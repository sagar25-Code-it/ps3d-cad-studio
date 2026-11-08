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
  /** Tab (or Shift+Tab, `backwards`) while typed-input fields are showing: move the focus into them, starting from the first (or last) field. */
  | { readonly kind: "focus-dynamic"; readonly backwards: boolean }
  /** Enter on the Line tool: end the chain being drawn. The segments already placed are kept; only the open end is dropped. */
  | { readonly kind: "end-chain" };

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

type DrawingTool = Exclude<SketchTool, "select">;

/**
 * Letter keys and the tool variants each one reaches. The first press picks the first tool; pressing the same letter again while one of
 * its tools is active steps to the next variant and wraps around (R: 2-point, centre, 3-point rectangle). The ribbon chips come from
 * this table, so a chip never advertises a key that does nothing.
 */
export const SKETCH_LETTER_FAMILIES: Readonly<Record<string, readonly DrawingTool[]>> = {
  l: ["line"],
  r: ["rectangle", "rectangle-center", "rectangle-three-point"],
  c: ["circle", "circle-two-point", "circle-three-point"],
  a: ["arc", "arc-center", "arc-tangent"],
  e: ["ellipse"]
};

/** The key text for a tool button: "R" for the first variant, "R ×2" when R must be pressed twice, undefined for tools with no key. */
export function sketchToolHotkeyChip(tool: SketchTool): string | undefined {
  if (tool === "select") return "V";
  for (const [letter, family] of Object.entries(SKETCH_LETTER_FAMILIES)) {
    const index = family.indexOf(tool as DrawingTool);
    if (index >= 0) return index === 0 ? letter.toUpperCase() : `${letter.toUpperCase()} ×${index + 1}`;
  }
  return undefined;
}

/** The tool the letter selects now: the next variant when a tool of the same family is already active, else the family's first tool. */
function familyTool(letter: string, active: SketchTool): DrawingTool | undefined {
  const family = SKETCH_LETTER_FAMILIES[letter];
  if (family === undefined) return undefined;
  const index = family.indexOf(active as DrawingTool);
  return family[(index + 1) % family.length];
}

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
  if (key === "Enter") {
    if (context.tool === "line" && context.pendingPoints >= 1) return { kind: "end-chain" };
    return ((context.tool === "spline" || context.tool === "spline-control") && context.pendingPoints >= 3) || (context.tool === "profile" && context.pendingPoints >= 1) ? { kind: "finish" } : undefined;
  }
  if (key === "Tab") return context.dynamicFieldCount > 0 ? { kind: "focus-dynamic", backwards: input.shift } : undefined;
  if (context.dynamicFieldCount > 0 && /^[0-9.,-]$/.test(input.key)) return { kind: "type-value", key: input.key };

  if (input.shift) return undefined;
  const tool = familyTool(key, context.tool);
  if (tool !== undefined) return { kind: "tool", tool };
  if (key === "d") return { kind: "dimension" };
  if (key === "t") return { kind: "edit-tool", tool: "trim" };
  if (key === "o") return { kind: "edit-tool", tool: "offset" };
  if (key === "x") return { kind: "toggle-construction" };
  if (key === "f") return { kind: "fit" };
  if (key === "v") return { kind: "select-tool" };
  if (key === "p") return { kind: "pan-mode" };
  return undefined;
}

/** Human-readable shortcut chips for tool buttons and the help sheet. */
export const SKETCH_HOTKEY_HELP: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: "L", action: "Line" },
  { keys: "R", action: "Rectangle: 2-point; press R again for centre, again for 3-point" },
  { keys: "C", action: "Circle: centre-radius; press C again for 2-point, again for 3-point" },
  { keys: "A", action: "Arc: 3-point; press A again for centerpoint, again for tangent" },
  { keys: "E", action: "Centre ellipse" },
  { keys: "D", action: "Sketch dimension" },
  { keys: "T", action: "Trim" },
  { keys: "O", action: "Offset" },
  { keys: "X", action: "Toggle construction on the selection" },
  { keys: "V", action: "Select tool" },
  { keys: "P", action: "Pan navigation" },
  { keys: "F", action: "Fit the sketch to the window" },
  { keys: "Esc", action: "Backs out one level: a drag, the points being placed, a pick mode, the dimension or edit tool, the drawing tool, then the selection" },
  { keys: "Backspace", action: "Remove the last placed point; with no points pending, delete the selected curves" },
  { keys: "Delete", action: "Drop the points being placed (a line chain keeps its finished segments); with no points pending, delete the selected curves" },
  { keys: "Enter", action: "End a line chain, finish a spline or profile" },
  { keys: "Tab / Shift+Tab", action: "Move into the typed-input fields (first / last field)" },
  { keys: "0-9 . -", action: "While typed-input fields show: start typing the first value" },
  { keys: "Ctrl+A", action: "Select every visible curve" },
  { keys: "Ctrl+C / Ctrl+X / Ctrl+V", action: "Copy, cut and paste the selected curves with their relations" },
  { keys: "Wheel", action: "Zoom at the cursor" },
  { keys: "Middle drag / Space drag", action: "Pan" }
];
