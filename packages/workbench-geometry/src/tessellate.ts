import type { Vec3 } from "../../workbench-core/src/index.js";

/**
 * Browser-safe analytic tessellator for general sketch-profile solids.
 *
 * The qualified Manifold kernel (solid-manifold-adapter) is Node-only and is
 * forbidden from the production browser graph by scripts/production-boundary.mjs,
 * so the live viewport cannot call it. This module reproduces extrude/revolve of
 * a closed profile with deterministic triangle tessellation (no WASM, no boolean
 * kernel). It is cross-checked by volume against combineSolids in the test suite.
 */

export type TessellatePlane = "xy" | "xz" | "yz";

export interface TessellatedMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

type Point2 = readonly [number, number];

/** Sketch-plane placement expressed as the same X/Y/Z rotation the Manifold adapter applies. */
const PLANE_ROTATION_DEG: Record<TessellatePlane, Vec3> = {
  xy: [0, 0, 0],
  xz: [90, 0, 0],
  yz: [0, 90, 0]
};

const REVOLVE_SEGMENTS = 64;

/** How a profile sits relative to the revolve axis (the sketch Y axis, x = 0). */
export type RevolveAxisRelation = "one-side" | "touches" | "crosses";

/**
 * Classifies a profile against the revolve axis. A profile entirely on one side revolves into a
 * solid; one that only touches the axis (an edge lying on it) is also valid and yields a solid
 * with no hole; one that has points strictly on both sides would sweep over itself, so it is
 * not a valid revolve profile.
 */
export function revolveAxisRelation(polygonMm: readonly Point2[], toleranceMm = 1e-6): RevolveAxisRelation {
  let hasPositive = false;
  let hasNegative = false;
  let hasOnAxis = false;
  for (const [x] of polygonMm) {
    if (x > toleranceMm) hasPositive = true;
    else if (x < -toleranceMm) hasNegative = true;
    else hasOnAxis = true;
  }
  if (hasPositive && hasNegative) return "crosses";
  return hasOnAxis ? "touches" : "one-side";
}

/** Extrude a closed profile polygon (millimetres) by `heightMm` along the plane normal. */
export function tessellateExtrude(polygonMm: readonly Point2[], heightMm: number, plane: TessellatePlane): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3) return { positionsMm: [], indices: [] };
  const height = Math.abs(heightMm);
  const capTriangles = triangulatePolygon(polygon);
  const count = polygon.length;
  const positions: number[] = [];
  for (const [x, y] of polygon) positions.push(x, y, 0);
  for (const [x, y] of polygon) positions.push(x, y, height);
  const indices: number[] = [];
  // Bottom cap: reverse the CCW triangulation so its normal faces -Z.
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
  // Top cap: keep CCW so its normal faces +Z.
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(count + capTriangles[i]!, count + capTriangles[i + 1]!, count + capTriangles[i + 2]!);
  // Side walls, outward wound for a CCW profile.
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    indices.push(i, next, count + next, i, count + next, count + i);
  }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices };
}

/** Revolve a closed profile polygon (millimetres) about the plane's in-plane axis by `degrees`. */
export function tessellateRevolve(polygonMm: readonly Point2[], degrees: number, plane: TessellatePlane): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3) return { positionsMm: [], indices: [] };
  const sweep = Math.min(360, Math.max(1, Math.abs(degrees)));
  const full = Math.abs(sweep - 360) < 1e-6;
  const segments = Math.max(3, Math.round((REVOLVE_SEGMENTS * sweep) / 360));
  const sampleCount = full ? segments : segments + 1;
  const angle = (sweep * Math.PI) / 180;
  const count = polygon.length;
  const positions: number[] = [];
  for (let s = 0; s < sampleCount; s += 1) {
    const theta = (angle * s) / segments;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (const [radius, axial] of polygon) positions.push(radius * cos, axial, radius * sin);
  }
  const indices: number[] = [];
  for (let s = 0; s < segments; s += 1) {
    const ring = s * count;
    const nextRing = (full ? (s + 1) % sampleCount : s + 1) * count;
    for (let j = 0; j < count; j += 1) {
      const nextJ = (j + 1) % count;
      indices.push(ring + j, ring + nextJ, nextRing + nextJ, ring + j, nextRing + nextJ, nextRing + j);
    }
  }
  if (!full) {
    const capTriangles = triangulatePolygon(polygon);
    const lastRing = (sampleCount - 1) * count;
    for (let i = 0; i < capTriangles.length; i += 3) {
      indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
      indices.push(lastRing + capTriangles[i]!, lastRing + capTriangles[i + 1]!, lastRing + capTriangles[i + 2]!);
    }
  }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices };
}

/** Remove a duplicated closing vertex and any zero-length segments so triangulation stays robust. */
function sanitizePolygon(polygon: readonly Point2[]): readonly Point2[] {
  const cleaned: Point2[] = [];
  for (const point of polygon) {
    const previous = cleaned[cleaned.length - 1];
    if (previous !== undefined && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-9) continue;
    cleaned.push([point[0], point[1]]);
  }
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (cleaned.length > 1 && first !== undefined && last !== undefined && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) cleaned.pop();
  return cleaned;
}

/** Ear-clipping triangulation returning CCW-wound vertex indices into `polygon`. */
function triangulatePolygon(polygon: readonly Point2[]): readonly number[] {
  const n = polygon.length;
  if (n < 3) return [];
  const order = Array.from({ length: n }, (_, index) => index);
  if (signedArea(polygon) < 0) order.reverse();
  const result: number[] = [];
  const maxGuard = n * n;
  let guard = 0;
  while (order.length > 3 && guard < maxGuard) {
    guard += 1;
    let clipped = false;
    for (let i = 0; i < order.length; i += 1) {
      const previous = order[(i - 1 + order.length) % order.length]!;
      const current = order[i]!;
      const next = order[(i + 1) % order.length]!;
      const a = polygon[previous]!;
      const b = polygon[current]!;
      const c = polygon[next]!;
      if (cross(a, b, c) <= 1e-12) continue;
      let encloses = false;
      for (const index of order) {
        if (index === previous || index === current || index === next) continue;
        if (pointInTriangle(polygon[index]!, a, b, c)) { encloses = true; break; }
      }
      if (encloses) continue;
      result.push(previous, current, next);
      order.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (order.length === 3) result.push(order[0]!, order[1]!, order[2]!);
  return result;
}

function signedArea(polygon: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(point: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const d1 = cross(a, b, point);
  const d2 = cross(b, c, point);
  const d3 = cross(c, a, point);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function rotatePositions(positions: readonly number[], rotationDeg: Vec3): readonly number[] {
  if (rotationDeg[0] === 0 && rotationDeg[1] === 0 && rotationDeg[2] === 0) return positions;
  const [rx, ry, rz] = rotationDeg.map((value) => (value * Math.PI) / 180) as unknown as Vec3;
  const ca = Math.cos(rx); const sa = Math.sin(rx);
  const cb = Math.cos(ry); const sb = Math.sin(ry);
  const cc = Math.cos(rz); const sc = Math.sin(rz);
  const matrix: readonly Vec3[] = [
    [cb * cc, -cb * sc, sb],
    [sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb],
    [-ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb]
  ];
  const rotated: number[] = [];
  for (let index = 0; index < positions.length; index += 3) {
    const point: Vec3 = [positions[index]!, positions[index + 1]!, positions[index + 2]!];
    rotated.push(dot(matrix[0]!, point), dot(matrix[1]!, point), dot(matrix[2]!, point));
  }
  return rotated;
}

function dot(row: Vec3, point: Vec3): number {
  return row[0] * point[0] + row[1] * point[1] + row[2] * point[2];
}
