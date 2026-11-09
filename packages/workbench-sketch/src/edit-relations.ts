import {
  failure,
  MODEL_ENVELOPE,
  WORKBENCH_LIMITS,
  type SketchEntity,
  type SketchPointRef,
  type Vec2,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint
} from "../../workbench-core/src/index.js";
import { solveLiveSketch } from "../../workbench-core/src/sketch-solve.js";
import { arcShape, isDimensionConstraint, measureDimensionConstraint } from "../../workbench-core/src/sketch-measure.js";
import { applyPlanToSketch, pinnedAmong } from "./sketch-clone.js";
import { editPlan, type SketchEditContext, type SketchEditPlan, type SketchEditResult } from "./edit-tools.js";

/**
 * What every sketch edit does around its geometry: it builds the relations the result should carry (joints, tangents, radius
 * dimensions), removes the relations the edit makes untrue instead of failing on them, refuses to move a Fixed curve, and checks the
 * model limits up front so the user never meets the generic "invalid or has a duplicate ID" error.
 */

const HOLD_TOLERANCE_MM = 1e-6;

export function nameOf(id: string): string {
  const bare = id.replace(/^entity:/u, "").replace(/^user-/u, "");
  return bare.length > 12 ? `${bare.slice(0, 8)}…` : bare;
}

function kindLabel(entity: SketchEntity): string {
  return `${entity.kind} ${nameOf(entity.id)}`;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function finiteVec(value: readonly number[]): boolean {
  return value.every((component) => Number.isFinite(component));
}

// ---------------------------------------------------------------------------------------------
// Relation builders
// ---------------------------------------------------------------------------------------------

export function jointRelation(context: SketchEditContext, aId: string, aRef: SketchPointRef, bId: string, bRef: SketchPointRef): WorkbenchSketchConstraint {
  return { id: context.newId("constraint"), kind: "coincident", entityIds: [aId, bId], points: [aRef, bRef] };
}

export function pairRelation(context: SketchEditContext, kind: "tangent" | "equal" | "concentric" | "parallel" | "perpendicular" | "collinear", aId: string, bId: string): WorkbenchSketchConstraint {
  return { id: context.newId("constraint"), kind, entityIds: [aId, bId] };
}

export function radiusDimensionRelation(context: SketchEditContext, entityId: string, radiusMm: number): WorkbenchSketchConstraint {
  return { id: context.newId("constraint"), kind: "radius", entityIds: [entityId], valueMm: radiusMm, dimension: "radius" };
}

// ---------------------------------------------------------------------------------------------
// Does a relation still hold on the geometry?
// ---------------------------------------------------------------------------------------------

function circleOf(entity: SketchEntity): { readonly center: Vec2; readonly radius: number } | undefined {
  if (entity.kind === "circle") return { center: entity.center, radius: entity.radiusMm };
  if (entity.kind === "arc") {
    const shape = arcShape(entity.start, entity.mid, entity.end);
    return shape === undefined ? undefined : { center: shape.center, radius: shape.radiusMm };
  }
  return undefined;
}

/** The position of a defining point of an entity, or undefined when the entity has no such point. */
export function pointOfEntity(entity: SketchEntity, ref: SketchPointRef): Vec2 | undefined {
  switch (entity.kind) {
    case "line":
      return ref === "start" ? entity.start : ref === "end" ? entity.end : ref === "mid" ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2] : undefined;
    case "arc":
      return ref === "start" ? entity.start : ref === "end" ? entity.end : ref === "mid" ? entity.mid : ref === "center" ? circleOf(entity)?.center : undefined;
    case "circle":
    case "ellipse":
    case "rectangle":
      return ref === "center" ? entity.center : undefined;
    case "point":
      return ref === "self" ? entity.point : undefined;
    case "spline":
      return ref === "start" ? entity.fitPoints[0] : ref === "end" ? entity.fitPoints[entity.fitPoints.length - 1] : undefined;
    default:
      return undefined;
  }
}

function direction(line: Extract<SketchEntity, { kind: "line" }>): Vec2 {
  return [line.end[0] - line.start[0], line.end[1] - line.start[1]];
}

function wrapDeg(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Whether the relation is satisfied by the geometry as it stands, with no solve. Kinds this cannot read directly (symmetry, smooth, pierce,
 * refraction) ask the live solver whether it would have to move anything.
 */
export function constraintHolds(sketch: Pick<WorkbenchSketch, "entities"> & Partial<WorkbenchSketch>, constraint: WorkbenchSketchConstraint): boolean {
  if (constraint.suppressed === true || constraint.kind === "fixed") return true;
  const entities = constraint.entityIds.map((id) => sketch.entities.find((entity) => entity.id === id));
  if (entities.some((entity) => entity === undefined)) return true;
  const [first, second] = entities as readonly SketchEntity[];
  if (isDimensionConstraint(constraint)) {
    if (constraint.driven === true) return true;
    const measured = measureDimensionConstraint(sketch, constraint);
    if (measured === undefined) return true;
    if (constraint.kind === "angle") {
      if (constraint.valueDeg === undefined) return true;
      const turn = Math.abs(wrapDeg(measured - constraint.valueDeg));
      return Math.min(turn, 360 - turn) <= 1e-6;
    }
    if (constraint.valueMm === undefined) return true;
    return Math.abs(measured - constraint.valueMm) <= HOLD_TOLERANCE_MM * Math.max(1, Math.abs(constraint.valueMm));
  }
  switch (constraint.kind) {
    case "horizontal": return first?.kind !== "line" || Math.abs(first.end[1] - first.start[1]) <= HOLD_TOLERANCE_MM;
    case "vertical": return first?.kind !== "line" || Math.abs(first.end[0] - first.start[0]) <= HOLD_TOLERANCE_MM;
    case "parallel":
    case "perpendicular":
    case "collinear": {
      if (first?.kind !== "line" || second?.kind !== "line") return true;
      const a = direction(first);
      const b = direction(second);
      const scale = Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]);
      if (scale < 1e-12) return false;
      if (constraint.kind === "perpendicular") return Math.abs(a[0] * b[0] + a[1] * b[1]) <= 1e-9 * scale;
      if (Math.abs(a[0] * b[1] - a[1] * b[0]) > 1e-9 * scale) return false;
      if (constraint.kind === "parallel") return true;
      const offset: Vec2 = [second.start[0] - first.start[0], second.start[1] - first.start[1]];
      return Math.abs(offset[0] * a[1] - offset[1] * a[0]) / Math.hypot(a[0], a[1]) <= HOLD_TOLERANCE_MM;
    }
    case "coincident": {
      const refs = constraint.points;
      if (refs === undefined || first === undefined || second === undefined) return true;
      const a = pointOfEntity(first, refs[0]!);
      const b = pointOfEntity(second, refs[1]!);
      return a === undefined || b === undefined || dist(a, b) <= HOLD_TOLERANCE_MM;
    }
    case "midpoint": {
      const refs = constraint.points;
      if (refs === undefined || first === undefined || second?.kind !== "line") return true;
      const a = pointOfEntity(first, refs[0]!);
      return a === undefined || dist(a, pointOfEntity(second, "mid")!) <= HOLD_TOLERANCE_MM;
    }
    case "equal": {
      if (first?.kind === "line" && second?.kind === "line") return Math.abs(Math.hypot(...direction(first)) - Math.hypot(...direction(second))) <= HOLD_TOLERANCE_MM;
      const a = first === undefined ? undefined : circleOf(first);
      const b = second === undefined ? undefined : circleOf(second);
      return a === undefined || b === undefined || Math.abs(a.radius - b.radius) <= HOLD_TOLERANCE_MM;
    }
    case "concentric": {
      const a = first === undefined ? undefined : circleOf(first);
      const b = second === undefined ? undefined : circleOf(second);
      return a === undefined || b === undefined || dist(a.center, b.center) <= HOLD_TOLERANCE_MM;
    }
    case "tangent": {
      if (first === undefined || second === undefined) return true;
      const line = first.kind === "line" ? first : second.kind === "line" ? second : undefined;
      const other = line === first ? second : first;
      const round = circleOf(other);
      if (line !== undefined) {
        if (round === undefined) return true;
        const d = direction(line);
        const length = Math.hypot(d[0], d[1]);
        if (length < 1e-12) return false;
        const gap = Math.abs((round.center[0] - line.start[0]) * d[1] - (round.center[1] - line.start[1]) * d[0]) / length;
        return Math.abs(gap - round.radius) <= HOLD_TOLERANCE_MM;
      }
      const a = circleOf(first);
      const b = circleOf(second);
      if (a === undefined || b === undefined) return true;
      const between = dist(a.center, b.center);
      return Math.abs(between - (a.radius + b.radius)) <= HOLD_TOLERANCE_MM || Math.abs(between - Math.abs(a.radius - b.radius)) <= HOLD_TOLERANCE_MM;
    }
    default:
      break;
  }
  return solverAccepts(sketch as WorkbenchSketch, constraint);
}

/** Asks the live solver whether a single relation would move anything on the geometry it names. */
function solverAccepts(sketch: WorkbenchSketch, constraint: WorkbenchSketchConstraint): boolean {
  const entities = sketch.entities.filter((entity) => constraint.entityIds.includes(entity.id));
  try {
    const solved = solveLiveSketch({ ...sketch, entities, constraints: [{ ...constraint, suppressed: false }] });
    return !solved.ok ? false : solved.movedIds.length === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Limits that the validator would otherwise report as "invalid or duplicate"
// ---------------------------------------------------------------------------------------------

/** The per-edit list sizes the apply-sketch-edit operation accepts. */
export const EDIT_ENTITY_LIMIT = 500;
export const EDIT_CONSTRAINT_LIMIT = 1_000;
const LIMIT_MM = MODEL_ENVELOPE.maxSketchCoordinateMm;
const MIN_MM = MODEL_ENVELOPE.minGeometryMm;

function pointProblem(point: readonly number[], label: string): string | undefined {
  if (!finiteVec(point)) return `${label} would have a coordinate that is not a number.`;
  for (const component of point) if (Math.abs(component) > LIMIT_MM) return `${label} would reach ${Math.round(Math.abs(component))} mm from the origin; the sketch limit is ${LIMIT_MM} mm.`;
  return undefined;
}

/** A sentence naming the limit an entity would break, or undefined when it is a valid entity. */
export function entityProblem(entity: SketchEntity): string | undefined {
  const label = kindLabel(entity);
  const sized = (value: number, what: string, maximum: number): string | undefined => {
    if (!Number.isFinite(value)) return `${label} would have a ${what} that is not a number.`;
    if (value < MIN_MM) return `${label} would have a ${what} of ${Math.round(value * 10000) / 10000} mm; the minimum is ${MIN_MM} mm.`;
    if (value > maximum) return `${label} would have a ${what} of ${Math.round(value)} mm; the maximum is ${maximum} mm.`;
    return undefined;
  };
  switch (entity.kind) {
    case "line":
      return pointProblem(entity.start, label) ?? pointProblem(entity.end, label) ?? sized(dist(entity.start, entity.end), "length", 2 * LIMIT_MM * Math.SQRT2);
    case "circle":
      return pointProblem(entity.center, label) ?? sized(entity.radiusMm, "radius", MODEL_ENVELOPE.maxSketchRadiusMm);
    case "rectangle":
      return pointProblem(entity.center, label) ?? sized(entity.widthMm, "width", MODEL_ENVELOPE.maxSketchSizeMm) ?? sized(entity.heightMm, "height", MODEL_ENVELOPE.maxSketchSizeMm);
    case "ellipse":
      return pointProblem(entity.center, label) ?? sized(entity.majorRadiusMm, "major radius", MODEL_ENVELOPE.maxSketchRadiusMm) ?? sized(entity.minorRadiusMm, "minor radius", MODEL_ENVELOPE.maxSketchRadiusMm)
        ?? (entity.minorRadiusMm > entity.majorRadiusMm + 1e-9 ? `${label} would have a minor radius larger than its major radius.` : undefined);
    case "arc": {
      const problem = pointProblem(entity.start, label) ?? pointProblem(entity.mid, label) ?? pointProblem(entity.end, label);
      if (problem !== undefined) return problem;
      const area = Math.abs((entity.mid[0] - entity.start[0]) * (entity.end[1] - entity.start[1]) - (entity.mid[1] - entity.start[1]) * (entity.end[0] - entity.start[0]));
      return area < 1e-4 ? `${label} would be degenerate (its three points almost coincide or lie in a line).` : undefined;
    }
    case "point":
      return pointProblem(entity.point, label);
    case "spline": {
      if (entity.fitPoints.length < 3 || entity.fitPoints.length > 24) return `${label} would have ${entity.fitPoints.length} fit points; a spline takes 3 to 24.`;
      for (let index = 0; index < entity.fitPoints.length; index += 1) {
        const point = entity.fitPoints[index]!;
        const problem = pointProblem(point, label);
        if (problem !== undefined) return problem;
        if (index > 0 && dist(entity.fitPoints[index - 1]!, point) < MIN_MM) return `${label} would have two fit points closer than ${MIN_MM} mm.`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Finishing a plan
// ---------------------------------------------------------------------------------------------

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the values and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function sameEntity(a: SketchEntity, b: SketchEntity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface FinishOptions {
  /** Entities the plan may move although they carry a Fixed relation (none by default). */
  readonly allowPinned?: readonly string[];
  /** Keep a relation that is no longer true instead of removing it (used by edits that re-value their own dimensions). */
  readonly keep?: ReadonlySet<string>;
  /** False for the intermediate steps of a multi-step edit: only the final plan needs the live solver's verdict. */
  readonly solve?: boolean;
}

/**
 * Turns a raw plan into one the operation will accept: drops no-op updates, refuses to move a Fixed curve, names a broken size or count
 * limit, and removes the relations the new geometry no longer satisfies (a joint at a corner that was rounded, a length that was
 * shortened) so the edit never fails on them.
 */
export function finishPlan(context: SketchEditContext, plan: SketchEditPlan, options: FinishOptions = {}): SketchEditResult {
  const sketch = context.sketch;
  const byId = new Map(sketch.entities.map((entity) => [entity.id, entity] as const));
  const updates = plan.updateEntities.filter((entity) => {
    const before = byId.get(entity.id);
    return before === undefined || !sameEntity(before, entity);
  });
  const moved = [...updates.map((entity) => entity.id), ...plan.removeEntityIds];
  const pinned = pinnedAmong(sketch, moved).filter((id) => !(options.allowPinned ?? []).includes(id));
  if (pinned.length > 0) {
    const names = pinned.map((id) => nameOf(id)).join(", ");
    return failure(
      "CONSTRAINT_CONFLICT",
      `${pinned.length === 1 ? `Curve ${names} is` : `Curves ${names} are`} fixed, so this edit would have to move ${pinned.length === 1 ? "it" : "them"}.`,
      pinned,
      "Remove the Fixed relation first (Relax Relations), or pick geometry that is not fixed."
    );
  }
  const removeIds = new Set(plan.removeEntityIds);
  const total = sketch.entities.length - removeIds.size + plan.addEntities.length;
  if (total > WORKBENCH_LIMITS.maxEntities) {
    return failure("RESOURCE_LIMIT", `Would create ${plan.addEntities.length} entities, which makes ${total} in the sketch; the limit is ${WORKBENCH_LIMITS.maxEntities}.`, [], "Delete entities or use a smaller count.");
  }
  // One edit travels as a single operation with these list sizes.
  if (plan.addEntities.length > EDIT_ENTITY_LIMIT || updates.length > EDIT_ENTITY_LIMIT || plan.removeEntityIds.length > EDIT_ENTITY_LIMIT) {
    const count = Math.max(plan.addEntities.length, updates.length, plan.removeEntityIds.length);
    return failure("RESOURCE_LIMIT", `This edit would touch ${count} entities at once; one edit can handle at most ${EDIT_ENTITY_LIMIT}.`, [], "Select fewer curves or use a smaller count, then repeat the edit.");
  }
  if (plan.addConstraints.length > EDIT_CONSTRAINT_LIMIT || (plan.removeConstraintIds?.length ?? 0) > EDIT_CONSTRAINT_LIMIT) {
    return failure("RESOURCE_LIMIT", `This edit would add or remove ${Math.max(plan.addConstraints.length, plan.removeConstraintIds?.length ?? 0)} relations at once; one edit can handle at most ${EDIT_CONSTRAINT_LIMIT}.`, [], "Select fewer curves, then repeat the edit.");
  }
  for (const entity of [...updates, ...plan.addEntities]) {
    const problem = entityProblem(entity);
    if (problem !== undefined) return reject(problem, [entity.id], "Use a smaller or larger value, or move the geometry closer to the origin.");
  }
  const cleaned: SketchEditPlan = { ...plan, updateEntities: updates, label: plan.label.length > 80 ? `${plan.label.slice(0, 77)}...` : plan.label };
  const settled = settleRelations(sketch, cleaned, options);
  if (typeof settled === "string") return reject(settled);
  const constraintTotal = sketch.constraints.length - (settled.removeConstraintIds?.length ?? 0) + settled.addConstraints.length;
  if (constraintTotal > WORKBENCH_LIMITS.maxConstraints) {
    return failure("RESOURCE_LIMIT", `The sketch would hold ${constraintTotal} relations; the limit is ${WORKBENCH_LIMITS.maxConstraints}.`, [], "Delete a relation before applying this edit.");
  }
  if ((settled.removeConstraintIds?.length ?? 0) > EDIT_CONSTRAINT_LIMIT) {
    return failure("RESOURCE_LIMIT", `This edit would remove ${settled.removeConstraintIds?.length} relations at once; one edit can handle at most ${EDIT_CONSTRAINT_LIMIT}.`, [], "Select fewer curves, then repeat the edit.");
  }
  return editPlan(settled.label, settled);
}

/** Adds to `removeConstraintIds` every existing relation the plan's geometry breaks. A string means the plan does not fit the sketch. */
export function settleRelations(sketch: WorkbenchSketch, plan: SketchEditPlan, options: FinishOptions = {}): SketchEditPlan | string {
  const applied = applyPlanToSketch(sketch, plan);
  if (typeof applied === "string") return applied;
  const removed = new Set(plan.removeEntityIds);
  const touched = new Set([...plan.updateEntities.map((entity) => entity.id)]);
  const already = new Set(plan.removeConstraintIds ?? []);
  const broken = new Set<string>();
  for (const constraint of sketch.constraints) {
    if (already.has(constraint.id) || (options.keep?.has(constraint.id) ?? false)) continue;
    if (constraint.entityIds.some((id) => removed.has(id))) continue;
    if (!constraint.entityIds.some((id) => touched.has(id))) continue;
    if (constraint.suppressed === true) {
      // A relaxed relation that the edit makes untrue would be left stale: restoring it later could not hold without undoing the edit.
      const live = { ...constraint, suppressed: false };
      if (constraintHolds(sketch, live) && !constraintHolds(applied.sketch, live)) broken.add(constraint.id);
      continue;
    }
    if (!constraintHolds(applied.sketch, constraint)) broken.add(constraint.id);
  }
  let result: SketchEditPlan = broken.size === 0 ? plan : { ...plan, removeConstraintIds: [...already, ...broken] };
  // The relations are as true as they can be read directly; if the live solver still would have to move something, drop the
  // relations on the changed geometry that it cannot hold either, rather than failing the edit on them.
  for (let attempt = 0; attempt < (options.solve === false ? 0 : 3); attempt += 1) {
    const next = applyPlanToSketch(sketch, result);
    if (typeof next === "string") return next;
    const focus = [...result.updateEntities.map((entity) => entity.id), ...result.addEntities.map((entity) => entity.id)];
    const solved = solveLiveSketch(next.sketch, next.focus);
    if (!solved.ok || solved.movedIds.length === 0) break;
    const moving = new Set(solved.movedIds);
    const added = new Set(result.addConstraints.map((constraint) => constraint.id));
    const drop = next.sketch.constraints.filter((constraint) => {
      if (constraint.suppressed === true || constraint.kind === "fixed" || (options.keep?.has(constraint.id) ?? false)) return false;
      if (!constraint.entityIds.some((id) => moving.has(id) || focus.includes(id))) return false;
      return !solverAccepts(next.sketch, constraint);
    });
    if (drop.length === 0) break;
    // A relation the live solver cannot hold is dropped, whether it already existed or the edit just made it, instead of failing the edit.
    const dropIds = new Set(drop.map((constraint) => constraint.id));
    result = {
      ...result,
      addConstraints: result.addConstraints.filter((constraint) => !dropIds.has(constraint.id)),
      removeConstraintIds: [...(result.removeConstraintIds ?? []), ...drop.filter((constraint) => !added.has(constraint.id)).map((constraint) => constraint.id)]
    };
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Chaining and diffing plans
// ---------------------------------------------------------------------------------------------

/** The sketch after a plan (relations on removed entities and removed relations dropped), or the reason it does not fit. */
export function sketchAfter(sketch: WorkbenchSketch, plan: SketchEditPlan): WorkbenchSketch | string {
  const applied = applyPlanToSketch(sketch, plan);
  return typeof applied === "string" ? applied : applied.sketch;
}

/** The single plan that turns `before` into `after`, so several steps run on a working copy can be applied as one atomic edit. */
export function diffPlan(before: WorkbenchSketch, after: WorkbenchSketch, label: string): SketchEditPlan {
  const afterById = new Map(after.entities.map((entity) => [entity.id, entity] as const));
  const beforeById = new Map(before.entities.map((entity) => [entity.id, entity] as const));
  const removeEntityIds = before.entities.filter((entity) => !afterById.has(entity.id)).map((entity) => entity.id);
  const removed = new Set(removeEntityIds);
  const updateEntities = after.entities.filter((entity) => {
    const old = beforeById.get(entity.id);
    return old !== undefined && !sameEntity(old, entity);
  });
  const addEntities = after.entities.filter((entity) => !beforeById.has(entity.id));
  const afterConstraints = new Map(after.constraints.map((constraint) => [constraint.id, constraint] as const));
  const beforeConstraints = new Map(before.constraints.map((constraint) => [constraint.id, constraint] as const));
  const removeConstraintIds: string[] = [];
  const addConstraints: WorkbenchSketchConstraint[] = [];
  for (const constraint of before.constraints) {
    const now = afterConstraints.get(constraint.id);
    if (now === undefined) {
      if (!constraint.entityIds.some((id) => removed.has(id))) removeConstraintIds.push(constraint.id);
    } else if (JSON.stringify(now) !== JSON.stringify(constraint)) {
      removeConstraintIds.push(constraint.id);
      addConstraints.push(now);
    }
  }
  for (const constraint of after.constraints) if (!beforeConstraints.has(constraint.id)) addConstraints.push(constraint);
  return { label, removeEntityIds, updateEntities, addEntities, addConstraints, ...(removeConstraintIds.length === 0 ? {} : { removeConstraintIds }) };
}

/** Constraint IDs of relations on one entity of the given single-entity kinds, for carrying them to a new piece of that entity. */
export function carriedRelations(
  context: SketchEditContext,
  sketch: WorkbenchSketch,
  fromId: string,
  toId: string,
  kinds: readonly WorkbenchSketchConstraint["kind"][] = ["horizontal", "vertical", "parallel", "perpendicular", "collinear"]
): readonly WorkbenchSketchConstraint[] {
  return sketch.constraints
    .filter((constraint) => constraint.suppressed !== true && kinds.includes(constraint.kind) && constraint.entityIds.includes(fromId))
    .map((constraint): WorkbenchSketchConstraint => ({ ...constraint, id: context.newId("constraint"), entityIds: constraint.entityIds.map((id) => (id === fromId ? toId : id)) }));
}

// ---------------------------------------------------------------------------------------------
// Parallel pairs whose lines run opposite ways
// ---------------------------------------------------------------------------------------------

/**
 * The live solver reads Parallel as "same direction", so a copied or mirrored pair whose lines run opposite ways (a mirrored polygon
 * reverses its winding) would be demoted to unconstrained. The copy is the same shape either way, so one line of such a pair is
 * stored reversed (start and end swapped), and every relation that names its ends or its direction is adjusted to match.
 */
export function alignParallelDirections(
  entities: readonly SketchEntity[],
  constraints: readonly WorkbenchSketchConstraint[]
): { readonly entities: readonly SketchEntity[]; readonly constraints: readonly WorkbenchSketchConstraint[] } {
  const lines = new Map(entities.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line").map((entity) => [entity.id, entity] as const));
  const flipped = new Set<string>();
  const directionOf = (id: string): Vec2 => {
    const line = lines.get(id)!;
    const sign = flipped.has(id) ? -1 : 1;
    return [sign * (line.end[0] - line.start[0]), sign * (line.end[1] - line.start[1])];
  };
  for (const constraint of constraints) {
    if (constraint.kind !== "parallel" || constraint.suppressed === true) continue;
    const [first, second] = constraint.entityIds;
    if (first === undefined || second === undefined || !lines.has(first) || !lines.has(second)) continue;
    const a = directionOf(first);
    const b = directionOf(second);
    if (a[0] * b[0] + a[1] * b[1] >= 0) continue;
    const candidate = flipped.has(second) ? first : second;
    if (flipped.has(candidate)) continue;
    flipped.add(candidate);
  }
  if (flipped.size === 0) return { entities, constraints };
  const swapRef = (ref: SketchPointRef): SketchPointRef => (ref === "start" ? "end" : ref === "end" ? "start" : ref);
  return {
    entities: entities.map((entity) => (entity.kind === "line" && flipped.has(entity.id) ? { ...entity, start: entity.end, end: entity.start } : entity)),
    constraints: constraints.map((constraint): WorkbenchSketchConstraint => {
      if (!constraint.entityIds.some((id) => flipped.has(id))) return constraint;
      const points = constraint.points === undefined ? undefined : constraint.points.map((ref, index) => (flipped.has(constraint.entityIds[index] ?? "") ? swapRef(ref) : ref));
      // An angle runs from the direction of the first line to the direction of the second: reversing one of them adds a half turn.
      const turned = constraint.kind === "angle" && constraint.valueDeg !== undefined && constraint.entityIds.filter((id) => flipped.has(id)).length === 1
        ? { valueDeg: (constraint.valueDeg + 180) % 360 } : {};
      return { ...constraint, ...(points === undefined ? {} : { points }), ...turned };
    })
  };
}
