import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("library import is opt-in, directory picker can cancel, settings persist and errors stay visible", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#library-settings").click();
  const dialog = page.locator("#library-settings-dialog");
  const enabled = page.locator("#library-import-enabled");
  await expect(enabled).not.toBeChecked();
  await expect(page.locator("#library-directory")).toHaveText("尚未设置目录");
  await enabled.check();
  await expect(page.locator("#library-settings-save").getByRole("button")).toBeDisabled();
  await page.locator("#library-directory-choose").click();
  await expect(page.locator("#library-directory")).toHaveText("尚未设置目录");
  const directory =
    "/Users/reader/图书资料/" + "很长的用户书库目录名称/".repeat(8);
  await page.evaluate(
    (directory) => localStorage.setItem("mock.directory", directory),
    directory,
  );
  await page.locator("#library-directory-choose").click();
  await expect(page.locator("#library-directory")).toHaveText(directory);
  await enabled.uncheck();
  await page.locator("#library-settings-save").click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.locator("#library-settings").click();
  await expect(enabled).not.toBeChecked();
  await expect(page.locator("#library-directory")).toHaveText(directory);
  await enabled.check();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#library-directory-choose").focus();
  await page.screenshot({ path: "test-results/library-settings.png" });
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  await page.locator("#library-settings-save").click();
  await page.reload();
  await page.locator("#library-settings").click();
  await expect(enabled).toBeChecked();
  await page.evaluate(() =>
    localStorage.setItem("mock.directory", "/unavailable"),
  );
  await page.locator("#library-directory-choose").click();
  await page.locator("#library-settings-save").click();
  await expect(dialog).toBeVisible();
  await expect(page.locator("#library-settings-error")).toContainText(
    "无法访问",
  );
  await page.locator("#library-settings-cancel").click();
  await page.locator("#library-settings").click();
  await expect(page.locator("#library-directory")).toHaveText(directory);
  await page.locator("#library-directory-clear").click();
  await expect(enabled).not.toBeChecked();
  await expect(page.locator("#library-directory-clear").getByRole("button")).toBeDisabled();
  await page.screenshot({ path: "test-results/library-settings-disabled.png" });
  await page.locator("#library-settings-save").click();
  await page.locator("#library-settings").click();
  await expect(page.locator("#library-directory")).toHaveText("尚未设置目录");
});
