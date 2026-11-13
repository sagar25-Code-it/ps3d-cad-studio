import { sketchPointsProblem } from "./entity-limits.js";
import { failure, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";

/**
 * Tools that place a whole parametric shape rather than one entity: a regular polygon (lines joined end to end with equal
 * sides) and a center-to-center slot (two lines and two end arcs held tangent, with a construction centreline between the cap
 * centres). The shape is returned as entities plus the relations that keep it what it is, ready to be added in one edit.
 */
export interface SketchShape {
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

export { POLYGON_DEFAULT_SIDES, POLYGON_MAX_SIDES, POLYGON_MIN_SIDES, POLYGON_MODES, buildEdgePolygon, buildPolygon, type PolygonMode, type RegularPolygonShape, type ShapeSizeDimension } from "./regular-polygon.js";

const bad = (message: string): WorkbenchResult<SketchShape> => failure("INVALID_OPERATION", message, [], "Place the points somewhere else, or press Esc to start over.");

export interface ShapeIds {
  readonly entity: () => string;
  readonly constraint: () => string;
}

/**
 * Coincident joints that close a ring of curves: the end of each piece sits on the start of the next, the last on the first.
 * Lines and arcs are both joined by their real ends, so the simultaneous solver moves an arc end with the line it touches and
 * the outline stays one closed profile when a side is edited or dragged.
 */
export function joinRing(ring: readonly SketchEntity[], ids: ShapeIds): WorkbenchSketchConstraint[] {
  return ring.map((entity, index): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: "coincident", entityIds: [entity.id, ring[(index + 1) % ring.length]!.id], points: ["end", "start"] }));
}


/**
 * Straight (overall) slot: the user clicks the two OUTER endpoints (the outermost points of the two caps) and a width
 * point. The slot's end-to-end length is the distance between the two clicks, and must be larger than the width so
 * there is still a straight portion between the caps. The result reuses buildSlot after pulling the cap centres inward
 * by the cap radius.
 */
export function buildSlotOverall(firstEnd: Vec2, secondEnd: Vec2, widthPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const unusable = sketchPointsProblem([firstEnd, secondEnd, widthPoint]);
  if (unusable !== undefined) return bad(unusable);
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

/**
 * Center-to-center slot: the two end centres, then a point whose distance from the axis is the half-width. Besides the outline it
 * has a construction centreline whose ends are held on the two cap centres. The centreline is what the slot is dimensioned and
 * placed by: its length is the centre distance, its middle is the slot's centre (for Midpoint or Symmetric), and it can be made
 * Horizontal, Vertical or Parallel to turn the slot. It never bounds a profile.
 */
export function buildSlot(first: Vec2, second: Vec2, widthPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const unusable = sketchPointsProblem([first, second, widthPoint]);
  if (unusable !== undefined) return bad(unusable);
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
    // Every side ends where the next cap begins, so a side edited or dragged takes the cap with it.
    ...joinRing([top, endCap, bottom, startCap], ids),
    // The sides touch the caps without a kink, and both caps have the same radius.
    { id: ids.constraint(), kind: "tangent", entityIds: [top.id, endCap.id] },
    { id: ids.constraint(), kind: "tangent", entityIds: [bottom.id, endCap.id] },
    { id: ids.constraint(), kind: "tangent", entityIds: [bottom.id, startCap.id] },
    { id: ids.constraint(), kind: "tangent", entityIds: [top.id, startCap.id] },
    { id: ids.constraint(), kind: "equal", entityIds: [endCap.id, startCap.id] }
  ];
  // The centreline: listed after the outline so the outline's own order (top, end cap, bottom, start cap) is unchanged.
  const centreline: SketchEntity = { id: ids.entity(), kind: "line", start: first, end: second, construction: true };
  constraints.push(
    { id: ids.constraint(), kind: "coincident", entityIds: [centreline.id, startCap.id], points: ["start", "center"] },
    { id: ids.constraint(), kind: "coincident", entityIds: [centreline.id, endCap.id], points: ["end", "center"] }
  );
  return { ok: true, value: { entities: [top, endCap, bottom, startCap, centreline], constraints } };
}
