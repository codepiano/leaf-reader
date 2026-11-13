const preferenceKey = "leaf.toc-sidebar";
const minWidth = 220;
const maxWidth = 440;
const readerMinWidth = 360;

export class TocSidebar {
  private reading = false;
  private open = false;
  private pinned = true;
  private width = 280;
  private drag?: { id: number; startX: number; width: number };

  constructor(
    private panel: HTMLElement,
    private toggle: HTMLElement,
    private pin: HTMLElement,
    close: HTMLElement,
    private handle: HTMLElement,
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) || "null");
      this.pinned = saved?.pinned !== false;
      if (Number.isFinite(saved?.width))
        this.width = Math.max(minWidth, Math.min(maxWidth, saved.width));
    } catch {
      // A fresh or unavailable preference store uses the defaults.
    }

    toggle.addEventListener("click", () => {
      if (this.open) this.close(true);
      else {
        this.open = true;
        this.render();
        const current = this.panel.querySelector<HTMLElement>(".toc-item.active");
        if (current?.getClientRects().length) {
          current.scrollIntoView({ block: "nearest" });
          current.focus({ preventScroll: true });
        }
        if (!this.panel.contains(document.activeElement)) this.pin.focus();
      }
    });
    close.addEventListener("click", () => this.close(true));
    pin.addEventListener("click", () => {
      this.pinned = !this.pinned;
      this.save();
      this.render();
    });
    new ResizeObserver(() => this.render()).observe(this.workspace);
    document.addEventListener("pointerdown", (event) => {
      const path = event.composedPath();
      if (!path.includes(this.panel) && !path.includes(this.toggle))
        this.dismissTemporary();
    });

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.drag) return;
      this.drag = { id: event.pointerId, startX: event.clientX, width: this.visibleWidth };
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      this.workspace.classList.add("resizing-toc");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      const drag = this.drag;
      if (drag?.id === event.pointerId)
        this.resize(drag.width + drag.startX - event.clientX);
    });
    handle.addEventListener("lostpointercapture", (event) => {
      if (this.drag?.id === event.pointerId) this.finishResize();
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.close(true);
        return;
      }
      const step = event.shiftKey ? 48 : 16;
      const next =
        event.key === "ArrowLeft" ? this.visibleWidth + step :
        event.key === "ArrowRight" ? this.visibleWidth - step :
        event.key === "Home" ? minWidth :
        event.key === "End" ? this.widthLimit : null;
      if (next === null) return;
      event.preventDefault();
      this.resize(next);
      this.save();
    });
    this.render();
  }

  setReading(reading: boolean) {
    if (reading !== this.reading) this.open = reading && this.pinned;
    this.reading = reading;
    this.render();
  }

  dismissTemporary(restoreFocus = false) {
    return !this.pinned && this.close(restoreFocus);
  }

  private close(restoreFocus: boolean) {
    if (!this.open) return false;
    this.open = false;
    this.render();
    if (restoreFocus) this.toggle.focus({ preventScroll: true });
    return true;
  }

  private get workspace() {
    return this.panel.parentElement!;
  }

  private get widthLimit() {
    return Math.max(minWidth, Math.min(maxWidth, this.workspace.clientWidth - readerMinWidth));
  }

  private get visibleWidth() {
    return Math.min(this.width, this.widthLimit);
  }

  private resize(next: number) {
    const width = Math.max(minWidth, Math.min(this.widthLimit, Math.round(next)));
    if (width === this.visibleWidth) return;
    this.width = width;
    this.render();
  }

  private finishResize() {
    const drag = this.drag;
    this.drag = undefined;
    this.workspace.classList.remove("resizing-toc");
    if (drag && this.handle.hasPointerCapture(drag.id))
      this.handle.releasePointerCapture(drag.id);
    this.save();
  }

  private save() {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify({ pinned: this.pinned, width: this.width }));
    } catch {
      // The preference still applies until the window closes.
    }
  }

  private render() {
    const visible = this.reading && this.open;
    if (!visible && this.drag) this.finishResize();
    this.toggle.hidden = !this.reading;
    this.toggle.setAttribute("aria-expanded", String(visible));
    this.panel.hidden = !visible;
    this.panel.dataset.mode = this.pinned ? "docked" : "floating";
    this.pin.setAttribute("aria-pressed", String(this.pinned));
    this.pin.title = this.pinned ? "取消固定目录" : "固定目录";
    this.panel.style.setProperty("--toc-width", `${this.visibleWidth}px`);
    this.handle.setAttribute("aria-valuemin", String(minWidth));
    this.handle.setAttribute("aria-valuemax", String(this.widthLimit));
    this.handle.setAttribute("aria-valuenow", String(this.visibleWidth));
    this.handle.setAttribute("aria-valuetext", `${this.visibleWidth} 像素`);
  }
}
