import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("chapter navigation, anchors, local assets and saved reading position", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await expect(page.locator("#empty")).toBeVisible();
  await page.screenshot({ path: "test-results/library-empty.png" });
  await page.locator("#demo").click();
  const frame = page.frameLocator("#reader");
  await expect(frame.locator("h1")).toHaveText("窗边的一小时");
  await expect
    .poll(() =>
      frame
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(120);
  await expect
    .poll(() =>
      frame
        .locator("blockquote")
        .evaluate((el) => getComputedStyle(el).borderLeftWidth),
    )
    .toBe("2px");
  await expect(page.locator("#prev")).toHaveAttribute("disabled", "");
  await page.locator('[data-toc="1"]').click();
  await expect
    .poll(() =>
      frame
        .locator("h2")
        .evaluate((el) => Math.abs(el.getBoundingClientRect().top)),
    )
    .toBeLessThan(3);
  await frame.locator("body").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("ArrowRight");
  await expect(frame.locator("h1")).toHaveText("散步的意义");
  await page.waitForTimeout(1600);
  await frame
    .locator("body")
    .evaluate((el) => el.ownerDocument.defaultView!.scrollTo(0, 650));
  await page.waitForTimeout(450);
  await page.locator("#back").click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.screenshot({ path: "test-results/library-book.png" });
  await page.locator(".book-card").click();
  await expect(frame.locator("h1")).toHaveText("散步的意义");
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate((el) => el.ownerDocument.defaultView!.scrollY),
    )
    .toBeGreaterThan(600);
  await page.screenshot({ path: "test-results/reader.png" });
  await page.locator('#toc [data-toc="3"]').click();
  await expect(frame.locator("h1")).toHaveText("把时间还给自己");
  await expect(page.locator("#next")).toHaveAttribute("disabled", "");
  await frame.locator("a").click();
  await expect(frame.locator("h1")).toHaveText("窗边的一小时");
});

test("a missing chapter reports an error and still allows returning to the shelf", async ({
  page,
}) => {
  await mockDesktop(page, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await expect(page.locator("#toast")).toContainText("章节资源不存在");
  await page.locator("#back").click();
  await expect(page.locator("#library-view")).toBeVisible();
  await expect(page.locator(".book-card")).toHaveCount(1);
});

test("Web Awesome controls: keyboard, long label, disabled and persisted theme", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.locator("#demo").click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
  await page.locator("#appearance").click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  const select = page.locator("#font-family");
  await select.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(() => select.evaluate((el: any) => el.value)).toBe("sans");
  await page.locator("#font-size").getByRole("slider").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#size-value")).toHaveText("20 px");
  await page.locator('[data-theme="night"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page.screenshot({ path: "test-results/settings-night.png" });
  await page.locator('[data-theme="paper"]').click();
  await select
    .locator("wa-option")
    .last()
    .evaluate((el) => {
      el.textContent =
        "非常长的字体选项，用于检查文字和箭头之间的留白以及省略效果";
    });
  await page.setViewportSize({ width: 900, height: 700 });
  await select.focus();
  await page.screenshot({ path: "test-results/settings-long-focus.png" });
  const geometry = await select.evaluate((el: any) => {
    const value = el.shadowRoot
      .querySelector('[part="display-input"]')
      .getBoundingClientRect();
    const arrow = el.shadowRoot
      .querySelector('[part="expand-icon"]')
      .getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return { gap: arrow.left - value.right, inset: box.right - arrow.right };
  });
  expect(geometry.gap).toBeGreaterThanOrEqual(8);
  expect(geometry.inset).toBeGreaterThanOrEqual(10);
  await select.evaluate((el: any) => {
    el.disabled = true;
  });
  await page.screenshot({ path: "test-results/settings-disabled.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
  await page.reload();
  await page.locator("#appearance").click();
  await expect(page.locator("#size-value")).toHaveText("20 px");
});

test("book markup cannot execute scripts, embed frames or send network requests", async ({
  page,
}) => {
  await mockDesktop(page, true);
  const outgoing: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith("https:")) outgoing.push(req.url());
  });
  await page.goto("/");
  await page.locator("#demo").click();
  const frame = page.frameLocator("#reader");
  await expect(frame.locator("h1")).toBeVisible();
  await expect(frame.locator("iframe,form,input")).toHaveCount(0);
  await expect(frame.locator("script")).toHaveCount(1);
  await expect(frame.locator("script")).toHaveAttribute(
    "src",
    /\/reader-bridge\.js$/,
  );
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        void parent.document.body;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  expect(
    await page.locator("body").getAttribute("data-compromised"),
  ).toBeNull();
  expect(outgoing).toEqual([]);
});
