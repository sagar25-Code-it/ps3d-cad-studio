import type { SketchDimensionName, SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { isSketchDatumEntityId } from "../../workbench-core/src/index.js";

/**
 * The parts of the canvas dimension editor that decide what is shown and what is sent, kept out of the component so they can be tested.
 * A circle is dimensioned by its diameter on the canvas, but the model may hold either a Radius dimension (the stored value is the radius)
 * or a Diameter dimension (the stored value is the diameter); the editor must read and write the one that is there.
 */

/** The driving dimension of a circle, if it has one, and what it stores. */
export interface CircleDimensionFacts {
  readonly constraint: WorkbenchSketchConstraint | undefined;
  /** True when the stored dimension is a Diameter (the stored value is already the diameter). */
  readonly diameterConstraint: boolean;
  /** The diameter the editor starts from, in millimetres: the dimension's if there is one, else the circle's own. */
  readonly diameterMm: number;
}

export function circleDimensionFacts(sketch: Pick<WorkbenchSketch, "constraints">, circle: Extract<SketchEntity, { kind: "circle" }>): CircleDimensionFacts {
  const constraint = sketch.constraints.find((candidate) => candidate.kind === "radius" && candidate.entityIds.length === 1 && candidate.entityIds[0] === circle.id && candidate.valueMm !== undefined && candidate.driven !== true && candidate.suppressed !== true);
  if (constraint === undefined || constraint.valueMm === undefined) return { constraint: undefined, diameterConstraint: false, diameterMm: circle.radiusMm * 2 };
  const diameterConstraint = constraint.dimension === "diameter";
  return { constraint, diameterConstraint, diameterMm: diameterConstraint ? constraint.valueMm : constraint.valueMm * 2 };
}

/** The `set-sketch-dimension` request for a diameter typed into the canvas editor: a Diameter dimension is updated as a diameter, any other as a radius. */
export function circleDimensionRequest(typedDiameterMm: number, diameterConstraint: boolean): { readonly dimension: SketchDimensionName; readonly valueMm: number } {
  return diameterConstraint ? { dimension: "diameter", valueMm: typedDiameterMm } : { dimension: "radius", valueMm: typedDiameterMm / 2 };
}

// ---------------------------------------------------------------------------------------------
// A dimension that needs a Fix relaxed first
// ---------------------------------------------------------------------------------------------

/** The Fixed relations (on the whole curve, not on a single point of it) that stop the named curves from moving. */
function wholeFixes(sketch: Pick<WorkbenchSketch, "constraints">, id: string): readonly WorkbenchSketchConstraint[] {
  return sketch.constraints.filter((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true && constraint.entityIds.includes(id) && (constraint.points === undefined || constraint.points.length === 0));
}

/**
 * The Fixed relations that make a dimension on `entityIds` impossible: every curve the solver could move is pinned, so the dimension would
 * contradict the Fix. Empty when something can still move (an unpinned curve, or a Fix on one point only). The sketch's origin and axes
 * never move, so they count as pinned.
 */
export function fixesBlockingDimension(sketch: Pick<WorkbenchSketch, "constraints">, entityIds: readonly string[]): readonly WorkbenchSketchConstraint[] {
  const movable = entityIds.filter((id) => !isSketchDatumEntityId(id));
  if (movable.length === 0) return [];
  const fixes = movable.map((id) => wholeFixes(sketch, id));
  if (fixes.some((list) => list.length === 0)) return [];
  const seen = new Set<string>();
  return fixes.flat().filter((constraint) => !seen.has(constraint.id) && (seen.add(constraint.id), true));
}
