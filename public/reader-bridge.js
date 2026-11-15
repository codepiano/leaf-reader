// The only script allowed in the opaque-origin reading frame. No Tauri API or
// parent DOM access. Books cannot supply scripts or broaden this frame's CSP.
(() => {
  "use strict";
  const channel = document.currentScript.dataset.channel;
  const streaming = document.currentScript.dataset.stream === "true";
  const send = (type, data = {}) =>
    parent.postMessage({ leaf: true, channel, type, ...data }, "*");
  let restoring = false;
  let finalSection = false;
  let observer;
  let timer;
  let raf;
  const fraction = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    if (max <= 1) return finalSection ? 1 : 0;
    if (scrollY > 0 && max - scrollY <= 1) return 1;
    return Math.max(0, Math.min(1, scrollY / max));
  };
  const position = () => send("position", { fraction: fraction() });
  const stopRestore = () => {
    restoring = false;
    observer?.disconnect();
    clearTimeout(timer);
  };
  const locateSearch = (target) => {
    if (!target) return null;
    // Use the same text boundaries as book-search.ts, retaining DOM offsets for the match.
    const excluded = "script,style,title,template,iframe,object,embed,form,[hidden]";
    const separated = "article,aside,blockquote,br,dd,div,dt,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,p,pre,section,td,th";
    let text = "";
    const nodes = [];
    const collect = (node) => {
      if (node.nodeType === Node.TEXT_NODE && node.length) {
        nodes.push({ node, start: text.length, end: text.length + node.length });
        text += node.data;
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches(excluded)) {
        const block = node.matches(separated);
        if (block) text += "\n";
        node.childNodes.forEach(collect);
        if (block) text += "\n";
      }
    };
    collect(document.body);
    const pattern = target.query.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const matches = text.matchAll(new RegExp(pattern, "giu"));
    for (let index = 0; index < target.occurrence; index++) {
      if (matches.next().done) return null;
    }
    const { value: match } = matches.next();
    if (!match) return null;
    const end = match.index + match[0].length;
    const first = nodes.find((item) => item.end > match.index);
    const last = nodes.find((item) => item.end >= end);
    if (!first || !last) return null;
    const range = new Range();
    range.setStart(first.node, match.index - first.start);
    range.setEnd(last.node, end - last.start);
    if (globalThis.Highlight && CSS.highlights)
      CSS.highlights.set("leaf-search", new Highlight(range));
    else {
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return range;
  };
  const restore = (value, fragment = "", search) => {
    stopRestore();
    restoring = true;
    const range = locateSearch(search);
    const move = () => {
      if (range) scrollBy(0, range.getBoundingClientRect().top - 24);
      else if (fragment) document.getElementById(fragment)?.scrollIntoView();
      else
        scrollTo(
          0,
          Math.max(0, document.documentElement.scrollHeight - innerHeight) *
            value,
        );
      position();
    };
    move();
    observer = new ResizeObserver(move);
    observer.observe(document.body);
    timer = setTimeout(stopRestore, 1500);
  };
  addEventListener("message", (e) => {
    if (e.source !== parent || e.data?.channel !== channel) return;
    const m = e.data;
    if (m.type === "init") {
      finalSection = m.finalSection === true;
      restore(m.fraction, m.fragment, m.search);
      send("initialized");
    } else if (m.type === "snapshot") {
      send("snapshot", { request: m.request, fraction: fraction() });
    } else if (m.type === "style" && typeof m.css === "string") {
      const value = fraction();
      document.getElementById("leaf-reader-style").textContent = m.css;
      if (!streaming) requestAnimationFrame(() => restore(value));
    } else if (streaming && m.type === "locate") {
      CSS.highlights?.delete("leaf-search");
      const anchor = m.fragment ? document.getElementById(m.fragment) : null;
      const target = locateSearch(m.search) ?? anchor;
      send("located", { offset: target?.getBoundingClientRect().top ?? 0 });
    } else if (m.type === "scroll" && typeof m.direction === "number") {
      stopRestore();
      scrollBy(0, Math.sign(m.direction) * innerHeight * 0.85);
    }
  });
  addEventListener(
    "scroll",
    () => {
      if (restoring) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(position);
    },
    { passive: true },
  );
  if (streaming) {
    new ResizeObserver(() => {
      send("measure", { height: Math.max(document.body.offsetHeight, document.body.scrollHeight) });
    }).observe(document.body);
    addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      send("wheel", { delta: e.deltaY, mode: e.deltaMode });
    }, { passive: false });
  } else {
    addEventListener("wheel", stopRestore, { passive: true });
  }
  addEventListener("pointerdown", () => {
    stopRestore();
    send("pointerdown");
  });
  document.addEventListener("click", (e) => {
    const element = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    const link = element?.closest("a[href]");
    if (!link) return;
    e.preventDefault();
    send("link", { href: link.getAttribute("href") });
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      send("find");
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      send("open");
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      send("navigate", { direction: e.key === "ArrowLeft" ? -1 : 1 });
    } else if (e.key === "Escape") {
      send("escape");
    } else if (streaming && ["ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      send("wheel", { delta: e.key === "ArrowUp" ? -40 : 40, mode: 0 });
    } else if ([" ", "PageUp", "PageDown"].includes(e.key)) {
      e.preventDefault();
      stopRestore();
      const direction = e.key === "PageUp" || e.shiftKey ? -1 : 1;
      if (streaming) send("scroll-page", { direction });
      else scrollBy(0, direction * innerHeight * 0.85);
    }
  });
  send("ready");
})();
