import type { ConstructionBinder, ConstructionEdgeRef, ConstructionPathRef, ConstructionPlaneDefinition, GeneralSolidBody, Vec3 } from "../../workbench-core/src/index.js";
import { matchBodyEdge, resolveBinder } from "./construction-binders.js";
import type { ConstructionPlaneFrame } from "./construction-geometry.js";

/**
 * Plane through two edges and plane along a path. These evaluate to the same oriented frame as every other construction plane
 * (origin, unit normal, two unit in-plane axes with u x v = normal, a drawn half-size).
 */

/** What the two planes need from the rest of the part. */
export interface PlaneContext {
  /** A construction axis as a segment: its two ends, or an error when it is missing or cannot be evaluated. */
  readonly axisSegment: (axisId: string) => { readonly a: Vec3; readonly b: Vec3; readonly name: string } | { readonly error: string };
  readonly bodies: readonly GeneralSolidBody[];
  readonly binders: readonly ConstructionBinder[];
}

const DEFAULT_HALF_SIZE_MM = 60;
/** Two edges closer to parallel than this (sin of the angle between them, about 1 degree) are treated as parallel. */
const PARALLEL_SIN = 0.0175;
/** How far apart two lines may be at their closest and still count as crossing. */
const CROSSING_TOLERANCE_MM = 0.01;

interface ResolvedEdge { readonly a: Vec3; readonly b: Vec3; readonly label: string }

export function planeFromDefinition(definition: Extract<ConstructionPlaneDefinition, { kind: "through-two-edges" | "along-path" }>, context: PlaneContext): ConstructionPlaneFrame | { readonly error: string } {
  return definition.kind === "through-two-edges" ? planeThroughTwoEdges(definition.edgeA, definition.edgeB, context) : planeAlongPath(definition.path, definition.t, definition.orientation, context);
}

export function resolveEdgeRef(ref: ConstructionEdgeRef, context: PlaneContext): ResolvedEdge | { readonly error: string } {
  if (ref.kind === "segment") return { a: ref.a, b: ref.b, label: "typed edge" };
  if (ref.kind === "axis") {
    const segment = context.axisSegment(ref.axisId);
    return "error" in segment ? segment : { a: segment.a, b: segment.b, label: segment.name };
  }
  if (ref.kind === "binder") {
    const binder = context.binders.find((candidate) => candidate.id === ref.binderId);
    if (binder === undefined) return { error: "The binder this edge uses is no longer in the part." };
    const resolved = resolveBinder(binder, context.bodies);
    if ("error" in resolved) return resolved;
    if (resolved.kind !== "edge") return { error: `${binder.name} is not an edge binder.` };
    return { a: resolved.a, b: resolved.b, label: binder.name };
  }
  const body = context.bodies.find((candidate) => candidate.id === ref.bodyId);
  if (body === undefined) return { error: "The body this edge was picked on is no longer in the part." };
  const matched = matchBodyEdge(body, ref.a, ref.b);
  if (matched === undefined) return { error: `The edge picked on ${body.name} is no longer there: it was removed or moved too far.` };
  return { a: matched.a, b: matched.b, label: `edge of ${body.name}` };
}

export function planeThroughTwoEdges(edgeA: ConstructionEdgeRef, edgeB: ConstructionEdgeRef, context: PlaneContext): ConstructionPlaneFrame | { readonly error: string } {
  const first = resolveEdgeRef(edgeA, context);
  if ("error" in first) return first;
  const second = resolveEdgeRef(edgeB, context);
  if ("error" in second) return second;
  const d1 = unitOrUndefined(sub(first.b, first.a));
  const d2 = unitOrUndefined(sub(second.b, second.a));
  if (d1 === undefined || d2 === undefined) return { error: "One of the two edges has no length." };
  const between = sub(second.a, first.a);
  const c = cross(d1, d2);
  const sine = length(c);
  let normal: Vec3; let uAxis: Vec3; let vAxis: Vec3;
  if (sine < PARALLEL_SIN) {
    const offset = sub(between, scale(d1, dot(between, d1)));
    const gap = length(offset);
    if (gap < CROSSING_TOLERANCE_MM) return { error: "The two edges lie on one line, which leaves the plane free to turn about it. Pick two edges that are side by side or cross." };
    uAxis = d1;
    vAxis = scale(offset, 1 / gap);
    normal = cross(uAxis, vAxis);
  } else {
    // The closest approach of two crossing lines is along c; the lines meet only when that gap is nothing.
    const gap = Math.abs(dot(between, c)) / sine;
    if (gap > CROSSING_TOLERANCE_MM) return { error: `The two edges are skew (${gap.toFixed(2)} mm apart at their closest), so no single plane contains both.` };
    normal = scale(c, 1 / sine);
    uAxis = d1;
    vAxis = cross(normal, uAxis);
  }
  // Centre the drawn quad on the four end points so it covers both edges.
  const ends = [first.a, first.b, second.a, second.b];
  const anchor = first.a;
  const us = ends.map((point) => dot(sub(point, anchor), uAxis));
  const vs = ends.map((point) => dot(sub(point, anchor), vAxis));
  const centreU = (Math.min(...us) + Math.max(...us)) / 2; const centreV = (Math.min(...vs) + Math.max(...vs)) / 2;
  const halfU = Math.max(DEFAULT_HALF_SIZE_MM / 2, 0.6 * (Math.max(...us) - Math.min(...us)));
  const halfV = Math.max(DEFAULT_HALF_SIZE_MM / 2, 0.6 * (Math.max(...vs) - Math.min(...vs)));
  const origin = add(anchor, add(scale(uAxis, centreU), scale(vAxis, centreV)));
  return { origin, normal, uAxis, vAxis, sizeMm: [halfU, halfV], description: `Through ${first.label} and ${second.label}` };
}

/** A path as a polyline with its running length. */
interface SampledPath { readonly points: readonly Vec3[]; readonly cumulative: readonly number[]; readonly totalMm: number }

function pathOf(ref: ConstructionPathRef, context: PlaneContext): SampledPath | { readonly error: string } {
  let raw: readonly Vec3[];
  if (ref.kind === "axis") {
    const segment = context.axisSegment(ref.axisId);
    if ("error" in segment) return segment;
    raw = [segment.a, segment.b];
  } else raw = ref.pointsMm;
  const points: Vec3[] = [];
  for (const point of raw) {
    const previous = points[points.length - 1];
    if (previous === undefined || length(sub(point, previous)) > 1e-9) points.push(point);
  }
  if (points.length < 2) return { error: "The path has no length." };
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1]! + length(sub(points[index]!, points[index - 1]!)));
  return { points, cumulative, totalMm: cumulative[cumulative.length - 1]! };
}

export function planeAlongPath(pathRef: ConstructionPathRef, t: number, orientation: "perpendicular" | "tangent", context: PlaneContext): ConstructionPlaneFrame | { readonly error: string } {
  if (!(t >= 0 && t <= 1)) return { error: "The position along the path must be between 0 and 1." };
  const path = pathOf(pathRef, context);
  if ("error" in path) return path;
  const sample = pathSample(path, t);
  const label = pathRef.kind === "axis" ? "axis" : "path";
  const percent = `${(t * 100).toFixed(t * 100 % 1 === 0 ? 0 : 1)}%`;
  if (orientation === "perpendicular") {
    const normal = sample.tangent;
    const reference: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const uAxis = unit(sub(reference, scale(normal, dot(reference, normal))));
    const vAxis = cross(normal, uAxis);
    return { origin: sample.point, normal, uAxis, vAxis, sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Perpendicular to ${label} at ${percent}` };
  }
  // Tangent: the plane holds the tangent and the direction the path bends towards (its osculating plane); a straight run has no
  // bend, so it holds the tangent and whichever world axis is least aligned with it.
  const tangent = sample.tangent;
  let inPlane = sub(sample.bend, scale(tangent, dot(sample.bend, tangent)));
  const bent = length(inPlane) > 1e-6;
  if (!bent) {
    const reference: Vec3 = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    inPlane = sub(reference, scale(tangent, dot(reference, tangent)));
  }
  const vAxis = unit(inPlane);
  const normal = cross(tangent, vAxis);
  return { origin: sample.point, normal, uAxis: tangent, vAxis, sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Tangent to ${label} at ${percent}${bent ? " (osculating)" : ""}` };
}

/** The point, smooth unit tangent and bend direction at fraction t of the path's length. */
function pathSample(path: SampledPath, t: number): { readonly point: Vec3; readonly tangent: Vec3; readonly bend: Vec3 } {
  const segments = path.points.length - 1;
  const target = t * path.totalMm;
  let index = 0;
  while (index < segments - 1 && path.cumulative[index + 1]! < target) index += 1;
  const start = path.cumulative[index]!; const end = path.cumulative[index + 1]!;
  const fraction = end - start < 1e-12 ? 0 : Math.min(1, Math.max(0, (target - start) / (end - start)));
  const a = path.points[index]!; const b = path.points[index + 1]!;
  const point: Vec3 = add(a, scale(sub(b, a), fraction));
  const tangentAt = (vertex: number): Vec3 => {
    const before = vertex > 0 ? unitOrUndefined(sub(path.points[vertex]!, path.points[vertex - 1]!)) : undefined;
    const after = vertex < segments ? unitOrUndefined(sub(path.points[vertex + 1]!, path.points[vertex]!)) : undefined;
    if (before === undefined) return after ?? [1, 0, 0];
    if (after === undefined) return before;
    return unitOrUndefined(add(before, after)) ?? after;
  };
  const t0 = tangentAt(index); const t1 = tangentAt(index + 1);
  const tangent = unitOrUndefined(add(scale(t0, 1 - fraction), scale(t1, fraction))) ?? t0;
  // How fast the tangent turns across this segment, pointing at the inside of the bend.
  const bend = sub(t1, t0);
  return { point, tangent, bend };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unitOrUndefined = (a: Vec3): Vec3 | undefined => { const l = length(a); return l < 1e-12 ? undefined : [a[0] / l, a[1] / l, a[2] / l]; };
const unit = (a: Vec3): Vec3 => unitOrUndefined(a) ?? [0, 0, 1];
