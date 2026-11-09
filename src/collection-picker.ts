import { type Candidate, escapeHTML as esc } from "./types";
type Node = {
  candidate: Candidate;
  children: Node[];
  parent?: Node;
  index: number;
  selectedBelow: number;
  badge?: HTMLElement;
};

export class CollectionPicker {
  private selected = new Set<string>();
  private nodes = new Map<string, Node>();
  constructor(
    container: HTMLElement,
    candidates: Candidate[],
    chosen: Set<string>,
    changed: (count: number) => void,
  ) {
    const roots: Node[] = [],
      stack: Node[] = [];
    for (const [index, candidate] of candidates.entries()) {
      while (
        stack.length &&
        stack[stack.length - 1].candidate.depth >= candidate.depth
      )
        stack.pop();
      const parent = stack.at(-1);
      const node: Node = {
        candidate,
        children: [],
        parent,
        index,
        selectedBelow: 0,
      };
      (parent ? parent.children : roots).push(node);
      this.nodes.set(candidate.id, node);
      stack.push(node);
      if (candidate.start && chosen.has(candidate.id))
        this.selected.add(candidate.id);
    }
    for (const id of this.selected) {
      for (
        let parent = this.nodes.get(id)?.parent;
        parent;
        parent = parent.parent
      )
        parent.selectedBelow++;
    }
    const updateBadge = (node: Node) => {
      if (!node.badge) return;
      node.badge.hidden = node.selectedBelow === 0;
      node.badge.textContent = `下级已选 ${node.selectedBelow}`;
    };
    const render = (nodes: Node[], list: HTMLElement) => {
      for (const node of nodes) {
        const c = node.candidate,
          branchId = `collection-children-${node.index}`;
        const li = document.createElement("li");
        li.innerHTML = `<div class="candidate-row">${node.children.length ? `<button class="candidate-toggle icon-button" type="button" aria-expanded="false" aria-controls="${branchId}" aria-label="展开 ${esc(c.title)}" title="展开下级目录">›</button>` : '<span class="candidate-spacer" aria-hidden="true"></span>'}<label class="collection-candidate"><input type="checkbox" value="${esc(c.id)}" ${this.selected.has(c.id) ? "checked" : ""} ${c.start ? "" : "disabled"}><span><strong>${esc(c.title)}</strong><small>${c.start ? `起始于第 ${c.start.chapter + 1} 个章节` : "没有可阅读内容"}</small></span></label><span class="candidate-selection-count" hidden></span></div>`;
        node.badge = li.querySelector<HTMLElement>(
          ".candidate-selection-count",
        )!;
        updateBadge(node);
        const input = li.querySelector<HTMLInputElement>("input")!;
        input.onchange = () => {
          if (input.checked === this.selected.has(c.id)) return;
          const delta = input.checked ? 1 : -1;
          if (input.checked) this.selected.add(c.id);
          else this.selected.delete(c.id);
          for (let parent = node.parent; parent; parent = parent.parent) {
            parent.selectedBelow += delta;
            updateBadge(parent);
          }
          changed(this.selected.size);
        };
        if (node.children.length) {
          const children = document.createElement("ul");
          children.id = branchId;
          children.hidden = true;
          const toggle = li.querySelector<HTMLButtonElement>("button")!;
          let mounted = false;
          toggle.onclick = () => {
            const expanded = toggle.getAttribute("aria-expanded") !== "true";
            if (expanded && !mounted) {
              render(node.children, children);
              mounted = true;
            }
            children.hidden = !expanded;
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.setAttribute(
              "aria-label",
              `${expanded ? "收起" : "展开"} ${c.title}`,
            );
            toggle.title = expanded ? "收起下级目录" : "展开下级目录";
          };
          li.append(children);
        }
        list.append(li);
      }
    };
    const list = document.createElement("ul");
    list.className = "candidate-tree";
    list.setAttribute("aria-label", "可选子书目录");
    container.replaceChildren(list);
    render(roots, list);
    changed(this.selected.size);
  }
  selectedIds() {
    return [...this.selected];
  }
}
