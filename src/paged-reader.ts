import type { Toc } from "./types";

export interface PagedReader {
  readonly pages: number;
  readonly scale: number;
  readonly isFit: boolean;
  render(index: number, keepScroll?: boolean): Promise<boolean>;
  zoomTo(scale: number | null): void;
  outline(): Promise<Toc[]>;
  close(): Promise<void>;
}
