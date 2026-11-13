import { SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID, SKETCH_ORIGIN_ID, type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { livePointOf } from "../../workbench-core/src/sketch-measure.js";
import { DIMENSION_GAP_PX, DIMENSION_OFFSET_PX, DIMENSION_OVERSHOOT_PX, linearDimensionLayout, upwardNormal, type DimensionLayout, type DimensionLayoutOptions } from "./dimension-layout.js";
import { formatDimensionLabelValue } from "./sketch-units.js";

/**
 * Where the lines, arrows and text of a distance between two things go: two points (aligned, or along X or Y only), a point and a line,
 * two parallel lines, and an ellipse's major or minor radius. These dimensions came with the simultaneous solver, so the canvas had no
 * drawing for them: a distance between two circle centres, or from the origin, was applied but never shown. The layout has the same
 * parts as every other dimension (witness lines, arrow heads, a label that stands off the geometry), so it is dragged, formatted and
 * stacked like the rest.
 */

const POINT_DISTANCE_NAMES: ReadonlySet<string> = new Set(["aligned", "horizontal", "vertical", "point-line", "line-line"]);

/** True for a distance between points, a point and a line, or two lines (not the length of one line or the size of a rectangle). */
export function isPointDistanceConstraint(constraint: Pick<WorkbenchSketchConstraint, "kind" | "dimension">): boolean {
  return constraint.kind === "distance" && constraint.dimension !== undefined && POINT_DISTANCE_NAMES.has(constraint.dimension);
}

/** True for the major or minor radius of an ellipse. */
export function isEllipseRadiusConstraint(constraint: Pick<WorkbenchSketchConstraint, "kind" | "dimension">): boolean {
  return constraint.kind === "radius" && (constraint.dimension === "major-radius" || constraint.dimension === "minor-radius");
}

interface LineEnds {
  readonly start: Vec2;
  readonly end: Vec2;
}

function lineOf(sketch: Pick<WorkbenchSketch, "entities">, id: string | undefined): LineEnds | undefined {
  if (id === SKETCH_AXIS_X_ID) return { start: [0, 0], end: [1, 0] };
  if (id === SKETCH_AXIS_Y_ID) return { start: [0, 0], end: [0, 1] };
  const entity = sketch.entities.find((candidate) => candidate.id === id);
  return entity?.kind === "line" ? entity : undefined;
}

function pointOf(sketch: Pick<WorkbenchSketch, "entities">, constraint: WorkbenchSketchConstraint, index: number): Vec2 | undefined {
  const id = constraint.entityIds[index];
  if (id === SKETCH_ORIGIN_ID) return [0, 0];
  return livePointOf(sketch.entities.find((candidate) => candidate.id === id), constraint.points?.[index]);
}

function foot(point: Vec2, line: LineEnds): Vec2 | undefined {
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-18) return undefined;
  const t = ((point[0] - line.start[0]) * dx + (point[1] - line.start[1]) * dy) / length2;
  return [line.start[0] + dx * t, line.start[1] + dy * t];
}

/**
 * A dimension measured along one axis between two points: the dimension line stands off the pair on the `normal` side, and each witness
 * line runs from its point out to the dimension line (the points are at different heights, so the witness lines differ in length).
 */
function projected(start: Vec2, end: Vec2, axis: Vec2, normal: Vec2, valueMm: number, pxMm: number, options?: DimensionLayoutOptions): DimensionLayout {
  const standoff = options?.offsetPx ?? DIMENSION_OFFSET_PX;
  const gap = DIMENSION_GAP_PX * pxMm;
  const level = Math.max(start[0] * normal[0] + start[1] * normal[1], end[0] * normal[0] + end[1] * normal[1]) + standoff * pxMm;
  const onLine = (point: Vec2): Vec2 => {
    const here = point[0] * normal[0] + point[1] * normal[1];
    return [point[0] + normal[0] * (level - here), point[1] + normal[1] * (level - here)];
  };
  const along = (point: Vec2): number => point[0] * axis[0] + point[1] * axis[1];
  const [low, high] = along(start) <= along(end) ? [start, end] : [end, start];
  const first = onLine(low);
  const second = onLine(high);
  const beyond = (point: Vec2): Vec2 => [point[0] + normal[0] * DIMENSION_OVERSHOOT_PX * pxMm, point[1] + normal[1] * DIMENSION_OVERSHOOT_PX * pxMm];
  const away = (point: Vec2): Vec2 => [point[0] + normal[0] * gap, point[1] + normal[1] * gap];
  const write = options?.format ?? formatDimensionLabelValue;
  return {
    extensionLines: [{ from: away(low), to: beyond(first) }, { from: away(high), to: beyond(second) }],
    dimensionLine: { from: first, to: second },
    arrows: [{ tip: first, direction: [-axis[0], -axis[1]] }, { tip: second, direction: axis }],
    textAt: [(first[0] + second[0]) / 2 + normal[0] * 9 * pxMm, (first[1] + second[1]) / 2 + normal[1] * 9 * pxMm],
    label: write(valueMm)
  };
}

/** The layout of a distance dimension between points, a point and a line, or two lines; undefined when its geometry cannot be found or has no extent. */
export function pointDistanceLayout(sketch: Pick<WorkbenchSketch, "entities">, constraint: WorkbenchSketchConstraint, valueMm: number, pxMm: number, options?: DimensionLayoutOptions): DimensionLayout | undefined {
  if (!isPointDistanceConstraint(constraint)) return undefined;
  const name = constraint.dimension;
  if (name === "aligned" || name === "horizontal" || name === "vertical") {
    const a = pointOf(sketch, constraint, 0);
    const b = pointOf(sketch, constraint, 1);
    if (a === undefined || b === undefined) return undefined;
    if (name === "horizontal") return Math.abs(b[0] - a[0]) < 1e-9 ? undefined : projected(a, b, [1, 0], [0, 1], valueMm, pxMm, options);
    if (name === "vertical") return Math.abs(b[1] - a[1]) < 1e-9 ? undefined : projected(a, b, [0, 1], [1, 0], valueMm, pxMm, options);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) return undefined;
    return linearDimensionLayout(a, b, upwardNormal([(b[0] - a[0]) / length, (b[1] - a[1]) / length]), valueMm, pxMm, "", options);
  }
  // A point to a line (the first thing is the point), or two lines (from the middle of the second to the first).
  const line = name === "point-line" ? lineOf(sketch, constraint.entityIds[1]) : lineOf(sketch, constraint.entityIds[0]);
  let point: Vec2 | undefined;
  if (name === "point-line") point = pointOf(sketch, constraint, 0);
  else {
    const other = lineOf(sketch, constraint.entityIds[1]);
    point = other === undefined ? undefined : [(other.start[0] + other.end[0]) / 2, (other.start[1] + other.end[1]) / 2];
  }
  if (line === undefined || point === undefined) return undefined;
  const base = foot(point, line);
  if (base === undefined) return undefined;
  const length = Math.hypot(base[0] - point[0], base[1] - point[1]);
  if (length < 1e-9) return undefined;
  const direction: Vec2 = [(base[0] - point[0]) / length, (base[1] - point[1]) / length];
  // A diameter across the line runs from the point to its mirror image on the far side, with a diameter sign before the value.
  if (constraint.doubled === true) return linearDimensionLayout(point, [2 * base[0] - point[0], 2 * base[1] - point[1]], upwardNormal(direction), valueMm, pxMm, "\u00d8", options);
  return linearDimensionLayout(point, base, upwardNormal(direction), valueMm, pxMm, "", options);
}

/** A radius line from an ellipse's centre to the end of its major or minor axis, with the value in the label ("Major R 12"). */
export function ellipseRadiusLayout(ellipse: Extract<SketchEntity, { kind: "ellipse" }>, which: "major-radius" | "minor-radius", valueMm: number, pxMm: number, options?: DimensionLayoutOptions): DimensionLayout {
  const turn = (ellipse.rotationDeg * Math.PI) / 180 + (which === "minor-radius" ? Math.PI / 2 : 0);
  const direction: Vec2 = [Math.cos(turn), Math.sin(turn)];
  const radius = which === "minor-radius" ? ellipse.minorRadiusMm : ellipse.majorRadiusMm;
  const tip: Vec2 = [ellipse.center[0] + direction[0] * radius, ellipse.center[1] + direction[1] * radius];
  const write = options?.format ?? formatDimensionLabelValue;
  return {
    extensionLines: [],
    dimensionLine: { from: ellipse.center, to: tip },
    arrows: [{ tip, direction }],
    textAt: [tip[0] + direction[0] * 18 * pxMm, tip[1] + direction[1] * 18 * pxMm],
    label: `${which === "minor-radius" ? "Minor" : "Major"} R${write(valueMm)}`
  };
}
