import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import { escapeHTML as esc } from "./types";

type Report = {
  found: number;
  added: number;
  existing: number;
  updated?: number;
  missing?: number;
  failed: number;
  errors: string[];
  truncated: boolean;
};
function reportHTML(result: Report, action = "扫描", noDirectories = false) {
  return `<p>${result.truncated ? action + "部分完成" : action + "完成"}：发现 ${result.found} 本，新增 ${result.added} 本，更新 ${result.updated ?? 0} 本，已有 ${result.existing} 本，文件不可用 ${result.missing ?? 0} 本，失败 ${result.failed} 项。</p>${noDirectories ? "<p>尚未配置扫描目录；已检查现有书籍的文件状态，可在侧栏“扫描目录”中添加来源。</p>" : ""}${result.truncated ? '<p class="dialog-error">已达到本次扫描上限（100,000 个目录项或 10,000 本书），部分内容尚未扫描。请缩小扫描目录范围。</p>' : ""}${result.errors.length ? `<details><summary>查看失败详情（最多 50 条）</summary><ul>${result.errors.map((message) => `<li>${esc(message)}</li>`).join("")}</ul></details>` : ""}`;
}
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
export function initScanDirectories(
  reportError: (error: unknown) => void,
  refresh: () => Promise<unknown>,
) {
  $(".shelf-tools").insertAdjacentHTML(
    "afterbegin",
    '<wa-button id="shelf-refresh" class="quiet-button" size="s" title="重新扫描已配置的目录，更新书架和封面">↻ 刷新</wa-button>',
  );
  $(".shelf-tools").insertAdjacentHTML(
    "afterend",
    '<section id="shelf-refresh-report" class="shelf-refresh-report" role="status" hidden></section>',
  );
  $(".sidebar-bottom").insertAdjacentHTML(
    "afterbegin",
    '<wa-button id="scan-settings" class="quiet-button" size="s">扫描目录</wa-button>',
  );
  document.body.insertAdjacentHTML(
    "beforeend",
    `<dialog id="scan-dialog" class="app-dialog"><div class="dialog-heading"><div><div class="eyebrow">书籍来源</div><h2>扫描目录</h2></div><wa-button id="scan-close" class="icon-button" size="s" aria-label="关闭扫描目录">×</wa-button></div><p class="dialog-description">从这些目录及其子目录发现 EPUB，加载到书架。扫描直接索引原文件，不复制文件，也不会标记为已读。</p><div id="scan-directory-list"></div><wa-button id="scan-add" class="quiet-button" size="s">＋ 添加扫描目录</wa-button><p class="field-hint">扫描目录与导入书库目录分别设置。阅读时是否复制到书库，由“书库设置 → 导入到书库”决定。移除扫描目录不会删除书籍或文件。</p><p class="field-hint">启动直接加载缓存书架；新增文件后请重新扫描。符号链接不会遍历。</p><div id="scan-report" role="status" hidden></div><p id="scan-error" class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><wa-button id="scan-cancel" class="quiet-button" size="s">取消</wa-button><wa-button id="scan-save" class="quiet-button" size="s">仅保存</wa-button><wa-button id="scan-run" class="primary-button" size="s">保存并扫描</wa-button></div></dialog>`,
  );
  const dialog = $<HTMLDialogElement>("#scan-dialog");
  let directories: string[] = [];
  let busy = false;
  let scanning = false;
  const render = () => {
    $<WaButton>("#shelf-refresh").disabled = busy;
    $<WaButton>("#scan-settings").disabled = busy;
    $("#shelf-refresh").textContent = scanning ? "刷新中…" : "↻ 刷新";
    $("#shelf-refresh").setAttribute("aria-busy", String(scanning));
    $("#scan-directory-list").innerHTML = directories.length
      ? directories
          .map(
            (directory, index) =>
              `<div class="scan-directory-row"><span class="directory-path">${esc(directory)}</span><wa-button class="icon-button" size="s" data-remove="${index}" aria-label="移除扫描目录 ${esc(directory)}" title="移除目录" ${busy ? "disabled" : ""}>×</wa-button></div>`,
          )
          .join("")
      : '<p class="field-hint">尚未添加扫描目录</p>';
    for (const id of ["scan-close", "scan-cancel", "scan-save"])
      $<WaButton>(`#${id}`).disabled = busy;
    $<WaButton>("#scan-run").disabled = busy || !directories.length;
    $<WaButton>("#scan-add").disabled = busy || directories.length >= 32;
    $("#scan-run").textContent = busy ? "正在处理…" : "保存并扫描";
  };
  const error = (e: unknown) => {
    $("#scan-error").textContent = String(e);
    $("#scan-error").hidden = false;
  };
  $("#scan-settings").onclick = async () => {
    try {
      directories = await invoke<string[]>("scan_directories");
      $("#scan-report").hidden = true;
      $("#scan-error").hidden = true;
      render();
      dialog.showModal();
    } catch (e) {
      reportError(e);
    }
  };
  $("#scan-directory-list").onclick = (event) => {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-remove]",
    );
    if (!button || busy) return;
    $("#scan-report").hidden = true;
    $("#scan-error").hidden = true;
    directories.splice(Number(button.dataset.remove), 1);
    render();
  };
  $("#scan-add").onclick = async () => {
    $("#scan-report").hidden = true;
    $("#scan-error").hidden = true;
    busy = true;
    render();
    try {
      const selected = await open({
        directory: true,
        multiple: true,
        title: "添加扫描目录",
      });
      const paths =
        typeof selected === "string" ? [selected] : (selected ?? []);
      directories = [...new Set([...directories, ...paths])];
      if (directories.length > 32) {
        directories = directories.slice(0, 32);
        error("最多设置 32 个扫描目录，其余未添加。");
      }
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      render();
    }
  };
  async function save(scan: boolean) {
    if (busy) return;
    busy = true;
    render();
    $("#scan-error").hidden = true;
    $("#scan-report").hidden = true;
    try {
      directories = await invoke<string[]>("set_scan_directories", {
        directories,
      });
      if (!scan) {
        dialog.close();
        return;
      }
      $("#scan-report").hidden = false;
      $("#scan-report").textContent = "正在读取 EPUB 元数据…";
      scanning = true;
      render();
      const result = await invoke<Report>("scan_library");
      await refresh();
      $("#scan-report").innerHTML = reportHTML(result);
    } catch (e) {
      $("#scan-report").hidden = true;
      error(e);
    } finally {
      busy = false;
      scanning = false;
      render();
    }
  }
  $("#shelf-refresh").onclick = async () => {
    if (busy) return;
    busy = true;
    scanning = true;
    render();
    const status = $("#shelf-refresh-report");
    status.hidden = false;
    status.textContent = "正在重新扫描来源目录，更新书架…";
    try {
      const directories = await invoke<string[]>("scan_directories");
      const result = await invoke<Report>("scan_library");
      const view = $("#library-view"),
        scroll = view.scrollTop;
      await refresh();
      view.scrollTop = scroll;
      status.innerHTML = reportHTML(result, "刷新", directories.length === 0);
    } catch (e) {
      status.textContent = `刷新失败：${String(e)}`;
    } finally {
      busy = false;
      scanning = false;
      render();
    }
  };
  $("#scan-save").onclick = () => void save(false);
  $("#scan-run").onclick = () => void save(true);
  for (const id of ["scan-close", "scan-cancel"])
    $(`#${id}`).onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
}
