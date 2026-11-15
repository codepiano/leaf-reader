import { showDialog } from "./focus";
import type { Book, MarkEdit, MarkStyle, ReadingMark, TextAnchor } from "./types";

export function markChapter(book: Book, mark: ReadingMark) {
  if (!mark.path) return mark.chapter;
  return book.chapters.findIndex((section) =>
    section.path === mark.path && (section.start_fragment || null) === mark.start_fragment);
}

type Draft = Extract<MarkEdit, { action: "add" | "update" }>;

export function initReadingMarks(
  edit: (change: MarkEdit) => Promise<void>,
  jump: (mark: ReadingMark) => void,
  bookmark: () => Promise<Draft>,
  annotation: () => Draft | undefined,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "app-dialog advanced-dialog";
  dialog.id = "reading-marks-dialog";
  dialog.setAttribute("aria-labelledby", "reading-marks-title");
  dialog.innerHTML = `
    <div class="dialog-heading"><h2 id="reading-marks-title">书签与批注</h2>
      <button id="marks-close" type="button" class="quiet-button">关闭</button>
    </div>
    <div id="marks-list-view">
      <div class="marks-actions">
        <button id="marks-add-bookmark" type="button" class="quiet-button">添加当前位置书签</button>
        <button id="marks-add-annotation" type="button" class="quiet-button">批注所选文字</button>
      </div>
      <p id="marks-selection-hint" class="field-hint"></p>
      <ul id="marks-list" aria-label="已保存的书签和批注"></ul>
    </div>
    <form id="marks-editor" hidden aria-labelledby="marks-editor-title">
      <h3 id="marks-editor-title"></h3>
      <blockquote id="marks-quote" hidden></blockquote>
      <fieldset id="marks-style" hidden>
        <legend>划线样式</legend>
        <label class="check-label"><input type="radio" name="style" value="underline" checked> 下划线</label>
        <label class="check-label"><input type="radio" name="style" value="highlight"> 高亮</label>
      </fieldset>
      <label class="form-field">备注<textarea id="marks-note" class="field-input" rows="4" maxlength="4000"></textarea></label>
      <div class="dialog-actions">
        <button id="marks-cancel" type="button" class="quiet-button">返回列表</button>
        <button id="marks-save" type="submit" class="primary-button">保存</button>
      </div>
    </form>
    <p id="marks-status" class="field-hint" role="status"></p>`;
  document.body.append(dialog);
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>("#" + id)!;
  const note = get<HTMLTextAreaElement>("marks-note");
  const form = get<HTMLFormElement>("marks-editor");
  const listView = get("marks-list-view");
  const list = get("marks-list");
  const status = get("marks-status");
  const addAnnotation = get<HTMLButtonElement>("marks-add-annotation");
  let draft: Draft | undefined;
  let pending = false;
  let generation = 0;
  let shownBook: Book | undefined;

  function showList() {
    draft = undefined;
    form.hidden = true;
    listView.hidden = false;
    status.textContent = "";
  }
  function refresh(book: Book) {
    const selected = !!annotation();
    addAnnotation.disabled = !selected;
    get("marks-selection-hint").textContent = !addAnnotation.hidden && !selected
      ? "在正文选中文字后，即可添加划线批注。" : "";
    shownBook = book;
    list.replaceChildren();
    const marks = book.reading_marks ?? [];
    for (const mark of [...marks].reverse()) {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      const index = markChapter(book, mark);
      const location = mark.path ? book.chapters[index]?.title || "原章节不可用" : `第 ${index + 1} 页`;
      title.textContent = `${mark.anchor ? "批注" : "书签"} · ${location}`;
      row.append(title);
      for (const text of [mark.anchor?.quote, mark.note]) {
        if (!text) continue;
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        row.append(paragraph);
      }
      const actions = document.createElement("div");
      actions.className = "marks-actions";
      for (const [label, callback] of [
        ["跳转", () => { if (index >= 0) jump(mark); }],
        ["编辑", () => showEditor({ action: "update", id: mark.id, style: mark.style, note: mark.note }, mark.anchor)],
        ["删除", () => void apply({ action: "remove", id: mark.id })],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet-button";
        button.textContent = label;
        button.disabled = label === "跳转" && index < 0;
        button.onclick = () => { if (!pending) callback(); };
        actions.append(button);
      }
      row.append(actions);
      list.append(row);
    }
    if (!marks.length && form.hidden) status.textContent = "本书还没有书签或批注。";
  }
  function showEditor(change: Draft, anchor: TextAnchor | null = change.action === "add" ? change.anchor : null) {
    draft = change;
    get("marks-editor-title").textContent = anchor ? "编辑划线批注" : "编辑书签";
    const quote = get("marks-quote");
    quote.hidden = !anchor;
    quote.textContent = anchor?.quote ?? "";
    get<HTMLFieldSetElement>("marks-style").hidden = !anchor;
    form.querySelector<HTMLInputElement>(`input[value="${change.style}"]`)!.checked = true;
    note.value = change.note;
    listView.hidden = true;
    form.hidden = false;
    status.textContent = "";
    note.focus();
  }
  async function apply(change: MarkEdit) {
    if (pending) return;
    const ticket = generation;
    pending = true;
    const save = get<HTMLButtonElement>("marks-save");
    save.disabled = true;
    try {
      await edit(change);
      if (ticket !== generation || !dialog.open) return;
      showList();
      if (shownBook) refresh(shownBook);
      get("marks-add-bookmark").focus();
      status.textContent = change.action === "remove" ? "已删除。" : "已保存。";
    } catch (error) {
      if (ticket === generation) status.textContent = String(error);
    } finally {
      pending = false;
      save.disabled = false;
    }
  }
  get("marks-close").onclick = () => dialog.close();
  get("marks-cancel").onclick = () => {
    if (pending) return;
    showList();
    if (shownBook) refresh(shownBook);
    get("marks-add-bookmark").focus();
  };
  get("marks-add-bookmark").onclick = async () => {
    if (pending) return;
    const ticket = generation;
    const button = get<HTMLButtonElement>("marks-add-bookmark");
    button.disabled = true;
    try {
      const change = await bookmark();
      if (ticket === generation && dialog.open) showEditor(change);
    } catch (error) {
      if (ticket === generation) status.textContent = String(error);
    } finally {
      button.disabled = false;
    }
  };
  addAnnotation.onclick = () => {
    const change = annotation();
    if (change) showEditor(change);
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!draft) return;
    const style = form.querySelector<HTMLInputElement>('input[name="style"]:checked')!.value as MarkStyle;
    void apply({ ...draft, style, note: note.value });
  };
  return {
    open(book: Book, canAnnotate: boolean) {
      generation++;
      showList();
      addAnnotation.hidden = !canAnnotate;
      refresh(book);
      showDialog(dialog);
    },
    close() { generation++; dialog.close(); },
  };
}
