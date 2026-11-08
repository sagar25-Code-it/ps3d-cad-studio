import { failure, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { sampleArc, sampleSpline } from "./index.js";
import { editPlan, type SketchEditContext, type SketchEditResult } from "./edit-tools.js";
import { curveEnd, isOpenCurve, jointBetween, withCurveEnd, type CurveEnd } from "./endpoint-join.js";
import { planHolds } from "./sketch-clone.js";

/**
 * Make Path: chains the selected open curves (lines, arcs, splines) into one ordered path, walking end to end from a free end,
 * and reports where the chain has gaps, branches or curves that do not join. The ordered samples are what a cam, a rail or a
 * sweep follows. Gaps can be healed (the later curve's end moves onto the earlier one's), and the path can be joined into one
 * spline so the single-curve sweep path picker can use it.
 */

type Open = Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>;

export interface PathSegment {
  readonly entityId: string;
  /** True when the path runs along this curve from its end to its start. */
  readonly reversed: boolean;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly lengthMm: number;
}

export interface PathGap {
  /** Index of the segment the gap follows (the last segment, for the gap that closes a loop). */
  readonly afterSegment: number;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly distanceMm: number;
  readonly at: Vec2;
}

export interface SketchPath {
  readonly segments: readonly PathSegment[];
  readonly closed: boolean;
  /** Joins that are not exactly coincident (within the maximum gap, so they were chained anyway). */
  readonly gaps: readonly PathGap[];
  /** Selected curves that could not be reached from the path. */
  readonly unlinkedIds: readonly string[];
  /** Points where more than one curve could have continued the path. */
  readonly branchPoints: readonly Vec2[];
  /** True when every selected curve is on the path. */
  readonly complete: boolean;
  readonly lengthMm: number;
  /** The path as one ordered polyline (arcs and splines sampled). */
  readonly samples: readonly Vec2[];
}

export interface MakePathOptions {
  /** The largest gap that still counts as the same path. Defaults to a little over the sketch snap tolerance. */
  readonly maxGapMm?: number;
}

const COINCIDENT_MM = 1e-4;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function samplesOf(entity: Open): readonly Vec2[] {
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind === "arc") return sampleArc(entity.start, entity.mid, entity.end);
  return sampleSpline(entity.fitPoints);
}

function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += dist(points[index - 1]!, points[index]!);
  return total;
}

export function makePath(sketch: WorkbenchSketch, ids: readonly string[], options: MakePathOptions = {}): WorkbenchResult<SketchPath> {
  const found = ids.map((id) => sketch.entities.find((entity) => entity.id === id));
  if (found.length === 0 || found.some((entity) => entity === undefined)) return failure("INVALID_OPERATION", "Select the curves to chain into a path.", [], "Select lines, arcs or splines first.");
  const entities = found as SketchEntity[];
  const closedShapes = entities.filter((entity) => !isOpenCurve(entity));
  if (closedShapes.length > 0) return failure("INVALID_OPERATION", `A path is made of lines, arcs and splines; a ${closedShapes[0]!.kind} cannot be part of one.`, closedShapes.map((entity) => entity.id), "Remove it from the selection.");
  const items = entities as Open[];
  const maxGap = options.maxGapMm ?? Math.max(sketch.snapToleranceMm * 2, 1.5);
  const endsOf = (item: Open): readonly [Vec2, Vec2] => [curveEnd(item, "first"), curveEnd(item, "last")];
  const degree = (item: Open, which: CurveEnd): number => {
    const point = curveEnd(item, which);
    return items.filter((other) => other !== item).reduce((count, other) => count + endsOf(other).filter((end) => dist(end, point) <= maxGap).length, 0);
  };

  // Start at a free end if there is one (the first in selection order); otherwise the selection is a ring, so start anywhere.
  let startItem = items[0]!;
  let startEnd: CurveEnd = "first";
  let freeFound = false;
  for (const item of items) {
    for (const which of ["first", "last"] as const) {
      if (!freeFound && degree(item, which) === 0) { startItem = item; startEnd = which; freeFound = true; }
    }
  }
  const used = new Set<string>();
  const segments: PathSegment[] = [];
  const gaps: PathGap[] = [];
  const branchPoints: Vec2[] = [];
  const samples: Vec2[] = [];
  const addSegment = (item: Open, enter: CurveEnd): Vec2 => {
    used.add(item.id);
    const reversed = enter === "last";
    const along = reversed ? [...samplesOf(item)].reverse() : samplesOf(item);
    for (const point of along) if (samples.length === 0 || dist(samples[samples.length - 1]!, point) > 1e-9) samples.push(point);
    const from = along[0]!;
    const to = along[along.length - 1]!;
    segments.push({ entityId: item.id, reversed, from, to, lengthMm: polylineLength(along) });
    return to;
  };
  let exit = addSegment(startItem, startEnd);
  for (;;) {
    const candidates = items
      .filter((item) => !used.has(item.id))
      .flatMap((item) => (["first", "last"] as const).map((which) => ({ item, which, gap: dist(curveEnd(item, which), exit) })))
      .filter((candidate) => candidate.gap <= maxGap)
      .sort((a, b) => a.gap - b.gap);
    const next = candidates[0];
    if (next === undefined) break;
    if (candidates.filter((candidate) => candidate.item.id !== next.item.id && candidate.gap <= Math.max(next.gap, COINCIDENT_MM) + COINCIDENT_MM).length > 0) branchPoints.push(exit);
    if (next.gap > COINCIDENT_MM) gaps.push({ afterSegment: segments.length - 1, fromEntityId: segments[segments.length - 1]!.entityId, toEntityId: next.item.id, distanceMm: next.gap, at: [(exit[0] + curveEnd(next.item, next.which)[0]) / 2, (exit[1] + curveEnd(next.item, next.which)[1]) / 2] });
    exit = addSegment(next.item, next.which);
  }
  const first = segments[0]!;
  const closed = segments.length >= 2 && dist(exit, first.from) <= maxGap;
  if (closed) {
    const closing = dist(exit, first.from);
    if (closing > COINCIDENT_MM) gaps.push({ afterSegment: segments.length - 1, fromEntityId: segments[segments.length - 1]!.entityId, toEntityId: first.entityId, distanceMm: closing, at: [(exit[0] + first.from[0]) / 2, (exit[1] + first.from[1]) / 2] });
  }
  const unlinkedIds = items.filter((item) => !used.has(item.id)).map((item) => item.id);
  return {
    ok: true,
    value: { segments, closed, gaps, unlinkedIds, branchPoints, complete: unlinkedIds.length === 0, lengthMm: segments.reduce((sum, segment) => sum + segment.lengthMm, 0), samples }
  };
}

/** One line per fact worth showing about a path: order, length, gaps, branches, curves left out. */
export function describePath(path: SketchPath): readonly string[] {
  const lines = [`${path.segments.length} curve${path.segments.length === 1 ? "" : "s"} chained into ${path.closed ? "a closed loop" : "an open path"}, ${Math.round(path.lengthMm * 100) / 100} mm long.`];
  for (const gap of path.gaps) lines.push(`Gap of ${Math.round(gap.distanceMm * 1000) / 1000} mm between ${gap.fromEntityId.replace(/^entity:/u, "")} and ${gap.toEntityId.replace(/^entity:/u, "")}.`);
  for (const point of path.branchPoints) lines.push(`Branch at (${Math.round(point[0] * 1000) / 1000}, ${Math.round(point[1] * 1000) / 1000}) mm: more than one curve continues from there.`);
  if (path.unlinkedIds.length > 0) lines.push(`${path.unlinkedIds.length} selected curve${path.unlinkedIds.length === 1 ? " is" : "s are"} not connected to the path: ${path.unlinkedIds.map((id) => id.replace(/^entity:/u, "")).join(", ")}.`);
  return lines;
}

/**
 * Closes every gap in the path: the later curve's end moves onto the earlier curve's end, and line ends are joined with a coincident
 * relation. The path's first curve does not move (except to close a loop).
 */
export function healPathGaps(context: SketchEditContext, path: SketchPath): SketchEditResult {
  if (path.gaps.length === 0) return failure("INVALID_OPERATION", "The path has no gaps to close.", [], "Nothing to do.");
  const sketch = context.sketch;
  const entity = (id: string): Open => sketch.entities.find((candidate) => candidate.id === id) as Open;
  const updates = new Map<string, SketchEntity>();
  const constraints: WorkbenchSketchConstraint[] = [];
  for (const gap of path.gaps) {
    const earlier = path.segments[gap.afterSegment]!;
    const later = path.segments.find((segment) => segment.entityId === gap.toEntityId)!;
    const target = earlier.to;
    // The path enters the later curve at its start unless the segment is reversed.
    const enterEnd: CurveEnd = later.reversed ? "last" : "first";
    const current = (updates.get(later.entityId) ?? entity(later.entityId)) as Open;
    const moved = withCurveEnd(current, enterEnd, target);
    if (moved === undefined) return failure("INVALID_OPERATION", `Closing the gap would collapse ${later.entityId.replace(/^entity:/u, "")}.`, [later.entityId], "Close that gap by hand.");
    updates.set(later.entityId, moved);
    const joint = jointBetween(context, entity(earlier.entityId), earlier.reversed ? "first" : "last", moved, enterEnd);
    if (joint !== undefined) constraints.push(joint);
  }
  const result = editPlan(`Closed ${path.gaps.length} gap${path.gaps.length === 1 ? "" : "s"} in the path`, { updateEntities: [...updates.values()], addConstraints: constraints });
  if (!result.ok) return result;
  const check = planHolds(sketch, result.value);
  return check.ok ? result : failure("CONSTRAINT_CONFLICT", `Closing the gaps conflicts with a sketch relation. ${check.reason}`, [...updates.keys()], "Relax Relations on the curves, then try again.");
}

/**
 * Joins the path into a single new spline that passes through every joint of the chain, so it can be picked as a sweep path (the sweep
 * takes one curve). The spline is smooth, so a sharp corner in the chain becomes a tight bend; the original curves are kept.
 */
export function pathToSpline(context: SketchEditContext, path: SketchPath): SketchEditResult {
  if (path.segments.length < 1) return failure("INVALID_OPERATION", "The path is empty.", [], "Select curves first.");
  const corners: Vec2[] = [];
  const extras: Vec2[][] = [];
  path.segments.forEach((segment, index) => {
    corners.push(segment.from);
    const entity = context.sketch.entities.find((candidate) => candidate.id === segment.entityId) as Open;
    const along = segment.reversed ? [...samplesOf(entity)].reverse() : samplesOf(entity);
    const inside: Vec2[] = [];
    if (entity.kind !== "line" && along.length > 3) {
      for (const fraction of [1 / 3, 2 / 3]) inside.push(along[Math.round(fraction * (along.length - 1))]!);
    } else if (entity.kind === "line" && path.segments.length === 1) inside.push([(segment.from[0] + segment.to[0]) / 2, (segment.from[1] + segment.to[1]) / 2]);
    extras[index] = inside;
  });
  const last = path.segments[path.segments.length - 1]!;
  const points: { readonly point: Vec2; readonly corner: boolean }[] = [];
  corners.forEach((corner, index) => {
    points.push({ point: corner, corner: true });
    for (const extra of extras[index] ?? []) points.push({ point: extra, corner: false });
  });
  points.push({ point: last.to, corner: true });
  let kept = points.filter((entry, index) => index === 0 || dist(entry.point, points[index - 1]!.point) > 0.05);
  if (kept.length > 24) {
    const spare = kept.filter((entry) => !entry.corner);
    let drop = kept.length - 24;
    // Drop the in-between samples first, evenly, so the corners that define the path stay.
    const dropEvery = Math.max(1, Math.floor(spare.length / Math.max(drop, 1)));
    const removed = new Set<{ readonly point: Vec2; readonly corner: boolean }>();
    for (let index = 0; index < spare.length && drop > 0; index += dropEvery) { removed.add(spare[index]!); drop -= 1; }
    kept = kept.filter((entry) => !removed.has(entry));
  }
  if (kept.length > 24) return failure("INVALID_OPERATION", `The path has ${kept.length} joints and a spline holds at most 24 fit points.`, path.segments.map((segment) => segment.entityId), "Chain fewer curves, or simplify the path.");
  if (kept.length < 3) return failure("INVALID_OPERATION", "The path is too short to become a spline.", path.segments.map((segment) => segment.entityId), "Select more curves.");
  const spline: SketchEntity = { id: context.newId("entity"), kind: "spline", fitPoints: kept.map((entry) => entry.point), construction: false };
  return editPlan(`Joined the path into one spline through ${kept.length} points`, { addEntities: [spline] });
}
