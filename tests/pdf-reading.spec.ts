import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { emptyMeta } from "../src/types";

const bytes = Array.from(readFileSync("fixtures/paged-sample.pdf"));

test("opens a scanned PDF, jumps through its outline, zooms and resumes", async ({ page }) => {
  await page.addInitScript(({ bytes, metadata }) => {
    const path = "/qa/paged-sample.pdf";
    const library = { books: [{
      id: "pdf", path, title: "PDF 验证样本", author: "", chapters: 0,
      progress: { chapter: 0, fraction: 0 }, opened: 0,
      collection: { enabled: false, parts: [] }, metadata, part_metadata: {},
    }], groups: [] };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { start: number; end: number; chapter: number; fraction: number }) => {
          switch (command) {
            case "library_snapshot": return library;
            case "library_settings": return { remember_position: true, track_reading_time: false };
            case "scan_directories": return ["/qa"];
            case "open_book": return {
              ...library.books[0], token: "pdf-token", pdf_size: bytes.length,
              chapters: [], toc: [],
              progress: JSON.parse(localStorage.getItem("pdf.progress") || '{"chapter":0,"fraction":0}'),
              track_reading_time: false,
            };
            case "read_pdf_range": return new Uint8Array(bytes.slice(args.start, args.end)).buffer;
            case "save_progress":
              localStorage.setItem("pdf.progress", JSON.stringify({ chapter: args.chapter, fraction: args.fraction }));
              return;
            case "plugin:event|listen": return 1;
            case "take_finder_book": return null;
            case "close_book":
            case "frontend_ready":
            case "set_pdf_pages": return;
            default: throw new Error(command);
          }
        },
        convertFileSrc: () => "http://epub.localhost/cover",
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      },
    });
  }, { bytes, metadata: emptyMeta() });
  await page.goto("/");
  await page.getByRole("button", { name: "继续阅读 PDF 验证样本" }).first().click();
  const paper = page.locator("#pdf-viewport canvas");
  const pageInput = page.getByRole("spinbutton", { name: "页码" });
  await expect(paper).toHaveAttribute("aria-label", "PDF 第 1 页");
  await expect(page.locator("#prev")).toHaveJSProperty("disabled", true);
  await expect(page.locator("#collection-mode")).toBeHidden();
  const ink = await paper.evaluate((element: HTMLCanvasElement) => {
    const ctx = element.getContext("2d")!;
    return ctx.getImageData(0, 0, element.width, element.height).data.some((v, i) =>
      i % 4 === 0 && v < 175);
  });
  expect(ink).toBe(true);

  const tocToggle = page.getByRole("button", { name: "本书目录" });
  if (await tocToggle.getAttribute("aria-expanded") !== "true") await tocToggle.click();
  await page.getByRole("button", { name: "横向页面与表格" }).click();
  await expect(pageInput).toHaveValue("2");
  await expect.poll(() => paper.evaluate((el) => el.clientWidth > el.clientHeight)).toBe(true);
  const paperWidth = () => page.evaluate(() =>
    document.querySelector("#pdf-viewport canvas")?.clientWidth ?? 0);
  const fitted = await paperWidth();
  await page.getByRole("button", { name: "放大" }).click();
  await expect.poll(paperWidth).toBeGreaterThan(fitted);
  await expect(page.locator("#pdf-fit")).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "适合页面" }).click();
  await expect(page.locator("#pdf-fit")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => Math.abs(await paperWidth() - fitted)).toBeLessThan(2);

  await pageInput.fill("9");
  await page.getByRole("button", { name: "跳转" }).click();
  await expect(page.locator("#position")).toContainText("2 / 3 页");
  await pageInput.fill("3");
  await pageInput.press("Enter");
  await expect(paper).toHaveAttribute("aria-label", "PDF 第 3 页");
  await expect(page.locator("#next")).toHaveJSProperty("disabled", true);
  await page.getByRole("button", { name: "返回书架" }).click();
  await page.reload();
  await page.getByRole("button", { name: "继续阅读 PDF 验证样本" }).first().click();
  await expect(paper).toHaveAttribute("aria-label", "PDF 第 3 页");
});
