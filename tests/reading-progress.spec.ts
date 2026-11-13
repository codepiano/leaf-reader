import { expect, test } from "@playwright/test";
import { mockDesktop } from "./mock";

test("a short section counts less than a long one and the shelf shows the same progress", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, false, "none", [10, 80, 10]);
  await page.goto("/");
  await page.locator("#demo").click();
  const frame = page.frameLocator("#reader");
  const progress = page.getByRole("progressbar", { name: "阅读进度" });
  await expect(progress).toHaveJSProperty("value", 0);

  await page.locator('#toc [data-toc="2"]').click();
  await expect(frame.locator("h1")).toHaveText("散步的意义");
  await expect(page.locator("#position")).toHaveText("2 / 3 节 · 10%");
  await expect(progress).toHaveJSProperty("value", 10);
  await page.locator("#back").click();
  await expect(page.locator(".book-progress")).toHaveText("10% 已读");

  await page.getByRole("button", { name: /继续阅读/ }).click();
  await page.locator('#toc [data-toc="3"]').click();
  await expect(frame.locator("h1")).toHaveText("把时间还给自己");
  await expect(progress).toHaveJSProperty("value", 90);
  await frame.locator("body").evaluate((body) => {
    body.ownerDocument.defaultView!.scrollTo(0, body.ownerDocument.documentElement.scrollHeight);
  });
  await expect(progress).toHaveJSProperty("value", 100);
  await page.locator(".reader-footer").screenshot({ path: "test-results/reading-progress.png" });
});
