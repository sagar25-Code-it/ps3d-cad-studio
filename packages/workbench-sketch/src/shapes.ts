import { failure, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";

/**
 * Tools that place a whole parametric shape rather than one entity: a regular polygon (lines joined end to end with equal
 * sides) and a center-to-center slot (two lines and two end arcs held tangent). The shape is returned as entities plus the
 * relations that keep it what it is, ready to be added in one edit.
 */
export interface SketchShape {
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

export const POLYGON_MIN_SIDES = 3;
export const POLYGON_MAX_SIDES = 64;
export const POLYGON_DEFAULT_SIDES = 6;

const bad = (message: string): WorkbenchResult<SketchShape> => failure("INVALID_OPERATION", message, [], "Place the points somewhere else, or press Esc to start over.");

export interface ShapeIds {
  readonly entity: () => string;
  readonly constraint: () => string;
}

/** Regular polygon from its centre and one corner (which sets the size and the turn). */
export function buildPolygon(center: Vec2, corner: Vec2, sides: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (!Number.isInteger(sides) || sides < POLYGON_MIN_SIDES || sides > POLYGON_MAX_SIDES) return bad(`A polygon needs between ${POLYGON_MIN_SIDES} and ${POLYGON_MAX_SIDES} sides.`);
  const radius = Math.hypot(corner[0] - center[0], corner[1] - center[1]);
  if (radius < 0.1) return bad("A polygon needs a radius of at least 0.1 mm.");
  const turn = Math.atan2(corner[1] - center[1], corner[0] - center[0]);
  const vertices = Array.from({ length: sides }, (_, index): Vec2 => {
    const angle = turn + (index * 2 * Math.PI) / sides;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
  const sideLength = 2 * radius * Math.sin(Math.PI / sides);
  if (sideLength < 0.01) return bad("The polygon's sides would be shorter than 0.01 mm.");
  const entities: SketchEntity[] = vertices.map((start, index): SketchEntity => ({
    id: ids.entity(),
    kind: "line",
    start,
    end: vertices[(index + 1) % sides]!,
    construction: false
  }));
  const constraints: WorkbenchSketchConstraint[] = [];
  entities.forEach((entity, index) => {
    const next = entities[(index + 1) % sides]!;
    // Each side ends where the next one starts.
    constraints.push({ id: ids.constraint(), kind: "coincident", entityIds: [entity.id, next.id], points: ["end", "start"] });
    // Every side is as long as the first, which keeps the polygon regular when one is resized.
    if (index > 0) constraints.push({ id: ids.constraint(), kind: "equal", entityIds: [entities[0]!.id, entity.id] });
  });
  return { ok: true, value: { entities, constraints } };
}

/**
 * Straight (overall) slot: the user clicks the two OUTER endpoints (the outermost points of the two caps) and a width
 * point. The slot's end-to-end length is the distance between the two clicks, and must be larger than the width so
 * there is still a straight portion between the caps. The result reuses buildSlot after pulling the cap centres inward
 * by the cap radius.
 */
export function buildSlotOverall(firstEnd: Vec2, secondEnd: Vec2, widthPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const axis: Vec2 = [secondEnd[0] - firstEnd[0], secondEnd[1] - firstEnd[1]];
  const overall = Math.hypot(axis[0], axis[1]);
  if (overall < 0.1) return bad("The slot's end-to-end length must be at least 0.1 mm.");
  const direction: Vec2 = [axis[0] / overall, axis[1] / overall];
  const normal: Vec2 = [-direction[1], direction[0]];
  const half = Math.abs((widthPoint[0] - firstEnd[0]) * normal[0] + (widthPoint[1] - firstEnd[1]) * normal[1]);
  if (half < 0.05) return bad("The slot width must be at least 0.1 mm: place the third point away from the line between the ends.");
  if (overall < 2 * half + 0.05) return bad("The slot's end-to-end length must be more than its width: pick ends farther apart or a smaller width.");
  const firstCenter: Vec2 = [firstEnd[0] + direction[0] * half, firstEnd[1] + direction[1] * half];
  const secondCenter: Vec2 = [secondEnd[0] - direction[0] * half, secondEnd[1] - direction[1] * half];
  return buildSlot(firstCenter, secondCenter, widthPoint, ids);
}

/** Center-to-center slot: the two end centres, then a point whose distance from the axis is the half-width. */
export function buildSlot(first: Vec2, second: Vec2, widthPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const axis: Vec2 = [second[0] - first[0], second[1] - first[1]];
  const length = Math.hypot(axis[0], axis[1]);
  if (length < 0.05) return bad("The two slot centres must be at least 0.05 mm apart.");
  const direction: Vec2 = [axis[0] / length, axis[1] / length];
  const normal: Vec2 = [-direction[1], direction[0]];
  const half = Math.abs((widthPoint[0] - first[0]) * normal[0] + (widthPoint[1] - first[1]) * normal[1]);
  if (half < 0.05) return bad("The slot width must be at least 0.1 mm: place the third point away from the line between the centres.");
  const at = (centre: Vec2, along: number, across: number): Vec2 => [centre[0] + direction[0] * along + normal[0] * across, centre[1] + direction[1] * along + normal[1] * across];
  const top: SketchEntity = { id: ids.entity(), kind: "line", start: at(first, 0, half), end: at(second, 0, half), construction: false };
  const endCap: SketchEntity = { id: ids.entity(), kind: "arc", start: at(second, 0, half), mid: at(second, half, 0), end: at(second, 0, -half), construction: false };
  const bottom: SketchEntity = { id: ids.entity(), kind: "line", start: at(second, 0, -half), end: at(first, 0, -half), construction: false };
  const startCap: SketchEntity = { id: ids.entity(), kind: "arc", start: at(first, 0, -half), mid: at(first, -half, 0), end: at(first, 0, half), construction: false };
  const constraints: WorkbenchSketchConstraint[] = [
    // The loop stays closed: every side ends where the next cap starts, so a length edit moves the caps with the sides.
    { id: ids.constraint(), kind: "coincident", entityIds: [top.id, endCap.id], points: ["end", "start"] },
    { id: ids.constraint(), kind: "coincident", entityIds: [endCap.id, bottom.id], points: ["end", "start"] },
    { id: ids.constraint(), kind: "coincident", entityIds: [bottom.id, startCap.id], points: ["end", "start"] },
    { id: ids.constraint(), kind: "coincident", entityIds: [startCap.id, top.id], points: ["end", "start"] },
    // The sides touch the caps without a kink, and both caps have the same radius.
    { id: ids.constraint(), kind: "tangent", entityIds: [top.id, endCap.id] },
    { id: ids.constraint(), kind: "tangent", entityIds: [bottom.id, endCap.id] },
    { id: ids.constraint(), kind: "tangent", entityIds: [bottom.id, startCap.id] },
    { id: ids.constraint(), kind: "tangent", entityIds: [top.id, startCap.id] },
    { id: ids.constraint(), kind: "equal", entityIds: [endCap.id, startCap.id] }
  ];
  return { ok: true, value: { entities: [top, endCap, bottom, startCap], constraints } };
}
