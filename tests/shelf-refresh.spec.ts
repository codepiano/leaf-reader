import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("refresh works on empty shelf, discovers configured sources and never changes configuration or opens a book", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  const refresh = page.locator("#shelf-refresh");
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.locator("#shelf-refresh-report")).toContainText(
    "尚未配置扫描目录",
  );
  await expect(page.locator(".book-card")).toHaveCount(0);
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("mock.library")!);
    state.scan_directories = ["/sources"];
    localStorage.setItem("mock.library", JSON.stringify(state));
  });
  await refresh.click();
  await expect(page.locator("#shelf-refresh-report")).toContainText(
    "新增 2 本",
  );
  await expect(page.locator(".book-card")).toHaveCount(2);
  await refresh.click();
  await expect(page.locator("#shelf-refresh-report")).toContainText(
    "新增 0 本",
  );
  await expect(page.locator(".book-card")).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      (window as any).__mockCommands.filter((c: any) =>
        ["set_scan_directories", "open_book"].includes(c.command),
      ),
    ),
  ).toEqual([]);
  await refresh.focus();
  await page.screenshot({ path: "test-results/refresh-desktop-focused.png" });
});

test("refresh guards concurrent clicks, retains cards after failure, and can retry", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("mock.scan_delay", "600");
    localStorage.setItem("mock.scan_failure", "1");
  });
  await page.locator("#shelf-refresh").click();
  await expect(
    page.locator("#shelf-refresh").getByRole("button"),
  ).toBeDisabled();
  await expect(
    page.locator("#scan-settings").getByRole("button"),
  ).toBeDisabled();
  await expect(page.locator("#shelf-refresh")).toContainText("刷新中");
  await page.screenshot({ path: "test-results/refresh-busy.png" });
  await page
    .locator("#shelf-refresh")
    .evaluate((el) =>
      el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  await expect(page.locator("#shelf-refresh-report")).toContainText("刷新失败");
  await expect(page.locator(".book-card")).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        (window as any).__mockCommands.filter(
          (c: any) => c.command === "scan_library",
        ).length,
    ),
  ).toBe(1);
  await expect(
    page.locator("#shelf-refresh").getByRole("button"),
  ).toBeEnabled();
  await page.evaluate(() => {
    localStorage.removeItem("mock.scan_failure");
    localStorage.removeItem("mock.scan_delay");
  });
  await page.locator("#shelf-refresh").click();
  await expect(page.locator("#shelf-refresh-report")).toContainText("刷新完成");
});

test("refresh marks missing files, restores availability and invalidates lazy covers while keeping search", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true, "good");
  await page.goto("/");
  const image = page.locator('[data-book-key="sample"] .embedded-cover');
  await expect(image).toHaveAttribute("src", /cover\/sample$/);
  await page.evaluate(() => localStorage.setItem("mock.unavailable", "sample"));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#shelf-refresh").click();
  await expect(
    page.locator('[data-book-key="sample"] .book-file-status'),
  ).toHaveText("文件不可用");
  await expect(image).toHaveAttribute("src", /cover\/sample\?v=.+/);
  const first = await image.getAttribute("src");
  await page.screenshot({ path: "test-results/refresh-missing-900.png" });
  await page.evaluate(() => localStorage.removeItem("mock.unavailable"));
  await page.locator("#shelf-refresh").click();
  await expect(page.locator(".book-file-status")).toHaveCount(0);
  await expect(image).toHaveAttribute("src", /cover\/sample\?v=.+/);
  await expect(image).not.toHaveAttribute("src", first!);
  const second = await image.getAttribute("src");
  await page.reload();
  await expect(image).toHaveAttribute("src", second!);
  await page.locator("#shelf-search").fill("没有匹配的长书名与作者");
  await page.locator("#shelf-refresh").click();
  await expect(page.locator("#shelf-search")).toHaveValue(
    "没有匹配的长书名与作者",
  );
  await expect(page.locator(".book-card")).toHaveCount(0);
  await page.screenshot({ path: "test-results/refresh-long-search-900.png" });
});
