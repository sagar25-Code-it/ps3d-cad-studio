/**
 * Surface and manufacturability analyses on triangle meshes: draft angle against a pull direction, ray-based wall
 * thickness, and per-vertex Gaussian and mean curvature. Pure functions on flat position / index arrays (mm); the
 * results are plain arrays that a viewport can colour.
 */

import { TriangleBvh } from "./mesh-bvh.js";

type V3 = readonly [number, number, number];

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function length(a: V3): number { return Math.hypot(a[0], a[1], a[2]); }
function unit(a: V3): V3 { const l = length(a); return l < 1e-300 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]; }

function pointAt(positionsMm: readonly number[], vertex: number): V3 {
  return [positionsMm[vertex * 3]!, positionsMm[vertex * 3 + 1]!, positionsMm[vertex * 3 + 2]!];
}

function validTriangles(positionsMm: readonly number[], indices: readonly number[]): number[] {
  const vertexCount = Math.floor(positionsMm.length / 3);
  const result: number[] = [];
  for (let triangle = 0; triangle * 3 + 2 < indices.length; triangle += 1) {
    const a = indices[triangle * 3]!; const b = indices[triangle * 3 + 1]!; const c = indices[triangle * 3 + 2]!;
    if (a >= 0 && b >= 0 && c >= 0 && a < vertexCount && b < vertexCount && c < vertexCount) result.push(triangle);
  }
  return result;
}

/** Outward unit normal and area of a triangle from its winding (counter-clockwise seen from outside). */
export function triangleNormalArea(positionsMm: readonly number[], indices: readonly number[], triangle: number): { readonly normal: V3; readonly areaMm2: number } {
  const a = pointAt(positionsMm, indices[triangle * 3]!);
  const b = pointAt(positionsMm, indices[triangle * 3 + 1]!);
  const c = pointAt(positionsMm, indices[triangle * 3 + 2]!);
  const n = cross(sub(b, a), sub(c, a));
  const l = length(n);
  return { normal: l < 1e-300 ? [0, 0, 0] : [n[0] / l, n[1] / l, n[2] / l], areaMm2: l / 2 };
}

// ---------------------------------------------------------------------------------------------
// Draft angle
// ---------------------------------------------------------------------------------------------

export type DraftClass = "positive" | "needs-draft" | "negative";

export interface DraftAnalysisOptions {
  /** Direction the part is pulled out of the mould (any non-zero vector). */
  readonly pullDirection: V3;
  /** A face is "positive" at or above this draft and "negative" at or below minus this draft (default 1 degree). */
  readonly requiredDraftDeg?: number;
}

export interface DraftAnalysis {
  readonly pullDirection: V3;
  readonly requiredDraftDeg: number;
  /** Draft angle of each triangle in degrees, in [-90, 90]: asin(normal . pull). NaN for a degenerate triangle. */
  readonly triangleAngleDeg: readonly number[];
  readonly triangleClass: readonly (DraftClass | "none")[];
  readonly areaMm2: { readonly positive: number; readonly needsDraft: number; readonly negative: number; readonly total: number };
  readonly minAngleDeg: number;
  readonly maxAngleDeg: number;
}

/**
 * Draft angle of every triangle against a pull direction. A wall parallel to the pull has zero draft; a face tilted so
 * its normal leans toward the pull direction by `t` degrees has +t, and one leaning away has -t. Faces that look
 * straight along the pull are +90 (top) or -90 (bottom). Positive draft releases from the mould, a draft inside
 * +/- `requiredDraftDeg` needs draft added, and negative draft is an undercut for a pull in this direction.
 */
export function analyzeDraft(positionsMm: readonly number[], indices: readonly number[], options: DraftAnalysisOptions): DraftAnalysis {
  const pull = unit(options.pullDirection);
  const required = Math.max(0, options.requiredDraftDeg ?? 1);
  const triangleCount = Math.floor(indices.length / 3);
  const valid = new Set(validTriangles(positionsMm, indices));
  const angle: number[] = [];
  const kind: (DraftClass | "none")[] = [];
  const area = { positive: 0, needsDraft: 0, negative: 0, total: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (!valid.has(triangle)) { angle.push(Number.NaN); kind.push("none"); continue; }
    const { normal, areaMm2 } = triangleNormalArea(positionsMm, indices, triangle);
    if (areaMm2 <= 0) { angle.push(Number.NaN); kind.push("none"); continue; }
    const degrees = Math.asin(Math.max(-1, Math.min(1, dot(normal, pull)))) * 180 / Math.PI;
    angle.push(degrees);
    const draftClass: DraftClass = degrees >= required ? "positive" : degrees <= -required ? "negative" : "needs-draft";
    kind.push(draftClass);
    area.total += areaMm2;
    if (draftClass === "positive") area.positive += areaMm2; else if (draftClass === "negative") area.negative += areaMm2; else area.needsDraft += areaMm2;
    if (degrees < min) min = degrees;
    if (degrees > max) max = degrees;
  }
  return { pullDirection: pull, requiredDraftDeg: required, triangleAngleDeg: angle, triangleClass: kind, areaMm2: area, minAngleDeg: Number.isFinite(min) ? min : 0, maxAngleDeg: Number.isFinite(max) ? max : 0 };
}

// ---------------------------------------------------------------------------------------------
// Wall thickness
// ---------------------------------------------------------------------------------------------

export interface WallThicknessOptions {
  /** Walls thinner than this (mm) are reported as thin (default 1). */
  readonly thinThresholdMm?: number;
  /** Rays do not search beyond this distance (mm); default is the body's bounding-box diagonal. */
  readonly maxDistanceMm?: number;
  /** Bodies with more triangles than this are not analysed (default 60000). */
  readonly maxTriangles?: number;
}

export interface WallThicknessAnalysis {
  readonly analysed: boolean;
  readonly message?: string;
  /** Thickness at each triangle in mm (the least of four sample rays); NaN where the ray found no opposite wall. */
  readonly triangleThicknessMm: readonly number[];
  readonly minThicknessMm: number;
  readonly maxThicknessMm: number;
  /** Area-weighted mean over the triangles that found a wall. */
  readonly meanThicknessMm: number;
  readonly thinThresholdMm: number;
  readonly thinAreaMm2: number;
  readonly totalAreaMm2: number;
  readonly minLocationMm: V3 | undefined;
  readonly minTriangle: number;
  /** Triangles whose rays hit nothing (open mesh or beyond the search distance). */
  readonly unmeasuredTriangles: number;
}

const SAMPLE_WEIGHTS: readonly (readonly [number, number, number])[] = [
  [1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]
];

/**
 * Local wall thickness by ray casting: from several points on every triangle a ray is shot into the material (against
 * the outward normal) and the distance to the first surface it meets is the thickness there. For a hollow box this is
 * the wall; at a rounded outside corner it reads the shortest path across the wall.
 */
export function analyzeWallThickness(positionsMm: readonly number[], indices: readonly number[], options: WallThicknessOptions = {}): WallThicknessAnalysis {
  const thin = options.thinThresholdMm ?? 1;
  const triangleCount = Math.floor(indices.length / 3);
  const empty = (message: string): WallThicknessAnalysis => ({ analysed: false, message, triangleThicknessMm: [], minThicknessMm: 0, maxThicknessMm: 0, meanThicknessMm: 0, thinThresholdMm: thin, thinAreaMm2: 0, totalAreaMm2: 0, minLocationMm: undefined, minTriangle: -1, unmeasuredTriangles: 0 });
  if (triangleCount === 0) return empty("The body has no triangles.");
  if (triangleCount > (options.maxTriangles ?? 60000)) return empty(`The body has ${triangleCount} triangles, which is more than the wall-thickness analysis accepts.`);
  const valid = validTriangles(positionsMm, indices);
  if (valid.length !== triangleCount) return empty("The mesh refers to vertices that do not exist.");

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex * 3 + 2 < positionsMm.length; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positionsMm[vertex * 3 + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const reach = options.maxDistanceMm ?? diagonal;
  const nudge = Math.max(1e-7, diagonal * 1e-7);
  const bvh = new TriangleBvh(positionsMm, indices);

  const result: number[] = [];
  let minThickness = Infinity;
  let maxThickness = 0;
  let weighted = 0;
  let measuredArea = 0;
  let totalArea = 0;
  let thinArea = 0;
  let minTriangle = -1;
  let minPoint: V3 | undefined;
  let unmeasured = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const { normal, areaMm2 } = triangleNormalArea(positionsMm, indices, triangle);
    totalArea += areaMm2;
    if (areaMm2 <= 0) { result.push(Number.NaN); unmeasured += 1; continue; }
    const a = pointAt(positionsMm, indices[triangle * 3]!);
    const b = pointAt(positionsMm, indices[triangle * 3 + 1]!);
    const c = pointAt(positionsMm, indices[triangle * 3 + 2]!);
    const direction: V3 = [-normal[0], -normal[1], -normal[2]];
    let best = Infinity;
    let bestPoint: V3 = a;
    for (const [wa, wb, wc] of SAMPLE_WEIGHTS) {
      const point: V3 = [a[0] * wa + b[0] * wb + c[0] * wc, a[1] * wa + b[1] * wb + c[1] * wc, a[2] * wa + b[2] * wb + c[2] * wc];
      const origin: V3 = [point[0] + direction[0] * nudge, point[1] + direction[1] * nudge, point[2] + direction[2] * nudge];
      const hit = bvh.nearestHit(origin, direction, 0, triangle, reach);
      if (hit !== undefined) {
        const distance = hit.distance + nudge;
        if (distance < best) { best = distance; bestPoint = point; }
      }
    }
    if (!Number.isFinite(best)) { result.push(Number.NaN); unmeasured += 1; continue; }
    result.push(best);
    weighted += best * areaMm2;
    measuredArea += areaMm2;
    if (best < thin) thinArea += areaMm2;
    if (best > maxThickness) maxThickness = best;
    if (best < minThickness) { minThickness = best; minTriangle = triangle; minPoint = bestPoint; }
  }
  return {
    analysed: true,
    triangleThicknessMm: result,
    minThicknessMm: Number.isFinite(minThickness) ? minThickness : 0,
    maxThicknessMm: maxThickness,
    meanThicknessMm: measuredArea > 0 ? weighted / measuredArea : 0,
    thinThresholdMm: thin,
    thinAreaMm2: thinArea,
    totalAreaMm2: totalArea,
    minLocationMm: minPoint,
    minTriangle,
    unmeasuredTriangles: unmeasured
  };
}

// ---------------------------------------------------------------------------------------------
// Gaussian and mean curvature
// ---------------------------------------------------------------------------------------------

export interface CurvatureStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  /** 95th percentile of the absolute value; a robust colour range. */
  readonly p95Abs: number;
}

export interface CurvatureAnalysis {
  /** For each original vertex, the welded vertex it belongs to (-1 when it is unused or not finite). */
  readonly weldedIndexOfVertex: readonly number[];
  /** Gaussian curvature K = k1 * k2 (1/mm2) at each welded vertex; NaN at boundary vertices. */
  readonly gaussian: readonly number[];
  /** Mean curvature H = (k1 + k2) / 2 (1/mm), positive where the surface is convex (bulges outward); NaN at boundary vertices. */
  readonly mean: readonly number[];
  readonly gaussianStats: CurvatureStats;
  readonly meanStats: CurvatureStats;
}

/**
 * Discrete Gaussian and mean curvature at the vertices of a triangle mesh (Meyer et al. 2003): Gaussian from the angle
 * deficit over the mixed Voronoi area, mean from the cotangent Laplacian projected on the area-weighted normal. The
 * mesh is welded first, so unwelded seams do not read as boundaries. A sphere of radius r gives K = 1/r2 and H = 1/r.
 */
export function analyzeCurvature(positionsMm: readonly number[], indices: readonly number[], weldToleranceMm = 1e-5): CurvatureAnalysis {
  const vertexCount = Math.floor(positionsMm.length / 3);
  const weld = new Array<number>(vertexCount).fill(-1);
  const welded: V3[] = [];
  const cells = new Map<string, number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const point = pointAt(positionsMm, vertex);
    if (!point.every(Number.isFinite)) continue;
    const key = `${Math.round(point[0] / weldToleranceMm)}|${Math.round(point[1] / weldToleranceMm)}|${Math.round(point[2] / weldToleranceMm)}`;
    let id = cells.get(key);
    if (id === undefined) { id = welded.length; welded.push(point); cells.set(key, id); }
    weld[vertex] = id;
  }
  const count = welded.length;
  const angleSum = new Float64Array(count);
  const area = new Float64Array(count);
  const laplace = new Float64Array(count * 3);
  const normal = new Float64Array(count * 3);
  const edgeUse = new Map<number, number>();
  const stride = count + 1;

  for (const triangle of validTriangles(positionsMm, indices)) {
    const ids = [0, 1, 2].map((corner) => weld[indices[triangle * 3 + corner]!]!);
    if (ids.some((id) => id < 0) || ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
    const p = ids.map((id) => welded[id]!);
    const faceNormal = cross(sub(p[1]!, p[0]!), sub(p[2]!, p[0]!));
    const doubleArea = length(faceNormal);
    if (doubleArea < 1e-300) continue;
    const triangleArea = doubleArea / 2;
    // Angles and cotangents at each corner.
    const angle: number[] = [];
    const cot: number[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const u = sub(p[(corner + 1) % 3]!, p[corner]!);
      const v = sub(p[(corner + 2) % 3]!, p[corner]!);
      const d = dot(u, v);
      const c = length(cross(u, v));
      angle.push(Math.atan2(c, d));
      cot.push(c < 1e-300 ? 0 : d / c);
    }
    const obtuse = angle.findIndex((value) => value > Math.PI / 2 + 1e-12);
    for (let corner = 0; corner < 3; corner += 1) {
      const id = ids[corner]!;
      angleSum[id]! += angle[corner]!;
      normal[id * 3]! += faceNormal[0]; normal[id * 3 + 1]! += faceNormal[1]; normal[id * 3 + 2]! += faceNormal[2];
      if (obtuse < 0) {
        const j = (corner + 1) % 3; const k = (corner + 2) % 3;
        const toJ = sub(p[j]!, p[corner]!); const toK = sub(p[k]!, p[corner]!);
        area[id]! += (dot(toJ, toJ) * cot[k]! + dot(toK, toK) * cot[j]!) / 8;
      } else {
        area[id]! += obtuse === corner ? triangleArea / 2 : triangleArea / 4;
      }
      // Cotangent edge weight: the edge opposite `corner` is (corner+1, corner+2); it gets cot at `corner`.
      const a = ids[(corner + 1) % 3]!; const b = ids[(corner + 2) % 3]!;
      const w = cot[corner]!;
      const pa = welded[a]!; const pb = welded[b]!;
      laplace[a * 3]! += w * (pb[0] - pa[0]); laplace[a * 3 + 1]! += w * (pb[1] - pa[1]); laplace[a * 3 + 2]! += w * (pb[2] - pa[2]);
      laplace[b * 3]! += w * (pa[0] - pb[0]); laplace[b * 3 + 1]! += w * (pa[1] - pb[1]); laplace[b * 3 + 2]! += w * (pa[2] - pb[2]);
      const key = Math.min(a, b) * stride + Math.max(a, b);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  // Each edge was visited once per adjacent triangle; boundary vertices touch an edge used once.
  const boundary = new Uint8Array(count);
  for (const [key, uses] of edgeUse) {
    if (uses === 2) continue;
    boundary[Math.floor(key / stride)] = 1;
    boundary[key % stride] = 1;
  }
  const gaussian = new Array<number>(count).fill(Number.NaN);
  const mean = new Array<number>(count).fill(Number.NaN);
  for (let id = 0; id < count; id += 1) {
    if (boundary[id] === 1 || area[id]! < 1e-300 || angleSum[id]! === 0) continue;
    gaussian[id] = (2 * Math.PI - angleSum[id]!) / area[id]!;
    const n = unit([normal[id * 3]!, normal[id * 3 + 1]!, normal[id * 3 + 2]!]);
    const laplacian: V3 = [laplace[id * 3]! / (2 * area[id]!), laplace[id * 3 + 1]! / (2 * area[id]!), laplace[id * 3 + 2]! / (2 * area[id]!)];
    mean[id] = -0.5 * dot(laplacian, n);
  }
  return { weldedIndexOfVertex: weld, gaussian, mean, gaussianStats: statsOf(gaussian), meanStats: statsOf(mean) };
}

function statsOf(values: readonly number[]): CurvatureStats {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return { min: 0, max: 0, mean: 0, median: 0, p95Abs: 0 };
  const absolute = finite.map(Math.abs).sort((a, b) => a - b);
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    min: finite[0]!,
    max: finite[finite.length - 1]!,
    mean: total / finite.length,
    median: finite[Math.floor(finite.length / 2)]!,
    p95Abs: absolute[Math.min(absolute.length - 1, Math.floor(absolute.length * 0.95))]!
  };
}
