import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
const MIN = 140,
  MAX = 240,
  STEP = 10;
export function initShelfSize() {
  const tools = document.querySelector<HTMLElement>(".shelf-tools")!;
  tools.insertAdjacentHTML(
    "beforeend",
    '<div class="shelf-size" role="group" aria-label="书卡大小"><span>封面</span><wa-button id="shelf-size-down" class="icon-button" size="s" aria-label="缩小书卡" title="缩小书卡">−</wa-button><input id="shelf-size" type="range" min="140" max="240" step="10" aria-label="书卡大小"><wa-button id="shelf-size-up" class="icon-button" size="s" aria-label="放大书卡" title="放大书卡">＋</wa-button><output id="shelf-size-value" for="shelf-size"></output></div>',
  );
  const range = document.querySelector<HTMLInputElement>("#shelf-size")!;
  let value = 160;
  try {
    const saved = localStorage.getItem("leaf.shelf-size");
    if (saved && Number.isFinite(Number(saved)))
      value = Math.round(Number(saved) / STEP) * STEP;
  } catch {
    /* Keep default when browser storage is unavailable. */
  }
  const apply = (next: number) => {
    value = Math.min(MAX, Math.max(MIN, next));
    document.documentElement.style.setProperty(
      "--book-card-width",
      `${value}px`,
    );
    range.value = String(value);
    document.querySelector<HTMLOutputElement>("#shelf-size-value")!.value =
      `${value}`;
    document.querySelector<WaButton>("#shelf-size-down")!.disabled =
      value <= MIN;
    document.querySelector<WaButton>("#shelf-size-up")!.disabled = value >= MAX;
    try {
      localStorage.setItem("leaf.shelf-size", String(value));
    } catch {
      /* Sizing still works without persistent storage. */
    }
  };
  range.oninput = () => apply(Number(range.value));
  document.querySelector<HTMLElement>("#shelf-size-down")!.onclick = () =>
    apply(value - STEP);
  document.querySelector<HTMLElement>("#shelf-size-up")!.onclick = () =>
    apply(value + STEP);
  apply(value);
}
