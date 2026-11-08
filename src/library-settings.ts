import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";

type Settings = { directory: string | null; import_enabled: boolean };
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

export function initLibrarySettings(reportError: (error: unknown) => void) {
  document
    .querySelector(".sidebar-bottom")!
    .insertAdjacentHTML(
      "afterbegin",
      '<wa-button id="library-settings" class="quiet-button" size="s">书库设置</wa-button>',
    );
  document.body.insertAdjacentHTML(
    "beforeend",
    `<dialog id="library-settings-dialog" class="app-dialog"><div class="dialog-heading"><div><div class="eyebrow">本地书库</div><h2>书库设置</h2></div><wa-button id="library-settings-close" class="icon-button" size="s" aria-label="关闭书库设置">×</wa-button></div><p class="dialog-description">默认直接读取原文件。开启导入后，新打开或拖入的 EPUB 会复制到指定目录，并从副本阅读；原文件保持不变。</p><label class="check-label"><input id="library-import-enabled" type="checkbox">导入到书库</label><div class="form-field library-directory-field"><span>书库目录</span><p id="library-directory" class="directory-path"></p><div class="directory-actions"><wa-button id="library-directory-choose" class="quiet-button" size="s">选择目录</wa-button><wa-button id="library-directory-clear" class="quiet-button" size="s">清除目录</wa-button></div></div><p class="field-hint">设置目录不会扫描现有文件或搬迁书架。关闭导入后，已导入的书仍可阅读；书架中的书不会重复复制。</p><p id="library-settings-error" class="dialog-error" role="alert" hidden></p><div class="dialog-actions"><wa-button id="library-settings-cancel" class="quiet-button" size="s">取消</wa-button><wa-button id="library-settings-save" class="primary-button" size="s">保存</wa-button></div></dialog>`,
  );
  const dialog = $<HTMLDialogElement>("#library-settings-dialog");
  const checkbox = $<HTMLInputElement>("#library-import-enabled");
  let directory: string | null = null;
  let busy = false;
  const error = (e: unknown) => {
    $("#library-settings-error").hidden = false;
    $("#library-settings-error").textContent = String(e);
  };
  const render = () => {
    $("#library-directory").textContent = directory || "尚未设置目录";
    $<WaButton>("#library-settings-save").disabled =
      busy || (checkbox.checked && !directory);
    $<WaButton>("#library-directory-clear").disabled = busy || !directory;
    for (const id of [
      "library-directory-choose",
      "library-settings-close",
      "library-settings-cancel",
    ])
      $<WaButton>(`#${id}`).disabled = busy;
    checkbox.disabled = busy;
  };
  $("#library-settings").onclick = async () => {
    try {
      const settings = await invoke<Settings>("library_settings");
      directory = settings.directory;
      checkbox.checked = settings.import_enabled;
      $("#library-settings-error").hidden = true;
      render();
      dialog.showModal();
    } catch (e) {
      reportError(e);
    }
  };
  checkbox.onchange = render;
  $("#library-directory-choose").onclick = async () => {
    busy = true;
    render();
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择书库目录",
        ...(directory ? { defaultPath: directory } : {}),
      });
      if (typeof selected === "string") directory = selected;
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      render();
    }
  };
  $("#library-directory-clear").onclick = () => {
    directory = null;
    checkbox.checked = false;
    render();
  };
  for (const id of ["library-settings-close", "library-settings-cancel"])
    $(`#${id}`).onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  $("#library-settings-save").onclick = async () => {
    busy = true;
    render();
    $("#library-settings-error").hidden = true;
    try {
      await invoke("set_library_settings", {
        directory,
        importEnabled: checkbox.checked,
      });
      dialog.close();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      render();
    }
  };
}
