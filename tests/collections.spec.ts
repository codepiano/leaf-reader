import { test, expect } from "@playwright/test";
import { mockDesktop } from "./mock";

async function convert(page: import("@playwright/test").Page) {
  await page.locator("#collection-mode").click();
  await expect(page.locator("#collection-selection")).toHaveText(
    "已选择 3 本子书",
  );
  await page.locator("#collection-apply").click();
  await expect(page.locator("#collection-dialog")).toBeHidden();
  await expect(page.locator(".book-card")).toHaveCount(3);
}

test("unlinked tree headings collapse, logical books clip shared files, progress and mode survive reopen", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  const group = page.locator('#toc details[data-node="toc-0-0"]');
  await expect(group.locator("summary")).toHaveText("›第一本：窗边");
  await group.locator("summary").click();
  await expect(group).not.toHaveAttribute("open");
  await group.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(group).toHaveAttribute("open", "");
  await group.locator("summary").click();
  await page.screenshot({ path: "test-results/anthology-tree-collapsed.png" });
  await page.locator("#collection-mode").click();
  await expect(page.locator("#collection-dialog")).toBeVisible();
  await page.screenshot({ path: "test-results/collection-dialog.png" });
  await page
    .getByRole("button", { name: "展开 三册随笔合集", exact: true })
    .click();
  await page
    .locator("#collection-candidates input:checked")
    .evaluateAll((inputs) =>
      inputs.forEach((el) => {
        (el as HTMLInputElement).checked = false;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    );
  await expect(page.locator("#collection-apply")).toHaveAttribute(
    "disabled",
    "",
  );
  await page.screenshot({ path: "test-results/collection-disabled-apply.png" });
  await page.locator("#collection-close").click();
  await convert(page);
  await page.screenshot({ path: "test-results/logical-book-shelf.png" });
  const b = page.locator('.book-card[aria-label="继续阅读 第二本：散步"]');
  await b.click();
  const frame = page.frameLocator("#reader");
  await expect(frame.locator("h1")).toHaveText("散步");
  await expect(frame.locator("h1", { hasText: "夜读" })).toHaveCount(0);
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await expect(page.locator("#next")).toHaveAttribute("disabled", "");
  await frame.locator("body").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("PageDown");
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate((el) => el.ownerDocument.defaultView!.scrollY),
    )
    .toBeGreaterThan(100);
  await page.locator('#toc [data-part="toc-0-2"]').click();
  await expect(frame.locator("h1")).toHaveText("夜读");
  await expect(frame.locator("h1", { hasText: "散步" })).toHaveCount(0);
  await expect(page.locator("#position")).toContainText("0%");
  await page.locator("#back").click();
  await b.click();
  await expect(frame.locator("h1")).toHaveText("散步");
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate((el) => el.ownerDocument.defaultView!.scrollY),
    )
    .toBeGreaterThan(100);
  await page.locator("#collection-mode").click();
  await page.locator("#collection-disable").click();
  await expect(page.locator("#reader-view")).toBeVisible();
  await expect(page.locator("#chapter-loading")).toBeHidden();
  await expect(page.locator("#book-count")).toHaveText("1");
  await convert(page);
  await page.reload();
  await expect(page.locator(".book-card")).toHaveCount(3);
  await b.click();
  await expect(frame.locator("h1")).toHaveText("散步");
  await expect
    .poll(() =>
      frame
        .locator("body")
        .evaluate((el) => el.ownerDocument.defaultView!.scrollY),
    )
    .toBeGreaterThan(100);
});

test("groups, tags, favorites, search and recent reading persist without changing unrelated books", async ({
  page,
}) => {
  await mockDesktop(page, false, false, false, true);
  await page.goto("/");
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator("#new-group").click();
  const longGroup = "这是一段很长的分组名称用于验证下拉框留白和文字省略".repeat(
    2,
  );
  await page.locator("#group-name").fill(longGroup);
  await page.locator("#group-create").click();
  await expect(page.locator("#group-editor .group-edit-row")).toHaveCount(1);
  await page.locator("#groups-dialog .dialog-close").click();
  await page
    .locator('[data-book-key="sample"] [data-action="metadata"]')
    .click();
  await expect(page.locator("#metadata-dialog")).toBeVisible();
  await page.locator("#metadata-group").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.locator("#metadata-tags").fill("随笔，待读，随笔");
  await page.locator("#metadata-favorite").check();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.locator("#metadata-group").getByRole("combobox").focus();
  await page.locator("#metadata-group").evaluate(async (el: any) => {
    await el.hide();
  });
  await expect(
    page.locator("#metadata-group").getByRole("listbox"),
  ).toBeHidden();
  await page.screenshot({ path: "test-results/metadata-long-group-focus.png" });
  await page.locator("#metadata-group").evaluate(async (el: any) => {
    await el.show();
  });
  await page.screenshot({ path: "test-results/metadata-long-group-menu.png" });
  await page.locator("#metadata-group").evaluate(async (el: any) => {
    await el.hide();
  });
  await expect(
    page.locator("#metadata-group").getByRole("listbox"),
  ).toBeHidden();
  const geometry = await page.locator("#metadata-group").evaluate((el: any) => {
    const v = el.shadowRoot
        .querySelector('[part="display-input"]')
        .getBoundingClientRect(),
      a = el.shadowRoot
        .querySelector('[part="expand-icon"]')
        .getBoundingClientRect(),
      b = el.getBoundingClientRect();
    return { gap: a.left - v.right, inset: b.right - a.right };
  });
  expect(geometry.gap).toBeGreaterThanOrEqual(8);
  expect(geometry.inset).toBeGreaterThanOrEqual(10);
  await page.locator("#metadata-save").click();
  await expect(page.locator("#metadata-dialog")).toBeHidden();
  await page.locator("#favorites-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(page.locator(".book-tags>span")).toHaveCount(2);
  await page.locator("#recent-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(0);
  await page.locator("#library-nav").click();
  await page.locator('[data-book-key="sample"] .book-card').click();
  await expect(page.frameLocator("#reader").locator("h1")).toBeVisible();
  await page.locator("#back").click();
  await page.locator("#recent-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator("#library-nav").click();
  await page.locator("#shelf-search").fill("待读");
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator("#shelf-search").fill("不存在");
  await expect(page.locator("#filter-empty")).toBeVisible();
  await page.reload();
  await page.locator("#favorites-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await page.locator("#manage-groups").click();
  await page.locator('[data-group-input="0"]').fill("文学");
  await page.locator('[data-group-rename="0"]').click();
  await expect(page.locator('[data-group-input="0"]')).toHaveValue("文学");
  await page.locator('[data-group-delete="0"]').click();
  await expect(page.locator("#group-editor .group-edit-row")).toHaveCount(0);
  await page.locator("#groups-dialog .dialog-close").click();
  await page.locator("#library-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.locator('[data-filter="group"][data-value=""]').click();
  await expect(page.locator(".book-card")).toHaveCount(2);
  await expect(page.locator(".favorite-button.is-favorite")).toHaveCount(1);
});

test("logical children can be favorited independently and invalid mixed-level conversion remains reviewable", async ({
  page,
}) => {
  await mockDesktop(page, false, false, true);
  await page.goto("/");
  await page.locator("#demo").click();
  await convert(page);
  await page
    .locator('[data-book-key="anthology::toc-0-1"] .favorite-button')
    .click();
  await page.locator("#favorites-nav").click();
  await expect(page.locator(".book-card")).toHaveCount(1);
  await expect(page.locator(".book-info h3")).toHaveText("第二本：散步");
  await page.locator("#library-nav").click();
  await expect(page.locator(".favorite-button.is-favorite")).toHaveCount(1);
  await page.locator('.book-card[aria-label="继续阅读 第一本：窗边"]').click();
  await page.locator("#collection-mode").click();
  await page
    .getByRole("button", { name: "展开 三册随笔合集", exact: true })
    .click();
  await page
    .getByRole("button", { name: "展开 第一本：窗边", exact: true })
    .click();
  await page.locator('#collection-candidates input[value="toc-0-0-0"]').check();
  await page.locator("#collection-apply").click();
  await expect(page.locator("#collection-error")).toContainText("不能同时选择");
  await expect(page.locator("#collection-dialog")).toBeVisible();
});
