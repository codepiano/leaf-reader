import { invoke } from "@tauri-apps/api/core";
import type { Book } from "./types";

export type SearchTarget = { query: string; occurrence: number };
export type SearchHit = { chapter: number; excerpt: string; target: SearchTarget };

const excluded = "script,style,title,template,iframe,object,embed,form,button,textarea,select,audio,video,.math-inline,.math-display,[hidden], [aria-hidden=true]";
const separated = "article,aside,blockquote,br,dd,div,dt,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,p,pre,section,td,th";

export function chapterMatches(source: string, section: Book["chapters"][number], query: string) {
  const template = document.createElement("template");
  template.innerHTML = source;
  let root = template.content;
  if (section.start_fragment || section.end_fragment) {
    const start = section.start_fragment && root.getElementById(section.start_fragment);
    const end = section.end_fragment && root.getElementById(section.end_fragment);
    if ((section.start_fragment && !start) || (section.end_fragment && !end)) return [];
    const range = template.ownerDocument.createRange();
    range.selectNodeContents(root);
    if (start) range.setStartBefore(start);
    if (end) range.setEndBefore(end);
    root = range.cloneContents();
  }
  root.querySelectorAll(excluded).forEach((node) => node.remove());
  root.querySelectorAll(separated).forEach((node) => {
    node.before("\n");
    node.after("\n");
  });
  const value = root.textContent ?? "";
  const pattern = query.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const matches = value.matchAll(new RegExp(pattern, "giu"));
  const result: string[] = [];
  for (const match of matches) {
    const start = Math.max(0, match.index - 30);
    const end = Math.min(value.length, match.index + match[0].length + 45);
    result.push((start > 0 ? "…" : "") + value.slice(start, end).replace(/\s+/g, " ").trim() + (end < value.length ? "…" : ""));
    if (result.length === 80) break;
  }
  return result;
}

export async function searchBook(book: Book, query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for (const [index, section] of book.chapters.entries()) {
    signal.throwIfAborted();
    const source = await invoke<string>("get_chapter", { token: book.token, index });
    signal.throwIfAborted();
    for (const [occurrence, excerpt] of chapterMatches(source, section, query).entries()) {
      hits.push({ chapter: index, excerpt, target: { query, occurrence } });
      if (hits.length === 80) return hits;
    }
  }
  return hits;
}
