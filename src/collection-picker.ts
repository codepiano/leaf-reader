import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import { type Candidate, escapeHTML as esc } from "./types";
type Node = {
  candidate: Candidate;
  children: Node[];
  parent?: Node;
  index: number;
  selectedBelow: number;
  badge?: HTMLElement;
  input?: HTMLInputElement;
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
    let currentParent: Node | undefined;
    const tools = document.createElement("div");
    tools.className = "collection-picker-tools";
    tools.innerHTML =
      '<span class="collection-current-layer"></span><div class="collection-bulk-actions"><wa-button class="quiet-button" data-select-layer size="s" title="全选当前分组的直接下级，自动移除对应的父子冲突勾选">全选当前层</wa-button><wa-button class="quiet-button" data-clear-selection size="s" title="取消所有层级的勾选，包括折叠项">取消全选</wa-button></div>';
    const selectLayer = tools.querySelector<WaButton>("[data-select-layer]")!;
    const clearSelection = tools.querySelector<WaButton>(
      "[data-clear-selection]",
    )!;
    const layerLabel = tools.querySelector<HTMLElement>(
      ".collection-current-layer",
    )!;
    const currentLayer = () => (currentParent ? currentParent.children : roots);
    const updateTools = () => {
      const label = currentParent
        ? `${currentParent.candidate.title} 的下级`
        : "第一层";
      layerLabel.textContent = `当前层：${label}`;
      layerLabel.title = layerLabel.textContent;
      selectLayer.disabled = !currentLayer().some(
        (node) => node.candidate.start,
      );
      clearSelection.disabled = this.selected.size === 0;
    };
    const changeLayer = (parent: Node | undefined) => {
      currentParent = parent;
      updateTools();
    };
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
        node.input = input;
        input.onchange = () => {
          changeLayer(node.parent);
          if (input.checked === this.selected.has(c.id)) return;
          const delta = input.checked ? 1 : -1;
          if (input.checked) this.selected.add(c.id);
          else this.selected.delete(c.id);
          for (let parent = node.parent; parent; parent = parent.parent) {
            parent.selectedBelow += delta;
            updateBadge(parent);
          }
          updateTools();
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
            changeLayer(expanded ? node : node.parent);
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
    const syncSelection = () => {
      for (const node of this.nodes.values()) node.selectedBelow = 0;
      for (const id of this.selected) {
        for (
          let parent = this.nodes.get(id)?.parent;
          parent;
          parent = parent.parent
        )
          parent.selectedBelow++;
      }
      for (const node of this.nodes.values()) {
        if (node.input)
          node.input.checked = this.selected.has(node.candidate.id);
        updateBadge(node);
      }
      updateTools();
      changed(this.selected.size);
    };
    selectLayer.onclick = () => {
      const targets = currentLayer().filter((node) => node.candidate.start);
      const ids = new Set(targets.map((node) => node.candidate.id));
      // Selecting sibling starts replaces only conflicting ancestors and descendants.
      for (const target of targets) {
        for (let parent = target.parent; parent; parent = parent.parent)
          this.selected.delete(parent.candidate.id);
      }
      for (const id of this.selected) {
        for (
          let parent = this.nodes.get(id)?.parent;
          parent;
          parent = parent.parent
        ) {
          if (ids.has(parent.candidate.id)) {
            this.selected.delete(id);
            break;
          }
        }
      }
      for (const id of ids) this.selected.add(id);
      syncSelection();
    };
    clearSelection.onclick = () => {
      this.selected.clear();
      syncSelection();
    };
    const list = document.createElement("ul");
    list.className = "candidate-tree";
    list.setAttribute("aria-label", "可选子书目录");
    container.replaceChildren(tools, list);
    render(roots, list);
    updateTools();
    changed(this.selected.size);
  }
  selectedIds() {
    return [...this.selected];
  }
}
