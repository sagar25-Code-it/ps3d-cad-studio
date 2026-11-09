import {
  analyzeLiveSketch,
  SPLINE_MAX_FIT_POINTS,
  SPLINE_MIN_FIT_POINTS,
  circleThroughThreePoints,
  constraintFit,
  describeConstraint,
  entityKindOf,
  entityNames,
  failure,
  type LiveRelationSet,
  threePointArcProblem,
  type SketchEntity,
  type Vec2,
  type WorkbenchResult,
  type WorkbenchSketch
} from "../../workbench-core/src/index.js";
import { directedSweep, type SweepDirection } from "./arc-sweep.js";
import { sketchEntityLimitProblem, sketchPointsProblem } from "./entity-limits.js";
import { CURVE_TOOL_LABELS, curveToolRequiredPoints, isFixedCurveTool, type CurveToolId, type FixedCurveToolId } from "./curve-tools.js";
import { pointInRing } from "./arrangement.js";
import { profileOutlineMm } from "./profile-outline.js";
import { matchProfileRef, resolveProfileRegion, type ProfileRegion } from "./profile-select.js";
import { detectProfilesOf, shapesOf } from "./profile-detect.js";
import type { ProfileDetectionOptions } from "./profile-regions.js";

import { sampleArc, sampleSpline } from "./curve-sampling.js";
export { sampleArc, sampleArcToBound, sampleSpline, sampleSplineToBound, CHORD_TOLERANCE_MM, isClosedFitSpline } from "./curve-sampling.js";
export { PROFILE_GAP_TOLERANCE_MM } from "./arrangement.js";
export { profileBaseOf, profileRefOf, parseProfileRef, signedProfileId, type ProfileDetectionOptions } from "./profile-regions.js";
export { profileOutlineMm, resolveProfileRegion, type ProfileRegion };
export { lostProfileRefs, matchProfileRef, profileInBox, type ProfileRegionGroup } from "./profile-select.js";
export { diagnoseProfiles, explainNoProfiles, type ProfileDiagnosis, type ProfileProblem } from "./profile-diagnostics.js";
export { breakAtIntersections } from "./break-intersections.js";
export { arrangeSketch } from "./profile-detect.js";
export { shapesOf as closedShapesOf } from "./profile-detect.js";

/**
 * The short names remain the default Fusion-familiar variants so existing
 * command records and saved UI state keep working:
 * - rectangle = 2-point rectangle
 * - circle = center/radius circle
 * - arc = 3-point arc
 */
export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "rectangle-center"
  | "rectangle-three-point"
  | "circle"
  | "circle-two-point"
  | "circle-three-point"
  | "ellipse"
  | "arc"
  /** Centerpoint arc: pick the centre, then the start, then the end (the end snaps to the circle of radius |start−centre|). */
  | "arc-center"
  /** Tangent arc: pick the anchor (usually an existing curve endpoint), a tangent-direction point, then the arc end. */
  | "arc-tangent"
  | "point"
  | "spline"
  /** A regular polygon: centre, then one corner. Placed as several entities, see shapes.ts. */
  | "polygon"
  /** A center-to-center slot: two end centres, then a width point. Placed as several entities, see shapes.ts. */
  | "slot"
  /** A straight (overall) slot: two outer endpoints (cap edges), then a width point. Placed as several entities, see shapes.ts. */
  | "slot-straight"
  /** The extra curve tools (midpoint line, centerline, parallelogram, rounded rectangle, arc slots, conics, blend, profile, text ...): see curve-tools.ts. */
  | CurveToolId;

/** Tools whose result is a whole parametric shape (several entities and relations) rather than one entity. */
export function isShapeTool(tool: SketchTool): tool is "polygon" | "slot" | "slot-straight" | FixedCurveToolId {
  return tool === "polygon" || tool === "slot" || tool === "slot-straight" || isFixedCurveTool(tool);
}

export type SketchProfileBoundary =
  | {
      readonly kind: "rectangle";
      readonly center: Vec2;
      readonly widthMm: number;
      readonly heightMm: number;
      readonly rotationDeg: number;
    }
  | {
      readonly kind: "circle";
      readonly center: Vec2;
      readonly radiusMm: number;
    }
  | {
      readonly kind: "ellipse";
      readonly center: Vec2;
      readonly majorRadiusMm: number;
      readonly minorRadiusMm: number;
      readonly rotationDeg: number;
    }
  | {
      readonly kind: "line-loop";
      readonly points: readonly Vec2[];
    }
  | {
      /** A closed loop that includes at least one arc. Arcs are sampled into `points`; `segments` maps edges back to entities. */
      readonly kind: "curve-loop";
      readonly points: readonly Vec2[];
      readonly segments: readonly SketchProfileSegment[];
    };

/** One sketch entity's contribution to a curve loop: a single line edge, or an arc sampled into several edges. */
export interface SketchProfileSegment {
  readonly entityId: string;
  readonly kind: "line" | "arc" | "spline";
  readonly edgeCount: number;
  /** Names the stretch of the entity this segment is: the entity id, or `id#k/n` when the entity is split into n pieces. */
  readonly key?: string;
}

/**
 * One enclosed region of a sketch. `boundary` is its outer boundary and `holes` the boundaries of the islands inside it, so
 * `areaMm2` is the net area. Every outline (outer and holes) winds counter-clockwise.
 */
export interface SketchProfile {
  readonly id: string;
  readonly entityIds: readonly string[];
  readonly boundary: SketchProfileBoundary;
  readonly areaMm2: number;
  readonly centroid: Vec2;
  /** The id marked exact: it names just this region (what a click on a region in the sketch stores in a feature), with the holes it has. */
  readonly ref?: string;
  /** Islands inside the region, largest first. Each is a loop of its own, with its own id (the id of the region it bounds). */
  readonly holes?: readonly SketchProfile[];
  /** A point strictly inside the region (not inside a hole). */
  readonly interiorPoint?: Vec2;
}

export interface QualifiedExtrusionCandidate {
  readonly outerProfileId: string;
  readonly boreProfileId: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly holeDiameterMm: number;
  readonly distanceMm: number;
}

export interface SketchAnalysis {
  readonly classification: "fully-constrained" | "underconstrained" | "conflict";
  /** Free variables minus the rank of the relations' Jacobian: what the sketch can still do, not a count of relations. */
  readonly degreesOfFreedom: number;
  /** Per entity: how many independent ways it can still move or change shape (the others being free to follow). */
  readonly entityFreedom: Readonly<Record<string, number>>;
  readonly appliedConstraints: number;
  /** Human-readable problems: contradicting relations (named), relations that cannot apply to their curves. */
  readonly conflicts: readonly string[];
  /** Relations that overlap: each set names the constraints, one of which adds nothing. The sketch is still solvable. */
  readonly redundant: readonly LiveRelationSet[];
  /** Relations that contradict each other at the stored geometry, with names. */
  readonly conflictSets: readonly LiveRelationSet[];
  /** Rank of the relations' Jacobian. */
  readonly rank: number;
  readonly boundsMm: { readonly min: Vec2; readonly max: Vec2; readonly size: Vec2 };
}

export interface SnapResult {
  readonly point: Vec2;
  readonly snapped: boolean;
  readonly kind: "grid" | "endpoint" | "none";
  readonly targetId?: string;
}

/** The relation kinds whose misuse (a horizontal circle, a radius on a line) is reported as a conflict in the analysis. */
const FIT_CHECKED_KINDS = new Set(["horizontal", "vertical", "parallel", "perpendicular", "collinear", "concentric", "angle", "arc-length", "perimeter", "smooth", "pierce", "refraction"]);

/**
 * Degrees of freedom and conflicts of the working sketch. The degrees of freedom come from the rank of the relations' Jacobian (see
 * analyzeLiveSketch): a duplicate relation removes nothing, a relation the solver does not enforce removes nothing, and a sketch is
 * "fully constrained" only when nothing is left to move. Relations that overlap are listed in `redundant` and relations that contradict in
 * `conflictSets`, both by the names of the constraints.
 */
export function analyzeWorkbenchSketch(sketch: WorkbenchSketch): SketchAnalysis {
  const rank = analyzeLiveSketch(sketch);
  const names = entityNames(sketch);
  const conflicts: string[] = [];
  const orientations = new Map<string, Set<string>>();
  const scalarValues = new Map<string, number>();

  for (const constraint of sketch.constraints) {
    // A relaxed relation stays recorded but takes no freedom away.
    if (constraint.suppressed === true) continue;
    const kinds = constraint.entityIds.map((id) => entityKindOf(sketch, id));
    if (FIT_CHECKED_KINDS.has(constraint.kind)) {
      const fit = constraintFit(constraint.kind, kinds, constraint.points, { driven: constraint.driven === true, ...(constraint.dimension === undefined ? {} : { dimension: constraint.dimension }) });
      if (!fit.ok) conflicts.push(`${describeConstraint(constraint, names)} cannot apply: ${fit.reason}`);
    }
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const id = constraint.entityIds[0]!;
      const set = orientations.get(id) ?? new Set<string>();
      set.add(constraint.kind);
      orientations.set(id, set);
    }
    // A driven (reference) dimension is measured from the geometry; it can conflict with nothing.
    if (constraint.driven === true) continue;
    if (constraint.kind === "angle" || constraint.kind === "arc-length" || constraint.kind === "perimeter" || constraint.kind === "radius" || constraint.kind === "distance") {
      const value = constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
      if (value === undefined) conflicts.push(`${describeConstraint(constraint, names)} requires a numeric value.`);
      else {
        const key = `${constraint.kind}:${constraint.dimension ?? "generic"}:${constraint.entityIds.join("|")}:${(constraint.points ?? []).join("|")}`;
        const prior = scalarValues.get(key);
        if (prior !== undefined && Math.abs(prior - value) > 1e-9) conflicts.push(`${describeConstraint(constraint, names)} conflicts with another ${constraint.kind} value on the same curves.`);
        scalarValues.set(key, value);
      }
    }
  }
  for (const [id, kinds] of orientations) {
    if (kinds.has("horizontal") && kinds.has("vertical")) conflicts.push(`${names.get(id) ?? id} cannot be both horizontal and vertical unless degenerate.`);
  }
  for (const set of rank.conflicting) conflicts.push(set.message);
  return {
    classification: conflicts.length > 0 ? "conflict" : rank.degreesOfFreedom === 0 && sketch.entities.length > 0 ? "fully-constrained" : "underconstrained",
    degreesOfFreedom: rank.degreesOfFreedom,
    entityFreedom: rank.entityFreedom,
    appliedConstraints: rank.enforced,
    conflicts,
    redundant: rank.redundant,
    conflictSets: rank.conflicting,
    rank: rank.rank,
    boundsMm: sketchBounds(sketch.entities)
  };
}

export interface SnapOptions {
  /** Snap reach in millimetres; the canvas passes a fixed number of screen pixels so it feels the same at every zoom. */
  readonly toleranceMm?: number;
  /** Grid spacing in millimetres to snap to; the canvas passes the grid step currently drawn. */
  readonly gridMm?: number;
}

export function snapSketchPoint(point: Vec2, sketch: WorkbenchSketch, options: SnapOptions = {}): SnapResult {
  const toleranceMm = options.toleranceMm ?? sketch.snapToleranceMm;
  const gridMm = options.gridMm ?? sketch.gridMm;
  let closest: { id: string; point: Vec2; distance: number } | undefined;
  for (const entity of sketch.entities) {
    if (entity.visible === false) continue;
    for (const candidate of entityPoints(entity)) {
      const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1]);
      if (distance <= toleranceMm && (closest === undefined || distance < closest.distance)) closest = { id: entity.id, point: candidate, distance };
    }
  }
  if (closest !== undefined) return { point: closest.point, snapped: true, kind: "endpoint", targetId: closest.id };
  const gridPoint: Vec2 = [roundTo(point[0], gridMm), roundTo(point[1], gridMm)];
  const gridDistance = Math.hypot(gridPoint[0] - point[0], gridPoint[1] - point[1]);
  return gridDistance <= toleranceMm
    ? { point: gridPoint, snapped: true, kind: "grid" }
    : { point, snapped: false, kind: "none" };
}

/** Extra input a tool can take besides its clicks. */
export interface SketchBuildOptions {
  /**
   * Centerpoint arc only: which way round the centre the arc runs, from the way the pointer travelled after the start
   * click (see arc-sweep.ts). Without it the arc takes the shorter way, which can never exceed 180 degrees.
   */
  readonly sweepDirection?: SweepDirection;
}

/**
 * Builds the entity a tool places from its clicks. A click that is not a finite number, or lies beyond the sketch limit,
 * and a result that would exceed a size limit are refused here with a message that names the limit.
 */
export function buildSketchEntity(tool: Exclude<SketchTool, "select">, points: readonly Vec2[], id: string, options: SketchBuildOptions = {}): WorkbenchResult<SketchEntity> {
  const badPoint = sketchPointsProblem(points);
  if (badPoint !== undefined) return degenerate(badPoint);
  const built = buildRawSketchEntity(tool, points, id, options);
  if (!built.ok) return built;
  const tooBig = sketchEntityLimitProblem(built.value);
  return tooBig === undefined ? built : degenerate(tooBig);
}

function buildRawSketchEntity(tool: Exclude<SketchTool, "select">, points: readonly Vec2[], id: string, options: SketchBuildOptions): WorkbenchResult<SketchEntity> {
  if (tool === "line" && points.length === 2) {
    if (distance(points[0]!, points[1]!) < 0.01) return degenerate("A line must be at least 0.01 mm long.");
    return { ok: true, value: { id, kind: "line", start: points[0]!, end: points[1]!, construction: false } };
  }
  if (tool === "rectangle" && points.length === 2) {
    const widthMm = clean(Math.abs(points[1]![0] - points[0]![0]));
    const heightMm = clean(Math.abs(points[1]![1] - points[0]![1]));
    if (widthMm < 0.01 || heightMm < 0.01) return degenerate("A rectangle needs non-zero width and height.");
    return { ok: true, value: { id, kind: "rectangle", center: [clean((points[0]![0] + points[1]![0]) / 2), clean((points[0]![1] + points[1]![1]) / 2)], widthMm, heightMm, rotationDeg: 0, construction: false } };
  }
  if (tool === "rectangle-center" && points.length === 2) {
    const widthMm = clean(Math.abs(points[1]![0] - points[0]![0]) * 2);
    const heightMm = clean(Math.abs(points[1]![1] - points[0]![1]) * 2);
    if (widthMm < 0.01 || heightMm < 0.01) return degenerate("A center rectangle needs a center and a non-zero corner offset.");
    return { ok: true, value: { id, kind: "rectangle", center: points[0]!, widthMm, heightMm, rotationDeg: 0, construction: false } };
  }
  if (tool === "rectangle-three-point" && points.length === 3) {
    const edgeX = points[1]![0] - points[0]![0];
    const edgeY = points[1]![1] - points[0]![1];
    const widthMm = Math.hypot(edgeX, edgeY);
    if (widthMm < 0.01) return degenerate("The first edge of a 3-point rectangle must be at least 0.01 mm long.");
    const normal: Vec2 = [-edgeY / widthMm, edgeX / widthMm];
    const signedHeight = (points[2]![0] - points[1]![0]) * normal[0] + (points[2]![1] - points[1]![1]) * normal[1];
    const heightMm = Math.abs(signedHeight);
    if (heightMm < 0.01) return degenerate("The third point must define a non-zero rectangle height.");
    const offset: Vec2 = [normal[0] * signedHeight, normal[1] * signedHeight];
    const center: Vec2 = [(points[0]![0] + points[1]![0] + offset[0]) / 2, (points[0]![1] + points[1]![1] + offset[1]) / 2];
    return { ok: true, value: { id, kind: "rectangle", center, widthMm, heightMm, rotationDeg: Math.atan2(edgeY, edgeX) * 180 / Math.PI, construction: false } };
  }
  if (tool === "circle" && points.length === 2) {
    const radiusMm = distance(points[0]!, points[1]!);
    if (radiusMm < 0.01) return degenerate("A circle radius must be at least 0.01 mm.");
    return { ok: true, value: { id, kind: "circle", center: points[0]!, radiusMm, construction: false } };
  }
  if (tool === "circle-two-point" && points.length === 2) {
    const diameterMm = distance(points[0]!, points[1]!);
    if (diameterMm < 0.02) return degenerate("A 2-point circle diameter must be at least 0.02 mm.");
    return {
      ok: true,
      value: {
        id,
        kind: "circle",
        center: [clean((points[0]![0] + points[1]![0]) / 2), clean((points[0]![1] + points[1]![1]) / 2)],
        radiusMm: clean(diameterMm / 2),
        construction: false
      }
    };
  }
  if (tool === "circle-three-point" && points.length === 3) {
    const problem = threePointArcProblem(points[0]!, points[1]!, points[2]!);
    if (problem !== undefined) return degenerate(problem);
    const circle = circumcircle(points[0]!, points[1]!, points[2]!)!;
    return { ok: true, value: { id, kind: "circle", center: circle.center, radiusMm: circle.radiusMm, construction: false } };
  }
  if (tool === "ellipse" && points.length === 3) {
    // The ellipse takes its centre, a point on the major axis, and a point that gives the minor radius as its perpendicular distance from the major axis.
    const center = points[0]!;
    const majorX = points[1]![0] - center[0];
    const majorY = points[1]![1] - center[1];
    const majorRadiusMm = Math.hypot(majorX, majorY);
    if (majorRadiusMm < 0.01) return degenerate("An ellipse major radius must be at least 0.01 mm.");
    const axisX = majorX / majorRadiusMm;
    const axisY = majorY / majorRadiusMm;
    const relX = points[2]![0] - center[0];
    const relY = points[2]![1] - center[1];
    const minorRadiusMm = Math.abs(-axisY * relX + axisX * relY);
    if (minorRadiusMm < 0.01) return degenerate("The third ellipse point must define a non-zero minor axis.");
    const rotationDeg = Math.atan2(axisY, axisX) * 180 / Math.PI;
    // Keep major >= minor; swap and rotate 90° if the user picked the shorter axis first. An ellipse looks the same turned
    // half a revolution, so the stored rotation always uses one convention, (-90, 90], like the five-point conic does.
    if (minorRadiusMm > majorRadiusMm) {
      return { ok: true, value: { id, kind: "ellipse", center, majorRadiusMm: minorRadiusMm, minorRadiusMm: majorRadiusMm, rotationDeg: normalizeEllipseRotation(rotationDeg + 90), construction: false } };
    }
    return { ok: true, value: { id, kind: "ellipse", center, majorRadiusMm, minorRadiusMm, rotationDeg: normalizeEllipseRotation(rotationDeg), construction: false } };
  }
  if (tool === "arc" && points.length === 3) {
    const problem = threePointArcProblem(points[0]!, points[1]!, points[2]!);
    if (problem !== undefined) return degenerate(problem);
    return { ok: true, value: { id, kind: "arc", start: points[0]!, mid: points[1]!, end: points[2]!, construction: false } };
  }
  if (tool === "arc-center" && points.length === 3) {
    const center = points[0]!;
    const start = points[1]!;
    const endClick = points[2]!;
    const startDx = start[0] - center[0];
    const startDy = start[1] - center[1];
    const radiusMm = Math.hypot(startDx, startDy);
    if (radiusMm < 0.01) return degenerate("A centerpoint arc radius must be at least 0.01 mm.");
    const endDx = endClick[0] - center[0];
    const endDy = endClick[1] - center[1];
    const endMag = Math.hypot(endDx, endDy);
    if (endMag < 0.01) return degenerate("The arc end must not coincide with the centre.");
    const end: Vec2 = [center[0] + (endDx / endMag) * radiusMm, center[1] + (endDy / endMag) * radiusMm];
    const startAngle = Math.atan2(startDy, startDx);
    const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
    // Without a pointer path the arc takes the shorter way; with one it runs the way the pointer went, so it can pass a half turn.
    let sweep = endAngle - startAngle;
    if (options.sweepDirection !== undefined) {
      sweep = directedSweep(startAngle, endAngle, options.sweepDirection);
      if (Math.abs(sweep) < 1e-6 || Math.abs(sweep) > 2 * Math.PI - 1e-6) return degenerate("The centerpoint arc has zero sweep: the end must sit away from the start direction.");
    } else {
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep <= -Math.PI) sweep += 2 * Math.PI;
    }
    if (Math.abs(sweep) < 1e-6) return degenerate("The centerpoint arc has zero sweep: the end must sit away from the start direction.");
    const midAngle = startAngle + sweep / 2;
    const mid: Vec2 = [center[0] + Math.cos(midAngle) * radiusMm, center[1] + Math.sin(midAngle) * radiusMm];
    return { ok: true, value: { id, kind: "arc", start, mid, end, construction: false } };
  }
  if (tool === "arc-tangent" && points.length === 3) {
    const anchor = points[0]!;
    const dirPoint = points[1]!;
    const end = points[2]!;
    const tx = dirPoint[0] - anchor[0];
    const ty = dirPoint[1] - anchor[1];
    const tangentLen = Math.hypot(tx, ty);
    if (tangentLen < 0.01) return degenerate("The tangent-direction point must sit at least 0.01 mm from the anchor.");
    const nx = -ty / tangentLen;
    const ny = tx / tangentLen;
    const dx = end[0] - anchor[0];
    const dy = end[1] - anchor[1];
    const dSq = dx * dx + dy * dy;
    if (dSq < 1e-6) return degenerate("The arc end must sit at least 0.001 mm from the anchor.");
    const dn = dx * nx + dy * ny;
    if (Math.abs(dn) < 1e-6) return degenerate("The arc end is collinear with the tangent direction; the arc would be a straight line.");
    const signedR = dSq / (2 * dn);
    const radiusMm = Math.abs(signedR);
    if (radiusMm < 0.01) return degenerate("The tangent arc radius is below 0.01 mm.");
    const center: Vec2 = [anchor[0] + nx * signedR, anchor[1] + ny * signedR];
    const direction = signedR > 0 ? 1 : -1;
    const startAngle = Math.atan2(anchor[1] - center[1], anchor[0] - center[0]);
    const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
    let sweep = direction > 0 ? endAngle - startAngle : startAngle - endAngle;
    while (sweep <= 0) sweep += 2 * Math.PI;
    if (sweep < 1e-6 || sweep >= 2 * Math.PI - 1e-6) return degenerate("The tangent arc sweep is zero or a full turn.");
    const midAngle = startAngle + direction * sweep / 2;
    const mid: Vec2 = [center[0] + Math.cos(midAngle) * radiusMm, center[1] + Math.sin(midAngle) * radiusMm];
    return { ok: true, value: { id, kind: "arc", start: anchor, mid, end, construction: false } };
  }
  if (tool === "point" && points.length === 1) {
    // A sketch point is reference geometry: it snaps and anchors patterns but never bounds a profile.
    return { ok: true, value: { id, kind: "point", point: points[0]!, construction: true } };
  }
  if (tool === "spline" && points.length >= SPLINE_MIN_FIT_POINTS) {
    if (points.length > SPLINE_MAX_FIT_POINTS) return degenerate(`A spline takes at most ${SPLINE_MAX_FIT_POINTS} fit points.`);
    if (points.some((point, index) => index > 0 && distance(points[index - 1]!, point) < 0.01)) return degenerate("Consecutive spline fit points must be at least 0.01 mm apart.");
    const repeated = repeatedSplinePoint(points);
    if (repeated !== undefined) return degenerate(`Fit points ${repeated[0] + 1} and ${repeated[1] + 1} are on top of each other: a spline that doubles back onto a point it already passed has no smooth shape. Move one of them, or draw the closed loop with at least four points ending on the first.`);
    return { ok: true, value: { id, kind: "spline", fitPoints: points, construction: false } };
  }
  return failure("INVALID_OPERATION", `${sketchToolLabel(tool)} requires ${requiredSketchPoints(tool)} points.`, [], "Complete the required points or cancel the sketch tool.");
}

export function requiredSketchPoints(tool: SketchTool): number {
  const curveTool = curveToolRequiredPoints(tool);
  if (curveTool !== undefined) return curveTool;
  // A spline needs three fit points at least; the workspace lets the user keep adding points until they finish it.
  return tool === "select" ? 0 : tool === "point" ? 1 : tool === "arc" || tool === "arc-center" || tool === "arc-tangent" || tool === "spline" || tool === "rectangle-three-point" || tool === "circle-three-point" || tool === "ellipse" || tool === "slot" || tool === "slot-straight" ? 3 : 2;
}

export function sketchToolLabel(tool: SketchTool): string {
  const labels: Record<SketchTool, string> = {
    select: "Select",
    line: "Line",
    rectangle: "2-point rectangle",
    "rectangle-center": "Center rectangle",
    "rectangle-three-point": "3-point rectangle",
    circle: "Center-radius circle",
    "circle-two-point": "2-point circle",
    "circle-three-point": "3-point circle",
    ellipse: "Center ellipse",
    arc: "3-point arc",
    "arc-center": "Centerpoint arc",
    "arc-tangent": "Tangent arc",
    point: "Point",
    spline: "Fit-point spline",
    polygon: "Polygon",
    slot: "Center-to-center slot",
    "slot-straight": "Straight slot",
    ...CURVE_TOOL_LABELS
  };
  return labels[tool];
}

/**
 * Derives the selectable closed regions of a sketch without mutating its geometry. All visible, non-construction curves are
 * split at their mutual intersections and joints (see arrangement.ts), and every enclosed face is a profile: a rectangle with a
 * diagonal gives two triangles, a grid of crossing lines gives its cells, overlapping shapes give their pieces and a ring between
 * concentric loops is a profile with a hole. Isolated primitives and loops are exact and keep their ids.
 */
export function detectSketchProfiles(sketch: WorkbenchSketch, options: ProfileDetectionOptions = {}): readonly SketchProfile[] {
  return detectProfilesOf(sketch, options);
}

/** Short stable token for a set of sketch entities, used to name kernel faces so names survive reordering and resizing. */
export function stableEntityToken(entityIds: readonly string[]): string {
  return fnv1a([...entityIds].sort().join("|"));
}

/**
 * Resolves the exact profile envelope supported by the qualified Phase-0 solid
 * evaluator: one axis-aligned rectangle and one concentric circular passage.
 */
export function resolveQualifiedExtrusion(
  sketch: WorkbenchSketch,
  selectedProfileIds: readonly string[],
  distanceMm: number
): WorkbenchResult<QualifiedExtrusionCandidate> {
  if (!Number.isFinite(distanceMm) || distanceMm < 1 || distanceMm > 100) {
    return failure("OUTSIDE_SUPPORTED_ENVELOPE", "Qualified extrusion distance must be between 1 mm and 100 mm.", [], "Enter a bounded positive extrusion distance.");
  }
  const detected = detectSketchProfiles(sketch);
  const profiles = shapesOf(detected) ?? detected;
  // A region id (the notched plate a crossing circle leaves) means the closed shape it was cut from.
  const wanted = new Set(selectedProfileIds.flatMap((id) => {
    const direct = matchProfileRef(id, profiles, false)?.profile;
    if (direct !== undefined) return [direct.id];
    const face = matchProfileRef(id, detected, false)?.profile;
    const source = face === undefined ? undefined : profiles.filter((profile) => profile.entityIds.every((entityId) => face.entityIds.includes(entityId)) && (face.interiorPoint === undefined || pointInRing(face.interiorPoint, profileOutlineMm(profile.boundary)))).sort((left, right) => left.areaMm2 - right.areaMm2)[0];
    return source === undefined ? [] : [source.id];
  }));
  const selected = profiles.filter((profile) => wanted.has(profile.id));
  const rectangles = selected.filter((profile) => profile.boundary.kind === "rectangle");
  if (rectangles.length !== 1) {
    return failure("INVALID_OPERATION", "Extrude needs either one closed rectangle profile (with its concentric bore circle) for the qualified plate, or a single circle on its own for a cylinder.", selectedProfileIds, "Click inside one shaded rectangle region and Shift-select its concentric circle, or select a single circle to extrude a cylinder.");
  }
  const outer = rectangles[0]!;
  if (outer.boundary.kind !== "rectangle") throw new TypeError("Profile filter invariant failed.");
  const outerRotation = normalizeRotation(outer.boundary.rotationDeg);
  const quarterTurn = Math.abs(Math.abs(outerRotation) - 90) < 1e-6;
  if (Math.abs(outerRotation) > 1e-6 && !quarterTurn) {
    return failure("UNSUPPORTED_CAPABILITY", "The qualified solid evaluator currently accepts an axis-aligned rectangle only.", outer.entityIds, "Use a 2-point or center rectangle aligned to the sketch axes.");
  }
  // A rectangle drawn with a vertical first edge is stored at 90 degrees but is still axis-aligned; swap its sides so width/height map to the sketch axes.
  const qualifiedWidthMm = quarterTurn ? outer.boundary.heightMm : outer.boundary.widthMm;
  const qualifiedHeightMm = quarterTurn ? outer.boundary.widthMm : outer.boundary.heightMm;
  const explicitlySelectedCircles = selected.filter((profile) => profile.boundary.kind === "circle");
  const concentricCircles = profiles.filter((profile) => profile.boundary.kind === "circle" && distance(profile.centroid, outer.centroid) <= 0.01);
  const boreCandidates = explicitlySelectedCircles.length > 0 ? explicitlySelectedCircles : concentricCircles;
  if (boreCandidates.length !== 1 || boreCandidates[0]!.boundary.kind !== "circle") {
    return failure("INVALID_OPERATION", "The qualified extrusion needs exactly one concentric circular profile for its through-bore.", selectedProfileIds, "Create or Shift-select one circle centered on the rectangle.");
  }
  const bore = boreCandidates[0]!;
  const boreBoundary = bore.boundary;
  if (boreBoundary.kind !== "circle") throw new TypeError("Profile filter invariant failed.");
  if (distance(bore.centroid, outer.centroid) > 0.01) {
    return failure("UNSUPPORTED_CAPABILITY", "The selected circular profile is not concentric with the qualified rectangle.", bore.entityIds, "Constrain the circle center to the rectangle center before extrusion.");
  }
  const holeDiameterMm = boreBoundary.radiusMm * 2;
  if ((Math.min(outer.boundary.widthMm, outer.boundary.heightMm) - holeDiameterMm) / 2 < 1) {
    return failure("DEGENERATE_GEOMETRY", "The selected profiles leave less than the qualified 1 mm wall allowance.", [...outer.entityIds, ...bore.entityIds], "Reduce the circle or enlarge the rectangle.");
  }
  return {
    ok: true,
    value: {
      outerProfileId: outer.id,
      boreProfileId: bore.id,
      widthMm: qualifiedWidthMm,
      heightMm: qualifiedHeightMm,
      holeDiameterMm,
      distanceMm
    }
  };
}

/**
 * The true bounding box of an entity: circles reach centre ± radius, arcs and splines follow their sampled curve
 * (defining points alone under-report a bulging arc or a wide circle), rectangles use their rotated corners.
 */
export function entityExtents(entity: SketchEntity): { readonly min: Vec2; readonly max: Vec2 } {
  let points: readonly Vec2[];
  if (entity.kind === "circle") points = [[entity.center[0] - entity.radiusMm, entity.center[1] - entity.radiusMm], [entity.center[0] + entity.radiusMm, entity.center[1] + entity.radiusMm]];
  else if (entity.kind === "ellipse") {
    // True rotated ellipse extents: max X = sqrt((a cos r)² + (b sin r)²), max Y = sqrt((a sin r)² + (b cos r)²).
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const spanX = Math.hypot(entity.majorRadiusMm * cos, entity.minorRadiusMm * sin);
    const spanY = Math.hypot(entity.majorRadiusMm * sin, entity.minorRadiusMm * cos);
    points = [[entity.center[0] - spanX, entity.center[1] - spanY], [entity.center[0] + spanX, entity.center[1] + spanY]];
  }
  else if (entity.kind === "arc") points = sampleArc(entity.start, entity.mid, entity.end);
  else if (entity.kind === "spline") points = sampleSpline(entity.fitPoints);
  else points = entityPoints(entity);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

export function sketchBounds(entities: readonly SketchEntity[]): SketchAnalysis["boundsMm"] {
  const points = entities.flatMap((entity) => {
    const extents = entityExtents(entity);
    return [extents.min, extents.max];
  });
  if (points.length === 0) return { min: [-50, -35], max: [50, 35], size: [100, 70] };
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const min: Vec2 = [Math.min(...xs), Math.min(...ys)];
  const max: Vec2 = [Math.max(...xs), Math.max(...ys)];
  return { min, max, size: [Math.max(max[0] - min[0], 1), Math.max(max[1] - min[1], 1)] };
}

export function entityPoints(entity: SketchEntity): readonly Vec2[] {
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind === "rectangle") {
    const halfWidth = entity.widthMm / 2;
    const halfHeight = entity.heightMm / 2;
    const radians = entity.rotationDeg * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corner = (dx: number, dy: number): Vec2 => [
      entity.center[0] + dx * cos - dy * sin,
      entity.center[1] + dx * sin + dy * cos
    ];
    return [
      corner(-halfWidth, -halfHeight),
      corner(halfWidth, -halfHeight),
      corner(halfWidth, halfHeight),
      corner(-halfWidth, halfHeight)
    ];
  }
  if (entity.kind === "circle") return [entity.center, [entity.center[0] + entity.radiusMm, entity.center[1]]];
  if (entity.kind === "ellipse") {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const majorEnd: Vec2 = [entity.center[0] + entity.majorRadiusMm * cos, entity.center[1] + entity.majorRadiusMm * sin];
    const minorEnd: Vec2 = [entity.center[0] - entity.minorRadiusMm * sin, entity.center[1] + entity.minorRadiusMm * cos];
    return [entity.center, majorEnd, minorEnd];
  }
  if (entity.kind === "point") return [entity.point];
  if (entity.kind === "spline") return entity.fitPoints;
  return [entity.start, entity.mid, entity.end];
}

/** Returns the complete topological curve component that contains the seed. */
export function selectConnectedSketchEntities(sketch: WorkbenchSketch, seedId: string, toleranceMm = sketch.snapToleranceMm): readonly string[] {
  const seed = sketch.entities.find((entity) => entity.id === seedId);
  if (seed === undefined) return [];
  const curveEntities = sketch.entities.filter((entity) => !entity.construction);
  const selected = new Set<string>();
  const queue = [seed.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (selected.has(id)) continue;
    const entity = curveEntities.find((candidate) => candidate.id === id);
    if (entity === undefined) continue;
    selected.add(id);
    const endpoints = curveEndpoints(entity);
    if (endpoints.length === 0) continue;
    for (const candidate of curveEntities) {
      if (selected.has(candidate.id) || candidate.id === id) continue;
      if (endpoints.some((endpoint) => curveEndpoints(candidate).some((other) => distance(endpoint, other) <= toleranceMm))) queue.push(candidate.id);
    }
  }
  return [...selected].sort();
}

/** Selects only endpoint-connected entities that are tangent within tolerance. */
export function selectTangentSketchEntities(sketch: WorkbenchSketch, seedId: string, angularToleranceDeg = 2, toleranceMm = sketch.snapToleranceMm): readonly string[] {
  const seed = sketch.entities.find((entity) => entity.id === seedId);
  if (seed === undefined) return [];
  if (curveEndpoints(seed).length === 0) return [seed.id];
  const curveEntities = sketch.entities.filter((entity) => !entity.construction);
  const cosineTolerance = Math.cos(angularToleranceDeg * Math.PI / 180);
  const selected = new Set<string>();
  const queue = [seed.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (selected.has(id)) continue;
    const entity = curveEntities.find((candidate) => candidate.id === id);
    if (entity === undefined) continue;
    selected.add(id);
    for (const candidate of curveEntities) {
      if (selected.has(candidate.id) || candidate.id === id) continue;
      if (curvesShareTangent(entity, candidate, toleranceMm, cosineTolerance)) queue.push(candidate.id);
    }
  }
  return [...selected].sort();
}

/** Counts branch endpoints so the UI can disclose ambiguous chain intent. */
export function sketchChainBranchCount(sketch: WorkbenchSketch, entityIds: readonly string[], toleranceMm = sketch.snapToleranceMm): number {
  const endpoints = entityIds.flatMap((id) => {
    const entity = sketch.entities.find((candidate) => candidate.id === id);
    return entity === undefined ? [] : curveEndpoints(entity);
  });
  return endpoints.filter((point, index) => endpoints.filter((candidate, candidateIndex) => candidateIndex !== index && distance(point, candidate) <= toleranceMm).length >= 2).length;
}


function curveEndpoints(entity: SketchEntity): readonly Vec2[] {
  if (entity.kind === "line" || entity.kind === "arc") return [entity.start, entity.end];
  if (entity.kind === "spline") return [entity.fitPoints[0]!, entity.fitPoints[entity.fitPoints.length - 1]!];
  return [];
}

function curvesShareTangent(left: SketchEntity, right: SketchEntity, toleranceMm: number, cosineTolerance: number): boolean {
  for (const leftEnd of curveEndTangents(left)) {
    for (const rightEnd of curveEndTangents(right)) {
      if (distance(leftEnd.point, rightEnd.point) > toleranceMm) continue;
      const dot = Math.abs(leftEnd.tangent[0] * rightEnd.tangent[0] + leftEnd.tangent[1] * rightEnd.tangent[1]);
      if (dot >= cosineTolerance) return true;
    }
  }
  return false;
}

function curveEndTangents(entity: SketchEntity): readonly { readonly point: Vec2; readonly tangent: Vec2 }[] {
  if (entity.kind === "line") {
    const tangent = normalize2([entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]]);
    return [{ point: entity.start, tangent }, { point: entity.end, tangent }];
  }
  if (entity.kind === "arc") {
    const circle = circumcircle(entity.start, entity.mid, entity.end);
    if (circle === undefined) {
      return [
        { point: entity.start, tangent: normalize2([entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]]) },
        { point: entity.end, tangent: normalize2([entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]]) }
      ];
    }
    // The tangent of a circle at a point is perpendicular to the radius there. (The old code used the start-to-mid and
    // mid-to-end chords, which are off by a quarter of the sweep and failed the 2 degree test beyond about 4 degrees.)
    const counterClockwise = cross(entity.start, entity.mid, entity.end) > 0;
    const tangentAt = (point: Vec2): Vec2 => {
      const radialX = point[0] - circle.center[0];
      const radialY = point[1] - circle.center[1];
      return normalize2(counterClockwise ? [-radialY, radialX] : [radialY, -radialX]);
    };
    return [{ point: entity.start, tangent: tangentAt(entity.start) }, { point: entity.end, tangent: tangentAt(entity.end) }];
  }
  if (entity.kind === "spline") {
    const fit = entity.fitPoints;
    // The true end tangent of the sampled curve, read from its first and last short steps (each end span depends only on
    // the three nearest fit points, so the span is sampled finely on its own).
    const head = sampleSpline(fit.slice(0, 3), 64);
    const tail = sampleSpline(fit.slice(-3), 64);
    return [
      { point: fit[0]!, tangent: normalize2([head[1]![0] - head[0]![0], head[1]![1] - head[0]![1]]) },
      { point: fit[fit.length - 1]!, tangent: normalize2([tail[tail.length - 1]![0] - tail[tail.length - 2]![0], tail[tail.length - 1]![1] - tail[tail.length - 2]![1]]) }
    ];
  }
  return [];
}

function normalize2(value: Vec2): Vec2 {
  const length = Math.hypot(...value);
  return length < 1e-12 ? [0, 0] : [value[0] / length, value[1] / length];
}

/**
 * Takes `amount` degrees of freedom away across the curves a relation joins. The reduction is shared between them rather than
 * charged to the first one: a joint costs each end a degree of freedom, and a Fixed curve, which has nothing left to give,
 * passes its share on to its partner. The total is unchanged; only who is blamed for it is fairer, which is what
 * "fully constrained" colouring and Show Movable read.
 */

/** Rounds to a multiple of `increment` and cleans the binary-float tail (0.1 * 3 is 0.30000000000000004, not 0.3). */
function roundTo(value: number, increment: number): number {
  return clean(Math.round(value / increment) * increment);
}

/** Drops float noise from a derived coordinate or size: twelve significant digits keep every real input exactly and lose 0.7000000000000001. */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : value;
}

function distance(left: Vec2, right: Vec2): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** The circle through three points, judged relative to their own size (see workbench-core arc-geometry.ts). */
function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  return circleThroughThreePoints(a, b, c);
}

/** An ellipse looks the same turned half a revolution, so its rotation is stored in (-90, 90]. */
function normalizeEllipseRotation(rotationDeg: number): number {
  const wrapped = ((rotationDeg % 180) + 180) % 180;
  const normalized = wrapped > 90 ? wrapped - 180 : wrapped;
  // Clean the float noise that the modulo of a value like 225 leaves behind.
  return Math.abs(normalized - Math.round(normalized)) < 1e-9 ? Math.round(normalized) : normalized;
}

/** The first pair of fit points that coincide although they are not neighbours, other than the first and last of a closed loop of four or more. */
function repeatedSplinePoint(points: readonly Vec2[]): readonly [number, number] | undefined {
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 2; second < points.length; second += 1) {
      if (first === 0 && second === points.length - 1 && points.length >= 4) continue;
      if (distance(points[first]!, points[second]!) < 0.01) return [first, second];
    }
  }
  return undefined;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeRotation(value: number): number {
  const normalized = ((value % 180) + 180) % 180;
  return normalized > 90 ? normalized - 180 : normalized;
}

function degenerate(message: string): WorkbenchResult<never> {
  return failure("DEGENERATE_GEOMETRY", message, [], "Choose points farther apart within the supported sketch envelope.");
}
