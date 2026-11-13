import { expect, test } from "@playwright/test";
import { mockDesktop } from "./mock";

test("the right directory docks, floats and dismisses without disturbing the current chapter", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  const panel = page.locator("#toc-panel");
  const toggle = page.locator("#toc-toggle");
  const pin = page.locator("#toc-pin");
  const reader = page.locator("#reader");
  const chapter = page.frameLocator("#reader").locator("h1");
  await expect(toggle).toBeHidden();
  await page.locator("#demo").click();
  await expect(chapter).toHaveText("窗边的一小时");
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "固定目录", pressed: true })).toBeVisible();
  const docked = (await reader.boundingBox())!;
  const right = (await panel.boundingBox())!;
  expect(right.x).toBeCloseTo(docked.x + docked.width);
  expect(right.x + right.width).toBeCloseTo(1180);
  await page.locator('#toc [data-toc="2"]').click();
  await expect(chapter).toHaveText("散步的意义");
  await expect(panel).toBeVisible();

  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await reader.boundingBox())!.width).toBeCloseTo(docked.width + right.width);
  await expect(chapter).toHaveText("散步的意义");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.frameLocator("#reader").locator("body").click({ position: { x: 24, y: 40 } });
  await expect(panel).toBeHidden();
  await toggle.click();
  await page.locator('#toc [data-toc="3"]').click();
  await expect(panel).toBeHidden();
  await expect(chapter).toHaveText("把时间还给自己");

  await page.reload();
  await page.getByRole("button", { name: /继续阅读/ }).click();
  await expect(chapter).toHaveText("把时间还给自己");
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await page.locator("#toc-close").click();
  await expect(toggle).toBeFocused();
});

test("pointer and keyboard resize the directory, retaining space for reading and remembering width", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#demo").click();
  const panel = page.locator("#toc-panel");
  const handle = page.getByRole("separator", { name: "本书目录" });
  const chapter = page.frameLocator("#reader").locator("h1");
  await expect(chapter).toHaveText("窗边的一小时");
  const initial = (await panel.boundingBox())!.width;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 60, grip.y + grip.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(initial + 60);
  await handle.press("ArrowRight");
  const savedWidth = initial + 44;
  await expect(handle).toHaveAttribute("aria-valuenow", String(savedWidth));
  await expect(chapter).toHaveText("窗边的一小时");
  await page.reload();
  await page.getByRole("button", { name: /继续阅读/ }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", String(savedWidth));

  await page.locator('#toc [data-toc="2"] .toc-title').evaluate((title) => {
    title.textContent = "很长的目录标题，用于验证窄桌面窗口里的文字可以自然换行并完整显示";
  });
  await page.setViewportSize({ width: 800, height: 640 });
  await expect(handle).toHaveAttribute("aria-valuenow", "240");
  const article = (await page.locator("#reader").boundingBox())!;
  expect(article.width).toBeGreaterThanOrEqual(360);
  const title = page.locator('#toc [data-toc="2"] .toc-title');
  expect(await title.evaluate((el) => el.clientHeight > parseFloat(getComputedStyle(el).lineHeight) &&
    el.scrollWidth === el.clientWidth)).toBe(true);
  await handle.press("End");
  await expect(handle).toBeFocused();
  await page.screenshot({ path: "test-results/toc-sidebar-narrow.png" });
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(handle).toHaveAttribute("aria-valuenow", String(savedWidth));
  await page.screenshot({ path: "test-results/toc-sidebar-docked.png" });
  await page.locator("#toc-pin").click();
  await page.screenshot({ path: "test-results/toc-sidebar-floating.png" });
  await handle.press("Enter");
  await expect(panel).toBeHidden();
  await expect(page.locator("#toc-toggle")).toBeFocused();
});
