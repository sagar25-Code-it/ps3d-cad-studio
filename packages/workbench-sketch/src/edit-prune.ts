import type { SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { analyzeLiveSketch } from "../../workbench-core/src/sketch-analysis.js";
import { applyPlanToSketch } from "./sketch-clone.js";
import type { SketchEditPlan } from "./edit-tools.js";

/**
 * Edits that add several relations at once (a mirror, a pattern, a split, an offset) can add a relation that the others already imply: a
 * copy keeps its own joint although its symmetry to the source fixes it, a split half is collinear with a piece it is already joined to.
 * The sketch still solves, but the Repair panel then lists "Over-defined" warnings after perfectly normal edits, and a later dimension
 * edit on the source can turn the redundancy into a conflict. This removes, from the plan's own additions only, the relations the solver's
 * rank analysis reports as implied. Relations that existed before the edit are never touched.
 */

/** Kinds that are never pruned: Tangent and Smooth carry meaning the rank analysis does not always see, and Fixed is a statement of intent. */
const NEVER_PRUNED: ReadonlySet<WorkbenchSketchConstraint["kind"]> = new Set(["tangent", "smooth", "fixed"]);

/** Beyond this many relations the analysis is skipped: the edit is applied as planned (the analysis costs about a millisecond per 30 relations). */
const MAX_ANALYSED_RELATIONS = 1_500;
const MAX_ROUNDS = 6;

/** Entity kinds whose copy is completely determined by a symmetry relation to its source (see constraintFit "symmetry"). */
export const SYMMETRY_DETERMINED_KINDS: ReadonlySet<SketchEntity["kind"]> = new Set(["line", "circle", "point", "arc", "rectangle", "ellipse", "spline"]);

/** A one-entity size dimension (a line's length, a circle's or arc's radius or diameter, a rectangle's width or height). */
export function isSizeDimension(constraint: WorkbenchSketchConstraint): boolean {
  if (constraint.entityIds.length !== 1 || constraint.driven === true) return false;
  if (constraint.kind === "radius") return true;
  return constraint.kind === "distance" && (constraint.dimension === undefined || constraint.dimension === "length" || constraint.dimension === "width" || constraint.dimension === "height" || constraint.dimension === "diameter");
}

const MAX_CONFIRMATIONS = 40;

/** The candidates whose removal leaves the sketch's rank (its number of independent equations) unchanged. */
function confirmed(sketch: WorkbenchSketch, rank: number, candidates: readonly string[]): readonly string[] {
  const rankWithout = (ids: ReadonlySet<string>): number | undefined => {
    try {
      return analyzeLiveSketch({ ...sketch, constraints: sketch.constraints.filter((constraint) => !ids.has(constraint.id)) }).rank;
    } catch {
      return undefined;
    }
  };
  if (rankWithout(new Set(candidates)) === rank) return candidates;
  const accepted: string[] = [];
  for (const id of candidates.slice(0, MAX_CONFIRMATIONS)) {
    if (rankWithout(new Set([...accepted, id])) === rank) accepted.push(id);
  }
  return accepted;
}

/** Removes from `plan.addConstraints` every relation the analysis shows the rest of the sketch already implies. Returns the plan unchanged when nothing is redundant. */
export function pruneRedundantAdditions(sketch: WorkbenchSketch, plan: SketchEditPlan): SketchEditPlan {
  let current = plan;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (current.addConstraints.length === 0) return current;
    const applied = applyPlanToSketch(sketch, current);
    if (typeof applied === "string" || applied.sketch.constraints.length > MAX_ANALYSED_RELATIONS) return current;
    let analysis: ReturnType<typeof analyzeLiveSketch>;
    try {
      analysis = analyzeLiveSketch(applied.sketch);
    } catch {
      return current;
    }
    if (analysis.redundant.length === 0) return current;
    const added = new Map(current.addConstraints.map((constraint) => [constraint.id, constraint] as const));
    const drop = new Set<string>();
    for (const set of analysis.redundant) {
      if (set.constraintIds.some((id) => drop.has(id))) continue;
      const candidates = set.constraintIds.filter((id) => {
        const constraint = added.get(id);
        return constraint !== undefined && !NEVER_PRUNED.has(constraint.kind);
      });
      if (candidates.length === 0) continue;
      const implied = set.impliedConstraintId;
      drop.add(implied !== undefined && candidates.includes(implied) ? implied : candidates[candidates.length - 1]!);
    }
    if (drop.size === 0) return current;
    // The analysis calls a relation redundant when some of its equations are implied (Collinear next to a Coincident joint still removes
    // the direction); only a relation whose removal leaves the rank of the whole sketch unchanged is really dropped.
    const accepted = confirmed(applied.sketch, analysis.rank, [...drop]);
    if (accepted.length === 0) return current;
    const gone = new Set(accepted);
    current = { ...current, addConstraints: current.addConstraints.filter((constraint) => !gone.has(constraint.id)) };
  }
  return current;
}
