import { compareBooks, savedSort, validSort, sortLabels } from "./shelf-sort";
import { initShelfSize } from "./shelf-size";
import { Covers } from "./covers";
import { showBookInfo } from "./book-info";
import { invoke } from "@tauri-apps/api/core";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import {
  type Snapshot,
  type ShelfItem,
  emptyMeta,
  escapeHTML as esc,
} from "./types";

type Filter = {
  kind:
    "all" | "recent" | "favorite" | "group" | "tag" | "collection" | "status";
  value?: string;
};
const normalizedMeta = (
  meta: ReturnType<typeof emptyMeta> | undefined,
  opened: number,
) => ({
  ...emptyMeta(),
  ...meta,
  reading_status:
    meta?.reading_status ??
    (opened > 0 ? ("reading" as const) : ("unread" as const)),
});
const statusTitle = (status: string | null) =>
  status === "finished" ? "读过" : status === "reading" ? "在读" : "未读";
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
export class Shelf {
  private covers = new Covers();
  private sort = savedSort();
  private sortReady: Promise<unknown> | undefined;
  data: Snapshot = { books: [], groups: [] };
  filter: Filter = { kind: "all" };
  query = "";
  constructor(
    private open: (path: string, partId?: string) => void,
    private navigate: (filter: Filter) => void,
    private error: (e: unknown) => void,
    private icon: (name: string) => string,
  ) {
    document
      .querySelector(".sidebar nav")!
      .insertAdjacentHTML(
        "beforeend",
        `<button id="recent-nav" class="nav-item">${icon("book")}<span>最近阅读</span></button><button id="favorites-nav" class="nav-item"><span class="nav-star">☆</span><span>我的收藏</span><span id="favorite-count" class="count">0</span></button>`,
      );
    $("#toc-panel").insertAdjacentHTML(
      "beforebegin",
      '<div class="library-sections"><div class="section-label">阅读分类</div><div id="reading-status-list" class="filter-list"></div><div class="section-label">书籍分组<button id="new-group" class="small-action" aria-label="新建分组">+</button></div><div id="group-list" class="filter-list"></div><div class="section-label">合集</div><div id="collection-list" class="filter-list"></div><div class="section-label">标签</div><div id="tag-list" class="tag-filter-list"></div></div>',
    );
    $(".shelf-heading").insertAdjacentHTML(
      "afterend",
      '<div class="shelf-tools"><input id="shelf-search" class="field-input" type="search" aria-label="搜索书籍、作者和标签" placeholder="搜索书名、作者、标签…"><label class="shelf-sort">排序<wa-select id="shelf-sort" aria-label="书架排序" size="s"><wa-option value="recent">最近阅读时间</wa-option><wa-option value="title">书名</wa-option><wa-option value="author">作者</wa-option></wa-select></label><wa-button id="manage-groups" class="quiet-button" size="s">管理分组</wa-button></div><p id="filter-empty" class="filter-empty" hidden>这里还没有书籍。</p>',
    );
    initShelfSize();
    $("#shelf-sort").addEventListener("change", () => {
      const value = $<WaSelect>("#shelf-sort").value;
      if (!validSort(value)) return;
      this.sort = value;
      try {
        localStorage.setItem("leaf.shelf-sort", value);
      } catch {
        /* In-memory preference still works. */
      }
      this.renderCards();
    });
    document.body.insertAdjacentHTML(
      "beforeend",
      `
      <dialog id="metadata-dialog" class="app-dialog"><form method="dialog"><div class="dialog-heading"><div><div class="eyebrow">整理书籍</div><h2 id="metadata-title"></h2></div><wa-button class="icon-button dialog-close" aria-label="关闭书籍设置" size="s">×</wa-button></div><label class="form-field">分组<wa-select id="metadata-group" aria-label="书籍分组" size="s"></wa-select></label><label class="form-field">阅读分类<wa-select id="metadata-status" aria-label="阅读分类" size="s"><wa-option value="unread">未读</wa-option><wa-option value="reading">在读</wa-option><wa-option value="finished">读过</wa-option></wa-select></label><label class="check-label"><input id="metadata-pinned" type="checkbox">置顶这本书</label><label class="form-field">标签<input id="metadata-tags" class="field-input" placeholder="多个标签用逗号分隔" maxlength="1950"><span class="field-hint">例如：文学，待读，2026</span></label><label class="check-label"><input id="metadata-favorite" type="checkbox">收藏这本书</label><div class="dialog-actions"><wa-button class="quiet-button dialog-close" size="s">取消</wa-button><wa-button id="metadata-save" class="primary-button" size="s">保存</wa-button></div></form></dialog>
      <dialog id="groups-dialog" class="app-dialog"><div class="dialog-heading"><h2>管理分组</h2><wa-button class="icon-button dialog-close" aria-label="关闭分组管理" size="s">×</wa-button></div><form id="new-group-form" class="group-create"><input id="group-name" class="field-input" required maxlength="64" aria-label="新分组名称" placeholder="新分组名称"><wa-button id="group-create" class="primary-button" size="s">新建</wa-button></form><div id="group-editor"></div><p class="field-hint">删除分组后，书籍会回到“未分组”。</p></dialog>`,
    );
    document
      .querySelectorAll<HTMLDialogElement>("#metadata-dialog,#groups-dialog")
      .forEach((d) =>
        d.querySelectorAll<HTMLElement>(".dialog-close").forEach(
          (b) =>
            (b.onclick = (e) => {
              e.preventDefault();
              d.close();
            }),
        ),
      );
    $("#metadata-dialog form").addEventListener("submit", (e) => {
      e.preventDefault();
      $("#metadata-save").click();
    });
    $("#recent-nav").onclick = () => this.navigate({ kind: "recent" });
    $("#favorites-nav").onclick = () => this.navigate({ kind: "favorite" });
    $("#new-group").onclick = $("#manage-groups").onclick = () =>
      this.showGroups();
    $<HTMLInputElement>("#shelf-search").oninput = (e) => {
      this.query = (e.target as HTMLInputElement).value;
      this.renderCards();
    };
    $("#group-create").onclick = () => void this.createGroup();
    $("#new-group-form").onsubmit = (e) => {
      e.preventDefault();
      void this.createGroup();
    };
    $("#shelf").addEventListener("click", (e) => {
      const target = (e.target as Element).closest<HTMLElement>(
        "[data-action]",
      );
      if (!target) return;
      const item = this.items().find((i) => i.key === target.dataset.key);
      if (!item) return;
      if (target.dataset.action === "read")
        this.open(item.path, item.partId ?? undefined);
      if (target.dataset.action === "pin")
        void this.pin(item, target as WaButton);
      if (target.dataset.action === "info")
        void showBookInfo(item.sourceId, item.partId);
      if (target.dataset.action === "metadata") void this.edit(item);
      if (target.dataset.action === "favorite")
        void this.favorite(item, target as WaButton);
      if (target.dataset.action === "collection")
        this.navigate({ kind: "collection", value: item.sourceId });
    });
  }
  private reportError(error: unknown) {
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (!dialog) {
      this.error(error);
      return;
    }
    let label = dialog.querySelector<HTMLElement>(".dialog-error");
    if (!label) {
      label = document.createElement("p");
      label.className = "dialog-error";
      label.setAttribute("role", "alert");
      dialog.append(label);
    }
    label.textContent = String(error);
  }
  items(): ShelfItem[] {
    return this.data.books.flatMap<ShelfItem>((r) =>
      r.collection?.enabled
        ? r.collection.parts.map((p) => ({
            key: `${r.id}::${p.id}`,
            sourceId: r.id,
            partId: p.id,
            path: r.path,
            title: p.title,
            author: r.part_metadata?.[p.id]?.details?.author || r.author,
            sourceTitle: r.title,
            chapters: p.chapters,
            progress: p.progress,
            opened: p.opened,
            metadata: normalizedMeta(r.part_metadata?.[p.id], p.opened),
          }))
        : [
            {
              key: r.id,
              sourceId: r.id,
              partId: null,
              path: r.path,
              title: r.title,
              author: r.author,
              chapters: r.chapters,
              progress: r.progress,
              opened: r.opened,
              metadata: normalizedMeta(r.metadata, r.opened),
            },
          ],
    );
  }
  async refresh() {
    this.data = await invoke<Snapshot>("library_snapshot");
    this.render();
  }
  select(filter: Filter) {
    this.filter = filter;
    this.query = "";
    $<HTMLInputElement>("#shelf-search").value = "";
    this.render();
  }
  render() {
    const all = this.items();
    if (all.length && !this.sortReady) {
      this.sortReady = Promise.all([
        import("@awesome.me/webawesome/dist/components/select/select.js"),
        import("@awesome.me/webawesome/dist/components/option/option.js"),
      ])
        .then(() => {
          $<WaSelect>("#shelf-sort").value = this.sort;
        })
        .catch(this.error);
    }
    $("#book-count").textContent = String(all.length);
    $("#favorite-count").textContent = String(
      all.filter((i) => i.metadata.favorite).length,
    );
    $("#library-nav").classList.toggle("active", this.filter.kind === "all");
    $("#recent-nav").classList.toggle("active", this.filter.kind === "recent");
    $("#favorites-nav").classList.toggle(
      "active",
      this.filter.kind === "favorite",
    );
    const filterButton = (
      kind: Filter["kind"],
      value: string,
      title: string,
      count: number,
    ) =>
      `<button class="filter-item ${this.filter.kind === kind && this.filter.value === value ? "active" : ""}" data-filter="${kind}" data-value="${esc(value)}" title="${esc(title)}"><span>${esc(title)}</span><small>${count}</small></button>`;
    $("#reading-status-list").innerHTML = ["unread", "reading", "finished"]
      .map((status) =>
        filterButton(
          "status",
          status,
          statusTitle(status),
          all.filter((i) => i.metadata.reading_status === status).length,
        ),
      )
      .join("");
    $("#group-list").innerHTML =
      filterButton(
        "group",
        "",
        "未分组",
        all.filter((i) => !i.metadata.group).length,
      ) +
      this.data.groups
        .map((g) =>
          filterButton(
            "group",
            g,
            g,
            all.filter((i) => i.metadata.group === g).length,
          ),
        )
        .join("");
    $("#collection-list").innerHTML =
      this.data.books
        .filter((r) => r.collection?.enabled)
        .map((r) =>
          filterButton("collection", r.id, r.title, r.collection.parts.length),
        )
        .join("") ||
      '<span class="sidebar-note">打开书籍后可切换合集模式</span>';
    const tags = [...new Set(all.flatMap((i) => i.metadata.tags))].sort(
      (a, b) => a.localeCompare(b),
    );
    $("#tag-list").innerHTML =
      tags
        .map(
          (t) =>
            `<button class="tag-filter ${this.filter.kind === "tag" && this.filter.value === t ? "active" : ""}" data-filter="tag" data-value="${esc(t)}" title="${esc(t)}">${esc(t)}</button>`,
        )
        .join("") || '<span class="sidebar-note">在书籍设置中添加标签</span>';
    document.querySelectorAll<HTMLElement>("[data-filter]").forEach(
      (b) =>
        (b.onclick = () =>
          this.navigate({
            kind: b.dataset.filter as Filter["kind"],
            value: b.dataset.value,
          })),
    );
    this.renderCards();
  }
  renderCards() {
    const all = this.items();
    let list = all.filter((i) =>
      this.filter.kind === "status"
        ? i.metadata.reading_status === this.filter.value
        : this.filter.kind === "favorite"
          ? i.metadata.favorite
          : this.filter.kind === "recent"
            ? i.opened > 0
            : this.filter.kind === "group"
              ? i.metadata.group === (this.filter.value ?? "")
              : this.filter.kind === "tag"
                ? i.metadata.tags.includes(this.filter.value!)
                : this.filter.kind === "collection"
                  ? i.sourceId === this.filter.value
                  : true,
    );
    const q = this.query.trim().toLocaleLowerCase();
    if (q)
      list = list.filter((i) =>
        [i.title, i.author, i.sourceTitle ?? "", ...i.metadata.tags]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q),
      );
    list.sort((a, b) => compareBooks(this.sort, a, b));
    const source = this.data.books.find((r) => r.id === this.filter.value);
    const title =
      this.filter.kind === "status"
        ? statusTitle(this.filter.value!)
        : this.filter.kind === "recent"
          ? "最近阅读"
          : this.filter.kind === "favorite"
            ? "我的收藏"
            : this.filter.kind === "group"
              ? this.filter.value || "未分组"
              : this.filter.kind === "tag"
                ? `标签 · ${this.filter.value}`
                : this.filter.kind === "collection"
                  ? (source?.title ?? "合集")
                  : "我的书架";
    $(".shelf-heading h2").innerHTML =
      `${esc(title)} <span id="shelf-count">${list.length} 本</span>`;
    $(".shelf-heading>.muted").textContent =
      `置顶优先 · ${sortLabels[this.sort]}`;
    $("#empty").hidden = all.length > 0;
    $("#filter-empty").hidden = !all.length || list.length > 0;
    $(".shelf-tools").toggleAttribute("hidden", all.length === 0);
    $("#filter-empty").textContent = q
      ? "没有找到匹配的书籍。"
      : this.filter.kind === "recent"
        ? "还没有阅读记录，打开一本书开始阅读。"
        : "这里还没有书籍。";
    $("#shelf").innerHTML =
      list.map((i, n) => this.card(i, n)).join("") +
      (all.length && this.filter.kind === "all" && !q
        ? `<button id="add-card" class="add-card">${this.icon("plus")}<span>打开另一本书</span><small>本地 EPUB 文件</small></button>`
        : "");
    this.covers.bind($("#shelf"));
    $("#add-card")?.addEventListener("click", () =>
      document.querySelector<HTMLElement>("#open")!.click(),
    );
  }
  card(i: ShelfItem, n: number) {
    const progress = Math.round(
      ((i.progress.chapter + i.progress.fraction) / Math.max(1, i.chapters)) *
        100,
    );
    const time = i.opened
      ? new Intl.DateTimeFormat("zh-CN", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(i.opened < 1e12 ? i.opened * 1000 : i.opened)
      : "尚未阅读";
    return `<article class="book-tile" data-book-key="${esc(i.key)}"><button class="book-card" data-action="read" data-key="${esc(i.key)}" aria-label="继续阅读 ${esc(i.title)}"><div class="book-cover cover-${n % 4}"><div class="cover-frame"><span class="cover-label">THE READING COLLECTION</span><h3>${esc(i.title)}</h3><span class="cover-author">${esc(i.author || "佚名")}</span>${this.icon("leaf")}<span class="cover-footer">${i.partId ? "COLLECTION" : "LEAF"} / ${String(n + 1).padStart(2, "0")}</span></div><img class="embedded-cover" data-cover-id="${esc(i.sourceId)}" alt="" decoding="async" aria-hidden="true"><span class="cover-spine"></span><div class="book-badges">${i.metadata.pinned ? '<span class="book-badge pin-badge">置顶</span>' : ""}${i.metadata.favorite ? '<span class="book-badge favorite-badge" aria-label="已收藏">★ 收藏</span>' : ""}</div></div><div class="book-info"><h3 title="${esc(i.title)}">${esc(i.title)}</h3><p>${esc(i.author || "作者未知")}</p><div class="book-progress"><span>${progress}% 已读</span>${this.icon("arrow")}</div></div></button>${i.sourceTitle ? `<button class="source-link" data-action="collection" data-key="${esc(i.key)}" title="${esc(i.sourceTitle)}">合集 · ${esc(i.sourceTitle)}</button>` : ""}<span class="book-status status-${i.metadata.reading_status}">${statusTitle(i.metadata.reading_status)}</span><div class="book-tags">${i.metadata.tags.map((t) => `<span title="${esc(t)}">${esc(t)}</span>`).join("")}</div><div class="book-actions"><span class="read-time">${esc(time)}</span><wa-button class="icon-button favorite-button ${i.metadata.favorite ? "is-favorite" : ""}" size="s" data-action="favorite" data-key="${esc(i.key)}" aria-label="${i.metadata.favorite ? "取消收藏" : "收藏"} ${esc(i.title)}" title="${i.metadata.favorite ? "取消收藏" : "收藏"}">${i.metadata.favorite ? "★" : "☆"}</wa-button><wa-button class="icon-button pin-button" size="s" data-action="pin" data-key="${esc(i.key)}" aria-label="${i.metadata.pinned ? "取消置顶" : "置顶"} ${esc(i.title)}" title="${i.metadata.pinned ? "取消置顶" : "置顶"}">${i.metadata.pinned ? "↓" : "↑"}</wa-button><wa-button class="icon-button" size="s" data-action="info" data-key="${esc(i.key)}" aria-label="图书信息 ${esc(i.title)}" title="图书信息">ⓘ</wa-button><wa-button class="icon-button" size="s" data-action="metadata" data-key="${esc(i.key)}" aria-label="整理 ${esc(i.title)}" title="分组与标签">···</wa-button></div></article>`;
  }
  async pin(item: ShelfItem, button: WaButton) {
    button.disabled = true;
    try {
      await invoke("pin_book", {
        sourceId: item.sourceId,
        partId: item.partId,
        pinned: !item.metadata.pinned,
      });
      await this.refresh();
    } catch (e) {
      this.reportError(e);
      button.disabled = false;
    }
  }
  async favorite(item: ShelfItem, button: WaButton) {
    button.disabled = true;
    try {
      await invoke("edit_metadata", {
        sourceId: item.sourceId,
        partId: item.partId,
        ...item.metadata,
        favorite: !item.metadata.favorite,
      });
      await this.refresh();
    } catch (e) {
      this.reportError(e);
      button.disabled = false;
    }
  }
  async edit(item: ShelfItem) {
    try {
      await Promise.all([
        import("@awesome.me/webawesome/dist/components/select/select.js"),
        import("@awesome.me/webawesome/dist/components/option/option.js"),
      ]);
      $("#metadata-dialog").querySelector(".dialog-error")?.remove();
      $("#metadata-title").textContent = item.title;
      const select = $<WaSelect>("#metadata-group");
      select.innerHTML =
        '<wa-option value="">未分组</wa-option>' +
        this.data.groups
          .map((g) => `<wa-option value="${esc(g)}">${esc(g)}</wa-option>`)
          .join("");
      select.value = item.metadata.group;
      $<WaSelect>("#metadata-status").value =
        item.metadata.reading_status ?? "unread";
      $<HTMLInputElement>("#metadata-pinned").checked = item.metadata.pinned;
      $<HTMLInputElement>("#metadata-tags").value =
        item.metadata.tags.join("，");
      $<HTMLInputElement>("#metadata-favorite").checked =
        item.metadata.favorite;
      $("#metadata-save").onclick = () =>
        void (async () => {
          const b = $<WaButton>("#metadata-save");
          b.disabled = true;
          try {
            await invoke("edit_metadata", {
              sourceId: item.sourceId,
              partId: item.partId,
              group: String(select.value ?? ""),
              tags: $<HTMLInputElement>("#metadata-tags")
                .value.split(/[,，]/)
                .map((t) => t.trim())
                .filter(Boolean),
              favorite: $<HTMLInputElement>("#metadata-favorite").checked,
              flags: {
                pinned: $<HTMLInputElement>("#metadata-pinned").checked,
                ...(String($<WaSelect>("#metadata-status").value) !==
                item.metadata.reading_status
                  ? {
                      reading_status: String(
                        $<WaSelect>("#metadata-status").value,
                      ),
                    }
                  : {}),
              },
            });
            await this.refresh();
            $<HTMLDialogElement>("#metadata-dialog").close();
          } catch (e) {
            this.reportError(e);
          } finally {
            b.disabled = false;
          }
        })();
      $<HTMLDialogElement>("#metadata-dialog").showModal();
    } catch (e) {
      this.reportError(e);
    }
  }
  showGroups() {
    this.renderGroupEditor();
    $<HTMLDialogElement>("#groups-dialog").showModal();
    $("#group-name").focus();
  }
  renderGroupEditor() {
    $("#groups-dialog").querySelector(".dialog-error")?.remove();
    $("#group-editor").innerHTML =
      this.data.groups
        .map(
          (g, i) =>
            `<div class="group-edit-row"><input class="field-input" value="${esc(g)}" maxlength="64" aria-label="重命名分组 ${esc(g)}" data-group-input="${i}"><wa-button class="quiet-button" size="s" data-group-rename="${i}">重命名</wa-button><wa-button class="text-button" size="s" data-group-delete="${i}" aria-label="删除分组 ${esc(g)}">删除</wa-button></div>`,
        )
        .join("") || '<p class="field-hint">还没有分组。</p>';
    $("#group-editor")
      .querySelectorAll<HTMLElement>("[data-group-rename],[data-group-delete]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void (async () => {
              const index = Number(
                  b.dataset.groupRename ?? b.dataset.groupDelete,
                ),
                name = this.data.groups[index],
                action =
                  b.dataset.groupDelete !== undefined ? "delete" : "rename",
                newName = $<HTMLInputElement>(
                  `[data-group-input="${index}"]`,
                ).value;
              try {
                await invoke("manage_group", { action, name, newName });
                if (this.filter.kind === "group" && this.filter.value === name)
                  this.filter =
                    action === "delete"
                      ? { kind: "all" }
                      : { kind: "group", value: newName.trim() };
                await this.refresh();
                this.renderGroupEditor();
              } catch (e) {
                this.reportError(e);
              }
            })()),
      );
  }
  async createGroup() {
    const input = $<HTMLInputElement>("#group-name");
    if (!input.reportValidity()) return;
    try {
      await invoke("manage_group", {
        action: "create",
        name: input.value,
        newName: null,
      });
      input.value = "";
      await this.refresh();
      this.renderGroupEditor();
    } catch (e) {
      this.reportError(e);
    }
  }
}
export type { Filter };
