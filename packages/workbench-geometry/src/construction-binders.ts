import type { ConstructionBinder, ConstructionBinderTarget, GeneralSolidBody, Vec3 } from "../../workbench-core/src/index.js";
import { solidMetrics } from "../../workbench-core/src/solid-metrics.js";
import { pickableEdges } from "./mesh-modify.js";
import type { PlaneFrame } from "./sketch-placement.js";
import type { ConstructionPlaneFrame } from "./construction-geometry.js";

/**
 * Shape and sub-shape binders. A binder is a stored pointer (body id, plus a face key or an edge's end points) that is
 * re-resolved against the body's current mesh every time it is evaluated, so it follows the body through a timeline rebuild.
 *
 * A face is found first by the body's own stable face key (kernel-built bodies carry `brep.faces[].key`, anchored to the
 * profile entity that made the face, so it survives a change of height or a moved sketch). When the key is gone, or the body
 * has no named faces, the face is found again from what was recorded about it: its normal, centre and area.
 */

export interface BinderBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export type BinderResolution =
  | { readonly kind: "body"; readonly bodyId: string; readonly boundsMm: BinderBounds; readonly centroidMm: Vec3; readonly volumeMm3: number; readonly description: string }
  | {
    readonly kind: "face";
    readonly bodyId: string;
    readonly faceKey: string;
    readonly matchedBy: "key" | "fingerprint";
    readonly planar: boolean;
    readonly normal: Vec3;
    readonly centroidMm: Vec3;
    readonly areaMm2: number;
    readonly frame: ConstructionPlaneFrame | undefined;
    readonly description: string;
  }
  | { readonly kind: "edge"; readonly bodyId: string; readonly a: Vec3; readonly b: Vec3; readonly matchedBy: "exact" | "nearest"; readonly description: string };

export type BinderError = { readonly error: string };

/** A face of a body: the triangles that make it and what they add up to. */
export interface BodyFace {
  readonly key: string;
  readonly triangles: readonly number[];
  readonly normal: Vec3;
  readonly centroidMm: Vec3;
  readonly areaMm2: number;
  readonly planar: boolean;
}

const ALIGNED_COS = 0.9998;
const WELD_MM = 1e-4;

export function resolveBinder(binder: ConstructionBinder, bodies: readonly GeneralSolidBody[]): BinderResolution | BinderError {
  const target = binder.target;
  const body = bodies.find((candidate) => candidate.id === target.bodyId);
  if (body === undefined) return { error: `The body ${binder.name} points at is no longer in the part.` };
  if (target.kind === "body") {
    const metrics = solidMetrics(body.positionsMm, body.indices);
    return { kind: "body", bodyId: body.id, boundsMm: metrics.boundsMm, centroidMm: metrics.centroidMm, volumeMm3: metrics.volumeMm3, description: `Shape of ${body.name}` };
  }
  if (target.kind === "edge") return resolveEdge(body, target.a, target.b, binder.name);
  return resolveFace(body, target, binder.name);
}

function resolveFace(body: GeneralSolidBody, target: Extract<ConstructionBinderTarget, { kind: "face" }>, name: string): BinderResolution | BinderError {
  const faces = bodyFaces(body);
  let found: BodyFace | undefined;
  let matchedBy: "key" | "fingerprint" = "fingerprint";
  if (target.faceKey !== "" && body.brep !== undefined) {
    found = faces.find((face) => face.key === target.faceKey);
    if (found !== undefined) matchedBy = "key";
  }
  if (found === undefined) {
    const reach = Math.max(10, 3 * Math.sqrt(target.areaMm2));
    let best = Infinity;
    for (const face of faces) {
      if (!face.planar || dot(face.normal, target.normal) < 0.98) continue;
      const ratio = target.areaMm2 < 1e-9 ? 1 : face.areaMm2 / target.areaMm2;
      if (ratio < 0.2 || ratio > 5) continue;
      const distance = Math.hypot(face.centroidMm[0] - target.centroidMm[0], face.centroidMm[1] - target.centroidMm[1], face.centroidMm[2] - target.centroidMm[2]);
      if (distance <= reach && distance < best) { best = distance; found = face; }
    }
  }
  if (found === undefined) return { error: `${name} no longer finds its face on ${body.name}: the face was removed or moved too far from where it was picked.` };
  const frame = found.planar ? faceFrame(body, found) : undefined;
  return {
    kind: "face",
    bodyId: body.id,
    faceKey: found.key,
    matchedBy,
    planar: found.planar,
    normal: found.normal,
    centroidMm: found.centroidMm,
    areaMm2: found.areaMm2,
    frame,
    description: `${found.planar ? "Face" : "Curved face"} of ${body.name} (${found.areaMm2.toFixed(1)} mm², matched by ${matchedBy})`
  };
}

function resolveEdge(body: GeneralSolidBody, a: Vec3, b: Vec3, name: string): BinderResolution | BinderError {
  const matched = matchBodyEdge(body, a, b);
  if (matched === undefined) return { error: `${name} no longer finds its edge on ${body.name}: the edge was removed or moved too far.` };
  return { kind: "edge", bodyId: body.id, a: matched.a, b: matched.b, matchedBy: matched.exact ? "exact" : "nearest", description: `Edge of ${body.name} (${length(sub(matched.b, matched.a)).toFixed(1)} mm)` };
}

/**
 * Finds the straight edge of the body that sits where a recorded edge was: among the sharp edges that run the same way
 * (within about 11 degrees) and are about as long (within a quarter either way), the one whose two end points are closest to
 * the recorded ones (either order), as long as each end has not moved by more than half the edge's length (and at least 1 mm).
 */
export function matchBodyEdge(body: GeneralSolidBody, a: Vec3, b: Vec3): { readonly a: Vec3; readonly b: Vec3; readonly exact: boolean } | undefined {
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices });
  if (typeof edges === "string") return undefined;
  const span = length(sub(b, a));
  const direction = unit(sub(b, a));
  let best: { a: Vec3; b: Vec3; cost: number } | undefined;
  for (const edge of edges) {
    const edgeSpan = length(sub(edge.b, edge.a));
    if (Math.abs(dot(unit(sub(edge.b, edge.a)), direction)) < 0.98 || edgeSpan < span * 0.75 || edgeSpan > span * 1.25) continue;
    const forward = length(sub(edge.a, a)) + length(sub(edge.b, b));
    const backward = length(sub(edge.a, b)) + length(sub(edge.b, a));
    const cost = Math.min(forward, backward);
    if (best === undefined || cost < best.cost) best = forward <= backward ? { a: edge.a, b: edge.b, cost } : { a: edge.b, b: edge.a, cost };
  }
  if (best === undefined || best.cost > 2 * Math.max(1, 0.5 * span)) return undefined;
  return { a: best.a, b: best.b, exact: best.cost < 1e-3 };
}

/** The faces of a body: its named kernel faces when it has them, else planar regions found from the mesh. */
export function bodyFaces(body: GeneralSolidBody): readonly BodyFace[] {
  if (body.brep !== undefined && body.brep.faceTriangles.length === body.indices.length / 3) {
    const groups = new Map<number, number[]>();
    body.brep.faceTriangles.forEach((face, triangle) => {
      if (face < 0) return;
      const bucket = groups.get(face);
      if (bucket === undefined) groups.set(face, [triangle]); else bucket.push(triangle);
    });
    const faces: BodyFace[] = [];
    for (const [faceIndex, triangles] of groups) {
      const key = body.brep.faces[faceIndex]?.key;
      if (key === undefined) continue;
      faces.push(summarize(body, key, triangles));
    }
    return faces;
  }
  return meshRegions(body).map((triangles, index) => summarize(body, `region:${index}`, triangles));
}

/** The face a click landed on: the face holding the triangle nearest to the point. */
export function nearestBodyFace(body: GeneralSolidBody, pointMm: Vec3): BodyFace | undefined {
  const faces = bodyFaces(body);
  let best: BodyFace | undefined; let bestDistance = Infinity;
  for (const face of faces) {
    for (const triangle of face.triangles) {
      const distance = distanceToTriangle(body, triangle, pointMm);
      if (distance < bestDistance) { bestDistance = distance; best = face; }
    }
  }
  return best;
}

/** Records a face of a body as a binder target. A face without a name in the body (no kernel faces) is recorded by its key "" and its fingerprint. */
export function faceTargetOf(body: GeneralSolidBody, face: BodyFace): Extract<ConstructionBinderTarget, { kind: "face" }> {
  return { kind: "face", bodyId: body.id, faceKey: body.brep === undefined ? "" : face.key, normal: face.normal, centroidMm: face.centroidMm, areaMm2: face.areaMm2 };
}

/** The sketch frame of a planar face: origin at its centre, X along the world axis that lies most in the plane, normal pointing out of the body. */
export function planeFrameOfFace(resolution: BinderResolution): PlaneFrame | undefined {
  if (resolution.kind !== "face" || resolution.frame === undefined) return undefined;
  return { originMm: resolution.frame.origin, uAxis: resolution.frame.uAxis, normal: resolution.frame.normal };
}

function summarize(body: GeneralSolidBody, key: string, triangles: readonly number[]): BodyFace {
  let area = 0; let nx = 0; let ny = 0; let nz = 0; let cx = 0; let cy = 0; let cz = 0;
  for (const triangle of triangles) {
    const [p, q, r] = corners(body, triangle);
    const cross = crossOf(sub(q, p), sub(r, p));
    const twice = length(cross);
    area += twice / 2;
    nx += cross[0]; ny += cross[1]; nz += cross[2];
    cx += (p[0] + q[0] + r[0]) / 3 * twice; cy += (p[1] + q[1] + r[1]) / 3 * twice; cz += (p[2] + q[2] + r[2]) / 3 * twice;
  }
  const total = area * 2;
  const normalLength = Math.hypot(nx, ny, nz);
  const normal: Vec3 = normalLength < 1e-12 ? [0, 0, 1] : [nx / normalLength, ny / normalLength, nz / normalLength];
  const centroid: Vec3 = total < 1e-12 ? [0, 0, 0] : [cx / total, cy / total, cz / total];
  // Planar when every vertex of the face lies within a hair of the plane through its centre.
  let extent = 0; let deviation = 0;
  for (const triangle of triangles) {
    for (const point of corners(body, triangle)) {
      const offset = sub(point, centroid);
      extent = Math.max(extent, length(offset));
      deviation = Math.max(deviation, Math.abs(dot(offset, normal)));
    }
  }
  return { key, triangles, normal, centroidMm: centroid, areaMm2: area, planar: deviation <= 0.01 + 1e-5 * extent };
}

function faceFrame(body: GeneralSolidBody, face: BodyFace): ConstructionPlaneFrame {
  const normal = face.normal;
  const reference: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const along = dot(reference, normal);
  const uAxis = unit([reference[0] - along * normal[0], reference[1] - along * normal[1], reference[2] - along * normal[2]]);
  const vAxis = crossOf(normal, uAxis);
  let halfU = 0; let halfV = 0;
  for (const triangle of face.triangles) {
    for (const point of corners(body, triangle)) {
      const offset = sub(point, face.centroidMm);
      halfU = Math.max(halfU, Math.abs(dot(offset, uAxis)));
      halfV = Math.max(halfV, Math.abs(dot(offset, vAxis)));
    }
  }
  return { origin: face.centroidMm, normal, uAxis, vAxis, sizeMm: [Math.max(2, halfU * 1.05), Math.max(2, halfV * 1.05)], description: `Face of ${body.name}` };
}

/** Groups triangles into planar regions: neighbours across a shared edge whose normals agree and whose planes coincide. */
function meshRegions(body: GeneralSolidBody): readonly (readonly number[])[] {
  const count = Math.floor(body.indices.length / 3);
  const weld = new Map<string, number>();
  const vertexId = (index: number): number => {
    const key = `${Math.round(body.positionsMm[index * 3]! / WELD_MM)}:${Math.round(body.positionsMm[index * 3 + 1]! / WELD_MM)}:${Math.round(body.positionsMm[index * 3 + 2]! / WELD_MM)}`;
    let id = weld.get(key);
    if (id === undefined) { id = weld.size; weld.set(key, id); }
    return id;
  };
  const normals: Vec3[] = [];
  const offsets: number[] = [];
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => { let root = index; while (parent[root] !== root) root = parent[root]!; while (parent[index] !== root) { const next = parent[index]!; parent[index] = root; index = next; } return root; };
  const edgeOwner = new Map<string, number>();
  for (let triangle = 0; triangle < count; triangle += 1) {
    const [p, q, r] = corners(body, triangle);
    const cross = crossOf(sub(q, p), sub(r, p));
    const normal = length(cross) < 1e-12 ? ([0, 0, 1] as Vec3) : unit(cross);
    normals.push(normal);
    offsets.push(dot(normal, p));
  }
  for (let triangle = 0; triangle < count; triangle += 1) {
    const ids = [0, 1, 2].map((corner) => vertexId(body.indices[triangle * 3 + corner]!));
    for (let side = 0; side < 3; side += 1) {
      const u = ids[side]!; const v = ids[(side + 1) % 3]!;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const other = edgeOwner.get(key);
      if (other === undefined) { edgeOwner.set(key, triangle); continue; }
      if (dot(normals[triangle]!, normals[other]!) >= ALIGNED_COS && Math.abs(offsets[triangle]! - dot(normals[triangle]!, corners(body, other)[0])) < 0.01) parent[find(triangle)] = find(other);
    }
  }
  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < count; triangle += 1) {
    const root = find(triangle);
    const bucket = groups.get(root);
    if (bucket === undefined) groups.set(root, [triangle]); else bucket.push(triangle);
  }
  return [...groups.values()];
}

function corners(body: GeneralSolidBody, triangle: number): readonly [Vec3, Vec3, Vec3] {
  const at = (corner: number): Vec3 => {
    const index = body.indices[triangle * 3 + corner]! * 3;
    return [body.positionsMm[index]!, body.positionsMm[index + 1]!, body.positionsMm[index + 2]!];
  };
  return [at(0), at(1), at(2)];
}

function distanceToTriangle(body: GeneralSolidBody, triangle: number, point: Vec3): number {
  const [a, b, c] = corners(body, triangle);
  const closest = closestPointOnTriangle(point, a, b, c);
  return length(sub(point, closest));
}

/** Ericson, Real-Time Collision Detection: the point of a triangle closest to p. */
function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(p, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b); const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c); const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denominator = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)));
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossOf = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = length(a); return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]; };
