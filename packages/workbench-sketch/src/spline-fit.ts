import { SPLINE_MAX_FIT_POINTS, SPLINE_MIN_FIT_POINTS, failure, type SketchEntity, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import { buildSketchEntity, sampleSpline } from "./index.js";

/**
 * Fit-point splines with a choice of parameterisation, and adding and removing fit points.
 *
 * A fit-point spline is drawn as a uniform Catmull-Rom curve through its points, which loops and backtracks when the clicks
 * are unevenly spaced (a short step beside a long one). Chord-length and centripetal parameterisation space the curve by the
 * distance between the points and do not. The stored spline stays an ordinary list of fit points, so nothing else in the
 * program needs to know: the clicked points are kept exactly and extra fit points are added on the chord-length or
 * centripetal curve between them, spaced evenly enough that the uniform curve through the whole list follows it.
 */
export type SplineParameterization = "uniform" | "chord-length" | "centripetal";

export const SPLINE_PARAMETERIZATION_LABELS: Readonly<Record<SplineParameterization, string>> = {
  uniform: "Uniform (classic)",
  "chord-length": "Chord length",
  centripetal: "Centripetal"
};

const MIN_GAP_MM = 0.01;

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** One span of a non-uniform Catmull-Rom curve (Barry and Goldman's pyramid), between p1 and p2, at u in [0, 1]. */
function catmullRomPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, alpha: number, u: number): Vec2 {
  const knot = (a: Vec2, b: Vec2, previous: number): number => previous + Math.max(distance(a, b), 1e-9) ** alpha;
  const t0 = 0;
  const t1 = knot(p0, p1, t0);
  const t2 = knot(p1, p2, t1);
  const t3 = knot(p2, p3, t2);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const w = tb === ta ? 0 : (t - ta) / (tb - ta);
    return [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/**
 * How many fit points each span gets: at least one (the span itself), more for long spans so that every gap comes out within
 * about 1.2 times the shortest span (a uniform curve through points whose neighbouring gaps differ by more than about 2 loops
 * and backtracks), and never more than 64 points in all. When the budget runs out the spacing is widened as little as it takes.
 */
function spanCounts(lengths: readonly number[]): readonly number[] {
  const budget = SPLINE_MAX_FIT_POINTS - 1;
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const countsFor = (spacing: number): number[] => lengths.map((length) => (length < 2 * MIN_GAP_MM ? 1 : Math.max(1, Math.round(length / spacing))));
  const sum = (values: readonly number[]): number => values.reduce((all, value) => all + value, 0);
  const shortest = Math.min(...lengths.filter((length) => length >= 2 * MIN_GAP_MM), Number.POSITIVE_INFINITY);
  const wanted = Number.isFinite(shortest) ? 1.2 * shortest : total;
  if (sum(countsFor(wanted)) <= budget) return countsFor(wanted);
  let low = wanted;
  let high = Math.max(total, wanted);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (sum(countsFor(middle)) <= budget) high = middle; else low = middle;
  }
  return countsFor(high);
}

/**
 * A fit-point spline through the clicked points with the chosen parameterisation. "uniform" is the classic spline exactly as
 * clicked; the other two keep the clicked points and add fit points between them (up to 64 in all), so the curve follows the
 * chord-length or centripetal curve and does not loop when clicks are unevenly spaced.
 */
export function buildFitSpline(points: readonly Vec2[], parameterization: SplineParameterization, id: string, tangents: SplineEndTangents = {}): WorkbenchResult<SketchEntity> {
  if (points.length < 2) return failure("INVALID_OPERATION", "A spline needs at least two points.", [], "Click a second point.");
  const conditions = tangents.start !== undefined || tangents.end !== undefined;
  const through = withEndConditions(points, tangents);
  if (!through.ok) return through;
  // The loops of a uniform curve through unevenly spaced points would bend the end conditions: an end tangent uses the centripetal spacing.
  const mode: SplineParameterization = conditions && parameterization === "uniform" ? "centripetal" : parameterization;
  return fitThrough(through.value, mode, id);
}

/** The direction a spline leaves its first point and arrives at its last, as unit vectors (undefined leaves that end free). */
export interface SplineEndTangents {
  readonly start?: Vec2 | undefined;
  readonly end?: Vec2 | undefined;
}

/** The unit vector of a direction written in degrees counter-clockwise from +X, or undefined for blank/invalid text. */
export function tangentFromDegrees(degrees: number | undefined): Vec2 | undefined {
  if (degrees === undefined || !Number.isFinite(degrees)) return undefined;
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/** How far along an end tangent the helper fit point sits, as a fraction of the gap to the next point. */
const TANGENT_REACH = 0.25;

/**
 * The fit points a spline really passes through: two clicks become a straight spline (the middle point is the midpoint), and an end tangent
 * adds one fit point a quarter of the way to the next point along that direction. A fit-point spline leaves its first point along the chord to
 * the second fit point, so the curve leaves with exactly the asked direction; the extra point is an ordinary fit point and can be dragged.
 */
function withEndConditions(points: readonly Vec2[], tangents: SplineEndTangents): WorkbenchResult<readonly Vec2[]> {
  const unit = (v: Vec2 | undefined): Vec2 | undefined => {
    if (v === undefined) return undefined;
    const length = Math.hypot(v[0], v[1]);
    return length < 1e-9 || !Number.isFinite(length) ? undefined : [v[0] / length, v[1] / length];
  };
  const start = unit(tangents.start);
  const end = unit(tangents.end);
  if ((tangents.start !== undefined && start === undefined) || (tangents.end !== undefined && end === undefined)) return failure("INVALID_OPERATION", "A spline end direction must be a finite angle.", [], "Type an angle in degrees, or clear the field.");
  let fit: Vec2[] = [...points];
  if (fit.length === 2) {
    const [a, b] = fit as [Vec2, Vec2];
    if (distance(a, b) < MIN_GAP_MM) return failure("INVALID_OPERATION", "The two spline points must be at least 0.01 mm apart.", [], "Place the second point further away.");
    // Without end directions a two-point spline is the straight line through its points, kept as a spline with the midpoint as its third fit point.
    if (start === undefined && end === undefined) return { ok: true, value: [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b] };
  }
  if (start !== undefined) {
    const reach = TANGENT_REACH * distance(fit[0]!, fit[1]!);
    fit = [fit[0]!, [fit[0]![0] + start[0] * reach, fit[0]![1] + start[1] * reach], ...fit.slice(1)];
  }
  if (end !== undefined) {
    const last = fit[fit.length - 1]!;
    const reach = TANGENT_REACH * distance(last, fit[fit.length - 2]!);
    fit = [...fit.slice(0, -1), [last[0] - end[0] * reach, last[1] - end[1] * reach], last];
  }
  return { ok: true, value: fit };
}

function fitThrough(points: readonly Vec2[], parameterization: SplineParameterization, id: string): WorkbenchResult<SketchEntity> {
  const classic = buildSketchEntity("spline", points, id);
  if (!classic.ok || parameterization === "uniform") return classic;
  const alpha = parameterization === "chord-length" ? 1 : 0.5;
  const lengths = points.slice(1).map((point, index) => distance(points[index]!, point));
  const counts = spanCounts(lengths);
  const fit: Vec2[] = [points[0]!];
  for (let span = 0; span < points.length - 1; span += 1) {
    const p0 = points[Math.max(0, span - 1)]!;
    const p1 = points[span]!;
    const p2 = points[span + 1]!;
    // Mirror the end points so the curve leaves them along the first and last chord, as the uniform curve does.
    const before: Vec2 = span === 0 ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : p0;
    const after: Vec2 = span === points.length - 2 ? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] : points[span + 2]!;
    const count = counts[span]!;
    for (let step = 1; step < count; step += 1) fit.push(catmullRomPoint(before, p1, p2, after, alpha, step / count));
    fit.push(p2);
  }
  if (fit.length > SPLINE_MAX_FIT_POINTS) return failure("INVALID_OPERATION", `This spline needs ${fit.length} fit points and at most ${SPLINE_MAX_FIT_POINTS} are allowed.`, [], "Click fewer points.");
  return buildSketchEntity("spline", fit, id);
}

type Spline = Extract<SketchEntity, { kind: "spline" }>;

const SAMPLES_PER_SPAN = 24;

/**
 * Adds a fit point to a spline at the curve point nearest to `near`, so the shape barely changes and the new point can then
 * be dragged. Refused when the spline already has 64 points or the click is on top of an existing point.
 */
export function insertSplineFitPoint(spline: Spline, near: Vec2): WorkbenchResult<{ readonly spline: Spline; readonly index: number }> {
  if (spline.fitPoints.length >= SPLINE_MAX_FIT_POINTS) return failure("RESOURCE_LIMIT", `A spline takes at most ${SPLINE_MAX_FIT_POINTS} fit points.`, [spline.id], "Remove a fit point first.");
  const samples = sampleSpline(spline.fitPoints, SAMPLES_PER_SPAN);
  let best = { distance: Infinity, point: samples[0]!, span: 0 };
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]!;
    const b = samples[index]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((near[0] - a[0]) * dx + (near[1] - a[1]) * dy) / lengthSquared));
    const point: Vec2 = [a[0] + dx * t, a[1] + dy * t];
    const gap = distance(point, near);
    if (gap < best.distance) best = { distance: gap, point, span: Math.min(spline.fitPoints.length - 2, Math.floor((index - 1) / SAMPLES_PER_SPAN)) };
  }
  const before = spline.fitPoints[best.span]!;
  const after = spline.fitPoints[best.span + 1]!;
  if (distance(best.point, before) < 2 * MIN_GAP_MM || distance(best.point, after) < 2 * MIN_GAP_MM) {
    return failure("DEGENERATE_GEOMETRY", "That is on top of an existing fit point.", [spline.id], "Click on the curve between two fit points.");
  }
  const fitPoints = [...spline.fitPoints.slice(0, best.span + 1), best.point, ...spline.fitPoints.slice(best.span + 1)];
  return { ok: true, value: { spline: { ...spline, fitPoints }, index: best.span + 1 } };
}

/** Removes an interior fit point. The end points hold the spline's joints and the spline keeps at least three points. */
export function removeSplineFitPoint(spline: Spline, index: number): WorkbenchResult<Spline> {
  if (!Number.isInteger(index) || index < 0 || index >= spline.fitPoints.length) return failure("INVALID_OPERATION", "That fit point does not exist.", [spline.id], "Pick one of the spline's points.");
  if (index === 0 || index === spline.fitPoints.length - 1) return failure("INVALID_OPERATION", "The two end points of a spline hold its joints and cannot be removed.", [spline.id], "Remove an interior point, or delete the spline.");
  if (spline.fitPoints.length <= SPLINE_MIN_FIT_POINTS) return failure("INVALID_OPERATION", `A spline needs at least ${SPLINE_MIN_FIT_POINTS} fit points.`, [spline.id], "Delete the spline, or draw a line.");
  const fitPoints = spline.fitPoints.filter((_, position) => position !== index);
  if (fitPoints.some((point, position) => position > 0 && distance(fitPoints[position - 1]!, point) < MIN_GAP_MM)) {
    return failure("DEGENERATE_GEOMETRY", "Removing that point would leave two fit points on top of each other.", [spline.id], "Remove a different point.");
  }
  return { ok: true, value: { ...spline, fitPoints } };
}
