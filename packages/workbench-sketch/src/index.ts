import {
  failure,
  type SketchEntity,
  type Vec2,
  type WorkbenchResult,
  type WorkbenchSketch
} from "../../workbench-core/src/index.js";

export type SketchTool = "select" | "line" | "rectangle" | "circle" | "arc";

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
  if (tool === "circle" && points.length === 2) {
    const radiusMm = distance(points[0]!, points[1]!);
    if (radiusMm < 0.01) return degenerate("A circle radius must be at least 0.01 mm.");
    return { ok: true, value: { id, kind: "circle", center: points[0]!, radiusMm, construction: false } };
  }
  if (tool === "arc" && points.length === 3) {
    const area2 = Math.abs(cross(points[0]!, points[1]!, points[2]!));
    if (area2 < 1e-4) return degenerate("The three arc points must not be collinear.");
    return { ok: true, value: { id, kind: "arc", start: points[0]!, mid: points[1]!, end: points[2]!, construction: false } };
  }
  return failure("INVALID_OPERATION", `${tool} requires ${tool === "arc" ? 3 : 2} points.`, [], "Complete the required points or cancel the sketch tool.");
}

export function requiredSketchPoints(tool: SketchTool): number {
  return tool === "select" ? 0 : tool === "arc" ? 3 : 2;
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

function baseFreedom(entity: SketchEntity): number {
  if (entity.kind === "line") return 4;
  if (entity.kind === "rectangle") return 5;
  if (entity.kind === "circle") return 3;
  return 6;
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

function degenerate(message: string): WorkbenchResult<never> {
  return failure("DEGENERATE_GEOMETRY", message, [], "Choose points farther apart within the supported sketch envelope.");
}
