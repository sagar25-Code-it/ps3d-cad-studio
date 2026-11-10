import { SKETCH_ORIGIN_ID, type SketchEntity, type SketchPointRef, type Vec2 } from "../../../../../packages/workbench-core/src/index.js";

/**
 * The definition points the canvas Sketch Dimension tool offers (the blue dots), and how a pair of them becomes a dimension.
 *
 * A line offers its ends, an arc its ends and middle, a circle and an ellipse their centre and axis ends, a point itself, and a
 * rectangle its four corners, its centre and the middle of each edge. The sketch origin is always on offer. Any two points the solver can
 * move (line and arc ends, centres, points, rectangle corners and centres, the origin) can be dimensioned with a driving distance; the
 * middle of a rectangle's edge and a circle's rim point are measure-only because the solver has no handle on them.
 */
export type SketchDimensionHandle =
  | "start" | "mid" | "end" | "left" | "right" | "top" | "bottom" | "center" | "radius"
  | "corner-0" | "corner-1" | "corner-2" | "corner-3" | "origin";

export interface SketchDimensionPoint {
  readonly id: string;
  /** The curve the point belongs to, or the sketch origin. */
  readonly entityId: string;
  readonly entityKind: SketchEntity["kind"] | "origin";
  readonly handle: SketchDimensionHandle;
  readonly point: Vec2;
  readonly label: string;
}

export interface DirectSketchDimension {
  readonly label: string;
  readonly valueMm: number;
  readonly delta: Vec2;
  readonly first: SketchDimensionPoint;
  readonly second: SketchDimensionPoint;
  readonly driving?: { readonly entityId: string; readonly dimension: "length" | "width" | "height" | "radius" };
  /** Two defining points of the solver's curves: a distance between them can be driven (aligned, horizontal or vertical). */
  readonly between?: { readonly entityId: string; readonly secondEntityId: string; readonly points: readonly [SketchPointRef, SketchPointRef] };
}

/** The sketch origin as a point to dimension from. It never moves, so the other point of the pair is the one that is driven. */
export const ORIGIN_DIMENSION_POINT: SketchDimensionPoint = { id: "dimension-point:sketch:origin", entityId: SKETCH_ORIGIN_ID, entityKind: "origin", handle: "origin", point: [0, 0], label: "Sketch origin" };

const CORNER_HANDLES = ["corner-0", "corner-1", "corner-2", "corner-3"] as const;

/** A rectangle corner's position: corners run counter-clockwise from the lower left of the rectangle's own frame. */
function rectangleCorner(entity: Extract<SketchEntity, { kind: "rectangle" }>, index: number): Vec2 {
  const radians = entity.rotationDeg * Math.PI / 180;
  const sx = index === 0 || index === 3 ? -0.5 : 0.5;
  const sy = index === 0 || index === 1 ? -0.5 : 0.5;
  const x = sx * entity.widthMm;
  const y = sy * entity.heightMm;
  return [entity.center[0] + Math.cos(radians) * x - Math.sin(radians) * y, entity.center[1] + Math.sin(radians) * x + Math.cos(radians) * y];
}

export function dimensionHandles(entity: SketchEntity): readonly SketchDimensionPoint[] {
  const point = (handle: SketchDimensionHandle, value: Vec2, label: string): SketchDimensionPoint => ({ id: `dimension-point:${entity.id}:${handle}`, entityId: entity.id, entityKind: entity.kind, handle, point: value, label });
  if (entity.kind === "line") return [point("start", entity.start, "Line start"), point("end", entity.end, "Line end")];
  if (entity.kind === "rectangle") {
    const radians = entity.rotationDeg * Math.PI / 180;
    const axisX: Vec2 = [Math.cos(radians), Math.sin(radians)];
    const axisY: Vec2 = [-Math.sin(radians), Math.cos(radians)];
    const offset = (axis: Vec2, distance: number): Vec2 => [entity.center[0] + axis[0] * distance, entity.center[1] + axis[1] * distance];
    return [
      point("left", offset(axisX, -entity.widthMm / 2), "Rectangle left midpoint"),
      point("right", offset(axisX, entity.widthMm / 2), "Rectangle right midpoint"),
      point("bottom", offset(axisY, -entity.heightMm / 2), "Rectangle bottom midpoint"),
      point("top", offset(axisY, entity.heightMm / 2), "Rectangle top midpoint"),
      ...CORNER_HANDLES.map((handle, index) => point(handle, rectangleCorner(entity, index), `Rectangle corner ${index + 1}`)),
      point("center", entity.center, "Rectangle centre")
    ];
  }
  if (entity.kind === "circle") return [point("center", entity.center, "Circle center"), point("radius", [entity.center[0] + entity.radiusMm, entity.center[1]], "Circle radius point")];
  if (entity.kind === "ellipse") {
    const radians = entity.rotationDeg * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const majorEnd: Vec2 = [entity.center[0] + entity.majorRadiusMm * cos, entity.center[1] + entity.majorRadiusMm * sin];
    const minorEnd: Vec2 = [entity.center[0] - entity.minorRadiusMm * sin, entity.center[1] + entity.minorRadiusMm * cos];
    return [point("center", entity.center, "Ellipse center"), point("right", majorEnd, "Ellipse major-axis end"), point("top", minorEnd, "Ellipse minor-axis end")];
  }
  if (entity.kind === "point") return [point("center", entity.point, "Sketch point")];
  if (entity.kind === "spline") return [point("start", entity.fitPoints[0]!, "Spline start"), point("end", entity.fitPoints[entity.fitPoints.length - 1]!, "Spline end")];
  return [point("start", entity.start, "Arc start"), point("mid", entity.mid, "Arc middle"), point("end", entity.end, "Arc end")];
}

/** Every dimension point of the visible curves, then the sketch origin. */
export function allDimensionPoints(entities: readonly SketchEntity[]): readonly SketchDimensionPoint[] {
  return [...entities.flatMap(dimensionHandles), ORIGIN_DIMENSION_POINT];
}

export function defaultDimensionPoints(entity: SketchEntity): readonly SketchDimensionPoint[] {
  const handles = dimensionHandles(entity);
  if (entity.kind === "rectangle") return handles.filter((point) => point.handle === "left" || point.handle === "right");
  if (entity.kind === "arc") return handles.filter((point) => point.handle === "start" || point.handle === "end");
  return handles.slice(0, 2);
}

/** The solver's name for a canvas dimension point, or undefined when the solver cannot move that point (a rectangle's edge middle, a circle's rim). */
export function solverPointRef(point: SketchDimensionPoint): SketchPointRef | undefined {
  if (point.entityKind === "origin") return "self";
  switch (point.entityKind) {
    case "line": return point.handle === "start" || point.handle === "end" ? point.handle : point.handle === "mid" ? "mid" : undefined;
    case "arc": return point.handle === "start" || point.handle === "end" ? point.handle : point.handle === "mid" ? "mid" : undefined;
    case "circle":
    case "ellipse": return point.handle === "center" ? "center" : undefined;
    case "rectangle": return point.handle === "center" ? "center" : point.handle === "corner-0" || point.handle === "corner-1" || point.handle === "corner-2" || point.handle === "corner-3" ? point.handle : undefined;
    case "point": return "self";
    default: return undefined;
  }
}

export function resolveDirectSketchDimension(points: readonly SketchDimensionPoint[]): DirectSketchDimension | undefined {
  if (points.length !== 2 || points[0]!.id === points[1]!.id) return undefined;
  const [first, second] = points as readonly [SketchDimensionPoint, SketchDimensionPoint];
  const delta: Vec2 = [second.point[0] - first.point[0], second.point[1] - first.point[1]];
  const valueMm = Math.hypot(delta[0], delta[1]);
  let driving: DirectSketchDimension["driving"];
  let label = "Reference distance";
  if (first.entityId === second.entityId && first.entityKind !== "origin") {
    const handles = new Set([first.handle, second.handle]);
    const pair = (a: SketchDimensionHandle, b: SketchDimensionHandle): boolean => handles.has(a) && handles.has(b);
    if (first.entityKind === "line" && pair("start", "end")) { driving = { entityId: first.entityId, dimension: "length" }; label = "Line length"; }
    else if (first.entityKind === "rectangle" && (pair("left", "right") || pair("corner-0", "corner-1") || pair("corner-3", "corner-2"))) { driving = { entityId: first.entityId, dimension: "width" }; label = "Rectangle width"; }
    else if (first.entityKind === "rectangle" && (pair("top", "bottom") || pair("corner-1", "corner-2") || pair("corner-0", "corner-3"))) { driving = { entityId: first.entityId, dimension: "height" }; label = "Rectangle height"; }
    else if (first.entityKind === "circle" && pair("center", "radius")) { driving = { entityId: first.entityId, dimension: "radius" }; label = "Circle radius"; }
  }
  // Any two defining points the solver can move: the distance between them can be driven.
  const firstRef = driving === undefined ? solverPointRef(first) : undefined;
  const secondRef = driving === undefined ? solverPointRef(second) : undefined;
  // Two origins, or a point and itself, measure nothing a solver could hold.
  const between = firstRef !== undefined && secondRef !== undefined && !(first.entityKind === "origin" && second.entityKind === "origin")
    ? { entityId: first.entityId, secondEntityId: second.entityId, points: [firstRef, secondRef] as const }
    : undefined;
  return { label, valueMm, delta, first, second, ...(driving === undefined ? {} : { driving }), ...(between === undefined ? {} : { between }) };
}
