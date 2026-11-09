import { failure, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { sketchPointsProblem } from "./entity-limits.js";
import type { ShapeIds, SketchShape } from "./shapes.js";

/**
 * A regular polygon that stays regular. The sides are lines joined end to end; a construction circle holds the centre, every
 * corner sits on that circle, and every side equals the first. That is the whole definition of a regular polygon, and it leaves four
 * degrees of freedom (the centre, the size, the turn): one size dimension on the polygon takes it to three, and the polygon keeps
 * its shape when that dimension, or the length of any one side, is edited or when a corner is dragged.
 *
 * Three ways to size it at the first placement:
 * - inscribed: the corners lie on the circle you click (centre, then a corner), so the circle's radius is the corner radius;
 * - circumscribed: the sides touch the circle you click (centre, then the middle of a side), so the apothem is the clicked distance;
 * - edge: the two clicks are the ends of one side, and the polygon grows on the left of it.
 */
export const POLYGON_MIN_SIDES = 3;
export const POLYGON_MAX_SIDES = 64;
export const POLYGON_DEFAULT_SIDES = 6;

export type PolygonMode = "inscribed" | "circumscribed" | "edge";
export const POLYGON_MODES: readonly PolygonMode[] = ["inscribed", "circumscribed", "edge"];

/** The one dimension that sizes a regular polygon in its mode, ready for `set-sketch-dimension`. */
export interface ShapeSizeDimension {
  readonly dimension: "radius" | "length" | "point-line";
  readonly entityId: string;
  readonly secondEntityId?: string;
  readonly points?: readonly SketchPointRef[];
  readonly valueMm: number;
}

export type RegularPolygonShape = SketchShape & { readonly sizeDimension: ShapeSizeDimension; readonly mode: PolygonMode };

const bad = (message: string): WorkbenchResult<RegularPolygonShape> => failure("INVALID_OPERATION", message, [], "Place the points somewhere else, or press Esc to start over.");

/** Rounds away floating-point dust (a cosine that should be zero) without changing any real coordinate. */
const clean = (value: number): number => Math.round(value * 1e9) / 1e9 + 0;

function checkSides(sides: number): WorkbenchResult<RegularPolygonShape> | undefined {
  if (!Number.isInteger(sides) || sides < POLYGON_MIN_SIDES || sides > POLYGON_MAX_SIDES) return bad(`A polygon needs between ${POLYGON_MIN_SIDES} and ${POLYGON_MAX_SIDES} sides.`);
  return undefined;
}

/** Regular polygon from its centre and one point: a corner (inscribed) or the middle of a side (circumscribed). */
export function buildPolygon(center: Vec2, point: Vec2, sides: number, ids: ShapeIds, mode: Exclude<PolygonMode, "edge"> = "inscribed"): WorkbenchResult<RegularPolygonShape> {
  const invalid = checkSides(sides);
  if (invalid !== undefined) return invalid;
  const unusable = sketchPointsProblem([center, point]);
  if (unusable !== undefined) return bad(unusable);
  const reach = Math.hypot(point[0] - center[0], point[1] - center[1]);
  if (reach < 0.1) return bad(mode === "circumscribed" ? "A polygon needs an apothem of at least 0.1 mm." : "A polygon needs a radius of at least 0.1 mm.");
  const heading = Math.atan2(point[1] - center[1], point[0] - center[0]);
  const circumradius = mode === "circumscribed" ? reach / Math.cos(Math.PI / sides) : reach;
  // The first corner is the click itself when inscribed; half a turn before the clicked side's middle when circumscribed.
  const turn = mode === "circumscribed" ? heading - Math.PI / sides : heading;
  return assemble(center, circumradius, turn, sides, mode, ids);
}

/** Regular polygon on one side: the two points are the ends of the first side, and the polygon grows on the left of the way they point. */
export function buildEdgePolygon(edgeStart: Vec2, edgeEnd: Vec2, sides: number, ids: ShapeIds): WorkbenchResult<RegularPolygonShape> {
  const invalid = checkSides(sides);
  if (invalid !== undefined) return invalid;
  const unusable = sketchPointsProblem([edgeStart, edgeEnd]);
  if (unusable !== undefined) return bad(unusable);
  const dx = edgeEnd[0] - edgeStart[0];
  const dy = edgeEnd[1] - edgeStart[1];
  const side = Math.hypot(dx, dy);
  if (side < 0.01) return bad("A polygon's sides must be at least 0.01 mm long.");
  const circumradius = side / (2 * Math.sin(Math.PI / sides));
  const apothem = side / (2 * Math.tan(Math.PI / sides));
  const center: Vec2 = [(edgeStart[0] + edgeEnd[0]) / 2 - (dy / side) * apothem, (edgeStart[1] + edgeEnd[1]) / 2 + (dx / side) * apothem];
  return assemble(center, circumradius, Math.atan2(edgeStart[1] - center[1], edgeStart[0] - center[0]), sides, "edge", ids, edgeStart);
}

function assemble(center: Vec2, circumradius: number, turn: number, sides: number, mode: PolygonMode, ids: ShapeIds, firstCorner?: Vec2): WorkbenchResult<RegularPolygonShape> {
  const sideLength = 2 * circumradius * Math.sin(Math.PI / sides);
  if (sideLength < 0.01) return bad("The polygon's sides would be shorter than 0.01 mm.");
  const vertices = Array.from({ length: sides }, (_, index): Vec2 => {
    if (index === 0 && firstCorner !== undefined) return [firstCorner[0], firstCorner[1]];
    const angle = turn + (index * 2 * Math.PI) / sides;
    return [clean(center[0] + circumradius * Math.cos(angle)), clean(center[1] + circumradius * Math.sin(angle))];
  });
  const lines = vertices.map((start, index): SketchEntity => ({ id: ids.entity(), kind: "line", start, end: vertices[(index + 1) % sides]!, construction: false }));
  const guide: SketchEntity = { id: ids.entity(), kind: "circle", center: [clean(center[0]), clean(center[1])], radiusMm: clean(circumradius), construction: true };
  const constraints: WorkbenchSketchConstraint[] = [];
  lines.forEach((line, index) => {
    const next = lines[(index + 1) % sides]!;
    // Each side ends where the next one starts, and its start is a corner on the guide circle.
    constraints.push({ id: ids.constraint(), kind: "coincident", entityIds: [line.id, next.id], points: ["end", "start"] });
    constraints.push({ id: ids.constraint(), kind: "coincident", entityIds: [line.id, guide.id], points: ["start", "curve"] });
    // Every side is as long as the first: with the corners on one circle that makes the polygon regular.
    if (index > 0) constraints.push({ id: ids.constraint(), kind: "equal", entityIds: [lines[0]!.id, line.id] });
  });
  const first = lines[0]!;
  const sizeDimension: ShapeSizeDimension = mode === "inscribed"
    ? { dimension: "radius", entityId: guide.id, valueMm: clean(circumradius) }
    : mode === "circumscribed"
      ? { dimension: "point-line", entityId: guide.id, secondEntityId: first.id, points: ["center"], valueMm: clean(circumradius * Math.cos(Math.PI / sides)) }
      : { dimension: "length", entityId: first.id, valueMm: clean(sideLength) };
  return { ok: true, value: { entities: [...lines, guide], constraints, sizeDimension, mode } };
}
