/**
 * Faces of a tessellated body, found from the mesh alone.
 *
 * The kernel keeps no exact faces after a Boolean, so a "face" here is a connected run of coplanar triangles (a flat region).
 * Regions that are single facets of a curved surface (a cylinder wall, a dome) are marked `curved`, because moving one facet
 * alone would not move the surface. A face picked in the viewport is named by a point on it and its outward direction, and is
 * found again after the body is edited by looking for the flat region that looks the same way and lies nearest that point.
 *
 * `movePlanes` is the common engine for shell, draft, offset region and replace face: it gives chosen regions a new plane and
 * puts every vertex where the planes of the regions around it now meet, so every other face stays exactly where it was.
 */

export type V3 = readonly [number, number, number];

export interface MeshLike {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

/** A picked face: a point on it and the way it looks (outward). */
export interface FaceRefLike {
  readonly pointMm: V3;
  readonly normalMm: V3;
}

export interface FaceRegion {
  readonly id: number;
  readonly triangles: readonly number[];
  /** Outward unit normal of the region's plane. */
  readonly normal: V3;
  /** The plane is `normal · x = offset`. */
  readonly offset: number;
  readonly areaMm2: number;
  readonly centroidMm: V3;
  /** True when the region is one facet of a smoothly curved surface, which cannot be moved on its own. */
  readonly curved: boolean;
}

export interface FaceAnalysis {
  /** Welded vertex id for each vertex of the mesh. */
  readonly weld: readonly number[];
  readonly weldedPositions: readonly V3[];
  readonly triangleRegion: readonly number[];
  readonly regions: readonly FaceRegion[];
  /** For each welded vertex, the ids of the regions that meet there. */
  readonly vertexRegions: readonly (readonly number[])[];
  readonly diagonalMm: number;
  readonly volumeMm3: number;
}

export interface PlaneLike {
  readonly normal: V3;
  readonly offset: number;
}

const WELD_QUANTUM = 1e-5;
const COPLANAR_COS = Math.cos((0.3 * Math.PI) / 180);
const SMOOTH_COS = Math.cos((30 * Math.PI) / 180);

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function unit(a: V3): V3 | undefined {
  const l = length(a);
  return l < 1e-12 ? undefined : [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Welds the vertices, finds the flat regions and checks that the mesh is a closed, outward solid. Returns a message instead
 * when it is not, because every edit built on this assumes a watertight body.
 */
export function analyzeFaces(mesh: MeshLike): FaceAnalysis | string {
  const { positionsMm, indices } = mesh;
  if (positionsMm.length < 9 || indices.length < 3 || positionsMm.length % 3 !== 0 || indices.length % 3 !== 0) return "The body has no mesh to work on.";
  const vertexCount = positionsMm.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const weld: number[] = new Array(vertexCount);
  const weldedPositions: V3[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positionsMm[i * 3]!;
    const y = positionsMm[i * 3 + 1]!;
    const z = positionsMm[i * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return "The body has a vertex that is not a finite point.";
    for (let k = 0; k < 3; k += 1) { const v = positionsMm[i * 3 + k]!; if (v < min[k]!) min[k] = v; if (v > max[k]!) max[k] = v; }
    const key = `${Math.round(x / WELD_QUANTUM)},${Math.round(y / WELD_QUANTUM)},${Math.round(z / WELD_QUANTUM)}`;
    let id = byKey.get(key);
    if (id === undefined) { id = weldedPositions.length; byKey.set(key, id); weldedPositions.push([x, y, z]); }
    weld[i] = id;
  }
  const diagonalMm = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  const triangleCount = indices.length / 3;
  const tri: [number, number, number][] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const a = weld[indices[t * 3]!];
    const b = weld[indices[t * 3 + 1]!];
    const c = weld[indices[t * 3 + 2]!];
    if (a === undefined || b === undefined || c === undefined) return "A triangle names a vertex that is not in the body.";
    tri.push([a, b, c]);
  }
  // Closed and consistently wound: every directed edge has exactly one partner running the other way.
  const W = weldedPositions.length;
  const owner = new Map<number, number>();
  const neighbour: number[] = new Array(triangleCount * 3).fill(-1);
  for (let t = 0; t < triangleCount; t += 1) {
    const [a, b, c] = tri[t]!;
    if (a === b || b === c || a === c) continue;
    const corners = [a, b, c];
    for (let s = 0; s < 3; s += 1) {
      const key = corners[s]! * W + corners[(s + 1) % 3]!;
      if (owner.has(key)) return "The body is not a clean closed solid: two triangles share an edge in the same direction.";
      owner.set(key, t * 3 + s);
    }
  }
  for (const [key, slot] of owner) {
    const a = Math.floor(key / W);
    const b = key - a * W;
    const partner = owner.get(b * W + a);
    if (partner === undefined) return "The body is not a closed solid: an edge has only one triangle.";
    neighbour[slot] = Math.floor(partner / 3);
  }
  // Triangle planes.
  const normals: V3[] = [];
  const areas: number[] = [];
  const centroids: V3[] = [];
  let volume = 0;
  for (let t = 0; t < triangleCount; t += 1) {
    const [a, b, c] = tri[t]!;
    const pa = weldedPositions[a]!;
    const pb = weldedPositions[b]!;
    const pc = weldedPositions[c]!;
    const n = cross(sub(pb, pa), sub(pc, pa));
    const doubleArea = length(n);
    areas.push(doubleArea / 2);
    normals.push(doubleArea < 1e-12 ? [0, 0, 0] : [n[0] / doubleArea, n[1] / doubleArea, n[2] / doubleArea]);
    centroids.push([(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3]);
    volume += dot(pa, cross(pb, pc)) / 6;
  }
  if (!(volume > 0)) return "The body does not enclose a positive volume (its triangles may face inward).";
  // Flat regions: grow from a seed triangle across shared edges while the neighbour stays on the seed's plane.
  const distanceTolerance = 5e-5 + 1e-7 * diagonalMm;
  const triangleRegion: number[] = new Array(triangleCount).fill(-1);
  const regions: FaceRegion[] = [];
  const regionTriangles: number[][] = [];
  for (let seed = 0; seed < triangleCount; seed += 1) {
    if (triangleRegion[seed] !== -1 || areas[seed]! < 1e-9) continue;
    const id = regionTriangles.length;
    const sn = normals[seed]!;
    const sd = dot(sn, weldedPositions[tri[seed]![0]]!);
    const members: number[] = [];
    const queue = [seed];
    triangleRegion[seed] = id;
    while (queue.length > 0) {
      const t = queue.pop()!;
      members.push(t);
      for (let s = 0; s < 3; s += 1) {
        const u = neighbour[t * 3 + s]!;
        if (u < 0 || triangleRegion[u] !== -1 || areas[u]! < 1e-9) continue;
        if (dot(normals[u]!, sn) < COPLANAR_COS) continue;
        const [ua, ub, uc] = tri[u]!;
        if ([ua, ub, uc].some((v) => Math.abs(dot(sn, weldedPositions[v]!) - sd) > distanceTolerance)) continue;
        triangleRegion[u] = id;
        queue.push(u);
      }
    }
    regionTriangles.push(members);
  }
  // Region plane and centroid, then smoothness.
  const draft = regionTriangles.map((members, id) => {
    let area = 0;
    let nx = 0; let ny = 0; let nz = 0;
    let cx = 0; let cy = 0; let cz = 0;
    for (const t of members) {
      const a = areas[t]!;
      area += a;
      nx += normals[t]![0] * a; ny += normals[t]![1] * a; nz += normals[t]![2] * a;
      cx += centroids[t]![0] * a; cy += centroids[t]![1] * a; cz += centroids[t]![2] * a;
    }
    const normal = unit([nx, ny, nz]) ?? normals[members[0]!]!;
    const centroid: V3 = [cx / area, cy / area, cz / area];
    return { id, members, area, normal, centroid, offset: dot(normal, centroid) };
  });
  const smooth: Set<number>[] = draft.map(() => new Set<number>());
  for (let t = 0; t < triangleCount; t += 1) {
    const r = triangleRegion[t]!;
    if (r < 0) continue;
    for (let s = 0; s < 3; s += 1) {
      const u = neighbour[t * 3 + s]!;
      const q = u < 0 ? -1 : triangleRegion[u]!;
      if (q < 0 || q === r) continue;
      if (dot(normals[t]!, normals[u]!) >= SMOOTH_COS) smooth[r]!.add(q);
    }
  }
  for (const entry of draft) {
    regions.push({ id: entry.id, triangles: entry.members, normal: entry.normal, offset: entry.offset, areaMm2: entry.area, centroidMm: entry.centroid, curved: smooth[entry.id]!.size >= 2 });
  }
  // Which regions meet at each vertex.
  const vertexRegions: number[][] = weldedPositions.map(() => []);
  for (let t = 0; t < triangleCount; t += 1) {
    const r = triangleRegion[t]!;
    if (r < 0) continue;
    for (const v of tri[t]!) { const list = vertexRegions[v]!; if (!list.includes(r)) list.push(r); }
  }
  return { weld, weldedPositions, triangleRegion, regions, vertexRegions, diagonalMm, volumeMm3: volume };
}

function closestPointOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(p, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

export type FaceLookup =
  | { readonly ok: true; readonly region: FaceRegion; readonly distanceMm: number }
  | { readonly ok: false; readonly message: string };

/**
 * Finds the flat region a picked face now is: among regions that look within 12° of the way the face looked, the one nearest
 * the picked point. A face that has moved because the body was edited is still found while it is within a third of the body's size.
 */
export function resolveFace(mesh: MeshLike, analysis: FaceAnalysis, ref: FaceRefLike, label = "The picked face"): FaceLookup {
  const want = unit(ref.normalMm);
  if (want === undefined) return { ok: false, message: `${label} has no direction.` };
  let best: { region: FaceRegion; distance: number } | undefined;
  for (const region of analysis.regions) {
    if (dot(region.normal, want) < Math.cos((12 * Math.PI) / 180)) continue;
    let distance = Infinity;
    for (const t of region.triangles) {
      const a = analysis.weldedPositions[analysis.weld[mesh.indices[t * 3]!]!]!;
      const b = analysis.weldedPositions[analysis.weld[mesh.indices[t * 3 + 1]!]!]!;
      const c = analysis.weldedPositions[analysis.weld[mesh.indices[t * 3 + 2]!]!]!;
      const d = length(sub(ref.pointMm, closestPointOnTriangle(ref.pointMm, a, b, c)));
      if (d < distance) distance = d;
    }
    if (best === undefined || distance < best.distance) best = { region, distance };
  }
  if (best === undefined) return { ok: false, message: `${label} is gone: no face of the body looks that way any more.` };
  if (best.distance > Math.max(1, analysis.diagonalMm / 3)) return { ok: false, message: `${label} is gone: the nearest face that looks that way is ${best.distance.toFixed(1)} mm from where it was picked.` };
  return { ok: true, region: best.region, distanceMm: best.distance };
}

function solve3(m: readonly number[], b: readonly number[]): V3 | undefined {
  const [a, bb, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-30) return undefined;
  const x = (b[0]! * (e * i - f * h) - bb * (b[1]! * i - f * b[2]!) + c * (b[1]! * h - e * b[2]!)) / det;
  const y = (a * (b[1]! * i - f * b[2]!) - b[0]! * (d * i - f * g) + c * (d * b[2]! - b[1]! * g)) / det;
  const z = (a * (e * b[2]! - b[1]! * h) - bb * (d * b[2]! - b[1]! * g) + b[0]! * (d * h - e * g)) / det;
  return [x, y, z];
}

/** The point nearest `from` that lies on every given plane (exactly where three independent planes meet). */
export function meetPoint(planes: readonly PlaneLike[], from: V3): V3 {
  const epsilon = 1e-10;
  const m = [epsilon, 0, 0, 0, epsilon, 0, 0, 0, epsilon];
  const b = [epsilon * from[0], epsilon * from[1], epsilon * from[2]];
  for (const { normal: n, offset } of planes) {
    m[0]! += n[0] * n[0]; m[1]! += n[0] * n[1]; m[2]! += n[0] * n[2];
    m[3]! += n[1] * n[0]; m[4]! += n[1] * n[1]; m[5]! += n[1] * n[2];
    m[6]! += n[2] * n[0]; m[7]! += n[2] * n[1]; m[8]! += n[2] * n[2];
    b[0]! += n[0] * offset; b[1]! += n[1] * offset; b[2]! += n[2] * offset;
  }
  return solve3(m, b) ?? from;
}

export type MoveResult =
  | { readonly ok: true; readonly positionsMm: number[]; readonly movedVertices: number }
  | { readonly ok: false; readonly message: string };

/**
 * Gives some regions a new plane and moves every vertex they touch to where the planes of all the regions around it now meet.
 * A vertex no changed region touches does not move, so the rest of the body keeps its exact shape. Refuses a move that turns a
 * triangle inside out or squeezes one to nothing (a face pushed through the body, a wall thinner than zero).
 */
export function movePlanes(mesh: MeshLike, analysis: FaceAnalysis, overrides: ReadonlyMap<number, PlaneLike>): MoveResult {
  const moved: V3[] = analysis.weldedPositions.slice();
  let movedVertices = 0;
  for (let v = 0; v < analysis.weldedPositions.length; v += 1) {
    const around = analysis.vertexRegions[v]!;
    if (!around.some((r) => overrides.has(r))) continue;
    const planes = around.map((r) => overrides.get(r) ?? analysis.regions[r]!);
    moved[v] = meetPoint(planes, analysis.weldedPositions[v]!);
    movedVertices += 1;
  }
  const bad = checkMoved(mesh, analysis, moved);
  if (bad !== undefined) return { ok: false, message: bad };
  const positionsMm = Array.from(mesh.positionsMm);
  for (let i = 0; i < analysis.weld.length; i += 1) {
    const w = analysis.weld[i]!;
    if (moved[w] === analysis.weldedPositions[w]) continue;
    positionsMm[i * 3] = moved[w]![0]; positionsMm[i * 3 + 1] = moved[w]![1]; positionsMm[i * 3 + 2] = moved[w]![2];
  }
  return { ok: true, positionsMm, movedVertices };
}

/**
 * A message when moving the welded vertices would flip a triangle, make a whole face vanish, or leave no volume; otherwise
 * undefined. A single triangle that goes flat because three of its corners now line up (a face that gained a straight edge)
 * is allowed: it keeps the mesh closed and encloses nothing.
 */
export function checkMoved(mesh: MeshLike, analysis: FaceAnalysis, moved: readonly V3[]): string | undefined {
  let volume = 0;
  const floor = 1e-9 * Math.max(1, analysis.diagonalMm) ** 2;
  const total = new Map<number, number>();
  const flat = new Map<number, number>();
  for (let t = 0; t < mesh.indices.length / 3; t += 1) {
    const a = analysis.weld[mesh.indices[t * 3]!]!;
    const b = analysis.weld[mesh.indices[t * 3 + 1]!]!;
    const c = analysis.weld[mesh.indices[t * 3 + 2]!]!;
    const before = cross(sub(analysis.weldedPositions[b]!, analysis.weldedPositions[a]!), sub(analysis.weldedPositions[c]!, analysis.weldedPositions[a]!));
    const after = cross(sub(moved[b]!, moved[a]!), sub(moved[c]!, moved[a]!));
    const was = length(before);
    if (was > 1e-9) {
      const region = analysis.triangleRegion[t]!;
      total.set(region, (total.get(region) ?? 0) + 1);
      if (length(after) < 1e-6 * was && was > floor) flat.set(region, (flat.get(region) ?? 0) + 1);
      else if (dot(before, after) <= 0) return "The edit turns part of the surface inside out, so it does not fit the body (a face pushed past the face behind it, or a wall thinner than nothing).";
    }
    volume += dot(moved[a]!, cross(moved[b]!, moved[c]!)) / 6;
  }
  for (const [region, count] of flat) {
    if (count === total.get(region)) return "The edit squeezes a whole face to nothing (two faces end up meeting), which the mesh cannot keep as a valid solid.";
  }
  if (!(volume > 0)) return "The edit leaves no solid volume.";
  return undefined;
}
