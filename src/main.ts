import { initFocus, showDialog } from "./focus";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import type WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import "./style.css";
import markdownCSS from "./markdown-rich.css?inline";
import transcriptCSS from "../src-tauri/reading-transcript.css?inline";
import {
  type Book,
  readingPercent,
  type Chapter,
  type Toc,
  escapeHTML,
} from "./types";
import { Shelf, type Filter } from "./shelf";
import { CollectionPicker } from "./collection-picker";
import { TocTree } from "./toc";
import { TocSidebar } from "./toc-sidebar";
import { initScanDirectories } from "./scan-directories";
import { ReadingClock } from "./reading-clock";
import { initBookInfo, showBookInfo } from "./book-info";
import { initLibrarySettings } from "./library-settings";
import type { PagedReader } from "./paged-reader";
import { ContinuousReader } from "./continuous-reader";
import { searchBook, type SearchTarget } from "./book-search";

initFocus();

type Settings = {
  size: number;
  line: number;
  width: number;
  theme: "paper" | "white" | "night";
  serif: boolean;
  continuousEpub: boolean;
};
const defaults: Settings = {
  size: 19,
  line: 1.9,
  width: 680,
  theme: "paper",
  serif: true,
  continuousEpub: false,
};
function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem("leaf.settings") || "{}");
    return {
      size: Math.min(30, Math.max(14, Number(s.size) || 19)),
      line: Math.min(2.4, Math.max(1.4, Number(s.line) || 1.9)),
      width: Math.min(900, Math.max(480, Number(s.width) || 680)),
      theme: ["paper", "white", "night"].includes(s.theme) ? s.theme : "paper",
      serif: s.serif !== false,
      continuousEpub: s.continuousEpub === true,
    };
  } catch {
    return { ...defaults };
  }
}
let settings = loadSettings();
let book: Book | null = null;
let paged: PagedReader | undefined;
let continuous: ContinuousReader | undefined;
let browserReading = false;
let browserRequestPending = false;
let chapter = 0;
let fraction = 0;
let progressOffsets: number[] = [];
let busy = false;
let loadingChapter = false;
let revision = 0;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let loadChannel = "";
let readerReady = false;
let handshake:
  | {
      resolve: () => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      fraction: number;
      fragment: string;
      search?: SearchTarget;
    }
  | undefined;
let snapshotNumber = 0;
const snapshots = new Map<
  number,
  {
    resolve: (value: number) => void;
    reject: (reason: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let saveChain: Promise<unknown> = Promise.resolve();
const icon = (name: string, cls = "") => {
  const paths: Record<string, string> = {
    leaf: '<path d="M5 18C1 8 12 2 21 3c1 10-4 18-14 15M4 21 16 8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    book: '<path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
    left: '<path d="m14 6-6 6 6 6"/>',
    right: '<path d="m10 6 6 6-6 6"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    sidebar: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/>',
    pin: '<path d="m15 4 5 5-3 1-3 4v3l-7-7h3l4-3 1-3ZM10.5 13.5 5 19"/>',
    folder: '<path d="M3 7V5h6l2 2h10v13H3Zm0 4h18"/>',
  };
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

$("#app").innerHTML = `
  <aside id="library-sidebar" class="sidebar" aria-label="书架侧栏">
    <a class="brand" href="#" aria-label="Leaf 书架">${icon("leaf")}<span>Leaf<span class="brand-dot">.</span></span></a>
    <div class="sidebar-caption">你的私人阅读空间</div>
    <nav><button id="library-nav" class="nav-item active">${icon("grid")}<span>我的书架</span><span id="book-count" class="count">0</span></button></nav>
    <div class="sidebar-bottom"><div class="local-badge"><span></span>本地存储 · 离线可用</div><p>给阅读，留一点空间。</p><span class="version">LEAF READER / 0.1</span></div>
  </aside>
  <main>
    <header class="topbar"><div class="topbar-start"><button type="button" id="library-sidebar-toggle" class="quiet-button" aria-label="书架侧栏" aria-expanded="true" aria-controls="library-sidebar" title="收起书架侧栏">${icon("sidebar")}</button><div id="breadcrumb">书架 <span>/</span> 全部书籍</div></div><div class="top-actions"><wa-button id="book-info" class="quiet-button" size="s" hidden>图书信息</wa-button><wa-button id="collection-mode" class="quiet-button" size="s" hidden>合集模式</wa-button><wa-button id="appearance" class="quiet-button" aria-expanded="false" aria-controls="settings-panel" title="阅读设置" size="small">Aa <span>阅读设置</span></wa-button><button type="button" id="toc-toggle" class="quiet-button" aria-label="本书目录" title="本书目录" aria-expanded="false" aria-controls="toc-panel" hidden>${icon("list")}<span>目录</span></button><span class="divider"></span><wa-button id="open" class="primary-button" size="small">${icon("plus")}打开书籍</wa-button><wa-button id="open-directory" class="quiet-button" size="small" title="打开 Markdown 目录">打开目录</wa-button><wa-button id="github-book" class="quiet-button" size="small">GitHub 书籍</wa-button></div></header>
    <section id="library-view" class="library-view">
      <div class="shelf-heading"><h2>我的书架 <span id="shelf-count">0 本</span></h2><span class="muted">最近阅读</span></div>
      <div id="shelf" class="shelf"></div>
      <div id="empty" class="empty-state"><div class="empty-art">${icon("book")}<span class="art-leaf">${icon("leaf")}</span></div><h2>下一段旅程，从这里开始</h2><p>打开一本书，把喜欢的文字放在手边。<br>也可以将文件拖到窗口中。</p><wa-button id="empty-open" class="primary-button" size="small">${icon("folder")}选择本地书籍</wa-button><wa-button id="demo" class="text-button" size="small">先读一段示例 ${icon("arrow")}</wa-button><div class="empty-foot">无需账号 · 无需联网 · 只专注阅读</div></div>
      <footer class="library-footer"><span>${icon("leaf")}一本书，一段属于自己的时间。</span><span>EPUB · MOBI · AZW3 · PDF · CBZ · HTML · Markdown · TXT</span></footer>
    </section>
    <div id="reader-workspace" hidden>
    <section id="reader-view" class="reader-view">
      <div class="reader-caption"><span id="chapter-caption"></span><div class="reader-caption-actions"><button type="button" id="continuous-mode" class="quiet-button" aria-pressed="false" hidden>连续滚动</button><button type="button" id="book-search" class="quiet-button" aria-keyshortcuts="Meta+F Control+F" hidden>书内查找</button><button type="button" id="poetry" class="quiet-button" aria-pressed="false" hidden>诗歌排版</button><button type="button" id="html-source" class="quiet-button" hidden>HTML 原文</button><button type="button" id="export-text" class="quiet-button" hidden>导出 HTML</button><wa-button id="browser-reading" class="quiet-button" size="s" hidden>浏览器共读</wa-button><wa-button id="back" class="text-button" size="small">返回书架</wa-button></div></div>
      <div id="chapter-loading" class="chapter-loading" role="status" hidden></div>
      <div id="pdf-tools" hidden>
        <form id="pdf-jump">
          <label for="pdf-page">页码</label>
          <input id="pdf-page" name="page" class="field-input" type="number" min="1" required>
          <span id="pdf-total"></span>
          <button id="pdf-go" type="submit" class="quiet-button">跳转</button>
        </form>
        <div class="pdf-zoom" role="group" aria-label="页面缩放">
          <button id="pdf-zoom-out" class="quiet-button" aria-label="缩小" type="button">−</button>
          <output id="pdf-scale" aria-label="缩放比例"></output>
          <button id="pdf-zoom-in" class="quiet-button" aria-label="放大" type="button">＋</button>
          <button id="pdf-fit" class="quiet-button" aria-pressed="true" type="button">适合页面</button>
        </div>
      </div>
      <iframe id="reader" title="书籍正文" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
      <div id="continuous-reader" role="region" aria-label="连续滚动正文" tabindex="0" hidden></div>
      <div id="pdf-viewport" role="region" aria-label="分页正文" tabindex="0" hidden></div>
      <footer class="reader-footer"><wa-button id="prev" class="quiet-button" size="small">${icon("left")}<span id="prev-label">上一章</span></wa-button><div><span id="position"></span><progress id="reading-progress" class="progress-track" max="100" value="0" aria-label="阅读进度"></progress></div><wa-button id="next" class="quiet-button" size="small"><span id="next-label">下一章</span>${icon("right")}</wa-button></footer>
    </section>
    <aside id="toc-panel" aria-labelledby="toc-title" hidden>
      <div id="toc-resize" role="separator" tabindex="0" aria-labelledby="toc-title" aria-orientation="vertical" aria-controls="toc-panel" title="拖动调整目录宽度"></div>
      <header class="toc-header"><div class="toc-heading"><h2 id="toc-title">本书目录</h2><span id="toc-count"></span></div><div class="toc-actions">
        <button type="button" id="toc-pin" class="icon-button" aria-label="固定目录" aria-pressed="true">${icon("pin")}</button>
        <button type="button" id="toc-close" class="icon-button" aria-label="收起目录" title="收起目录">${icon("close")}</button>
      </div></header>
      <nav id="toc" class="toc" aria-label="目录条目"></nav>
    </aside>
    </div>
    <section id="settings-panel" class="settings-panel" aria-label="阅读设置" hidden><div class="settings-title"><h2>阅读设置</h2><wa-button id="settings-close" class="icon-button" aria-label="关闭设置" size="small">${icon("close")}</wa-button></div><label>字体大小 <output id="size-value"></output><wa-slider id="font-size" aria-label="字体大小" min="14" max="30" step="1"></wa-slider></label><label>行间距 <output id="line-value"></output><wa-slider id="line-height" aria-label="行间距" min="1.4" max="2.4" step="0.1"></wa-slider></label><label>阅读宽度 <output id="width-value"></output><wa-slider id="reading-width" aria-label="阅读宽度" min="480" max="900" step="20"></wa-slider></label><label class="select-label">正文字体<wa-select id="font-family" aria-label="正文字体" size="small"><wa-option value="serif">宋体 / 衬线字体</wa-option><wa-option value="sans">黑体 / 无衬线字体</wa-option></wa-select></label><div class="field-label">阅读背景</div><div class="themes"><button data-theme="paper" class="theme-swatch paper">暖纸</button><button data-theme="white" class="theme-swatch white">素白</button><button data-theme="night" class="theme-swatch night">夜读</button></div><p class="settings-note">设置自动保存，仅存于本机。</p></section>
  </main><div id="toast" role="status" hidden></div><div id="drop-overlay" hidden>${icon("book")}放下书籍，开始阅读</div>`;

document.body.insertAdjacentHTML(
  "beforeend",
  `<dialog id="collection-dialog" class="app-dialog collection-dialog"><div class="dialog-heading"><div><div class="eyebrow">合集模式</div><h2>选择要作为子书的目录</h2></div><wa-button id="collection-close" class="icon-button" aria-label="关闭合集设置" size="s">×</wa-button></div><p class="dialog-description">逻辑拆分，共用原 EPUB；每本子书单独记录进度。不会生成或改写 EPUB 文件。</p><p class="field-hint">默认只展示第一层，点击箭头逐级展开。勾选子书的起始分组；未链接的标题将使用其第一段正文作为起点。首个起点之前的内容保留在合集“附加内容”中，不计为子书。</p><div id="collection-candidates"></div><p id="collection-selection" class="field-hint"></p><p id="collection-error" role="alert" hidden></p><div class="dialog-actions"><wa-button id="collection-disable" class="quiet-button" size="s" hidden>恢复整本阅读</wa-button><wa-button id="collection-apply" class="primary-button" size="s">转为合集模式</wa-button></div></dialog>`,
);
document.body.insertAdjacentHTML("beforeend", `
  <dialog id="book-search-dialog" class="app-dialog advanced-dialog" aria-labelledby="book-search-title">
    <div class="dialog-heading"><h2 id="book-search-title">书内查找</h2><button type="button" id="book-search-close" class="icon-button" aria-label="关闭查找">${icon("close")}</button></div>
    <form id="book-search-form">
      <div class="book-search-field">
        <input id="book-search-term" class="field-input" type="search" aria-label="查找词" placeholder="输入要查找的文字" required maxlength="160" autofocus>
        <button type="submit" class="primary-button">查找</button>
      </div>
    </form>
    <p id="book-search-status" class="field-hint" role="status"></p>
    <ol id="book-search-results" aria-label="查找结果"></ol>
  </dialog>
  <dialog id="github-dialog" class="app-dialog advanced-dialog" aria-labelledby="github-title">
    <div class="dialog-heading"><h2 id="github-title">GitHub 书籍</h2></div>
    <form id="github-form">
      <label class="form-field">公开仓库地址<input id="github-url" class="field-input" type="url" required placeholder="https://github.com/owner/repo" spellcheck="false"></label>
      <p class="field-hint">将仓库中的 Markdown 加为一本书。已有书籍可在这里检查并更新。</p>
      <p id="github-status" role="status"></p>
      <div class="dialog-actions">
        <button class="quiet-button" type="button" id="github-cancel">取消</button>
        <button class="quiet-button" type="submit" value="update">检查并更新</button>
        <button class="primary-button" type="submit" value="open">打开书籍</button>
      </div>
    </form>
  </dialog>
  <dialog id="html-source-dialog" class="app-dialog advanced-dialog source-dialog" aria-labelledby="html-source-title">
    <div class="dialog-heading"><h2 id="html-source-title">HTML 原文</h2></div>
    <pre id="html-source-text" tabindex="0"></pre>
    <form method="dialog" class="dialog-actions"><button class="quiet-button">关闭</button></form>
  </dialog>
`);
const librarySidebar = $("#library-sidebar");
const librarySidebarToggle = $<HTMLButtonElement>("#library-sidebar-toggle");
const librarySidebarPreference = "leaf.library-sidebar-collapsed";
function setLibrarySidebarCollapsed(collapsed: boolean) {
  $("#app").classList.toggle("library-sidebar-collapsed", collapsed);
  librarySidebar.hidden = collapsed;
  librarySidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  librarySidebarToggle.title = collapsed ? "展开书架侧栏" : "收起书架侧栏";
}
try {
  setLibrarySidebarCollapsed(localStorage.getItem(librarySidebarPreference) === "true");
} catch {
  // Keep the sidebar expanded if preferences are unavailable.
}
librarySidebarToggle.onclick = () => {
  const collapsed = !librarySidebar.hidden;
  setLibrarySidebarCollapsed(collapsed);
  try {
    localStorage.setItem(librarySidebarPreference, String(collapsed));
  } catch {
    // The sidebar can still be toggled in this window.
  }
};
const shelf = new Shelf(
  (path, partId) => void openPath(path, false, partId, true),
  (filter) => void libraryView(filter),
  showError,
  icon,
);
const readingClock = new ReadingClock();
setInterval(() => readingClock.sample(), 1000);
setInterval(() => {
  void readingClock.flush().catch(showError);
}, 15000);
for (const event of ["focus", "blur"])
  window.addEventListener(event, () => {
    readingClock.sample();
    void readingClock.flush().catch(showError);
  });
document.addEventListener("visibilitychange", () => {
  readingClock.sample();
  void readingClock.flush().catch(showError);
});
window.addEventListener("leaf-preferences", (event) => {
  const enabled = (event as CustomEvent).detail.track_reading_time;
  if (book) book.track_reading_time = enabled;
  readingClock.preference(enabled);
});
initLibrarySettings(showError, () => flushProgress());
initScanDirectories(showError, () => refreshShelf(true));
initBookInfo(
  () => readingClock.flush(),
  async (info, sourceId, partId) => {
    await refreshShelf();
    if (book && book.id === sourceId && book.part_id === partId) {
      book.title = info.title;
      book.author = info.author;
      book.source_title = info.source_title || info.title;
      book.metadata = info.metadata;
      const part = book.collection.parts.find((p) => p.id === partId);
      if (part) part.title = info.title;
      $("#breadcrumb").textContent = partId
        ? `${book.source_title} / ${book.title}`
        : `阅读 / ${book.title}`;
      document.title = `${book.title} · Leaf`;
      tocTree.render(book, navigateFromToc, openPartFromToc);
      tocTree.active(chapter);
    }
  },
);
$("#book-info").onclick = () => {
  if (book) void showBookInfo(book.id, book.part_id);
};
const tocTree = new TocTree($("#toc"), $("#toc-count"));
const tocSidebar = new TocSidebar(
  $("#toc-panel"),
  $("#toc-toggle"),
  $("#toc-pin"),
  $("#toc-close"),
  $("#toc-resize"),
);
function setReadingView(reading: boolean) {
  $("#reader-workspace").hidden = !reading;
  $("#library-view").hidden = reading;
  document.body.classList.toggle("reading", reading);
  tocSidebar.setReading(reading && book?.comic_pages === undefined);
}
function navigateFromToc(c: number, f = 0, anchor = "") {
  tocSidebar.dismissTemporary(true);
  void navigate(c, f, anchor);
}
function openPartFromToc(id: string) {
  tocSidebar.dismissTemporary(true);
  void openPath(book!.path, false, id);
}
$("#collection-close").onclick = () =>
  $<HTMLDialogElement>("#collection-dialog").close();
$("#collection-mode").onclick = () => void collectionDialog();
$("#collection-disable").onclick = () => void configureCollection(false);
$("#collection-apply").onclick = () => void configureCollection(true);
let collectionChoices: CollectionPicker | undefined;
async function collectionDialog() {
  try {
    if (!book) {
      const source = shelf.data.books.find((r) => r.id === shelf.filter.value);
      if (!source) return;
      await openPath(source.path);
    }
    if (!book) return;
    const chosen = new Set(
      book.collection.parts.length
        ? book.collection.parts.map((p) => p.id)
        : book.candidates.filter((c) => c.suggested).map((c) => c.id),
    );
    collectionChoices = new CollectionPicker(
      $("#collection-candidates"),
      book.candidates,
      chosen,
      (count) => {
        $("#collection-selection").textContent = `已选择 ${count} 本子书`;
        $<WaButton>("#collection-apply").disabled = count < 2;
      },
    );
    $("#collection-disable").hidden = !book.collection.enabled;
    $("#collection-apply").textContent = book.collection.enabled
      ? "更新子书划分"
      : "转为合集模式";
    $("#collection-error").hidden = true;
    showDialog($<HTMLDialogElement>("#collection-dialog"));
  } catch (e) {
    showError(e);
  }
}
async function configureCollection(enabled: boolean) {
  if (!book || busy || loadingChapter) return;
  const ids = collectionChoices?.selectedIds() ?? [];
  setBusy(true);
  $<WaButton>("#collection-apply").disabled = true;
  $<WaButton>("#collection-disable").disabled = true;
  try {
    readingClock.pause();
    await flushProgress();
    const opened = await invoke<Book>("set_collection", {
      token: book.token,
      enabled,
      nodeIds: ids,
    });
    $<HTMLDialogElement>("#collection-dialog").close();
    await presentBook(opened);
  } catch (e) {
    $("#collection-error").textContent = String(e);
    $("#collection-error").hidden = false;
  } finally {
    setBusy(false);
    if (book && readerReady)
      readingClock.resume(book.token, book.track_reading_time ?? true);
    $<WaButton>("#collection-apply").disabled = false;
    $<WaButton>("#collection-disable").disabled = false;
  }
}
function showError(error: unknown) {
  const toast = $("#toast");
  toast.textContent = String(error);
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 6000);
}
function setBusy(value: boolean) {
  busy = value;
  for (const id of ["open", "empty-open", "demo"])
    $<WaButton>(`#${id}`).disabled = value;
  document.body.classList.toggle("busy", value);
  updateBrowserReading();
}
async function refreshShelf(invalidateCovers = false) {
  await shelf.refresh(invalidateCovers);
}
function frameWindow() {
  return $<HTMLIFrameElement>("#reader").contentWindow;
}
function sendReader(type: string, data: Record<string, unknown> = {}) {
  frameWindow()?.postMessage({ channel: loadChannel, type, ...data }, "*");
}
function readPosition(): Promise<number> {
  const request = ++snapshotNumber;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      snapshots.delete(request);
      reject("无法读取当前阅读位置，请重试");
    }, 2000);
    snapshots.set(request, { resolve, reject, timer });
    sendReader("snapshot", { request });
  });
}
function clearReader() {
  continuous?.dispose();
  continuous = undefined;
  $("#continuous-reader").hidden = true;
  searchRequest?.abort();
  if (searchDialog.open) searchDialog.close();
  readingClock.pause();
  readerReady = false;
  if (handshake) {
    clearTimeout(handshake.timer);
    handshake.reject("章节已关闭");
    handshake = undefined;
  }
  for (const pending of snapshots.values()) {
    clearTimeout(pending.timer);
    pending.reject("书籍已关闭");
  }
  snapshots.clear();
  loadChannel = "";
}
function flushProgress() {
  clearTimeout(scrollTimer);
  if (!book || loadingChapter || !readerReady)
    return Promise.all([saveChain, readingClock.flush()]);
  const token = book.token;
  const streamPosition = continuous?.position();
  const index = streamPosition?.chapter ?? chapter;
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      await readingClock.flush();
      const value = streamPosition?.fraction ?? (paged ? 1 : await readPosition());
      await invoke("save_progress", { token, chapter: index, fraction: value });
    });
  return saveChain;
}
window.addEventListener("message", (e) => {
  if (
    e.source !== frameWindow() ||
    !e.data?.leaf ||
    e.data.channel !== loadChannel ||
    !book
  )
    return;
  const m = e.data;
  if (m.type === "ready" && handshake)
    sendReader("init", {
      fraction: handshake.fraction,
      fragment: handshake.fragment,
      search: handshake.search,
      finalSection: chapter === book.chapters.length - 1,
    });
  else if (m.type === "initialized" && handshake) {
    readerReady = true;
    readingClock.resume(book.token, book.track_reading_time ?? true);
    clearTimeout(handshake.timer);
    handshake.resolve();
    handshake = undefined;
  } else if (
    (m.type === "position" || m.type === "snapshot") &&
    Number.isFinite(m.fraction) &&
    m.fraction >= 0 &&
    m.fraction <= 1
  ) {
    fraction = m.fraction;
    updatePosition();
    if (m.type === "snapshot") {
      const pending = snapshots.get(m.request);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(fraction);
        snapshots.delete(m.request);
      }
    } else if (!loadingChapter) scheduleProgress();
  } else {
    handleReaderAction(chapter, m);
  }
});
function scheduleProgress() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => void flushProgress().catch(showError), 350);
}
function resourceBase(token: string, path: string) {
  return convertFileSrc("", "epub") + token + "/" + path.split("/").map(encodeURIComponent).join("/");
}
function handleReaderAction(index: number, m: { type: string; href?: string; direction?: number }) {
  if (!book) return;
  if (m.type === "navigate" && (m.direction === -1 || m.direction === 1))
    void navigate(chapter + m.direction);
  else if (m.type === "open") void pickBook();
  else if (m.type === "find") openBookSearch();
  else if (m.type === "escape") closeReaderOverlay();
  else if (m.type === "pointerdown") tocSidebar.dismissTemporary();
  else if (m.type === "link" && typeof m.href === "string") {
    try {
      const base = new URL(resourceBase(book.token, book.chapters[index].path));
      const url = new URL(m.href, base);
      if (
        url.protocol !== base.protocol ||
        url.host !== base.host ||
        !decodeURIComponent(url.pathname).startsWith(`/${book.token}/`)
      )
        throw new Error();
      const path = decodeURIComponent(url.pathname)
        .split("/")
        .slice(2)
        .join("/");
      let target = path === book.chapters[index].path
        ? index : book.chapters.findIndex((c) => c.path === path);
      if (target < 0 && path.startsWith("sections/")) {
        const prefix = path.replace(/\/$/, "") + "/";
        target = book.chapters.findIndex((c) =>
          c.path.startsWith(prefix) && /^readme\.(md|markdown|mdown|mkd)$/i.test(c.path.slice(prefix.length)));
      }
      if (target < 0) throw new Error();
      void navigate(target, 0, decodeURIComponent(url.hash.slice(1)));
    } catch {
      showError("无法打开此书内链接；外部链接保持关闭。");
    }
  }
}
function updateBrowserReading() {
  const control = $<WaButton>("#browser-reading");
  control.hidden = !book || isPaged(book);
  control.disabled = browserRequestPending || (!browserReading && (!readerReady || busy || loadingChapter));
  control.textContent = browserReading ? "结束浏览器共读" : "浏览器共读";
}
$("#browser-reading").onclick = async () => {
  if (!book || isPaged(book) || browserRequestPending) return;
  const current = book;
  browserRequestPending = true;
  updateBrowserReading();
  try {
    if (browserReading) {
      await invoke("stop_browser_reading");
      browserReading = false;
    } else {
      await invoke("open_browser_reading", { token: current.token, index: chapter });
      if (book === current) browserReading = true;
    }
  } catch (e) {
    showError(e);
  } finally {
    browserRequestPending = false;
    updateBrowserReading();
  }
};

function updatePosition() {
  updateBrowserReading();
  if (!book) return;
  if (paged) {
    const progress = readingPercent((chapter + 1) / paged.pages);
    $("#position").textContent = `${chapter + 1} / ${paged.pages} 页 · ${progress}%`;
    $<HTMLProgressElement>("#reading-progress").value = progress;
    $<WaButton>("#prev").disabled = loadingChapter || chapter === 0;
    $<WaButton>("#next").disabled = loadingChapter || chapter === paged.pages - 1;
    $<HTMLInputElement>("#pdf-page").max = String(paged.pages);
    $("#pdf-total").textContent = `/ ${paged.pages}`;
    syncPageControls();
    tocTree.active(chapter);
    return;
  }
  const start = progressOffsets[chapter];
  const weight = progressOffsets[chapter + 1] - start;
  const progress = readingPercent(
    (start + fraction * weight) / progressOffsets.at(-1)!,
  );
  $("#position").textContent =
    `${chapter + 1} / ${book.chapters.length} 节 · ${progress}%`;
  $<HTMLProgressElement>("#reading-progress").value = progress;
  $<WaButton>("#prev").disabled = loadingChapter || chapter === 0;
  $<WaButton>("#next").disabled =
    loadingChapter || chapter >= book.chapters.length - 1;
  tocTree.active(chapter);
}
async function openPath(
  path?: string,
  demo = false,
  partId?: string,
  importFile = false,
) {
  if (busy || loadingChapter) return;
  setBusy(true);
  try {
    readingClock.pause();
    await flushProgress();
    const opened = await invoke<Book>(
      demo ? "open_demo" : "open_book",
      demo ? {} : { path, partId: partId ?? null, importFile },
    );
    await presentBook(opened);
  } catch (e) {
    showError(e);
  } finally {
    setBusy(false);
    if (book && readerReady)
      readingClock.resume(book.token, book.track_reading_time ?? true);
  }
}
const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd)$/i.test(path);
const isHtml = (path: string) => /\.html?$/i.test(path);
let exportSnapshot: { token: string; body: HTMLElement; base: string } | undefined;
let headingOutline: Toc[] = [];
let baseToc: Toc[] = [];

function refreshTextToc() {
  if (!book) return;
  if (isHtml(book.path) && headingOutline.length) {
    book.toc = headingOutline;
  } else if (book.metadata?.poetry && headingOutline.length) {
    book.toc = baseToc.map((entry) => entry.chapter === chapter
      ? { ...entry, children: [...entry.children, ...headingOutline] }
      : entry);
  } else {
    book.toc = baseToc;
  }
  tocTree.render(book, navigateFromToc, openPartFromToc);
  tocTree.active(chapter, true);
}
const isPaged = (opened: Book) => opened.pdf_size !== undefined || opened.comic_pages !== undefined;

function updatePoetry() {
  const button = $<HTMLButtonElement>("#poetry");
  button.hidden = !book || isPaged(book);
  button.setAttribute("aria-pressed", String(book?.metadata?.poetry ?? false));
}

async function presentBook(opened: Book) {
  clearReader();
  await closePaged();
  book = opened;
  baseToc = opened.toc;
  headingOutline = [];
  exportSnapshot = undefined;
  $("#export-text").hidden = true;
  $("#html-source").hidden = !isHtml(opened.path);
  browserReading = false;
  updateBrowserReading();
  updatePoetry();
  $("#book-info").hidden = false;
  chapter = opened.progress.chapter;
  fraction = opened.progress.fraction;
  // New fields have defaults here so older UI fixtures and saved sessions degrade gracefully.
  book.collection ??= { enabled: false, parts: [] };
  book.candidates ??= [];
  book.part_id ??= null;
  book.source_title ??= book.title;
  $("#collection-mode").hidden = !/\.epub$/i.test(opened.path);
  $("#collection-mode").textContent = book.collection.enabled
    ? "合集设置"
    : "合集模式";
  $("#back").textContent = book.part_id ? "返回合集" : "返回书架";
  await refreshShelf();
  if (book.collection.enabled && !book.part_id) {
    $<HTMLIFrameElement>("#reader").srcdoc = "";
    setReadingView(false);
    shelf.select({ kind: "collection", value: book.id });
    $("#breadcrumb").textContent = `合集 / ${book.title}`;
    document.title = `${book.title} · Leaf`;
    return;
  }
  const isPagedBook = isPaged(opened);
  const isEpub = /\.epub$/i.test(opened.path);
  $("#book-search").hidden = !isEpub;
  $("#continuous-mode").hidden = !isEpub;
  $("#reader").hidden = isPagedBook;
  $("#pdf-viewport").hidden = !isPagedBook;
  $("#pdf-tools").hidden = true;
  $("#prev-label").textContent = isPagedBook ? "上一页" : "上一章";
  $("#next-label").textContent = isPagedBook ? "下一页" : "下一章";
  $("#chapter-loading").textContent = isPagedBook ? "正在打开页面…" : "正在打开章节…";
  progressOffsets = [0];
  for (let i = 0; i < book.chapters.length; i++) {
    progressOffsets.push(progressOffsets[i] + (book.progress_weights?.[i] ?? 1));
  }
  setReadingView(true);
  $("#library-nav").classList.remove("active");
  $("#breadcrumb").textContent = book.part_id
    ? `${book.source_title} / ${book.title}`
    : `阅读 / ${book.title}`;
  document.title = `${book.title} · Leaf`;
  if (isPagedBook) {
    try {
      await presentPaged(opened);
    } catch (error) {
      await returnToShelf({ kind: "all" });
      throw error;
    }
    return;
  }
  tocTree.render(book, navigateFromToc, openPartFromToc);
  await renderFlow(chapter, fraction);
}
async function pickBook(directory = false) {
  if (busy) return;
  try {
    const path = await open({
      multiple: false,
      directory,
      ...(directory ? {} : { filters: [{ name: "电子书", extensions: ["epub", "mobi", "azw3", "pdf", "cbz", "htm", "html", "md", "markdown", "mdown", "mkd", "txt"] }] }),
    });
    if (typeof path === "string") await openPath(path, false, undefined, true);
  } catch (e) {
    showError(e);
  }
}
const poetryCSS = `
  body{max-width:38em!important;font-family:"Songti SC","Noto Serif CJK SC",Georgia,serif!important}
  p{white-space:pre-wrap!important;margin:1.5em 0!important}
  h1,h2,h3{text-align:center!important}
  h1+h2{margin-top:.75em!important}
  .leaf-poem-title:not(:first-child){margin-block-start:2.5em!important;text-align:center!important}
`;

function readerCSS() {
  const colors = {
    paper: ["#f6f5f0", "#373c35", "#687b5d"],
    white: ["#fff", "#303630", "#627c55"],
    night: ["#222723", "#cbd2c7", "#a6bc95"],
  }[settings.theme];
  const highlighter = settings.theme === "night"
    ? ".hljs-keyword,.hljs-title,.hljs-built_in{color:#d3aaff}.hljs-string,.hljs-regexp{color:#a7d29c}.hljs-number,.hljs-literal{color:#e4b387}.hljs-comment{color:#aeb7aa}"
    : "";
  return `:root{color-scheme:${settings.theme === "night" ? "dark" : "light"};background:${colors[0]}!important;color:${colors[1]}!important}html{scroll-behavior:auto!important}body{box-sizing:border-box!important;max-width:${settings.width}px!important;margin:0 auto!important;padding:32px 44px 100px!important;background:${colors[0]}!important;color:${colors[1]}!important;font-family:${settings.serif ? "'Songti SC','Noto Serif CJK SC',Georgia,serif" : "system-ui,sans-serif"}!important;font-size:${settings.size}px!important;line-height:${settings.line}!important;overflow-wrap:anywhere}p,li,blockquote{font-size:inherit!important;line-height:inherit!important}h1,h2,h3{color:inherit!important;line-height:1.5!important;font-weight:500!important}h1{font-size:1.8em!important;margin:.5em 0 1em!important}h2{font-size:1.3em!important;margin:2em 0 1em!important}p{margin:1.1em 0!important}img,svg,video{max-width:100%!important;height:auto!important}a{color:${colors[2]}!important}pre,table{max-width:100%;overflow:auto}*{animation:none!important;transition:none!important}body>*:first-child{margin-top:0}::highlight(leaf-search){background:#ffdb79;color:#292017}::selection{background:#b9c7a8;color:#1f3020}p.plain-text{white-space:pre-line}${transcriptCSS}${markdownCSS}${highlighter}${book?.metadata?.poetry ? poetryCSS : ""}`;
}
async function buildChapter(
  source: string, path: string, loadId: string, index: number, current: Book, streaming = false,
) {
  // Keep publisher styles, but never grant book markup scripts, forms, IPC or networking.
  // A template is inert even for images. DOMParser alone can fetch resources before sanitization.
  const template = document.createElement("template");
  template.innerHTML = source;
  template.content.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (
        ["src", "href", "xlink:href", "poster", "background"].includes(
          attr.name,
        )
      ) {
        const value = attr.value.trim().replace(/[\u0000-\u0020]/g, "");
        if (value.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(value))
          el.removeAttribute(attr.name);
      }
      if (["srcset", "ping"].includes(attr.name)) el.removeAttribute(attr.name);
    }
  });
  const clean = DOMPurify.sanitize(template.content, {
    RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ["link"],
    ADD_ATTR: ["href", "rel"],
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "base",
      "meta",
      "audio",
      "video",
    ],
    FORBID_ATTR: ["srcdoc", "autofocus"],
  });
  const doc = document.implementation.createHTMLDocument("");
  doc.documentElement.dataset.leafLoad = loadId;
  doc.body.append(clean);
  doc.body
    .querySelectorAll("style,link,title")
    .forEach((el) => doc.head.append(el));
  const markdownBook = isMarkdown(current.path) || (path.startsWith("sections/") && isMarkdown(path));
  if (!streaming) headingOutline = [];
  if (!/\.(epub|mobi|azw3)$/i.test(current.path)) {
    const nodes = [...doc.body.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")];
    const used = new Set([...doc.querySelectorAll("[id]")].map((el) => el.id));
    const htmlBook = isHtml(current.path);
    const headings: Toc[] = [];
    const parents: { level: number; item: Toc }[] = [];
    for (const node of nodes) {
      const title = node.textContent?.trim();
      if (!title) continue;
      if (!node.id) {
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/\s/g, "-") || "heading";
        let id = slug;
        for (let suffix = 1; used.has(id); suffix++) id = `${slug}-${suffix}`;
        node.id = id;
        used.add(id);
      }
      if (!htmlBook && !markdownBook) continue;
      if (markdownBook) node.classList.add("leaf-poem-title");
      const level = Number(node.tagName[1]);
      while (parents.length && parents.at(-1)!.level >= level) parents.pop();
      const item = { id: `heading-${index}-${node.id}`, title, chapter: index, fragment: node.id, children: [] };
      (parents.at(-1)?.item.children ?? headings).push(item);
      parents.push({ level, item });
    }
    headingOutline = headings;
    refreshTextToc();
  }
  if (markdownBook && doc.body.querySelector(".math-inline,.math-display,pre > code[class*='language-']")) {
    const { enhanceMarkdown } = await import("./markdown-rich");
    await enhanceMarkdown(doc.body);
  }
  const scope = current.chapters[index];
  if (scope?.start_fragment || scope?.end_fragment) {
    const start = scope.start_fragment
      ? doc.getElementById(scope.start_fragment)
      : null;
    const end = scope.end_fragment
      ? doc.getElementById(scope.end_fragment)
      : null;
    if (scope.start_fragment && !start)
      throw new Error("子书起点在正文中不存在，请重新划分");
    if (scope.end_fragment && !end)
      throw new Error("子书终点在正文中不存在，请重新划分");
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    if (start) range.setStartBefore(start);
    if (end) range.setEndBefore(end);
    const clipped = range.cloneContents();
    doc.body.replaceChildren(clipped);
  }
  // convertFileSrc encodes slashes as %2F. Use it for the platform origin only;
  // resource paths must keep separators for relative CSS/images/links to resolve.
  const base = doc.createElement("base");
  base.href = resourceBase(current.token, path);
  if (markdownBook || isHtml(current.path) || /\.txt$/i.test(current.path)) {
    exportSnapshot = { token: current.token, body: doc.body.cloneNode(true) as HTMLElement, base: base.href };
  }
  const bridgeUrl = new URL("reader-bridge.js", document.baseURI).href;
  // Opaque sandbox origin: the book has no parent DOM or IPC access. Only the
  // app-owned bridge script is allowed; publisher scripts are always removed.
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = `default-src 'none'; script-src ${bridgeUrl}; style-src 'unsafe-inline' epub: http://epub.localhost; img-src data: epub: http://epub.localhost; font-src data: epub: http://epub.localhost; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri epub: http://epub.localhost`;
  doc.head.prepend(base);
  doc.head.prepend(csp);
  doc.querySelectorAll("link").forEach((link) => {
    if (link.rel !== "stylesheet") link.remove();
  });
  const style = doc.createElement("style");
  style.id = "leaf-reader-style";
  style.textContent = readerCSS();

  doc.head.append(style);
  if (streaming) {
    const layout = doc.createElement("style");
    layout.textContent = "html{height:auto!important;overflow:hidden!important}body{height:auto!important;min-height:0!important;padding-block:24px!important;display:flow-root!important;overflow:visible!important}";
    doc.head.append(layout);
  }
  const bridge = doc.createElement("script");
  bridge.src = bridgeUrl;
  bridge.dataset.channel = loadId;
  bridge.dataset.stream = String(streaming);
  doc.body.append(bridge);
  doc.documentElement.lang ||= "zh-CN";
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
async function renderChapter(index: number, targetFraction = 0, fragment = "", search?: SearchTarget) {
  if (!book) return;
  const ticket = ++revision;
  exportSnapshot = undefined;
  $("#export-text").hidden = true;
  loadingChapter = true;
  $("#chapter-loading").hidden = false;
  updatePosition();
  try {
    const source = await invoke<string>("get_chapter", {
      token: book.token,
      index,
    });
    if (ticket !== revision || !book) return;
    const loadId = `${book.token}-${ticket}`;
    chapter = index;
    const srcdoc = await buildChapter(source, book.chapters[index].path, loadId, index, book);
    if (ticket !== revision || !book) return;
    clearReader();
    const iframe = $<HTMLIFrameElement>("#reader");
    loadChannel = loadId;
    chapter = index;
    fraction = targetFraction;
    $("#chapter-caption").textContent = book.chapters[index].title;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        handshake = undefined;
        reject("章节显示超时，请重试");
      }, 10000);
      handshake = {
        resolve,
        reject,
        timer,
        fraction: targetFraction,
        fragment,
        search,
      };
      iframe.srcdoc = srcdoc;
    });
    if (ticket !== revision) return;
    tocTree.active(chapter, true);
    $("#export-text").hidden = !exportSnapshot;
  } catch (e) {
    showError(e);
  } finally {
    if (ticket === revision) {
      loadingChapter = false;
      $("#chapter-loading").hidden = true;
      updatePosition();
    }
  }
}
function syncPageControls() {
  if (!paged) return;
  $("#pdf-scale").textContent = `${Math.round(paged.scale * 100)}%`;
  $("#pdf-fit").setAttribute("aria-pressed", String(paged.isFit));
  $<HTMLButtonElement>("#pdf-zoom-out").disabled = loadingChapter || paged.scale <= 0.25;
  $<HTMLButtonElement>("#pdf-zoom-in").disabled = loadingChapter || paged.scale >= 5;
  $<HTMLButtonElement>("#pdf-fit").disabled = loadingChapter;
  $<HTMLButtonElement>("#pdf-go").disabled = loadingChapter;
}

async function closePaged() {
  const current = paged;
  paged = undefined;
  if (current) await current.close();
}

async function presentPaged(opened: Book) {
  $<HTMLIFrameElement>("#reader").srcdoc = "";
  $("#chapter-caption").textContent = opened.title;
  $("#position").textContent = "";
  $<HTMLProgressElement>("#reading-progress").value = 0;
  $<WaButton>("#prev").disabled = $<WaButton>("#next").disabled = true;
  $("#chapter-loading").hidden = false;
  $("#toc-count").textContent = "";
  $("#toc").textContent = "正在读取目录…";
  try {
    const viewport = $("#pdf-viewport");
    viewport.setAttribute("aria-label", opened.comic_pages ? "漫画正文" : "PDF 正文");
    const reader = opened.comic_pages !== undefined
      ? (await import("./comic-reader")).openComic(opened.token, opened.comic_pages, viewport, syncPageControls)
      : await (await import("./pdf-reader")).openPdf(opened.token, opened.pdf_size!, viewport, syncPageControls);
    paged = reader;
    chapter = Math.min(Math.max(0, chapter), reader.pages - 1);
    await reader.render(chapter);
    if (!opened.comic_pages) await invoke("set_pdf_pages", { token: opened.token, pages: reader.pages });
    $("#pdf-tools").hidden = false;
    $<HTMLInputElement>("#pdf-page").value = String(chapter + 1);
    readerReady = true;
    updatePosition();
    await flushProgress();
    if (opened.comic_pages !== undefined) return;
    void reader.outline().then((outline) => {
      if (paged !== reader) return;
      opened.toc = outline;
      tocTree.render(opened, navigateFromToc, openPartFromToc);
      tocTree.active(chapter, true);
    }).catch(() => {
      if (paged === reader) $("#toc").textContent = "无法读取 PDF 目录，可用页码跳转。";
    });
  } finally {
    $("#chapter-loading").hidden = true;
  }
}

async function renderPage(index: number, zoom?: number | null) {
  if (!paged || loadingChapter) return;
  if (zoom !== undefined) paged.zoomTo(zoom);
  loadingChapter = true;
  updatePosition();
  try {
    if (await paged.render(index, zoom !== undefined)) {
      chapter = index;
      $<HTMLInputElement>("#pdf-page").value = String(index + 1);
      tocTree.active(chapter, true);
    }
  } finally {
    loadingChapter = false;
    updatePosition();
  }
  if (zoom === undefined) await flushProgress();
}

$("#pdf-jump").onsubmit = (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("#pdf-page");
  if (input.reportValidity()) void navigate(input.valueAsNumber - 1);
};
for (const [id, factor] of [["pdf-zoom-out", 1 / 1.25], ["pdf-zoom-in", 1.25]] as const) {
  $(`#${id}`).onclick = () => {
    if (paged) void renderPage(chapter, paged.scale * factor).catch(showError);
  };
}
$("#pdf-fit").onclick = () => void renderPage(chapter, null).catch(showError);
$("#pdf-viewport").onpointerdown = () => tocSidebar.dismissTemporary();

function useContinuousReader() {
  return settings.continuousEpub && !!book && /\.epub$/i.test(book.path);
}
async function renderFlow(index: number, value = 0, fragment = "", search?: SearchTarget) {
  const current = book;
  if (!current) return;
  const streaming = useContinuousReader();
  $("#continuous-mode").setAttribute("aria-pressed", String(streaming));
  $("#reader").hidden = streaming;
  $("#continuous-reader").hidden = !streaming;
  if (!streaming) {
    await renderChapter(index, value, fragment, search);
    return;
  }
  if (!continuous) {
    $<HTMLIFrameElement>("#reader").srcdoc = "";
    continuous = new ContinuousReader(
      $("#continuous-reader"),
      current.chapters.length,
      async (i, channel) => {
        const source = await invoke<string>("get_chapter", { token: current.token, index: i });
        return buildChapter(source, current.chapters[i].path, channel, i, current, true);
      },
      (i) => current.chapters[i].title,
      (position) => {
        if (position.chapter !== chapter)
          $("#chapter-caption").textContent = current.chapters[position.chapter].title;
        if (position.chapter !== chapter || position.fraction !== fraction) {
          chapter = position.chapter;
          fraction = position.fraction;
          updatePosition();
          if (readerReady && !loadingChapter) scheduleProgress();
        }
      },
      handleReaderAction,
      showError,
    );
  }
  chapter = index;
  fraction = value;
  $("#chapter-caption").textContent = current.chapters[index].title;
  loadingChapter = true;
  $("#chapter-loading").hidden = false;
  updatePosition();
  try {
    await continuous.open(index, value, fragment, search);
    if (book !== current) return;
    readerReady = true;
    readingClock.resume(current.token, current.track_reading_time ?? true);
    tocTree.active(chapter, true);
  } catch (error) {
    showError(error);
  } finally {
    loadingChapter = false;
    $("#chapter-loading").hidden = true;
    if (book === current) updatePosition();
  }
}

$<HTMLButtonElement>("#continuous-mode").onclick = async () => {
  const button = $<HTMLButtonElement>("#continuous-mode");
  if (!book || busy || loadingChapter || button.disabled) return;
  button.disabled = true;
  busy = true;
  try {
    await flushProgress();
    const position = continuous?.position() ?? { chapter, fraction };
    clearReader();
    settings.continuousEpub = !settings.continuousEpub;
    localStorage.setItem("leaf.settings", JSON.stringify(settings));
    await renderFlow(position.chapter, position.fraction);
    await flushProgress();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    button.disabled = false;
    updateBrowserReading();
  }
};

const searchDialog = $<HTMLDialogElement>("#book-search-dialog");
const searchTerm = $<HTMLInputElement>("#book-search-term");
const searchResults = $("#book-search-results");
const searchStatus = $("#book-search-status");
let searchRequest: AbortController | undefined;
let searchedBook: Book | null = null;
function openBookSearch() {
  if (!book || $("#book-search").hidden || $("#reader-workspace").hidden || document.querySelector("dialog[open]")) return;
  if (searchedBook !== book) {
    searchedBook = book;
    searchTerm.value = "";
    searchStatus.textContent = "";
    searchResults.replaceChildren();
  }
  searchDialog.showModal();
  searchTerm.select();
}
$("#book-search").onclick = openBookSearch;
$("#book-search-close").onclick = () => searchDialog.close();
searchDialog.onclose = () => {
  if (!searchDialog.open && searchRequest) {
    searchRequest.abort();
    searchRequest = undefined;
    searchStatus.textContent = "";
  }
};
$<HTMLFormElement>("#book-search-form").onsubmit = async (event) => {
  event.preventDefault();
  const current = book;
  const query = searchTerm.value.trim();
  if (!current || !query) return;
  searchRequest?.abort();
  const request = new AbortController();
  searchRequest = request;
  searchResults.replaceChildren();
  searchStatus.textContent = "正在查找…";
  try {
    const hits = await searchBook(current, query, request.signal);
    if (request.signal.aborted || current !== book) return;
    searchStatus.textContent = hits.length === 80 ? "显示前 80 条结果" : hits.length ? `${hits.length} 条结果` : "未找到匹配的正文";
    for (const { chapter: index, excerpt, target } of hits) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const title = document.createElement("strong");
      title.textContent = current.chapters[index].title;
      const snippet = document.createElement("span");
      snippet.textContent = excerpt;
      button.append(title, snippet);
      button.onclick = () => {
        searchDialog.close();
        void navigate(index, 0, "", target);
      };
      item.append(button);
      searchResults.append(item);
    }
  } catch {
    if (!request.signal.aborted) searchStatus.textContent = "无法查找正文，请重试";
  } finally {
    if (searchRequest === request) searchRequest = undefined;
  }
};

async function navigate(index: number, targetFraction = 0, fragment = "", search?: SearchTarget) {
  if (
    !book ||
    busy ||
    loadingChapter ||
    index < 0 ||
    index >= (paged?.pages ?? book.chapters.length)
  )
    return;
  try {
    if (paged) {
      await renderPage(index);
      return;
    }
    await flushProgress();
    await renderFlow(index, targetFraction, fragment, search);
    await flushProgress();
  } catch (e) {
    showError(e);
  }
}
async function libraryView(filter: Filter = { kind: "all" }) {
  if (busy || loadingChapter) return;
  try {
    readingClock.pause();
    await flushProgress();
    await returnToShelf(filter);
  } catch (e) {
    showError(e);
  }
}
async function returnToShelf(filter: Filter) {
  ++revision;
  clearReader();
  await closePaged();
  book = null;
  browserReading = false;
  updateBrowserReading();
  updatePoetry();
  $("#book-info").hidden = true;
  $<HTMLIFrameElement>("#reader").srcdoc = "";
  setReadingView(false);
  $("#breadcrumb").textContent = "书架 / 全部书籍";
  document.title = "Leaf · 本地阅读";
  await invoke("close_book");
  await refreshShelf();
  shelf.select(filter);
  $("#collection-mode").hidden = filter.kind !== "collection";
  $("#collection-mode").textContent = "合集设置";
}

let controlsReady: Promise<unknown> | undefined;
async function toggleSettings(show = $("#settings-panel").hidden) {
  if (show) {
    controlsReady ||= Promise.all([
      import("@awesome.me/webawesome/dist/components/slider/slider.js"),
      import("@awesome.me/webawesome/dist/components/select/select.js"),
      import("@awesome.me/webawesome/dist/components/option/option.js"),
    ]);
    await controlsReady;
    applySettings();
  }
  $("#settings-panel").hidden = !show;
  $("#appearance").setAttribute("aria-expanded", String(show));
  if (show) {
    await $<WaSlider>("#font-size").updateComplete;
    $("#font-size").focus();
  } else $("#appearance").focus();
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.classList.toggle(
    "wa-dark",
    settings.theme === "night",
  );
  if (customElements.get("wa-slider"))
    $<WaSlider>("#font-size").value = settings.size;
  $("#size-value").textContent = `${settings.size} px`;
  if (customElements.get("wa-slider"))
    $<WaSlider>("#line-height").value = settings.line;
  $("#line-value").textContent = `${settings.line.toFixed(1)}`;
  if (customElements.get("wa-slider"))
    $<WaSlider>("#reading-width").value = settings.width;
  $("#width-value").textContent = `${settings.width} px`;
  if (customElements.get("wa-select"))
    $<WaSelect>("#font-family").value = settings.serif ? "serif" : "sans";
  document.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((el) => {
    el.setAttribute(
      "aria-pressed",
      String(el.dataset.theme === settings.theme),
    );
  });
  if (continuous) continuous.style(readerCSS());
  else if (book) sendReader("style", { css: readerCSS() });
  localStorage.setItem("leaf.settings", JSON.stringify(settings));
}
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && book && !$("#book-search").hidden && !$("#reader-workspace").hidden) {
    e.preventDefault();
    openBookSearch();
    return;
  }
  const target = e.target as HTMLElement;
  if (
    target.matches(
      "input,select,textarea,button,summary,wa-button,wa-slider,wa-select",
    ) ||
    target.isContentEditable ||
    target.closest("#toc-panel")
  )
    return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void pickBook();
  }
  if (book && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      void navigate(chapter - 1);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      void navigate(chapter + 1);
    }
    if (e.key === " " || e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const direction = e.key === "PageUp" || e.shiftKey ? -1 : 1;
      if (paged) void navigate(chapter + direction);
      else if (continuous) continuous.scroll(direction * $("#continuous-reader").clientHeight * 0.85);
      else sendReader("scroll", { direction });
    }
  }
}
$("#open").onclick = $("#empty-open").onclick = () => void pickBook();
$("#open-directory").onclick = () => void pickBook(true);
$<HTMLButtonElement>("#poetry").onclick = () => {
  const current = book;
  if (!current || isPaged(current)) return;
  const button = $<HTMLButtonElement>("#poetry");
  if (button.disabled) return;
  button.disabled = true;
  const enabled = !current.metadata.poetry;
  void (async () => {
    try {
      await invoke("set_poetry", { token: current.token, enabled });
      if (book !== current) return;
      current.metadata.poetry = enabled;
      updatePoetry();
      refreshTextToc();
      if (continuous) continuous.style(readerCSS());
      else sendReader("style", { css: readerCSS() });
    } catch (e) {
      showError(e);
    } finally {
      button.disabled = false;
    }
  })();
};
const githubDialog = $<HTMLDialogElement>("#github-dialog");
let githubBusy = false;
$("#github-book").onclick = () => showDialog(githubDialog);
$("#github-cancel").onclick = () => githubDialog.close();
githubDialog.addEventListener("cancel", (event) => {
  if (githubBusy) event.preventDefault();
});
$<HTMLFormElement>("#github-form").onsubmit = async (event) => {
  event.preventDefault();
  if (githubBusy || busy) return;
  githubBusy = true;
  const controls = [...githubDialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button,input")];
  controls.forEach((control) => { control.disabled = true; });
  const status = $("#github-status");
  status.textContent = "正在读取 GitHub 仓库…";
  try {
    const { path, status: result } = await invoke<{ path: string; status: string }>("prepare_github_book", {
      url: $<HTMLInputElement>("#github-url").value,
      update: (event.submitter as HTMLButtonElement | null)?.value === "update",
    });
    githubDialog.close();
    await openPath(path);
    if (result === "updated" || result === "current") {
      showError(result === "updated" ? "GitHub 书籍已更新" : "已是最新版本");
    }
  } catch (error) {
    status.textContent = String(error);
  } finally {
    githubBusy = false;
    controls.forEach((control) => { control.disabled = false; });
  }
};
$("#html-source").onclick = async () => {
  const current = book;
  if (!current || !isHtml(current.path)) return;
  try {
    const source = await invoke<string>("get_html_source", { token: current.token });
    if (book !== current) return;
    $("#html-source-text").textContent = source;
    showDialog($<HTMLDialogElement>("#html-source-dialog"));
  } catch (error) {
    showError(error);
  }
};
$<HTMLDialogElement>("#html-source-dialog").addEventListener("close", () => {
  $("#html-source-text").textContent = "";
});
$("#export-text").onclick = async () => {
  const snapshot = exportSnapshot;
  const current = book;
  if (!snapshot || !current || snapshot.token !== current.token) return;
  const button = $<HTMLButtonElement>("#export-text");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const title = current.chapters[chapter]?.title || current.title;
    const name = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "Leaf";
    const path = await save({ defaultPath: `${name}.html`, filters: [{ name: "HTML", extensions: ["html"] }] });
    if (!path || book !== current) return;
    const { exportText } = await import("./text-export");
    await exportText(snapshot, title, path, readerCSS());
    showError("已导出当前章节");
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
};
$("#demo").onclick = () => void openPath(undefined, true);
$("#library-nav").onclick = () => void libraryView();
$("#back").onclick = () =>
  void libraryView(
    book?.part_id ? { kind: "collection", value: book.id } : { kind: "all" },
  );
$(".brand").onclick = (e) => {
  e.preventDefault();
  void libraryView();
};
$("#appearance").onclick = () => toggleSettings();
$("#settings-close").onclick = () => toggleSettings(false);
$("#prev").onclick = () => void navigate(chapter - 1);
$("#next").onclick = () => void navigate(chapter + 1);
for (const [id, key] of [
  ["font-size", "size"],
  ["line-height", "line"],
  ["reading-width", "width"],
] as const) {
  $<WaSlider>(`#${id}`).oninput = (e) => {
    settings[key] = Number((e.target as WaSlider).value);
    applySettings();
  };
}
$<WaSelect>("#font-family").onchange = (e) => {
  settings.serif = (e.target as WaSelect).value === "serif";
  applySettings();
};
document.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach(
  (el) =>
    (el.onclick = () => {
      settings.theme = el.dataset.theme as Settings["theme"];
      applySettings();
    }),
);
document.addEventListener("keydown", onKey);
function closeReaderOverlay() {
  if (!$("#settings-panel").hidden) {
    void toggleSettings(false);
    return true;
  }
  return tocSidebar.dismissTemporary(true);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented &&
      !document.querySelector("dialog[open]") && closeReaderOverlay())
    e.preventDefault();
});
document.addEventListener("click", (e) => {
  if (
    !$("#settings-panel").hidden &&
    !(e.target as Element).closest("#settings-panel, #appearance")
  ) {
    $("#settings-panel").hidden = true;
    $("#appearance").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());
applySettings();
void refreshShelf()
  .then(() => {
    if (isTauri())
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          void invoke("frontend_ready");
        }),
      );
  })
  .catch((e) =>
    showError(
      isTauri() ? e : "请通过 Leaf 桌面应用打开书籍；浏览器仅用于界面预览。",
    ),
  );
if (isTauri()) {
  const win = getCurrentWindow();
  void win.onDragDropEvent((e) => {
    $("#drop-overlay").hidden =
      e.payload.type !== "over" && e.payload.type !== "enter";
    if (e.payload.type === "drop") {
      const path = e.payload.paths.find((p) =>
        /\.(epub|mobi|azw3|pdf|cbz|html?|md|markdown|mdown|mkd|txt)$/i.test(p),
      ) ?? e.payload.paths[0];
      if (path) void openPath(path, false, undefined, true);
    }
  });
  let closing = false;
  void win.onCloseRequested(async (e) => {
    e.preventDefault();
    if (closing) return;
    closing = true;
    try {
      readingClock.pause();
      await flushProgress();
      await win.destroy();
    } catch (err) {
      closing = false;
      showError(err);
    }
  });
}
