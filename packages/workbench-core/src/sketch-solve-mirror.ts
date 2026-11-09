import type { SketchEntity, Vec2, WorkbenchSketchConstraint } from "./types.js";
import { SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID } from "./types.js";

/**
 * The parts of a Symmetric relation that the analytic solver does not carry: the image of a spline follows its source point by point,
 * and the image of an ellipse turns the mirrored way (its centre and size are solved with the other relations). Both run on the
 * geometry the analytic pass produced, like Smooth and Refraction, so a neighbour that moved in that pass is followed.
 *
 * The source drives its image. Only when the image alone is being edited (it is in the edit's focus and the source is not) does the
 * source follow the image instead, so an image can still be dragged without being snapped straight back.
 */

const EPS = 1e-9;

interface AxisLine {
  readonly start: Vec2;
  readonly end: Vec2;
}

function axisOf(id: string | undefined, entities: ReadonlyMap<string, SketchEntity>): AxisLine | undefined {
  if (id === SKETCH_AXIS_X_ID) return { start: [0, 0], end: [1, 0] };
  if (id === SKETCH_AXIS_Y_ID) return { start: [0, 0], end: [0, 1] };
  const entity = id === undefined ? undefined : entities.get(id);
  return entity?.kind === "line" && Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]) > EPS ? entity : undefined;
}

function reflect(point: Vec2, axis: AxisLine): Vec2 {
  const dx = axis.end[0] - axis.start[0];
  const dy = axis.end[1] - axis.start[1];
  const parameter = ((point[0] - axis.start[0]) * dx + (point[1] - axis.start[1]) * dy) / (dx * dx + dy * dy);
  return [2 * (axis.start[0] + parameter * dx) - point[0], 2 * (axis.start[1] + parameter * dy) - point[1]];
}

const distanceSquared = (a: Vec2, b: Vec2): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function sameFitPoints(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  return a.length === b.length && a.every((point, index) => Math.abs(point[0] - b[index]![0]) <= EPS && Math.abs(point[1] - b[index]![1]) <= EPS);
}

/** An angle in degrees as the equivalent value (modulo 180, an ellipse looks the same turned half way round) nearest `near`. */
function nearestEllipseTurn(degrees: number, near: number): number {
  let turn = degrees;
  while (turn - near > 90) turn -= 180;
  while (turn - near < -90) turn += 180;
  return turn;
}

export interface MirrorFollow {
  readonly entity: SketchEntity;
  readonly note: string;
}

/**
 * Brings the image of a spline or ellipse pair back in line with its source. Undefined when the pair already agrees or is not one of
 * these kinds; a string explains why the relation cannot be applied.
 */
export function applySymmetryExtras(constraint: WorkbenchSketchConstraint, entities: ReadonlyMap<string, SketchEntity>, focus: ReadonlySet<string>): MirrorFollow | string | undefined {
  const [firstId, secondId, axisId] = constraint.entityIds;
  const first = entities.get(firstId ?? "");
  const second = entities.get(secondId ?? "");
  if (first === undefined || second === undefined) return undefined;
  if (!((first.kind === "spline" && second.kind === "spline") || (first.kind === "ellipse" && second.kind === "ellipse"))) return undefined;
  const axis = axisOf(axisId, entities);
  if (axis === undefined) return "Symmetric needs an axis line as the last selection.";
  // The edited image drives its source; otherwise the source drives the image.
  const imageDrives = focus.has(second.id) && !focus.has(first.id);
  const [from, to] = imageDrives ? [second, first] : [first, second];
  if (from.kind === "spline" && to.kind === "spline") {
    const mirrored = from.fitPoints.map((point) => reflect(point, axis));
    if (mirrored.length !== to.fitPoints.length) return "A spline and its mirror image must have the same number of fit points.";
    // Pair the fit points in the order that is nearer, so an image drawn in either direction keeps it.
    const straight = mirrored.reduce((sum, point, index) => sum + distanceSquared(point, to.fitPoints[index]!), 0);
    const crossed = mirrored.reduce((sum, point, index) => sum + distanceSquared(point, to.fitPoints[mirrored.length - 1 - index]!), 0);
    const wanted = straight <= crossed ? mirrored : [...mirrored].reverse();
    if (sameFitPoints(wanted, to.fitPoints)) return undefined;
    return { entity: { ...to, fitPoints: wanted }, note: `Mirrored spline ${to.id.replace(/^entity:/u, "")} follows ${from.id.replace(/^entity:/u, "")}` };
  }
  if (from.kind === "ellipse" && to.kind === "ellipse") {
    const angle = (Math.atan2(axis.end[1] - axis.start[1], axis.end[0] - axis.start[0]) * 180) / Math.PI;
    const turn = nearestEllipseTurn(2 * angle - from.rotationDeg, to.rotationDeg);
    if (Math.abs(turn - to.rotationDeg) <= 1e-7) return undefined;
    return { entity: { ...to, rotationDeg: turn }, note: `Mirrored ellipse ${to.id.replace(/^entity:/u, "")} turned to follow ${from.id.replace(/^entity:/u, "")}` };
  }
  return undefined;
}
