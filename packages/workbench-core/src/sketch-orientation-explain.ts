import { entityNames } from "./sketch-translate.js";
import type { WorkbenchSketch } from "./types.js";

/**
 * A line that is exactly vertical cannot be made Horizontal by the solver (and an exactly horizontal one cannot be made Vertical): the
 * nearest answer that satisfies the relation is to squash the line to a point, which is refused as a collapse, and the user was told
 * only that "Line 1 would collapse to a point" with the relation list. This names the real cause and the way out.
 */
const EXACT = 1e-6;


/** A sentence for a failed solve when it is an orientation relation on a line already turned the other way; undefined when it is not. */
export function explainOrientationCollapse(sketch: WorkbenchSketch, relatedIds: readonly string[]): string | undefined {
  const names = entityNames(sketch);
  for (const constraint of sketch.constraints) {
    if (constraint.suppressed === true || (constraint.kind !== "horizontal" && constraint.kind !== "vertical")) continue;
    if (!relatedIds.includes(constraint.id) || constraint.entityIds.length !== 1) continue;
    const line = sketch.entities.find((entity) => entity.id === constraint.entityIds[0]);
    if (line === undefined || line.kind !== "line") continue;
    // Horizontal and Vertical on the same line contradict each other: that conflict is named by the solver, with both relations.
    const opposite = constraint.kind === "horizontal" ? "vertical" : "horizontal";
    if (sketch.constraints.some((other) => other.suppressed !== true && other.kind === opposite && other.entityIds.includes(line.id))) continue;
    const dx = line.end[0] - line.start[0];
    const dy = line.end[1] - line.start[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const alreadyVertical = Math.abs(dx) <= EXACT * Math.max(1, length);
    const alreadyHorizontal = Math.abs(dy) <= EXACT * Math.max(1, length);
    if (constraint.kind === "horizontal" && alreadyVertical) {
      return `${names.get(line.id) ?? line.id} is exactly vertical (from ${line.start[0]}, ${line.start[1]} to ${line.end[0]}, ${line.end[1]}), so Horizontal would need a quarter turn, which the solver does not do: the nearest answer it finds squashes the line to a point.`;
    }
    if (constraint.kind === "vertical" && alreadyHorizontal) {
      return `${names.get(line.id) ?? line.id} is exactly horizontal (from ${line.start[0]}, ${line.start[1]} to ${line.end[0]}, ${line.end[1]}), so Vertical would need a quarter turn, which the solver does not do: the nearest answer it finds squashes the line to a point.`;
    }
  }
  return undefined;
}

/** What to do about it. */
export const ORIENTATION_RECOVERY = "Turn the line away from the axis first (or draw it at the angle you want), then add the relation; or use Perpendicular or an angle dimension for a quarter turn.";
