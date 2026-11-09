import { formatDimensionLabelValue } from "./sketch-units.js";
import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { arcShape } from "../../workbench-core/src/sketch-measure.js";
import { entityPoints } from "./index.js";

/**
 * Where the lines, arrows and text of a driving dimension go. Distances that depend on the screen (how far the dimension
 * line stands off the geometry, arrow size) are passed in as `pxMm`, the number of millimetres one screen pixel covers, so
 * a dimension keeps its look at every zoom level.
 */
export type DrivingDimensionKind = "length" | "width" | "height" | "radius" | "angle" | "arc-length" | "perimeter";

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

/** A curved dimension line: the arc of a circle swept counter-clockwise from `fromRad` by `sweepRad`. An angle or arc-length dimension uses one. */
export interface DimensionArc {
  readonly center: Vec2;
  readonly radiusMm: number;
  readonly fromRad: number;
  readonly sweepRad: number;
}

export interface DimensionLayout {
  /** Present when the dimension line is curved; `dimensionLine` is then the chord between the arc's ends. */
  readonly arc?: DimensionArc;
  /** True for a driven (reference) dimension, drawn in brackets. */
  readonly reference?: boolean;
  readonly extensionLines: readonly DimensionSegment[];
  readonly dimensionLine: DimensionSegment;
  readonly arrows: readonly DimensionArrow[];
  /** Centre of the text, in sketch millimetres. */
  readonly textAt: Vec2;
  /** The text to show: a diameter for circles (the stored value is the radius). */
  readonly label: string;
}

export const DIMENSION_OFFSET_PX = 30;

/** Per-dimension display choices: how far the dimension line stands off the geometry, and how the value is written. */
export interface DimensionLayoutOptions {
  /** Distance of the dimension line from the geometry in screen pixels; defaults to DIMENSION_OFFSET_PX. */
  readonly offsetPx?: number;
  /** Writes a value (millimetres; for a circle the diameter) as the label text. Defaults to three decimals without a unit. */
  readonly format?: (value: number) => string;
}
export const DIMENSION_OVERSHOOT_PX = 6;
export const DIMENSION_GAP_PX = 3;

function formatValue(value: number): string {
  return String(Number(value.toFixed(3)));
}

const writer = (options: DimensionLayoutOptions | undefined): ((value: number) => string) => options?.format ?? formatDimensionLabelValue;

function unit(from: Vec2, to: Vec2): Vec2 {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return length < 1e-12 ? [1, 0] : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

/** A linear dimension between two points, stood off to the side given by `normal`. */
function linear(start: Vec2, end: Vec2, normal: Vec2, valueMm: number, pxMm: number, labelPrefix = "", options?: DimensionLayoutOptions): DimensionLayout {
  const direction = unit(start, end);
  const standoff = options?.offsetPx ?? DIMENSION_OFFSET_PX;
  const offset = standoff * pxMm;
  const reach = (standoff + DIMENSION_OVERSHOOT_PX) * pxMm;
  const gap = DIMENSION_GAP_PX * pxMm;
  const at = (point: Vec2, distance: number): Vec2 => [point[0] + normal[0] * distance, point[1] + normal[1] * distance];
  const first = at(start, offset);
  const second = at(end, offset);
  return {
    extensionLines: [{ from: at(start, gap), to: at(start, reach) }, { from: at(end, gap), to: at(end, reach) }],
    dimensionLine: { from: first, to: second },
    arrows: [{ tip: first, direction: [-direction[0], -direction[1]] }, { tip: second, direction }],
    textAt: [(first[0] + second[0]) / 2 + normal[0] * 9 * pxMm, (first[1] + second[1]) / 2 + normal[1] * 9 * pxMm],
    label: `${labelPrefix}${writer(options)(valueMm)}`
  };
}

export const linearDimensionLayout = linear;

/** Prefer the side of a line that points up (and right for a vertical one) so text sits above it. */
export function upwardNormal(direction: Vec2): Vec2 {
  const candidate: Vec2 = [-direction[1], direction[0]];
  return candidate[1] > 1e-9 || (Math.abs(candidate[1]) <= 1e-9 && candidate[0] >= 0) ? candidate : [-candidate[0], -candidate[1]];
}

/**
 * The layout of a driving dimension on an entity, or undefined when the entity has no such dimension.
 * Circles are shown as a diameter (Ø) even though the stored value is the radius.
 */
export function dimensionLayout(entity: SketchEntity, dimension: DrivingDimensionKind, valueMm: number, pxMm: number, options?: DimensionLayoutOptions): DimensionLayout | undefined {
  if (entity.kind === "line" && dimension === "length") {
    return linear(entity.start, entity.end, upwardNormal(unit(entity.start, entity.end)), valueMm, pxMm, "", options);
  }
  if (entity.kind === "rectangle" && (dimension === "width" || dimension === "height")) {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const axisX: Vec2 = [Math.cos(radians), Math.sin(radians)];
    const axisY: Vec2 = [-Math.sin(radians), Math.cos(radians)];
    const corners = entityPoints(entity);
    // Corners run (-w,-h), (w,-h), (w,h), (-w,h) in the rectangle's own frame.
    return dimension === "width"
      ? linear(corners[0]!, corners[1]!, [-axisY[0], -axisY[1]], valueMm, pxMm, "", options)
      : linear(corners[1]!, corners[2]!, axisX, valueMm, pxMm, "", options);
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
      label: `Ø${writer(options)(valueMm * 2)}`
    };
  }
  if (entity.kind === "arc" && dimension === "radius") {
    const shape = arcShape(entity.start, entity.mid, entity.end);
    if (shape === undefined) return undefined;
    const direction = unit(shape.center, entity.mid);
    return {
      extensionLines: [],
      dimensionLine: { from: shape.center, to: entity.mid },
      // The arrow touches the arc from inside, pointing outward.
      arrows: [{ tip: entity.mid, direction }],
      textAt: [entity.mid[0] + direction[0] * 16 * pxMm, entity.mid[1] + direction[1] * 16 * pxMm],
      label: `R${writer(options)(valueMm)}`
    };
  }
  if (entity.kind === "arc" && dimension === "arc-length") return arcLengthDimensionLayout(entity, valueMm, pxMm);
  if (dimension === "perimeter") return perimeterDimensionLayout(entity, valueMm, pxMm);
  return undefined;
}

/** A driven (reference) dimension kind: measured, not editable. Arc length for curves, perimeter for closed loops. */
export type DrivenDimensionKind = "arc-length" | "perimeter";

/**
 * Measure a reference (driven) dimension for a sketch entity. Returns the measured length in millimetres plus a layout
 * that can be rendered the same way as a driving dimension (with the label prefixed "ARC" or "PERIM" to flag it as a
 * reference). Returns undefined when the kind does not apply to the entity (e.g. arc-length on a point).
 */
export function drivenDimensionLayout(entity: SketchEntity, kind: DrivenDimensionKind, pxMm: number): DimensionLayout | undefined {
  if (kind === "arc-length") {
    if (entity.kind === "line") {
      const length = Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
      return linear(entity.start, entity.end, upwardNormal(unit(entity.start, entity.end)), length, pxMm, "ARC ");
    }
    if (entity.kind === "arc") {
      // Reconstruct the circle through start → mid → end and integrate the arc length.
      const [sx, sy] = entity.start;
      const [mx, my] = entity.mid;
      const [ex, ey] = entity.end;
      const d = 2 * ((sx) * (my - ey) + (mx) * (ey - sy) + (ex) * (sy - my));
      if (Math.abs(d) < 1e-9) return undefined;
      const cx = ((sx * sx + sy * sy) * (my - ey) + (mx * mx + my * my) * (ey - sy) + (ex * ex + ey * ey) * (sy - my)) / d;
      const cy = ((sx * sx + sy * sy) * (ex - mx) + (mx * mx + my * my) * (sx - ex) + (ex * ex + ey * ey) * (mx - sx)) / d;
      const radius = Math.hypot(sx - cx, sy - cy);
      // Signed sweep from start → end going through mid.
      const startAngle = Math.atan2(sy - cy, sx - cx);
      const midAngle = Math.atan2(my - cy, mx - cx);
      const endAngle = Math.atan2(ey - cy, ex - cx);
      const normalize = (a: number): number => ((a - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const midNorm = normalize(midAngle);
      const endNorm = normalize(endAngle);
      // Sweep direction: if midNorm < endNorm, the mid sits before the end going CCW, so sweep is endNorm; else the full
      // arc goes the other way → 2π − endNorm.
      const sweep = midNorm < endNorm ? endNorm : 2 * Math.PI - endNorm;
      const arcLength = radius * sweep;
      return linear(entity.start, entity.end, upwardNormal(unit(entity.start, entity.end)), arcLength, pxMm, "ARC ");
    }
    return undefined;
  }
  // perimeter
  if (entity.kind === "rectangle") {
    const perimeter = 2 * (entity.widthMm + entity.heightMm);
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const axisY: Vec2 = [-Math.sin(radians), Math.cos(radians)];
    const corners = entityPoints(entity);
    return linear(corners[0]!, corners[1]!, [-axisY[0], -axisY[1]], perimeter, pxMm, "PERIM ");
  }
  if (entity.kind === "circle") {
    const circumference = 2 * Math.PI * entity.radiusMm;
    const angle = (55 * Math.PI) / 180;
    const direction: Vec2 = [Math.cos(angle), Math.sin(angle)];
    const near: Vec2 = [entity.center[0] - direction[0] * entity.radiusMm, entity.center[1] - direction[1] * entity.radiusMm];
    const far: Vec2 = [entity.center[0] + direction[0] * entity.radiusMm, entity.center[1] + direction[1] * entity.radiusMm];
    return {
      extensionLines: [],
      dimensionLine: { from: near, to: far },
      arrows: [{ tip: near, direction: [-direction[0], -direction[1]] }, { tip: far, direction }],
      textAt: [far[0] + direction[0] * 18 * pxMm, far[1] + direction[1] * 18 * pxMm],
      label: `PERIM ${formatDimensionLabelValue(circumference)}`
    };
  }
  return undefined;
}

const ANGLE_RADIUS_PX = 52;

type SketchLine = Extract<SketchEntity, { kind: "line" }>;

function wrapLabel(text: string, reference: boolean): string {
  return reference ? `(${text})` : text;
}

function arcPoint(center: Vec2, radius: number, angle: number): Vec2 {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

/** Where two infinite lines cross, or undefined when they are parallel. */
function lineCrossing(first: SketchLine, second: SketchLine): Vec2 | undefined {
  const d1: Vec2 = [first.end[0] - first.start[0], first.end[1] - first.start[1]];
  const d2: Vec2 = [second.end[0] - second.start[0], second.end[1] - second.start[1]];
  const denominator = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(denominator) < 1e-9 * Math.max(1, Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]))) return undefined;
  const t = ((second.start[0] - first.start[0]) * d2[1] - (second.start[1] - first.start[1]) * d2[0]) / denominator;
  return [first.start[0] + d1[0] * t, first.start[1] + d1[1] * t];
}

/** A dimension drawn along an arc of a circle: curved dimension line, arrows pointing outward along it at both ends. */
function arcDimension(center: Vec2, radius: number, fromRad: number, sweepRad: number, extensionLines: readonly DimensionSegment[], label: string, textPush: number, reference: boolean): DimensionLayout {
  const start = arcPoint(center, radius, fromRad);
  const end = arcPoint(center, radius, fromRad + sweepRad);
  const middle = fromRad + sweepRad / 2;
  const along = (angle: number): Vec2 => [-Math.sin(angle), Math.cos(angle)];
  const backwards = along(fromRad);
  return {
    arc: { center, radiusMm: radius, fromRad, sweepRad },
    reference,
    extensionLines,
    dimensionLine: { from: start, to: end },
    arrows: [{ tip: start, direction: [-backwards[0], -backwards[1]] }, { tip: end, direction: along(fromRad + sweepRad) }],
    textAt: arcPoint(center, radius + textPush, middle),
    label: wrapLabel(label, reference)
  };
}

/**
 * The angle dimension between two lines: an arc about the point where the lines cross (the middle between them when they are
 * parallel), swept counter-clockwise from the direction of `first` to the direction of `second`, with the value in degrees.
 * Lines that stop short of the crossing get a thin extension line out to it. `reference` draws a driven dimension in brackets.
 */
export function angleDimensionLayout(first: SketchLine, second: SketchLine, valueDeg: number, pxMm: number, reference = false): DimensionLayout | undefined {
  const firstDirection = unit(first.start, first.end);
  const crossing = lineCrossing(first, second);
  const middleOf = (line: SketchLine): Vec2 => [(line.start[0] + line.end[0]) / 2, (line.start[1] + line.end[1]) / 2];
  const vertex: Vec2 = crossing ?? [(middleOf(first)[0] + middleOf(second)[0]) / 2, (middleOf(first)[1] + middleOf(second)[1]) / 2];
  const radius = ANGLE_RADIUS_PX * pxMm;
  const extensions: DimensionSegment[] = [];
  if (crossing !== undefined) {
    for (const line of [first, second]) {
      const nearest = Math.hypot(line.start[0] - vertex[0], line.start[1] - vertex[1]) <= Math.hypot(line.end[0] - vertex[0], line.end[1] - vertex[1]) ? line.start : line.end;
      const gap = Math.hypot(nearest[0] - vertex[0], nearest[1] - vertex[1]);
      if (gap > 3 * pxMm) extensions.push({ from: nearest, to: vertex });
    }
  }
  return arcDimension(vertex, radius, Math.atan2(firstDirection[1], firstDirection[0]), (valueDeg * Math.PI) / 180, extensions, `${formatValue(valueDeg)}°`, 14 * pxMm, reference);
}

/** The arc-length dimension of a 3-point arc: a dimension arc standing off the arc, concentric with it. */
export function arcLengthDimensionLayout(arc: Extract<SketchEntity, { kind: "arc" }>, valueMm: number, pxMm: number, reference = false): DimensionLayout | undefined {
  const shape = arcShape(arc.start, arc.mid, arc.end);
  if (shape === undefined) return undefined;
  const first = shape.counterClockwise ? arc.start : arc.end;
  const from = Math.atan2(first[1] - shape.center[1], first[0] - shape.center[0]);
  const standOff = shape.radiusMm + DIMENSION_OFFSET_PX * pxMm;
  const reach = shape.radiusMm + (DIMENSION_OFFSET_PX + DIMENSION_OVERSHOOT_PX) * pxMm;
  const gapRadius = shape.radiusMm + DIMENSION_GAP_PX * pxMm;
  const extensions: DimensionSegment[] = [from, from + shape.sweepRad].map((angle) => ({ from: arcPoint(shape.center, gapRadius, angle), to: arcPoint(shape.center, reach, angle) }));
  return arcDimension(shape.center, standOff, from, shape.sweepRad, extensions, `⌒${formatDimensionLabelValue(valueMm)}`, 10 * pxMm, reference);
}

/** A perimeter dimension: a leader from the outline to a text label, since a closed outline has no two ends to dimension between. */
export function perimeterDimensionLayout(entity: SketchEntity, valueMm: number, pxMm: number, reference = false): DimensionLayout | undefined {
  let from: Vec2 | undefined;
  let outward: Vec2 = [1, 1];
  if (entity.kind === "circle") {
    outward = [Math.SQRT1_2, Math.SQRT1_2];
    from = [entity.center[0] + entity.radiusMm * outward[0], entity.center[1] + entity.radiusMm * outward[1]];
  } else if (entity.kind === "rectangle") {
    from = entityPoints(entity)[2];
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const x: Vec2 = [Math.cos(radians), Math.sin(radians)];
    const y: Vec2 = [-Math.sin(radians), Math.cos(radians)];
    outward = [(x[0] + y[0]) * Math.SQRT1_2, (x[1] + y[1]) * Math.SQRT1_2];
  } else if (entity.kind === "ellipse") {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    outward = [Math.cos(radians), Math.sin(radians)];
    from = [entity.center[0] + entity.majorRadiusMm * outward[0], entity.center[1] + entity.majorRadiusMm * outward[1]];
  }
  if (from === undefined) return undefined;
  const reach = 36 * pxMm;
  const to: Vec2 = [from[0] + outward[0] * reach, from[1] + outward[1] * reach];
  return {
    reference,
    extensionLines: [],
    dimensionLine: { from, to },
    arrows: [{ tip: from, direction: [-outward[0], -outward[1]] }],
    textAt: [to[0] + outward[0] * 18 * pxMm, to[1] + outward[1] * 18 * pxMm],
    label: wrapLabel(`P ${formatDimensionLabelValue(valueMm)}`, reference)
  };
}

/** The three points of an arrowhead: the tip, and the two back corners. */
export function arrowHead(arrow: DimensionArrow, pxMm: number): readonly [Vec2, Vec2, Vec2] {
  const length = 10 * pxMm;
  const half = 3.6 * pxMm;
  const [dx, dy] = arrow.direction;
  const back: Vec2 = [arrow.tip[0] - dx * length, arrow.tip[1] - dy * length];
  return [arrow.tip, [back[0] - dy * half, back[1] + dx * half], [back[0] + dy * half, back[1] - dx * half]];
}
