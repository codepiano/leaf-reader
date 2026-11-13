import { initFocus, showDialog } from "./focus";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import type WaSlider from "@awesome.me/webawesome/dist/components/slider/slider.js";
import type WaSelect from "@awesome.me/webawesome/dist/components/select/select.js";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import "./style.css";
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

initFocus();

type Settings = {
  size: number;
  line: number;
  width: number;
  theme: "paper" | "white" | "night";
  serif: boolean;
};
const defaults: Settings = {
  size: 19,
  line: 1.9,
  width: 680,
  theme: "paper",
  serif: true,
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
    };
  } catch {
    return { ...defaults };
  }
}
let settings = loadSettings();
let book: Book | null = null;
let chapter = 0;
let fraction = 0;
let progressOffsets: number[] = [];
let busy = false;
let loadingChapter = false;
let revision = 0;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let loadChannel = "";
let readerReady = false;
let chapterBase = "";
let handshake:
  | {
      resolve: () => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      fraction: number;
      fragment: string;
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
  <aside class="sidebar">
    <a class="brand" href="#" aria-label="Leaf 书架">${icon("leaf")}<span>Leaf<span class="brand-dot">.</span></span></a>
    <div class="sidebar-caption">你的私人阅读空间</div>
    <nav><button id="library-nav" class="nav-item active">${icon("grid")}<span>我的书架</span><span id="book-count" class="count">0</span></button></nav>
    <div class="sidebar-bottom"><div class="local-badge"><span></span>本地存储 · 离线可用</div><p>给阅读，留一点空间。</p><span class="version">LEAF READER / 0.1</span></div>
  </aside>
  <main>
    <header class="topbar"><div id="breadcrumb">书架 <span>/</span> 全部书籍</div><div class="top-actions"><wa-button id="book-info" class="quiet-button" size="s" hidden>图书信息</wa-button><wa-button id="collection-mode" class="quiet-button" size="s" hidden>合集模式</wa-button><wa-button id="appearance" class="quiet-button" aria-expanded="false" aria-controls="settings-panel" title="阅读设置" size="small">Aa <span>阅读设置</span></wa-button><button type="button" id="toc-toggle" class="quiet-button" aria-label="本书目录" title="本书目录" aria-expanded="false" aria-controls="toc-panel" hidden>${icon("list")}<span>目录</span></button><span class="divider"></span><wa-button id="open" class="primary-button" size="small">${icon("plus")}打开 EPUB</wa-button></div></header>
    <section id="library-view" class="library-view">
      <div class="shelf-heading"><h2>我的书架 <span id="shelf-count">0 本</span></h2><span class="muted">最近阅读</span></div>
      <div id="shelf" class="shelf"></div>
      <div id="empty" class="empty-state"><div class="empty-art">${icon("book")}<span class="art-leaf">${icon("leaf")}</span></div><h2>下一段旅程，从这里开始</h2><p>打开一本 EPUB，把喜欢的文字放在手边。<br>也可以将文件拖到窗口中。</p><wa-button id="empty-open" class="primary-button" size="small">${icon("folder")}选择本地书籍</wa-button><wa-button id="demo" class="text-button" size="small">先读一段示例 ${icon("arrow")}</wa-button><div class="empty-foot">无需账号 · 无需联网 · 只专注阅读</div></div>
      <footer class="library-footer"><span>${icon("leaf")}一本书，一段属于自己的时间。</span><span>EPUB 2 / 3</span></footer>
    </section>
    <div id="reader-workspace" hidden>
    <section id="reader-view" class="reader-view"><div class="reader-caption"><span id="chapter-caption"></span><wa-button id="back" class="text-button" size="small">返回书架</wa-button></div><div id="chapter-loading" class="chapter-loading" hidden>正在打开章节…</div><iframe id="reader" title="书籍正文" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><footer class="reader-footer"><wa-button id="prev" class="quiet-button" size="small">${icon("left")}上一章</wa-button><div><span id="position"></span><progress id="reading-progress" class="progress-track" max="100" value="0" aria-label="阅读进度"></progress></div><wa-button id="next" class="quiet-button" size="small">下一章${icon("right")}</wa-button></footer></section>
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
  </main><div id="toast" role="status" hidden></div><div id="drop-overlay" hidden>${icon("book")}放下 EPUB，开始阅读</div>`;

document.body.insertAdjacentHTML(
  "beforeend",
  `<dialog id="collection-dialog" class="app-dialog collection-dialog"><div class="dialog-heading"><div><div class="eyebrow">合集模式</div><h2>选择要作为子书的目录</h2></div><wa-button id="collection-close" class="icon-button" aria-label="关闭合集设置" size="s">×</wa-button></div><p class="dialog-description">逻辑拆分，共用原 EPUB；每本子书单独记录进度。不会生成或改写 EPUB 文件。</p><p class="field-hint">默认只展示第一层，点击箭头逐级展开。勾选子书的起始分组；未链接的标题将使用其第一段正文作为起点。首个起点之前的内容保留在合集“附加内容”中，不计为子书。</p><div id="collection-candidates"></div><p id="collection-selection" class="field-hint"></p><p id="collection-error" role="alert" hidden></p><div class="dialog-actions"><wa-button id="collection-disable" class="quiet-button" size="s" hidden>恢复整本阅读</wa-button><wa-button id="collection-apply" class="primary-button" size="s">转为合集模式</wa-button></div></dialog>`,
);
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
  tocSidebar.setReading(reading);
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
  const index = chapter;
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
      await readingClock.flush();
      const value = await readPosition();
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
    } else if (!loadingChapter) {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        void flushProgress().catch(showError);
      }, 350);
    }
  } else if (m.type === "navigate" && (m.direction === -1 || m.direction === 1))
    void navigate(chapter + m.direction);
  else if (m.type === "open") void pickBook();
  else if (m.type === "escape") closeReaderOverlay();
  else if (m.type === "pointerdown") tocSidebar.dismissTemporary();
  else if (m.type === "link" && typeof m.href === "string") {
    try {
      const url = new URL(m.href, chapterBase);
      const base = new URL(chapterBase);
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
      const target = book.chapters.findIndex((c) => c.path === path);
      if (target < 0) throw new Error();
      void navigate(target, 0, decodeURIComponent(url.hash.slice(1)));
    } catch {
      showError("无法打开此书内链接；外部链接保持关闭。");
    }
  }
});
function updatePosition() {
  if (!book) return;
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
async function presentBook(opened: Book) {
  clearReader();
  book = opened;
  $("#book-info").hidden = false;
  chapter = opened.progress.chapter;
  fraction = opened.progress.fraction;
  // New fields have defaults here so older UI fixtures and saved sessions degrade gracefully.
  book.collection ??= { enabled: false, parts: [] };
  book.candidates ??= [];
  book.part_id ??= null;
  book.source_title ??= book.title;
  $("#collection-mode").hidden = false;
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
  tocTree.render(book, navigateFromToc, openPartFromToc);
  await renderChapter(chapter, fraction);
}
async function pickBook() {
  if (busy) return;
  try {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
    });
    if (typeof path === "string") await openPath(path, false, undefined, true);
  } catch (e) {
    showError(e);
  }
}
function readerCSS() {
  const colors = {
    paper: ["#f6f5f0", "#373c35", "#687b5d"],
    white: ["#fff", "#303630", "#627c55"],
    night: ["#222723", "#cbd2c7", "#a6bc95"],
  }[settings.theme];
  return `:root{color-scheme:${settings.theme === "night" ? "dark" : "light"};background:${colors[0]}!important;color:${colors[1]}!important}html{scroll-behavior:auto!important}body{box-sizing:border-box!important;max-width:${settings.width}px!important;margin:0 auto!important;padding:32px 44px 100px!important;background:${colors[0]}!important;color:${colors[1]}!important;font-family:${settings.serif ? "'Songti SC','Noto Serif CJK SC',Georgia,serif" : "system-ui,sans-serif"}!important;font-size:${settings.size}px!important;line-height:${settings.line}!important;overflow-wrap:anywhere}p,li,blockquote{font-size:inherit!important;line-height:inherit!important}h1,h2,h3{color:inherit!important;line-height:1.5!important;font-weight:500!important}h1{font-size:1.8em!important;margin:.5em 0 1em!important}h2{font-size:1.3em!important;margin:2em 0 1em!important}p{margin:1.1em 0!important}img,svg,video{max-width:100%!important;height:auto!important}a{color:${colors[2]}!important}pre,table{max-width:100%;overflow:auto}*{animation:none!important;transition:none!important}body>*:first-child{margin-top:0}::selection{background:#b9c7a8;color:#1f3020}`;
}
function buildChapter(source: string, path: string, loadId: string) {
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
  const scope = book!.chapters[chapter];
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
  base.href =
    convertFileSrc("", "epub") +
    `${book!.token}/${path.split("/").map(encodeURIComponent).join("/")}`;
  chapterBase = base.href;
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
  const bridge = doc.createElement("script");
  bridge.src = bridgeUrl;
  bridge.dataset.channel = loadId;
  doc.body.append(bridge);
  doc.documentElement.lang ||= "zh-CN";
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
async function renderChapter(index: number, targetFraction = 0, fragment = "") {
  if (!book) return;
  const ticket = ++revision;
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
    const srcdoc = buildChapter(source, book.chapters[index].path, loadId);
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
      };
      iframe.srcdoc = srcdoc;
    });
    if (ticket !== revision) return;
    tocTree.active(chapter, true);
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
async function navigate(index: number, targetFraction = 0, fragment = "") {
  if (
    !book ||
    busy ||
    loadingChapter ||
    index < 0 ||
    index >= book.chapters.length
  )
    return;
  try {
    await flushProgress();
    await renderChapter(index, targetFraction, fragment);
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
    ++revision;
    clearReader();
    book = null;
    $("#book-info").hidden = true;
    $<HTMLIFrameElement>("#reader").srcdoc = "";
    await invoke("close_book");
    setReadingView(false);
    $("#breadcrumb").textContent = "书架 / 全部书籍";
    document.title = "Leaf · 本地阅读";
    await refreshShelf();
    shelf.select(filter);
    $("#collection-mode").hidden = filter.kind !== "collection";
    $("#collection-mode").textContent = "合集设置";
  } catch (e) {
    showError(e);
  }
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
  if (book) sendReader("style", { css: readerCSS() });
  localStorage.setItem("leaf.settings", JSON.stringify(settings));
}
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
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
      sendReader("scroll", {
        direction: e.key === "PageUp" || e.shiftKey ? -1 : 1,
      });
    }
  }
}
$("#open").onclick = $("#empty-open").onclick = () => void pickBook();
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
        p.toLowerCase().endsWith(".epub"),
      );
      if (path) void openPath(path, false, undefined, true);
      else showError("请拖入 .epub 文件。");
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
