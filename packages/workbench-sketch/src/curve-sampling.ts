import type { Vec2 } from "../../workbench-core/src/index.js";
import { isPeriodicSpline, splineDerivativesAt, splineSpanCount } from "../../workbench-core/src/spline-curvature.js";

/**
 * Curve sampling shared by the profile engine and the rest of the sketch modules.
 *
 * Arcs and circles are sampled by a chord-error bound, not a fixed facet count: a short arc of a small circle gets a
 * few edges and a large bore gets as many as it needs to stay within `CHORD_TOLERANCE_MM` of the true curve.
 * Fit-point splines are centripetal Catmull-Rom curves, which follow the points without loops or backtracking when the
 * clicks are unevenly spaced, and a spline whose last fit point equals its first is periodic (smooth across the join).
 */

/** The largest distance between a sampled edge and the true curve it stands for. */
export const CHORD_TOLERANCE_MM = 0.01;

const TWO_PI = Math.PI * 2;
const MAX_ARC_STEPS = 1440;
/** At least 72 edges to a full turn (5 degrees), as circles have always been sampled; the chord bound only adds edges for big radii. */
const MIN_STEP_RADIANS = (2 * Math.PI) / 72;

/** How many straight edges an arc of `sweepAbs` radians on a circle of `radius` needs to stay within `chordTolMm`. */
export function arcStepCount(radius: number, sweepAbs: number, chordTolMm = CHORD_TOLERANCE_MM): number {
  const maxStep = radius > chordTolMm ? 2 * Math.acos(1 - chordTolMm / radius) : Math.PI / 2;
  const byTolerance = Math.ceil(sweepAbs / maxStep);
  const bySmoothness = Math.ceil(sweepAbs / MIN_STEP_RADIANS);
  return Math.min(MAX_ARC_STEPS, Math.max(1, byTolerance, bySmoothness));
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

/** The circle through a 3-point arc, with the start angle and the signed sweep (positive counter-clockwise). */
export function arcCircle(start: Vec2, mid: Vec2, end: Vec2): { readonly center: Vec2; readonly radiusMm: number; readonly startAngle: number; readonly sweep: number } | undefined {
  const circle = circumcircle(start, mid, end);
  if (circle === undefined) return undefined;
  const startAngle = Math.atan2(start[1] - circle.center[1], start[0] - circle.center[0]);
  const endAngle = Math.atan2(end[1] - circle.center[1], end[0] - circle.center[0]);
  const ccw = (mid[0] - start[0]) * (end[1] - start[1]) - (mid[1] - start[1]) * (end[0] - start[0]) > 0;
  const raw = ccw ? endAngle - startAngle : startAngle - endAngle;
  const sweepAbs = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
  return { center: circle.center, radiusMm: circle.radiusMm, startAngle, sweep: ccw ? sweepAbs : -sweepAbs };
}

/**
 * Points along a 3-point arc from `start` to `end` through `mid`, including both ends. Falls back to the chord when the
 * three points are collinear. The step count follows the chord-error bound.
 */
export function sampleArc(start: Vec2, mid: Vec2, end: Vec2, chordTolMm = CHORD_TOLERANCE_MM): readonly Vec2[] {
  const circle = arcCircle(start, mid, end);
  if (circle === undefined) return [start, end];
  const sweepAbs = Math.abs(circle.sweep);
  if (sweepAbs < 1e-12) return [start, end];
  const steps = Math.max(2, arcStepCount(circle.radiusMm, sweepAbs, chordTolMm));
  const points: Vec2[] = [start];
  for (let step = 1; step < steps; step += 1) {
    const angle = circle.startAngle + (circle.sweep * step) / steps;
    points.push([circle.center[0] + circle.radiusMm * Math.cos(angle), circle.center[1] + circle.radiusMm * Math.sin(angle)]);
  }
  points.push(end);
  return points;
}

// ---------------------------------------------------------------------------------------------
// Splines (the curve itself lives in workbench-core/spline-curvature.ts, shared with the Smooth constraint)
// ---------------------------------------------------------------------------------------------

/** A fit-point spline whose last point is its first closes on itself into a smooth periodic curve. */
export function isClosedFitSpline(fitPoints: readonly Vec2[], toleranceMm = 1e-9): boolean {
  return isPeriodicSpline(fitPoints, toleranceMm);
}

/** Number of spans (fit-point to fit-point pieces) of the spline. */
export { splineSpanCount };

/** The point of span `span` (from fit point `span` to `span + 1`) at parameter `s` in [0, 1]. */
export function splinePositionAt(fitPoints: readonly Vec2[], span: number, s: number): Vec2 {
  if (s <= 0) return span >= 0 && span < fitPoints.length ? fitPoints[span]! : fitPoints[0]!;
  if (s >= 1) return fitPoints[Math.min(fitPoints.length - 1, span + 1)]!;
  return splineDerivativesAt(fitPoints, span, s).point;
}

/**
 * Smooth curve through the fit points, sampled into short straight edges (`samplesPerSpan` per span).
 * The first and last samples are exactly the first and last fit points.
 */
export function sampleSpline(fitPoints: readonly Vec2[], samplesPerSpan = 8): readonly Vec2[] {
  if (fitPoints.length < 3) return fitPoints;
  const points: Vec2[] = [fitPoints[0]!];
  const spans = splineSpanCount(fitPoints);
  for (let span = 0; span < spans; span += 1) {
    for (let step = 1; step <= samplesPerSpan; step += 1) {
      if (step === samplesPerSpan) {
        points.push(fitPoints[span + 1]!);
        break;
      }
      points.push(splinePositionAt(fitPoints, span, step / samplesPerSpan));
    }
  }
  return points;
}

/**
 * Samples a spline so no edge strays further than `chordTolMm` from the curve: each span is subdivided until its midpoint
 * is within tolerance of the chord. Returns the polyline and, for each vertex, how far along the spline it is (0 to 1 by arc length).
 */
export function flattenSpline(fitPoints: readonly Vec2[], chordTolMm = CHORD_TOLERANCE_MM): { readonly points: readonly Vec2[]; readonly params: readonly number[] } {
  const points: Vec2[] = [fitPoints[0]!];
  const spans = splineSpanCount(fitPoints);
  for (let span = 0; span < spans; span += 1) {
    const from = splinePositionAt(fitPoints, span, 0);
    const to = splinePositionAt(fitPoints, span, 1);
    const subdivide = (s0: number, p0: Vec2, s1: number, p1: Vec2, depth: number): void => {
      const sm = (s0 + s1) / 2;
      const pm = splinePositionAt(fitPoints, span, sm);
      const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const deviation = chord < 1e-12 ? Math.hypot(pm[0] - p0[0], pm[1] - p0[1]) : Math.abs((p1[0] - p0[0]) * (p0[1] - pm[1]) - (p0[0] - pm[0]) * (p1[1] - p0[1])) / chord;
      if (depth < 12 && (deviation > chordTolMm || depth < 2)) {
        subdivide(s0, p0, sm, pm, depth + 1);
        subdivide(sm, pm, s1, p1, depth + 1);
      } else {
        points.push(p1);
      }
    };
    subdivide(0, from, 1, to, 0);
  }
  const cumulative: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    cumulative.push(cumulative[index - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cumulative[cumulative.length - 1]! || 1;
  return { points, params: cumulative.map((value) => value / total) };
}
