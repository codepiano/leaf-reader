import type { ShelfItem } from "./types";
export type ShelfSort = "recent" | "title" | "author";
export const sortLabels = {
  recent: "最近阅读时间",
  title: "书名",
  author: "作者",
};
export const validSort = (value: unknown): value is ShelfSort =>
  value === "recent" || value === "title" || value === "author";
const collator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});
const timestamp = (value: number) =>
  value && value < 1e12 ? value * 1000 : value;
export function compareBooks(sort: ShelfSort, a: ShelfItem, b: ShelfItem) {
  const pinned = Number(b.metadata.pinned) - Number(a.metadata.pinned);
  if (pinned) return pinned;
  const title = collator.compare(a.title, b.title);
  const author =
    Number(!a.author.trim()) - Number(!b.author.trim()) ||
    collator.compare(a.author, b.author);
  return (
    (sort === "recent"
      ? timestamp(b.opened) - timestamp(a.opened)
      : sort === "title"
        ? title
        : author) ||
    title ||
    author ||
    a.key.localeCompare(b.key)
  );
}
export function savedSort(): ShelfSort {
  try {
    const value = localStorage.getItem("leaf.shelf-sort");
    return validSort(value) ? value : "recent";
  } catch {
    return "recent";
  }
}
