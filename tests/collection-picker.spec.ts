import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

test("picker starts with only the first level and folding preserves selections and conversion", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await page.locator("#collection-mode").click();
  await expect(page.locator("#collection-candidates input")).toHaveCount(1);
  await expect(
    page.locator("#collection-candidates .candidate-selection-count").first(),
  ).toHaveText("下级已选 3");
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 3 本子书",
  );
  const root = page.getByRole("button", {
    name: "展开 三册随笔合集",
    exact: true,
  });
  await root.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#collection-candidates input")).toHaveCount(4);
  await expect(
    page.locator('#collection-candidates input[value="toc-0-0-0"]'),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "展开 第一本：窗边", exact: true })
    .focus();
  await page.keyboard.press("Space");
  const parent = page.locator('#collection-candidates input[value="toc-0-0"]'),
    child = page.locator('#collection-candidates input[value="toc-0-0-0"]');
  await parent.uncheck();
  await child.check();
  await page
    .getByRole("button", { name: "收起 第一本：窗边", exact: true })
    .click();
  await expect(child).toBeHidden();
  await expect(child).toBeChecked();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 3 本子书",
  );
  await page
    .getByRole("button", { name: "展开 第一本：窗边", exact: true })
    .click();
  await expect(child).toBeChecked();
  await child.uncheck();
  await parent.check();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.screenshot({
    path: "test-results/collection-picker-expanded.png",
  });
  await page
    .getByRole("button", { name: "收起 三册随笔合集", exact: true })
    .click();
  await expect(
    page.locator("#collection-candidates input:visible"),
  ).toHaveCount(1);
  await page.screenshot({
    path: "test-results/collection-picker-collapsed.png",
  });
  await page.locator("#collection-apply").click();
  await expect(page.locator(".book-card")).toHaveCount(3);
  const selected = await page.evaluate(
    () =>
      (window as any).__mockCommands
        .filter((c: any) => c.command === "set_collection")
        .at(-1).args.nodeIds,
  );
  expect(selected.sort()).toEqual(["toc-0-0", "toc-0-1", "toc-0-2"]);
  await page.locator('[data-book-key="anthology::toc-0-1"] .book-card').click();
  await page.locator("#collection-mode").click();
  await expect(page.locator("#collection-candidates input")).toHaveCount(1);
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 3 本子书",
  );
});

test("large candidate sets initially mount only their first level without losing hidden selections", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  const stats = await page.evaluate(async () => {
    const { CollectionPicker } = await import("/src/collection-picker.ts");
    const root = document.createElement("section");
    root.id = "stress-picker";
    document.body.append(root);
    const candidates: any[] = [];
    for (let i = 0; i < 20; i++) {
      candidates.push({
        id: `root-${i}`,
        title: `第 ${i} 本`,
        depth: 0,
        start: { chapter: i, fragment: "" },
        suggested: false,
      });
      for (let j = 0; j < 500; j++)
        candidates.push({
          id: `child-${i}-${j}`,
          title: `第 ${j} 章`,
          depth: 1,
          start: { chapter: i, fragment: "" },
          suggested: false,
        });
    }
    let count = 0;
    const picker = new CollectionPicker(
      root,
      candidates,
      new Set(["child-0-499", "child-19-499"]),
      (n: number) => {
        count = n;
      },
    );
    const initial = root.querySelectorAll("input").length;
    (root.querySelector("button") as HTMLButtonElement).click();
    return {
      initial,
      expanded: root.querySelectorAll("input").length,
      count,
      chosen: picker.selectedIds(),
    };
  });
  expect(stats).toEqual({
    initial: 20,
    expanded: 520,
    count: 2,
    chosen: ["child-0-499", "child-19-499"],
  });
});
