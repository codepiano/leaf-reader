import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("book details are available from shelf and reader, long paths wrap and missing files remain inspectable", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "mock.info-path",
      "/Users/reader/" + "图书资料/".repeat(18) + "缓慢的日常.epub",
    ),
  );
  await page.locator('[data-book-key="sample"] [data-action="info"]').click();
  const dialog = page.locator("#book-info-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#book-info-title")).toHaveText("缓慢的日常");
  await expect(page.locator("#book-info-content")).toContainText("2,030 字节");
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#book-info-close").focus();
  await page.screenshot({ path: "test-results/book-info-long-path.png" });
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  await page.locator("#book-info-close").click();
  await page.locator('[data-book-key="sample"] .book-card').click();
  await page.locator("#book-info").click();
  await expect(page.locator("#book-info-title")).toHaveText("缓慢的日常");
  await page.locator("#book-info-close").click();
  await page.locator("#back").click();
  await page.locator('[data-book-key="anthology"] .book-card').click();
  await page.locator("#collection-mode").click();
  await page.locator("#collection-apply").click();
  await page
    .locator('[data-book-key="anthology::toc-0-1"] [data-action="info"]')
    .click();
  await expect(page.locator("#book-info-title")).toHaveText("第二本：散步");
  await expect(page.locator("#book-info-content")).toContainText(
    "共用 EPUB 大小",
  );
  await expect(page.locator("#book-info-content")).toContainText("子书章节数");
  await page.screenshot({ path: "test-results/book-info-part.png" });
  await page.locator("#book-info-close").click();
  await page.evaluate(() => localStorage.setItem("mock.missing", "1"));
  await page
    .locator('[data-book-key="anthology::toc-0-1"] [data-action="info"]')
    .click();
  await expect(page.locator("#book-info-content")).toContainText(
    "文件已移动或无法访问",
  );
  await expect(page.locator("#book-info-content")).toContainText("无法获取");
});
