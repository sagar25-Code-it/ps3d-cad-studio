import { failure, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { buildArrangement, type ArrangementEdge } from "./arrangement.js";
import { arcCircle } from "./curve-sampling.js";
import { editPlan, type SketchEditContext, type SketchEditResult } from "./edit-tools.js";
import { profileCurves, profileGapToleranceOf } from "./profile-regions.js";

/**
 * Break at intersections: splits curves wherever they cross, touch or overlap, in one step. The selected curves (or every curve when
 * nothing is selected) are cut at their meeting points with all the visible curves; each piece becomes a curve of its own.
 *
 *  - a line becomes lines, an arc becomes arcs, a circle crossed twice or more becomes arcs, a rectangle that is cut becomes lines,
 *    a spline becomes splines through points sampled from the curve.
 *  - an ellipse is left whole (the sketch has no elliptical arc), and a circle that is only touched once stays a circle.
 *  - Fixed, horizontal and vertical relations carry onto every piece of a line; relations that cannot hold on a piece are dropped.
 */

type Piece = { readonly entityId: string; readonly edge: ArrangementEdge; readonly index: number; readonly count: number; readonly side: number };

function pieceOf(edge: ArrangementEdge, entityId: string): Piece | undefined {
  const owner = edge.owners.find((candidate) => candidate.entityId === entityId);
  if (owner === undefined) return undefined;
  const match = /#(\d+)\/(\d+)$/u.exec(owner.key);
  return { entityId, edge, index: match === null ? 0 : Number(match[1]), count: match === null ? 1 : Number(match[2]), side: owner.side };
}

function oriented(edge: ArrangementEdge): readonly Vec2[] {
  return edge.points;
}

function middleOf(points: readonly Vec2[]): Vec2 {
  return points[Math.floor(points.length / 2)]!;
}

/** The midpoint of an arc piece on the circle when the sampling left no point between the ends. */
function midpointOnCircle(center: Vec2, start: Vec2, end: Vec2, counterClockwise: boolean): Vec2 {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = counterClockwise ? a1 - a0 : a0 - a1;
  sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const angle = a0 + (counterClockwise ? 1 : -1) * (sweep / 2);
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

function subsample(points: readonly Vec2[], limit: number): Vec2[] {
  if (points.length <= limit) return [...points];
  const result: Vec2[] = [];
  for (let index = 0; index < limit; index += 1) result.push(points[Math.round((index * (points.length - 1)) / (limit - 1))]!);
  return result;
}

/** The two ends of a line or arc, which is all a joint with a broken curve can still name. */
function endsOf(entity: SketchEntity): { readonly start: Vec2; readonly end: Vec2 } | undefined {
  return entity.kind === "line" || entity.kind === "arc" ? { start: entity.start, end: entity.end } : undefined;
}

const JOINT_TOLERANCE_MM = 0.05;
const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOINT_TOLERANCE_MM;

/**
 * A curve that is broken is replaced by its pieces, and the joints it had (Coincident at its ends) went with it, so a closed outline fell
 * apart on the next drag. Each joint is made again on the piece that now holds that end, and consecutive pieces of one curve are joined to
 * each other so the curve still moves as one.
 */
function rejoin(
  context: SketchEditContext,
  replaced: ReadonlyMap<string, { readonly entity: SketchEntity; readonly pieces: readonly SketchEntity[] }>
): WorkbenchSketchConstraint[] {
  const joints: WorkbenchSketchConstraint[] = [];
  const newJoint = (a: string, pointA: SketchPointRef, b: string, pointB: SketchPointRef): void => {
    joints.push({ id: context.newId("constraint"), kind: "coincident", entityIds: [a, b], points: [pointA, pointB] });
  };
  const carry = (id: string, point: SketchPointRef | undefined): { readonly id: string; readonly point: SketchPointRef } | undefined => {
    const swap = replaced.get(id);
    if (swap === undefined) return point === undefined ? undefined : { id, point };
    const ends = endsOf(swap.entity);
    if (ends === undefined || (point !== "start" && point !== "end")) return undefined;
    const wanted = point === "start" ? ends.start : ends.end;
    for (const piece of swap.pieces) {
      const pieceEnds = endsOf(piece);
      if (pieceEnds === undefined) continue;
      if (near(pieceEnds.start, wanted)) return { id: piece.id, point: "start" };
      if (near(pieceEnds.end, wanted)) return { id: piece.id, point: "end" };
    }
    return undefined;
  };
  return (() => {
    const current = (context.sketch.constraints);
    for (const constraint of current) {
      if (constraint.kind !== "coincident" || constraint.suppressed === true || constraint.entityIds.length !== 2 || constraint.points === undefined) continue;
      if (!constraint.entityIds.some((id) => replaced.has(id))) continue;
      const first = carry(constraint.entityIds[0]!, constraint.points[0]);
      const second = carry(constraint.entityIds[1]!, constraint.points[1]);
      if (first === undefined || second === undefined || first.id === second.id) continue;
      newJoint(first.id, first.point, second.id, second.point);
    }
    for (const swap of replaced.values()) {
      for (let index = 0; index + 1 < swap.pieces.length; index += 1) {
        const left = swap.pieces[index]!;
        const right = swap.pieces[index + 1]!;
        const a = endsOf(left);
        const b = endsOf(right);
        if (a === undefined || b === undefined) continue;
        if (near(a.end, b.start)) newJoint(left.id, "end", right.id, "start");
        else if (near(a.end, b.end)) newJoint(left.id, "end", right.id, "end");
        else if (near(a.start, b.start)) newJoint(left.id, "start", right.id, "start");
        else if (near(a.start, b.end)) newJoint(left.id, "start", right.id, "end");
      }
    }
    return joints;
  })();
}

/**
 * Joints at the points where the pieces meet. A crossing of two curves is a point both are cut at, but the cuts only joined the pieces of
 * ONE curve to each other; the pieces of the other curve meeting there had no joint, so resizing one of them left the other behind and the
 * regions fell apart. Every group of line and arc ends that now lies at one point gets Coincident joints, as many as are needed to tie the
 * group together (a joint that the sketch or the joints above already imply is not added twice). Only groups with a new piece in them are touched.
 */
function jointsAtMeetingPoints(
  context: SketchEditContext,
  removed: ReadonlySet<string>,
  added: readonly SketchEntity[],
  known: readonly WorkbenchSketchConstraint[]
): WorkbenchSketchConstraint[] {
  const fresh = new Set(added.map((entity) => entity.id));
  const live = [...context.sketch.entities.filter((entity) => !removed.has(entity.id) && !entity.construction && entity.visible !== false), ...added];
  interface End { readonly id: string; readonly point: SketchPointRef; readonly at: Vec2 }
  const ends: End[] = [];
  for (const entity of live) {
    const both = endsOf(entity);
    if (both === undefined) continue;
    ends.push({ id: entity.id, point: "start", at: both.start }, { id: entity.id, point: "end", at: both.end });
  }
  const key = (end: { readonly id: string; readonly point: SketchPointRef }): string => `${end.id}|${end.point}`;
  const parent = new Map<string, string>(ends.map((end) => [key(end), key(end)]));
  const find = (value: string): string => { let current = value; while (parent.get(current) !== current) { const next = parent.get(current); if (next === undefined) return current; current = next; } return current; };
  const union = (a: string, b: string): void => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const constraint of [...context.sketch.constraints.filter((candidate) => !constraint_touches(candidate, removed)), ...known]) {
    if (constraint.kind !== "coincident" || constraint.suppressed === true || constraint.entityIds.length !== 2 || constraint.points === undefined) continue;
    const a = `${constraint.entityIds[0]!}|${constraint.points[0]!}`;
    const b = `${constraint.entityIds[1]!}|${constraint.points[1]!}`;
    if (parent.has(a) && parent.has(b)) union(a, b);
  }
  const cell = Math.max(JOINT_TOLERANCE_MM, 1e-6);
  const grid = new Map<string, End[]>();
  const cellKey = (x: number, y: number): string => `${x},${y}`;
  const joints: WorkbenchSketchConstraint[] = [];
  for (const end of ends) {
    const cx = Math.floor(end.at[0] / cell);
    const cy = Math.floor(end.at[1] / cell);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const other of grid.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (other.id === end.id || !near(other.at, end.at)) continue;
        if (!fresh.has(end.id) && !fresh.has(other.id)) continue;
        if (find(key(other)) === find(key(end))) continue;
        union(key(other), key(end));
        joints.push({ id: context.newId("constraint"), kind: "coincident", entityIds: [other.id, end.id], points: [other.point, end.point] });
      }
    }
    const own = grid.get(cellKey(cx, cy));
    if (own === undefined) grid.set(cellKey(cx, cy), [end]); else own.push(end);
  }
  return joints;
}

function constraint_touches(constraint: WorkbenchSketchConstraint, removed: ReadonlySet<string>): boolean {
  return constraint.entityIds.some((id) => removed.has(id));
}

export function breakAtIntersections(context: SketchEditContext, ids?: readonly string[]): SketchEditResult {
  const sketch = context.sketch;
  const curves = profileCurves(sketch);
  const wanted = ids === undefined || ids.length === 0 ? undefined : new Set(ids);
  const targets = curves.filter((entity) => wanted === undefined || wanted.has(entity.id));
  if (targets.length === 0) return failure("INVALID_OPERATION", "There is no visible curve to break. Select curves that are not construction or hidden.", [...(wanted ?? [])], "Select the curves to break, or select nothing to break all of them.");
  const arrangement = buildArrangement(curves, { gapToleranceMm: profileGapToleranceOf(sketch) });

  const removeEntityIds: string[] = [];
  const addEntities: SketchEntity[] = [];
  const addConstraints: WorkbenchSketchConstraint[] = [];
  const notes: string[] = [];
  const replaced = new Map<string, { readonly entity: SketchEntity; readonly pieces: readonly SketchEntity[] }>();
  let pieces = 0;
  let curvesBroken = 0;
  for (const entity of targets) {
    const mine = arrangement.edges.flatMap((edge) => { const piece = pieceOf(edge, entity.id); return piece === undefined ? [] : [piece]; });
    if (mine.length === 0) continue;
    const split = mine.some((piece) => piece.count > 1);
    if (entity.kind === "ellipse") { if (split) notes.push(`${entity.id.replace(/^entity:/u, "")} is an ellipse and stays whole`); continue; }
    if (entity.kind === "rectangle") {
      if (!split) continue;
    } else if (!split) continue;
    if (entity.kind === "circle" && mine.length < 2) continue;
    const ordered = [...mine].sort((left, right) => left.side - right.side || left.index - right.index);
    const created: SketchEntity[] = [];
    const base = { construction: entity.construction, ...(entity.visible === undefined ? {} : { visible: entity.visible }) };
    if (entity.kind === "line" || entity.kind === "rectangle") {
      for (const piece of ordered) {
        const points = oriented(piece.edge);
        created.push({ id: context.newId("entity"), kind: "line", start: points[0]!, end: points[points.length - 1]!, ...base });
      }
    } else if (entity.kind === "arc" || entity.kind === "circle") {
      const circle = entity.kind === "arc" ? arcCircle(entity.start, entity.mid, entity.end) : undefined;
      const center: Vec2 = entity.kind === "circle" ? entity.center : circle?.center ?? entity.start;
      const counterClockwise = entity.kind === "circle" ? true : (circle?.sweep ?? 1) > 0;
      for (const piece of ordered) {
        const points = oriented(piece.edge);
        const start = points[0]!;
        const end = points[points.length - 1]!;
        const mid = points.length >= 3 ? middleOf(points) : midpointOnCircle(center, start, end, counterClockwise);
        created.push({ id: context.newId("entity"), kind: "arc", start, mid, end, ...base });
      }
    } else if (entity.kind === "spline") {
      for (const piece of ordered) {
        const points = subsample(oriented(piece.edge), 12);
        const fit = points.length >= 3 ? points : [points[0]!, [(points[0]![0] + points[points.length - 1]![0]) / 2, (points[0]![1] + points[points.length - 1]![1]) / 2] as Vec2, points[points.length - 1]!];
        created.push({ id: context.newId("entity"), kind: "spline", fitPoints: fit, ...base });
      }
    }
    if (created.length < 2) continue;
    removeEntityIds.push(entity.id);
    addEntities.push(...created);
    replaced.set(entity.id, { entity, pieces: created });
    pieces += created.length;
    curvesBroken += 1;
    // Relations that stay true on every piece of a line.
    if (entity.kind === "line") {
      for (const constraint of sketch.constraints) {
        if (constraint.suppressed === true || constraint.entityIds.length !== 1 || constraint.entityIds[0] !== entity.id) continue;
        if (constraint.kind !== "fixed" && constraint.kind !== "horizontal" && constraint.kind !== "vertical") continue;
        for (const piece of created) addConstraints.push({ id: context.newId("constraint"), kind: constraint.kind, entityIds: [piece.id] });
      }
    }
  }
  if (curvesBroken === 0) {
    return failure("INVALID_OPERATION", `No curve crosses, touches or overlaps another, so there is nothing to break${notes.length === 0 ? "" : ` (${notes.join("; ")})`}.`, [...(wanted ?? [])], "Break splits curves where they meet. Draw curves that cross first.");
  }
  addConstraints.push(...rejoin(context, replaced));
  addConstraints.push(...jointsAtMeetingPoints(context, new Set(removeEntityIds), addEntities, addConstraints));
  const crossings = arrangement.crossings.length;
  return editPlan(`Broke ${curvesBroken} curve${curvesBroken === 1 ? "" : "s"} into ${pieces} pieces at ${crossings} intersection${crossings === 1 ? "" : "s"}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`, { removeEntityIds, addEntities, addConstraints });
}
