import { dimensionTargetValue, isDimensionConstraint } from "./sketch-measure.js";
import { describeConstraint, entityNames } from "./sketch-translate.js";
import type { WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * What the status line of a sketch edit says about the driving dimensions it let go of. An edit that rebuilds geometry (a fillet, a trim, a
 * split) can make a dimension meaningless; it is never dropped silently, the summary names it. A dimension that the edit re-expressed on
 * other geometry (the same value added again, for example a length that became a distance to a virtual corner) is not reported as lost.
 */
export function lostDimensionsNote(before: WorkbenchSketch, gone: readonly WorkbenchSketchConstraint[], added: readonly WorkbenchSketchConstraint[], removedEntityIds: ReadonlySet<string>): string {
  const sameValue = (a: WorkbenchSketchConstraint, b: WorkbenchSketchConstraint): boolean => {
    const x = dimensionTargetValue(a);
    const y = dimensionTargetValue(b);
    return x !== undefined && y !== undefined && a.kind === b.kind && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
  };
  const lost = gone.filter((constraint) => {
    if (!isDimensionConstraint(constraint) || constraint.driven === true || constraint.suppressed === true || dimensionTargetValue(constraint) === undefined) return false;
    // A dimension of a curve that was deleted goes with the curve; only a dimension whose curves survive is a surprise.
    if (constraint.entityIds.every((id) => removedEntityIds.has(id))) return false;
    return !added.some((candidate) => isDimensionConstraint(candidate) && sameValue(constraint, candidate));
  });
  if (lost.length === 0) return "";
  const names = entityNames(before);
  const text = lost.slice(0, 3).map((constraint) => describeConstraint(constraint, names));
  return ` Dimensions let go: ${text.join("; ")}${lost.length > 3 ? ` and ${lost.length - 3} more` : ""}.`;
}
