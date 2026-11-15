import type { SearchTarget } from "./book-search";

type Entry = { index: number; frame: HTMLIFrameElement; channel: string; measured: boolean };
type Position = { chapter: number; fraction: number };
type Action = { type: string; href?: string; direction?: number };
type Jump = { index: number; fraction: number; fragment: string; search?: SearchTarget };

export class ContinuousReader {
  private entries: Entry[] = [];
  private target: Jump | undefined;
  private pending?: { resolve: () => void; reject: (reason: unknown) => void; timer: number };
  private moveFrame = 0;
  private readonly resize = new ResizeObserver(() => this.queueUpdate());
  private lastPosition: Position = { chapter: 0, fraction: 0 };

  constructor(
    private viewport: HTMLElement,
    private count: number,
    private load: (index: number, channel: string) => Promise<string>,
    private title: (index: number) => string,
    private onPosition: (position: Position) => void,
    private onAction: (index: number, action: Action) => void,
    private onError: (message: unknown) => void,
  ) {
    window.addEventListener("message", this.receive);
    viewport.addEventListener("scroll", this.queueUpdate);
    this.resize.observe(viewport);
  }

  dispose() {
    window.removeEventListener("message", this.receive);
    this.viewport.removeEventListener("scroll", this.queueUpdate);
    cancelAnimationFrame(this.moveFrame);
    this.resize.disconnect();
    this.viewport.style.paddingBottom = "";
    this.clearPending("章节已关闭");
    this.viewport.replaceChildren();
    this.entries = [];
  }

  open(index: number, fraction: number, fragment: string, search?: SearchTarget) {
    this.clearPending("章节已切换");
    this.target = { index, fraction, fragment, search };
    this.lastPosition = { chapter: index, fraction };
    if (!this.entries.some((entry) => entry.index === index)) {
      this.viewport.replaceChildren();
      this.viewport.style.paddingBottom = "";
      this.entries = [];
      this.add(index);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => this.clearPending("章节显示超时，请重试"), 10000);
      this.pending = { resolve, reject, timer };
      this.locate();
    });
  }

  position(): Position {
    if (this.target) return this.lastPosition;
    const top = this.viewport.scrollTop;
    let active = this.entries[0];
    for (const entry of this.entries) {
      if (entry.frame.offsetTop > top + 1) break;
      active = entry;
    }
    if (!active?.measured) return this.lastPosition;
    const viewportHeight = this.viewport.clientHeight;
    const height = active.frame.offsetHeight;
    const offset = Math.max(0, top - active.frame.offsetTop);
    const isLast = active.index === this.count - 1;
    // Earlier chapters share the same denominator as single-chapter mode.
    const max = Math.max(1, height - viewportHeight);
    return { chapter: active.index, fraction: isLast && height <= viewportHeight ? 1 : Math.min(1, offset / max) };
  }

  scroll(delta: number) {
    this.viewport.scrollTop += delta;
  }

  style(css: string) {
    for (const entry of this.entries) this.post(entry, "style", { css });
  }

  private clearPending(error?: unknown) {
    this.target = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private add(index: number, prepend = false) {
    const frame = document.createElement("iframe");
    frame.title = this.title(index);
    frame.sandbox.add("allow-scripts");
    frame.referrerPolicy = "no-referrer";
    frame.style.height = Math.max(240, this.viewport.clientHeight) + "px";
    const entry = { index, frame, channel: "stream-" + crypto.getRandomValues(new Uint32Array(3)).join("-"), measured: false };
    const top = this.viewport.scrollTop;
    if (prepend) {
      this.entries.unshift(entry);
      this.viewport.prepend(frame);
      this.viewport.scrollTop = top + frame.offsetHeight;
    } else {
      this.entries.push(entry);
      this.viewport.append(frame);
    }
    void this.load(index, entry.channel).then((source) => {
      if (frame.isConnected) frame.srcdoc = source;
    }).catch((error) => {
      if (!frame.isConnected) return;
      if (this.target?.index === index) this.clearPending(error);
      // Leave the failed chapter as a placeholder so neighbors stay reachable.
      frame.title = this.title(index) + "（加载失败）";
      this.onError(error);
    });
  }

  private post(entry: Entry, type: string, data: Record<string, unknown> = {}) {
    entry.frame.contentWindow?.postMessage({ channel: entry.channel, type, ...data }, "*");
  }

  private locate() {
    const target = this.target;
    const entry = this.entries.find((item) => item.index === target?.index);
    if (!target || !entry?.measured) return;
    if (target.fragment || target.search) {
      this.post(entry, "locate", { fragment: target.fragment, search: target.search });
    } else {
      this.finish(entry, Math.max(0, entry.frame.offsetHeight - this.viewport.clientHeight) * target.fraction);
    }
  }

  private fitLastChapter() {
    const last = this.entries.at(-1);
    const padding = last?.measured && last.index === this.count - 1
      ? Math.max(0, this.viewport.clientHeight - last.frame.offsetHeight) : 0;
    this.viewport.style.paddingBottom = padding + "px";
  }

  private finish(entry: Entry, offset: number) {
    this.fitLastChapter();
    this.viewport.scrollTop = entry.frame.offsetTop + offset;
    this.clearPending();
    this.update();
  }

  private queueUpdate = () => {
    cancelAnimationFrame(this.moveFrame);
    this.moveFrame = requestAnimationFrame(() => this.update());
  };

  private update() {
    if (this.target || !this.entries.length) return;
    this.fitLastChapter();
    const position = this.position();
    this.lastPosition = position;
    this.onPosition(position);
    // Keep enough nearby frames to scroll across chapter boundaries in either direction.
    const top = this.viewport.scrollTop;
    const h = this.viewport.clientHeight;
    const first = this.entries[0];
    const last = this.entries.at(-1)!;
    if (last.index + 1 < this.count && last.measured &&
        last.index < position.chapter + 4 && last.frame.offsetTop + last.frame.offsetHeight - top < h * 2)
      this.add(last.index + 1);
    if (first.index > 0 && first.measured && top < h && first.index >= position.chapter - 2)
      this.add(first.index - 1, true);
    while (this.entries[0].index < position.chapter - 3) {
      const { frame } = this.entries.shift()!;
      const previousTop = this.viewport.scrollTop;
      const height = frame.offsetHeight;
      frame.remove();
      this.viewport.scrollTop = previousTop - height;
    }
    while (this.entries.at(-1)!.index > position.chapter + 3 && this.entries.at(-1)!.frame.offsetTop > this.viewport.scrollTop + h * 2)
      this.entries.pop()!.frame.remove();
  }

  private receive = (event: MessageEvent) => {
    const m = event.data;
    if (event.origin !== "null" || !m?.leaf) return;
    const entry = this.entries.find(({ frame, channel }) => event.source === frame.contentWindow && m.channel === channel);
    if (!entry) return;
    if (m.type === "measure" && Number.isFinite(m.height) && m.height > 0) {
      const top = this.viewport.scrollTop;
      const oldHeight = entry.frame.offsetHeight;
      const isBefore = entry.frame.offsetTop + oldHeight <= top + 1;
      entry.frame.style.height = Math.ceil(m.height) + "px";
      entry.measured = true;
      if (isBefore) this.viewport.scrollTop = top + entry.frame.offsetHeight - oldHeight;
      if (this.target?.index === entry.index) this.locate();
      this.queueUpdate();
    } else if (m.type === "located" && this.target?.index === entry.index && Number.isFinite(m.offset)) {
      this.finish(entry, Math.max(0, m.offset - 24));
    } else if (m.type === "wheel" && Number.isFinite(m.delta)) {
      const scale = m.mode === 1 ? 20 : m.mode === 2 ? this.viewport.clientHeight : 1;
      this.scroll(m.delta * scale);
    } else if (m.type === "scroll-page" && (m.direction === -1 || m.direction === 1)) {
      this.scroll(m.direction * this.viewport.clientHeight * 0.85);
    } else {
      this.onAction(entry.index, m);
    }
  };
}
