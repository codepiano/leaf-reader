import { invoke } from "@tauri-apps/api/core";
import { escapeHTML } from "./types";

export async function exportText(
  snapshot: { token: string; body: HTMLElement; base: string },
  title: string,
  path: string,
  css: string,
) {
  const body = snapshot.body.cloneNode(true) as HTMLElement;
  const base = new URL(snapshot.base);
  const prefix = `/${snapshot.token}/`;
  const images = [...body.querySelectorAll("img")];
  const references = images.map((image) => {
    try {
      const url = new URL(image.getAttribute("src") ?? "", base);
      const decoded = decodeURIComponent(url.pathname);
      if (url.protocol === base.protocol && url.host === base.host && decoded.startsWith(prefix))
        return decoded.slice(prefix.length);
    } catch { /* Retain alternative text for an invalid image. */ }
    return "";
  });
  const unique = [...new Set(references.filter(Boolean))];
  const embedded = unique.length
    ? await invoke<Record<string, string>>("text_export_images", { token: snapshot.token, paths: unique })
    : {};
  images.forEach((image, i) => {
    const src = embedded[references[i]];
    if (src) image.setAttribute("src", src);
    else image.replaceWith(document.createTextNode(image.alt));
  });
  body.querySelectorAll("a[href]").forEach((link) => {
    if (!link.getAttribute("href")?.startsWith("#")) link.removeAttribute("href");
  });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHTML(title)}</title><style>${css}</style><body>${body.innerHTML}</body></html>`;
  await invoke("save_text_export", { token: snapshot.token, path, html });
}
