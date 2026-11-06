import { useEffect, useRef } from "react";
import { resolveSketchHotkey, type SketchHotkeyAction, type SketchHotkeyContext } from "../../../../../packages/workbench-sketch/src/hotkeys.js";

interface SketchHotkeyOptions {
  readonly enabled: boolean;
  readonly context: SketchHotkeyContext;
  readonly onAction: (action: SketchHotkeyAction) => void;
}

function shouldIgnore(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  // A modal dialog, an open menu or the command palette owns the keyboard until it closes.
  return globalThis.document.querySelector('[role="dialog"], [role="menu"]') !== null;
}

/**
 * One window-level key listener for the sketch canvas. It runs in the capture phase and stops the keys it handles, so the
 * app-level shortcuts (which would, for example, switch to Orbit on O) never see them. Anything it does not recognise,
 * such as Ctrl+Z or Ctrl+S, falls through untouched.
 */
export function useSketchHotkeys(options: SketchHotkeyOptions): void {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const current = latest.current;
      if (!current.enabled || event.repeat || shouldIgnore(event.target)) return;
      const action = resolveSketchHotkey({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }, current.context);
      if (action === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      current.onAction(action);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
}
