import type { WorkbenchSketchConstraint } from "./types.js";

/**
 * Where a dimension's text was dragged to is part of the sketch: the stand-off of its dimension line from the geometry, in screen
 * pixels (so it reads the same at every zoom), stored on the dimension as `labelOffsetPx`. A dimension without it stands at the
 * default distance and is stacked clear of its neighbours, as every dimension was before the position was saved with the design.
 */
export const MIN_LABEL_OFFSET_PX = 12;
export const MAX_LABEL_OFFSET_PX = 400;

const DIMENSION_KINDS: ReadonlySet<string> = new Set(["radius", "distance", "angle", "arc-length", "perimeter"]);

/** True for a stand-off the canvas can draw: a finite number of pixels inside the supported range. */
export function validLabelOffsetPx(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_LABEL_OFFSET_PX && value <= MAX_LABEL_OFFSET_PX;
}

/** True for a constraint that is drawn with dimension text (a relation such as Parallel has a glyph, not a label). */
export function hasDimensionLabel(constraint: Pick<WorkbenchSketchConstraint, "kind">): boolean {
  return DIMENSION_KINDS.has(constraint.kind);
}

/** The stand-off as it is stored: to a tenth of a pixel, which is finer than anyone can place a label. */
export function storedLabelOffsetPx(offsetPx: number): number {
  return Math.round(Math.min(MAX_LABEL_OFFSET_PX, Math.max(MIN_LABEL_OFFSET_PX, offsetPx)) * 10) / 10;
}

/** The dragged label positions saved with the sketch, by dimension id. */
export function savedLabelOffsets(constraints: readonly WorkbenchSketchConstraint[]): Readonly<Record<string, number>> {
  const offsets: Record<string, number> = {};
  for (const constraint of constraints) if (constraint.labelOffsetPx !== undefined && hasDimensionLabel(constraint)) offsets[constraint.id] = constraint.labelOffsetPx;
  return offsets;
}

/**
 * The label positions to draw with: the ones saved with the sketch, and for a dimension that has none the position this browser
 * remembered before positions were saved with the design. Returns `local` itself when the sketch saves none, so nothing re-renders.
 */
export function mergedLabelOffsets(constraints: readonly WorkbenchSketchConstraint[], local: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const saved = savedLabelOffsets(constraints);
  return Object.keys(saved).length === 0 ? local : { ...local, ...saved };
}
