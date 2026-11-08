import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("scan sources are multiple, persistent and independent of import directory; books stay unread until opened", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#scan-settings").click();
  await expect(page.locator("#scan-run").getByRole("button")).toBeDisabled();
  await page.screenshot({ path: "test-results/scan-empty-disabled.png" });
  await page.locator("#scan-add").click();
  await expect(page.locator(".scan-directory-row")).toHaveCount(0);
  const first = "/Users/reader/来源目录/" + "资料分类/".repeat(15);
  await page.evaluate(
    (paths) => localStorage.setItem("mock.scan_pick", JSON.stringify(paths)),
    [first, "/Volumes/外置硬盘/电子书", first],
  );
  await page.locator("#scan-add").click();
  await expect(page.locator(".scan-directory-row")).toHaveCount(2);
  await page.locator("#scan-save").click();
  await expect(page.locator("#scan-dialog")).toBeHidden();
  await expect(page.locator(".book-card")).toHaveCount(0);
  await page.locator("#library-settings").click();
  await expect(page.locator("#library-import-enabled")).not.toBeChecked();
  await expect(page.locator("#library-directory")).toHaveText("尚未设置目录");
  await page.evaluate(() =>
    localStorage.setItem("mock.directory", "/Users/reader/独立书库"),
  );
  await page.locator("#library-directory-choose").click();
  await page.locator("#library-import-enabled").check();
  await page.locator("#library-settings-save").click();
  await page.reload();
  const scanOnStartup = await page.evaluate(() =>
    (window as any).__mockCommands.some(
      (c: any) => c.command === "scan_library",
    ),
  );
  expect(scanOnStartup).toBe(false);
  await page.locator("#scan-settings").click();
  await expect(page.locator(".scan-directory-row")).toHaveCount(2);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#scan-add").focus();
  await page.screenshot({ path: "test-results/scan-multiple-long-path.png" });
  expect(
    await page
      .locator("#scan-dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  await page.locator("#scan-run").click();
  await expect(page.locator("#scan-report")).toContainText("新增 2 本");
  await page.screenshot({ path: "test-results/scan-success.png" });
  await page.locator("#scan-run").click();
  await expect(page.locator("#scan-report")).toContainText("新增 0 本");
  await page.locator("#scan-close").click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator("#recent-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(0);
  await page.locator("#library-nav").click();
  await page.locator('[data-book-key="sample"] .book-card').click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).__mockCommands
          .filter((c: any) => c.command === "open_book")
          .at(-1).args.importFile,
    ),
  ).toBe(true);
  await page.locator("#back").click();
  await page.locator("#scan-settings").click();
  await page.locator('[data-remove="0"]').click();
  await page.locator('[data-remove="0"]').click();
  await page.locator("#scan-save").click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator("#library-settings").click();
  await expect(page.locator("#library-directory")).toHaveText(
    "/Users/reader/独立书库",
  );
  await expect(page.locator("#library-import-enabled")).toBeChecked();
});

test("scan errors and limits remain reviewable, and cancelled drafts do not change configured sources", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#scan-settings").click();
  await page.evaluate(() =>
    localStorage.setItem("mock.scan_pick", JSON.stringify(["/unavailable"])),
  );
  await page.locator("#scan-add").click();
  await page.locator("#scan-save").click();
  await expect(page.locator("#scan-error")).toContainText("无法访问");
  await page.locator("#scan-cancel").click();
  await page.locator("#scan-settings").click();
  await expect(page.locator(".scan-directory-row")).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem("mock.scan_pick", JSON.stringify(["/sources"]));
    localStorage.setItem("mock.scan_error", "1");
    localStorage.setItem("mock.scan_limit", "1");
  });
  await page.locator("#scan-add").click();
  await page.locator("#scan-run").click();
  await expect(page.locator("#scan-report")).toContainText("失败 1 项");
  await expect(page.locator("#scan-report")).toContainText("扫描上限");
  await page.locator("#scan-report summary").click();
  await expect(page.locator("#scan-report li")).toContainText("broken.epub");
  await page.screenshot({ path: "test-results/scan-errors.png" });
});
