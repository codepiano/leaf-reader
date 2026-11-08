import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
test("title, author and recent sorts persist and pins always lead across filters", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.addInitScript(() => {
    if (localStorage.getItem("mock.sorted")) return;
    const s = JSON.parse(localStorage.getItem("mock.library")!);
    const base = s.books[0];
    s.books = [
      {
        ...base,
        id: "alpha",
        title: "Alpha Book",
        author: "Beta",
        opened: 2000000000000,
      },
      {
        ...base,
        id: "beta",
        title: "Beta Book",
        author: "Alpha",
        opened: 2100000000000,
      },
      {
        ...base,
        id: "unknown",
        title: "Gamma Book",
        author: "",
        opened: 2050000000000,
      },
      {
        ...base,
        id: "pinned",
        title: "Z Book",
        author: "Z",
        opened: 0,
        metadata: { ...base.metadata, pinned: true },
      },
    ];
    localStorage.setItem("mock.library", JSON.stringify(s));
    localStorage.setItem("mock.sorted", "1");
  });
  await page.goto("/");
  const order = () =>
    page
      .locator(".book-tile")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-book-key")));
  await expect.poll(order).toEqual(["pinned", "beta", "unknown", "alpha"]);
  await page.locator("#shelf-sort").click();
  await page.getByRole("option", { name: "书名", exact: true }).click();
  await expect.poll(order).toEqual(["pinned", "alpha", "beta", "unknown"]);
  await page.locator("#shelf-sort").click();
  await page.getByRole("option", { name: "作者", exact: true }).click();
  await expect.poll(order).toEqual(["pinned", "beta", "alpha", "unknown"]);
  await page.reload();
  await expect.poll(order).toEqual(["pinned", "beta", "alpha", "unknown"]);
  await expect(page.locator("#shelf-sort").getByRole("combobox")).toHaveValue(
    "作者",
  );
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#shelf-sort").getByRole("combobox").focus();
  await page.screenshot({ path: "test-results/shelf-sorting.png" });
  expect(
    await page
      .locator(".shelf-tools")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBeTruthy();
  await page.locator("#shelf-sort").click();
  await page.getByRole("option", { name: "最近阅读时间", exact: true }).click();
  await expect.poll(order).toEqual(["pinned", "beta", "unknown", "alpha"]);
  await page.locator("#recent-nav").click();
  await expect.poll(order).toEqual(["beta", "unknown", "alpha"]);
});
