/**
 * Exact derivatives of the sketch's fit-point spline.
 *
 * A spline entity is a uniform Catmull-Rom curve through its fit points whose first and last spans repeat the end point as the
 * missing neighbour (the same curve `sampleSpline` draws). Inside a span the curve is a cubic, so its first and second
 * derivatives are known exactly; the signed curvature (positive when the curve turns left) follows from them. This module
 * works on that curve only; it does not depend on the sketch package.
 */

export type SplinePoint = readonly [number, number];

export interface SplineDerivatives {
  readonly point: SplinePoint;
  /** First derivative with respect to the span parameter t in [0, 1]. */
  readonly d1: SplinePoint;
  /** Second derivative with respect to t. */
  readonly d2: SplinePoint;
}

/** The smallest gap between consecutive fit points a sketch accepts (kept in step with the sketch validation). */
export const MIN_SPLINE_FIT_GAP_MM = 0.01;

/** A fit-point spline whose last point is its first closes on itself into a smooth periodic curve. */
export function isPeriodicSpline(fit: readonly SplinePoint[], toleranceMm = 1e-9): boolean {
  if (fit.length < 4) return false;
  const first = fit[0]!;
  const last = fit[fit.length - 1]!;
  return Math.hypot(last[0] - first[0], last[1] - first[1]) <= toleranceMm;
}

/** Number of spans of a fit-point spline (one fewer than the fit points). */
export function splineSpanCount(fit: readonly SplinePoint[]): number {
  return Math.max(0, fit.length - 1);
}

/**
 * How far the knot spacing departs from uniform: 0 for evenly spaced fit points, up to 0.75 (between centripetal and chordal) when
 * neighbouring chords differ by a factor of eight or more. A uniform Catmull-Rom curve loops or backtracks when the gaps differ much;
 * centripetal to chordal parameterisations do not. Between a factor of four and eight the exponent ramps, so the curve changes smoothly
 * with the points and evenly spaced splines keep the exact uniform curve (and the curvature formulas that go with it).
 */
function knotExponent(ring: readonly SplinePoint[], closed: boolean): number {
  return 0.75 * Math.min(1, Math.max(0, (chordRatio(ring, closed) - 4) / 4));
}

/** The largest ratio between neighbouring chords of the fit points (1 for evenly spaced points). */
function chordRatio(ring: readonly SplinePoint[], closed: boolean): number {
  let ratio = 1;
  const count = ring.length;
  const chord = (index: number): number => {
    const a = ring[index % count]!;
    const b = ring[(index + 1) % count]!;
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  const chords = closed ? count : count - 1;
  for (let index = 0; index + 1 < chords; index += 1) {
    const left = chord(index);
    const right = chord(index + 1);
    if (left > 1e-12 && right > 1e-12) ratio = Math.max(ratio, left / right, right / left);
  }
  if (closed && chords > 1) {
    const left = chord(chords - 1);
    const right = chord(0);
    if (left > 1e-12 && right > 1e-12) ratio = Math.max(ratio, left / right, right / left);
  }
  return ratio;
}

/** From this ratio of neighbouring chords the tangents are kept from swinging the curve far outside its fit points. */
const OVERSHOOT_LIMIT_RATIO = 3;
/** The share of a cubic's end tangent (perpendicular to the chord) that shows as its largest sideways excursion: 4/27 from each end, and the two ends of a span add up, so 8/27. */
const EXCURSION_PER_TANGENT = 8 / 27;
/** A tangent is never shortened below this share, so the curve keeps leaving the point in the direction it is heading. */
const MIN_TANGENT_KEEP = 0.05;

/**
 * Keeps the curve near its fit points when they are unevenly spaced. A Catmull-Rom tangent at a point between a short and a very long
 * chord leans along the short one, and over the long chord that sends the curve far outside the points (a spline through points that
 * all lie in y 0..1 dipped to y -2.6). Here the tangent keeps its direction (so the curve still leaves the point the way the clicks
 * suggest and the short spans do not fold back) but is shortened until the sideways excursion over each adjacent span stays within a share of
 * how far that span's neighbours lie off its chord (or half a percent of its length). Evenly spaced points never reach this, so they
 * keep the exact uniform curve.
 */
function limitedTangent(at: (index: number) => SplinePoint, index: number, hasPrevious: boolean, hasNext: boolean, gap: (a: SplinePoint, b: SplinePoint) => number, tangent: SplinePoint): SplinePoint {
  const size = Math.hypot(tangent[0], tangent[1]);
  if (size < 1e-12) return tangent;
  const current = at(index);
  let keep = 1;
  const constrain = (to: SplinePoint, outerBefore: SplinePoint, outerAfter: SplinePoint, scale: number): void => {
    const dx = to[0] - current[0];
    const dy = to[1] - current[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-12) return;
    const off = (point: SplinePoint): number => Math.abs((point[0] - current[0]) * dy - (point[1] - current[1]) * dx) / length;
    const slack = Math.max(0.2 * Math.max(off(outerBefore), off(outerAfter)), 0.002 * length);
    // The part of the tangent across the chord is what swings the curve sideways.
    const across = Math.abs(tangent[0] * dy - tangent[1] * dx) / length;
    const reach = EXCURSION_PER_TANGENT * scale * across;
    if (reach > slack) keep = Math.min(keep, slack / reach);
  };
  if (hasPrevious) constrain(at(index - 1), at(index + 1), at(index - 2), gap(at(index - 1), current));
  if (hasNext) constrain(at(index + 1), at(index - 1), at(index + 2), gap(current, at(index + 1)));
  keep = Math.max(keep, MIN_TANGENT_KEEP);
  return keep >= 1 ? tangent : [tangent[0] * keep, tangent[1] * keep];
}

interface PreparedSpline {
  readonly closed: boolean;
  readonly ring: readonly SplinePoint[];
  readonly count: number;
  readonly exponent: number;
  /** The ratio of the longest to the shortest chord, found once per list: it decides whether the tangents are limited. */
  readonly chordRatio: number;
}

/**
 * What every span of one fit list shares: whether it is periodic, the ring of distinct points and the knot exponent (a scan of all the
 * chords). Computing it once per list, not once per sample, makes sampling a spline linear in its fit points instead of quadratic
 * (a 64-point spline was 140 times slower than the uniform curve it replaced). The cache is keyed on the array, which callers do not mutate.
 */
const PREPARED = new WeakMap<readonly SplinePoint[], PreparedSpline>();

function preparedSpline(fit: readonly SplinePoint[]): PreparedSpline {
  const cached = PREPARED.get(fit);
  if (cached !== undefined && cached.count === (cached.closed ? fit.length - 1 : fit.length)) return cached;
  const closed = isPeriodicSpline(fit);
  const ring = closed ? fit.slice(0, -1) : fit;
  const made: PreparedSpline = { closed, ring, count: ring.length, exponent: knotExponent(ring, closed), chordRatio: chordRatio(ring, closed) };
  PREPARED.set(fit, made);
  return made;
}

/**
 * One span as a cubic Hermite segment: its end points and the end tangents with respect to the span parameter s in [0, 1].
 * The tangents are the non-uniform Catmull-Rom ones; with even spacing they are (P2 - P0) / 2 and (P3 - P1) / 2. The ends of an
 * open spline repeat the end point as the missing neighbour, with the knot gap mirrored from the next span.
 */
export function splineSpanHermite(fit: readonly SplinePoint[], span: number): { readonly p1: SplinePoint; readonly p2: SplinePoint; readonly m1: SplinePoint; readonly m2: SplinePoint } {
  const { closed, ring, count, exponent, chordRatio: ratio } = preparedSpline(fit);
  const at = (index: number): SplinePoint => (closed ? ring[((index % count) + count) % count]! : ring[Math.min(count - 1, Math.max(0, index))]!);
  const q0 = at(span - 1);
  const q1 = at(span);
  const q2 = at(span + 1);
  const q3 = at(span + 2);
  const gap = (a: SplinePoint, b: SplinePoint): number => Math.max(Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), exponent), 1e-9);
  const d12 = gap(q1, q2);
  const d01 = !closed && span === 0 ? d12 : gap(q0, q1);
  const d23 = !closed && span === count - 2 ? d12 : gap(q2, q3);
  const tangent = (axis: 0 | 1, a: SplinePoint, b: SplinePoint, c: SplinePoint, dLeft: number, dRight: number): number =>
    ((b[axis] - a[axis]) / dLeft - (c[axis] - a[axis]) / (dLeft + dRight) + (c[axis] - b[axis]) / dRight);
  let t1: SplinePoint = [tangent(0, q0, q1, q2, d01, d12), tangent(1, q0, q1, q2, d01, d12)];
  // The far tangent uses the same pattern shifted by one: (q2 - q1) / d12 - (q3 - q1) / (d12 + d23) + (q3 - q2) / d23.
  let t2: SplinePoint = [tangent(0, q1, q2, q3, d12, d23), tangent(1, q1, q2, q3, d12, d23)];
  if (ratio > OVERSHOOT_LIMIT_RATIO) {
    const hasBefore = (index: number): boolean => closed || index > 0;
    const hasAfter = (index: number): boolean => closed || index < count - 1;
    t1 = limitedTangent(at, span, hasBefore(span), hasAfter(span), gap, t1);
    t2 = limitedTangent(at, span + 1, hasBefore(span + 1), hasAfter(span + 1), gap, t2);
  }
  const m1: SplinePoint = [d12 * t1[0], d12 * t1[1]];
  const m2: SplinePoint = [d12 * t2[0], d12 * t2[1]];
  return { p1: q1, p2: q2, m1, m2 };
}

/** Position and derivatives inside one span, at parameter t in [0, 1]. */
export function splineDerivativesAt(fit: readonly SplinePoint[], span: number, t: number): SplineDerivatives {
  const { p1, p2, m1, m2 } = splineSpanHermite(fit, span);
  const t2 = t * t;
  const t3 = t2 * t;
  const component = (axis: 0 | 1): { readonly value: number; readonly d1: number; readonly d2: number } => {
    const a = p1[axis];
    const b = p2[axis];
    const u = m1[axis];
    const v = m2[axis];
    return {
      value: (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * u + (-2 * t3 + 3 * t2) * b + (t3 - t2) * v,
      d1: (6 * t2 - 6 * t) * a + (3 * t2 - 4 * t + 1) * u + (-6 * t2 + 6 * t) * b + (3 * t2 - 2 * t) * v,
      d2: (12 * t - 6) * a + (6 * t - 4) * u + (-12 * t + 6) * b + (6 * t - 2) * v
    };
  };
  const x = component(0);
  const y = component(1);
  return { point: [x.value, y.value], d1: [x.d1, y.d1], d2: [x.d2, y.d2] };
}

/** Signed curvature (1/mm, positive when the curve turns left) from the first and second derivative; 0 where the speed vanishes. */
export function signedCurvature(d1: SplinePoint, d2: SplinePoint): number {
  const speed = Math.hypot(d1[0], d1[1]);
  return speed < 1e-12 ? 0 : (d1[0] * d2[1] - d1[1] * d2[0]) / (speed * speed * speed);
}

/** Signed curvature of the spline at a span parameter. */
export function splineCurvatureAt(fit: readonly SplinePoint[], span: number, t: number): number {
  const derivatives = splineDerivativesAt(fit, span, t);
  return signedCurvature(derivatives.d1, derivatives.d2);
}

/** What the curve does at one of its two ends, travelling in the direction of increasing fit-point index. */
export interface SplineEndFrame {
  readonly point: SplinePoint;
  /** Unit tangent in the direction of increasing fit-point index. */
  readonly tangent: SplinePoint;
  /** Signed curvature in the direction of increasing fit-point index. */
  readonly curvature: number;
}

export function splineEndFrame(fit: readonly SplinePoint[], end: "start" | "end"): SplineEndFrame | undefined {
  if (fit.length < 3) return undefined;
  const derivatives = end === "start" ? splineDerivativesAt(fit, 0, 0) : splineDerivativesAt(fit, fit.length - 2, 1);
  const speed = Math.hypot(derivatives.d1[0], derivatives.d1[1]);
  if (speed < 1e-12) return undefined;
  return { point: derivatives.point, tangent: [derivatives.d1[0] / speed, derivatives.d1[1] / speed], curvature: signedCurvature(derivatives.d1, derivatives.d2) };
}

/** Arc length of the whole spline, from fine sampling of the exact cubic spans. */
export function splineLengthMm(fit: readonly SplinePoint[], samplesPerSpan = 64): number {
  let length = 0;
  for (let span = 0; span < splineSpanCount(fit); span += 1) {
    let previous = splineDerivativesAt(fit, span, 0).point;
    for (let step = 1; step <= samplesPerSpan; step += 1) {
      const next = splineDerivativesAt(fit, span, step / samplesPerSpan).point;
      length += Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      previous = next;
    }
  }
  return length;
}

/**
 * Moves the end of a spline so that it starts at `joint`, leaves it along `tangent` and has signed curvature `curvature` there.
 *
 * The end is worked on as the start of the fit list (the list is reversed for the `end` end, which also flips the sign of the
 * curvature). With P0 the end point, P1 the next fit point and P2 the one after, the first span's derivatives at t = 0 are
 * d1 = (P1 - P0) / 2 and d2 = 4 (P1 - P0) + P0 - P2. Putting P0 on the joint and P1 on the tangent (keeping its distance),
 * the curvature then depends on P2 only through its component along the left normal N of the tangent:
 * curvature = -4 N . (P2 - P0) / s^2 with s = |P1 - P0|. So P2 is slid along N until the curvature is right; everything
 * beyond P2 stays where it was, apart from P2 following the joint when the joint has moved.
 *
 * `tangent` is the direction of travel *away from the joint into the spline* and `curvature` the signed curvature in that
 * same direction of travel (positive turns left).
 */
export function adaptSplineEnd(
  fit: readonly SplinePoint[],
  end: "start" | "end",
  joint: SplinePoint,
  tangent: SplinePoint,
  curvature: number
): { readonly ok: true; readonly fitPoints: readonly SplinePoint[] } | { readonly ok: false; readonly reason: string } {
  if (fit.length < 3) return { ok: false, reason: "A spline needs at least three fit points." };
  const length = Math.hypot(tangent[0], tangent[1]);
  if (length < 1e-9) return { ok: false, reason: "The tangent direction is degenerate." };
  if (!Number.isFinite(curvature)) return { ok: false, reason: "The curvature is not a finite number." };
  const unit: SplinePoint = [tangent[0] / length, tangent[1] / length];
  const list = end === "start" ? [...fit] : [...fit].reverse();
  const p0 = list[0]!;
  const p1 = list[1]!;
  const p2 = list[2]!;
  const shift: SplinePoint = [joint[0] - p0[0], joint[1] - p0[1]];
  const spacing = Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 10 * MIN_SPLINE_FIT_GAP_MM);
  const newP1: SplinePoint = [joint[0] + unit[0] * spacing, joint[1] + unit[1] * spacing];
  const normal: SplinePoint = [-unit[1], unit[0]];
  const movedP2: SplinePoint = [p2[0] + shift[0], p2[1] + shift[1]];
  const current = normal[0] * (movedP2[0] - joint[0]) + normal[1] * (movedP2[1] - joint[1]);
  const wanted = (-curvature * spacing * spacing) / 4;
  const newP2: SplinePoint = [movedP2[0] + normal[0] * (wanted - current), movedP2[1] + normal[1] * (wanted - current)];
  const edited = [joint, newP1, newP2, ...list.slice(3)];
  for (let index = 1; index < edited.length; index += 1) {
    const before = edited[index - 1]!;
    const after = edited[index]!;
    if (Math.hypot(after[0] - before[0], after[1] - before[1]) < MIN_SPLINE_FIT_GAP_MM) {
      return { ok: false, reason: "Matching the curvature would put two fit points on top of each other; move the spline's inner fit points apart first." };
    }
  }
  return { ok: true, fitPoints: end === "start" ? edited : edited.reverse() };
}

/** One stretch of a spline whose radius of curvature is below a limit. */
export interface TightSpan {
  /** Index of the span (between fit points `span` and `span + 1`). */
  readonly span: number;
  /** Where the radius first drops below the limit, and where it recovers, as span parameters. */
  readonly fromT: number;
  readonly toT: number;
  readonly fromPoint: SplinePoint;
  readonly toPoint: SplinePoint;
  /** The tightest point of this stretch. */
  readonly tightestPoint: SplinePoint;
  readonly minRadiusMm: number;
}

export interface SplineRadiusReport {
  /** Smallest radius of curvature over the whole spline (Infinity for a straight one). */
  readonly minRadiusMm: number;
  readonly minRadiusPoint: SplinePoint;
  /** The span and parameter where it occurs. */
  readonly minRadiusSpan: number;
  readonly minRadiusT: number;
  /** Stretches tighter than the limit; empty when no limit was given or the spline stays above it. */
  readonly tight: readonly TightSpan[];
}

/**
 * The smallest radius of curvature of a spline and where it falls, and (with a limit) every stretch that is tighter than the
 * limit. Curvature is evaluated exactly on a fine grid of every span, so a tight bend between two fit points is not missed.
 */
export function splineRadiusReport(fit: readonly SplinePoint[], limitMm?: number, samplesPerSpan = 96): SplineRadiusReport {
  let minRadius = Infinity;
  let minPoint: SplinePoint = fit[0] ?? [0, 0];
  let minSpan = 0;
  let minT = 0;
  const tight: TightSpan[] = [];
  for (let span = 0; span < splineSpanCount(fit); span += 1) {
    const state: { open?: { fromT: number; fromPoint: SplinePoint; tightestRadius: number; tightestPoint: SplinePoint } } = {};
    const close = (toT: number, toPoint: SplinePoint): void => {
      const open = state.open;
      if (open === undefined) return;
      tight.push({ span, fromT: open.fromT, toT, fromPoint: open.fromPoint, toPoint, tightestPoint: open.tightestPoint, minRadiusMm: open.tightestRadius });
      delete state.open;
    };
    for (let step = 0; step <= samplesPerSpan; step += 1) {
      const t = step / samplesPerSpan;
      const derivatives = splineDerivativesAt(fit, span, t);
      const curvature = Math.abs(signedCurvature(derivatives.d1, derivatives.d2));
      const radius = curvature < 1e-12 ? Infinity : 1 / curvature;
      if (radius < minRadius) {
        minRadius = radius;
        minPoint = derivatives.point;
        minSpan = span;
        minT = t;
      }
      if (limitMm !== undefined && radius < limitMm) {
        const open = state.open;
        if (open === undefined) state.open = { fromT: t, fromPoint: derivatives.point, tightestRadius: radius, tightestPoint: derivatives.point };
        else if (radius < open.tightestRadius) { open.tightestRadius = radius; open.tightestPoint = derivatives.point; }
      } else {
        close(t, derivatives.point);
      }
    }
    close(1, splineDerivativesAt(fit, span, 1).point);
  }
  return { minRadiusMm: minRadius, minRadiusPoint: minPoint, minRadiusSpan: minSpan, minRadiusT: minT, tight };
}
