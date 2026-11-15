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
  const textIndex = () => {
    // Use the same text boundaries as book-search.ts, retaining DOM offsets for the match.
    const excluded = "script,style,title,template,iframe,object,embed,form,button,textarea,select,audio,video,.math-inline,.math-display,[hidden], [aria-hidden=true]";
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
    return { text, nodes };
  };
  const makeRange = (index, start, end) => {
    const first = index.nodes.find((item) => item.end > start);
    const last = index.nodes.find((item) => item.end >= end);
    if (!first || !last || first.start > start || last.start >= end) return null;
    const range = new Range();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  };
  const anchorOffset = (text, anchor) => {
    const savedEnd = anchor.start + anchor.quote.length;
    if (text.slice(anchor.start, savedEnd) === anchor.quote &&
        text.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start) === anchor.prefix &&
        text.slice(savedEnd, savedEnd + anchor.suffix.length) === anchor.suffix)
      return anchor.start;
    let best = -1;
    let bestScore = -1;
    let ambiguous = false;
    let count = 0;
    let position = text.indexOf(anchor.quote);
    while (position >= 0) {
      count++;
      const end = position + anchor.quote.length;
      let score = 0;
      for (let i = 1; i <= anchor.prefix.length && text[position - i] === anchor.prefix.at(-i); i++) score++;
      for (let i = 0; i < anchor.suffix.length && text[end + i] === anchor.suffix[i]; i++) score++;
      if (score > bestScore) {
        best = position;
        bestScore = score;
        ambiguous = false;
      } else if (score === bestScore) ambiguous = true;
      position = text.indexOf(anchor.quote, position + 1);
    }
    if (count === 1) return best;
    if (!ambiguous && bestScore > 0) return best;
    return -1;
  };
  const locateSearch = (target) => {
    if (!target) return null;
    const index = textIndex();
    if (target.anchor) {
      const start = anchorOffset(index.text, target.anchor);
      if (start < 0) {
        send("mark-missing");
        return null;
      }
      return makeRange(index, start, start + target.anchor.quote.length);
    }
    const { text } = index;
    const pattern = target.query.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const matches = text.matchAll(new RegExp(pattern, "giu"));
    for (let index = 0; index < target.occurrence; index++) {
      if (matches.next().done) return null;
    }
    const { value: match } = matches.next();
    if (!match) return null;
    const range = makeRange(index, match.index, match.index + match[0].length);
    if (!range) return null;
    if (globalThis.Highlight && CSS.highlights)
      CSS.highlights.set("leaf-search", new Highlight(range));
    else {
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return range;
  };
  let decorations = [];
  const showMarks = (marks) => {
    if (marks.length || decorations.length) CSS.highlights?.delete("leaf-search");
    const parents = new Set();
    for (const mark of decorations) {
      if (!mark.parentNode) continue;
      parents.add(mark.parentNode);
      mark.replaceWith(...mark.childNodes);
    }
    parents.forEach((parent) => parent.normalize());
    decorations = [];
    if (!marks.length) return;
    const { text, nodes } = textIndex();
    const spans = marks.flatMap(({ anchor, style }) => {
      const start = anchorOffset(text, anchor);
      return start < 0 ? [] : [{ start, end: start + anchor.quote.length, style }];
    }).sort((a, b) => a.start - b.start);
    let first = 0;
    for (const { node, start, end } of nodes) {
      while (spans[first]?.end <= start) first++;
      const overlaps = [];
      for (let i = first; i < spans.length && spans[i].start < end; i++) {
        if (spans[i].end > start) overlaps.push(spans[i]);
      }
      if (!overlaps.length) continue;
      const boundaries = [...new Set([start, end, ...overlaps.flatMap((span) =>
        [Math.max(start, span.start), Math.min(end, span.end)])])].sort((a, b) => a - b);
      const content = document.createDocumentFragment();
      for (let i = 1; i < boundaries.length; i++) {
        const from = boundaries[i - 1], to = boundaries[i];
        const value = node.data.slice(from - start, to - start);
        const styles = overlaps.filter((span) => span.start <= from && span.end >= to).map((span) => span.style);
        if (!styles.length) content.append(value);
        else {
          const mark = document.createElement("mark");
          mark.classList.add("leaf-annotation");
          for (const style of styles) mark.classList.add("leaf-annotation-" + style);
          mark.textContent = value;
          decorations.push(mark);
          content.append(mark);
        }
      }
      node.replaceWith(content);
    }
  };
  const captureSelection = () => {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
      if (document.hasFocus()) send("selection", { anchor: null });
      return;
    }
    const range = selection.getRangeAt(0);
    const { text, nodes } = textIndex();
    if (!document.body.contains(range.commonAncestorContainer)) return;
    let start, end;
    for (const item of nodes) {
      if (!range.intersectsNode(item.node)) continue;
      const from = item.node === range.startContainer ? range.startOffset : 0;
      const to = item.node === range.endContainer ? range.endOffset : item.node.length;
      if (to <= from) continue;
      start ??= item.start + from;
      end = item.start + to;
    }
    const quote = start === undefined ? "" : text.slice(start, end);
    if (!quote.trim() || quote.length > 2000) {
      send("selection", { anchor: null });
      return;
    }
    const prefix = text.slice(Math.max(0, start - 64), start).replace(/^[\uDC00-\uDFFF]/, "");
    const suffix = text.slice(end, end + 64).replace(/[\uD800-\uDBFF]$/, "");
    send("selection", { anchor: {
      start, quote, prefix, suffix,
    }, fraction: fraction(), offset: range.getBoundingClientRect().top });
  };
  document.addEventListener("selectionchange", captureSelection);
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
      if (m.marks?.length) showMarks(m.marks);
      restore(m.fraction, m.fragment, m.search);
      send("initialized");
    } else if (m.type === "marks" && Array.isArray(m.marks)) {
      showMarks(m.marks);
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
      send("located", { offset: target?.getBoundingClientRect().top ?? (m.search?.anchor ? null : 0) });
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
