import type { SketchEntity, Vec2, WorkbenchResult } from "../../workbench-core/src/index.js";
import { badShape, sampleCurveToFitPoints, splineFromPoints, type ShapeIds, type SketchShape } from "./curve-math.js";
import { nearestOnEllipse } from "./ellipse-geometry.js";
import { tidyPoint } from "./clean-numbers.js";
import { buildSketchEntity, sampleSpline } from "./index.js";

/**
 * Elliptical arc (a partial ellipse). The sketch has no arc-of-ellipse entity, so the arc is stored as a fit-point spline
 * that follows the ellipse to a tolerance of a few microns (more fit points where the curve bends sharply). That keeps the
 * arc joinable: its two ends are exact points of the ellipse, a line or an arc that starts at one of them closes a loop,
 * and the closed loop becomes a profile that extrudes like any other.
 *
 * The clicks are the ellipse's centre, the end of its major axis, a point that sets the minor radius, then the start and the
 * end of the arc. The arc runs counter-clockwise from the start to the end.
 */
export const ELLIPSE_ARC_MIN_SWEEP_RAD = 1e-3;

/** The fit-point counts tried, smallest first, until the spline is within tolerance of the ellipse. */
const FIT_COUNTS = [8, 12, 16, 24, 32, 48, 64] as const;

/** How far the spline may stray from the true ellipse: 5 microns, or 1e-5 of the major radius for a very large ellipse. */
function toleranceMm(majorRadiusMm: number): number {
  return Math.max(0.005, 1e-5 * majorRadiusMm);
}

type Ellipse = Extract<SketchEntity, { kind: "ellipse" }>;

/** The parameter angle t of the ellipse point nearest to `point` (the point at t is centre + R(rot) * (a cos t, b sin t)). */
export function ellipseParameterOf(ellipse: Ellipse, point: Vec2): number {
  const radians = (ellipse.rotationDeg * Math.PI) / 180;
  const dx = point[0] - ellipse.center[0];
  const dy = point[1] - ellipse.center[1];
  const x = dx * Math.cos(radians) + dy * Math.sin(radians);
  const y = -dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.atan2(y / ellipse.minorRadiusMm, x / ellipse.majorRadiusMm);
}

function pointAt(ellipse: Ellipse, t: number): Vec2 {
  const radians = (ellipse.rotationDeg * Math.PI) / 180;
  const x = ellipse.majorRadiusMm * Math.cos(t);
  const y = ellipse.minorRadiusMm * Math.sin(t);
  return tidyPoint([ellipse.center[0] + x * Math.cos(radians) - y * Math.sin(radians), ellipse.center[1] + x * Math.sin(radians) + y * Math.cos(radians)]);
}

/** The largest distance from the spline through `fit` to the ellipse, measured at ten samples per span. */
function deviation(ellipse: Ellipse, fit: readonly Vec2[]): number {
  let worst = 0;
  for (const sample of sampleSpline(fit, 10)) worst = Math.max(worst, nearestOnEllipse(sample, ellipse).distance);
  return worst;
}

export function buildEllipticalArc(center: Vec2, majorPoint: Vec2, minorPoint: Vec2, startPoint: Vec2, endPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const base = buildSketchEntity("ellipse", [center, majorPoint, minorPoint], "entity:ellipse-arc-frame");
  if (!base.ok) return base;
  const ellipse = base.value as Ellipse;
  const startParameter = ellipseParameterOf(ellipse, startPoint);
  const endParameter = ellipseParameterOf(ellipse, endPoint);
  if (!Number.isFinite(startParameter) || !Number.isFinite(endParameter)) return badShape("The arc start or end is not a usable point.");
  const full = Math.PI * 2;
  let sweep = (((endParameter - startParameter) % full) + full) % full;
  if (sweep < ELLIPSE_ARC_MIN_SWEEP_RAD || sweep > full - ELLIPSE_ARC_MIN_SWEEP_RAD) {
    return badShape("The arc start and end are at the same place on the ellipse: choose two different points, or draw a full ellipse.", "Place the end point somewhere else on the ellipse.");
  }
  sweep = Math.min(sweep, full - ELLIPSE_ARC_MIN_SWEEP_RAD);
  const curve = (t: number): Vec2 => pointAt(ellipse, t);
  const tolerance = toleranceMm(ellipse.majorRadiusMm);
  let fit: readonly Vec2[] = [];
  for (const count of FIT_COUNTS) {
    // The longer the sweep, the more points it takes: start at a count in proportion to the angle.
    if (count < Math.min(64, 4 + Math.ceil((sweep / full) * 16))) continue;
    fit = sampleCurveToFitPoints(curve, startParameter, startParameter + sweep, count, 720, 0, 1);
    if (deviation(ellipse, fit) <= tolerance) break;
  }
  const spline = splineFromPoints(fit, ids.entity());
  if (!spline.ok) return badShape(`The arc is too small to draw: its fit points would be closer than 0.01 mm. ${spline.diagnostics[0]?.message ?? ""}`);
  return { ok: true, value: { entities: [spline.value], constraints: [] } };
}

/** Where the arc built from these clicks starts and ends, exactly, so lines and arcs can be drawn to meet them. */
export function ellipticalArcEnds(center: Vec2, majorPoint: Vec2, minorPoint: Vec2, startPoint: Vec2, endPoint: Vec2): { readonly start: Vec2; readonly end: Vec2 } | undefined {
  const base = buildSketchEntity("ellipse", [center, majorPoint, minorPoint], "entity:ellipse-arc-frame");
  if (!base.ok) return undefined;
  const ellipse = base.value as Ellipse;
  return { start: pointAt(ellipse, ellipseParameterOf(ellipse, startPoint)), end: pointAt(ellipse, ellipseParameterOf(ellipse, endPoint)) };
}
