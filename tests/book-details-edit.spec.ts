import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
async function edit(page: import("@playwright/test").Page) {
  await page.locator("#book-info-edit").click();
  await expect(page.locator("#details-dialog")).toBeVisible();
}
test("manual bibliography updates shelf, search and reader in place, and restoring keeps reading position", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.locator('[data-book-key="sample"] [data-action="info"]').click();
  await edit(page);
  await page.locator("#details-title").fill("手动补全的书名");
  await page.locator("#details-author").fill("新增作者");
  await page.locator("#details-publisher").fill("示例出版社");
  await page.locator("#details-published").fill("2026-11");
  await page.locator("#details-isbn").fill("9780000000000");
  await page.locator("#details-language").fill("zh-CN");
  await page
    .locator("#details-description")
    .fill("第一行说明\n第二行 <b>按文字展示</b>");
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#details-author").focus();
  await page.screenshot({ path: "test-results/edit-book-information.png" });
  await page.locator("#details-save").click();
  await expect(page.locator("#book-info-title")).toHaveText("手动补全的书名");
  await expect(page.locator("#book-info-content")).toContainText("示例出版社");
  await expect(page.locator(".book-description")).toHaveText(
    /第一行说明.*第二行 <b>按文字展示<\/b>/s,
  );
  await expect(page.locator(".book-description b")).toHaveCount(0);
  await page.locator("#book-info-close").click();
  await page.locator("#shelf-search").fill("新增作者");
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(page.locator(".book-info h3")).toHaveText("手动补全的书名");
  await page.reload();
  await page.locator('[data-book-key="sample"] .book-card').click();
  await expect(page.locator("#breadcrumb")).toHaveText("阅读 / 手动补全的书名");
  await page.locator('#toc [data-toc="2"]').click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await page.locator("#book-info").click();
  await edit(page);
  await page.locator("#details-title").fill("阅读中更名");
  await page.locator("#details-save").click();
  await expect(page.locator("#breadcrumb")).toHaveText("阅读 / 阅读中更名");
  await page.locator("#book-info-close").click();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText(
    "散步的意义",
  );
  await page.locator("#book-info").click();
  await edit(page);
  await page.locator("#details-reset").click();
  await page.locator("#details-save").click();
  await expect(page.locator("#book-info-title")).toHaveText("缓慢的日常");
  await page.locator("#book-info-close").click();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText(
    "散步的意义",
  );
  await expect(page.locator("#position")).toContainText("2 / 3");
});
test("logical books have independent details and failed edits or cancellation preserve the previous information", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await page.locator("#collection-mode").click();
  await page.locator("#collection-apply").click();
  await page
    .locator('[data-book-key="anthology::toc-0-1"] [data-action="info"]')
    .click();
  await edit(page);
  await page.locator("#details-title").fill("独立子书名称");
  await page.locator("#details-author").fill("子书作者");
  await page.evaluate(() => localStorage.setItem("mock.details_error", "1"));
  await page.locator("#details-save").click();
  await expect(page.locator("#details-error")).toContainText(
    "保存图书信息失败",
  );
  await page.locator("#details-cancel").click();
  await expect(page.locator("#book-info-title")).toHaveText("第二本：散步");
  await page.evaluate(() => localStorage.removeItem("mock.details_error"));
  await edit(page);
  await page.locator("#details-title").fill("独立子书名称");
  await page.locator("#details-author").fill("子书作者");
  await page.locator("#details-save").click();
  await expect(page.locator("#book-info-title")).toHaveText("独立子书名称");
  await page.locator("#book-info-close").click();
  await expect(
    page.locator('[data-book-key="anthology::toc-0-1"] .book-info'),
  ).toContainText("子书作者");
  await expect(
    page.locator('[data-book-key="anthology::toc-0-0"] .book-info'),
  ).toContainText("Leaf QA");
  await expect(
    page.locator('[data-book-key="anthology::toc-0-1"] .source-link'),
  ).toContainText("三册随笔合集");
});

test("public catalog lookup previews multiple editions before saving a selected candidate", async ({ page }) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.evaluate(() => {
    const mock = (window as any).__TAURI_INTERNALS__;
    const original = mock.invoke;
    mock.invoke = async (command: string, args: { term: string; author: string }) => {
      if (command !== "lookup_book_metadata") return original(command, args);
      ((window as any).catalogQueries ||= []).push(args);
      if (args.term === "重试") throw new Error("Open Library 暂时无法查询");
      if (args.term === "没有这本书") return [];
      await new Promise<void>((resolve) => { (window as any).finishCatalogQuery = resolve; });
      return [
        { reference: "/books/OL1M", details: { title: "示例书名", author: "候选作者", publisher: "第一家出版社", published: "2003", isbn: "9780141439518", language: "eng" } },
        { reference: "/books/OL2M", details: { title: "示例书名", author: "候选作者", publisher: "第二家出版社及其用于检查长文本换行的完整机构名", published: "2008", isbn: "9780141439525", language: "eng" } },
      ];
    };
  });
  await page.locator('[data-book-key="sample"] [data-action="info"]').click();
  await edit(page);
  await page.locator("#details-title").fill("示例书名");
  await page.locator("#details-author").fill("手填作者");
  await page.getByRole("button", { name: "查找公开书目" }).click();
  const lookup = page.getByRole("dialog", { name: "从 Open Library 补全" });
  const term = lookup.getByLabel("书名或 ISBN");
  const author = lookup.getByLabel("作者（按书名查找时可选）");
  const submit = lookup.getByRole("button", { name: "查找" });
  await expect(term).toHaveValue("示例书名");
  await expect(author).toHaveValue("手填作者");
  await term.fill("重试");
  await submit.click();
  await expect(lookup.getByRole("status")).toContainText("暂时无法查询");
  await term.fill("没有这本书");
  await author.fill("");
  await submit.click();
  await expect(lookup.getByRole("status")).toContainText("未找到候选");
  await term.fill("示例书名");
  await author.fill("候选作者");
  await author.press("Enter");
  await expect(submit).toBeDisabled();
  await page.screenshot({ path: "test-results/metadata-lookup-loading.png" });
  await page.evaluate(() => (window as any).finishCatalogQuery());
  await expect(lookup.getByRole("status")).toContainText("2 个候选");
  await page.setViewportSize({ width: 800, height: 660 });
  await lookup.getByRole("button", { name: /选用此书目.*OL2M/ }).focus();
  await page.screenshot({ path: "test-results/metadata-lookup-narrow.png" });
  await lookup.getByRole("button", { name: /选用此书目.*OL2M/ }).click();
  await expect(lookup).toBeHidden();
  await expect(page.locator("#details-author")).toHaveValue("手填作者");
  await expect(page.locator("#details-isbn")).toHaveValue("9780141439525");
  await expect(page.locator("#details-publisher")).toHaveValue(/第二家出版社/);
  expect(await page.evaluate(() => (window as any).__mockCommands.some(
    ({ command }: { command: string }) => command === "edit_book_details",
  ))).toBe(false);
  await page.getByRole("button", { name: "查找公开书目" }).click();
  await expect(term).toHaveValue("9780141439525");
  await expect(author).toHaveValue("");
  await submit.click();
  await expect(submit).toBeDisabled();
  await page.evaluate(() => (window as any).finishCatalogQuery());
  await expect(lookup.getByRole("status")).toContainText("2 个候选");
  await lookup.getByLabel("替换已有字段").check();
  await lookup.getByRole("button", { name: /选用此书目.*OL2M/ }).click();
  await expect(page.locator("#details-author")).toHaveValue("候选作者");
  await page.locator("#details-save").click();
  await expect(page.locator("#book-info-content")).toContainText("第二家出版社");
  expect(await page.evaluate(() => (window as any).catalogQueries)).toEqual([
    { term: "重试", author: "手填作者" },
    { term: "没有这本书", author: "" },
    { term: "示例书名", author: "候选作者" },
    { term: "9780141439525", author: "" },
  ]);
});
