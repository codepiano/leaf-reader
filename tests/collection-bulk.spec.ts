import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";
test("bulk actions target the displayed sibling layer, remove overlaps, and clear folded choices", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await page.locator("#collection-mode").click();
  const select = page.getByRole("button", { name: "全选当前层", exact: true }),
    clear = page.getByRole("button", { name: "取消全选", exact: true });
  await expect(page.locator(".collection-current-layer")).toHaveText(
    "当前层：第一层",
  );
  await clear.click();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 0 本子书",
  );
  await expect(
    page.locator("[data-clear-selection]").getByRole("button"),
  ).toBeDisabled();
  await expect(page.locator("#collection-apply")).toHaveAttribute(
    "disabled",
    "",
  );
  await page
    .getByRole("button", { name: "展开 三册随笔合集", exact: true })
    .click();
  await expect(page.locator(".collection-current-layer")).toHaveText(
    "当前层：三册随笔合集 的下级",
  );
  await select.click();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 3 本子书",
  );
  await page
    .getByRole("button", { name: "收起 三册随笔合集", exact: true })
    .click();
  await select.click();
  await expect(
    page.locator('#collection-candidates input[value="toc-0"]'),
  ).toBeChecked();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 1 本子书",
  );
  await page
    .getByRole("button", { name: "展开 三册随笔合集", exact: true })
    .click();
  await select.click();
  await expect(
    page.locator('#collection-candidates input[value="toc-0"]'),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "展开 第一本：窗边", exact: true })
    .click();
  await page.keyboard.press("Tab");
  await expect(page.locator(".collection-current-layer")).toHaveText(
    "当前层：第一本：窗边 的下级",
  );
  await select.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 4 本子书",
  );
  await expect(
    page.locator('#collection-candidates input[value="toc-0-0"]'),
  ).not.toBeChecked();
  await expect(
    page.locator('#collection-candidates input[value="toc-0-0-0"]'),
  ).toBeChecked();
  await expect(
    page.locator('#collection-candidates input[value="toc-0-0-1"]'),
  ).toBeChecked();
  await expect(
    page.locator('#collection-candidates input[value="toc-0-1"]'),
  ).toBeChecked();
  await page.setViewportSize({ width: 900, height: 700 });
  await select.focus();
  await page.screenshot({ path: "test-results/collection-bulk-layer.png" });
  await page
    .getByRole("button", { name: "收起 三册随笔合集", exact: true })
    .click();
  await clear.click();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 0 本子书",
  );
  await expect(
    page.locator("#collection-candidates input:checked"),
  ).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: "test-results/collection-bulk-cleared.png" });
  await page
    .getByRole("button", { name: "展开 三册随笔合集", exact: true })
    .click();
  await select.click();
  await page.locator("#collection-apply").click();
  await expect(page.locator(".book-card")).toHaveCount(3);
  const ids = await page.evaluate(
    () =>
      (window as any).__mockCommands
        .filter((c: any) => c.command === "set_collection")
        .at(-1).args.nodeIds,
  );
  expect(ids.sort()).toEqual(["toc-0-0", "toc-0-1", "toc-0-2"]);
});

test("disabled nodes are skipped and bulk updates do not eagerly mount children", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { CollectionPicker } = await import("/src/collection-picker.ts");
    const container = document.createElement("section");
    document.body.append(container);
    let count = 0;
    const node = (id: string, depth: number, start: any) => ({
      id,
      title: id,
      depth,
      start,
      suggested: false,
    });
    const picker = new CollectionPicker(
      container,
      [
        node("one", 0, { chapter: 0, fragment: "" }),
        node("disabled", 0, null),
        node("branch", 0, { chapter: 1, fragment: "" }),
        node("child", 1, { chapter: 1, fragment: "a" }),
      ],
      new Set(["child"]),
      (n: number) => (count = n),
    );
    await Promise.all(
      Array.from(
        container.querySelectorAll("wa-button"),
        (element) => (element as any).updateComplete,
      ),
    );
    (container.querySelector("[data-select-layer]") as HTMLElement).click();
    const first = {
      ids: picker.selectedIds().sort(),
      count,
      inputs: container.querySelectorAll("input").length,
      disabled: (
        container.querySelector('input[value="disabled"]') as HTMLInputElement
      ).disabled,
    };
    (container.querySelector(".candidate-toggle") as HTMLElement).click();
    (container.querySelector("[data-select-layer]") as HTMLElement).click();
    const nested = { ids: picker.selectedIds().sort(), count };
    (container.querySelector("[data-clear-selection]") as HTMLElement).click();
    return { first, nested, cleared: picker.selectedIds(), count };
  });
  expect(result).toEqual({
    first: { ids: ["branch", "one"], count: 2, inputs: 3, disabled: true },
    nested: { ids: ["child", "one"], count: 2 },
    cleared: [],
    count: 0,
  });
});
