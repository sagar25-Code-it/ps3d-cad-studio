import { type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { solveLiveSketch } from "../../workbench-core/src/sketch-solve.js";
import { mapEntity, type SketchEditContext, type SketchEditPlan } from "./edit-tools.js";

/** Shared helpers for plans that copy geometry (clipboard paste, dynamic mirror) and for checking a plan before it is offered. */

export interface CloneTransform {
  readonly point: (value: Vec2) => Vec2;
  /** Maps a rectangle's or ellipse's rotation in degrees; a mirror reverses it, a move leaves it. */
  readonly rotation: (degrees: number) => number;
}

export interface CloneResult {
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
  /** Original ID to the ID of its copy. */
  readonly idMap: ReadonlyMap<string, string>;
}

/** The relations that only involve the given entities, so they can travel with them. */
export function internalRelations(constraints: readonly WorkbenchSketchConstraint[], entityIds: readonly string[]): readonly WorkbenchSketchConstraint[] {
  const wanted = new Set(entityIds);
  return constraints.filter((constraint) => constraint.entityIds.length > 0 && constraint.entityIds.every((id) => wanted.has(id)));
}

/**
 * Copies entities through `transform` with fresh IDs, and re-creates the relations between them on the copies.
 * Relations that mention an entity outside the set are left behind (the caller passes only internal ones).
 */
export function cloneWithRelations(
  context: SketchEditContext,
  entities: readonly SketchEntity[],
  constraints: readonly WorkbenchSketchConstraint[],
  transform: CloneTransform
): CloneResult {
  const idMap = new Map<string, string>();
  const copies = entities.map((entity) => {
    const id = context.newId("entity");
    idMap.set(entity.id, id);
    return mapEntity(entity, id, transform.point, transform.rotation);
  });
  const copiedConstraints = internalRelations(constraints, entities.map((entity) => entity.id)).map((constraint): WorkbenchSketchConstraint => ({
    ...constraint,
    id: context.newId("constraint"),
    entityIds: constraint.entityIds.map((id) => idMap.get(id)!)
  }));
  return { entities: copies, constraints: copiedConstraints, idMap };
}

/**
 * Whether `apply-sketch-edit` would accept the plan: the same checks the operation makes (existing ids, then a solve that must not
 * have to move anything). Lets a planner offer only edits that will actually go through, or fall back to a simpler variant.
 */
export function planHolds(sketch: WorkbenchSketch, plan: SketchEditPlan): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const existing = new Set(sketch.entities.map((entity) => entity.id));
  const removed = new Set(plan.removeEntityIds);
  const updates = new Map(plan.updateEntities.map((entity) => [entity.id, entity] as const));
  for (const id of removed) if (!existing.has(id)) return { ok: false, reason: "An entity to remove does not exist." };
  for (const id of updates.keys()) if (!existing.has(id) || removed.has(id)) return { ok: false, reason: "An entity to update does not exist." };
  const addedIds = plan.addEntities.map((entity) => entity.id);
  if (new Set(addedIds).size !== addedIds.length || addedIds.some((id) => existing.has(id))) return { ok: false, reason: "A new entity reuses an ID." };
  const gone = new Set(plan.removeConstraintIds ?? []);
  const entities = [...sketch.entities.filter((entity) => !removed.has(entity.id)).map((entity) => updates.get(entity.id) ?? entity), ...plan.addEntities];
  const constraints = [...sketch.constraints.filter((constraint) => !constraint.entityIds.some((id) => removed.has(id)) && !gone.has(constraint.id)), ...plan.addConstraints];
  if (new Set(constraints.map((constraint) => constraint.id)).size !== constraints.length) return { ok: false, reason: "A new relation reuses an ID." };
  const next = { ...sketch, entities, constraints };
  const focus = [...updates.keys(), ...addedIds, ...plan.addConstraints.flatMap((constraint) => constraint.entityIds)];
  const solved = solveLiveSketch(next, focus);
  if (!solved.ok) return { ok: false, reason: solved.message };
  if (solved.movedIds.length > 0) return { ok: false, reason: `Conflicts with a relation on ${solved.movedIds.map((id) => id.replace(/^entity:/u, "")).join(", ")}.` };
  return { ok: true };
}
