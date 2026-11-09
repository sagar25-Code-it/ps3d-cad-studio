import { sketchPatternInstanceOf, type SketchEntity, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import type { SketchEditPlan } from "./edit-tools.js";

/**
 * The copies of an associative pattern are generated from its source curves and are re-made after every operation, so an edit that
 * changes a copy in place (a fillet, a trim, a move, a split) cannot stick: the copy would be reset to follow the pattern while the
 * curves the edit added next to it stay behind, unsolved. Such an edit is refused with the way out, instead of reported as done.
 */
export function patternCopyProblem(sketch: WorkbenchSketch, plan: SketchEditPlan, nameOf: (id: string) => string): string | undefined {
  const patterns = sketch.patterns ?? [];
  if (patterns.length === 0 || plan.updateEntities.length === 0) return undefined;
  const planned = new Set([...(plan.objects?.patterns ?? []).map((pattern) => pattern.id), ...(plan.objects?.removeObjectIds ?? [])]);
  const updated = new Set(plan.updateEntities.map((entity: SketchEntity) => entity.id));
  for (const pattern of patterns) {
    if (planned.has(pattern.id)) continue;
    const copies = plan.updateEntities.filter((entity) => sketchPatternInstanceOf(pattern.id, entity.id) !== undefined);
    if (copies.length === 0) continue;
    // Moving the sources together with their copies is fine: the copies are re-made from the moved sources.
    if (pattern.sourceIds.every((id) => updated.has(id))) continue;
    const names = copies.slice(0, 3).map((entity) => nameOf(entity.id)).join(", ");
    return `${copies.length === 1 ? `${names} is a copy` : `${names}${copies.length > 3 ? ` and ${copies.length - 3} more` : ""} are copies`} in a pattern, so ${copies.length === 1 ? "it follows" : "they follow"} the source curves. Edit the source curves, or dissolve the pattern first to edit the copies on their own.`;
  }
  return undefined;
}
