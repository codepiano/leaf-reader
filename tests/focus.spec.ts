import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("pointer buttons stay quiet, dialogs focus their title, and keyboard rings remain thin", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  const trigger = page.locator(
    '[data-book-key="sample"] [data-action="metadata"]',
  );
  const button = trigger.getByRole("button");
  const dialog = page.locator("#metadata-dialog");
  const close = dialog.locator(".dialog-heading wa-button").getByRole("button");
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h2")).toBeFocused();
  expect(await close.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "none",
  );
  await page.screenshot({ path: "test-results/focus-pointer-dialog.png" });
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  expect(await close.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
    "1px",
  );
  await page.screenshot({ path: "test-results/focus-keyboard-dialog.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  expect(await button.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
    "1px",
  );
  await page.keyboard.press("Enter");
  await expect(dialog.locator("h2")).toBeFocused();
  await close.click();
  await expect(dialog).toBeHidden();
  expect(await button.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "none",
  );
  await page.screenshot({ path: "test-results/focus-pointer-shelf.png" });
  await page.setViewportSize({ width: 900, height: 700 });
  await trigger.click();
  await expect(dialog.locator("h2")).toBeFocused();
  await page.screenshot({ path: "test-results/focus-pointer-dialog-900.png" });
});

test("shared dialogs avoid initially selecting close buttons", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  for (const [trigger, dialog] of [
    ["#library-settings", "#library-settings-dialog"],
    ["#scan-settings", "#scan-dialog"],
    ['[data-book-key="sample"] [data-action="info"]', "#book-info-dialog"],
  ]) {
    await page.locator(trigger).click();
    await expect(page.locator(`${dialog} h2`)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(dialog)).toBeHidden();
  }
});
