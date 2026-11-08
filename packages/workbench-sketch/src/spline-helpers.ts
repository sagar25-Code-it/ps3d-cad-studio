import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { arcShape } from "../../workbench-core/src/sketch-measure.js";
import {
  MIN_SPLINE_FIT_GAP_MM,
  adaptSplineEnd,
  splineDerivativesAt,
  splineEndFrame,
  splineRadiusReport,
  type SplinePoint,
  type TightSpan
} from "../../workbench-core/src/spline-curvature.js";

/**
 * Spline helpers: tangent handles, curvature control and a minimum-radius check for the sketch's fit-point splines, plus the
 * little geometry the Smooth (G2) button needs to find which ends meet. The spline is a Catmull-Rom curve through its fit
 * points (see `spline-curvature.ts`); everything here edits the fit points, so the edited curve still passes through them.
 */

export type SplineEntity = Extract<SketchEntity, { kind: "spline" }>;

export type SplineEditResult =
  | { readonly ok: true; readonly fitPoints: readonly Vec2[] }
  | { readonly ok: false; readonly message: string };

export interface SplineTangentHandle {
  /** Which fit point the handle belongs to. */
  readonly index: number;
  /** The fit point the curve passes through. */
  readonly point: Vec2;
  /** The curve's velocity at the fit point per unit of span parameter, as a vector (its length is the handle's reach). */
  readonly tangent: Vec2;
  /** Where to draw the draggable handle tip: the point plus the tangent scaled by `scale`. */
  readonly tip: Vec2;
  /** Signed curvature in the direction of increasing fit-point index, from the span that starts here (the last point uses the span that ends here). */
  readonly curvature: number;
}

/** A tangent handle on every fit point. `scale` sets how far the drawn tip stands from the point per unit of tangent. */
export function splineTangentHandles(entity: SplineEntity, scale = 1): readonly SplineTangentHandle[] {
  const fit = entity.fitPoints as readonly SplinePoint[];
  if (fit.length < 3) return [];
  return fit.map((point, index) => {
    const last = index === fit.length - 1;
    const derivatives = last ? splineDerivativesAt(fit, fit.length - 2, 1) : splineDerivativesAt(fit, index, 0);
    const speed = Math.hypot(derivatives.d1[0], derivatives.d1[1]);
    const curvature = speed < 1e-12 ? 0 : (derivatives.d1[0] * derivatives.d2[1] - derivatives.d1[1] * derivatives.d2[0]) / (speed * speed * speed);
    return {
      index,
      point: point as Vec2,
      tangent: derivatives.d1 as Vec2,
      tip: [point[0] + derivatives.d1[0] * scale, point[1] + derivatives.d1[1] * scale] as Vec2,
      curvature
    };
  });
}

function gapsOk(fit: readonly Vec2[]): boolean {
  for (let index = 1; index < fit.length; index += 1) {
    if (Math.hypot(fit[index]![0] - fit[index - 1]![0], fit[index]![1] - fit[index - 1]![1]) < MIN_SPLINE_FIT_GAP_MM) return false;
  }
  return true;
}

/**
 * Drags a tangent handle: makes the curve leave fit point `index` with velocity `tangent`. At an end point the next fit point
 * moves (velocity there is half the step to it). At an interior point the two neighbours move by equal and opposite amounts
 * (velocity there is half the span between them), so the curve still passes through every fit point.
 */
export function setSplineTangent(entity: SplineEntity, index: number, tangent: Vec2): SplineEditResult {
  const fit = entity.fitPoints;
  if (!Number.isInteger(index) || index < 0 || index >= fit.length) return { ok: false, message: "That fit point does not exist." };
  if (!Number.isFinite(tangent[0]) || !Number.isFinite(tangent[1]) || Math.hypot(tangent[0], tangent[1]) < 1e-9) return { ok: false, message: "A tangent handle needs a non-zero direction and reach." };
  const edited = fit.map((point) => [point[0], point[1]] as Vec2);
  if (index === 0) {
    edited[1] = [fit[0]![0] + 2 * tangent[0], fit[0]![1] + 2 * tangent[1]];
  } else if (index === fit.length - 1) {
    edited[index - 1] = [fit[index]![0] - 2 * tangent[0], fit[index]![1] - 2 * tangent[1]];
  } else {
    const current: Vec2 = [(fit[index + 1]![0] - fit[index - 1]![0]) / 2, (fit[index + 1]![1] - fit[index - 1]![1]) / 2];
    const delta: Vec2 = [tangent[0] - current[0], tangent[1] - current[1]];
    edited[index + 1] = [fit[index + 1]![0] + delta[0], fit[index + 1]![1] + delta[1]];
    edited[index - 1] = [fit[index - 1]![0] - delta[0], fit[index - 1]![1] - delta[1]];
  }
  return gapsOk(edited) ? { ok: true, fitPoints: edited } : { ok: false, message: "That tangent would put two fit points on top of each other." };
}

/**
 * Curvature control at an end: sets the signed curvature of the spline's first or last span end (positive turns left when
 * travelling in the direction of increasing fit-point index) and keeps the end point and its tangent direction.
 */
export function setSplineEndCurvature(entity: SplineEntity, end: "start" | "end", curvature: number): SplineEditResult {
  const frame = splineEndFrame(entity.fitPoints as readonly SplinePoint[], end);
  if (frame === undefined) return { ok: false, message: "The spline is too short or degenerate at that end." };
  // The adaptation works travelling away from the end: at the last point that is against the fit-point order.
  const away: Vec2 = end === "start" ? frame.tangent : [-frame.tangent[0], -frame.tangent[1]];
  const result = adaptSplineEnd(entity.fitPoints as readonly SplinePoint[], end, frame.point, away, end === "start" ? curvature : -curvature);
  return result.ok ? { ok: true, fitPoints: result.fitPoints as readonly Vec2[] } : { ok: false, message: result.reason };
}

/** Where the Smooth (G2) button should join two curves: the end of each that lie closest, and how far apart they are now. */
export interface SmoothJoint {
  readonly points: readonly [SketchPointRef, SketchPointRef];
  readonly gapMm: number;
}

function endsOf(entity: SketchEntity): readonly { readonly ref: "start" | "end"; readonly point: Vec2 }[] {
  if (entity.kind === "line" || entity.kind === "arc") return [{ ref: "start", point: entity.start }, { ref: "end", point: entity.end }];
  if (entity.kind === "spline") return [{ ref: "start", point: entity.fitPoints[0]! }, { ref: "end", point: entity.fitPoints[entity.fitPoints.length - 1]! }];
  return [];
}

/** The pair of ends (one per curve) closest to each other; undefined when either curve has no ends. */
export function nearestSmoothJoint(first: SketchEntity, second: SketchEntity): SmoothJoint | undefined {
  let best: SmoothJoint | undefined;
  for (const a of endsOf(first)) {
    for (const b of endsOf(second)) {
      const gapMm = Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]);
      if (best === undefined || gapMm < best.gapMm) best = { points: [a.ref, b.ref], gapMm };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Minimum radius of curvature
// ---------------------------------------------------------------------------------------------

export interface TightStretch {
  /** The start and end of the stretch whose radius is below the limit, and its tightest point. */
  readonly from: Vec2;
  readonly to: Vec2;
  readonly tightestAt: Vec2;
  readonly minRadiusMm: number;
}

export interface EntityRadiusReport {
  readonly entityId: string;
  readonly kind: SketchEntity["kind"];
  /** Smallest radius of curvature on the curve (Infinity for a straight one). */
  readonly minRadiusMm: number;
  /** Where that smallest radius occurs. */
  readonly at: Vec2;
  /** True when a limit was given and the curve goes below it somewhere. */
  readonly belowLimit: boolean;
  /** For a spline, the stretches that are tighter than the limit; a circle, arc or ellipse is either wholly or partly below it with a single entry. */
  readonly tight: readonly TightStretch[];
}

function fromSplineStretch(fit: readonly SplinePoint[], stretch: TightSpan): TightStretch {
  void fit;
  return { from: stretch.fromPoint as Vec2, to: stretch.toPoint as Vec2, tightestAt: stretch.tightestPoint as Vec2, minRadiusMm: stretch.minRadiusMm };
}

/** Radius report of one curve, or undefined for entities that have no curvature (lines, points, rectangles). */
export function entityRadiusReport(entity: SketchEntity, limitMm?: number): EntityRadiusReport | undefined {
  const belowOf = (radius: number): boolean => limitMm !== undefined && radius < limitMm;
  if (entity.kind === "circle") {
    const at: Vec2 = [entity.center[0] + entity.radiusMm, entity.center[1]];
    const below = belowOf(entity.radiusMm);
    return { entityId: entity.id, kind: entity.kind, minRadiusMm: entity.radiusMm, at, belowLimit: below, tight: below ? [{ from: at, to: at, tightestAt: at, minRadiusMm: entity.radiusMm }] : [] };
  }
  if (entity.kind === "arc") {
    const shape = arcShape(entity.start, entity.mid, entity.end);
    if (shape === undefined) return undefined;
    const below = belowOf(shape.radiusMm);
    return { entityId: entity.id, kind: entity.kind, minRadiusMm: shape.radiusMm, at: entity.mid, belowLimit: below, tight: below ? [{ from: entity.start, to: entity.end, tightestAt: entity.mid, minRadiusMm: shape.radiusMm }] : [] };
  }
  if (entity.kind === "ellipse") {
    // The tightest bend of an ellipse is at the ends of its major axis, where the radius of curvature is b squared over a.
    const major = Math.max(entity.majorRadiusMm, entity.minorRadiusMm);
    const minor = Math.min(entity.majorRadiusMm, entity.minorRadiusMm);
    const radius = (minor * minor) / major;
    const rotation = (entity.rotationDeg * Math.PI) / 180;
    const alongMajor = entity.majorRadiusMm >= entity.minorRadiusMm;
    const direction: Vec2 = alongMajor ? [Math.cos(rotation), Math.sin(rotation)] : [-Math.sin(rotation), Math.cos(rotation)];
    const at: Vec2 = [entity.center[0] + direction[0] * major, entity.center[1] + direction[1] * major];
    const below = belowOf(radius);
    return { entityId: entity.id, kind: entity.kind, minRadiusMm: radius, at, belowLimit: below, tight: below ? [{ from: at, to: at, tightestAt: at, minRadiusMm: radius }] : [] };
  }
  if (entity.kind === "spline") {
    const fit = entity.fitPoints as readonly SplinePoint[];
    if (fit.length < 3) return undefined;
    const report = splineRadiusReport(fit, limitMm);
    return {
      entityId: entity.id,
      kind: entity.kind,
      minRadiusMm: report.minRadiusMm,
      at: report.minRadiusPoint as Vec2,
      belowLimit: report.tight.length > 0,
      tight: report.tight.map((stretch) => fromSplineStretch(fit, stretch))
    };
  }
  return undefined;
}

export interface MinimumRadiusCheck {
  readonly limitMm: number;
  /** Every curved entity, tightest first. */
  readonly entities: readonly EntityRadiusReport[];
  /** The ones that go below the limit. */
  readonly violations: readonly EntityRadiusReport[];
  readonly ok: boolean;
}

/** The minimum-radius check over a sketch: where on which curves the radius of curvature falls below `limitMm` (construction curves are skipped). */
export function minimumRadiusCheck(sketch: Pick<WorkbenchSketch, "entities">, limitMm: number): MinimumRadiusCheck {
  const entities = sketch.entities
    .filter((entity) => entity.construction !== true && entity.visible !== false)
    .flatMap((entity) => {
      const report = entityRadiusReport(entity, limitMm);
      return report === undefined ? [] : [report];
    })
    .sort((left, right) => left.minRadiusMm - right.minRadiusMm);
  const violations = entities.filter((report) => report.belowLimit);
  return { limitMm, entities, violations, ok: violations.length === 0 };
}
