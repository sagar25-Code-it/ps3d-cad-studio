import { constraintFit } from "./constraint-fit.js";
import { entityKindOf } from "./sketch-translate.js";
import type { WorkbenchProject, WorkbenchResult, WorkbenchSketchConstraint } from "./types.js";
import { isSketchDatumEntityId } from "./types.js";
import { failure } from "./validation.js";

const INVALID_RECOVERY = "Pick curves the relation applies to (the Constrain buttons show why one is unavailable).";
const DIMENSION_KINDS: readonly WorkbenchSketchConstraint["kind"][] = ["radius", "distance", "angle", "arc-length", "perimeter"];

/**
 * Refuses a constraint that cannot mean anything, using the same rule table the Constrain buttons use: a horizontal circle, a radius on a
 * line, a distance of two circles, a line parallel to itself, a dimension with no value, a pierce onto an axis that does not exist.
 * Returns undefined when the constraint is acceptable.
 */
export function checkNewConstraint(project: WorkbenchProject, constraint: WorkbenchSketchConstraint): WorkbenchResult<never> | undefined {
  const sketch = project.sketch;
  const kinds = constraint.entityIds.map((id) => entityKindOf(sketch, id));
  const missing = constraint.entityIds.find((_, index) => kinds[index] === undefined);
  if (missing !== undefined) return failure("BROKEN_REFERENCE", "A sketch constraint references an entity that does not exist.", [missing], "Refresh the project and select existing entities.");
  const fit = constraintFit(constraint.kind, kinds, constraint.points, { driven: constraint.driven === true, ...(constraint.dimension === undefined ? {} : { dimension: constraint.dimension }) });
  if (!fit.ok) return failure("INVALID_OPERATION", fit.reason, constraint.entityIds.filter((id) => !isSketchDatumEntityId(id)), INVALID_RECOVERY);
  const distinct = new Set(constraint.entityIds);
  const mayRepeat = constraint.kind === "coincident" || constraint.kind === "midpoint" || constraint.kind === "perimeter" || constraint.kind === "fixed" || constraint.kind === "distance";
  if (distinct.size !== constraint.entityIds.length && !mayRepeat) {
    return failure("INVALID_OPERATION", `${/^[aeiou]/u.test(constraint.kind) ? "An" : "A"} ${constraint.kind} constraint relates two different curves, but the same one was picked twice.`, [...distinct], INVALID_RECOVERY);
  }
  if (constraint.kind === "coincident" && constraint.entityIds[0] === constraint.entityIds[1] && constraint.points?.[0] === constraint.points?.[1]) {
    return failure("INVALID_OPERATION", "A point cannot be made coincident with itself.", [...distinct], INVALID_RECOVERY);
  }
  if (DIMENSION_KINDS.includes(constraint.kind) && constraint.driven !== true) {
    const value = constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
    if (value === undefined) return failure("INVALID_OPERATION", "A driving dimension needs a value; give it one, or make it a reference (driven) dimension.", [constraint.id], INVALID_RECOVERY);
  }
  if (constraint.kind === "pierce" && constraint.pierce !== undefined) {
    const reference = constraint.pierce;
    const exists = reference.kind === "axis"
      ? (project.part.constructionAxes ?? []).some((axis) => axis.id === reference.axisId)
      : (project.part.generalBodies ?? []).some((body) => body.id === reference.bodyId);
    if (!exists) return failure("BROKEN_REFERENCE", reference.kind === "axis" ? `The pierce axis ${reference.axisId} does not exist.` : `The pierce body ${reference.bodyId} does not exist.`, [constraint.id], "Choose an existing construction axis or body.");
  }
  return undefined;
}
