// The only script allowed in the opaque-origin reading frame. No Tauri API or
// parent DOM access. Books cannot supply scripts or broaden this frame's CSP.
(() => {
  "use strict";
  const channel = document.currentScript.dataset.channel;
  const send = (type, data = {}) =>
    parent.postMessage({ leaf: true, channel, type, ...data }, "*");
  let restoring = false;
  let observer;
  let timer;
  let raf;
  const fraction = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 1 ? Math.max(0, Math.min(1, scrollY / max)) : 0;
  };
  const position = () => send("position", { fraction: fraction() });
  const stopRestore = () => {
    restoring = false;
    observer?.disconnect();
    clearTimeout(timer);
  };
  const restore = (value, fragment = "") => {
    stopRestore();
    restoring = true;
    const move = () => {
      if (fragment) document.getElementById(fragment)?.scrollIntoView();
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
      restore(m.fraction, m.fragment);
      send("initialized");
    } else if (m.type === "snapshot") {
      send("snapshot", { request: m.request, fraction: fraction() });
    } else if (m.type === "style" && typeof m.css === "string") {
      const value = fraction();
      document.getElementById("leaf-reader-style").textContent = m.css;
      requestAnimationFrame(() => restore(value));
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
  addEventListener("wheel", stopRestore, { passive: true });
  addEventListener("pointerdown", stopRestore);
  document.addEventListener("click", (e) => {
    const element = e.target.nodeType === 1 ? e.target : e.target.parentElement;
    const link = element?.closest("a[href]");
    if (!link) return;
    e.preventDefault();
    send("link", { href: link.getAttribute("href") });
  });
  document.addEventListener("keydown", (e) => {
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
    } else if ([" ", "PageUp", "PageDown"].includes(e.key)) {
      e.preventDefault();
      stopRestore();
      scrollBy(
        0,
        (e.key === "PageUp" || e.shiftKey ? -1 : 1) * innerHeight * 0.85,
      );
    }
  });
  send("ready");
})();
