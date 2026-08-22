import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** Keyboard isolation and opener restoration for the application's modal surfaces. */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const returnFocus = globalThis.document.activeElement instanceof HTMLElement && globalThis.document.activeElement !== globalThis.document.body ? globalThis.document.activeElement : null;
    const controls = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? controls()[0] ?? dialog;
    queueMicrotask(() => initial.focus());

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = controls();
      if (focusable.length === 0) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first.focus(); }
    };

    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      queueMicrotask(() => {
        if (globalThis.document.querySelector('[role="dialog"]') !== null) return;
        const fallback = globalThis.document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? globalThis.document.querySelector<HTMLElement>(".project-button");
        if (returnFocus?.isConnected) returnFocus.focus();
        else fallback?.focus();
      });
    };
  }, [open]);

  return dialogRef;
}
