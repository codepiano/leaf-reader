import { expect, test } from "@playwright/test";
import { mockDesktop } from "./mock";

test("EPUB continuous scrolling crosses chapter boundaries and restores the reading position", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#demo").click();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText("窗边的一小时");
  await page.getByRole("button", { name: "连续滚动" }).click();
  const stream = page.locator("#continuous-reader");
  const first = stream.locator("iframe").first();
  await expect(first.contentFrame().locator("h1")).toHaveText("窗边的一小时");
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await first.contentFrame().locator("h1").hover();
  await page.mouse.wheel(0, 350);
  await expect.poll(() => stream.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);

  await stream.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const second = stream.locator('iframe[title="散步的意义"]');
  await expect(second.contentFrame().locator("h1")).toHaveText("散步的意义");
  // The heading can appear before the parent receives the frame's measured height.
  await expect.poll(() => second.evaluate((el) =>
    el.parentElement!.scrollHeight - el.parentElement!.clientHeight - el.offsetTop,
  )).toBeGreaterThanOrEqual(400);
  await second.evaluate((el) => {
    el.parentElement!.scrollTop = el.offsetTop + 400;
  });
  await expect.poll(() => second.evaluate((el) =>
    el.parentElement!.scrollTop - el.offsetTop,
  )).toBe(400);
  await expect(page.locator("#chapter-caption")).toHaveText("散步的意义");
  await expect(page.locator("#position")).toContainText("2 / 3 节");
  await page.locator("#back").click();
  await page.locator(".book-card").click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await expect(page.locator("#chapter-caption")).toHaveText("散步的意义");
  await expect.poll(() => stream.locator('iframe[title="散步的意义"]').evaluate((el) =>
    el.parentElement!.scrollTop - el.offsetTop,
  )).toBeGreaterThan(375);

  await page.getByRole("button", { name: "连续滚动" }).click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText("散步的意义");
  await expect.poll(() => page.frameLocator("#reader").locator("body").evaluate((body) =>
    body.ownerDocument.defaultView!.scrollY,
  )).toBeGreaterThan(375);
});

test("EPUB search opens from the frame shortcut and jumps to a specific result in either mode", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#demo").click();
  const reader = page.frameLocator("#reader");
  await reader.locator("h1").click();
  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog", { name: "书内查找" });
  const query = dialog.getByRole("searchbox");
  await expect(query).toBeFocused();
  await query.fill("安静的抵达。");
  await query.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("1 条结果");
  await page.screenshot({ path: "test-results/book-search-desktop.png" });
  await dialog.getByRole("button", { name: /把时间还给自己.*安静的抵达/ }).click();
  await expect(reader.locator("h1")).toHaveText("把时间还给自己");
  await expect.poll(() => reader.locator("blockquote").evaluate((el) => {
    const win = el.ownerDocument.defaultView!;
    return win.CSS.highlights?.get("leaf-search")?.values().next().value?.toString() ?? win.getSelection()?.toString();
  })).toBe("安静的抵达。");

  await page.getByRole("button", { name: "连续滚动" }).click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await page.setViewportSize({ width: 720, height: 660 });
  await page.getByRole("button", { name: "书内查找" }).click();
  await query.fill("温水，决定把这一小时留给阅读。");
  await query.press("Enter");
  await expect(dialog.getByRole("status")).toContainText("结果");
  await dialog.locator("#book-search-results button").nth(3).focus();
  await page.screenshot({ path: "test-results/book-search-narrow.png" });
  await dialog.locator("#book-search-results button").nth(3).click();
  await expect(page.locator("#chapter-caption")).toHaveText("窗边的一小时");
  const continuous = page.frameLocator('#continuous-reader iframe[title="窗边的一小时"]');
  await expect.poll(() => continuous.locator("body").evaluate((el) => {
    const win = el.ownerDocument.defaultView!;
    return win.CSS.highlights?.get("leaf-search")?.values().next().value?.toString() ?? win.getSelection()?.toString();
  })).toBe("温水，决定把这一小时留给阅读。");
  await expect.poll(() => page.locator("#continuous-reader").evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  await page.getByRole("button", { name: "书内查找" }).click();
  await query.fill("不存在的查找内容");
  await query.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("未找到匹配的正文");
  await dialog.getByRole("button", { name: "关闭查找" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
