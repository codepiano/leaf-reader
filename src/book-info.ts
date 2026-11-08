import { invoke } from "@tauri-apps/api/core";
import { escapeHTML as esc, type Metadata } from "./types";
type Info = {
  title: string;
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
export function initBookInfo() {
  document.body.insertAdjacentHTML(
    "beforeend",
    '<dialog id="book-info-dialog" class="app-dialog"><div class="dialog-heading"><div><div class="eyebrow">图书信息</div><h2 id="book-info-title"></h2></div><wa-button id="book-info-close" class="icon-button" size="s" aria-label="关闭图书信息">×</wa-button></div><div id="book-info-content"></div></dialog>',
  );
  $("#book-info-close").onclick = () =>
    ($("#book-info-dialog") as HTMLDialogElement).close();
}
export async function showBookInfo(
  sourceId: string,
  partId: string | null = null,
) {
  const dialog = $("#book-info-dialog") as HTMLDialogElement;
  $("#book-info-title").textContent = "图书信息";
  $("#book-info-content").textContent = "正在读取…";
  if (!dialog.open) dialog.showModal();
  try {
    const info = await invoke<Info>("book_info", { sourceId, partId });
    if (!dialog.open) return;
    $("#book-info-title").textContent = info.title;
    const field = (name: string, value: string) =>
      `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`;
    const size =
      info.size === null
        ? "无法获取"
        : `${info.size >= 1048576 ? (info.size / 1048576).toFixed(2) + " MiB" : (info.size / 1024).toFixed(2) + " KiB"}（${info.size.toLocaleString("zh-CN")} 字节）`;
    $("#book-info-content").innerHTML =
      `<dl class="book-details">${field("作者", info.author || "作者未知")}${info.source_title ? field("所属合集", info.source_title) : ""}${field("文件路径", info.path)}${field(info.source_title ? "共用 EPUB 大小" : "文件大小", size)}${field(info.source_title ? "子书章节数" : "章节数", String(info.chapters))}${info.source_title ? field("原书章节数", String(info.source_chapters)) : ""}${field("文件修改时间", info.modified === null ? "无法获取" : new Date(info.modified).toLocaleString("zh-CN", { hour12: false }))}${field("分组", info.metadata.group || "未分组")}${field("标签", info.metadata.tags.join("、") || "无")}${field("收藏", info.metadata.favorite ? "已收藏" : "未收藏")}</dl>${info.source_title ? '<p class="field-hint">子书为逻辑拆分，路径和文件大小属于共用的原 EPUB。章节数按阅读内容文件计算。</p>' : '<p class="field-hint">章节数按 EPUB 阅读内容文件计算，可能与目录标题数量不同。</p>'}${info.file_error ? `<p class="dialog-error" role="alert">${esc(info.file_error)}</p>` : ""}`;
  } catch (e) {
    $("#book-info-content").textContent = String(e);
  }
}
