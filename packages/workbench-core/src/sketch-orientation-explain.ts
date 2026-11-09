import { entityNames } from "./sketch-translate.js";
import type { WorkbenchSketch } from "./types.js";

/**
 * A line that is exactly vertical is turned a quarter turn when it is made Horizontal (sketch-quarter-turn.ts; likewise an exactly horizontal
 * one made Vertical). When the other relations on the line do not leave room for that turn the nearest answer is to squash the line to a
 * point, which is refused as a collapse. This names the real cause and the way out instead of "Line 1 would collapse to a point".
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
      return `${names.get(line.id) ?? line.id} is exactly vertical (from ${line.start[0]}, ${line.start[1]} to ${line.end[0]}, ${line.end[1]}), so Horizontal would need a quarter turn, and the other relations on it leave no room to turn it: the nearest answer squashes the line to a point.`;
    }
    if (constraint.kind === "vertical" && alreadyHorizontal) {
      return `${names.get(line.id) ?? line.id} is exactly horizontal (from ${line.start[0]}, ${line.start[1]} to ${line.end[0]}, ${line.end[1]}), so Vertical would need a quarter turn, and the other relations on it leave no room to turn it: the nearest answer squashes the line to a point.`;
    }
  }
  return undefined;
}

/** What to do about it. */
export const ORIENTATION_RECOVERY = "Relax the relations that hold the line in place (a Fixed end, a joint to fixed geometry, a length or angle), or draw the line at the angle you want, then add the relation.";
