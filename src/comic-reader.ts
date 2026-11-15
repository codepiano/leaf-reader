import { convertFileSrc } from "@tauri-apps/api/core";
import type { PagedReader } from "./paged-reader";

export function openComic(token: string, pages: number, viewport: HTMLElement, resized: () => void): PagedReader {
  let image: HTMLImageElement | undefined;
  let page = -1;
  let zoom: number | null = null;
  let fit = 1;
  let revision = 0;

  const layout = (next: HTMLImageElement, keepScroll: boolean) => {
    const x = image?.clientWidth ? viewport.scrollLeft / image.clientWidth : 0;
    const y = image?.clientHeight ? viewport.scrollTop / image.clientHeight : 0;
    fit = Math.max(0.05, Math.min(
      (viewport.clientWidth - 32) / next.naturalWidth,
      (viewport.clientHeight - 32) / next.naturalHeight,
      3,
    ));
    next.width = Math.max(1, Math.round(next.naturalWidth * (zoom ?? fit)));
    if (next !== image) viewport.replaceChildren(next);
    image = next;
    viewport.scrollTo(keepScroll ? x * next.clientWidth : 0, keepScroll ? y * next.clientHeight : 0);
  };
  const observer = new ResizeObserver(() => {
    if (!image || zoom !== null) return;
    layout(image, true);
    resized();
  });
  observer.observe(viewport);

  return {
    pages,
    get scale() { return zoom ?? fit; },
    get isFit() { return zoom === null; },
    zoomTo(scale) { zoom = scale === null ? null : Math.max(0.25, Math.min(5, scale)); },
    async render(index, keepScroll = false) {
      const ticket = ++revision;
      if (image && page === index) {
        layout(image, keepScroll);
        return true;
      }
      const next = new Image();
      next.alt = `漫画第 ${index + 1} 页`;
      const loaded = new Promise<void>((resolve, reject) => {
        next.onload = () => resolve();
        next.onerror = () => reject(new Error(`无法读取漫画第 ${index + 1} 页。`));
      });
      next.src = convertFileSrc("", "epub") + `${token}/comic/${index}`;
      await loaded;
      if (ticket !== revision) return false;
      layout(next, keepScroll);
      page = index;
      return true;
    },
    async outline() { return []; },
    async close() {
      ++revision;
      observer.disconnect();
      image = undefined;
      viewport.replaceChildren();
    },
  };
}
