/**
 * Drag maths for an on-view manipulator (the arrow a command shows on the picked face or edge). Everything here is pure: the
 * viewport adapter feeds it screen positions, and the studio turns the result into the panel field's number. Nothing in this
 * file knows about three.js, the DOM or the command panel, so every rule below is covered by plain tests.
 *
 * The idea: an arrow starts at an anchor and points along a direction in the model. Dragging the knob moves the pointer on
 * the screen; the part of that move that lies along the arrow's picture on the screen, divided by how many pixels one
 * millimetre of travel takes up there, is the distance the knob travelled in the model.
 */

export type Pixel = readonly [number, number];
export type Mm3 = readonly [number, number, number];

/** The arrow as the screen sees it, measured once when a drag starts and kept for the whole drag so the arrow moving does not feed back. */
export interface HandleScreenAxis {
  /** Where the arrow starts and where its knob is, in the same pixel space as the pointer. */
  readonly anchorPx: Pixel;
  readonly tipPx: Pixel;
  /** The picture of the arrow's direction on the screen: a unit vector, or [0, 0] when the arrow points straight at the viewer. */
  readonly unitPx: Pixel;
  /** Pixels covered on the screen by one millimetre of travel along the arrow at its tip. */
  readonly pxPerMm: number;
  /** True when the arrow points (nearly) along the line of sight: its picture is too short to drag by, so the handle is not offered. */
  readonly degenerate: boolean;
}

/** An arrow whose picture is shorter than this share of a full-length one (foreshortened more than ~80%) is end-on and cannot be dragged. */
export const END_ON_RATIO = 0.2;

/**
 * Projects the arrow with the viewport's own projection. `project` maps a model point (mm) to a pixel; `referencePxPerMm` is how
 * many pixels one millimetre takes at the arrow's tip when it lies flat to the screen (the caller measures it with the camera's
 * right vector), so end-on arrows can be told from flat ones in both perspective and orthographic views.
 */
export function projectHandleAxis(
  project: (pointMm: Mm3) => Pixel,
  anchorMm: Mm3,
  directionMm: Mm3,
  tipDistanceMm: number,
  referencePxPerMm: number
): HandleScreenAxis {
  const unit = normalize3(directionMm);
  const at = (distance: number): Mm3 => [anchorMm[0] + unit[0] * distance, anchorMm[1] + unit[1] * distance, anchorMm[2] + unit[2] * distance];
  const anchorPx = project(anchorMm);
  const tipPx = project(at(tipDistanceMm));
  const beyond = project(at(tipDistanceMm + 1));
  const stepX = beyond[0] - tipPx[0];
  const stepY = beyond[1] - tipPx[1];
  const pxPerMm = Math.hypot(stepX, stepY);
  const ok = Number.isFinite(pxPerMm) && pxPerMm > 1e-9 && Number.isFinite(referencePxPerMm) && referencePxPerMm > 0 && pxPerMm >= END_ON_RATIO * referencePxPerMm && (unit[0] !== 0 || unit[1] !== 0 || unit[2] !== 0);
  return {
    anchorPx, tipPx,
    unitPx: ok ? [stepX / pxPerMm, stepY / pxPerMm] : [0, 0],
    pxPerMm: ok ? pxPerMm : 0,
    degenerate: !ok
  };
}

/** Distance from a point to the segment a-b, in pixels. */
export function pointToSegmentPx(point: Pixel, a: Pixel, b: Pixel): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lengthSquared = abx * abx + aby * aby;
  const t = lengthSquared < 1e-12 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + abx * t), point[1] - (a[1] + aby * t));
}

export interface HandleHitOptions {
  /** Radius of the round knob at the tip that grabs the handle. */
  readonly knobPx?: number;
  /** How far from the shaft a press still grabs it. */
  readonly shaftPx?: number;
  /** The first part of the shaft next to the anchor is left to the model, so the edge the arrow stands on stays pickable. */
  readonly anchorGapPx?: number;
}

/** Does a press at `point` grab the handle? The knob and the outer shaft do; the stretch next to the anchor does not. Degenerate arrows never do. */
export function hitHandle(axis: HandleScreenAxis, point: Pixel, options: HandleHitOptions = {}): boolean {
  if (axis.degenerate) return false;
  const knob = options.knobPx ?? 12;
  const shaft = options.shaftPx ?? 6;
  const gap = options.anchorGapPx ?? 14;
  if (Math.hypot(point[0] - axis.tipPx[0], point[1] - axis.tipPx[1]) <= knob) return true;
  const length = Math.hypot(axis.tipPx[0] - axis.anchorPx[0], axis.tipPx[1] - axis.anchorPx[1]);
  if (length <= gap) return false;
  const start: Pixel = [axis.anchorPx[0] + (axis.tipPx[0] - axis.anchorPx[0]) * (gap / length), axis.anchorPx[1] + (axis.tipPx[1] - axis.anchorPx[1]) * (gap / length)];
  return pointToSegmentPx(point, start, axis.tipPx) <= shaft;
}

/** How far the knob has travelled along the arrow, in mm (negative = back towards the anchor), for a pointer that moved `deltaPx` since the press. */
export function deltaMmFromDrag(axis: HandleScreenAxis, deltaPx: Pixel): number {
  if (axis.degenerate || axis.pxPerMm <= 0) return 0;
  return (deltaPx[0] * axis.unitPx[0] + deltaPx[1] * axis.unitPx[1]) / axis.pxPerMm;
}

export interface HandleValueRule {
  /** The field's number when the drag began. */
  readonly startValue: number;
  /** How much the field changes for 1 mm of knob travel (1 for a distance; 0.5 where the arrow shows a radius for a diameter field). */
  readonly valuePerMm: number;
  /** Smallest and largest value the field accepts (the smallest is exclusive when `exclusiveMin`). */
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: boolean;
  /** Round to this step (the drag moves in tenths of a mm, say); Shift passes a finer one. */
  readonly step?: number;
}

/** The field's new number for a knob that travelled `deltaMm`: scaled, snapped to the step and held inside the limits. Never NaN. */
export function valueFromDrag(rule: HandleValueRule, deltaMm: number): number {
  const raw = rule.startValue + (Number.isFinite(deltaMm) ? deltaMm : 0) * rule.valuePerMm;
  const step = rule.step !== undefined && rule.step > 0 ? rule.step : 0;
  let value = step > 0 ? Math.round(raw / step) * step : raw;
  const floor = rule.min === undefined ? -Infinity : rule.min;
  // "More than the minimum" means one step above it (or a thousandth when there is no step), so a radius never drags down to 0.
  const smallest = rule.exclusiveMin === true ? floor + (step > 0 ? step : 1e-3) : floor;
  if (rule.max !== undefined && value > rule.max) value = rule.max;
  if (value < smallest) value = smallest;
  return Number(value.toFixed(6));
}

function normalize3(value: Mm3): Mm3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length < 1e-12 ? [0, 0, 0] : [value[0] / length, value[1] / length, value[2] / length];
}
