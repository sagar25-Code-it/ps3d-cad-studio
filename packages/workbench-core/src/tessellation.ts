/**
 * The one chord-error rule every flattening of a curve follows: a circle that becomes the outline of an extrusion, an arc of a loop, a
 * spline, the path of a sweep. Nothing here imports another module, so the sketch, geometry and app layers can all share it.
 *
 * A straight edge may sit at most `chordErrorBoundMm(size)` away from the curve it stands for. The bound is relative for small
 * curves (1/2,000 of the radius, so a small circle is as round as a big one) and capped at 0.01 mm for large ones, with a floor so
 * a tiny curve does not need thousands of edges. For a circle the area of an inscribed polygon is short by 4/3 of (chord error /
 * radius), so the volume of a round part is within about 0.07 percent of the analytic value at every size.
 */

/** The largest distance between a sampled edge and the true curve, for large curves. */
export const CHORD_ERROR_CAP_MM = 0.01;
/** The smallest chord error asked of a tiny curve. */
export const CHORD_ERROR_FLOOR_MM = 2e-5;
/** Chord error as a fraction of the radius (or the size) of the curve, below the cap. */
export const CHORD_ERROR_RELATIVE = 5e-4;
/** The most edges one full turn of a circle is given. */
export const MAX_FULL_CIRCLE_FACETS = 4096;

/** The chord error allowed for a curve of this radius or overall size; a caller can pass a coarser `capMm`. */
export function chordErrorBoundMm(sizeMm: number, capMm: number = CHORD_ERROR_CAP_MM): number {
  const relative = Number.isFinite(sizeMm) && sizeMm > 0 ? sizeMm * CHORD_ERROR_RELATIVE : CHORD_ERROR_FLOOR_MM;
  return Math.min(capMm, Math.max(CHORD_ERROR_FLOOR_MM, relative));
}

/** The widest angle one straight edge may span on a circle of this radius without leaving the chord error bound. */
export function maxChordStepRadians(radiusMm: number, capMm: number = CHORD_ERROR_CAP_MM): number {
  const tolerance = chordErrorBoundMm(radiusMm, capMm);
  return radiusMm > tolerance ? 2 * Math.acos(1 - tolerance / radiusMm) : Math.PI / 2;
}

/** Edges for a full circle of this radius, rounded up to a multiple of four so the four quadrant points are always vertices. */
export function fullCircleFacets(radiusMm: number, capMm: number = CHORD_ERROR_CAP_MM, maximum: number = MAX_FULL_CIRCLE_FACETS): number {
  const step = maxChordStepRadians(radiusMm, capMm);
  const wanted = Math.ceil((2 * Math.PI) / step);
  return Math.min(maximum - (maximum % 4), Math.max(16, Math.ceil(wanted / 4) * 4));
}
