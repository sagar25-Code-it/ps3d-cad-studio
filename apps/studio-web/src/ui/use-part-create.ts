import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import { anotherSurfaceOpen, partCreateWindowKey, type EscapeAppFlags } from "../esc-order.js";
import { probeTouchingIds, touchKey, type PartCreateState } from "../part-create-panel.js";

/**
 * The live parts of the Extrude / Revolve panel that need the window: the background test of which solids the result
 * touches (so the operation can default to Join), the window-level Enter and Esc keys (when focus is on the canvas and not in
 * the panel), and closing the panel when the design or the workspace changes under it. Everything it decides is in
 * part-create-panel.ts and esc-order.ts, which are tested without a window.
 */
interface PartCreateSessionOptions {
  readonly state: PartCreateState | null;
  readonly setState: Dispatch<SetStateAction<PartCreateState | null>>;
  readonly projectRef: MutableRefObject<WorkbenchProject>;
  /** The solids of the design: a change re-runs the touch test. */
  readonly bodies: unknown;
  readonly workspace: string;
  readonly projectId: string;
  /** What else is running when a key is pressed. */
  readonly flags: () => EscapeAppFlags;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}

function isTextField(element: Element | EventTarget | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
}

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id, index) => id === right[index]);

export function usePartCreateSession(options: PartCreateSessionOptions): void {
  const { state, setState, projectRef, bodies, workspace, projectId } = options;
  const live = useRef(options);
  live.current = options;
  const open = state !== null;
  const key = state === null ? "" : touchKey(state);

  // Which solids would the result touch? A throwaway build a moment after the last change; the result only proposes the operation.
  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    const timer = window.setTimeout(() => {
      const snapshot = live.current.state;
      if (snapshot === null) return;
      probeTouchingIds(snapshot, projectRef.current)
        .then((ids) => { if (current) setState((now) => (now !== null && touchKey(now) === touchKey(snapshot) && !sameIds(now.touchingIds, ids) ? { ...now, touchingIds: ids } : now)); })
        .catch(() => undefined);
    }, 160);
    return () => { current = false; window.clearTimeout(timer); };
  }, [open, key, bodies]);

  // A panel for another workspace or another design would build on the wrong thing: it closes.
  const lastProject = useRef(projectId);
  useEffect(() => { if (workspace !== "part" && live.current.state !== null) live.current.setState(null); }, [workspace]);
  useEffect(() => {
    if (lastProject.current === projectId) return;
    lastProject.current = projectId;
    if (live.current.state !== null) live.current.setState(null);
  }, [projectId]);

  // Enter commits and Esc cancels when focus is outside the panel (after a click on the canvas). Focus inside the panel is the
  // panel's own handler, which stops the event; Esc is read in the capture phase so a lower handler cannot swallow it.
  useEffect(() => {
    if (!open) return undefined;
    const contextOf = (event: KeyboardEvent) => {
      const focused = globalThis.document.activeElement;
      const inPanel = focused instanceof Element && focused.closest(".command-panel") !== null;
      return { ...live.current.flags(), partCreateOpen: true, editPanelOpen: false, otherSurfaceOpen: anotherSurfaceOpen(globalThis.document), foreignTextFieldFocused: isTextField(focused) && !inPanel && event.key === "Escape" };
    };
    const onEnter = (event: KeyboardEvent): void => {
      if (event.key !== "Enter") return;
      if (partCreateWindowKey("Enter", { context: contextOf(event), editableTarget: isTextField(event.target) || event.target instanceof HTMLButtonElement }) !== "commit") return;
      event.preventDefault();
      live.current.onCommit();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (partCreateWindowKey("Escape", { context: contextOf(event), editableTarget: false }) !== "cancel") return;
      event.preventDefault();
      live.current.onCancel();
    };
    window.addEventListener("keydown", onEnter);
    window.addEventListener("keydown", onEscape, true);
    return () => { window.removeEventListener("keydown", onEnter); window.removeEventListener("keydown", onEscape, true); };
  }, [open]);
}
