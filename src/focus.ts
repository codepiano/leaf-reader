// WebKit can keep :focus-visible after pointer-driven dialog focus transfers.
// Track the input method so button rings remain a keyboard affordance.
export function initFocus() {
  const root = document.documentElement;
  root.dataset.focusInput = "pointer";
  document.addEventListener(
    "pointerdown",
    () => {
      root.dataset.focusInput = "pointer";
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
        root.dataset.focusInput = "keyboard";
      }
    },
    true,
  );
}

export function showDialog(dialog: HTMLDialogElement) {
  if (dialog.open) return;
  dialog.showModal();
  const heading = dialog.querySelector<HTMLElement>("h2");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}
