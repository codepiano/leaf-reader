import { invoke } from "@tauri-apps/api/core";

// Count only short intervals of foreground reading. Long gaps (sleep/suspension) are discarded.
export class ReadingClock {
  private token = "";
  private enabled = true;
  private paused = true;
  private last = performance.now();
  private active = false;
  private pending = 0;
  private chain = Promise.resolve();
  constructor(
    private eligible = () =>
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      !document.querySelector("dialog[open]") &&
      !document.querySelector("#reader-view")?.hasAttribute("hidden"),
    private save = (token: string, milliseconds: number) =>
      invoke<void>("save_reading_time", { token, milliseconds }),
  ) {}
  sample() {
    const now = performance.now(),
      elapsed = now - this.last;
    if (this.active && elapsed > 0 && elapsed <= 2000) this.pending += elapsed;
    this.last = now;
    this.active =
      !!this.token && this.enabled && !this.paused && this.eligible();
  }
  resume(token: string, enabled: boolean) {
    this.sample();
    if (this.token !== token) {
      this.token = token;
      this.pending = 0;
    }
    this.enabled = enabled;
    this.paused = false;
    this.last = performance.now();
    this.active = enabled && this.eligible();
  }
  pause() {
    this.sample();
    this.paused = true;
    this.active = false;
  }
  preference(enabled: boolean) {
    this.sample();
    this.enabled = enabled;
    this.pending = 0;
    this.active = !this.paused && enabled && this.eligible();
  }
  flush() {
    this.sample();
    const token = this.token,
      milliseconds = Math.min(60000, Math.floor(this.pending));
    if (!token || milliseconds === 0) return this.chain;
    this.pending -= milliseconds;
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        try {
          await this.save(token, milliseconds);
        } catch (e) {
          if (this.token === token) this.pending += milliseconds;
          throw e;
        }
      });
    return this.chain;
  }
}
