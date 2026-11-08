import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
test("books appear before delayed covers, missing and broken covers keep fallback", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.addInitScript(() => localStorage.setItem("mock.cover", "slow"));
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
  await page.evaluate(() => localStorage.setItem("mock.cover", "broken"));
  await page.locator("#favorites-nav").click();
  await page.locator("#library-nav").click();
  await expect(
    page.locator('[data-book-key="sample"] .cover-frame'),
  ).toBeVisible();
  await expect(
    page.locator('[data-book-key="sample"] .has-embedded-cover'),
  ).toHaveCount(0);
  await page.locator('[data-book-key="sample"] .book-card').click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
});
