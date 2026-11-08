import {
  constraintFit,
  failure,
  type SketchEntity,
  type Vec2,
  type WorkbenchResult,
  type WorkbenchSketch
} from "../../workbench-core/src/index.js";

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
  | "slot-straight";

/** Tools whose result is a whole parametric shape (several entities and relations) rather than one entity. */
export function isShapeTool(tool: SketchTool): tool is "polygon" | "slot" | "slot-straight" {
  return tool === "polygon" || tool === "slot" || tool === "slot-straight";
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
}

export interface SketchProfile {
  readonly id: string;
  readonly entityIds: readonly string[];
  readonly boundary: SketchProfileBoundary;
  readonly areaMm2: number;
  readonly centroid: Vec2;
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
  readonly degreesOfFreedom: number;
  readonly entityFreedom: Readonly<Record<string, number>>;
  readonly appliedConstraints: number;
  readonly conflicts: readonly string[];
  readonly boundsMm: { readonly min: Vec2; readonly max: Vec2; readonly size: Vec2 };
}

export interface SnapResult {
  readonly point: Vec2;
  readonly snapped: boolean;
  readonly kind: "grid" | "endpoint" | "none";
  readonly targetId?: string;
}

export function analyzeWorkbenchSketch(sketch: WorkbenchSketch): SketchAnalysis {
  const freedom = new Map(sketch.entities.map((entity) => [entity.id, baseFreedom(entity)]));
  const conflicts: string[] = [];
  const orientations = new Map<string, Set<string>>();
  const scalarValues = new Map<string, number>();
  let applied = 0;

  for (const constraint of sketch.constraints) {
    // A relaxed relation stays recorded but takes no freedom away.
    if (constraint.suppressed === true) continue;
    if (constraint.kind === "fixed") {
      for (const id of constraint.entityIds) freedom.set(id, 0);
      applied += 1;
      continue;
    }
    if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
      const id = constraint.entityIds[0]!;
      const entity = sketch.entities.find((candidate) => candidate.id === id);
      if (entity?.kind !== "line") conflicts.push(`${constraint.id} requires a line.`);
      const set = orientations.get(id) ?? new Set<string>();
      set.add(constraint.kind);
      orientations.set(id, set);
      reduce(freedom, [id], 1);
      applied += 1;
      continue;
    }
    if (constraint.kind === "concentric") {
      const entities = constraint.entityIds.map((id) => sketch.entities.find((candidate) => candidate.id === id));
      if (!constraintFit("concentric", entities.map((entity) => entity?.kind)).ok) conflicts.push(`${constraint.id} requires two circles or arcs.`);
      reduce(freedom, constraint.entityIds, 2);
      applied += 1;
      continue;
    }
    if (constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "collinear") {
      const entities = constraint.entityIds.map((id) => sketch.entities.find((candidate) => candidate.id === id));
      if (entities.length !== 2 || entities.some((entity) => entity?.kind !== "line")) conflicts.push(`${constraint.id} requires two lines.`);
      reduce(freedom, constraint.entityIds, constraint.kind === "collinear" ? 2 : 1);
      applied += 1;
      continue;
    }
    if (constraint.kind === "tangent") {
      if (constraint.entityIds.length !== 2) conflicts.push(`${constraint.id} requires two entities.`);
      reduce(freedom, constraint.entityIds, 1);
      applied += 1;
      continue;
    }
    // A driven (reference) dimension is measured from the geometry; it takes no freedom and can conflict with nothing.
    if (constraint.driven === true) continue;
    if (constraint.kind === "angle" || constraint.kind === "arc-length" || constraint.kind === "perimeter") {
      const entities = constraint.entityIds.map((id) => sketch.entities.find((candidate) => candidate.id === id));
      if (!constraintFit(constraint.kind, entities.map((entity) => entity?.kind), constraint.points).ok) conflicts.push(`${constraint.id} does not apply to these curves.`);
      const value = constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
      if (value === undefined) conflicts.push(`${constraint.id} requires a numeric value.`);
      else {
        const key = `${constraint.kind}:${constraint.entityIds.join("|")}`;
        const prior = scalarValues.get(key);
        if (prior !== undefined && Math.abs(prior - value) > 1e-9) conflicts.push(`${constraint.id} conflicts with another ${constraint.kind} value.`);
        scalarValues.set(key, value);
      }
      reduce(freedom, constraint.entityIds, 1);
      applied += 1;
      continue;
    }
    if (constraint.kind === "smooth") {
      const entities = constraint.entityIds.map((id) => sketch.entities.find((candidate) => candidate.id === id));
      if (!constraintFit("smooth", entities.map((entity) => entity?.kind), constraint.points).ok) conflicts.push(`${constraint.id} needs a spline end meeting a line, arc or spline end.`);
      // Joining the ends (2), matching the tangent (1) and matching the curvature (1) all act on the spline.
      const splineId = constraint.entityIds.find((id) => sketch.entities.find((candidate) => candidate.id === id)?.kind === "spline") ?? constraint.entityIds[0]!;
      reduce(freedom, [splineId], 4);
      applied += 1;
      continue;
    }
    if (constraint.kind === "pierce") {
      if (constraint.entityIds.length !== 1 || sketch.entities.find((candidate) => candidate.id === constraint.entityIds[0])?.kind !== "point") conflicts.push(`${constraint.id} requires a sketch point.`);
      reduce(freedom, constraint.entityIds, 2);
      applied += 1;
      continue;
    }
    if (constraint.kind === "refraction") {
      const entities = constraint.entityIds.map((id) => sketch.entities.find((candidate) => candidate.id === id));
      if (!constraintFit("refraction", entities.map((entity) => entity?.kind)).ok) conflicts.push(`${constraint.id} requires three lines.`);
      reduce(freedom, [constraint.entityIds[1]!], 1);
      applied += 1;
      continue;
    }
    if (constraint.kind === "radius" || constraint.kind === "distance") {
      if (constraint.valueMm === undefined) conflicts.push(`${constraint.id} requires a numeric value.`);
      const key = `${constraint.kind}:${constraint.dimension ?? "generic"}:${constraint.entityIds.join("|")}`;
      if (constraint.valueMm !== undefined) {
        const prior = scalarValues.get(key);
        if (prior !== undefined && Math.abs(prior - constraint.valueMm) > 1e-9) conflicts.push(`${constraint.id} conflicts with another ${constraint.kind} value.`);
        scalarValues.set(key, constraint.valueMm);
      }
      reduce(freedom, constraint.entityIds, 1);
      applied += 1;
      continue;
    }
    const reduction = constraint.kind === "coincident" ? 2 : 1;
    reduce(freedom, constraint.entityIds, reduction);
    applied += 1;
  }

  for (const [id, kinds] of orientations) {
    if (kinds.has("horizontal") && kinds.has("vertical")) conflicts.push(`${id} cannot be both horizontal and vertical unless degenerate.`);
  }
  const degreesOfFreedom = [...freedom.values()].reduce((sum, value) => sum + value, 0);
  return {
    classification: conflicts.length > 0 ? "conflict" : degreesOfFreedom === 0 ? "fully-constrained" : "underconstrained",
    degreesOfFreedom,
    entityFreedom: Object.fromEntries([...freedom.entries()].sort(([left], [right]) => left.localeCompare(right))),
    appliedConstraints: applied,
    conflicts,
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

export function buildSketchEntity(tool: Exclude<SketchTool, "select">, points: readonly Vec2[], id: string): WorkbenchResult<SketchEntity> {
  if (tool === "line" && points.length === 2) {
    if (distance(points[0]!, points[1]!) < 0.01) return degenerate("A line must be at least 0.01 mm long.");
    return { ok: true, value: { id, kind: "line", start: points[0]!, end: points[1]!, construction: false } };
  }
  if (tool === "rectangle" && points.length === 2) {
    const widthMm = Math.abs(points[1]![0] - points[0]![0]);
    const heightMm = Math.abs(points[1]![1] - points[0]![1]);
    if (widthMm < 0.01 || heightMm < 0.01) return degenerate("A rectangle needs non-zero width and height.");
    return { ok: true, value: { id, kind: "rectangle", center: [(points[0]![0] + points[1]![0]) / 2, (points[0]![1] + points[1]![1]) / 2], widthMm, heightMm, rotationDeg: 0, construction: false } };
  }
  if (tool === "rectangle-center" && points.length === 2) {
    const widthMm = Math.abs(points[1]![0] - points[0]![0]) * 2;
    const heightMm = Math.abs(points[1]![1] - points[0]![1]) * 2;
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
        center: [(points[0]![0] + points[1]![0]) / 2, (points[0]![1] + points[1]![1]) / 2],
        radiusMm: diameterMm / 2,
        construction: false
      }
    };
  }
  if (tool === "circle-three-point" && points.length === 3) {
    const circle = circumcircle(points[0]!, points[1]!, points[2]!);
    if (circle === undefined || circle.radiusMm < 0.01) return degenerate("The three circle points must be distinct and non-collinear.");
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
    // Keep major >= minor; swap and rotate 90° if the user picked the shorter axis first.
    if (minorRadiusMm > majorRadiusMm) {
      return { ok: true, value: { id, kind: "ellipse", center, majorRadiusMm: minorRadiusMm, minorRadiusMm: majorRadiusMm, rotationDeg: rotationDeg + 90, construction: false } };
    }
    return { ok: true, value: { id, kind: "ellipse", center, majorRadiusMm, minorRadiusMm, rotationDeg, construction: false } };
  }
  if (tool === "arc" && points.length === 3) {
    const area2 = Math.abs(cross(points[0]!, points[1]!, points[2]!));
    if (area2 < 1e-4) return degenerate("The three arc points must not be collinear.");
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
    let sweep = endAngle - startAngle;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep <= -Math.PI) sweep += 2 * Math.PI;
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
  if (tool === "spline" && points.length >= 3) {
    if (points.length > 24) return degenerate("A spline takes at most 24 fit points.");
    if (points.some((point, index) => index > 0 && distance(points[index - 1]!, point) < 0.01)) return degenerate("Consecutive spline fit points must be at least 0.01 mm apart.");
    return { ok: true, value: { id, kind: "spline", fitPoints: points, construction: false } };
  }
  return failure("INVALID_OPERATION", `${sketchToolLabel(tool)} requires ${requiredSketchPoints(tool)} points.`, [], "Complete the required points or cancel the sketch tool.");
}

export function requiredSketchPoints(tool: SketchTool): number {
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
    "slot-straight": "Straight slot"
  };
  return labels[tool];
}

/**
 * Derives selectable closed profiles without mutating sketch geometry. Primitive
 * rectangles/circles are exact. Connected line-only loops are recognized when
 * every endpoint in the component has degree two.
 */
export function detectSketchProfiles(sketch: WorkbenchSketch): readonly SketchProfile[] {
  const profiles: SketchProfile[] = [];
  // Hidden geometry never bounds a profile: what you cannot see must not become a solid or a hole.
  const shown = sketch.entities.filter((entity) => entity.visible !== false);
  for (const entity of shown) {
    if (entity.construction) continue;
    if (entity.kind === "rectangle") {
      profiles.push({
        id: profileId(entity.id),
        entityIds: [entity.id],
        boundary: { kind: "rectangle", center: entity.center, widthMm: entity.widthMm, heightMm: entity.heightMm, rotationDeg: entity.rotationDeg },
        areaMm2: entity.widthMm * entity.heightMm,
        centroid: entity.center
      });
    }
    if (entity.kind === "circle") {
      profiles.push({
        id: profileId(entity.id),
        entityIds: [entity.id],
        boundary: { kind: "circle", center: entity.center, radiusMm: entity.radiusMm },
        areaMm2: Math.PI * entity.radiusMm ** 2,
        centroid: entity.center
      });
    }
    if (entity.kind === "ellipse") {
      profiles.push({
        id: profileId(entity.id),
        entityIds: [entity.id],
        boundary: { kind: "ellipse", center: entity.center, majorRadiusMm: entity.majorRadiusMm, minorRadiusMm: entity.minorRadiusMm, rotationDeg: entity.rotationDeg },
        areaMm2: Math.PI * entity.majorRadiusMm * entity.minorRadiusMm,
        centroid: entity.center
      });
    }
  }
  profiles.push(...detectCurveLoops(shown.filter((entity): entity is Extract<SketchEntity, { kind: "line" | "arc" | "spline" }> => (entity.kind === "line" || entity.kind === "arc" || entity.kind === "spline") && !entity.construction)));
  return profiles.sort((left, right) => right.areaMm2 - left.areaMm2 || left.id.localeCompare(right.id));
}

/** Closed polygon (millimetres) that outlines a profile: circles are sampled at 72 points, arcs at their sampled facets. */
export function profileOutlineMm(boundary: SketchProfileBoundary): readonly Vec2[] {
  if (boundary.kind === "circle") {
    return Array.from({ length: 72 }, (_, index): Vec2 => {
      const angle = (2 * Math.PI * index) / 72;
      return [boundary.center[0] + boundary.radiusMm * Math.cos(angle), boundary.center[1] + boundary.radiusMm * Math.sin(angle)];
    });
  }
  if (boundary.kind === "ellipse") {
    const radians = (boundary.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return Array.from({ length: 72 }, (_, index): Vec2 => {
      const theta = (2 * Math.PI * index) / 72;
      const localX = boundary.majorRadiusMm * Math.cos(theta);
      const localY = boundary.minorRadiusMm * Math.sin(theta);
      return [boundary.center[0] + localX * cos - localY * sin, boundary.center[1] + localX * sin + localY * cos];
    });
  }
  if (boundary.kind === "rectangle") {
    const halfWidth = boundary.widthMm / 2;
    const halfHeight = boundary.heightMm / 2;
    const radians = (boundary.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners: readonly Vec2[] = [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]];
    return corners.map(([x, y]): Vec2 => [boundary.center[0] + x * cos - y * sin, boundary.center[1] + x * sin + y * cos]);
  }
  return boundary.points;
}

/** Short stable token for a set of sketch entities, used to name kernel faces so names survive reordering and resizing. */
export function stableEntityToken(entityIds: readonly string[]): string {
  return fnv1a([...entityIds].sort().join("|"));
}

export interface ProfileRegion {
  readonly outer: SketchProfile;
  /** Profiles that become holes through the outer profile, largest first. */
  readonly holes: readonly SketchProfile[];
}

/**
 * Turns a profile selection into one outer profile plus the holes cut through it.
 * The largest selected profile is the outer boundary and every other selected profile must lie inside it.
 * With `includeIslands` a lone selection also takes the profiles that sit directly inside it, which is what
 * a CAD region click does: a rectangle with a circle in it extrudes as a plate with a hole.
 */
export function resolveProfileRegion(
  profiles: readonly SketchProfile[],
  selectedIds: readonly string[],
  options: { readonly includeIslands: boolean }
): WorkbenchResult<ProfileRegion> {
  const selected = profiles.filter((profile) => selectedIds.includes(profile.id)).sort((left, right) => right.areaMm2 - left.areaMm2);
  const outer = selected[0] ?? profiles[0];
  if (outer === undefined) return failure("INVALID_OPERATION", "Draw or select a closed profile first.", [], "Draw a closed profile in the sketch.");
  const outerOutline = profileOutlineMm(outer.boundary);
  const inside = (candidate: SketchProfile, ring: readonly Vec2[]): boolean => profileOutlineMm(candidate.boundary).every((point) => pointInPolygon(point, ring));
  if (selected.length > 1) {
    const holes = selected.slice(1);
    const stray = holes.find((hole) => !inside(hole, outerOutline));
    if (stray !== undefined) return failure("INVALID_OPERATION", "Every extra selected profile must lie inside the largest selected profile; it becomes a hole. One of the selected profiles is outside it.", stray.entityIds, "Select only the outer profile and the profiles inside it, or extrude them one at a time.");
    const nested = holes.find((hole) => holes.some((other) => other !== hole && inside(hole, profileOutlineMm(other.boundary))));
    if (nested !== undefined) return failure("INVALID_OPERATION", "A selected profile sits inside another hole, which would be a separate island. Extrude it on its own.", nested.entityIds, "Deselect the innermost profile.");
    return { ok: true, value: { outer, holes } };
  }
  if (!options.includeIslands) return { ok: true, value: { outer, holes: [] } };
  const contained = profiles.filter((candidate) => candidate !== outer && candidate.areaMm2 < outer.areaMm2 && inside(candidate, outerOutline));
  const islands = contained.filter((candidate) => !contained.some((other) => other !== candidate && other.areaMm2 > candidate.areaMm2 && inside(candidate, profileOutlineMm(other.boundary))));
  return { ok: true, value: { outer, holes: islands } };
}

function pointInPolygon(point: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
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
  const profiles = detectSketchProfiles(sketch);
  const selected = profiles.filter((profile) => selectedProfileIds.includes(profile.id));
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

/**
 * Smooth uniform Catmull-Rom curve through the fit points, sampled into short straight edges.
 * The first and last samples are exactly the first and last fit points.
 */
export function sampleSpline(fitPoints: readonly Vec2[], samplesPerSpan = 8): readonly Vec2[] {
  if (fitPoints.length < 3) return fitPoints;
  const points: Vec2[] = [fitPoints[0]!];
  for (let span = 0; span < fitPoints.length - 1; span += 1) {
    const p0 = fitPoints[Math.max(0, span - 1)]!;
    const p1 = fitPoints[span]!;
    const p2 = fitPoints[span + 1]!;
    const p3 = fitPoints[Math.min(fitPoints.length - 1, span + 2)]!;
    for (let step = 1; step <= samplesPerSpan; step += 1) {
      if (span === fitPoints.length - 2 && step === samplesPerSpan) {
        points.push(p2);
        break;
      }
      const t = step / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      points.push([blend(p0[0], p1[0], p2[0], p3[0]), blend(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return points;
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

function baseFreedom(entity: SketchEntity): number {
  if (entity.kind === "line") return 4;
  if (entity.kind === "rectangle") return 5;
  if (entity.kind === "circle") return 3;
  if (entity.kind === "ellipse") return 5; // centre (2), two radii (2) and orientation (1)
  if (entity.kind === "point") return 2;
  if (entity.kind === "spline") return entity.fitPoints.length * 2;
  return 6;
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
    return [
      { point: entity.start, tangent: normalize2([entity.mid[0] - entity.start[0], entity.mid[1] - entity.start[1]]) },
      { point: entity.end, tangent: normalize2([entity.end[0] - entity.mid[0], entity.end[1] - entity.mid[1]]) }
    ];
  }
  if (entity.kind === "spline") {
    const fit = entity.fitPoints;
    const last = fit.length - 1;
    return [
      { point: fit[0]!, tangent: normalize2([fit[1]![0] - fit[0]![0], fit[1]![1] - fit[0]![1]]) },
      { point: fit[last]!, tangent: normalize2([fit[last]![0] - fit[last - 1]![0], fit[last]![1] - fit[last - 1]![1]]) }
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
function reduce(freedom: Map<string, number>, ids: readonly string[], amount: number): void {
  const unique = [...new Set(ids)];
  let remaining = amount;
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    const active = unique.filter((id) => (freedom.get(id) ?? 0) > 0);
    if (active.length === 0) return;
    const base = Math.floor(remaining / active.length);
    let extra = remaining % active.length;
    for (const id of active) {
      const want = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
      const current = freedom.get(id) ?? 0;
      const take = Math.min(current, want);
      if (take > 0) {
        freedom.set(id, current - take);
        remaining -= take;
        progress = true;
      }
    }
  }
}

function roundTo(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

function distance(left: Vec2, right: Vec2): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: distance(center, a) };
}

type LoopEdgeEntity = Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>;

function loopStart(entity: LoopEdgeEntity): Vec2 {
  return entity.kind === "spline" ? entity.fitPoints[0]! : entity.start;
}

function loopEnd(entity: LoopEdgeEntity): Vec2 {
  return entity.kind === "spline" ? entity.fitPoints[entity.fitPoints.length - 1]! : entity.end;
}

/** The entity's outline from its start to its end, with curves sampled into short straight edges. */
function loopPath(entity: LoopEdgeEntity): readonly Vec2[] {
  if (entity.kind === "arc") return sampleArc(entity.start, entity.mid, entity.end);
  if (entity.kind === "spline") return sampleSpline(entity.fitPoints);
  return [entity.start, entity.end];
}

/** Facet angle used when an arc is sampled into polygon edges (about 5.6 degrees, ~0.1% radial error). */
const ARC_FACET_RADIANS = Math.PI / 32;

/**
 * Points along a 3-point arc from `start` to `end` through `mid`, including both ends. Falls back to
 * the chord when the three points are collinear.
 */
export function sampleArc(start: Vec2, mid: Vec2, end: Vec2): readonly Vec2[] {
  const circle = circumcircle(start, mid, end);
  if (circle === undefined) return [start, end];
  const startAngle = Math.atan2(start[1] - circle.center[1], start[0] - circle.center[0]);
  const endAngle = Math.atan2(end[1] - circle.center[1], end[0] - circle.center[0]);
  const counterClockwise = cross(start, mid, end) > 0;
  const full = Math.PI * 2;
  let sweep = counterClockwise ? endAngle - startAngle : startAngle - endAngle;
  sweep = ((sweep % full) + full) % full;
  const steps = Math.min(128, Math.max(2, Math.ceil(sweep / ARC_FACET_RADIANS)));
  const points: Vec2[] = [start];
  for (let step = 1; step < steps; step += 1) {
    const angle = startAngle + (counterClockwise ? 1 : -1) * (sweep * step) / steps;
    points.push([circle.center[0] + circle.radiusMm * Math.cos(angle), circle.center[1] + circle.radiusMm * Math.sin(angle)]);
  }
  points.push(end);
  return points;
}

/**
 * Finds closed loops made of lines and 3-point arcs where every joint is shared by exactly two edges.
 * A loop of lines only keeps the exact "line-loop" boundary; a loop with an arc becomes a "curve-loop"
 * whose arcs are sampled into short edges that stay grouped under their owning entity.
 */
function detectCurveLoops(entities: readonly LoopEdgeEntity[]): readonly SketchProfile[] {
  if (entities.length < 2) return [];
  const endpoints = new Map<string, { readonly point: Vec2; readonly edgeIds: string[] }>();
  const edges = new Map(entities.map((entity) => [entity.id, { entity, startKey: pointKey(loopStart(entity)), endKey: pointKey(loopEnd(entity)) }]));
  for (const edge of edges.values()) {
    registerEndpoint(endpoints, edge.startKey, loopStart(edge.entity), edge.entity.id);
    registerEndpoint(endpoints, edge.endKey, loopEnd(edge.entity), edge.entity.id);
  }
  const unvisited = new Set(edges.keys());
  const profiles: SketchProfile[] = [];
  while (unvisited.size > 0) {
    const seed = [...unvisited].sort()[0]!;
    const componentIds: string[] = [];
    const queue = [seed];
    while (queue.length > 0) {
      const edgeId = queue.pop()!;
      if (!unvisited.delete(edgeId)) continue;
      componentIds.push(edgeId);
      const edge = edges.get(edgeId)!;
      for (const key of [edge.startKey, edge.endKey]) {
        for (const adjacent of endpoints.get(key)?.edgeIds ?? []) if (unvisited.has(adjacent)) queue.push(adjacent);
      }
    }
    const hasArc = componentIds.some((id) => edges.get(id)!.entity.kind !== "line");
    const componentKeys = new Set(componentIds.flatMap((id) => {
      const edge = edges.get(id)!;
      return [edge.startKey, edge.endKey];
    }));
    // Two edges close a loop only when one is an arc (a half-disc or lens); two lines would be degenerate.
    if (componentIds.length < (hasArc ? 2 : 3) || [...componentKeys].some((key) => endpoints.get(key)?.edgeIds.filter((id) => componentIds.includes(id)).length !== 2)) continue;
    const startKey = [...componentKeys].sort()[0]!;
    const orderedPoints: Vec2[] = [];
    const segments: SketchProfileSegment[] = [];
    let currentKey = startKey;
    let previousEdge: string | undefined;
    for (let index = 0; index < componentIds.length; index += 1) {
      const nextEdgeId = endpoints.get(currentKey)!.edgeIds.filter((id) => componentIds.includes(id) && id !== previousEdge).sort()[0];
      if (nextEdgeId === undefined) break;
      const edge = edges.get(nextEdgeId)!;
      const forward = edge.startKey === currentKey;
      const entity = edge.entity;
      let path: readonly Vec2[] = loopPath(entity);
      if (!forward) path = [...path].reverse();
      path = [endpoints.get(currentKey)!.point, ...path.slice(1)];
      // The last point is the start of the next edge, so each edge contributes all but its end.
      orderedPoints.push(...path.slice(0, -1));
      segments.push({ entityId: entity.id, kind: entity.kind, edgeCount: path.length - 1 });
      currentKey = forward ? edge.endKey : edge.startKey;
      previousEdge = nextEdgeId;
    }
    if (currentKey !== startKey || segments.length !== componentIds.length) continue;
    const signedArea = polygonSignedArea(orderedPoints);
    if (Math.abs(signedArea) < 1e-6) continue;
    const centroid = polygonCentroid(orderedPoints, signedArea);
    const entityIds = [...componentIds].sort();
    profiles.push({
      id: `profile:loop-${fnv1a(entityIds.join("|"))}`,
      entityIds,
      boundary: hasArc ? { kind: "curve-loop", points: orderedPoints, segments } : { kind: "line-loop", points: orderedPoints },
      areaMm2: Math.abs(signedArea),
      centroid
    });
  }
  return profiles;
}

function registerEndpoint(map: Map<string, { readonly point: Vec2; readonly edgeIds: string[] }>, key: string, point: Vec2, edgeId: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, { point, edgeIds: [edgeId] });
  else existing.edgeIds.push(edgeId);
}

function pointKey(point: Vec2): string {
  return `${Math.round(point[0] * 1e6)}:${Math.round(point[1] * 1e6)}`;
}

function polygonSignedArea(points: readonly Vec2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
}

function polygonCentroid(points: readonly Vec2[], signedArea: number): Vec2 {
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const factor = current[0] * next[1] - next[0] * current[1];
    x += (current[0] + next[0]) * factor;
    y += (current[1] + next[1]) * factor;
  }
  const scale = 1 / (6 * signedArea);
  return [x * scale, y * scale];
}

function profileId(entityId: string): string {
  return `profile:${entityId.startsWith("entity:") ? entityId.slice("entity:".length) : entityId}`;
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
