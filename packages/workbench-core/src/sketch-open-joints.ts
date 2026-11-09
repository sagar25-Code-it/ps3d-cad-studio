import type { SketchEntity, Vec2, WorkbenchSketchConstraint } from "./types.js";

/**
 * Stale-geometry guard for dimension edits. Curves that touch end to end without a Coincident relation (an outline from an older
 * build, an import, a profile whose joints were never recorded) are moved apart by an edit that only drives one of them, and the
 * edit used to report success while the outline tore open. These helpers find the touching ends, tell which of them an edit
 * separated, and describe a joint relation for the solver to hold the next time round.
 */

export type EndRef = "start" | "end";

export interface JointEnd {
  readonly entityId: string;
  readonly ref: EndRef;
}

export interface OpenJoint {
  readonly first: JointEnd;
  readonly second: JointEnd;
  /** How far apart the two ends are after the edit. */
  readonly gapMm: number;
}

/** Ends this close count as touching before an edit; ends this far apart after it count as separated. */
export const JOINT_TOUCH_MM = 1e-6;
export const JOINT_OPEN_MM = 1e-5;

type Ended = Extract<SketchEntity, { readonly kind: "line" | "arc" }>;

const isEnded = (entity: SketchEntity): entity is Ended => (entity.kind === "line" || entity.kind === "arc") && entity.construction !== true;
const pointOf = (entity: Ended, ref: EndRef): Vec2 => entity[ref];
const key = (end: JointEnd): string => `${end.entityId}|${end.ref}`;

function related(constraints: readonly WorkbenchSketchConstraint[], a: JointEnd, b: JointEnd): boolean {
  return constraints.some((constraint) => {
    if (constraint.kind !== "coincident" || constraint.suppressed === true || constraint.points === undefined) return false;
    const [first, second] = constraint.entityIds;
    const [pointFirst, pointSecond] = constraint.points;
    if (first === undefined || second === undefined) return false;
    return (first === a.entityId && second === b.entityId && pointFirst === a.ref && pointSecond === b.ref) || (first === b.entityId && second === a.entityId && pointFirst === b.ref && pointSecond === a.ref);
  });
}

/** Pairs of curve ends (from different curves) that touch in `entities` and are not joined by a Coincident relation. */
export function looseTouchingJoints(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[]): readonly (readonly [JointEnd, JointEnd])[] {
  const cell = (point: Vec2): string => `${Math.round(point[0] / 1e-3)}|${Math.round(point[1] / 1e-3)}`;
  const grid = new Map<string, JointEnd[]>();
  const ends: Ended[] = entities.filter(isEnded);
  for (const entity of ends) {
    for (const ref of ["start", "end"] as const) {
      const point = pointOf(entity, ref);
      const bucket = cell(point);
      const list = grid.get(bucket);
      if (list === undefined) grid.set(bucket, [{ entityId: entity.id, ref }]);
      else list.push({ entityId: entity.id, ref });
    }
  }
  const byId = new Map(ends.map((entity) => [entity.id, entity] as const));
  const found: (readonly [JointEnd, JointEnd])[] = [];
  const seen = new Set<string>();
  for (const entity of ends) {
    for (const ref of ["start", "end"] as const) {
      const here: JointEnd = { entityId: entity.id, ref };
      const point = pointOf(entity, ref);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = grid.get(`${Math.round(point[0] / 1e-3) + dx}|${Math.round(point[1] / 1e-3) + dy}`);
          if (bucket === undefined) continue;
          for (const other of bucket) {
            if (other.entityId === entity.id) continue;
            const pair = key(here) < key(other) ? `${key(here)}~${key(other)}` : `${key(other)}~${key(here)}`;
            if (seen.has(pair)) continue;
            const otherEntity = byId.get(other.entityId)!;
            const q = pointOf(otherEntity, other.ref);
            if (Math.hypot(q[0] - point[0], q[1] - point[1]) > JOINT_TOUCH_MM) continue;
            seen.add(pair);
            if (!related(constraints, here, other)) found.push([here, other]);
          }
        }
      }
    }
  }
  return found;
}

/** The joints that touched before an edit (related or not, as `touching` lists them) and are open in `after`. */
export function openedJoints(touching: readonly (readonly [JointEnd, JointEnd])[], after: readonly SketchEntity[]): readonly OpenJoint[] {
  const byId = new Map(after.filter(isEnded).map((entity) => [entity.id, entity] as const));
  const opened: OpenJoint[] = [];
  for (const [first, second] of touching) {
    const a = byId.get(first.entityId);
    const b = byId.get(second.entityId);
    if (a === undefined || b === undefined) continue;
    const p = pointOf(a, first.ref);
    const q = pointOf(b, second.ref);
    const gapMm = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (gapMm > JOINT_OPEN_MM) opened.push({ first, second, gapMm });
  }
  return opened;
}

/** Coincident joints (for one solve; they are not stored) that hold the given pairs of ends together. */
export function jointRelations(pairs: readonly (readonly [JointEnd, JointEnd])[]): readonly WorkbenchSketchConstraint[] {
  return pairs.map(([first, second], index): WorkbenchSketchConstraint => ({ id: `constraint:implicit-joint-${index + 1}`, kind: "coincident", entityIds: [first.entityId, second.entityId], points: [first.ref, second.ref] }));
}
