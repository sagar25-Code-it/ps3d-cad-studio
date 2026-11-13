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
  | { readonly status: "none"; readonly message: string };

export const PAIR_DIMENSION_LABELS: Readonly<Record<PairDimensionName, string>> = {
  angle: "Angle (degrees)",
  "line-line": "Distance between the lines",
  "point-line": "Distance to the line",
  aligned: "Distance",
  horizontal: "Horizontal distance",
  vertical: "Vertical distance"
};

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

function distanceBetween(sketch: WorkbenchSketch, entityId: string, secondEntityId: string, dimension: Exclude<PairDimensionName, "angle">, points: readonly SketchPointRef[] | undefined): PairDimension | string {
  const kinds = [entityId, secondEntityId].map((id): SketchEntityKind | undefined => (id === SKETCH_ORIGIN_ID ? "origin" : sketch.entities.find((entity) => entity.id === id)?.kind));
  const fit = constraintFit("distance", kinds, points, { dimension });
  if (!fit.ok) return fit.reason;
  const probe: WorkbenchSketchConstraint = { id: "constraint:pair-probe", kind: "distance", dimension, entityIds: [entityId, secondEntityId], ...(points === undefined ? {} : { points }), driven: true };
  const measured = measureDimensionConstraint(sketch, probe);
  if (measured === undefined) return "That distance cannot be measured on this geometry.";
  const existing = existingOf(sketch, { entityId, secondEntityId, dimension, ...(points === undefined ? {} : { points }) });
  return { entityId, secondEntityId, dimension, ...(points === undefined ? {} : { points }), label: PAIR_DIMENSION_LABELS[dimension], measured, ...(existing === undefined ? {} : { existing }) };
}

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
    if (Math.abs(u[0] * v[1] - u[1] * v[0]) <= 1e-9 * scale) return ready(distanceBetween(sketch, a.id, b.id, "line-line", undefined));
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

/** The distance between two picked points, of the kind the placement chooses. */
export function placePointDistance(sketch: WorkbenchSketch, placement: PointPairPlacement, cursor: Vec2): PairDimension | string {
  return distanceBetween(sketch, placement.entityId, placement.secondEntityId, orientationForPlacement(placement.from, placement.to, cursor), placement.points);
}
