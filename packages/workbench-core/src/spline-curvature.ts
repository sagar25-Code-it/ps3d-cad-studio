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

/** The four control points of one span, with the end points standing in for the missing outer neighbours. */
function spanPoints(fit: readonly SplinePoint[], span: number): readonly [SplinePoint, SplinePoint, SplinePoint, SplinePoint] {
  const last = fit.length - 1;
  return [fit[Math.max(0, span - 1)]!, fit[span]!, fit[span + 1]!, fit[Math.min(last, span + 2)]!];
}

/** Number of spans of a fit-point spline (one fewer than the fit points). */
export function splineSpanCount(fit: readonly SplinePoint[]): number {
  return Math.max(0, fit.length - 1);
}

/** Position and derivatives inside one span, at parameter t in [0, 1]. */
export function splineDerivativesAt(fit: readonly SplinePoint[], span: number, t: number): SplineDerivatives {
  const [p0, p1, p2, p3] = spanPoints(fit, span);
  const t2 = t * t;
  const component = (axis: 0 | 1): { readonly value: number; readonly d1: number; readonly d2: number } => {
    const a = p0[axis];
    const b = p1[axis];
    const c = p2[axis];
    const d = p3[axis];
    const k1 = -a + c;
    const k2 = 2 * a - 5 * b + 4 * c - d;
    const k3 = -a + 3 * b - 3 * c + d;
    return {
      value: 0.5 * (2 * b + k1 * t + k2 * t2 + k3 * t2 * t),
      d1: 0.5 * (k1 + 2 * k2 * t + 3 * k3 * t2),
      d2: k2 + 3 * k3 * t
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
