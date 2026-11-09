import { designOf } from "./design.js";
import type { WorkbenchProject, WorkbenchResult } from "./types.js";
import { failure } from "./validation.js";

/**
 * The refusal for a curve the working sketch does not hold. When the curve belongs to a finished sketch in the timeline (an agent or a
 * script is addressing the committed sketch directly), the message says so and names the way in: reopen that sketch first.
 */
export function missingSketchEntityFailure(project: WorkbenchProject, id: string, message: string): WorkbenchResult<never> {
  const owner = designOf(project).features.find((feature) => feature.kind === "sketch" && feature.sketch.entities.some((entity) => entity.id === id));
  const base = message.endsWith(".") ? message.slice(0, -1) : message;
  if (owner !== undefined) {
    return failure("BROKEN_REFERENCE", `${base} (${id}) in the working sketch: it belongs to the finished sketch "${owner.name}" (${owner.id}).`, [id, owner.id], `Reopen that sketch with edit-design-sketch (featureId ${owner.id}), make the change, then commit-design-sketch.`);
  }
  return failure("BROKEN_REFERENCE", `${base} (${id}).`, [id], "Refresh the project and select an existing stable ID.");
}
