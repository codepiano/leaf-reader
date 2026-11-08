import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
test("compact shelf shows books early and size controls change widths, respect limits and persist", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  const cover = page.locator(".book-cover").first();
  expect((await cover.boundingBox())!.y).toBeLessThan(260);
  expect((await cover.boundingBox())!.width).toBeCloseTo(160, 0);
  await page.locator("#shelf-size-up").click();
  expect((await cover.boundingBox())!.width).toBeCloseTo(170, 0);
  await page.locator("#shelf-size").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#shelf-size")).toHaveValue("240");
  await expect(
    page.locator("#shelf-size-up").getByRole("button"),
  ).toBeDisabled();
  expect((await cover.boundingBox())!.width).toBeCloseTo(240, 0);
  await page.screenshot({ path: "test-results/shelf-large-cards.png" });
  await page.reload();
  await expect(page.locator("#shelf-size")).toHaveValue("240");
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#shelf-size").focus();
  await page.keyboard.press("Home");
  await expect(
    page.locator("#shelf-size-down").getByRole("button"),
  ).toBeDisabled();
  expect((await cover.boundingBox())!.width).toBeCloseTo(140, 0);
  expect(
    Math.abs((await cover.boundingBox())!.height - 140 / 0.72),
  ).toBeLessThan(1);
  expect((await cover.boundingBox())!.y).toBeLessThan(280);
  await page.screenshot({ path: "test-results/shelf-small-cards.png" });
  expect(
    await page
      .locator(".shelf-tools")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
});

test("cover requests follow viewport and distant decoded images lose their source", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true, "good");
  await page.addInitScript(() => {
    const s = JSON.parse(localStorage.getItem("mock.library")!);
    if (s.books.length < 10)
      s.books = Array.from({ length: 100 }, (_, n) => ({
        ...s.books[0],
        id: `lazy-${n}`,
        title: `Book ${n}`,
      }));
    localStorage.setItem("mock.library", JSON.stringify(s));
  });
  const requested: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/cover/")) requested.push(r.url());
  });
  await page.goto("/");
  await expect(page.locator(".book-card")).toHaveCount(100);
  await expect(
    page.locator('[data-book-key="lazy-0"] .has-embedded-cover'),
  ).toHaveCount(1);
  expect(requested.length).toBeLessThan(20);
  await expect(
    page.locator('[data-book-key="lazy-99"] .embedded-cover'),
  ).not.toHaveAttribute("src");
  await page
    .locator("#library-view")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(
    page.locator('[data-book-key="lazy-99"] .has-embedded-cover'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-book-key="lazy-0"] .embedded-cover'),
  ).not.toHaveAttribute("src");
});
