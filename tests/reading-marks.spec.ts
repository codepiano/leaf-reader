import { expect, test } from "@playwright/test";
import { mockDesktop } from "./mock";
import type { ReadingMark, MarkEdit } from "../src/types";

test("bookmarks and exact text annotations persist and can be reopened, updated and removed", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.evaluate(() => {
    const internal = (window as any).__TAURI_INTERNALS__;
    const invoke = internal.invoke;
    internal.invoke = async (command: string, args: { edit: MarkEdit }) => {
      const read = (): ReadingMark[] => JSON.parse(localStorage.getItem("mock.marks") || "[]");
      if (command === "edit_reading_marks") {
        const marks = read();
        const change = args.edit;
        if (change.action === "add") {
          const { chapter, fraction, anchor, style, note } = change;
          marks.push({ id: crypto.randomUUID(), chapter, path: `OPS/ch${chapter + 1}.xhtml`,
            start_fragment: null, fraction, anchor, style, note });
        }
        if (change.action === "update") {
          const mark = marks.find(({ id }) => id === change.id)!;
          Object.assign(mark, { note: change.note, style: change.style });
        }
        const result = change.action === "remove" ? marks.filter(({ id }) => id !== change.id) : marks;
        localStorage.setItem("mock.marks", JSON.stringify(result));
        return result;
      }
      const result = await invoke(command, args);
      if (command === "open_demo" || command === "open_book") result.reading_marks = read();
      return result;
    };
  });
  await page.locator("#demo").click();
  const frame = page.frameLocator("#reader");
  const openMarks = () => page.getByRole("button", { name: "书签与批注" }).click();
  const marks = page.getByRole("dialog", { name: "书签与批注" });
  const selectedText = frame.locator("p").filter({ hasText: "清晨的光线" }).nth(2);
  await expect(selectedText).toBeVisible();
  await openMarks();
  await expect(marks.getByRole("button", { name: "批注所选文字" })).toBeDisabled();
  await page.screenshot({ path: "test-results/reading-marks-empty.png" });
  await marks.getByRole("button", { name: "添加当前位置书签" }).click();
  await marks.getByLabel("备注").fill("开篇书签");
  await marks.getByRole("button", { name: "保存" }).click();
  await expect(marks.locator("li")).toContainText(["开篇书签"]);
  await marks.getByRole("button", { name: "关闭" }).click();
  await selectedText.evaluate((el) => {
    const range = el.ownerDocument.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 7);
    const selection = el.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect.poll(() => selectedText.evaluate((el) => el.ownerDocument.getSelection()?.toString())).toBe("清晨的光线慢慢");
  await openMarks();
  await marks.getByRole("button", { name: "批注所选文字" }).click();
  await expect(marks.locator("blockquote")).toHaveText("清晨的光线慢慢");
  await marks.getByLabel("备注").fill("只标第三处，即使书里出现多次相同的文字也要跳回这里。");
  await page.setViewportSize({ width: 800, height: 660 });
  await page.screenshot({ path: "test-results/reading-marks-narrow.png" });
  await marks.getByRole("button", { name: "保存" }).click();
  await expect(marks.locator("li")).toHaveCount(2);
  await marks.getByRole("button", { name: "关闭" }).click();
  await expect(frame.locator("mark.leaf-annotation-underline")).toHaveCount(1);
  await expect(selectedText.locator("mark")).toHaveText("清晨的光线慢慢");
  await page.locator("#back").click();
  await page.locator(".book-card").click();
  await expect(selectedText.locator("mark")).toHaveText("清晨的光线慢慢");
  await openMarks();
  const annotation = marks.locator("li").filter({ hasText: "只标第三处" });
  await annotation.getByRole("button", { name: "跳转" }).click();
  await expect(marks).toBeHidden();
  await expect(selectedText.locator("mark")).toBeInViewport();
  await openMarks();
  await annotation.getByRole("button", { name: "编辑" }).click();
  await marks.getByLabel("高亮").check();
  await marks.getByLabel("备注").fill("已修改");
  await marks.getByRole("button", { name: "保存" }).click();
  await expect(marks.locator("li")).toContainText(["已修改", "开篇书签"]);
  await marks.locator("li").filter({ hasText: "已修改" }).getByRole("button", { name: "删除" }).click();
  await expect(marks.locator("li")).toHaveCount(1);
  await marks.getByRole("button", { name: "关闭" }).click();
  await expect(frame.locator("mark.leaf-annotation")).toHaveCount(0);

  await page.locator("#next").click();
  await expect(frame.locator("h1")).toHaveText("散步的意义");
  await openMarks();
  await marks.locator("li").filter({ hasText: "开篇书签" }).getByRole("button", { name: "跳转" }).click();
  await expect(frame.locator("h1")).toHaveText("窗边的一小时");
});
