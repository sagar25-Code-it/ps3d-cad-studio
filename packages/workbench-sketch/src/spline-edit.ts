import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { MAX_SPLINE_FIT_POINTS, MIN_SPLINE_FIT_POINTS } from "../../workbench-core/src/spline-limits.js";
import { MIN_SPLINE_FIT_GAP_MM } from "../../workbench-core/src/spline-curvature.js";
import { sampleSpline } from "./index.js";

/**
 * Fit-point surgery on a spline (audit Sketch edit E25): insert a fit point on the curve where the person double-clicks, and
 * remove one. Both keep the curve passing through every remaining fit point and both refuse changes the spline cannot hold
 * (too few points, too many, two points closer than the model allows).
 */
export type SplineEntity = Extract<SketchEntity, { kind: "spline" }>;

export type SplineFitEdit =
  | { readonly ok: true; readonly entity: SplineEntity; readonly index: number }
  | { readonly ok: false; readonly message: string };

const SAMPLES_PER_SPAN = 8;

/** The nearest point of the spline's curve to `point`, with the span (between fit point `span` and `span + 1`) it lies on. */
export function nearestPointOnSpline(entity: SplineEntity, point: Vec2): { readonly point: Vec2; readonly span: number; readonly distanceMm: number } | undefined {
  const samples = sampleSpline(entity.fitPoints, SAMPLES_PER_SPAN);
  let best: { point: Vec2; span: number; distanceMm: number } | undefined;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index]!;
    const b = samples[index + 1]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const lengthSquared = abx * abx + aby * aby;
    const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / lengthSquared));
    const foot: Vec2 = [a[0] + abx * t, a[1] + aby * t];
    const distanceMm = Math.hypot(point[0] - foot[0], point[1] - foot[1]);
    if (best === undefined || distanceMm < best.distanceMm) best = { point: foot, span: Math.min(entity.fitPoints.length - 2, Math.floor(index / SAMPLES_PER_SPAN)), distanceMm };
  }
  return best;
}

/** Adds a fit point on the curve nearest to `point`, in the span it belongs to. */
export function insertSplineFitPoint(entity: SplineEntity, point: Vec2): SplineFitEdit {
  if (entity.fitPoints.length >= MAX_SPLINE_FIT_POINTS) return { ok: false, message: `A spline takes at most ${MAX_SPLINE_FIT_POINTS} fit points.` };
  const near = nearestPointOnSpline(entity, point);
  if (near === undefined) return { ok: false, message: "The spline has no curve to add a point to." };
  const index = near.span + 1;
  const fitPoints = [...entity.fitPoints.slice(0, index), near.point, ...entity.fitPoints.slice(index)];
  const previous = fitPoints[index - 1]!;
  const next = fitPoints[index + 1]!;
  const gap = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (gap(previous, near.point) < MIN_SPLINE_FIT_GAP_MM || gap(next, near.point) < MIN_SPLINE_FIT_GAP_MM) return { ok: false, message: "That is too close to an existing fit point. Click further along the curve." };
  return { ok: true, entity: { ...entity, fitPoints }, index };
}

/** Removes the fit point at `index`; the curve then passes through the others. */
export function removeSplineFitPoint(entity: SplineEntity, index: number): SplineFitEdit {
  if (!Number.isInteger(index) || index < 0 || index >= entity.fitPoints.length) return { ok: false, message: "That fit point does not exist." };
  if (entity.fitPoints.length <= MIN_SPLINE_FIT_POINTS) return { ok: false, message: `A spline needs at least ${MIN_SPLINE_FIT_POINTS} fit points.` };
  const fitPoints = entity.fitPoints.filter((_, position) => position !== index);
  for (let at = 1; at < fitPoints.length; at += 1) {
    const a = fitPoints[at - 1]!;
    const b = fitPoints[at]!;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_SPLINE_FIT_GAP_MM) return { ok: false, message: "Removing that point would leave two fit points on top of each other." };
  }
  return { ok: true, entity: { ...entity, fitPoints }, index: Math.max(0, index - 1) };
}
