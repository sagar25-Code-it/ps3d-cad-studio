import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { entityPoints } from "./index.js";

/**
 * Where the lines, arrows and text of a driving dimension go. Distances that depend on the screen (how far the dimension
 * line stands off the geometry, arrow size) are passed in as `pxMm`, the number of millimetres one screen pixel covers, so
 * a dimension keeps its look at every zoom level.
 */
export type DrivingDimensionKind = "length" | "width" | "height" | "radius";

export interface DimensionSegment {
  readonly from: Vec2;
  readonly to: Vec2;
}

export interface DimensionArrow {
  /** The point of the arrow, on the extension line or the curve. */
  readonly tip: Vec2;
  /** Unit vector the arrow points along. */
  readonly direction: Vec2;
}

export interface DimensionLayout {
  readonly extensionLines: readonly DimensionSegment[];
  readonly dimensionLine: DimensionSegment;
  readonly arrows: readonly DimensionArrow[];
  /** Centre of the text, in sketch millimetres. */
  readonly textAt: Vec2;
  /** The text to show: a diameter for circles (the stored value is the radius). */
  readonly label: string;
}

export const DIMENSION_OFFSET_PX = 30;
export const DIMENSION_OVERSHOOT_PX = 6;
export const DIMENSION_GAP_PX = 3;

function formatValue(value: number): string {
  return String(Number(value.toFixed(3)));
}

function unit(from: Vec2, to: Vec2): Vec2 {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return length < 1e-12 ? [1, 0] : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

/** A linear dimension between two points, stood off to the side given by `normal`. */
function linear(start: Vec2, end: Vec2, normal: Vec2, valueMm: number, pxMm: number, labelPrefix = ""): DimensionLayout {
  const direction = unit(start, end);
  const offset = DIMENSION_OFFSET_PX * pxMm;
  const reach = (DIMENSION_OFFSET_PX + DIMENSION_OVERSHOOT_PX) * pxMm;
  const gap = DIMENSION_GAP_PX * pxMm;
  const at = (point: Vec2, distance: number): Vec2 => [point[0] + normal[0] * distance, point[1] + normal[1] * distance];
  const first = at(start, offset);
  const second = at(end, offset);
  return {
    extensionLines: [{ from: at(start, gap), to: at(start, reach) }, { from: at(end, gap), to: at(end, reach) }],
    dimensionLine: { from: first, to: second },
    arrows: [{ tip: first, direction: [-direction[0], -direction[1]] }, { tip: second, direction }],
    textAt: [(first[0] + second[0]) / 2 + normal[0] * 9 * pxMm, (first[1] + second[1]) / 2 + normal[1] * 9 * pxMm],
    label: `${labelPrefix}${formatValue(valueMm)}`
  };
}

/** Prefer the side of a line that points up (and right for a vertical one) so text sits above it. */
function upwardNormal(direction: Vec2): Vec2 {
  const candidate: Vec2 = [-direction[1], direction[0]];
  return candidate[1] > 1e-9 || (Math.abs(candidate[1]) <= 1e-9 && candidate[0] >= 0) ? candidate : [-candidate[0], -candidate[1]];
}

/**
 * The layout of a driving dimension on an entity, or undefined when the entity has no such dimension.
 * Circles are shown as a diameter (Ø) even though the stored value is the radius.
 */
export function dimensionLayout(entity: SketchEntity, dimension: DrivingDimensionKind, valueMm: number, pxMm: number): DimensionLayout | undefined {
  if (entity.kind === "line" && dimension === "length") {
    return linear(entity.start, entity.end, upwardNormal(unit(entity.start, entity.end)), valueMm, pxMm);
  }
  if (entity.kind === "rectangle" && (dimension === "width" || dimension === "height")) {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const axisX: Vec2 = [Math.cos(radians), Math.sin(radians)];
    const axisY: Vec2 = [-Math.sin(radians), Math.cos(radians)];
    const corners = entityPoints(entity);
    // Corners run (-w,-h), (w,-h), (w,h), (-w,h) in the rectangle's own frame.
    return dimension === "width"
      ? linear(corners[0]!, corners[1]!, [-axisY[0], -axisY[1]], valueMm, pxMm)
      : linear(corners[1]!, corners[2]!, axisX, valueMm, pxMm);
  }
  if (entity.kind === "circle" && dimension === "radius") {
    const angle = (35 * Math.PI) / 180;
    const direction: Vec2 = [Math.cos(angle), Math.sin(angle)];
    const near: Vec2 = [entity.center[0] - direction[0] * entity.radiusMm, entity.center[1] - direction[1] * entity.radiusMm];
    const far: Vec2 = [entity.center[0] + direction[0] * entity.radiusMm, entity.center[1] + direction[1] * entity.radiusMm];
    return {
      extensionLines: [],
      dimensionLine: { from: near, to: far },
      // The arrows touch the curve from inside, pointing outward at both ends.
      arrows: [{ tip: near, direction: [-direction[0], -direction[1]] }, { tip: far, direction }],
      textAt: [far[0] + direction[0] * 16 * pxMm, far[1] + direction[1] * 16 * pxMm],
      label: `Ø${formatValue(valueMm * 2)}`
    };
  }
  return undefined;
}

/** The three points of an arrowhead: the tip, and the two back corners. */
export function arrowHead(arrow: DimensionArrow, pxMm: number): readonly [Vec2, Vec2, Vec2] {
  const length = 10 * pxMm;
  const half = 3.6 * pxMm;
  const [dx, dy] = arrow.direction;
  const back: Vec2 = [arrow.tip[0] - dx * length, arrow.tip[1] - dy * length];
  return [arrow.tip, [back[0] - dy * half, back[1] + dx * half], [back[0] + dy * half, back[1] - dx * half]];
}
