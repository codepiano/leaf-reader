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

type Progress = { chapter: number; fraction: number };
type Chapter = { title: string; path: string };
type Toc = { title: string; chapter: number; fragment: string; depth: number };
type Book = {
  token: string;
  id: string;
  title: string;
  author: string;
  chapters: Chapter[];
  toc: Toc[];
  progress: Progress;
};
type Recent = {
  id: string;
  path: string;
  title: string;
  author: string;
  chapters: number;
  progress: Progress;
};
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
let busy = false;
let loadingChapter = false;
let revision = 0;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let recent: Recent[] = [];
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
    <section id="toc-panel" hidden><div class="section-label">本书目录 <span id="toc-count"></span></div><div id="toc" class="toc"></div></section>
    <div class="sidebar-bottom"><div class="local-badge"><span></span>本地存储 · 离线可用</div><p>给阅读，留一点空间。</p><span class="version">LEAF READER / 0.1</span></div>
  </aside>
  <main>
    <header class="topbar"><div id="breadcrumb">书架 <span>/</span> 全部书籍</div><div class="top-actions"><wa-button id="appearance" class="quiet-button" aria-expanded="false" aria-controls="settings-panel" title="阅读设置" size="small">Aa <span>阅读设置</span></wa-button><span class="divider"></span><wa-button id="open" class="primary-button" size="small">${icon("plus")}打开 EPUB</wa-button></div></header>
    <section id="library-view" class="library-view">
      <div class="library-heading"><div><div class="eyebrow">A LITTLE SPACE FOR READING</div><h1>把时间，留给好书<span>。</span></h1><p>从一页开始，走进另一个世界。</p></div><span class="heading-note">少一点喧嚣<br>多一点阅读</span></div>
      <div class="shelf-heading"><h2>我的书架 <span id="shelf-count">0 本</span></h2><span class="muted">最近阅读</span></div>
      <div id="shelf" class="shelf"></div>
      <div id="empty" class="empty-state"><div class="empty-art">${icon("book")}<span class="art-leaf">${icon("leaf")}</span></div><h2>下一段旅程，从这里开始</h2><p>打开一本 EPUB，把喜欢的文字放在手边。<br>也可以将文件拖到窗口中。</p><wa-button id="empty-open" class="primary-button" size="small">${icon("folder")}选择本地书籍</wa-button><wa-button id="demo" class="text-button" size="small">先读一段示例 ${icon("arrow")}</wa-button><div class="empty-foot">无需账号 · 无需联网 · 只专注阅读</div></div>
      <footer class="library-footer"><span>${icon("leaf")}一本书，一段属于自己的时间。</span><span>EPUB 2 / 3</span></footer>
    </section>
    <section id="reader-view" class="reader-view" hidden><div class="reader-caption"><span id="chapter-caption"></span><wa-button id="back" class="text-button" size="small">返回书架</wa-button></div><div id="chapter-loading" class="chapter-loading" hidden>正在打开章节…</div><iframe id="reader" title="书籍正文" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><footer class="reader-footer"><wa-button id="prev" class="quiet-button" size="small">${icon("left")}上一章</wa-button><div><span id="position"></span><div class="progress-track"><span id="progress-fill"></span></div></div><wa-button id="next" class="quiet-button" size="small">下一章${icon("right")}</wa-button></footer></section>
    <section id="settings-panel" class="settings-panel" aria-label="阅读设置" hidden><div class="settings-title"><h2>阅读设置</h2><wa-button id="settings-close" class="icon-button" aria-label="关闭设置" size="small">${icon("close")}</wa-button></div><label>字体大小 <output id="size-value"></output><wa-slider id="font-size" aria-label="字体大小" min="14" max="30" step="1"></wa-slider></label><label>行间距 <output id="line-value"></output><wa-slider id="line-height" aria-label="行间距" min="1.4" max="2.4" step="0.1"></wa-slider></label><label>阅读宽度 <output id="width-value"></output><wa-slider id="reading-width" aria-label="阅读宽度" min="480" max="900" step="20"></wa-slider></label><label class="select-label">正文字体<wa-select id="font-family" aria-label="正文字体" size="small"><wa-option value="serif">宋体 / 衬线字体</wa-option><wa-option value="sans">黑体 / 无衬线字体</wa-option></wa-select></label><div class="field-label">阅读背景</div><div class="themes"><button data-theme="paper" class="theme-swatch paper">暖纸</button><button data-theme="white" class="theme-swatch white">素白</button><button data-theme="night" class="theme-swatch night">夜读</button></div><p class="settings-note">设置自动保存，仅存于本机。</p></section>
  </main><div id="toast" role="status" hidden></div><div id="drop-overlay" hidden>${icon("book")}放下 EPUB，开始阅读</div>`;

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
function overall(p: Progress, count: number) {
  return Math.round(((p.chapter + p.fraction) / Math.max(1, count)) * 100);
}
async function refreshShelf() {
  recent = await invoke<Recent[]>("list_recent");
  $("#book-count").textContent = String(recent.length);
  $("#shelf-count").textContent = `${recent.length} 本`;
  $("#empty").hidden = recent.length > 0;
  $("#shelf").innerHTML =
    recent
      .map(
        (r, i) =>
          `<button class="book-card" data-id="${escape(r.id)}" aria-label="继续阅读 ${escape(r.title)}"><div class="book-cover cover-${i % 4}"><div class="cover-frame"><span class="cover-label">THE READING COLLECTION</span><h3>${escape(r.title)}</h3><span class="cover-author">${escape(r.author || "佚名")}</span>${icon("leaf")}<span class="cover-footer">LEAF / ${String(i + 1).padStart(2, "0")}</span></div><span class="cover-spine"></span></div><div class="book-info"><h3>${escape(r.title)}</h3><p>${escape(r.author || "作者未知")}</p><div class="book-progress"><span>${overall(r.progress, r.chapters)}% 已读</span>${icon("arrow")}</div></div></button>`,
      )
      .join("") +
    (recent.length
      ? `<button id="add-card" class="add-card">${icon("plus")}<span>打开另一本书</span><small>本地 EPUB 文件</small></button>`
      : "");
  $("#shelf")
    .querySelectorAll<HTMLButtonElement>("[data-id]")
    .forEach(
      (el) =>
        (el.onclick = () => {
          const item = recent.find((r) => r.id === el.dataset.id);
          if (item) void openPath(item.path);
        }),
    );
  $("#add-card")?.addEventListener("click", () => void pickBook());
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
  if (!book || loadingChapter || !readerReady) return saveChain;
  const token = book.token;
  const index = chapter;
  saveChain = saveChain
    .catch(() => {})
    .then(async () => {
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
    });
  else if (m.type === "initialized" && handshake) {
    readerReady = true;
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
  else if (m.type === "escape") void toggleSettings(false);
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
  $("#position").textContent =
    `${chapter + 1} / ${book.chapters.length} 章 · ${overall({ chapter, fraction }, book.chapters.length)}%`;
  $("#progress-fill").style.width =
    `${overall({ chapter, fraction }, book.chapters.length)}%`;
  $<WaButton>("#prev").disabled = loadingChapter || chapter === 0;
  $<WaButton>("#next").disabled =
    loadingChapter || chapter >= book.chapters.length - 1;
  $("#toc")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.chapter) === chapter);
      if (Number(el.dataset.chapter) === chapter)
        el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    });
}
async function openPath(path?: string, demo = false) {
  if (busy) return;
  setBusy(true);
  try {
    await flushProgress();
    const opened = await invoke<Book>(
      demo ? "open_demo" : "open_book",
      demo ? {} : { path },
    );
    clearReader();
    book = opened;
    chapter = opened.progress.chapter;
    fraction = opened.progress.fraction;
    $("#library-view").hidden = true;
    $("#reader-view").hidden = false;
    $("#toc-panel").hidden = false;
    $("#library-nav").classList.remove("active");
    $("#breadcrumb").innerHTML =
      `阅读 <span>/</span> <strong>${escape(book.title)}</strong>`;
    document.title = `${book.title} · Leaf`;
    $("#toc-count").textContent = `${book.chapters.length} 章`;
    $("#toc").innerHTML = book.toc
      .map(
        (t, i) =>
          `<button data-chapter="${t.chapter}" data-toc="${i}" style="--depth:${t.depth}" title="${escape(t.title)}"><span>${String(t.chapter + 1).padStart(2, "0")}</span><span>${escape(t.title)}</span></button>`,
      )
      .join("");
    $("#toc")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach(
        (el) =>
          (el.onclick = () => {
            const t = book!.toc[Number(el.dataset.toc)];
            void navigate(t.chapter, 0, t.fragment);
          }),
      );
    await renderChapter(chapter, fraction);
    await refreshShelf();
  } catch (e) {
    showError(e);
  } finally {
    setBusy(false);
  }
}
async function pickBook() {
  if (busy) return;
  try {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
    });
    if (typeof path === "string") await openPath(path);
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
async function libraryView() {
  if (busy || loadingChapter) return;
  try {
    await flushProgress();
    ++revision;
    clearReader();
    book = null;
    $<HTMLIFrameElement>("#reader").srcdoc = "";
    await invoke("close_book");
    $("#reader-view").hidden = true;
    $("#library-view").hidden = false;
    $("#toc-panel").hidden = true;
    $("#library-nav").classList.add("active");
    $("#breadcrumb").innerHTML = "书架 <span>/</span> 全部书籍";
    document.title = "Leaf · 本地阅读";
    await refreshShelf();
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
  const target = e.target as HTMLElement;
  if (
    target.matches(
      "input,select,textarea,button,wa-button,wa-slider,wa-select",
    ) ||
    target.isContentEditable
  )
    return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    void pickBook();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    toggleSettings(false);
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
$("#library-nav").onclick = $("#back").onclick = () => void libraryView();
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#settings-panel").hidden) toggleSettings(false);
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
      if (path) void openPath(path);
      else showError("请拖入 .epub 文件。");
    }
  });
  let closing = false;
  void win.onCloseRequested(async (e) => {
    e.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await flushProgress();
      await win.destroy();
    } catch (err) {
      closing = false;
      showError(err);
    }
  });
}
