import { type Book, type Toc, escapeHTML as esc } from "./types";
export const walkToc = (nodes: Toc[]): Toc[] =>
  nodes.flatMap((n) => [n, ...walkToc(n.children)]);
export class TocTree {
  private collapsed = new Set<string>();
  private key = "";
  constructor(private el: HTMLElement) {
    el.addEventListener(
      "toggle",
      (e) => {
        const d = e.target as HTMLDetailsElement;
        if (d.tagName !== "DETAILS" || !d.dataset.node) return;
        if (d.open) this.collapsed.delete(d.dataset.node);
        else this.collapsed.add(d.dataset.node);
        localStorage.setItem(this.key, JSON.stringify([...this.collapsed]));
      },
      true,
    );
  }
  render(
    book: Book,
    navigate: (chapter: number, fraction?: number, fragment?: string) => void,
    openPart: (id: string) => void,
  ) {
    this.key = `leaf.toc.${book.id}`;
    try {
      this.collapsed = new Set(
        JSON.parse(localStorage.getItem(this.key) || "[]"),
      );
    } catch {
      this.collapsed = new Set();
    }
    const flat = walkToc(book.toc);
    const disclosure = (
      id: string,
      title: string,
      body: string,
      classes = "",
    ) =>
      `<details class="toc-group ${classes}" data-node="${esc(id)}" ${this.collapsed.has(id) ? "" : "open"}><summary title="${esc(title)}"><span class="toc-chevron">›</span><span>${esc(title)}</span></summary><div class="toc-children">${body}</div></details>`;
    const nodes = (tree: Toc[]): string =>
      tree
        .map((n) => {
          const jump =
            n.chapter !== null
              ? `<button class="toc-item ${n.children.length ? "toc-jump" : ""}" data-chapter="${n.chapter}" data-toc="${flat.indexOf(n)}" title="${esc(n.title)}"><span>${n.children.length ? "↳" : String(n.chapter + 1).padStart(2, "0")}</span><span>${n.children.length ? "从这里阅读" : esc(n.title)}</span></button>`
              : "";
          return n.children.length
            ? disclosure(n.id, n.title, jump + nodes(n.children))
            : jump ||
                `<div class="toc-label" title="${esc(n.title)}">${esc(n.title)}</div>`;
        })
        .join("");
    let roots = book.toc;
    if (book.collection.enabled && book.part_id) {
      while (roots.length === 1 && roots[0].children.length) {
        const n = roots[0];
        roots = n.children;
        if (n.title === book.title) break;
      }
      this.el.innerHTML = disclosure(
        "root",
        book.source_title,
        book.collection.parts
          .map((p) =>
            disclosure(
              `part-${p.id}`,
              p.title,
              `<button class="toc-part-open" data-part="${esc(p.id)}">${p.id === book.part_id ? "继续阅读" : "打开此书"}</button>` +
                (p.id === book.part_id ? nodes(roots) : ""),
              p.id === book.part_id ? "current-part" : "",
            ),
          )
          .join(""),
      );
    } else {
      if (
        roots.length === 1 &&
        roots[0].title === book.title &&
        roots[0].children.length
      )
        roots = roots[0].children;
      this.el.innerHTML = disclosure(
        "root",
        book.source_title || book.title,
        nodes(roots),
      );
    }
    this.el.querySelectorAll<HTMLElement>("[data-toc]").forEach(
      (b) =>
        (b.onclick = () => {
          const n = flat[Number(b.dataset.toc)];
          if (n.chapter !== null) navigate(n.chapter, 0, n.fragment);
        }),
    );
    this.el
      .querySelectorAll<HTMLElement>("[data-part]")
      .forEach((b) => (b.onclick = () => openPart(b.dataset.part!)));
  }
  active(chapter: number, reveal = false) {
    this.el.querySelectorAll<HTMLElement>("[data-chapter]").forEach((b) => {
      const active = Number(b.dataset.chapter) === chapter;
      b.classList.toggle("active", active);
      if (active) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
      if (active && reveal) {
        let p = b.parentElement;
        while (p && p !== this.el) {
          if (p instanceof HTMLDetailsElement) p.open = true;
          p = p.parentElement;
        }
      }
    });
  }
}
