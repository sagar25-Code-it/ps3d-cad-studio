import { useEffect, useState } from "react";
import { NO_MODIFIERS, type SnapModifiers } from "../../../../../packages/workbench-sketch/src/snap-assist.js";

/**
 * Whether Ctrl (or Cmd) and Shift are held right now, so the canvas can switch snapping off or constrain the point while the
 * key is down, even when the pointer is not moving. Losing the window focus counts as releasing both.
 */
export function useModifierKeys(enabled: boolean): SnapModifiers {
  const [modifiers, setModifiers] = useState<SnapModifiers>(NO_MODIFIERS);
  useEffect(() => {
    if (!enabled) { setModifiers(NO_MODIFIERS); return undefined; }
    const update = (event: KeyboardEvent): void => {
      const next: SnapModifiers = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey };
      setModifiers((current) => current.ctrl === next.ctrl && current.shift === next.shift ? current : next);
    };
    const clear = (): void => setModifiers(NO_MODIFIERS);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, [enabled]);
  return modifiers;
}
