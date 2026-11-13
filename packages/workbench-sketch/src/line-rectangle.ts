import { sketchPointsProblem } from "./entity-limits.js";
import { failure, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { ShapeIds, SketchShape } from "./shapes.js";

/**
 * The rectangle tools draw four ordinary lines, not one rectangle entity. Each side can then be selected, deleted, trimmed, made
 * tangent to, used for a point-on-curve relation or measured to like any other line, without the rectangle having to be taken apart first.
 *
 * What holds the four lines together as a rectangle:
 *  - every side ends where the next one starts (four Coincident joints);
 *  - corner to corner and from the centre: the first and third sides are Horizontal, the second and fourth Vertical;
 *  - from three points (drawn at its own angle): each side is Perpendicular to the next;
 *  - from the centre: two construction diagonals joined to the corners, so the centre is the middle of a diagonal and a Midpoint
 *    relation can hold it on a point.
 *
 * The sides are returned in a fixed order: [first side, second side, third side, fourth side, (diagonal, diagonal)]. The first side carries
 * the width, the second the height. A rectangle entity in a saved sketch is untouched by this and keeps loading and solving as before.
 */
export type LineRectangleTool = "rectangle" | "rectangle-center" | "rectangle-three-point";

export function isLineRectangleTool(tool: string): tool is LineRectangleTool {
  return tool === "rectangle" || tool === "rectangle-center" || tool === "rectangle-three-point";
}

const bad = (message: string): WorkbenchResult<SketchShape> => failure("INVALID_OPERATION", message, [], "Place the points somewhere else, or press Esc to start over.");
const clean = (value: number): number => Number(value.toFixed(9));
const MIN_SIDE_MM = 0.01;

function ring(corners: readonly [Vec2, Vec2, Vec2, Vec2], ids: ShapeIds): { readonly sides: readonly SketchEntity[]; readonly joints: readonly WorkbenchSketchConstraint[] } {
  const sides = corners.map((corner, index): SketchEntity => ({ id: ids.entity(), kind: "line", start: corner, end: corners[(index + 1) % 4]!, construction: false }));
  const joints = sides.map((side, index): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: "coincident", entityIds: [side.id, sides[(index + 1) % 4]!.id], points: ["end", "start"] }));
  return { sides, joints };
}

function level(corners: readonly [Vec2, Vec2, Vec2, Vec2], ids: ShapeIds): SketchShape {
  const { sides, joints } = ring(corners, ids);
  const square = sides.map((side, index): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: index % 2 === 0 ? "horizontal" : "vertical", entityIds: [side.id] }));
  return { entities: sides, constraints: [...joints, ...square] };
}

/** The four lines (and, from the centre, the two construction diagonals) a rectangle tool draws from its clicks, with the relations that keep them a rectangle. */
export function buildLineRectangle(tool: LineRectangleTool, points: readonly Vec2[], ids: ShapeIds): WorkbenchResult<SketchShape> {
  const unusable = sketchPointsProblem(points);
  if (unusable !== undefined) return bad(unusable);
  if (tool === "rectangle-three-point") {
    const [first, second, third] = points;
    if (first === undefined || second === undefined || third === undefined) return bad("A 3-point rectangle takes three points.");
    const edge: Vec2 = [second[0] - first[0], second[1] - first[1]];
    const width = Math.hypot(edge[0], edge[1]);
    if (width < MIN_SIDE_MM) return bad("The first edge of a 3-point rectangle must be at least 0.01 mm long.");
    const normal: Vec2 = [-edge[1] / width, edge[0] / width];
    const signedHeight = (third[0] - second[0]) * normal[0] + (third[1] - second[1]) * normal[1];
    if (Math.abs(signedHeight) < MIN_SIDE_MM) return bad("The third point must define a non-zero rectangle height.");
    const offset: Vec2 = [normal[0] * signedHeight, normal[1] * signedHeight];
    const corners: readonly [Vec2, Vec2, Vec2, Vec2] = [first, second, [clean(second[0] + offset[0]), clean(second[1] + offset[1])], [clean(first[0] + offset[0]), clean(first[1] + offset[1])]];
    const { sides, joints } = ring(corners, ids);
    const square = [0, 1, 2].map((index): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: "perpendicular", entityIds: [sides[index]!.id, sides[index + 1]!.id] }));
    return { ok: true, value: { entities: sides, constraints: [...joints, ...square] } };
  }
  const [first, second] = points;
  if (first === undefined || second === undefined) return bad("A rectangle takes two points.");
  const centred = tool === "rectangle-center";
  const halfX = Math.abs(second[0] - first[0]);
  const halfY = Math.abs(second[1] - first[1]);
  const x0 = centred ? clean(first[0] - halfX) : Math.min(first[0], second[0]);
  const x1 = centred ? clean(first[0] + halfX) : Math.max(first[0], second[0]);
  const y0 = centred ? clean(first[1] - halfY) : Math.min(first[1], second[1]);
  const y1 = centred ? clean(first[1] + halfY) : Math.max(first[1], second[1]);
  if (x1 - x0 < MIN_SIDE_MM || y1 - y0 < MIN_SIDE_MM) return bad(centred ? "A center rectangle needs a center and a non-zero corner offset." : "A rectangle needs non-zero width and height.");
  const shape = level([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], ids);
  if (!centred) return { ok: true, value: shape };
  const [bottom, right, top, left] = shape.entities as readonly [SketchEntity, SketchEntity, SketchEntity, SketchEntity];
  const rising: SketchEntity = { id: ids.entity(), kind: "line", start: [x0, y0], end: [x1, y1], construction: true };
  const falling: SketchEntity = { id: ids.entity(), kind: "line", start: [x0, y1], end: [x1, y0], construction: true };
  const join = (a: SketchEntity, aRef: "start" | "end", b: SketchEntity, bRef: "start" | "end"): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: "coincident", entityIds: [a.id, b.id], points: [aRef, bRef] });
  const diagonalJoints = [join(rising, "start", bottom, "start"), join(rising, "end", top, "start"), join(falling, "start", left, "start"), join(falling, "end", right, "start")];
  return { ok: true, value: { entities: [...shape.entities, rising, falling], constraints: [...shape.constraints, ...diagonalJoints] } };
}

/** The side that carries the rectangle's width (its first side) and the one that carries its height (its second side). */
export function lineRectangleSizeSides(shape: SketchShape): { readonly width: SketchEntity | undefined; readonly height: SketchEntity | undefined } {
  return { width: shape.entities[0], height: shape.entities[1] };
}

/** The construction diagonal whose middle is the centre of a centre rectangle, if the shape has one. */
export function lineRectangleCentreDiagonal(shape: SketchShape): SketchEntity | undefined {
  return shape.entities.find((entity) => entity.kind === "line" && entity.construction);
}
