import type { Vec2 } from "../../workbench-core/src/index.js";
import type { EllipseShape } from "./ellipse-geometry.js";

/**
 * Exact crossings of an ellipse with a circle or another ellipse. The cursor inference first finds a crossing on a polygonal outline (a
 * millimetre-scale guess), and this module then moves it onto both true curves with Newton's method on their implicit equations, so the
 * snapped point can be held by two point-on-curve relations without the solver having to move anything.
 */

/** The implicit function of a curve: zero on it, and in length units (so a residual is a distance, roughly). */
export type ImplicitCurve = (point: Vec2) => number;

export function circleImplicit(center: Vec2, radius: number): ImplicitCurve {
  return (point) => Math.hypot(point[0] - center[0], point[1] - center[1]) - radius;
}

/** The same form the solver uses for a point on an ellipse, so a refined point satisfies the relation to rounding. */
export function ellipseImplicit(ellipse: EllipseShape): ImplicitCurve {
  const radians = (ellipse.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scale = Math.min(ellipse.majorRadiusMm, ellipse.minorRadiusMm);
  return (point) => {
    const dx = point[0] - ellipse.center[0];
    const dy = point[1] - ellipse.center[1];
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    return (Math.hypot(along / ellipse.majorRadiusMm, across / ellipse.minorRadiusMm) - 1) * scale;
  };
}

/**
 * Newton's method for the point where both curves are zero, started at `guess`. Returns the guess unchanged when the iteration does not
 * converge to a point close to it (a tangent contact, say), so a refined crossing is never worse than the polygonal one.
 */
export function refineCrossing(guess: Vec2, first: ImplicitCurve, second: ImplicitCurve, maxShiftMm = 0.5): Vec2 {
  let x = guess[0];
  let y = guess[1];
  const h = 1e-6;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const f1 = first([x, y]);
    const f2 = second([x, y]);
    if (Math.abs(f1) < 1e-13 && Math.abs(f2) < 1e-13) break;
    const a = (first([x + h, y]) - first([x - h, y])) / (2 * h);
    const b = (first([x, y + h]) - first([x, y - h])) / (2 * h);
    const c = (second([x + h, y]) - second([x - h, y])) / (2 * h);
    const d = (second([x, y + h]) - second([x, y - h])) / (2 * h);
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-12) return guess;
    x -= (d * f1 - b * f2) / determinant;
    y -= (-c * f1 + a * f2) / determinant;
  }
  const ok = Math.abs(first([x, y])) < 1e-9 && Math.abs(second([x, y])) < 1e-9 && Math.hypot(x - guess[0], y - guess[1]) <= maxShiftMm;
  return ok ? [x, y] : guess;
}
