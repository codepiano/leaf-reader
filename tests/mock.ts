import { type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const catalog = JSON.parse(
  readFileSync("fixtures/browser-catalog.json", "utf8"),
);
const files = Object.fromEntries(
  ["quiet-days", "anthology"].map((name) => [
    name,
    JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `import json,zipfile;z=zipfile.ZipFile('fixtures/${name}.epub');print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))`,
        ],
        { encoding: "utf8" },
      ),
    ),
  ]),
);
export async function mockDesktop(
  page: Page,
  malicious = false,
  broken = false,
  anthology = false,
  both = false,
) {
  await page.addInitScript(
    ({ catalog, files, malicious, broken, anthology, both }) => {
      const copy = (v: any) => JSON.parse(JSON.stringify(v));
      const meta = () => ({
        group: "",
        tags: [],
        favorite: false,
        pinned: false,
        reading_status: null as string | null,
      });
      const load = () =>
        JSON.parse(
          localStorage.getItem("mock.library") || '{"books":[],"groups":[]}',
        );
      const save = (s: any) =>
        localStorage.setItem("mock.library", JSON.stringify(s));
      const root = (id: string) =>
        copy(catalog[id === "sample" ? "sample" : "anthology"]);
      const ensure = (state: any, id: string) => {
        let record = state.books.find((r: any) => r.id === id);
        if (record) return record;
        const r = root(id);
        record = {
          id,
          path: r.path,
          title: r.title,
          author: r.author,
          chapters: r.chapters.length,
          progress: { chapter: 0, fraction: 0 },
          opened: 0,
          collection: { enabled: false, parts: [] },
          metadata: meta(),
          part_metadata: {},
        };
        state.books.push(record);
        return record;
      };
      if (both && !load().books.length) {
        const s = load();
        ensure(s, "sample");
        ensure(s, "anthology");
        save(s);
      }
      let active: any = null;
      const opened = (
        id: string,
        partId: string | null = null,
        markRead = true,
      ) => {
        const s = load(),
          r = ensure(s, id);
        let view = root(id);
        if (r.collection.enabled && !partId) view = copy(catalog.collection);
        if (partId) {
          view = copy(catalog.parts[partId]);
          if (!view) throw "子书不存在";
        }
        const p = partId
          ? r.collection.parts.find((p: any) => p.id === partId)
          : null;
        if (markRead) {
          if (p) p.opened = Date.now();
          else if (!r.collection.enabled) r.opened = Date.now();
        }
        if (markRead && (p || !r.collection.enabled)) {
          const m = p ? (r.part_metadata[p.id] ||= meta()) : r.metadata;
          m.reading_status ??= "reading";
        }
        view.collection = copy(r.collection);
        view.progress =
          s.settings?.remember_position === false
            ? { chapter: 0, fraction: 0 }
            : copy(p ? p.progress : r.progress);
        view.track_reading_time = s.settings?.track_reading_time ?? true;
        view.part_id = partId;
        view.metadata = copy(
          partId ? r.part_metadata[partId] || meta() : r.metadata,
        );
        view.id = id;
        view.path = r.path;
        view.token = `${id}-${Date.now()}-${Math.random()}`;
        active = view;
        save(s);
        return view;
      };
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          convertFileSrc: (path: string) =>
            `http://epub.localhost/${encodeURIComponent(path)}`,
          invoke: async (command: string, args: Record<string, any> = {}) => {
            const s = load();
            ((window as any).__mockCommands ||= []).push({
              command,
              args: copy(args),
            });
            if (command === "scan_directories") return s.scan_directories || [];
            if (command === "set_scan_directories") {
              if (args.directories.includes("/unavailable"))
                throw "扫描目录无法访问或不是文件夹";
              s.scan_directories = [...new Set(args.directories)];
              save(s);
              return s.scan_directories;
            }
            if (command === "scan_library") {
              const before = s.books.length;
              if (s.scan_directories?.length) {
                ensure(s, "sample");
                ensure(s, "anthology");
              }
              save(s);
              const failed = localStorage.getItem("mock.scan_error") === "1";
              return {
                found: s.scan_directories?.length ? 2 : 0,
                added: s.books.length - before,
                existing: before,
                failed: failed ? 1 : 0,
                errors: failed
                  ? ["/sources/broken.epub：文件不是有效的 EPUB"]
                  : [],
                truncated: localStorage.getItem("mock.scan_limit") === "1",
              };
            }
            if (command === "save_reading_time") {
              if (!active || active.token !== args.token) throw "书籍已关闭";
              if (s.settings?.track_reading_time === false) return;
              const key =
                active.id + (active.part_id ? "::" + active.part_id : "");
              s.reading_ms ||= {};
              s.reading_ms[key] = (s.reading_ms[key] || 0) + args.milliseconds;
              save(s);
              return;
            }
            if (command === "book_info") {
              const r = s.books.find((r: any) => r.id === args.sourceId);
              const part = args.partId
                ? r.collection.parts.find((p: any) => p.id === args.partId)
                : null;
              const missing = localStorage.getItem("mock.missing");
              return {
                reading_ms: Object.entries(s.reading_ms || {})
                  .filter(
                    ([k]) =>
                      k ===
                        args.sourceId +
                          (args.partId ? "::" + args.partId : "") ||
                      (!args.partId && k.startsWith(args.sourceId + "::")),
                  )
                  .reduce((sum, [, v]) => sum + Number(v), 0),
                title: part?.title || r.title,
                author: r.author,
                path: localStorage.getItem("mock.info-path") || r.path,
                size: missing ? null : 2030,
                modified: missing ? null : 1794153600000,
                chapters: part?.chapters || r.chapters,
                source_chapters: r.chapters,
                source_title: part ? r.title : null,
                metadata: part
                  ? r.part_metadata[part.id] || meta()
                  : r.metadata,
                file_error: missing ? "文件已移动或无法访问" : null,
              };
            }
            if (command === "library_settings")
              return (
                s.settings || {
                  directory: null,
                  import_enabled: false,
                  remember_position: true,
                  track_reading_time: true,
                }
              );
            if (command === "set_library_settings") {
              if (args.directory === "/unavailable") throw "无法访问书库目录";
              s.settings = {
                directory: args.directory,
                import_enabled: args.importEnabled,
                remember_position: args.rememberPosition ?? true,
                track_reading_time: args.trackReadingTime ?? true,
              };
              save(s);
              return s.settings;
            }
            if (command === "library_snapshot") return s;
            if (command === "list_recent") return s.books;
            if (command === "open_demo")
              return opened(anthology ? "anthology" : "sample");
            if (command === "plugin:dialog|open") {
              if (args.options?.directory) {
                if (args.options.multiple)
                  return JSON.parse(
                    localStorage.getItem("mock.scan_pick") || "null",
                  );
                return localStorage.getItem("mock.directory") || null;
              }
              return anthology ? "/anthology.epub" : "/sample.epub";
            }
            if (command === "open_book")
              return opened(
                args.path === "/anthology.epub" ? "anthology" : "sample",
                args.partId || null,
              );
            if (command === "get_chapter") {
              if (broken) throw "章节资源不存在";
              if (!active) throw "书籍已关闭";
              const data =
                files[active.id === "anthology" ? "anthology" : "quiet-days"];
              return (
                data[active.chapters[args.index].path] +
                (malicious
                  ? '<script>parent.document.body.dataset.compromised="yes"</script><img src="https://example.invalid/track"><iframe src="https://example.invalid/"></iframe><form action="https://example.invalid/"><input autofocus></form>'
                  : "")
              );
            }
            if (command === "save_progress") {
              if (s.settings?.remember_position === false) return;
              const r = s.books.find((r: any) => r.id === active.id),
                p = active.part_id
                  ? r.collection.parts.find((p: any) => p.id === active.part_id)
                  : r;
              p.progress = { chapter: args.chapter, fraction: args.fraction };
              save(s);
              return;
            }
            if (command === "set_collection") {
              const r = s.books.find((r: any) => r.id === active.id);
              if (args.enabled) {
                if (args.nodeIds.length < 2) throw "请至少选择两个子书起点";
                if (
                  args.nodeIds.some((a: string) =>
                    args.nodeIds.some(
                      (b: string) => a !== b && a.startsWith(b + "-"),
                    ),
                  )
                )
                  throw "不能同时选择一个分组和它内部的章节";
                const old = r.collection.parts;
                r.collection = copy(catalog.collection.collection);
                for (const p of r.collection.parts) {
                  const found = old.find((o: any) => o.id === p.id);
                  if (found) {
                    p.progress = found.progress;
                    p.opened = found.opened;
                  }
                }
              } else r.collection.enabled = false;
              save(s);
              return opened(active.id, null, false);
            }
            if (command === "pin_book") {
              const r = s.books.find((r: any) => r.id === args.sourceId);
              const m = args.partId
                ? (r.part_metadata[args.partId] ||= meta())
                : r.metadata;
              m.pinned = args.pinned;
              save(s);
              return;
            }
            if (command === "edit_metadata") {
              const r = s.books.find((r: any) => r.id === args.sourceId),
                m = {
                  ...(args.partId
                    ? r.part_metadata[args.partId] || meta()
                    : r.metadata),
                  ...(args.flags || {}),
                  group: args.group.trim(),
                  tags: [...new Set(args.tags.map((t: string) => t.trim()))],
                  favorite: args.favorite,
                };
              if (args.partId) r.part_metadata[args.partId] = m;
              else r.metadata = m;
              if (m.group && !s.groups.includes(m.group))
                s.groups.push(m.group);
              save(s);
              return;
            }
            if (command === "manage_group") {
              const name = args.name.trim(),
                next = args.newName?.trim();
              if (!name || name.length > 64) throw "名称应为 1–64 个字符";
              if (args.action === "create") {
                if (s.groups.includes(name)) throw "分组已存在";
                s.groups.push(name);
              } else {
                const index = s.groups.indexOf(name);
                if (index < 0) throw "分组不存在";
                if (args.action === "delete") s.groups.splice(index, 1);
                else s.groups[index] = next;
                for (const r of s.books) {
                  for (const m of [
                    r.metadata,
                    ...Object.values(r.part_metadata),
                  ] as any[])
                    if (m.group === name)
                      m.group = args.action === "delete" ? "" : next;
                }
              }
              save(s);
              return;
            }
            if (command === "close_book") {
              active = null;
              return;
            }
            throw new Error(`Unexpected command: ${command}`);
          },
        },
      });
    },
    { catalog, files, malicious, broken, anthology, both },
  );
  await page.route("http://epub.localhost/**", async (route) => {
    const coverPath = new URL(route.request().url()).pathname;
    if (coverPath.startsWith("/cover/")) {
      const mode = await page.evaluate(
        () => localStorage.getItem("mock.cover") || "none",
      );
      if (mode === "slow")
        await new Promise((resolve) => setTimeout(resolve, 1500));
      if (mode === "broken") {
        await route.fulfill({ body: "broken", contentType: "image/png" });
        return;
      }
      if (mode === "none" || coverPath.endsWith("/anthology")) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      const body = execFileSync(
        "python3",
        [
          "-c",
          "import zipfile;print(zipfile.ZipFile('fixtures/embedded-cover.epub').read('OPS/cover.svg').decode())",
        ],
        { encoding: "utf8" },
      );
      await route.fulfill({
        body,
        contentType: "image/svg+xml",
        headers: { "Access-Control-Allow-Origin": "*" },
      });
      return;
    }
    const path = new URL(route.request().url()).pathname
      .split("/")
      .slice(2)
      .join("/");
    await route.fulfill({
      body: files["quiet-days"][path] || files.anthology[path] || "",
      contentType: path.endsWith(".css") ? "text/css" : "image/svg+xml",
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  });
}
