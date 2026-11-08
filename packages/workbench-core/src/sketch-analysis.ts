import { solveAnalyticSketch } from "../../parametric-sketch-core/src/solver.js";
import { toLiveSets, type LiveRelationSet } from "./sketch-solve.js";
import { translateSketch, type UnsolvedConstraint } from "./sketch-translate.js";
import type { WorkbenchSketch } from "./types.js";

/**
 * The degrees of freedom of the live sketch from the rank of its relations' Jacobian (see rank-analysis.ts in the solver package), not
 * from counting relations: a duplicate relation removes nothing, a relation the solver does not enforce removes nothing, a loop of
 * dimensions that closes reports the dimension that is implied by the others, and a rectangle with only a width and a height still floats.
 */
export interface LiveSketchAnalysis {
  readonly degreesOfFreedom: number;
  /** Per entity: how many independent ways it can still move or change shape (the others being free to follow). */
  readonly entityFreedom: Readonly<Record<string, number>>;
  readonly rank: number;
  /** Consistent but dependent relations: one of each set adds nothing. */
  readonly redundant: readonly LiveRelationSet[];
  /** Relations that contradict each other at the stored geometry. */
  readonly conflicting: readonly LiveRelationSet[];
  /** Relations that are recorded but not enforced (a pairing the solver cannot handle, or a spline). */
  readonly unsolved: readonly UnsolvedConstraint[];
  /** How many relations the solver enforces. */
  readonly enforced: number;
}

export function analyzeLiveSketch(sketch: WorkbenchSketch): LiveSketchAnalysis {
  const translation = translateSketch(sketch);
  const result = solveAnalyticSketch({ document: translation.document, mode: "validate", labels: translation.labels });
  const byEntity: Record<string, number> = { ...result.dof.byEntity };
  let degrees = result.dof.total;
  const reduce = (id: string, amount: number): void => {
    const current = byEntity[id];
    if (current === undefined) return;
    const taken = Math.min(current, amount);
    byEntity[id] = current - taken;
    degrees -= taken;
  };
  const active = sketch.constraints.filter((constraint) => constraint.suppressed !== true);
  // Splines are outside the solver: two numbers per fit point, taken away by Fix and by a smooth join.
  for (const entity of sketch.entities) {
    if (entity.kind !== "spline") continue;
    byEntity[entity.id] = entity.fitPoints.length * 2;
    degrees += byEntity[entity.id]!;
  }
  for (const constraint of active) {
    if (constraint.kind === "fixed") {
      for (const id of constraint.entityIds) {
        if (sketch.entities.find((entity) => entity.id === id)?.kind === "spline") reduce(id, byEntity[id] ?? 0);
      }
    } else if (constraint.kind === "smooth") {
      // Joining the ends (2), matching the tangent (1) and matching the curvature (1) all act on the spline.
      const splineId = constraint.entityIds.find((id) => sketch.entities.find((entity) => entity.id === id)?.kind === "spline");
      if (splineId !== undefined) reduce(splineId, 4);
    } else if (constraint.kind === "pierce") {
      reduce(constraint.entityIds[0]!, 2);
    } else if (constraint.kind === "refraction") {
      reduce(constraint.entityIds[1]!, 1);
    }
  }
  const unsolved = [...translation.unsolved];
  const enforced = active.filter((constraint) => constraint.driven !== true && !unsolved.some((entry) => entry.constraintId === constraint.id)).length;
  return {
    degreesOfFreedom: Math.max(0, degrees),
    entityFreedom: Object.fromEntries(Object.entries(byEntity).sort(([a], [b]) => (a < b ? -1 : 1))),
    rank: result.dof.rank ?? 0,
    redundant: toLiveSets(result.dof.relationSets ?? [], "redundant"),
    conflicting: toLiveSets(result.dof.relationSets ?? [], "conflicting"),
    unsolved,
    enforced
  };
}
