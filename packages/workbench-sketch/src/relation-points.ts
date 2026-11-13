import { SKETCH_ORIGIN_ID, SOLVABLE_POINT_REFS, type SketchEntity, type SketchPointRef, type Vec2 } from "../../workbench-core/src/index.js";
import { entityPoints } from "./index.js";

/** A point of a curve that the canvas offers when a Coincident or Midpoint relation is being picked. */
export interface RelationPoint {
  readonly id: string;
  readonly entityId: string;
  readonly ref: SketchPointRef;
  readonly point: Vec2;
  readonly label: string;
}

/** The sketch origin as a point to pick: a hole centre can be put level with it, or a point joined to it. */
export const ORIGIN_RELATION_POINT: RelationPoint = { id: `relation-point:${SKETCH_ORIGIN_ID}:self`, entityId: SKETCH_ORIGIN_ID, ref: "self", point: [0, 0], label: "Sketch origin" };

function centreOf(start: Vec2, mid: Vec2, end: Vec2): Vec2 | undefined {
  const d = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = start[0] ** 2 + start[1] ** 2;
  const b2 = mid[0] ** 2 + mid[1] ** 2;
  const c2 = end[0] ** 2 + end[1] ** 2;
  return [(a2 * (mid[1] - end[1]) + b2 * (end[1] - start[1]) + c2 * (start[1] - mid[1])) / d, (a2 * (end[0] - mid[0]) + b2 * (start[0] - end[0]) + c2 * (mid[0] - start[0])) / d];
}

const CORNER_NAMES = ["lower left", "lower right", "upper right", "upper left"] as const;

/**
 * Every point of the entity the live solver can move, with where it is: a line's ends and middle, a circle's, ellipse's, arc's and
 * rectangle's centre, an arc's ends and middle, a rectangle's four corners, a sketch point. These are the points the Coincident and
 * Midpoint pickers on the canvas offer; the list follows SOLVABLE_POINT_REFS, so a point the solver gained is offered here too.
 */
export function relationPointsOf(entity: SketchEntity): readonly RelationPoint[] {
  const make = (ref: SketchPointRef, point: Vec2, label: string): RelationPoint => ({ id: `relation-point:${entity.id}:${ref}`, entityId: entity.id, ref, point, label });
  const offered = SOLVABLE_POINT_REFS[entity.kind];
  const found: RelationPoint[] = [];
  const add = (ref: SketchPointRef, point: Vec2 | undefined, label: string): void => { if (point !== undefined && offered.includes(ref)) found.push(make(ref, point, label)); };
  switch (entity.kind) {
    case "line":
      add("start", entity.start, "Line start");
      add("end", entity.end, "Line end");
      add("mid", [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], "Line midpoint");
      break;
    case "circle":
      add("center", entity.center, "Circle center");
      break;
    case "ellipse":
      add("center", entity.center, "Ellipse center");
      break;
    case "arc":
      add("start", entity.start, "Arc start");
      add("end", entity.end, "Arc end");
      add("mid", entity.mid, "Arc midpoint");
      add("center", centreOf(entity.start, entity.mid, entity.end), "Arc center");
      break;
    case "rectangle": {
      add("center", entity.center, "Rectangle center");
      const corners = entityPoints(entity);
      (["corner-0", "corner-1", "corner-2", "corner-3"] as const).forEach((ref, index) => add(ref, corners[index], `Rectangle corner ${index + 1} (${CORNER_NAMES[index]})`));
      break;
    }
    case "point":
      add("self", entity.point, "Sketch point");
      break;
    default:
      break;
  }
  return found;
}
