import type { Vec2 } from "../../workbench-core/src/index.js";
import { dist, lerp, sampleCurveToFitPoints } from "./curve-math.js";
import { sampleSpline } from "./curve-sampling.js";

/**
 * How closely a fit-point spline follows the curve it stands for. Conics, hyperbola branches and control-point splines are stored as fit-point
 * splines, and a fixed number of points followed a long or sharply bent curve only to a tenth of a millimetre or worse. The fit is now measured
 * against the true curve (nearest distance to a fine polyline of it, not to its sample points) and points are added, up to the 64 a spline may
 * hold, until it is within the tolerance.
 */

/** The tolerance the curve tools aim for and state: every conic and control-point spline is within this of the true curve unless the 64-point limit stops it. */
export const FIT_TOLERANCE_MM = 0.01;

/** The tolerance in words for the tool prompts: 0.01 mm of the true curve, 0.03 mm for the longest spans (several hundred mm) where the 64-point limit decides. */
export const FIT_TOLERANCE_NOTE = "0.01 mm of the true curve (up to 0.03 mm on spans of several hundred mm)";

/** Fit-point counts tried in turn (a spline holds at most 64). */
const COUNT_LADDER = [24, 32, 40, 48, 56, 64] as const;
const REFERENCE_SAMPLES = 1600;
const CHECK_SAMPLES_PER_SPAN = 8;

/** The largest distance from any of `samples` to the polyline `reference`. */
export function maxDistanceToPolyline(samples: readonly Vec2[], reference: readonly Vec2[]): number {
  let worst = 0;
  for (const sample of samples) {
    let best = Infinity;
    for (let index = 1; index < reference.length; index += 1) {
      const a = reference[index - 1]!;
      const b = reference[index]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((sample[0] - a[0]) * dx + (sample[1] - a[1]) * dy) / lengthSquared));
      const gap = Math.hypot(sample[0] - a[0] - dx * t, sample[1] - a[1] - dy * t);
      if (gap < best) best = gap;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/** How far the spline through `fit` strays from the reference polyline. */
export function splineDeviationMm(fit: readonly Vec2[], reference: readonly Vec2[]): number {
  return maxDistanceToPolyline(sampleSpline(fit, CHECK_SAMPLES_PER_SPAN), reference);
}

export interface FitOptions {
  /** Fit points to start with (the ladder begins at the first rung that is not smaller). */
  readonly minCount?: number;
  /** Points near the ends sit this fraction of a regular gap from them (see sampleCurveToFitPoints). */
  readonly endLead?: number;
  /** How strongly the points crowd where the curve bends. */
  readonly curvatureBias?: number;
  readonly toleranceMm?: number;
}

/**
 * Fit points for a parametric curve, with the fewest points of the ladder that bring the spline within the tolerance (or, when none
 * does, the one that comes closest).
 */
export function fitCurveWithinTolerance(curve: (t: number) => Vec2, t0: number, t1: number, options: FitOptions = {}): readonly Vec2[] {
  const tolerance = options.toleranceMm ?? FIT_TOLERANCE_MM;
  const reference: Vec2[] = [];
  for (let index = 0; index <= REFERENCE_SAMPLES; index += 1) reference.push(curve(t0 + ((t1 - t0) * index) / REFERENCE_SAMPLES));
  let best: { readonly fit: readonly Vec2[]; readonly deviation: number } | undefined;
  for (const count of COUNT_LADDER) {
    if (count < (options.minCount ?? 0)) continue;
    const fit = sampleCurveToFitPoints(curve, t0, t1, count, 960, options.endLead ?? 0, options.curvatureBias ?? 0);
    // Points closer than the spline limit allows cannot be used: a denser ladder rung would only repeat them.
    if (fit.some((point, index) => index > 0 && dist(fit[index - 1]!, point) < 0.01)) break;
    const deviation = splineDeviationMm(fit, reference);
    if (best === undefined || deviation < best.deviation) best = { fit, deviation };
    if (deviation <= tolerance) break;
  }
  return best === undefined ? sampleCurveToFitPoints(curve, t0, t1, options.minCount ?? COUNT_LADDER[0], 960, options.endLead ?? 0, options.curvatureBias ?? 0) : best.fit;
}

/** A parametric curve (t in [0, 1]) that walks a dense polyline by index, for fitting a curve known only as samples. */
export function curveOfPolyline(dense: readonly Vec2[]): (t: number) => Vec2 {
  const last = dense.length - 1;
  return (t) => {
    const position = Math.max(0, Math.min(1, t)) * last;
    const index = Math.min(last - 1, Math.floor(position));
    return lerp(dense[index]!, dense[index + 1]!, position - index);
  };
}
