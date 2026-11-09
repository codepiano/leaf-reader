import { invoke } from "@tauri-apps/api/core";
import {
  escapeHTML as esc,
  type Metadata,
  type Details,
  emptyDetails,
} from "./types";
export type Info = {
  details: Details;
  original_details: Details;
  title: string;
  reading_ms: number;
  author: string;
  path: string;
  size: number | null;
  modified: number | null;
  chapters: number;
  source_chapters: number;
  source_title: string | null;
  metadata: Metadata;
  file_error: string | null;
};
const $ = (s: string) => document.querySelector<HTMLElement>(s)!;
let afterEdit: (
  info: Info,
  sourceId: string,
  partId: string | null,
) => Promise<unknown> = async () => {};
let current:
  { info: Info; sourceId: string; partId: string | null } | undefined;
let request = 0;
let flushTime: () => Promise<unknown> = async () => {};
export function initBookInfo(
  beforeShow: () => Promise<unknown>,
  afterSave: typeof afterEdit,
) {
  afterEdit = afterSave;
  flushTime = beforeShow;
  document.body.insertAdjacentHTML(
    "beforeend",
    '<dialog id="book-info-dialog" class="app-dialog"><div class="dialog-heading"><div><div class="eyebrow">图书信息</div><h2 id="book-info-title"></h2></div><wa-button id="book-info-close" class="icon-button" size="s" aria-label="关闭图书信息">×</wa-button></div><div id="book-info-content"></div><div class="dialog-actions"><wa-button id="book-info-edit" class="primary-button" size="s" disabled>编辑信息</wa-button></div></dialog>',
  );
  document.body.insertAdjacentHTML(
    "beforeend",
    `<dialog id="details-dialog" class="app-dialog"><form id="details-form"><div class="dialog-heading"><h2>编辑图书信息</h2><wa-button id="details-close" class="icon-button" size="s" aria-label="关闭信息编辑">×</wa-button></div><p class="field-hint">留空使用原书信息。仅保存在本机，不改写 EPUB；合集子书可单独补全。</p><label class="form-field">书名<input id="details-title" class="field-input" maxlength="256"></label><label class="form-field">作者<input id="details-author" class="field-input" maxlength="256"></label><div class="details-pair"><label class="form-field">出版社<input id="details-publisher" class="field-input" maxlength="256"></label><label class="form-field">出版日期<input id="details-published" class="field-input" maxlength="64" placeholder="例如：2026-11"></label><label class="form-field">ISBN<input id="details-isbn" class="field-input" maxlength="64"></label><label class="form-field">语言<input id="details-language" class="field-input" maxlength="64" placeholder="例如：zh-CN"></label></div><label class="form-field">简介<textarea id="details-description" class="field-input" rows="4" maxlength="10000"></textarea></label><p id="details-error" class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><wa-button id="details-reset" class="quiet-button" size="s">恢复原书信息</wa-button><wa-button id="details-cancel" class="quiet-button" size="s">取消</wa-button><wa-button id="details-save" class="primary-button" size="s">保存</wa-button></div></form></dialog>`,
  );
  $("#book-info-edit").onclick = () => {
    if (!current) return;
    const { info } = current;
    for (const key of Object.keys(emptyDetails()) as (keyof Details)[]) {
      const field = document.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(`#details-${key}`)!;
      field.value = info.metadata.details?.[key] ?? "";
      field.placeholder = info.original_details?.[key] || "原书未提供";
    }
    $("#details-error").hidden = true;
    ($("#book-info-dialog") as HTMLDialogElement).close();
    ($("#details-dialog") as HTMLDialogElement).showModal();
  };
  let saving = false;
  const closeEditor = (event: Event) => {
    event.preventDefault();
    if (saving) return;
    ($("#details-dialog") as HTMLDialogElement).close();
    if (current) void showBookInfo(current.sourceId, current.partId);
  };
  $("#details-close").onclick = closeEditor;
  $("#details-cancel").onclick = closeEditor;
  $("#details-dialog").addEventListener("cancel", closeEditor);
  $("#details-reset").onclick = (event) => {
    event.preventDefault();
    for (const key of Object.keys(emptyDetails()))
      (document.querySelector(`#details-${key}`) as HTMLInputElement).value =
        "";
  };
  const save = async (event: Event) => {
    event.preventDefault();
    if (!current || saving) return;
    const context = current;
    const data = emptyDetails();
    for (const key of Object.keys(data) as (keyof Details)[])
      data[key] = (
        document.querySelector(`#details-${key}`) as HTMLInputElement
      ).value.trim();
    saving = true;
    $("#details-error").hidden = true;
    for (const id of [
      "details-save",
      "details-reset",
      "details-cancel",
      "details-close",
    ])
      (
        document.querySelector(
          `#${id}`,
        ) as import("@awesome.me/webawesome/dist/components/button/button.js").default
      ).disabled = true;
    try {
      await invoke("edit_book_details", {
        sourceId: context.sourceId,
        partId: context.partId,
        details: data,
      });
      const info = await invoke<Info>("book_info", {
        sourceId: context.sourceId,
        partId: context.partId,
      });
      await afterEdit(info, context.sourceId, context.partId);
      ($("#details-dialog") as HTMLDialogElement).close();
      await showBookInfo(context.sourceId, context.partId);
    } catch (e) {
      $("#details-error").hidden = false;
      $("#details-error").textContent = String(e);
    } finally {
      saving = false;
      for (const id of [
        "details-save",
        "details-reset",
        "details-cancel",
        "details-close",
      ])
        (
          document.querySelector(
            `#${id}`,
          ) as import("@awesome.me/webawesome/dist/components/button/button.js").default
        ).disabled = false;
    }
  };
  $("#details-form").addEventListener("submit", (event) => void save(event));
  $("#details-save").onclick = (event) => void save(event);
  $("#book-info-close").onclick = () =>
    ($("#book-info-dialog") as HTMLDialogElement).close();
}
export async function showBookInfo(
  sourceId: string,
  partId: string | null = null,
) {
  const generation = ++request;
  const dialog = $("#book-info-dialog") as HTMLDialogElement;
  (
    document.querySelector(
      "#book-info-edit",
    ) as import("@awesome.me/webawesome/dist/components/button/button.js").default
  ).disabled = true;
  $("#book-info-title").textContent = "图书信息";
  $("#book-info-content").textContent = "正在读取…";
  if (!dialog.open) dialog.showModal();
  try {
    await flushTime();
    const info = await invoke<Info>("book_info", { sourceId, partId });
    if (!dialog.open || generation !== request) return;
    current = { info, sourceId, partId };
    (
      document.querySelector(
        "#book-info-edit",
      ) as import("@awesome.me/webawesome/dist/components/button/button.js").default
    ).disabled = false;
    $("#book-info-title").textContent = info.title;
    const field = (name: string, value: string) =>
      `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`;
    const size =
      info.size === null
        ? "无法获取"
        : `${info.size >= 1048576 ? (info.size / 1048576).toFixed(2) + " MiB" : (info.size / 1024).toFixed(2) + " KiB"}（${info.size.toLocaleString("zh-CN")} 字节）`;
    $("#book-info-content").innerHTML =
      `<dl class="book-details">${field("作者", info.author || "作者未知")}${info.source_title ? field("所属合集", info.source_title) : ""}${field("出版社", info.details?.publisher || "未提供")}${field("出版日期", info.details?.published || "未提供")}${field("ISBN", info.details?.isbn || "未提供")}${field("语言", info.details?.language || "未提供")}${field("文件路径", info.path)}${field(info.source_title ? "共用 EPUB 大小" : "文件大小", size)}${field(partId === "frontmatter" ? "附加内容章节数" : info.source_title ? "子书章节数" : "章节数", String(info.chapters))}${info.source_title ? field("原书章节数", String(info.source_chapters)) : ""}${field("文件修改时间", info.modified === null ? "无法获取" : new Date(info.modified).toLocaleString("zh-CN", { hour12: false }))}${field("累计阅读时长", formatDuration(info.reading_ms ?? 0))}${field("分组", info.metadata.group || "未分组")}${field("标签", info.metadata.tags.join("、") || "无")}${field("收藏", info.metadata.favorite ? "已收藏" : "未收藏")}${field("阅读分类", info.metadata.reading_status === "finished" ? "读过" : info.metadata.reading_status === "reading" ? "在读" : "未读")}${field("置顶", info.metadata.pinned ? "已置顶" : "未置顶")}</dl>${info.details?.description ? `<div class="book-description"><h3>简介</h3><p>${esc(info.details.description)}</p></div>` : ""}${partId === "frontmatter" ? '<p class="field-hint">这是合集的前置附加内容，路径和文件大小属于共用的原 EPUB，不计为一本子书。</p>' : info.source_title ? '<p class="field-hint">子书为逻辑拆分，路径和文件大小属于共用的原 EPUB。章节数按阅读内容文件计算。</p>' : '<p class="field-hint">章节数按 EPUB 阅读内容文件计算，可能与目录标题数量不同。</p>'}${info.file_error ? `<p class="dialog-error" role="alert">${esc(info.file_error)}</p>` : ""}`;
  } catch (e) {
    $("#book-info-content").textContent = String(e);
  }
}

function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000),
    minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60);
  return hours
    ? `${hours} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`
    : minutes
      ? `${minutes} 分 ${seconds % 60} 秒`
      : `${seconds} 秒`;
}
