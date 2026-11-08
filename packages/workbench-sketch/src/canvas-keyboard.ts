import type { SketchEntity } from "../../workbench-core/src/index.js";

/**
 * Keyboard and touch access to the sketch canvas (audit Sketch edit E28). The canvas takes the keyboard focus; arrow keys walk
 * through the visible curves in drawing order, Enter or Space selects the focused one (with Shift it adds to the selection),
 * Home and End jump to the first and last. The text that describes the focused curve is what a screen reader announces.
 * Handle and glyph sizes grow on touch screens, where a finger covers far more than a mouse pointer.
 */
export type CanvasKeyAction =
  | { readonly kind: "focus-next" }
  | { readonly kind: "focus-previous" }
  | { readonly kind: "focus-first" }
  | { readonly kind: "focus-last" }
  | { readonly kind: "select-focused"; readonly additive: boolean };

export interface CanvasKeyInput {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** Maps a key pressed while the canvas itself has the focus. Anything else falls through to the sketch hotkeys. */
export function resolveCanvasKey(input: CanvasKeyInput): CanvasKeyAction | undefined {
  if (input.ctrl || input.meta || input.alt) return undefined;
  switch (input.key) {
    case "ArrowRight":
    case "ArrowDown": return { kind: "focus-next" };
    case "ArrowLeft":
    case "ArrowUp": return { kind: "focus-previous" };
    case "Home": return { kind: "focus-first" };
    case "End": return { kind: "focus-last" };
    case "Enter":
    case " ": return { kind: "select-focused", additive: input.shift };
    default: return undefined;
  }
}

/** The curve that takes the focus after `action`, wrapping at the ends. With nothing focused, next is the first and previous the last. */
export function focusAfter(entities: readonly SketchEntity[], focusedId: string | null, action: CanvasKeyAction): string | null {
  const order = entities.filter((entity) => entity.visible !== false);
  if (order.length === 0) return null;
  if (action.kind === "focus-first") return order[0]!.id;
  if (action.kind === "focus-last") return order[order.length - 1]!.id;
  if (action.kind === "select-focused") return focusedId;
  const index = order.findIndex((entity) => entity.id === focusedId);
  if (index < 0) return action.kind === "focus-next" ? order[0]!.id : order[order.length - 1]!.id;
  const step = action.kind === "focus-next" ? 1 : order.length - 1;
  return order[(index + step) % order.length]!.id;
}

const n = (value: number): string => String(Number(value.toFixed(2)));

/** "Line 3 of 12, length 25 mm, from 0, 0 to 25, 0", spoken when a curve takes the keyboard focus. */
export function describeEntityForAccessibility(entity: SketchEntity, label: string, position: number, total: number, selected: boolean): string {
  const lead = `${label}, ${position} of ${total}`;
  let detail = "";
  if (entity.kind === "line") detail = `length ${n(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))} millimetres, from ${n(entity.start[0])}, ${n(entity.start[1])} to ${n(entity.end[0])}, ${n(entity.end[1])}`;
  else if (entity.kind === "circle") detail = `radius ${n(entity.radiusMm)} millimetres, centre ${n(entity.center[0])}, ${n(entity.center[1])}`;
  else if (entity.kind === "rectangle") detail = `${n(entity.widthMm)} by ${n(entity.heightMm)} millimetres, centre ${n(entity.center[0])}, ${n(entity.center[1])}`;
  else if (entity.kind === "ellipse") detail = `radii ${n(entity.majorRadiusMm)} and ${n(entity.minorRadiusMm)} millimetres, centre ${n(entity.center[0])}, ${n(entity.center[1])}`;
  else if (entity.kind === "arc") detail = `from ${n(entity.start[0])}, ${n(entity.start[1])} to ${n(entity.end[0])}, ${n(entity.end[1])}`;
  else if (entity.kind === "point") detail = `at ${n(entity.point[0])}, ${n(entity.point[1])}`;
  else detail = `${entity.fitPoints.length} fit points`;
  return `${lead}, ${detail}${entity.construction ? ", construction" : ""}${selected ? ", selected" : ""}`;
}

export interface CanvasHitSizes {
  /** Drawn radius of a drag handle, in screen pixels. */
  readonly grabHandlePx: number;
  /** Invisible hit radius of a drag handle, so the target is larger than the dot. */
  readonly grabHitPx: number;
  readonly dimensionPointPx: number;
  readonly relationPointPx: number;
  /** Radius of a relation glyph's disc. */
  readonly glyphPx: number;
  /** How far from a curve a press still counts as on it. */
  readonly pickPx: number;
}

/** Mouse targets are small and precise; touch targets are at least 44 px across, the usual minimum for a finger. */
export function canvasHitSizes(coarsePointer: boolean): CanvasHitSizes {
  return coarsePointer
    ? { grabHandlePx: 9, grabHitPx: 22, dimensionPointPx: 11, relationPointPx: 14, glyphPx: 12, pickPx: 16 }
    : { grabHandlePx: 6, grabHitPx: 11, dimensionPointPx: 7, relationPointPx: 8, glyphPx: 8, pickPx: 10 };
}
