import { fullCircleFacets, type Vec3 } from "../../workbench-core/src/index.js";
import { alignLoopStart } from "./loft-align.js";

/**
 * Browser-safe analytic tessellator for general sketch-profile solids.
 *
 * The qualified Manifold kernel (solid-manifold-adapter) is Node-only and is
 * forbidden from the production browser graph by scripts/production-boundary.mjs,
 * so the live viewport cannot call it. This module reproduces extrude/revolve of
 * a closed profile with deterministic triangle tessellation (no WASM, no boolean
 * kernel). It is cross-checked by volume against combineSolids in the test suite.
 */

/** "yz-zup" is the Right plane of the Z-up convention (sketch X along world +Y, sketch Y along +Z); "yz" keeps the legacy mapping of older sketches. */
export type TessellatePlane = "xy" | "xz" | "yz" | "yz-zup";

export interface TessellatedMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

type Point2 = readonly [number, number];

/** Sketch-plane placement expressed as the same X/Y/Z rotation the Manifold adapter applies. */
export const PLANE_ROTATION_DEG: Record<TessellatePlane, Vec3> = {
  xy: [0, 0, 0],
  xz: [90, 0, 0],
  yz: [0, 90, 0],
  "yz-zup": [0, 90, 90]
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

/** The most triangles a revolve spends on getting rounder than the classic rule: a stored mesh is plain JSON, so a torus must stay a few megabytes. */
export const REVOLVE_TRIANGLE_BUDGET = 14_000;

/**
 * The facets a full turn of a revolve of this radius gets. The classic rule (adaptiveFacetCount: sag up to 0.1 percent of the radius, at
 * least 64) is the floor; where the profile is simple enough that the triangle budget allows, the turn follows the sketch-wide chord
 * error rule (1/2,000 of the radius, at most 0.01 mm: workbench-core/tessellation.ts), so a rectangle revolved at r=5 is as round as one
 * at r=500. A profile with many points keeps the classic count rather than an unstorable solid.
 */
export function revolveSegmentsForRadius(radiusMm: number, profilePoints = 0): number {
  const classic = adaptiveFacetCount(radiusMm, REVOLVE_SEGMENTS, 512);
  const wanted = Number.isFinite(radiusMm) && radiusMm > 0 ? fullCircleFacets(radiusMm, undefined, 512) : classic;
  const affordable = profilePoints > 0 ? Math.floor(REVOLVE_TRIANGLE_BUDGET / (2 * profilePoints)) : wanted;
  const chosen = Math.max(classic, Math.min(wanted, affordable));
  // A body stores at most 100,000 vertices: a finely faceted profile gets fewer turns rather than an unstorable solid.
  return profilePoints > 0 ? Math.max(16, Math.min(chosen, Math.floor(80_000 / profilePoints))) : chosen;
}

/**
 * Facets around a full circle of this radius. The chord may sag at most 0.001 of the radius and never more than 0.05 mm, so small
 * circles keep the classic 72 facets and large ones get as many as they need (up to 512), rounded up to a multiple of four so the
 * four quadrant points are always vertices.
 */
export function adaptiveFacetCount(radiusMm: number, minimum = 72, maximum = 512): number {
  if (!Number.isFinite(radiusMm) || radiusMm <= 0) return minimum;
  const sag = Math.min(0.05, radiusMm * 0.001);
  const half = Math.acos(Math.max(-1, Math.min(1, 1 - sag / radiusMm)));
  const count = half > 0 ? Math.ceil(Math.PI / half) : maximum;
  return Math.min(maximum, Math.max(minimum, Math.ceil(count / 4) * 4));
}

/** Signed volume of a closed mesh (positive when its triangles face outward). */
function signedMeshVolume(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = indices[index]! * 3; const b = indices[index + 1]! * 3; const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return total / 6;
}

/** Turns every triangle inside out when the mesh encloses a negative volume (a profile drawn the other way round, or on the other side of the axis). */
export function outwardIndices(positions: readonly number[], indices: readonly number[]): number[] {
  const result = [...indices];
  if (signedMeshVolume(positions, result) >= 0) return result;
  for (let index = 0; index + 2 < result.length; index += 3) { const swap = result[index + 1]!; result[index + 1] = result[index + 2]!; result[index + 2] = swap; }
  return result;
}

/**
 * Revolve a closed profile polygon (millimetres) about the plane's in-plane axis by `degrees`. The profile may lie on either side of the
 * axis and be wound either way: the solid always comes out facing outward (a profile left of the axis used to come out inside out).
 */
export function tessellateRevolve(polygonMm: readonly Point2[], degrees: number, plane: TessellatePlane): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3) return { positionsMm: [], indices: [] };
  const sweep = Math.min(360, Math.max(1, Math.abs(degrees)));
  const full = Math.abs(sweep - 360) < 1e-6;
  const widest = polygon.reduce((maximum, [radius]) => Math.max(maximum, Math.abs(radius)), 0);
  const segments = Math.max(3, Math.round((revolveSegmentsForRadius(widest, polygon.length) * sweep) / 360));
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
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices: outwardIndices(positions, indices) };
}

/**
 * Sweep a closed profile polygon (millimetres) along a world-space direction. Unlike extrude (which goes along the
 * sketch-plane normal) sweep goes along an arbitrary 3D direction, which gives a skewed prism. The top ring is the
 * bottom ring translated by `directionWorld * distanceMm` so caps are parallel; the ribbon sides stay planar quads.
 * Caller must ensure the direction is not parallel to the sketch plane (the builder refuses that).
 */
export function tessellateSweep(polygonMm: readonly Point2[], directionWorldMm: readonly [number, number, number], distanceMm: number, plane: TessellatePlane, twistDeg = 0): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3) return { positionsMm: [], indices: [] };
  const length = Math.hypot(directionWorldMm[0], directionWorldMm[1], directionWorldMm[2]);
  if (length < 1e-9 || !Number.isFinite(distanceMm) || distanceMm === 0) return { positionsMm: [], indices: [] };
  const unit: readonly [number, number, number] = [directionWorldMm[0] / length, directionWorldMm[1] / length, directionWorldMm[2] / length];
  const offset = Math.abs(distanceMm);
  const shift: readonly [number, number, number] = [unit[0] * offset, unit[1] * offset, unit[2] * offset];
  const capTriangles = triangulatePolygon(polygon);
  const count = polygon.length;
  // Twist rotates the top ring about the profile's 2D centroid before placement.
  const centroid = polygonCentroid(polygon);
  const twistRad = (Number.isFinite(twistDeg) ? twistDeg : 0) * Math.PI / 180;
  const sinT = Math.sin(twistRad);
  const cosT = Math.cos(twistRad);
  const localPositions: number[] = [];
  for (const [x, y] of polygon) localPositions.push(x, y, 0);
  for (const [x, y] of polygon) {
    const dx = x - centroid[0];
    const dy = y - centroid[1];
    localPositions.push(centroid[0] + dx * cosT - dy * sinT, centroid[1] + dx * sinT + dy * cosT, 0);
  }
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
export function tessellateSweepPath(polygonMm: readonly Point2[], pathSamples: readonly Point2[], heightMm: number, plane: TessellatePlane, twistDeg = 0, frameTransport = false): TessellatedMesh {
  const polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3 || pathSamples.length < 2) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(heightMm) || heightMm === 0) return { positionsMm: [], indices: [] };
  const height = Math.abs(heightMm);
  const start = pathSamples[0]!;
  const count = polygon.length;
  const centroid = polygonCentroid(polygon);
  const twistRad = (Number.isFinite(twistDeg) ? twistDeg : 0) * Math.PI / 180;
  // Frenet transport: local tangent per sample, central differences inside, one-sided at the endpoints.
  const tangents: Point2[] = frameTransport
    ? pathSamples.map((_, i) => {
      const previous = pathSamples[Math.max(0, i - 1)]!;
      const next = pathSamples[Math.min(pathSamples.length - 1, i + 1)]!;
      const dx = next[0] - previous[0];
      const dy = next[1] - previous[1];
      const length = Math.hypot(dx, dy);
      return (length < 1e-9 ? [1, 0] : [dx / length, dy / length]) as Point2;
    })
    : [];
  const positions: number[] = [];
  for (let s = 0; s < pathSamples.length; s += 1) {
    const sample = pathSamples[s]!;
    const t = s / (pathSamples.length - 1);
    const theta = twistRad * t;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    if (frameTransport) {
      const tangent = tangents[s]!;
      // In-plane perpendicular (profile X → this axis) and out-of-plane (profile Y → sketch-plane +Z).
      const perpendX = -tangent[1];
      const perpendY = tangent[0];
      for (const [px, py] of polygon) {
        // Twist is applied in the profile-local frame about the centroid before placement.
        const dx = px - centroid[0];
        const dy = py - centroid[1];
        const tdx = dx * cosT - dy * sinT;
        const tdy = dx * sinT + dy * cosT;
        positions.push(sample[0] + tdx * perpendX, sample[1] + tdx * perpendY, tdy);
      }
    } else {
      const dx = sample[0] - start[0];
      const dy = sample[1] - start[1];
      const z = height * t;
      for (const [px, py] of polygon) {
        const rx = px - centroid[0];
        const ry = py - centroid[1];
        positions.push(centroid[0] + rx * cosT - ry * sinT + dx, centroid[1] + rx * sinT + ry * cosT + dy, z);
      }
    }
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
 * A rounded dome over a closed profile: ring `r` is the profile scaled about its centroid by cos(φ) and raised by
 * height·sin(φ), with φ running from 0 to 90°, and the last ring is closed by a fan to the apex. A circular profile gives a
 * true half-ellipsoid (a hemisphere when the height equals the radius). A negative `heightMm` builds the dome below the plane.
 */
export function tessellateDome(polygonMm: readonly Point2[], heightMm: number, plane: TessellatePlane, rings = 14): TessellatedMesh {
  let polygon = sanitizePolygon(polygonMm);
  if (polygon.length < 3 || !Number.isFinite(heightMm) || heightMm === 0 || rings < 3) return { positionsMm: [], indices: [] };
  if (signedArea(polygon) < 0) polygon = [...polygon].reverse();
  const height = Math.abs(heightMm);
  const sign = heightMm < 0 ? -1 : 1;
  const centroid = polygonCentroid(polygon);
  const count = polygon.length;
  const positions: number[] = [];
  for (let r = 0; r < rings; r += 1) {
    const phi = (r / rings) * (Math.PI / 2);
    const scale = Math.cos(phi);
    const z = height * Math.sin(phi) * sign;
    for (const [x, y] of polygon) positions.push(centroid[0] + (x - centroid[0]) * scale, centroid[1] + (y - centroid[1]) * scale, z);
  }
  const apex = rings * count;
  positions.push(centroid[0], centroid[1], height * sign);
  const indices: number[] = [];
  const capTriangles = triangulatePolygon(polygon);
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
  for (let r = 0; r < rings - 1; r += 1) {
    const base = r * count;
    const nextBase = (r + 1) * count;
    for (let i = 0; i < count; i += 1) {
      const next = (i + 1) % count;
      indices.push(base + i, base + next, nextBase + next, base + i, nextBase + next, nextBase + i);
    }
  }
  const lastBase = (rings - 1) * count;
  for (let i = 0; i < count; i += 1) indices.push(lastBase + i, lastBase + (i + 1) % count, apex);
  if (sign < 0) for (let i = 0; i < indices.length; i += 3) { const swap = indices[i + 1]!; indices[i + 1] = indices[i + 2]!; indices[i + 2] = swap; }
  return { positionsMm: rotatePositions(positions, PLANE_ROTATION_DEG[plane]), indices };
}

/**
 * Resample an OPEN polyline (an ordered list of points, no implicit closing segment back to the first) into exactly
 * `targetCount` points at equal arc-length intervals. The first and last resampled points match the input endpoints.
 * Used by loft rails so one rail sample lines up with each ring height.
 */
export function resamplePath(path: readonly Point2[], targetCount: number): readonly Point2[] {
  if (path.length === 0 || targetCount < 2) return path;
  if (path.length === 1) return Array.from({ length: targetCount }, () => path[0]!);
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(segment);
    total += segment;
  }
  if (total < 1e-9) return Array.from({ length: targetCount }, () => path[0]!);
  const samples: Point2[] = [];
  for (let step = 0; step < targetCount; step += 1) {
    const targetDistance = (total * step) / (targetCount - 1);
    if (step === targetCount - 1) { samples.push(path[path.length - 1]!); continue; }
    let cumulative = 0;
    for (let probe = 0; probe < lengths.length; probe += 1) {
      const segmentLength = lengths[probe]!;
      if (cumulative + segmentLength >= targetDistance - 1e-9) {
        const a = path[probe]!;
        const b = path[probe + 1]!;
        const t = segmentLength < 1e-9 ? 0 : (targetDistance - cumulative) / segmentLength;
        samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        break;
      }
      cumulative += segmentLength;
    }
  }
  return samples;
}

/**
 * Resample a closed polygon into exactly `targetCount` points at equal arc-length intervals, keeping the polygon's
 * centroid stable. The returned array starts at the resampled position closest to the original polygon's first
 * vertex, so two resampled polygons that share orientation also share their start alignment. Used by the two-profile
 * loft to accept profiles with different vertex counts, and by the rail path to produce one centroid per ring.
 */
export function resampleClosedPolygon(polygon: readonly Point2[], targetCount: number): readonly Point2[] {
  const clean = sanitizePolygon(polygon);
  if (clean.length < 2 || targetCount < 3) return clean;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const a = clean[i]!;
    const b = clean[(i + 1) % clean.length]!;
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(segment);
    total += segment;
  }
  if (total < 1e-9) return clean;
  const resampled: Point2[] = [];
  let segmentIndex = 0;
  let distanceIntoSegment = 0;
  let segmentLength = lengths[0]!;
  for (let step = 0; step < targetCount; step += 1) {
    const targetDistance = (total * step) / targetCount;
    // Advance until the segment contains targetDistance.
    let cumulative = 0;
    for (let probe = 0; probe < lengths.length; probe += 1) {
      if (cumulative + lengths[probe]! >= targetDistance - 1e-9) {
        segmentIndex = probe;
        distanceIntoSegment = targetDistance - cumulative;
        segmentLength = lengths[probe]!;
        break;
      }
      cumulative += lengths[probe]!;
    }
    const a = clean[segmentIndex]!;
    const b = clean[(segmentIndex + 1) % clean.length]!;
    const t = segmentLength < 1e-9 ? 0 : distanceIntoSegment / segmentLength;
    resampled.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return resampled;
}

/**
 * Loft between two explicit profiles on parallel sketch planes. Both polygons must have the same vertex count; the
 * caller is responsible for resampling. `continuity` selects the shape of the ribbon: "position" is a straight linear
 * interpolation between the two rings (G0), "tangent" eases with smoothstep `3t²−2t³` so the ribbon meets each cap
 * tangentially (G1), and "curvature" eases with smootherstep `6t⁵−15t⁴+10t³` so the second derivative is also zero at
 * each cap (G2). The Z coordinate stays linear with t so the caps keep their intended heights.
 */
export function tessellateLoftTwoProfiles(bottom: readonly Point2[], top: readonly Point2[], heightMm: number, continuity: "position" | "tangent" | "curvature", plane: TessellatePlane, rings = 12, railSamples?: readonly Point2[], tangencyWeight = 1): TessellatedMesh {
  let bottomClean = sanitizePolygon(bottom);
  let topClean = sanitizePolygon(top);
  if (bottomClean.length < 3 || topClean.length < 3) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(heightMm) || heightMm === 0) return { positionsMm: [], indices: [] };
  // Resample to a common count when they differ, so mismatched polygons (rectangle ↔ circle, hexagon ↔ triangle) still loft.
  if (bottomClean.length !== topClean.length) {
    const targetCount = Math.max(bottomClean.length, topClean.length, 12);
    bottomClean = resampleClosedPolygon(bottomClean, targetCount);
    topClean = resampleClosedPolygon(topClean, targetCount);
    if (bottomClean.length !== topClean.length) return { positionsMm: [], indices: [] };
  }
  topClean = [...alignLoopStart(bottomClean, topClean)];
  const height = Math.abs(heightMm);
  // A rail forces at least `rings` ring samples so the bend is visible even in the position mode.
  const sampleCount = (continuity === "position" && railSamples === undefined) ? 2 : Math.max(2, rings);
  const count = bottomClean.length;
  const positions: number[] = [];
  // Tangency weight: 0 falls back to linear, 1 is the plain G1/G2 ease, up to 2 over-applies it for a punchier middle.
  const weight = continuity === "position" ? 0 : Math.max(0, Math.min(2, Number.isFinite(tangencyWeight) ? tangencyWeight : 1));
  const smoothstep = (t: number): number => t * t * (3 - 2 * t);
  const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  const target = continuity === "curvature" ? smootherstep : smoothstep;
  const ease = (t: number): number => t + weight * (target(t) - t);
  // The straight-line centroid interpolation is what the rail bends away from.
  const bottomCentroid = polygonCentroid(bottomClean);
  const topCentroid = polygonCentroid(topClean);
  // Resample the rail to one sample per ring so offsets line up with the ring heights exactly.
  const rail = railSamples === undefined ? undefined : resamplePath(railSamples, sampleCount);
  for (let r = 0; r < sampleCount; r += 1) {
    const linear = sampleCount === 1 ? 0 : r / (sampleCount - 1);
    const s = ease(linear);
    const z = height * linear;
    let offsetX = 0;
    let offsetY = 0;
    if (rail !== undefined) {
      const expectedX = bottomCentroid[0] + (topCentroid[0] - bottomCentroid[0]) * linear;
      const expectedY = bottomCentroid[1] + (topCentroid[1] - bottomCentroid[1]) * linear;
      offsetX = rail[r]![0] - expectedX;
      offsetY = rail[r]![1] - expectedY;
    }
    for (let i = 0; i < count; i += 1) {
      const a = bottomClean[i]!;
      const b = topClean[i]!;
      positions.push(a[0] + (b[0] - a[0]) * s + offsetX, a[1] + (b[1] - a[1]) * s + offsetY, z);
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

/**
 * Helical sweep of a closed profile around the sketch-plane normal axis. The profile centroid traces a circle of
 * `radiusMm` in the sketch plane, advancing along the axis by `pitchMm` per full turn, for `turns` turns. Each ring
 * is built in a Frenet-like frame: the profile's X axis points radially outward (away from the axis), the profile's
 * Y axis follows the helix tangent's axial component. `handedness` picks the direction: "right" winds up with +Z,
 * "left" winds down. Produces a tessellated tube with cap triangulation at both ends.
 */
export function tessellateHelix(profileMm: readonly Point2[], radiusMm: number, pitchMm: number, turns: number, handedness: "right" | "left", plane: TessellatePlane, segmentsPerTurn = 24): TessellatedMesh {
  const profile = sanitizePolygon(profileMm);
  if (profile.length < 3) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(radiusMm) || radiusMm <= 0) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(pitchMm) || pitchMm <= 0) return { positionsMm: [], indices: [] };
  if (!Number.isFinite(turns) || turns <= 0) return { positionsMm: [], indices: [] };
  const signedPitch = handedness === "left" ? -pitchMm : pitchMm;
  const sampleCount = Math.max(2, Math.ceil(turns * Math.max(3, segmentsPerTurn)) + 1);
  const count = profile.length;
  const centroid = polygonCentroid(profile);
  const positions: number[] = [];
  for (let s = 0; s < sampleCount; s += 1) {
    const t = s / (sampleCount - 1);
    const theta = turns * 2 * Math.PI * t;
    const z = signedPitch * turns * t;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // Radial outward unit vector in the sketch plane.
    const centerX = radiusMm * cos;
    const centerY = radiusMm * sin;
    for (const [px, py] of profile) {
      const dx = px - centroid[0];
      const dy = py - centroid[1];
      // Profile X → radial outward (cos, sin, 0), Profile Y → +Z axis.
      positions.push(centerX + dx * cos, centerY + dx * sin, z + dy);
    }
  }
  const capTriangles = triangulatePolygon(profile);
  const indices: number[] = [];
  // Bottom cap (reverse winding).
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(capTriangles[i]!, capTriangles[i + 2]!, capTriangles[i + 1]!);
  // Top cap at the last ring.
  const topBase = (sampleCount - 1) * count;
  for (let i = 0; i < capTriangles.length; i += 3) indices.push(topBase + capTriangles[i]!, topBase + capTriangles[i + 1]!, topBase + capTriangles[i + 2]!);
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
export function sanitizePolygon(polygon: readonly Point2[]): readonly Point2[] {
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

export function rotatePositions(positions: readonly number[], rotationDeg: Vec3): readonly number[] {
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
