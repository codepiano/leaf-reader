import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
test("books appear before delayed covers and missing covers keep fallback", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true, "slow");
  await page.goto("/");
  await expect(page.locator(".book-card")).toHaveCount(2);
  await expect(
    page.locator('[data-book-key="sample"] .cover-frame'),
  ).toBeVisible();
  await expect(
    page.locator('[data-book-key="sample"] .has-embedded-cover'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-book-key="anthology"] .cover-frame'),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/embedded-covers.png" });
  await page.locator('[data-book-key="sample"] .book-card').click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
});

test("invalid embedded images quietly retain the text cover", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true, "broken");
  const response = page.waitForResponse((r) =>
    r.url().includes("/cover/sample"),
  );
  await page.goto("/");
  await response;
  await expect(
    page.locator('[data-book-key="sample"] .embedded-cover'),
  ).not.toHaveAttribute("src");
  await expect(
    page.locator('[data-book-key="sample"] .cover-frame'),
  ).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden();
});
