import { SKETCH_ORIGIN_ID, SOLVABLE_POINT_REFS, constraintFit, locateDimensionConstraint, type SketchEntityKind, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { angleBetweenLinesDeg, livePointOf, measureDimensionConstraint } from "../../workbench-core/src/sketch-measure.js";

/**
 * The Sketch Dimension tool with two picks: what two picked things are dimensioned by. A pick is a curve that was clicked or one of its
 * defining points (a blue dot). The pair decides the kind of dimension, as a designer expects from one D tool:
 *
 *   two parallel lines            the distance between them
 *   two lines that are not        the angle from the first to the second
 *   a point or a centre, a line   the distance from the point to the line
 *   two points or centres         the distance between them: straight, or its horizontal or vertical part, chosen by where the
 *                                 dimension is placed (above or below the points: horizontal; beside them: vertical)
 *
 * A clicked circle, arc, ellipse or rectangle stands for its centre and a sketch point for itself. Nothing here changes the sketch: the
 * canvas opens the value editor with the result and the usual dimension operation applies what is typed.
 */
export interface DimensionPick {
  readonly entityId: string;
  /** The defining point that was picked; absent when the curve itself was clicked. */
  readonly ref?: SketchPointRef | undefined;
}

export type PairDimensionName = "angle" | "line-line" | "point-line" | "aligned" | "horizontal" | "vertical";

/** A dimension between two picks, ready for the value editor. */
export interface PairDimension {
  readonly entityId: string;
  readonly secondEntityId: string;
  readonly dimension: PairDimensionName;
  /** The point each entity contributes (a distance between points names two, a point-to-line distance one). */
  readonly points?: readonly SketchPointRef[];
  /** The editor's label. */
  readonly label: string;
  /** What it measures now: millimetres, or degrees for an angle. */
  readonly measured: number;
  /** The dimension this pair already has, if any: its value (or its expression), or that it is a reference. */
  readonly existing?: { readonly value?: number; readonly expression?: string; readonly reference: boolean };
  /**
   * A distance to a line only. True: the value is a diameter across the line (twice the distance). False: a plain distance, chosen by
   * placing the dimension on the near side of a centreline. Absent: the dimension keeps the form it has.
   */
  readonly doubled?: boolean;
}

/**
 * A point (or a line) and a centreline picked: the dimension is made when it is placed. Beyond the centreline it is a diameter across
 * it, as the half profile of a turned part is dimensioned; on the near side it is the distance to the centreline.
 */
export interface AcrossLinePlacement {
  readonly entityId: string;
  readonly secondEntityId: string;
  readonly dimension: "point-line" | "line-line";
  readonly points?: readonly SketchPointRef[];
  /** Where the distance is measured from: the picked point, or the middle of the picked line. */
  readonly from: Vec2;
  /** The centreline (a construction line). */
  readonly axis: { readonly start: Vec2; readonly end: Vec2 };
}

/** Two points picked: the dimension is made when it is placed, because the place chooses straight, horizontal or vertical. */
export interface PointPairPlacement {
  readonly entityId: string;
  readonly secondEntityId: string;
  readonly points: readonly [SketchPointRef, SketchPointRef];
  readonly from: Vec2;
  readonly to: Vec2;
}

export type DimensionPairResult =
  | { readonly status: "ready"; readonly dimension: PairDimension }
  | { readonly status: "place"; readonly placement: PointPairPlacement; readonly prompt: string }
  | { readonly status: "place-across"; readonly placement: AcrossLinePlacement; readonly prompt: string }
  | { readonly status: "none"; readonly message: string };

export const PAIR_DIMENSION_LABELS: Readonly<Record<PairDimensionName, string>> = {
  angle: "Angle (degrees)",
  "line-line": "Distance between the lines",
  "point-line": "Distance to the line",
  aligned: "Distance",
  horizontal: "Horizontal distance",
  vertical: "Vertical distance"
};

export const DOUBLED_DISTANCE_LABEL = "Diameter across the centreline";

export const ACROSS_PROMPT = "Click where the dimension should go: beyond the centreline for a diameter across it, on this side of it for the distance to it.";

export const PLACEMENT_PROMPT = "Click where the dimension should go: above or below the two points for the horizontal distance, beside them for the vertical distance, anywhere else for the straight distance.";

type Role =
  | { readonly type: "line"; readonly id: string }
  | { readonly type: "point"; readonly id: string; readonly ref: SketchPointRef; readonly kind: SketchEntityKind };

function roleOf(sketch: WorkbenchSketch, pick: DimensionPick): Role | string {
  if (pick.entityId === SKETCH_ORIGIN_ID) return { type: "point", id: pick.entityId, ref: "self", kind: "origin" };
  const entity = sketch.entities.find((candidate) => candidate.id === pick.entityId);
  if (entity === undefined) return "A picked curve is no longer in the sketch; pick again.";
  if (pick.ref !== undefined) {
    return SOLVABLE_POINT_REFS[entity.kind].includes(pick.ref)
      ? { type: "point", id: entity.id, ref: pick.ref, kind: entity.kind }
      : "That point can only be measured, not driven: pick an end, a centre, a rectangle corner, a sketch point or the origin.";
  }
  switch (entity.kind) {
    case "line": return { type: "line", id: entity.id };
    case "point": return { type: "point", id: entity.id, ref: "self", kind: "point" };
    case "circle":
    case "arc":
    case "ellipse":
    case "rectangle": return { type: "point", id: entity.id, ref: "center", kind: entity.kind };
    default: return "A spline takes reference dimensions only; pick a line, a circle, an arc, a rectangle or a point.";
  }
}

function existingOf(sketch: WorkbenchSketch, key: { readonly entityId: string; readonly secondEntityId: string; readonly dimension: PairDimensionName; readonly points?: readonly SketchPointRef[] }): PairDimension["existing"] {
  const found = locateDimensionConstraint(sketch, key);
  if (found === undefined) return undefined;
  const value = found.kind === "angle" ? found.valueDeg : found.valueMm;
  return { reference: found.driven === true, ...(value === undefined ? {} : { value }), ...(found.expression === undefined ? {} : { expression: found.expression }) };
}

/**
 * `doubled` is the form the placement asked for (a diameter across the line, or a plain distance); left out, the pair keeps the form
 * its dimension already has. A dimension that exists in the other form is not reported as existing: its value is not this one's, and
 * accepting the editor then turns it into the form that was placed.
 */
function distanceBetween(sketch: WorkbenchSketch, entityId: string, secondEntityId: string, dimension: Exclude<PairDimensionName, "angle">, points: readonly SketchPointRef[] | undefined, doubled?: boolean): PairDimension | string {
  const kinds = [entityId, secondEntityId].map((id): SketchEntityKind | undefined => (id === SKETCH_ORIGIN_ID ? "origin" : sketch.entities.find((entity) => entity.id === id)?.kind));
  const fit = constraintFit("distance", kinds, points, { dimension });
  if (!fit.ok) return fit.reason;
  const key = { entityId, secondEntityId, dimension, ...(points === undefined ? {} : { points }) };
  const stored = locateDimensionConstraint(sketch, key);
  const storedDoubled = stored?.doubled === true;
  const form = doubled ?? storedDoubled;
  const probe: WorkbenchSketchConstraint = { id: "constraint:pair-probe", kind: "distance", dimension, entityIds: [entityId, secondEntityId], ...(points === undefined ? {} : { points }), driven: true, ...(form ? { doubled: true } : {}) };
  const measured = measureDimensionConstraint(sketch, probe);
  if (measured === undefined) return "That distance cannot be measured on this geometry.";
  const existing = stored !== undefined && storedDoubled !== form ? undefined : existingOf(sketch, key);
  return { ...key, label: form ? DOUBLED_DISTANCE_LABEL : PAIR_DIMENSION_LABELS[dimension], measured, ...(existing === undefined ? {} : { existing }), ...(doubled === undefined && !form ? {} : { doubled: form }) };
}

/** Which side of a line a point is on: 1, -1, or 0 when it is on the line. */
function sideOf(axis: { readonly start: Vec2; readonly end: Vec2 }, point: Vec2): number {
  const cross = (axis.end[0] - axis.start[0]) * (point[1] - axis.start[1]) - (axis.end[1] - axis.start[1]) * (point[0] - axis.start[0]);
  const scale = Math.max(Math.hypot(axis.end[0] - axis.start[0], axis.end[1] - axis.start[1]), 1e-12);
  return Math.abs(cross) / scale < 1e-9 ? 0 : Math.sign(cross);
}

/** True when the dimension placed at `cursor` is a diameter: the cursor is beyond the centreline, on the side away from what was picked. */
export function placedAcross(placement: AcrossLinePlacement, cursor: Vec2): boolean {
  const near = sideOf(placement.axis, placement.from);
  return near !== 0 && sideOf(placement.axis, cursor) === -near;
}

/** The dimension a point (or line) and a centreline get where it is placed: a diameter across the centreline, or the distance to it. */
export function placeAcrossDistance(sketch: WorkbenchSketch, placement: AcrossLinePlacement, cursor: Vec2): PairDimension | string {
  return distanceBetween(sketch, placement.entityId, placement.secondEntityId, placement.dimension, placement.points, placedAcross(placement, cursor));
}

/**
 * The dimension a waiting placement would make with the pointer at `cursor`, as a reference constraint the canvas can lay out and
 * draw while the pointer moves. It is never stored.
 */
export function placementPreview(sketch: WorkbenchSketch, placement: PointPairPlacement | AcrossLinePlacement, cursor: Vec2): { readonly constraint: WorkbenchSketchConstraint; readonly measured: number } | undefined {
  const found = "axis" in placement ? placeAcrossDistance(sketch, placement, cursor) : placePointDistance(sketch, placement, cursor);
  if (typeof found === "string" || found.dimension === "angle") return undefined;
  return {
    constraint: { id: "constraint:placement-preview", kind: "distance", dimension: found.dimension, entityIds: [found.entityId, found.secondEntityId], ...(found.points === undefined ? {} : { points: found.points }), driven: true, ...(found.doubled === true ? { doubled: true } : {}) },
    measured: found.measured
  };
}

const isCentreline = (entity: { readonly kind: string; readonly construction?: boolean } | undefined): boolean => entity?.kind === "line" && entity.construction === true;

/** What the two picks are dimensioned by, in the order they were picked. */
export function resolveDimensionPair(sketch: WorkbenchSketch, first: DimensionPick, second: DimensionPick): DimensionPairResult {
  const none = (message: string): DimensionPairResult => ({ status: "none", message });
  const a = roleOf(sketch, first);
  if (typeof a === "string") return none(a);
  const b = roleOf(sketch, second);
  if (typeof b === "string") return none(b);
  const ready = (found: PairDimension | string): DimensionPairResult => (typeof found === "string" ? none(found) : { status: "ready", dimension: found });

  if (a.type === "line" && b.type === "line") {
    if (a.id === b.id) return none("Pick a second curve, or type the length of this line.");
    const one = sketch.entities.find((entity) => entity.id === a.id);
    const two = sketch.entities.find((entity) => entity.id === b.id);
    if (one?.kind !== "line" || two?.kind !== "line") return none("A picked line is no longer in the sketch; pick again.");
    const u: Vec2 = [one.end[0] - one.start[0], one.end[1] - one.start[1]];
    const v: Vec2 = [two.end[0] - two.start[0], two.end[1] - two.start[1]];
    const scale = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]);
    if (scale < 1e-12) return none("One of the lines has no length.");
    if (Math.abs(u[0] * v[1] - u[1] * v[0]) <= 1e-9 * scale) {
      // A line and a centreline (the second pick when both are construction lines): where the dimension is placed chooses diameter or distance.
      const axis = isCentreline(two) ? two : isCentreline(one) ? one : undefined;
      const other = axis === two ? one : two;
      if (axis !== undefined) {
        // A dimension these two already have (stored centreline first) is edited as it is.
        if (existingOf(sketch, { entityId: axis.id, secondEntityId: other.id, dimension: "line-line" }) !== undefined) return ready(distanceBetween(sketch, axis.id, other.id, "line-line", undefined));
        const from: Vec2 = [(other.start[0] + other.end[0]) / 2, (other.start[1] + other.end[1]) / 2];
        if (existingOf(sketch, { entityId: a.id, secondEntityId: b.id, dimension: "line-line" }) === undefined && sideOf(axis, from) !== 0) {
          return { status: "place-across", placement: { entityId: axis.id, secondEntityId: other.id, dimension: "line-line", from, axis: { start: axis.start, end: axis.end } }, prompt: ACROSS_PROMPT };
        }
      }
      return ready(distanceBetween(sketch, a.id, b.id, "line-line", undefined));
    }
    const existing = existingOf(sketch, { entityId: a.id, secondEntityId: b.id, dimension: "angle" });
    return { status: "ready", dimension: { entityId: a.id, secondEntityId: b.id, dimension: "angle", label: PAIR_DIMENSION_LABELS.angle, measured: angleBetweenLinesDeg(one, two), ...(existing === undefined ? {} : { existing }) } };
  }
  if (a.type === "point" && b.type === "point") {
    if (a.id === b.id && a.ref === b.ref) return none("That is the same point; pick a second one.");
    if (a.kind === "origin" && b.kind === "origin") return none("The origin is one point; pick a curve or a point to dimension from it.");
    const fit = constraintFit("distance", [a.kind, b.kind], [a.ref, b.ref], { dimension: "aligned" });
    if (!fit.ok) return none(fit.reason);
    const from = a.kind === "origin" ? ([0, 0] as Vec2) : livePointOf(sketch.entities.find((entity) => entity.id === a.id), a.ref);
    const to = b.kind === "origin" ? ([0, 0] as Vec2) : livePointOf(sketch.entities.find((entity) => entity.id === b.id), b.ref);
    if (from === undefined || to === undefined) return none("One of the points cannot be found on its curve.");
    return { status: "place", placement: { entityId: a.id, secondEntityId: b.id, points: [a.ref, b.ref], from, to }, prompt: PLACEMENT_PROMPT };
  }
  const point = a.type === "point" ? a : (b as Extract<Role, { type: "point" }>);
  const line = a.type === "line" ? a : (b as Extract<Role, { type: "line" }>);
  if (point.id === line.id) return none("That point belongs to the line itself; pick a point of another curve.");
  const axisLine = sketch.entities.find((entity) => entity.id === line.id);
  if (axisLine?.kind === "line" && axisLine.construction) {
    // A point and a centreline: where the dimension is placed chooses a diameter across the centreline or the distance to it.
    const from = point.kind === "origin" ? ([0, 0] as Vec2) : livePointOf(sketch.entities.find((entity) => entity.id === point.id), point.ref);
    if (from !== undefined && sideOf(axisLine, from) !== 0 && existingOf(sketch, { entityId: point.id, secondEntityId: line.id, dimension: "point-line", points: [point.ref] }) === undefined) return { status: "place-across", placement: { entityId: point.id, secondEntityId: line.id, dimension: "point-line", points: [point.ref], from, axis: { start: axisLine.start, end: axisLine.end } }, prompt: ACROSS_PROMPT };
  }
  return ready(distanceBetween(sketch, point.id, line.id, "point-line", [point.ref]));
}

/**
 * Straight, horizontal or vertical, from where the dimension is placed. Above or below the span of the two points it measures across
 * (horizontal); to the left or right of them it measures up and down (vertical); anywhere else, or when that part would be zero, it is
 * the straight distance.
 */
export function orientationForPlacement(from: Vec2, to: Vec2, cursor: Vec2): "aligned" | "horizontal" | "vertical" {
  const tiny = 1e-9;
  const insideX = cursor[0] >= Math.min(from[0], to[0]) && cursor[0] <= Math.max(from[0], to[0]);
  const insideY = cursor[1] >= Math.min(from[1], to[1]) && cursor[1] <= Math.max(from[1], to[1]);
  if (insideX && !insideY && Math.abs(to[0] - from[0]) > tiny) return "horizontal";
  if (insideY && !insideX && Math.abs(to[1] - from[1]) > tiny) return "vertical";
  return "aligned";
}

/**
 * A sloped line picked on its own, as its two ends: clicking a curve gives its length at once, and a placement click above or below
 * the line then gives its horizontal extent, beside it its vertical extent. A level or plumb line has no separate extent, so it
 * gives nothing here.
 */
export function lineExtentPlacement(sketch: WorkbenchSketch, pick: DimensionPick | undefined): PointPairPlacement | undefined {
  if (pick === undefined || pick.ref !== undefined) return undefined;
  const entity = sketch.entities.find((candidate) => candidate.id === pick.entityId);
  if (entity?.kind !== "line") return undefined;
  if (Math.abs(entity.end[0] - entity.start[0]) < 1e-9 || Math.abs(entity.end[1] - entity.start[1]) < 1e-9) return undefined;
  return { entityId: entity.id, secondEntityId: entity.id, points: ["start", "end"], from: entity.start, to: entity.end };
}

/** The horizontal or vertical extent of a picked line for a placement click at `cursor`; undefined where the placement means its own length. */
export function placeLineExtent(sketch: WorkbenchSketch, pick: DimensionPick | undefined, cursor: Vec2): PairDimension | string | undefined {
  const placement = lineExtentPlacement(sketch, pick);
  if (placement === undefined || orientationForPlacement(placement.from, placement.to, cursor) === "aligned") return undefined;
  return placePointDistance(sketch, placement, cursor);
}

/** The distance between two picked points, of the kind the placement chooses. */
export function placePointDistance(sketch: WorkbenchSketch, placement: PointPairPlacement, cursor: Vec2): PairDimension | string {
  return distanceBetween(sketch, placement.entityId, placement.secondEntityId, orientationForPlacement(placement.from, placement.to, cursor), placement.points);
}

/**
 * What the Dimension tool keeps as its first pick after a click on a point (a blue dot): the point itself while it is the only point
 * picked, so a curve clicked next is paired with it. Pick order does not matter in the tool: a point and then a line gives the same
 * distance as the line and then the point. Two picked points are placed as a point pair, which needs no first pick.
 */
export function firstPickAfterPoint(point: { readonly entityId: string; readonly ref: SketchPointRef | undefined }, pickedPointCount: number): DimensionPick | undefined {
  return pickedPointCount === 1 && point.ref !== undefined ? { entityId: point.entityId, ref: point.ref } : undefined;
}

/**
 * What a click on a curve is dimensioned by when something was picked before it, or undefined when the click is for the curve alone
 * (nothing picked before, the same curve again, or a point that already lies on the clicked line, such as the corner the two share:
 * that point has no distance to give, so the click opens the line's own length).
 */
export function pairForCurveClick(sketch: WorkbenchSketch, first: DimensionPick | undefined, curveId: string): DimensionPairResult | undefined {
  if (first === undefined || first.entityId === curveId) return undefined;
  const pair = resolveDimensionPair(sketch, first, { entityId: curveId });
  if (first.ref !== undefined && pair.status === "ready" && pair.dimension.dimension === "point-line" && pair.dimension.existing === undefined && Math.abs(pair.dimension.measured) < 1e-9) return undefined;
  return pair;
}

/** The Dimension tool's banner while one thing is picked and nothing is being placed. */
export function firstPickPrompt(first: DimensionPick, lineHasExtent: boolean): string {
  if (first.ref !== undefined) return "Point picked. Click a line for the distance to it, or a second point or circle for the distance between the two.";
  return lineHasExtent
    ? "Type the length, click above or beside the line for its horizontal or vertical extent, or click a second curve or point."
    : "Type the value, or click a second curve or point for the distance or angle between the two.";
}
