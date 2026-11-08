export type Progress = { chapter: number; fraction: number };
export type Chapter = {
  title: string;
  path: string;
  start_fragment?: string;
  end_fragment?: string;
};
export type Toc = {
  id: string;
  title: string;
  chapter: number | null;
  fragment: string;
  children: Toc[];
};
export type Location = { chapter: number; fragment: string };
export type Part = {
  id: string;
  title: string;
  start: Location;
  end: Location | null;
  chapters: number;
  progress: Progress;
  opened: number;
};
export type Collection = { enabled: boolean; parts: Part[] };
export type ReadingStatus = "unread" | "reading" | "finished";
export type Details = {
  title: string;
  author: string;
  publisher: string;
  published: string;
  isbn: string;
  language: string;
  description: string;
};
export const emptyDetails = (): Details => ({
  title: "",
  author: "",
  publisher: "",
  published: "",
  isbn: "",
  language: "",
  description: "",
});
export type Metadata = {
  details: Details;
  group: string;
  tags: string[];
  favorite: boolean;
  pinned: boolean;
  reading_status: ReadingStatus | null;
};
export type Candidate = {
  id: string;
  title: string;
  depth: number;
  start: Location | null;
  suggested: boolean;
};
export type Book = {
  token: string;
  track_reading_time?: boolean;
  id: string;
  path: string;
  title: string;
  source_title: string;
  author: string;
  chapters: Chapter[];
  toc: Toc[];
  progress: Progress;
  collection: Collection;
  candidates: Candidate[];
  part_id: string | null;
  metadata: Metadata;
};
export type Recent = {
  id: string;
  path: string;
  title: string;
  author: string;
  chapters: number;
  progress: Progress;
  opened: number;
  collection: Collection;
  metadata: Metadata;
  part_metadata: Record<string, Metadata>;
};
export type Snapshot = { books: Recent[]; groups: string[] };
export type ShelfItem = {
  key: string;
  sourceId: string;
  partId: string | null;
  path: string;
  title: string;
  author: string;
  sourceTitle?: string;
  chapters: number;
  progress: Progress;
  opened: number;
  metadata: Metadata;
};
export const emptyMeta = (): Metadata => ({
  details: emptyDetails(),
  group: "",
  tags: [],
  favorite: false,
  pinned: false,
  reading_status: null,
});
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
