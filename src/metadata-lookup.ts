import { invoke } from "@tauri-apps/api/core";
import { showDialog } from "./focus";
import type { Details } from "./types";

const bibliographicFields = {
  title: "书名",
  author: "作者",
  publisher: "出版社",
  published: "出版日期",
  isbn: "ISBN",
  language: "语言",
} as const;

type Candidate = { reference: string; details: Details };

export function initMetadataLookup(
  apply: (details: Details, overwrite: boolean) => number,
) {
  const dialog = document.createElement("dialog");
  dialog.id = "metadata-lookup-dialog";
  dialog.className = "app-dialog advanced-dialog";
  dialog.setAttribute("aria-labelledby", "metadata-lookup-title");
  dialog.innerHTML = `
    <div class="dialog-heading"><h2 id="metadata-lookup-title">从 Open Library 补全</h2></div>
    <form aria-labelledby="metadata-lookup-title">
      <label class="form-field" for="metadata-lookup-term">书名或 ISBN
        <input class="field-input" id="metadata-lookup-term" type="search" required maxlength="256">
      </label>
      <label class="form-field" for="metadata-lookup-author">作者（按书名查找时可选）
        <input class="field-input" id="metadata-lookup-author" maxlength="256">
      </label>
      <p class="field-hint">点击查找后，将使用 ISBN 或书名和作者在 Open Library 查询。</p>
      <div class="dialog-actions">
        <button type="button" id="metadata-lookup-close" class="quiet-button">关闭</button>
        <button type="submit" class="primary-button">查找</button>
      </div>
    </form>
    <p class="field-hint" id="metadata-lookup-status" role="status"></p>
    <div id="metadata-lookup-candidates" hidden>
      <div class="check-label">
        <input type="checkbox" id="metadata-lookup-overwrite">
        <label for="metadata-lookup-overwrite">替换已有字段</label>
      </div>
      <ul aria-label="候选书目"></ul>
    </div>
  `;
  document.body.append(dialog);

  const form = dialog.querySelector("form")!;
  const term = dialog.querySelector<HTMLInputElement>("#metadata-lookup-term")!;
  const author = dialog.querySelector<HTMLInputElement>("#metadata-lookup-author")!;
  const overwrite = dialog.querySelector<HTMLInputElement>("#metadata-lookup-overwrite")!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const status = dialog.querySelector<HTMLElement>("#metadata-lookup-status")!;
  const candidates = dialog.querySelector<HTMLElement>("#metadata-lookup-candidates")!;
  const list = candidates.querySelector("ul")!;
  let generation = 0;

  dialog.querySelector<HTMLButtonElement>("#metadata-lookup-close")!.onclick = () => dialog.close();
  form.oninput = () => {
    candidates.hidden = true;
    list.replaceChildren();
    if (!submit.disabled) status.textContent = "";
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const query = term.value.trim();
    const selectedAuthor = author.value.trim();
    if (!query) {
      status.textContent = "请输入书名或 ISBN。";
      term.focus();
      return;
    }
    const ticket = ++generation;
    submit.disabled = true;
    candidates.hidden = true;
    list.replaceChildren();
    status.textContent = "正在查询 Open Library…";
    try {
      const results = await invoke<Candidate[]>("lookup_book_metadata", {
        term: query, author: selectedAuthor,
      });
      if (!dialog.open || ticket !== generation) return;
      if (query !== term.value.trim() || selectedAuthor !== author.value.trim()) {
        status.textContent = "";
        return;
      }
      status.textContent = results.length
        ? `找到 ${results.length} 个候选，请核对后选用。`
        : "未找到候选。可以改用 ISBN 或调整书名和作者。";
      candidates.hidden = results.length === 0;
      for (const result of results) {
        const item = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = result.details.title || "未提供书名";
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "quiet-button";
        choice.textContent = "选用此书目";
        choice.setAttribute("aria-label", `选用此书目：${title.textContent} ${result.reference.split("/").at(-1)}`);
        const fields = document.createElement("dl");
        for (const [key, label] of Object.entries(bibliographicFields) as [keyof typeof bibliographicFields, string][]) {
          if (key === "title" || !result.details[key]) continue;
          const name = document.createElement("dt");
          const value = document.createElement("dd");
          name.textContent = label;
          value.textContent = result.details[key];
          fields.append(name, value);
        }
        item.append(title, fields, choice);
        list.append(item);
        choice.onclick = () => {
          if (apply(result.details, overwrite.checked)) dialog.close();
          else status.textContent = "现有字段已填写。勾选「替换已有字段」后可重新选用。";
        };
      }
    } catch (error) {
      if (dialog.open && ticket === generation) status.textContent = String(error);
    } finally {
      if (ticket === generation) submit.disabled = false;
    }
  };

  return (initial: Details) => {
    generation++;
    term.value = initial.isbn || initial.title;
    author.value = initial.isbn ? "" : initial.author;
    overwrite.checked = false;
    submit.disabled = false;
    status.textContent = "";
    list.replaceChildren();
    candidates.hidden = true;
    showDialog(dialog);
  };
}
