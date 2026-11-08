import { SPLINE_MAX_FIT_POINTS, SPLINE_MIN_FIT_POINTS, failure, type SketchEntity, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import type { ShapeIds, SketchShape } from "./shapes.js";
import { MAX_SPLINE_FIT_POINTS } from "../../workbench-core/src/spline-limits.js";

/** Small 2D helpers shared by the curve-tool modules (kept here so the tools stay independent of each other). */
export type { ShapeIds, SketchShape };

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec2, factor: number): Vec2 => [a[0] * factor, a[1] * factor];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const polar = (center: Vec2, radius: number, angle: number): Vec2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];

export function normalize(a: Vec2): Vec2 {
  const length = Math.hypot(a[0], a[1]);
  return length < 1e-12 ? [0, 0] : [a[0] / length, a[1] / length];
}

/** Twice the signed area of the triangle a, b, c (positive when counter-clockwise). */
export const turn = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: dist(center, a) };
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += dist(points[index - 1]!, points[index]!);
  return total;
}

/**
 * Where along a curve (0 to 1) the interior point number `step` of `count` falls: equally spaced, except that with an
 * `endLead` (a fraction of the regular spacing, 0.25 is typical) the first and last interior points sit that much closer
 * to the ends, so the chord leaving each end of a spline through them lies nearer the curve's tangent there. The fit-point
 * spline is a uniform Catmull-Rom curve, which loops if neighbouring gaps differ too much, so the lead stays above 0.2.
 */
function stepFraction(step: number, count: number, endLead: number): number {
  const spacing = 1 / (count - 1);
  const lead = endLead > 0 && count >= 6 ? spacing * Math.min(1, Math.max(0.2, endLead)) : 0;
  const interior = count - 2;
  if (lead === 0) return step * spacing;
  return step === 1 ? lead : step === interior ? 1 - lead : lead + ((1 - 2 * lead) * (step - 1)) / (interior - 1);
}

/**
 * Picks `count` points spaced equally by path length along a dense polyline. The first and last points are the
 * polyline's own ends, exactly, so a curve built from them still joins what it was meant to join.
 */
export function resampleByLength(dense: readonly Vec2[], count: number, endLead = 0): readonly Vec2[] {
  if (dense.length < 2 || count < 2) return dense;
  const cumulative: number[] = [0];
  for (let index = 1; index < dense.length; index += 1) cumulative.push(cumulative[index - 1]! + dist(dense[index - 1]!, dense[index]!));
  const total = cumulative[cumulative.length - 1]!;
  if (total < 1e-12) return [dense[0]!, dense[dense.length - 1]!];
  const out: Vec2[] = [dense[0]!];
  let segment = 1;
  for (let step = 1; step < count - 1; step += 1) {
    const target = total * stepFraction(step, count, endLead);
    while (segment < cumulative.length - 1 && cumulative[segment]! < target) segment += 1;
    const lo = cumulative[segment - 1]!;
    const span = cumulative[segment]! - lo;
    out.push(lerp(dense[segment - 1]!, dense[segment]!, span < 1e-12 ? 0 : (target - lo) / span));
  }
  out.push(dense[dense.length - 1]!);
  return out;
}

/**
 * Samples a parametric curve densely to measure its length, then returns `count` points equally spaced along it. Each point
 * is evaluated on the curve itself (not interpolated on a chord), and the first and last are the curve at t0 and t1.
 * With `endLead` (a fraction of the regular spacing, see stepFraction) the second and second-to-last points sit closer to the
 * ends, so the chord leaving each end of the resulting spline lies nearer the curve's own tangent there.
 * With `curvatureBias` above zero the points crowd where the curve bends sharply: the spacing density is
 * 1 + bias * sqrt(curvature * length), so a fit-point spline through them follows a tight shoulder instead of cutting it
 * (a conic with rho 0.98 deviated 0.9 mm from its curve with 24 evenly spaced points, and under 0.002 mm with a bias of 2).
 * The neighbouring gaps stay within about a factor of 2.3 of each other, which the uniform spline interpolation tolerates.
 */
export function sampleCurveToFitPoints(curve: (t: number) => Vec2, t0: number, t1: number, count = 24, dense = 480, endLead = 0, curvatureBias = 0): readonly Vec2[] {
  const params: number[] = [];
  const samples: Vec2[] = [];
  for (let index = 0; index <= dense; index += 1) {
    const t = t0 + ((t1 - t0) * index) / dense;
    params.push(t);
    samples.push(curve(t));
  }
  const cumulative: number[] = [0];
  for (let index = 1; index < samples.length; index += 1) cumulative.push(cumulative[index - 1]! + dist(samples[index - 1]!, samples[index]!));
  const length = cumulative[cumulative.length - 1]!;
  if (length < 1e-12 || count < 2) return [samples[0]!, samples[samples.length - 1]!];
  // The spacing measure: plain path length, or path length weighted up where the curve turns quickly.
  let measure = cumulative;
  if (curvatureBias > 0) {
    measure = [0];
    for (let index = 1; index < samples.length; index += 1) {
      const step = cumulative[index]! - cumulative[index - 1]!;
      const before = samples[Math.max(0, index - 2)]!;
      const here = samples[index - 1]!;
      const after = samples[index]!;
      const turnAngle = Math.abs(Math.atan2((here[0] - before[0]) * (after[1] - here[1]) - (here[1] - before[1]) * (after[0] - here[0]), (here[0] - before[0]) * (after[0] - here[0]) + (here[1] - before[1]) * (after[1] - here[1])));
      const localLength = Math.max(dist(before, here) + step, 1e-12) / 2;
      measure.push(measure[index - 1]! + step * (1 + curvatureBias * Math.sqrt((turnAngle / localLength) * length)));
    }
  }
  const total = measure[measure.length - 1]!;
  const out: Vec2[] = [curve(t0)];
  let segment = 1;
  for (let step = 1; step < count - 1; step += 1) {
    const target = total * stepFraction(step, count, endLead);
    while (segment < measure.length - 1 && measure[segment]! < target) segment += 1;
    const lo = measure[segment - 1]!;
    const span = measure[segment]! - lo;
    const fraction = span < 1e-12 ? 0 : (target - lo) / span;
    out.push(curve(params[segment - 1]! + (params[segment]! - params[segment - 1]!) * fraction));
  }
  out.push(curve(t1));
  return out;
}

export function badShape(message: string, recovery = "Place the points somewhere else, or press Esc to start over."): WorkbenchResult<never> {
  return failure("INVALID_OPERATION", message, [], recovery);
}

/** A fit-point spline entity, refused when the points are too close together or too few for one. */
export function splineFromPoints(fitPoints: readonly Vec2[], id: string, construction = false): WorkbenchResult<Extract<SketchEntity, { kind: "spline" }>> {
  if (fitPoints.length < SPLINE_MIN_FIT_POINTS) return badShape("A spline needs at least three fit points.");
  if (fitPoints.length > SPLINE_MAX_FIT_POINTS) return badShape(`A spline takes at most ${SPLINE_MAX_FIT_POINTS} fit points.`);
  if (fitPoints.some((point, index) => index > 0 && dist(fitPoints[index - 1]!, point) < 0.01)) return badShape("The curve is too small: consecutive fit points would be closer than 0.01 mm.");
  if (fitPoints.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return badShape("The curve could not be computed from these points.");
  return { ok: true, value: { id, kind: "spline", fitPoints, construction } };
}
