import { createWorkbenchProject, locateDimensionConstraint, type SketchDimensionName, type SketchPointRef, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import { setSketchDimension } from "../../workbench-core/src/sketch-dimension-edit.js";
import { analyzeWorkbenchSketch } from "./index.js";

/**
 * Would a new driving dimension over-constrain the sketch? A dimension the other relations already decide (redundant) or contradict
 * (conflicting) should not be added as a driving one: the person is offered a reference dimension instead, which is measured and never
 * fights the solver. The check runs the same operation the canvas would send, on a copy, and reads the result; it changes nothing.
 *
 * It answers only for a dimension that is new (or is a reference today). Changing the value of a dimension that already drives the
 * sketch is a different case: a value that cannot be met is refused by the operation with the relations that hold the geometry named.
 */
export interface DimensionTrialRequest {
  readonly entityId: string;
  readonly dimension: SketchDimensionName;
  readonly valueMm: number;
  readonly secondEntityId?: string | undefined;
  readonly points?: readonly SketchPointRef[] | undefined;
  readonly expression?: string | undefined;
  readonly driven?: boolean | undefined;
}

export interface DimensionOverConstraint {
  /** `redundant`: the sketch already fixes this measure. `conflict`: the value contradicts what the sketch holds. */
  readonly kind: "redundant" | "conflict";
  /** The solver's own words: which relations already decide, or contradict, the dimension. */
  readonly reason: string;
  /** One sentence for the prompt. */
  readonly message: string;
}

const PROBE = createWorkbenchProject("project:dimension-probe");

export function dimensionOverConstraint(sketch: WorkbenchSketch, request: DimensionTrialRequest): DimensionOverConstraint | undefined {
  // A reference dimension constrains nothing; a parameter expression is evaluated by the project, so it is left to the operation.
  if (request.driven === true || request.expression !== undefined) return undefined;
  const key = { entityId: request.entityId, dimension: request.dimension, ...(request.secondEntityId === undefined ? {} : { secondEntityId: request.secondEntityId }), ...(request.points === undefined ? {} : { points: request.points }) };
  const existing = locateDimensionConstraint(sketch, key);
  if (existing !== undefined && existing.driven !== true) return undefined;
  const project = { ...PROBE, sketch };
  const applied = setSketchDimension(project, { kind: "set-sketch-dimension", operationId: "operation:dimension-probe", expectedRevision: project.revision, ...key, valueMm: request.valueMm });
  if (!applied.ok) {
    const conflict = applied.diagnostics.find((diagnostic) => diagnostic.code === "CONSTRAINT_CONFLICT");
    if (conflict === undefined) return undefined;
    return { kind: "conflict", reason: conflict.message, message: `This dimension would over-constrain the sketch: ${conflict.message}` };
  }
  const after = applied.value.project.sketch;
  const added = locateDimensionConstraint(after, key);
  if (added === undefined) return undefined;
  const overlap = analyzeWorkbenchSketch(after).redundant.find((set) => set.constraintIds.includes(added.id));
  if (overlap === undefined) return undefined;
  return { kind: "redundant", reason: overlap.message, message: `This dimension would over-constrain the sketch: the other relations already decide it. ${overlap.message}` };
}
