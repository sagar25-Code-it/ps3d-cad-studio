/**
 * Distances and angles for "to" terminations. An extrusion that ends at a face, a body or a vertex, and a revolve that runs until it
 * reaches a face, need a number; this module measures it from the target's current mesh, so the number can be measured again every time
 * the model is rebuilt. Everything here is pure geometry in world millimetres.
 */

type V3 = readonly [number, number, number];

export interface ExtentMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  /** For each triangle, the index of the B-rep face it belongs to. */
  readonly faceTriangles?: readonly number[];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, factor: number): V3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
function unit(a: V3): V3 | undefined {
  const size = length(a);
  return size < 1e-12 ? undefined : scale(a, 1 / size);
}

function vertexAt(mesh: ExtentMesh, index: number): V3 {
  return [mesh.positionsMm[index * 3]!, mesh.positionsMm[index * 3 + 1]!, mesh.positionsMm[index * 3 + 2]!];
}

/** The plane a B-rep face lies in. `planar` is false for a curved face, whose point and normal are only an average. */
export interface FacePlane {
  readonly pointMm: V3;
  /** Outward direction (triangles are wound outward). */
  readonly normal: V3;
  readonly planar: boolean;
  readonly areaMm2: number;
  readonly boundsMm: { readonly min: V3; readonly max: V3 };
}

/** Number of faces named by a mesh's `faceTriangles`. */
export function faceCountOf(mesh: ExtentMesh): number {
  let highest = -1;
  for (const face of mesh.faceTriangles ?? []) if (face > highest) highest = face;
  return highest + 1;
}

/** The area-weighted plane of one face, or undefined when the face has no triangles. */
export function facePlaneOf(mesh: ExtentMesh, faceIndex: number): FacePlane | undefined {
  const faceTriangles = mesh.faceTriangles;
  if (faceTriangles === undefined) return undefined;
  let area = 0;
  let normal: V3 = [0, 0, 0];
  let centroid: V3 = [0, 0, 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const used: V3[] = [];
  for (let triangle = 0; triangle < faceTriangles.length; triangle += 1) {
    if (faceTriangles[triangle] !== faceIndex) continue;
    const a = vertexAt(mesh, mesh.indices[triangle * 3]!);
    const b = vertexAt(mesh, mesh.indices[triangle * 3 + 1]!);
    const c = vertexAt(mesh, mesh.indices[triangle * 3 + 2]!);
    const weighted = scale(cross(sub(b, a), sub(c, a)), 0.5);
    const triangleArea = length(weighted);
    area += triangleArea;
    normal = add(normal, weighted);
    centroid = add(centroid, scale(add(add(a, b), c), triangleArea / 3));
    for (const vertex of [a, b, c]) {
      used.push(vertex);
      for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis]!, vertex[axis]!); max[axis] = Math.max(max[axis]!, vertex[axis]!); }
    }
  }
  if (area < 1e-12) return undefined;
  const facing = unit(normal);
  const point = scale(centroid, 1 / area);
  // A closed or strongly curved face sums to a short normal; a flat one keeps its whole area.
  let planar = facing !== undefined && length(normal) > area * 0.999;
  if (planar && facing !== undefined) {
    const span = Math.max(1, length(sub(max, min)));
    const tolerance = 1e-4 * span + 1e-4;
    planar = used.every((vertex) => Math.abs(dot(sub(vertex, point), facing)) <= tolerance);
  }
  return { pointMm: point, normal: facing ?? [0, 0, 1], planar, areaMm2: area, boundsMm: { min, max } };
}

/**
 * Points of a sketch profile to probe with: its corners, the centre, and the halfway points between them. A body or a curved face is
 * reached where the first of these rays arrives, which is what a flat end cap would meet first.
 */
export function footprintSamples(points: readonly V3[]): readonly V3[] {
  if (points.length === 0) return [];
  let centre: V3 = [0, 0, 0];
  for (const point of points) centre = add(centre, point);
  centre = scale(centre, 1 / points.length);
  const samples: V3[] = [centre];
  for (const point of points) { samples.push(point); samples.push(scale(add(point, centre), 0.5)); }
  return samples;
}

/** Distance along `direction` from `origin` to the first triangle hit (Moller-Trumbore), or undefined. */
function rayHit(mesh: ExtentMesh, origin: V3, direction: V3, accept: (triangle: number) => boolean, minDistance: number): number | undefined {
  let best: number | undefined;
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle += 1) {
    if (!accept(triangle)) continue;
    const a = vertexAt(mesh, mesh.indices[triangle * 3]!);
    const b = vertexAt(mesh, mesh.indices[triangle * 3 + 1]!);
    const c = vertexAt(mesh, mesh.indices[triangle * 3 + 2]!);
    const edge1 = sub(b, a);
    const edge2 = sub(c, a);
    const p = cross(direction, edge2);
    const determinant = dot(edge1, p);
    if (Math.abs(determinant) < 1e-12) continue;
    const inverse = 1 / determinant;
    const toOrigin = sub(origin, a);
    const u = dot(toOrigin, p) * inverse;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = cross(toOrigin, edge1);
    const v = dot(direction, q) * inverse;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = dot(edge2, q) * inverse;
    if (t > minDistance && (best === undefined || t < best)) best = t;
  }
  return best;
}

export type ExtentDistance =
  | {
    readonly ok: true;
    /** The distance for a flat end cap: the shortest reach of the profile. For a flat face parallel to the profile this is the distance. */
    readonly nearMm: number;
    /** The longest reach of the profile. It differs from `nearMm` for a face that is not parallel to the profile. */
    readonly farMm: number;
    /** Set for a flat face that is not parallel to the profile: extrude `farMm`, then remove what lies beyond this plane. */
    readonly trim?: { readonly pointMm: V3; readonly beyondNormal: V3 };
  }
  | { readonly ok: false; readonly message: string };

const PARALLEL_TOLERANCE = 1e-6;

/** How far along `direction` a profile (given by sample points on its plane) reaches a face. A flat face is treated as the plane it lies in. */
export function distanceToFace(mesh: ExtentMesh, faceIndex: number, samples: readonly V3[], direction: V3): ExtentDistance {
  const heading = unit(direction);
  const plane = facePlaneOf(mesh, faceIndex);
  if (heading === undefined || plane === undefined) return { ok: false, message: "The face to extrude to is empty." };
  if (samples.length === 0) return { ok: false, message: "The profile has no points to measure from." };
  if (plane.planar) {
    const alignment = dot(heading, plane.normal);
    if (Math.abs(alignment) < 1e-4) return { ok: false, message: "The face runs parallel to the extrusion direction, so the extrusion can never reach it." };
    let nearMm = Infinity;
    let farMm = -Infinity;
    for (const sample of samples) {
      const reach = dot(sub(plane.pointMm, sample), plane.normal) / alignment;
      if (reach < nearMm) nearMm = reach;
      if (reach > farMm) farMm = reach;
    }
    if (!(nearMm > 1e-6)) return { ok: false, message: nearMm > -1e-6 ? "The sketch already lies on that face, so there is no distance to extrude." : "That face is behind the sketch plane in this direction. Flip the direction to extrude toward it." };
    const tilted = farMm - nearMm > 1e-4 * Math.max(1, farMm);
    return tilted
      ? { ok: true, nearMm, farMm, trim: { pointMm: plane.pointMm, beyondNormal: alignment > 0 ? plane.normal : scale(plane.normal, -1) } }
      : { ok: true, nearMm, farMm };
  }
  const faceTriangles = mesh.faceTriangles;
  const hits = samples.flatMap((sample) => { const hit = rayHit(mesh, sample, heading, (triangle) => faceTriangles?.[triangle] === faceIndex, 1e-6); return hit === undefined ? [] : [hit]; });
  if (hits.length === 0) return { ok: false, message: "The profile does not face that curved face in this direction, so the extrusion would never reach it." };
  return { ok: true, nearMm: Math.min(...hits), farMm: Math.max(...hits) };
}

/** How far along `direction` a profile reaches a body: where its first ray meets the body's surface. */
export function distanceToBody(mesh: ExtentMesh, samples: readonly V3[], direction: V3): ExtentDistance {
  const heading = unit(direction);
  if (heading === undefined) return { ok: false, message: "The extrusion has no direction." };
  const hits = samples.flatMap((sample) => { const hit = rayHit(mesh, sample, heading, () => true, 1e-6); return hit === undefined ? [] : [hit]; });
  if (hits.length === 0) return { ok: false, message: "The profile does not face that solid in this direction, so the extrusion would never reach it. Flip the direction, or pick a solid in front of the sketch." };
  return { ok: true, nearMm: Math.min(...hits), farMm: Math.max(...hits) };
}

/** How far along `direction` a point lies from the sketch plane (any sample on it). */
export function distanceToPoint(pointMm: V3, origin: V3, direction: V3): ExtentDistance {
  const heading = unit(direction);
  if (heading === undefined) return { ok: false, message: "The extrusion has no direction." };
  const reach = dot(sub(pointMm, origin), heading);
  if (!(reach > 1e-6)) return { ok: false, message: reach > -1e-6 ? "The vertex lies on the sketch plane, so there is no distance to extrude." : "That vertex is behind the sketch plane in this direction. Flip the direction to extrude toward it." };
  return { ok: true, nearMm: reach, farMm: reach };
}

/** An axis-aligned-in-its-own-frame box covering everything past `pointMm` on the `beyondNormal` side of a plane, for trimming an extrusion to a tilted face. */
export function halfSpaceBox(pointMm: V3, beyondNormal: V3, halfSizeMm: number, depthMm = 2 * halfSizeMm): { readonly positionsMm: readonly number[]; readonly indices: readonly number[] } {
  const n = unit(beyondNormal) ?? [0, 0, 1];
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(n, helper))!;
  const v = cross(n, u);
  const corners: V3[] = [];
  for (const depth of [0, 1]) for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    corners.push(add(add(add(pointMm, scale(u, su * halfSizeMm)), scale(v, sv * halfSizeMm)), scale(n, depth * depthMm)));
  }
  // u x v = n, so the near ring (depth 0) runs counter-clockwise seen from +n; outward faces are wound accordingly.
  const indices = [
    0, 2, 1, 0, 3, 2, // face at the plane (outward = -n)
    4, 5, 6, 4, 6, 7, // far face (outward = +n)
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7
  ];
  return { positionsMm: corners.flatMap((corner) => [corner[0], corner[1], corner[2]]), indices };
}

/** Rotates points right-handed by `angleRad` about the line through `axisPoint` along `axis`. */
export function rotateAboutAxis(positionsMm: readonly number[], axisPoint: V3, axis: V3, angleRad: number): number[] {
  const k = unit(axis);
  if (k === undefined || angleRad === 0) return [...positionsMm];
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const out: number[] = [];
  for (let index = 0; index + 2 < positionsMm.length; index += 3) {
    const w = sub([positionsMm[index]!, positionsMm[index + 1]!, positionsMm[index + 2]!], axisPoint);
    const along = dot(k, w);
    const perpendicular = sub(w, scale(k, along));
    const turned = add(add(scale(perpendicular, cos), scale(cross(k, perpendicular), sin)), scale(k, along));
    out.push(axisPoint[0] + turned[0], axisPoint[1] + turned[1], axisPoint[2] + turned[2]);
  }
  return out;
}

export type RevolveReach =
  | { readonly ok: true; readonly angleDeg: number }
  | { readonly ok: false; readonly message: string };

/**
 * The angle a profile turns through before it reaches a flat face. `profilePoints` are the profile's corners in world space, `sweepAxis`
 * is the axis the profile turns right-handed about, and the face is the target's. For each corner the first turn that lands it on the
 * face (not merely on the face's plane) is found; "first" stops when the first corner arrives, "last" when the last corner has.
 */
export function revolveAngleToFace(mesh: ExtentMesh, faceIndex: number, profilePoints: readonly V3[], axisPoint: V3, sweepAxis: V3, pick: "first" | "last"): RevolveReach {
  const plane = facePlaneOf(mesh, faceIndex);
  const k = unit(sweepAxis);
  if (plane === undefined || k === undefined) return { ok: false, message: "The face to revolve to is empty." };
  if (!plane.planar) return { ok: false, message: "Revolve can run to a flat face. Pick a planar face." };
  const n = plane.normal;
  const diagonal = length(sub(plane.boundsMm.max, plane.boundsMm.min));
  const margin = 1e-3 + 0.02 * diagonal;
  const inside = (point: V3): boolean => [0, 1, 2].every((axis) => point[axis]! >= plane.boundsMm.min[axis]! - margin && point[axis]! <= plane.boundsMm.max[axis]! + margin);
  const arrivals: number[] = [];
  for (const p of profilePoints) {
    const w = sub(p, axisPoint);
    const along = dot(k, w);
    const perpendicular = sub(w, scale(k, along));
    const a = dot(n, perpendicular);
    const b = dot(n, cross(k, perpendicular));
    const c = dot(n, sub(plane.pointMm, axisPoint)) - dot(n, scale(k, along));
    // a cos(t) + b sin(t) = c  ->  r cos(t - phi) = c.
    const radius = Math.hypot(a, b);
    if (radius < 1e-9 || Math.abs(c) > radius + 1e-9) continue;
    const phi = Math.atan2(b, a);
    const spread = Math.acos(Math.max(-1, Math.min(1, c / radius)));
    const candidates = [phi + spread, phi - spread].map((angle) => { let wrapped = angle % (2 * Math.PI); if (wrapped < 0) wrapped += 2 * Math.PI; return wrapped; }).sort((x, y) => x - y);
    for (const turn of candidates) {
      if (turn < 1e-6) continue;
      const landed = add(axisPoint, add(add(scale(perpendicular, Math.cos(turn)), scale(cross(k, perpendicular), Math.sin(turn))), scale(k, along)));
      if (inside(landed)) { arrivals.push(turn); break; }
    }
  }
  if (arrivals.length === 0) return { ok: false, message: "The profile never reaches that face when it is revolved this way. Pick a face in the path of the profile, or flip the direction." };
  const turn = pick === "first" ? Math.min(...arrivals) : Math.max(...arrivals);
  const angleDeg = (turn * 180) / Math.PI;
  if (angleDeg < 1) return { ok: false, message: "The profile is already against that face, so there is less than 1 degree left to revolve." };
  return { ok: true, angleDeg: Math.min(360, angleDeg) };
}
