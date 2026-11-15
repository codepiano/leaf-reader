import { expect, test, type Page } from "@playwright/test";
import { emptyMeta } from "../src/types";

const prefix = "http://epub.localhost/";
const title = "测试非常长的书名，用于检查书名省略和工具栏在桌面窗口收窄时的表现";
const folder = "/qa/Poems";
const html = "/qa/export.html";
const comic = "/qa/Comic.cbz";
const txt = "/qa/dialogue.txt";
const bodies = [
  '<h1>秋</h1><p>第一行\n第二行</p><p>新一节</p><a href="2.md#春">去春天</a>',
  '<h1>春</h1><p>新一章</p><h2>诗题</h2><p>诗行</p><span class="math math-inline">x^2</span><pre><code class="language-javascript">const spring = 2;</code></pre><span class="task-mark" role="img" aria-label="已完成">☑</span>',
];

async function install(page: Page) {
  await page.addInitScript(({ prefix, metadata, folder, html, comic, txt, title, bodies }) => {
    const collection = { enabled: false, parts: [] };
    const paths = [folder, html, comic, txt];
    const library = {
      books: paths.map((path, index) => ({
        id: String(index), title: index === 0 ? title : ["", "HTML 样本", "漫画样本", "TXT 样本"][index],
        path, author: "", chapters: 2, opened: 0, collection, metadata,
        part_metadata: {}, progress: { chapter: 0, fraction: 0 },
      })),
      groups: [],
    };
    let active = 0;
    const textChapters = [
      { title: "很长的第一章标题：当目录和正文的工具栏同时显示时仍然可以使用", path: "sections/1.md" },
      { title: "春", path: "sections/2.md" },
    ];
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: {
          path: string; index: number; chapter: number; fraction: number; enabled: boolean;
          options?: { directory?: boolean }; update?: boolean; url?: string; html?: string;
        }) => {
          switch (command) {
            case "library_snapshot": return library;
            case "library_settings": return { remember_position: true, track_reading_time: false };
            case "scan_directories": return ["/qa"];
            case "prepare_github_book":
              localStorage.setItem("github.request", JSON.stringify({ url: args.url, update: args.update }));
              return { path: folder, status: args.update ? "updated" : "added" };
            case "get_html_source": return "<script>document.body.textContent='ran'</script><h1>HTML 正文</h1>";
            case "plugin:dialog|save": return "/qa/output.html";
            case "text_export_images": return { "images/leaf.png": "data:image/png;base64,aW1hZ2U=" };
            case "save_text_export": localStorage.setItem("html.export", args.html!); return;
            case "plugin:dialog|open": return args.options?.directory ? folder : html;
            case "open_book": {
              active = paths.indexOf(args.path);
              const record = library.books[active];
              const chapters = active === 0 ? textChapters : active === 1 ? [{ title: "HTML 样本", path: "chapter-0.html" }] : active === 3 ? [{ title: "TXT 样本", path: "chapter-0.xhtml" }] : [];
              return {
                ...record, token: "qa-token", chapters,
                metadata: { ...metadata, poetry: localStorage.getItem(`poetry.${active}`) === "true" },
                toc: chapters.map((c, i) => ({ title: c.title, id: c.path, chapter: i, fragment: "", children: [] })),
                comic_pages: active === 2 ? 2 : undefined,
                progress: JSON.parse(localStorage.getItem(`progress.${active}`) || '{"chapter":0,"fraction":0}'),
                track_reading_time: false,
              };
            }
            case "get_chapter": return active === 0 ? bodies[args.index] : active === 3 ? "<p>访谈正文中的文字</p>" :
              '<h1>HTML 正文</h1><h2 id="section">标题二</h2><p>保留正文</p><img alt="本地图片" src="images/leaf.png">';
            case "set_poetry": localStorage.setItem(`poetry.${active}`, String(args.enabled)); return;
            case "save_progress":
              localStorage.setItem(`progress.${active}`, JSON.stringify({ chapter: args.chapter, fraction: args.fraction }));
              return;
            case "plugin:event|listen": return 1;
            case "close_book":
            case "frontend_ready": return;
            default: throw new Error(command);
          }
        },
        convertFileSrc: (path: string) => prefix + path,
        transformCallback: () => 1,
        unregisterCallback: () => {},
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      },
    });
  }, { prefix, metadata: emptyMeta(), folder, html, comic, txt, title, bodies });
  await page.route(`${prefix}qa-token/**`, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="980"><rect width="700" height="980" fill="ivory"/><rect x="100" y="100" width="500" height="780" fill="#526a4f"/></svg>',
  }));
  await page.goto("/");
}

test("opens a Markdown folder, follows a relative chapter link and remembers verse layout for that book", async ({ page }) => {
  await install(page);
  await page.getByRole("button", { name: "打开目录" }).click();
  const source = page.frameLocator("#reader");
  const poetry = page.getByRole("button", { name: "诗歌排版" });
  const lines = source.locator("p").first();
  await expect(lines).toHaveCSS("white-space", "normal");
  await poetry.click();
  await expect(poetry).toHaveAttribute("aria-pressed", "true");
  await expect(lines).toHaveCSS("white-space", "pre-wrap");
  await expect(source.locator("h1")).toHaveCSS("text-align", "center");
  await page.screenshot({ path: "test-results/leaf-poetry-wide.png" });
  await page.setViewportSize({ width: 800, height: 620 });
  await page.keyboard.press("Tab");
  await poetry.focus();
  await expect(poetry).toBeFocused();
  await page.screenshot({ path: "test-results/leaf-poetry-narrow.png" });
  await source.getByRole("link", { name: "去春天" }).click();
  await expect(source.getByRole("heading", { name: "春" })).toBeVisible();
  await page.getByRole("button", { name: "返回书架" }).click();

  await page.getByRole("button", { name: "打开书籍" }).click();
  await expect(source.getByRole("heading", { name: "HTML 正文" })).toBeVisible();
  await expect(poetry).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => source.getByAltText("本地图片").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(700);
  const toggle = page.getByRole("button", { name: "本书目录" });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("button", { name: "标题二" })).toBeVisible();
  await page.getByRole("button", { name: "返回书架" }).click();
  await page.getByRole("button", { name: "打开目录" }).click();
  await expect(poetry).toHaveAttribute("aria-pressed", "true");
  await expect(source.getByRole("heading", { name: "春" })).toBeVisible();
});

test("reads CBZ pages with zoom, page jump and resume", async ({ page }) => {
  await install(page);
  await page.getByRole("button", { name: "继续阅读 漫画样本" }).first().click();
  const panel = page.getByRole("region", { name: "漫画正文" });
  await expect(panel.getByAltText("漫画第 1 页")).toBeVisible();
  await expect(page.locator("#prev")).toHaveJSProperty("disabled", true);
  await expect(page.getByRole("button", { name: "诗歌排版" })).toBeHidden();
  await expect(page.getByRole("button", { name: "本书目录" })).toBeHidden();
  const imageWidth = () => panel.getByRole("img").evaluate((el) => el.clientWidth);
  const fitted = await imageWidth();
  await page.getByRole("button", { name: "放大" }).click();
  await expect.poll(imageWidth).toBeGreaterThan(fitted);
  await page.getByRole("button", { name: "适合页面" }).click();
  await expect.poll(imageWidth).toBe(fitted);
  const pageNumber = page.getByRole("spinbutton", { name: "页码" });
  await pageNumber.fill("2");
  await pageNumber.press("Enter");
  await expect(panel.getByAltText("漫画第 2 页")).toBeVisible();
  await expect(page.locator("#next")).toHaveJSProperty("disabled", true);
  await page.screenshot({ path: "test-results/leaf-comic-wide.png" });
  await page.setViewportSize({ width: 800, height: 620 });
  await expect.poll(() => panel.evaluate((el) => {
    const image = el.querySelector("img")!;
    return image.clientHeight <= el.clientHeight - 31 && image.clientWidth <= el.clientWidth - 31;
  })).toBe(true);
  await page.screenshot({ path: "test-results/leaf-comic-narrow.png" });
  await page.getByRole("button", { name: "返回书架" }).click();
  await page.reload();
  await page.getByRole("button", { name: "继续阅读 漫画样本" }).first().click();
  await expect(panel.getByAltText("漫画第 2 页")).toBeVisible();
});

test("opens a GitHub directory book with rendered formulas, highlighted code and a poem outline", async ({ page }) => {
  await install(page);
  await page.getByRole("button", { name: "GitHub 书籍" }).click();
  const dialog = page.getByRole("dialog", { name: "GitHub 书籍" });
  await dialog.getByLabel("公开仓库地址").fill("https://github.com/example/poems");
  await page.screenshot({ path: "test-results/leaf-github-wide.png" });
  await page.setViewportSize({ width: 800, height: 620 });
  await dialog.getByLabel("公开仓库地址").focus();
  await page.screenshot({ path: "test-results/leaf-github-narrow.png" });
  await dialog.getByRole("button", { name: "检查并更新" }).click();
  const reader = page.frameLocator("#reader");
  await reader.getByRole("link", { name: "去春天" }).click();
  await expect(reader.locator("math")).toContainText("x");
  await expect(reader.locator(".hljs-keyword")).toHaveText("const");
  await expect(reader.getByRole("img", { name: "已完成" })).toHaveText("☑");
  await page.getByRole("button", { name: "诗歌排版" }).click();
  const toggle = page.getByRole("button", { name: "本书目录" });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.getByRole("button", { name: "诗题" })).toBeVisible();
  await page.getByRole("button", { name: "诗题" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("github.request")!))).toEqual({
    url: "https://github.com/example/poems", update: true,
  });
});

test("shows HTML source as text and exports an independent rendered chapter", async ({ page }) => {
  await install(page);
  await page.getByRole("button", { name: "打开书籍" }).click();
  await expect(page.frameLocator("#reader").getByRole("heading", { name: "HTML 正文" })).toBeVisible();
  await page.getByRole("button", { name: "HTML 原文" }).click();
  const source = page.getByRole("dialog", { name: "HTML 原文" });
  await expect(source.locator("pre")).toContainText("<script>");
  await expect(source.locator("script")).toHaveCount(0);
  await source.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "导出 HTML" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("html.export"))).toContain("data:image/png;base64,");
  const output = await page.evaluate(() => localStorage.getItem("html.export"));
  expect(output).toContain("HTML 正文");
  expect(output).not.toContain("<script");
});


test("TXT, Markdown directory chapters and HTML can all search rendered text", async ({ page }) => {
  await install(page);
  for (const [id, term] of [["0", "const spring"], ["1", "保留正文"], ["3", "访谈正文中的文字"]]) {
    await page.locator(`[data-book-key="${id}"] .book-card`).click();
    await expect(page.locator("#chapter-loading")).toBeHidden();
    await page.getByRole("button", { name: "书内查找" }).click();
    const dialog = page.getByRole("dialog", { name: "书内查找" });
    await dialog.getByRole("searchbox").fill(term);
    await dialog.getByRole("button", { name: "查找", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("1 条结果");
    const reader = page.frameLocator("#reader");
    const previousLoad = await reader.locator("html").getAttribute("data-leaf-load");
    await dialog.locator("#book-search-results button").click();
    await expect(reader.locator("html")).not.toHaveAttribute("data-leaf-load", previousLoad!);
    await expect.poll(() => reader.locator("body").evaluate((body) => {
      const view = body.ownerDocument.defaultView!;
      return view.CSS.highlights?.get("leaf-search")?.values().next().value?.toString()
        ?? view.getSelection()?.toString();
    })).toBe(term);
    await page.locator("#back").click();
  }
});
