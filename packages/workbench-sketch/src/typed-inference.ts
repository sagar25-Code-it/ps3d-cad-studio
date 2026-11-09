import type { Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { inferSketchPoint, type InferenceGuide, type InferenceResult } from "./inference.js";

/**
 * A point that was typed into the dynamic-input fields (a length and an angle, or #x,y) is placed exactly where it was typed, but it
 * means the same thing a clicked point means when it lands on geometry: on an endpoint, a centre, the origin, a midpoint or a curve it
 * must be joined to it. Without this, a keyboard-drawn outline was a pile of lines that only looked closed, and its first edit tore it open.
 */

/** How close a typed point has to be to a named point of the sketch to count as being on it (millimetres): exact input, with room for the float dust of unit conversion. */
export const TYPED_SNAP_MM = 1e-4;

const sameGuide = (a: InferenceGuide, b: InferenceGuide): boolean => a.kind === b.kind && Math.hypot(a.from[0] - b.from[0], a.from[1] - b.from[1]) < 1e-9;

/**
 * What a typed point landed on. The point itself is the typed one unless it is on a named point (endpoint, centre, origin, midpoint,
 * quadrant, crossing), in which case it is that point exactly. `guides` are the typed angle's own guides plus the alignments that hold exactly.
 */
export function inferTypedPoint(point: Vec2, sketch: WorkbenchSketch, anchor: Vec2 | undefined, typedGuides: readonly InferenceGuide[] = []): InferenceResult {
  const found = inferSketchPoint(point, sketch, { toleranceMm: TYPED_SNAP_MM, ...(anchor === undefined ? {} : { anchor, anchorUse: "align" as const }), relations: {} });
  const primary = found.primary;
  // Only what the typed point is exactly on counts; a grid or alignment pull would move a point the user typed to the micron.
  const exact = primary !== undefined && primary.kind !== "grid" && primary.kind !== "horizontal" && primary.kind !== "vertical" && primary.kind !== "polar";
  const guides = [...typedGuides];
  for (const guide of found.guides) if (!guides.some((existing) => sameGuide(existing, guide))) guides.push(guide);
  const snapped = exact || guides.length > 0;
  return {
    point: exact ? primary.point : point,
    snapped,
    ...(exact ? { primary } : {}),
    guides
  };
}
