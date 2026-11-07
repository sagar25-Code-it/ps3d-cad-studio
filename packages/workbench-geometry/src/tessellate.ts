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

/**
 * Sweep a closed profile polygon (millimetres) along a world-space direction. Unlike extrude (which goes along the
 * sketch-plane normal) sweep goes along an arbitrary 3D direction, which gives a skewed prism. The top ring is the
 * bottom ring translated by `directionWorld * distanceMm` so caps are parallel; the ribbon sides stay planar quads.
 * Caller must ensure the direction is not parallel to the sketch plane (the builder refuses that).
 */
export function tessellateSweep(polygonMm: readonly Point2[], directionWorldMm: readonly [number, number, number], distanceMm: number, plane: TessellatePlane): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3) return { positionsMm: [], indices: [] };
  const length = Math.hypot(directionWorldMm[0], directionWorldMm[1], directionWorldMm[2]);
  if (length < 1e-9 || !Number.isFinite(distanceMm) || distanceMm === 0) return { positionsMm: [], indices: [] };
  const unit: readonly [number, number, number] = [directionWorldMm[0] / length, directionWorldMm[1] / length, directionWorldMm[2] / length];
  const offset = Math.abs(distanceMm);
  const shift: readonly [number, number, number] = [unit[0] * offset, unit[1] * offset, unit[2] * offset];
  const capTriangles = triangulatePolygon(polygon);
  const count = polygon.length;
  // Build in sketch-plane local 3D (Z = 0 for bottom, Z = ? — doesn't apply: we translate the TOP in WORLD after rotation).
  // Because the rotation is applied uniformly to every (x, y, 0) point, we instead rotate the whole set first, then translate
  // the top ring by the WORLD shift. That keeps caps parallel.
  const localPositions: number[] = [];
  for (const [x, y] of polygon) localPositions.push(x, y, 0);
  for (const [x, y] of polygon) localPositions.push(x, y, 0);
  const rotated = rotatePositions(localPositions, PLANE_ROTATION_DEG[plane]).slice();
  // Translate the top half by the world shift.
  const positions = [...rotated];
  for (let index = count * 3; index < positions.length; index += 3) {
    positions[index] = positions[index]! + shift[0];
    positions[index + 1] = positions[index + 1]! + shift[1];
    positions[index + 2] = positions[index + 2]! + shift[2];
  }
  const indices: number[] = [];
  // Bottom cap (reverse CCW so the normal faces the plane's -normal direction).
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
  // Top cap.
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(count + capTriangles[i]!, count + capTriangles[i + 1]!, count + capTriangles[i + 2]!);
  // Side ribbon.
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    indices.push(i, next, count + next, i, count + next, count + i);
  }
  return { positionsMm: positions, indices };
}

/**
 * Loft between a base profile and the same profile scaled by `topScale` (about its 2D centroid), placed at height
 * `topZMm` along the sketch-plane normal. topScale = 1 reduces to an extrude. A non-positive topScale is refused.
 */
export function tessellateLoft(polygonMm: readonly Point2[], topScale: number, topZMm: number, plane: TessellatePlane): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(topScale) || topScale <= 0) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(topZMm) || topZMm === 0) return { positionsMm: [], indices: [] };
  const height = Math.abs(topZMm);
  // Centroid of the polygon (area-weighted via shoelace; falls back to average for a degenerate signed area).
  const centroid = polygonCentroid(polygon);
  const capTriangles = triangulatePolygon(polygon);
  const count = polygon.length;
  const positions: number[] = [];
  for (const [x, y] of polygon) positions.push(x, y, 0);
  for (const [x, y] of polygon) positions.push(centroid[0] + (x - centroid[0]) * topScale, centroid[1] + (y - centroid[1]) * topScale, height);
  const indices: number[] = [];
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(count + capTriangles[i]!, count + capTriangles[i + 1]!, count + capTriangles[i + 2]!);
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count;
    indices.push(i, next, count + next, i, count + next, count + i);
  }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices };
}

/**
 * Sweep a closed profile polygon along a sketch-plane path (2D samples). At each sample i the ring is the profile
 * translated in-plane by `(sample_i − sample_0)`, with Z lifted linearly from 0 to `heightMm` across the samples.
 * For a line path this reproduces a slanted prism; for an arc or spline path it traces the curvature. The caller
 * samples the path entity into at least two points; three or more give a visible curve.
 */
export function tessellateSweepPath(polygonMm: readonly Point2[], pathSamples: readonly Point2[], heightMm: number, plane: TessellatePlane): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3 || pathSamples.length < 2) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(heightMm) || heightMm === 0) return { positionsMm: [], indices: [] };
  const height = Math.abs(heightMm);
  const start = pathSamples[0]!;
  const count = polygon.length;
  const positions: number[] = [];
  for (let s = 0; s < pathSamples.length; s += 1) {
    const sample = pathSamples[s]!;
    const dx = sample[0] - start[0];
    const dy = sample[1] - start[1];
    const z = height * (s / (pathSamples.length - 1));
    for (const [px, py] of polygon) positions.push(px + dx, py + dy, z);
  }
  const capTriangles = triangulatePolygon(polygon);
  const indices: number[] = [];
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
  const topBase = (pathSamples.length - 1) * count;
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(topBase + capTriangles[i]!, topBase + capTriangles[i + 1]!, topBase + capTriangles[i + 2]!);
  for (let r = 0; r < pathSamples.length - 1; r += 1) {
    const base = r * count;
    const nextBase = (r + 1) * count;
    for (let i = 0; i < count; i += 1) {
      const next = (i + 1) % count;
      indices.push(base + i, base + next, nextBase + next, base + i, nextBase + next, nextBase + i);
    }
  }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices };
}

/**
 * Loft between two explicit profiles on parallel sketch planes. Both polygons must have the same vertex count; the
 * caller is responsible for resampling. `continuity` selects the shape of the ribbon: "position" is a straight linear
 * interpolation between the two rings (G0), "tangent" eases with smoothstep `3t²−2t³` so the ribbon meets each cap
 * tangentially (G1), and "curvature" eases with smootherstep `6t⁵−15t⁴+10t³` so the second derivative is also zero at
 * each cap (G2). The Z coordinate stays linear with t so the caps keep their intended heights.
 */
export function tessellateLoftTwoProfiles(bottom: readonly Point2[], top: readonly Point2[], heightMm: number, continuity: "position" | "tangent" | "curvature", plane: TessellatePlane, rings = 12): TessellatedMesh {
  const bottomClean = sanitizePolygon(bottom);
  const topClean = sanitizePolygon(top);
  if (bottomClean.length < 3 || topClean.length < 3) return { positionsMm: [], indices: [] };
  if (bottomClean.length !== topClean.length) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(heightMm) || heightMm === 0) return { positionsMm: [], indices: [] };
  const height = Math.abs(heightMm);
  const sampleCount = continuity === "position" ? 2 : Math.max(2, rings);
  const count = bottomClean.length;
  const positions: number[] = [];
  const ease = continuity === "position"
    ? (t: number): number => t
    : continuity === "tangent"
      ? (t: number): number => t * t * (3 - 2 * t)
      : (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  for (let r = 0; r < sampleCount; r += 1) {
    const linear = r / (sampleCount - 1);
    const s = ease(linear);
    const z = height * linear;
    for (let i = 0; i < count; i += 1) {
      const a = bottomClean[i]!;
      const b = topClean[i]!;
      positions.push(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, z);
    }
  }
  const capTrianglesBottom = triangulatePolygon(bottomClean);
  const capTrianglesTop = triangulatePolygon(topClean);
  const indices: number[] = [];
  // Bottom cap (reverse winding).
  for (let i = 0; i < capTrianglesBottom.length; i += 3) indices.push(capTrianglesBottom[i]!, capTrianglesBottom[i + 2]!, capTrianglesBottom[i + 1]!);
  // Top cap at ring `sampleCount - 1`.
  const topBase = (sampleCount - 1) * count;
  for (let i = 0; i < capTrianglesTop.length; i += 3) indices.push(topBase + capTrianglesTop[i]!, topBase + capTrianglesTop[i + 1]!, topBase + capTrianglesTop[i + 2]!);
  // Side ribbons between consecutive rings.
  for (let r = 0; r < sampleCount - 1; r += 1) {
    const base = r * count;
    const nextBase = (r + 1) * count;
    for (let i = 0; i < count; i += 1) {
      const next = (i + 1) % count;
      indices.push(base + i, base + next, nextBase + next, base + i, nextBase + next, nextBase + i);
    }
  }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices };
}

function polygonCentroid(polygon: readonly Point2[]): Point2 {
  let signed = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    signed += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(signed) < 1e-9) {
    // Degenerate signed area: fall back to average of vertices.
    const avg = polygon.reduce<Point2>((acc, point) => [acc[0] + point[0] / polygon.length, acc[1] + point[1] / polygon.length], [0, 0]);
    return avg;
  }
  const area6 = signed * 3;
  return [cx / area6, cy / area6];
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
