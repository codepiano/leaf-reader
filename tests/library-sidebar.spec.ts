import { expect, test } from "@playwright/test";
import { mockDesktop } from "./mock";

test("the bookcase sidebar gives back its space and remembers being collapsed", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "书架侧栏" });
  const sidebar = page.getByRole("complementary", { name: "书架侧栏" });
  const directory = page.locator("#toc-panel");

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator("#demo").click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
  const reader = page.locator("#reader");
  const expandedWidth = (await reader.boundingBox())!.width;

  await toggle.press("Enter");
  await expect(sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
  await expect(directory).toBeVisible();
  expect((await reader.boundingBox())!.width).toBeGreaterThan(expandedWidth);

  await page.locator("#back").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toBeHidden();

  await page.setViewportSize({ width: 800, height: 640 });
  await page.getByRole("button", { name: /继续阅读/ }).click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
  await toggle.press("Space");
  await expect(sidebar).toBeVisible();
  await expect(directory).toBeVisible();
  await page.screenshot({ path: "test-results/library-sidebar-expanded.png" });
  await toggle.press("Enter");
  await page.screenshot({ path: "test-results/library-sidebar-collapsed.png" });
});
