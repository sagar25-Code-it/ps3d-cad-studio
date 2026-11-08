import type { SketchTool } from "./index.js";

/**
 * Pure keyboard model for the sketch canvas. The workspace feeds it a key and the current interaction state and gets back
 * one action (or nothing, which lets the key fall through to the rest of the app: undo, save, command search).
 *
 * Letter keys follow Fusion's sketch habits: L line, R rectangle, C circle, A arc, D dimension, T trim, O offset.
 */
export type SketchHotkeyAction =
  | { readonly kind: "tool"; readonly tool: Exclude<SketchTool, "select"> }
  | { readonly kind: "dimension" }
  | { readonly kind: "edit-tool"; readonly tool: "trim" | "offset" }
  | { readonly kind: "toggle-construction" }
  /** Q: everything drawn from now on is construction geometry (or back). */
  | { readonly kind: "toggle-draw-construction" }
  | { readonly kind: "fit" }
  | { readonly kind: "pan-mode" }
  | { readonly kind: "select-tool" }
  | { readonly kind: "cancel-points" }
  | { readonly kind: "undo-point" }
  | { readonly kind: "cancel-drag" }
  | { readonly kind: "exit-pick" }
  | { readonly kind: "exit-dimension" }
  | { readonly kind: "exit-edit-tool" }
  | { readonly kind: "clear-selection" }
  | { readonly kind: "delete-selection" }
  | { readonly kind: "finish" }
  | { readonly kind: "select-all" }
  /** Ctrl/Cmd+C, X and V: the sketch clipboard. Copy and cut need a curve selection; paste is always offered and says if the clipboard is empty. */
  | { readonly kind: "copy" }
  | { readonly kind: "cut" }
  | { readonly kind: "paste" }
  /** A digit, point or minus pressed while typed-input fields are showing: start typing into the first field. */
  | { readonly kind: "type-value"; readonly key: string }
  /** Tab while typed-input fields are showing: move the focus into them. */
  | { readonly kind: "focus-dynamic" };

export interface SketchHotkeyInput {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface SketchHotkeyContext {
  readonly tool: SketchTool;
  readonly pendingPoints: number;
  /** Everything selected: curves and shaded profiles. Escape clears all of it. */
  readonly selectionCount: number;
  /** Selected curves only: Delete and Backspace remove curves, never a profile. */
  readonly curveSelectionCount: number;
  readonly dimensionMode: boolean;
  readonly editToolActive: boolean;
  /** Picking the points of a Coincident or Midpoint relation on the canvas. */
  readonly pickingRelation: boolean;
  /** A curve or point is being dragged. Escape abandons the drag and puts everything back. */
  readonly dragging: boolean;
  /** How many typed-input fields (length, angle, width...) the canvas is showing next to the cursor. */
  readonly dynamicFieldCount: number;
}

const LETTER_TOOLS: Readonly<Record<string, Exclude<SketchTool, "select">>> = {
  l: "line",
  r: "rectangle",
  c: "circle",
  a: "arc"
};

export function resolveSketchHotkey(input: SketchHotkeyInput, context: SketchHotkeyContext): SketchHotkeyAction | undefined {
  if (input.alt) return undefined;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (input.ctrl || input.meta) {
    if (input.shift) return undefined;
    if (key === "a") return { kind: "select-all" };
    if (key === "c" && context.curveSelectionCount > 0) return { kind: "copy" };
    if (key === "x" && context.curveSelectionCount > 0) return { kind: "cut" };
    if (key === "v" && context.pendingPoints === 0) return { kind: "paste" };
    return undefined;
  }

  if (key === "Escape") {
    // Escape backs out one level at a time: a drag in progress, points being placed, then a pick mode, a dimension or edit tool, then the drawing tool, then the selection.
    if (context.dragging) return { kind: "cancel-drag" };
    if (context.pendingPoints > 0) return { kind: "cancel-points" };
    if (context.pickingRelation) return { kind: "exit-pick" };
    if (context.dimensionMode) return { kind: "exit-dimension" };
    if (context.editToolActive) return { kind: "exit-edit-tool" };
    if (context.tool !== "select") return { kind: "select-tool" };
    if (context.selectionCount > 0) return { kind: "clear-selection" };
    return undefined;
  }
  if (key === "Backspace") {
    if (context.pendingPoints > 0) return { kind: "undo-point" };
    return context.curveSelectionCount > 0 ? { kind: "delete-selection" } : undefined;
  }
  if (key === "Delete") {
    if (context.pendingPoints > 0) return { kind: "cancel-points" };
    return context.curveSelectionCount > 0 ? { kind: "delete-selection" } : undefined;
  }
  if (key === "Enter") return ((context.tool === "spline" || context.tool === "spline-control") && context.pendingPoints >= 3) || (context.tool === "profile" && context.pendingPoints >= 1) ? { kind: "finish" } : undefined;
  if (key === "Tab") return context.dynamicFieldCount > 0 && !input.shift ? { kind: "focus-dynamic" } : undefined;
  if (context.dynamicFieldCount > 0 && /^[0-9.,-]$/.test(input.key)) return { kind: "type-value", key: input.key };

  if (input.shift) return undefined;
  const tool = LETTER_TOOLS[key];
  if (tool !== undefined) return { kind: "tool", tool };
  if (key === "d") return { kind: "dimension" };
  if (key === "t") return { kind: "edit-tool", tool: "trim" };
  if (key === "o") return { kind: "edit-tool", tool: "offset" };
  if (key === "x") return { kind: "toggle-construction" };
  if (key === "q") return { kind: "toggle-draw-construction" };
  if (key === "f") return { kind: "fit" };
  if (key === "v") return { kind: "select-tool" };
  if (key === "p") return { kind: "pan-mode" };
  return undefined;
}

/** Human-readable shortcut chips for tool buttons and the help sheet. */
export const SKETCH_HOTKEY_HELP: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: "L", action: "Line" },
  { keys: "R", action: "2-point rectangle" },
  { keys: "C", action: "Center-radius circle" },
  { keys: "A", action: "3-point arc" },
  { keys: "D", action: "Sketch dimension" },
  { keys: "T", action: "Trim" },
  { keys: "O", action: "Offset" },
  { keys: "X", action: "Toggle construction on the selection" },
  { keys: "Q", action: "Draw as construction: new curves are construction geometry (toggle)" },
  { keys: "V", action: "Select tool" },
  { keys: "P", action: "Pan navigation" },
  { keys: "F", action: "Fit the sketch to the window" },
  { keys: "Esc", action: "Cancel points, then tool, then selection" },
  { keys: "Backspace", action: "Remove the last placed point" },
  { keys: "Delete", action: "Delete the selected curves" },
  { keys: "Enter", action: "Finish a spline" },
  { keys: "Ctrl+A", action: "Select every visible curve" },
  { keys: "Ctrl+C / Ctrl+X / Ctrl+V", action: "Copy, cut and paste the selected curves with their relations" },
  { keys: "Wheel", action: "Zoom at the cursor" },
  { keys: "Middle drag / Space drag", action: "Pan" }
];
