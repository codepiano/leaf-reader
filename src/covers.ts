import { convertFileSrc } from "@tauri-apps/api/core";

// Visible covers only, at most two requests in flight. Removing distant src releases decoded images.
export class Covers {
  private dispose = () => {};
  private version = (() => {
    try {
      return localStorage.getItem("leaf.cover-refresh") || "";
    } catch {
      return "";
    }
  })();
  private refreshes = 0;
  invalidate() {
    this.version = `${Date.now().toString(36)}-${++this.refreshes}`;
    try {
      localStorage.setItem("leaf.cover-refresh", this.version);
    } catch {
      /* Current session still refreshes covers. */
    }
  }
  bind(root: HTMLElement) {
    this.dispose();
    const queue = new Set<HTMLImageElement>();
    const jobs = new Map<HTMLImageElement, () => void>();
    let stopped = false;
    const clear = (img: HTMLImageElement) => {
      img.onload = img.onerror = null;
      img.removeAttribute("src");
      img.parentElement?.classList.remove("has-embedded-cover");
      delete img.dataset.loaded;
    };
    const pump = () => {
      if (stopped) return;
      while (jobs.size < 2 && queue.size) {
        const img = queue.values().next().value!;
        queue.delete(img);
        if (!img.isConnected) continue;
        const finish = () => {
          img.onload = img.onerror = null;
          jobs.delete(img);
          pump();
        };
        jobs.set(img, () => {
          clear(img);
          finish();
        });
        img.onload = () => {
          img.dataset.loaded = "true";
          img.parentElement?.classList.add("has-embedded-cover");
          finish();
        };
        img.onerror = () => {
          clear(img);
          observer.unobserve(img);
          finish();
        };
        img.src =
          convertFileSrc("", "epub") +
          "cover/" +
          encodeURIComponent(img.dataset.coverId!) +
          (this.version ? `?v=${encodeURIComponent(this.version)}` : "");
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const img = entry.target as HTMLImageElement;
          if (entry.isIntersecting) {
            if (!img.dataset.loaded && !jobs.has(img)) queue.add(img);
          } else {
            queue.delete(img);
            const cancel = jobs.get(img);
            if (cancel) cancel();
            else clear(img);
          }
        }
        pump();
      },
      { rootMargin: "200px" },
    );
    const images = root.querySelectorAll<HTMLImageElement>(".embedded-cover");
    images.forEach((img) => observer.observe(img));
    this.dispose = () => {
      stopped = true;
      observer.disconnect();
      queue.clear();
      images.forEach(clear);
      jobs.clear();
    };
  }
}
