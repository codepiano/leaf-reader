import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("removed books stay out of refresh and survive reload until manually opened, keeping their records", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("mock.library")!);
    s.scan_directories = ["/sources"];
    s.books[0].metadata.favorite = true;
    s.books[0].metadata.tags = ["保留"];
    s.books[0].progress = { chapter: 1, fraction: 0.4 };
    localStorage.setItem("mock.library", JSON.stringify(s));
  });
  await page
    .locator('[data-book-key="sample"] [data-action="metadata"]')
    .click();
  await page.locator("#metadata-remove").click();
  await expect(page.locator("#remove-book-dialog h2")).toBeFocused();
  await expect(page.locator("#remove-book-description")).toContainText(
    "保留原 EPUB",
  );
  await page.locator("#remove-book-cancel").click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await expect(page.locator("#metadata-dialog")).toBeVisible();
  await page.locator("#metadata-remove").click();
  await page.locator("#remove-book-confirm").click();
  await expect(page.locator("#metadata-dialog")).toBeHidden();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator("#shelf-refresh").click();
  await expect(page.locator("#shelf-refresh-report")).toContainText(
    "已忽略 1 本",
  );
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".book-card")).toHaveCount(1);
  const retained = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mock.library")!).books.find(
      (b: any) => b.id === "sample",
    ),
  );
  expect(retained.metadata.favorite).toBe(true);
  expect(retained.metadata.tags).toEqual(["保留"]);
  expect(retained.progress.fraction).toBe(0.4);
  await page.locator("#open").click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
  await page.locator("#back").click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await expect(
    page.locator('[data-book-key="sample"] .favorite-badge'),
  ).toBeVisible();
});

test("removal errors can be retried, and long titles fit desktop dialogs", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("mock.remove_failure", "1");
    localStorage.setItem("mock.remove_delay", "800");
    const state = JSON.parse(localStorage.getItem("mock.library")!);
    state.books.find((book: any) => book.id === "sample").metadata.details = {
      title: "很长的书名与合集副标题".repeat(7),
    };
    localStorage.setItem("mock.library", JSON.stringify(state));
  });
  await page.reload();
  await page.setViewportSize({ width: 900, height: 700 });
  await page
    .locator('[data-book-key="sample"] [data-action="metadata"]')
    .click();
  await page.screenshot({ path: "test-results/remove-menu-900.png" });
  await page.locator("#metadata-remove").click();
  await page.locator("#remove-book-confirm").click();
  await expect(
    page.locator("#remove-book-confirm").getByRole("button"),
  ).toBeDisabled();
  await page.screenshot({ path: "test-results/remove-disabled-900.png" });
  await expect(page.locator("#remove-book-error")).toContainText(
    "保存阅读记录失败",
  );
  await expect(page.locator(".book-card")).toHaveCount(2);
  await expect(
    page.locator("#remove-book-confirm").getByRole("button"),
  ).toBeEnabled();
  await page.screenshot({ path: "test-results/remove-error-900.png" });
  await page.evaluate(() => localStorage.removeItem("mock.remove_failure"));
  await page.locator("#remove-book-confirm").click();
  await expect(page.locator(".book-card")).toHaveCount(1);
});

test("removing one logical child preserves siblings and reopening its EPUB restores it", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await page.locator("#collection-mode").click();
  await page.locator("#collection-apply").click();
  await expect(page.locator(".book-card")).toHaveCount(3);
  const first = page.locator(".book-tile").first();
  const key = await first.getAttribute("data-book-key");
  await first.locator('[data-action="metadata"]').click();
  await page.locator("#metadata-remove").click();
  await expect(page.locator("#remove-book-description")).toContainText(
    "其他子书",
  );
  await page.locator("#remove-book-confirm").click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator("#shelf-refresh").click();
  await expect(page.locator(`[data-book-key="${key}"]`)).toHaveCount(0);
  await expect(page.locator(".book-card")).toHaveCount(2);
  const underlying = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("mock.library")!).books[0].collection
        .parts.length,
  );
  expect(underlying).toBe(4);
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.screenshot({ path: "test-results/remove-logical-child.png" });
  await page.locator("#open").click();
  await expect(page.locator("#library-view")).toBeVisible();
  await expect(page.locator(".book-card")).toHaveCount(3);
});
