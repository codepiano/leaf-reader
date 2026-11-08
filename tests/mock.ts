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
      const meta = () => ({ group: "", tags: [], favorite: false });
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
        view.collection = copy(r.collection);
        view.progress = copy(p ? p.progress : r.progress);
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
            if (command === "book_info") {
              const r = s.books.find((r: any) => r.id === args.sourceId);
              const part = args.partId
                ? r.collection.parts.find((p: any) => p.id === args.partId)
                : null;
              const missing = localStorage.getItem("mock.missing");
              return {
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
              return s.settings || { directory: null, import_enabled: false };
            if (command === "set_library_settings") {
              if (args.directory === "/unavailable") throw "无法访问书库目录";
              s.settings = {
                directory: args.directory,
                import_enabled: args.importEnabled,
              };
              save(s);
              return s.settings;
            }
            if (command === "library_snapshot") return s;
            if (command === "list_recent") return s.books;
            if (command === "open_demo")
              return opened(anthology ? "anthology" : "sample");
            if (command === "plugin:dialog|open") {
              if (args.options?.directory)
                return localStorage.getItem("mock.directory") || null;
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
            if (command === "edit_metadata") {
              const r = s.books.find((r: any) => r.id === args.sourceId),
                m = {
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
