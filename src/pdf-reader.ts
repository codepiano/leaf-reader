import { invoke } from "@tauri-apps/api/core";
import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Toc } from "./types";

const chunkSize = 256 * 1024;
const maxCanvasPixels = 12_000_000;
const assets = new URL("pdf-assets/", document.baseURI);
GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", assets).href;

class LocalPdfRange extends PDFDataRangeTransport {
  private closed = false;
  constructor(private token: string, size: number) {
    super(size, null, true);
  }

  override requestDataRange(start: number, end: number) {
    void this.read(start, end).then(
      (bytes) => {
        if (!this.closed) this.onDataRange(start, bytes);
      },
      () => {
        if (!this.closed) this.onDataRange(start, null);
      },
    );
  }

  private async read(start: number, end: number) {
    // The worker can coalesce adjacent chunks into a single range.
    const bytes = new Uint8Array(end - start);
    for (let offset = start; offset < end; offset += chunkSize) {
      if (this.closed) throw new Error("PDF 已关闭");
      const limit = Math.min(offset + chunkSize, end);
      const data = await invoke<ArrayBuffer>("read_pdf_range", {
        token: this.token, start: offset, end: limit,
      });
      const chunk = new Uint8Array(data);
      if (chunk.length !== limit - offset) throw new Error("PDF 读取不完整");
      bytes.set(chunk, offset - start);
    }
    return bytes;
  }

  override abort() {
    this.closed = true;
  }
}

export async function openPdf(token: string, size: number, viewport: HTMLElement, resized: () => void) {
  const task = getDocument({
    range: new LocalPdfRange(token, size),
    rangeChunkSize: chunkSize,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: new URL("cmaps/", assets).href,
    standardFontDataUrl: new URL("standard_fonts/", assets).href,
    iccUrl: new URL("iccs/", assets).href,
    wasmUrl: new URL("wasm/", assets).href,
    // The main context fetches bundled assets even on Tauri's custom schemes.
    useWorkerFetch: false,
  });
  try {
    return new PdfReader(await task.promise, viewport, resized, () => task.destroy());
  } catch (error) {
    await task.destroy();
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error("此 PDF 需要密码，Leaf 暂不支持打开加密 PDF。");
    throw new Error("无法打开 PDF，请检查文件是否完整。", { cause: error });
  }
}

class PdfReader {
  readonly pages: number;
  private renderTask?: RenderTask;
  private page = -1;
  private rendering = false;
  private revision = 0;
  private zoom: number | null = null;
  private fit = 1;
  private readonly resize: ResizeObserver;

  constructor(private pdf: PDFDocumentProxy, private viewport: HTMLElement, resized: () => void, private destroy: () => Promise<void>) {
    this.pages = pdf.numPages;
    this.resize = new ResizeObserver(() => {
      if (this.page >= 0 && !this.rendering && this.zoom === null)
        void this.render(this.page, true).then(resized).catch(() => {});
    });
    this.resize.observe(this.viewport);
  }

  get scale() {
    return this.zoom ?? this.fit;
  }

  get isFit() {
    return this.zoom === null;
  }

  async outline(): Promise<Toc[]> {
    type Entry = NonNullable<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>[number];
    const entries = await this.pdf.getOutline();
    if (!entries) return [];
    const resolve = async (items: Entry[], prefix: string, depth: number): Promise<Toc[]> => {
      if (depth >= 32) return [];
      return Promise.all(items.map(async (item, i) => {
        const id = `${prefix}.${i}`;
        let chapter: number | null = null;
        try {
          const dest = typeof item.dest === "string"
            ? await this.pdf.getDestination(item.dest)
            : item.dest;
          const ref = dest?.[0];
          const index = Number.isInteger(ref) ? ref as number
            : ref && typeof ref === "object" ? await this.pdf.getPageIndex(ref) : -1;
          if (index >= 0 && index < this.pages) chapter = index;
        } catch { /* Keep headings and any valid descendants. */ }
        return {
          id, chapter, fragment: "", title: item.title.trim() || "未命名条目",
          children: await resolve(item.items, id, depth + 1),
        };
      }));
    };
    return resolve(entries, "pdf", 0);
  }

  zoomTo(scale: number | null) {
    this.zoom = scale === null ? null : Math.max(0.25, Math.min(5, scale));
  }

  async render(index: number, keepScroll = false): Promise<boolean> {
    const revision = ++this.revision;
    this.renderTask?.cancel();
    this.rendering = true;
    try {
      return await this.draw(index, revision, keepScroll);
    } finally {
      if (revision === this.revision) this.rendering = false;
    }
  }

  private async draw(index: number, revision: number, keepScroll: boolean) {
    const page = await this.pdf.getPage(index + 1);
    if (revision !== this.revision) return false;

    const original = page.getViewport({ scale: 1 });
    this.fit = Math.max(0.05, Math.min(
      (this.viewport.clientWidth - 32) / original.width,
      (this.viewport.clientHeight - 32) / original.height,
      3,
    ));
    const view = page.getViewport({ scale: this.scale });
    const outputScale = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(maxCanvasPixels / view.width / view.height),
      8192 / Math.max(view.width, view.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(view.width * outputScale));
    canvas.height = Math.max(1, Math.floor(view.height * outputScale));
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `PDF 第 ${index + 1} 页`);
    const task = page.render({
      canvas,
      viewport: view,
      transform: [canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0],
    });
    this.renderTask = task;
    try {
      await task.promise;
      if (revision !== this.revision) return false;
      const previous = this.viewport.firstElementChild;
      const x = previous?.clientWidth ? this.viewport.scrollLeft / previous.clientWidth : 0;
      const y = previous?.clientHeight ? this.viewport.scrollTop / previous.clientHeight : 0;
      this.viewport.replaceChildren(canvas);
      this.viewport.scrollTo(keepScroll ? x * canvas.clientWidth : 0, keepScroll ? y * canvas.clientHeight : 0);
      this.page = index;
      return true;
    } catch (error) {
      if (revision !== this.revision) return false;
      throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = undefined;
    }
  }

  async close() {
    ++this.revision;
    this.resize.disconnect();
    this.renderTask?.cancel();
    this.viewport.replaceChildren();
    await this.destroy();
  }
}

export type { PdfReader };
