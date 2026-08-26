import {
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
  | "arc";

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
      readonly kind: "line-loop";
      readonly points: readonly Vec2[];
    };

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
      if (entities.length !== 2 || entities.some((entity) => entity?.kind !== "circle")) conflicts.push(`${constraint.id} requires two circles.`);
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

export function snapSketchPoint(point: Vec2, sketch: WorkbenchSketch): SnapResult {
  let closest: { id: string; point: Vec2; distance: number } | undefined;
  for (const entity of sketch.entities) {
    for (const candidate of entityPoints(entity)) {
      const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1]);
      if (distance <= sketch.snapToleranceMm && (closest === undefined || distance < closest.distance)) closest = { id: entity.id, point: candidate, distance };
    }
  }
  if (closest !== undefined) return { point: closest.point, snapped: true, kind: "endpoint", targetId: closest.id };
  const gridPoint: Vec2 = [roundTo(point[0], sketch.gridMm), roundTo(point[1], sketch.gridMm)];
  const gridDistance = Math.hypot(gridPoint[0] - point[0], gridPoint[1] - point[1]);
  return gridDistance <= sketch.snapToleranceMm
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
  if (tool === "arc" && points.length === 3) {
    const area2 = Math.abs(cross(points[0]!, points[1]!, points[2]!));
    if (area2 < 1e-4) return degenerate("The three arc points must not be collinear.");
    return { ok: true, value: { id, kind: "arc", start: points[0]!, mid: points[1]!, end: points[2]!, construction: false } };
  }
  return failure("INVALID_OPERATION", `${sketchToolLabel(tool)} requires ${requiredSketchPoints(tool)} points.`, [], "Complete the required points or cancel the sketch tool.");
}

export function requiredSketchPoints(tool: SketchTool): number {
  return tool === "select" ? 0 : tool === "arc" || tool === "rectangle-three-point" || tool === "circle-three-point" ? 3 : 2;
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
    arc: "3-point arc"
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
  for (const entity of sketch.entities) {
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
  }
  profiles.push(...detectLineLoops(sketch.entities.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line" && !entity.construction)));
  return profiles.sort((left, right) => right.areaMm2 - left.areaMm2 || left.id.localeCompare(right.id));
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
    return failure("INVALID_OPERATION", "Select exactly one closed rectangle profile for the qualified base extrusion.", selectedProfileIds, "Click inside one shaded rectangle region, then select its concentric circle with Shift.");
  }
  const outer = rectangles[0]!;
  if (outer.boundary.kind !== "rectangle") throw new TypeError("Profile filter invariant failed.");
  if (Math.abs(normalizeRotation(outer.boundary.rotationDeg)) > 1e-6) {
    return failure("UNSUPPORTED_CAPABILITY", "The qualified solid evaluator currently accepts an axis-aligned rectangle only.", outer.entityIds, "Use a 2-point or center rectangle aligned to the sketch axes.");
  }
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
      widthMm: outer.boundary.widthMm,
      heightMm: outer.boundary.heightMm,
      holeDiameterMm,
      distanceMm
    }
  };
}

export function sketchBounds(entities: readonly SketchEntity[]): SketchAnalysis["boundsMm"] {
  const points = entities.flatMap(entityPoints);
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
    return [
      [entity.center[0] - halfWidth, entity.center[1] - halfHeight],
      [entity.center[0] + halfWidth, entity.center[1] - halfHeight],
      [entity.center[0] + halfWidth, entity.center[1] + halfHeight],
      [entity.center[0] - halfWidth, entity.center[1] + halfHeight]
    ];
  }
  if (entity.kind === "circle") return [entity.center, [entity.center[0] + entity.radiusMm, entity.center[1]]];
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
  return endpoints.filter((point, index) => endpoints.filter((candidate, candidateIndex) => candidateIndex !== index && distance(point, candidate) <= toleranceMm).length > 2).length;
}

function baseFreedom(entity: SketchEntity): number {
  if (entity.kind === "line") return 4;
  if (entity.kind === "rectangle") return 5;
  if (entity.kind === "circle") return 3;
  return 6;
}

function curveEndpoints(entity: SketchEntity): readonly Vec2[] {
  if (entity.kind === "line" || entity.kind === "arc") return [entity.start, entity.end];
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
  return [];
}

function normalize2(value: Vec2): Vec2 {
  const length = Math.hypot(...value);
  return length < 1e-12 ? [0, 0] : [value[0] / length, value[1] / length];
}

function reduce(freedom: Map<string, number>, ids: readonly string[], amount: number): void {
  let remaining = amount;
  for (const id of ids) {
    const current = freedom.get(id) ?? 0;
    const reduction = Math.min(current, remaining);
    freedom.set(id, current - reduction);
    remaining -= reduction;
    if (remaining === 0) break;
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

function detectLineLoops(lines: readonly Extract<SketchEntity, { kind: "line" }>[]): readonly SketchProfile[] {
  if (lines.length < 3) return [];
  const endpoints = new Map<string, { readonly point: Vec2; readonly edgeIds: string[] }>();
  const edges = new Map(lines.map((line) => [line.id, { line, startKey: pointKey(line.start), endKey: pointKey(line.end) }]));
  for (const edge of edges.values()) {
    registerEndpoint(endpoints, edge.startKey, edge.line.start, edge.line.id);
    registerEndpoint(endpoints, edge.endKey, edge.line.end, edge.line.id);
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
    const componentKeys = new Set(componentIds.flatMap((id) => {
      const edge = edges.get(id)!;
      return [edge.startKey, edge.endKey];
    }));
    if (componentIds.length < 3 || [...componentKeys].some((key) => endpoints.get(key)?.edgeIds.filter((id) => componentIds.includes(id)).length !== 2)) continue;
    const startKey = [...componentKeys].sort()[0]!;
    const orderedPoints: Vec2[] = [];
    let currentKey = startKey;
    let previousEdge: string | undefined;
    for (let index = 0; index < componentIds.length; index += 1) {
      orderedPoints.push(endpoints.get(currentKey)!.point);
      const nextEdgeId = endpoints.get(currentKey)!.edgeIds.filter((id) => componentIds.includes(id) && id !== previousEdge).sort()[0];
      if (nextEdgeId === undefined) break;
      const edge = edges.get(nextEdgeId)!;
      currentKey = edge.startKey === currentKey ? edge.endKey : edge.startKey;
      previousEdge = nextEdgeId;
    }
    if (currentKey !== startKey || orderedPoints.length !== componentIds.length) continue;
    const signedArea = polygonSignedArea(orderedPoints);
    if (Math.abs(signedArea) < 1e-6) continue;
    const centroid = polygonCentroid(orderedPoints, signedArea);
    const entityIds = [...componentIds].sort();
    profiles.push({
      id: `profile:loop-${fnv1a(entityIds.join("|"))}`,
      entityIds,
      boundary: { kind: "line-loop", points: orderedPoints },
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
