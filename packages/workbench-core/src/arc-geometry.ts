import { ENVELOPE_LIMITS } from "./envelope-limits.js";
import type { Vec2 } from "./types.js";

/**
 * Scale-relative checks for three-point arcs and circles. The old tests used absolute thresholds (a cross product under
 * 1e-4, a determinant under 1e-9), which accepted a near-straight arc with a radius of hundreds of millions of millimetres
 * while refusing a tiny arc that is perfectly well formed. A three-point arc is judged by its circumradius instead.
 */

/** The largest circle or arc radius a sketch may hold: the envelope's circle radius limit, shared through envelope-limits.ts (which imports nothing, so there is no cycle with envelope.ts). */
export const MAX_ARC_RADIUS_MM: number = ENVELOPE_LIMITS.maxSketchRadiusMm;

/** The smallest circle or arc radius a sketch may hold. */
export const MIN_ARC_RADIUS_MM: number = ENVELOPE_LIMITS.minGeometryMm;

export interface ThreePointCircle {
  readonly center: Vec2;
  readonly radiusMm: number;
}

/**
 * The circle through three points, or undefined when two of the points coincide or the three are in a straight line to
 * within double precision. The result is not limited in radius; see threePointArcProblem for the sketch limits.
 */
export function circleThroughThreePoints(a: Vec2, b: Vec2, c: Vec2): ThreePointCircle | undefined {
  // Work relative to `a` so large coordinates do not cancel away the small differences that decide the circle.
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const cx = c[0] - a[0];
  const cy = c[1] - a[1];
  const determinant = 2 * (bx * cy - by * cx);
  const scale = Math.max(Math.hypot(bx, by), Math.hypot(cx, cy));
  if (!Number.isFinite(determinant) || scale === 0 || Math.abs(determinant) <= 1e-15 * scale * scale) return undefined;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / determinant;
  const uy = (bx * c2 - cx * b2) / determinant;
  const radiusMm = Math.hypot(ux, uy);
  if (!Number.isFinite(radiusMm)) return undefined;
  return { center: [a[0] + ux, a[1] + uy], radiusMm };
}

/**
 * Why three points cannot be a sketch arc or circle, or undefined when they can. They are refused when two coincide, when
 * they are in line, when the circle through them is larger than 10,000 mm (draw a line instead) or smaller than 0.01 mm.
 */
export function threePointArcProblem(start: Vec2, mid: Vec2, end: Vec2): string | undefined {
  const circle = circleThroughThreePoints(start, mid, end);
  if (circle === undefined) return "The three points must be distinct and must not lie on a straight line.";
  if (circle.radiusMm > MAX_ARC_RADIUS_MM) {
    return `The circle through these three points has a radius of ${formatRadius(circle.radiusMm)} mm, above the ${MAX_ARC_RADIUS_MM.toLocaleString("en-US")} mm limit: the points are nearly in line, so draw a line instead or bend the middle point further out.`;
  }
  if (circle.radiusMm < MIN_ARC_RADIUS_MM) return `The circle through these three points has a radius under ${MIN_ARC_RADIUS_MM} mm.`;
  return undefined;
}

function formatRadius(value: number): string {
  return value >= 1e6 ? value.toExponential(2) : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
