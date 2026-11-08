import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
test("reading status is manual, pins sort first and favorite cover badges persist", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.locator('[data-book-key="anthology"] [data-action="pin"]').click();
  await expect(page.locator(".book-tile").first()).toHaveAttribute(
    "data-book-key",
    "anthology",
  );
  await expect(
    page.locator('[data-book-key="anthology"] .pin-badge'),
  ).toHaveText("置顶");
  await page
    .locator('[data-book-key="anthology"] [data-action="favorite"]')
    .click();
  await expect(
    page.locator('[data-book-key="anthology"] .favorite-badge'),
  ).toBeVisible();
  await page
    .locator('[data-book-key="anthology"] [data-action="metadata"]')
    .click();
  await page.locator("#metadata-status").click();
  await page.getByRole("option", { name: "读过", exact: true }).click();
  await page.locator("#metadata-save").click();
  await page.locator('[data-filter="status"][data-value="finished"]').click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(page.locator(".book-status")).toHaveText("读过");
  await page.screenshot({ path: "test-results/pinned-favorite-finished.png" });
  await page.locator("#library-nav").click();
  await page.locator('[data-book-key="sample"] .book-card').click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await page.locator("#back").click();
  await page.locator('[data-filter="status"][data-value="reading"]').click();
  await expect(page.locator(".book-info h3")).toHaveText("缓慢的日常");
  await page
    .locator('[data-book-key="sample"] [data-action="metadata"]')
    .click();
  await page.locator("#metadata-status").click();
  await page.getByRole("option", { name: "未读", exact: true }).click();
  await page.locator("#metadata-save").click();
  await page.locator('[data-filter="status"][data-value="unread"]').click();
  await expect(page.locator(".book-info h3")).toHaveText("缓慢的日常");
  // Explicit manual classification survives reading and restarting the interface.
  await page.locator(".book-card").click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await page.locator("#back").click();
  await page.reload();
  await page.locator('[data-filter="status"][data-value="unread"]').click();
  await expect(page.locator(".book-info h3")).toHaveText("缓慢的日常");
  await page.locator("#library-nav").click();
  await expect(page.locator(".book-tile").first()).toHaveAttribute(
    "data-book-key",
    "anthology",
  );
  await page.locator('[data-book-key="anthology"] [data-action="pin"]').click();
  await expect(
    page.locator('[data-book-key="anthology"] .pin-badge'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-book-key="anthology"] .favorite-badge'),
  ).toBeVisible();
});
