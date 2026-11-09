import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("frontmatter remains readable as collection extras without increasing the selected book count", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await page.locator("#collection-mode").click();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 3 本子书",
  );
  await page.locator("#collection-apply").click();
  await expect(page.locator(".book-card")).toHaveCount(3);
  await expect(page.locator("#shelf-count")).toHaveText("3 本");
  await expect(page.locator("#book-count")).toHaveText("3");
  await expect(
    page.locator('#collection-list [data-value="anthology"] small'),
  ).toHaveText("3");
  await expect(
    page.locator('[data-book-key="anthology::frontmatter"]'),
  ).toHaveCount(0);
  await expect(page.locator("#collection-frontmatter-open")).toBeVisible();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#collection-frontmatter-open").focus();
  await page.screenshot({
    path: "test-results/collection-frontmatter-extras.png",
  });
  await page.locator("#collection-frontmatter-open").click();
  await expect(page.frameLocator("#reader").locator("h1")).toHaveText(
    "合集序言",
  );
  await expect(
    page.locator('#toc details[data-node="part-frontmatter"] summary'),
  ).toContainText("附加内容");
  await page.locator("#book-info").click();
  await expect(page.locator("#book-info-content")).toContainText(
    "附加内容章节数",
  );
  await page.locator("#book-info-close").click();
  await page.locator("#back").click();
  await expect(page.locator(".book-card")).toHaveCount(3);
  await expect(page.locator("#collection-frontmatter-open")).toBeVisible();
  await page.locator("#library-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(3);
  await expect(page.locator("#collection-extras")).toBeHidden();
  await page.reload();
  await expect(page.locator("#book-count")).toHaveText("3");
  await page.locator('#collection-list [data-value="anthology"]').click();
  await expect(page.locator("#collection-frontmatter-open")).toBeVisible();
  const state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("mock.library")!),
  );
  expect(state.books[0].collection.parts).toHaveLength(4);
  expect(state.books[0].collection.parts[0].id).toBe("frontmatter");
});

test("an existing seven-book collection displays seven and preserves source records and real book titles", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.addInitScript(() => {
    const state = JSON.parse(localStorage.getItem("mock.library")!);
    const r = state.books.find((b: any) => b.id === "anthology");
    const part = (id: string, title: string) => ({
      id,
      title,
      start: { chapter: 0, fragment: "" },
      end: null,
      chapters: 1,
      opened: 0,
      progress: { chapter: 0, fraction: 0 },
    });
    r.collection = {
      enabled: true,
      parts: [
        part("frontmatter", "前置附加"),
        ...Array.from({ length: 7 }, (_, n) =>
          part(`toc-0-${n}`, n === 4 ? "卷首内容" : `子书 ${n + 1}`),
        ),
      ],
    };
    localStorage.setItem("mock.library", JSON.stringify(state));
    localStorage.setItem("mock.before-frontmatter", JSON.stringify(state));
  });
  await page.goto("/");
  await expect(page.locator("#book-count")).toHaveText("8");
  await expect(
    page.locator('#collection-list [data-value="anthology"] small'),
  ).toHaveText("7");
  await page.locator('#collection-list [data-value="anthology"]').click();
  await expect(page.locator("#shelf-count")).toHaveText("7 本");
  await expect(page.locator(".book-card")).toHaveCount(7);
  await expect(
    page.locator('[data-book-key="anthology::toc-0-4"] .book-info h3'),
  ).toHaveText("卷首内容");
  await expect(page.locator("#collection-frontmatter-open")).toHaveText(
    "前置附加",
  );
  const unchanged = await page.evaluate(
    () =>
      localStorage.getItem("mock.library") ===
      localStorage.getItem("mock.before-frontmatter"),
  );
  expect(unchanged).toBe(true);
});
