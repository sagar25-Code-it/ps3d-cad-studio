import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { DIMENSION_OFFSET_PX, type DimensionLayout } from "./dimension-layout.js";

/**
 * How dimensions are written and placed on the sketch canvas (audit Sketch edit E24): a precision and a unit for the label, a
 * value editor that starts from the exact stored number rather than a rounded one, stacking so two dimensions on one curve do
 * not overlap, and a stand-off the person can change by dragging the label.
 */
export type DimensionUnit = "mm" | "in";

export interface DimensionDisplaySettings {
  readonly unit: DimensionUnit;
  /** Decimal places shown on the canvas, 0 to 6. */
  readonly precision: number;
  readonly showUnit: boolean;
}

export const DEFAULT_DIMENSION_DISPLAY: DimensionDisplaySettings = { unit: "mm", precision: 2, showUnit: true };

export const MM_PER_INCH = 25.4;
export const MIN_DIMENSION_PRECISION = 0;
export const MAX_DIMENSION_PRECISION = 6;

export function clampPrecision(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DIMENSION_DISPLAY.precision;
  return Math.min(MAX_DIMENSION_PRECISION, Math.max(MIN_DIMENSION_PRECISION, Math.round(value)));
}

/** A length in millimetres as label text: "25.40 mm", or "1.000 in" when the unit is inches. Tiny non-zero values never round to "0". */
export function formatLengthLabel(valueMm: number, settings: DimensionDisplaySettings = DEFAULT_DIMENSION_DISPLAY): string {
  const precision = clampPrecision(settings.precision);
  const shown = settings.unit === "in" ? valueMm / MM_PER_INCH : valueMm;
  let text = shown.toFixed(precision);
  // A value that is not zero but would print as zero keeps its first significant digits, so 0.0004 does not read as 0.
  if (shown !== 0 && Number(text) === 0) text = Number(shown.toPrecision(2)).toString();
  if (text === "-0" || /^-0(\.0+)?$/u.test(text)) text = text.slice(1);
  return settings.showUnit ? `${text} ${settings.unit}` : text;
}

export function formatAngleLabel(valueDeg: number, settings: DimensionDisplaySettings = DEFAULT_DIMENSION_DISPLAY): string {
  const precision = clampPrecision(settings.precision);
  return `${valueDeg.toFixed(precision)}°`;
}

/** The text the value editor starts with: the stored number to full precision, so pressing Enter without typing changes nothing. */
export function dimensionEditText(valueMm: number, settings: DimensionDisplaySettings = DEFAULT_DIMENSION_DISPLAY): string {
  const shown = settings.unit === "in" ? valueMm / MM_PER_INCH : valueMm;
  return String(Number(shown.toPrecision(12)));
}

/**
 * Converts what was typed in the editor to millimetres. A bare number is in the display unit; an explicit "mm" or "in" suffix
 * always wins. Returns undefined for text that is not a number with an optional unit (expressions are handled by the caller).
 */
export function parseDimensionInput(text: string, settings: DimensionDisplaySettings = DEFAULT_DIMENSION_DISPLAY): number | undefined {
  const match = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?)\s*(mm|in|inch|inches|")?\s*$/iu.exec(text);
  if (match === null) return undefined;
  const number = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(number)) return undefined;
  const unit = match[2]?.toLowerCase();
  const inches = unit === undefined ? settings.unit === "in" : unit !== "mm";
  return inches ? number * MM_PER_INCH : number;
}

/** True when typed text means the stored value, so the editor can close without re-driving the geometry. */
export function sameDimensionValue(typedMm: number, storedMm: number): boolean {
  return Math.abs(typedMm - storedMm) <= Math.max(1e-9, Math.abs(storedMm) * 1e-12);
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

export const MIN_DIMENSION_OFFSET_PX = 12;
export const MAX_DIMENSION_OFFSET_PX = 400;
export const STACK_STEP_PX = 24;

export function clampOffsetPx(value: number): number {
  if (!Number.isFinite(value)) return DIMENSION_OFFSET_PX;
  return Math.min(MAX_DIMENSION_OFFSET_PX, Math.max(MIN_DIMENSION_OFFSET_PX, value));
}

/** Label box in screen pixels for overlap tests; the width follows the text length. */
export function labelBoxPx(label: string): { readonly width: number; readonly height: number } {
  return { width: label.length * 7.4 + 12, height: 20 };
}

interface Box { readonly cx: number; readonly cy: number; readonly width: number; readonly height: number }

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.cx - b.cx) * 2 < a.width + b.width && Math.abs(a.cy - b.cy) * 2 < a.height + b.height;
}

export interface StackRequest {
  readonly id: string;
  /** Lays the dimension out at a stand-off in pixels; returns undefined when it cannot be drawn. */
  readonly layoutAt: (offsetPx: number) => DimensionLayout | undefined;
  /** The stand-off the person chose by dragging, if any. A dragged dimension is never moved by stacking. */
  readonly userOffsetPx?: number | undefined;
}

export interface StackedDimension {
  readonly id: string;
  readonly offsetPx: number;
  readonly layout: DimensionLayout;
}

/**
 * Chooses a stand-off for every dimension so that no two labels overlap. Dimensions the person placed keep their stand-off and
 * are laid out first; the others start at the default and move outward by one step at a time until their label is clear
 * (at most eight steps, so a pathological sketch cannot loop). Deterministic: the result depends only on the input order.
 */
export function stackDimensionLabels(requests: readonly StackRequest[], mmPerPx: number): readonly StackedDimension[] {
  const px = mmPerPx > 0 ? mmPerPx : 1;
  const placedBoxes: Box[] = [];
  const results = new Map<string, StackedDimension>();
  const toBox = (layout: DimensionLayout): Box => {
    const size = labelBoxPx(layout.label);
    return { cx: layout.textAt[0] / px, cy: layout.textAt[1] / px, width: size.width, height: size.height };
  };
  const ordered = [...requests].sort((a, b) => (a.userOffsetPx === undefined ? 1 : 0) - (b.userOffsetPx === undefined ? 1 : 0));
  for (const request of ordered) {
    if (request.userOffsetPx !== undefined) {
      const offsetPx = clampOffsetPx(request.userOffsetPx);
      const layout = request.layoutAt(offsetPx);
      if (layout === undefined) continue;
      placedBoxes.push(toBox(layout));
      results.set(request.id, { id: request.id, offsetPx, layout });
      continue;
    }
    let offsetPx = DIMENSION_OFFSET_PX;
    let layout = request.layoutAt(offsetPx);
    if (layout === undefined) continue;
    for (let step = 0; step < 8 && placedBoxes.some((box) => overlaps(box, toBox(layout!))); step += 1) {
      offsetPx += STACK_STEP_PX;
      const next = request.layoutAt(offsetPx);
      if (next === undefined) break;
      layout = next;
    }
    placedBoxes.push(toBox(layout));
    results.set(request.id, { id: request.id, offsetPx, layout });
  }
  return requests.flatMap((request) => results.get(request.id) ?? []);
}

/** Unit vector from the geometry towards the dimension line, read off a layout that has extension lines. */
export function dimensionNormal(layout: DimensionLayout): Vec2 | undefined {
  const extension = layout.extensionLines[0];
  if (extension === undefined) return undefined;
  const dx = layout.dimensionLine.from[0] - extension.from[0];
  const dy = layout.dimensionLine.from[1] - extension.from[1];
  const length = Math.hypot(dx, dy);
  return length < 1e-12 ? undefined : [dx / length, dy / length];
}

/** True when the dimension has a stand-off the person can change (extension lines show it); a diameter or angle does not. */
export function isRepositionable(layout: DimensionLayout): boolean {
  return dimensionNormal(layout) !== undefined;
}

/**
 * The stand-off after dragging a dimension label from `startMm` to `pointerMm`: the drag along the dimension's normal is added
 * to the stand-off it started with, clamped so the label can neither sink into the geometry nor fly off the sheet.
 */
export function dragDimensionOffset(layout: DimensionLayout, startOffsetPx: number, startMm: Vec2, pointerMm: Vec2, mmPerPx: number): number {
  const normal = dimensionNormal(layout);
  if (normal === undefined || mmPerPx <= 0) return startOffsetPx;
  const along = ((pointerMm[0] - startMm[0]) * normal[0] + (pointerMm[1] - startMm[1]) * normal[1]) / mmPerPx;
  return clampOffsetPx(startOffsetPx + along);
}

// ---------------------------------------------------------------------------------------------
// Remembering the choices
// ---------------------------------------------------------------------------------------------

export type DimensionOffsets = Readonly<Record<string, number>>;

export function serializeDimensionOffsets(offsets: DimensionOffsets): string {
  return JSON.stringify(Object.fromEntries(Object.entries(offsets).filter(([, value]) => Number.isFinite(value)).map(([id, value]) => [id, Math.round(clampOffsetPx(value) * 10) / 10])));
}

export function parseDimensionOffsets(text: string | null | undefined): DimensionOffsets {
  if (text === null || text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])).map(([id, offset]) => [id, clampOffsetPx(offset)]));
  } catch {
    return {};
  }
}

export function parseDimensionDisplay(text: string | null | undefined): DimensionDisplaySettings {
  if (text === null || text === undefined) return DEFAULT_DIMENSION_DISPLAY;
  try {
    const value = JSON.parse(text) as { readonly unit?: unknown; readonly precision?: unknown; readonly showUnit?: unknown };
    return {
      unit: value.unit === "in" ? "in" : "mm",
      precision: typeof value.precision === "number" ? clampPrecision(value.precision) : DEFAULT_DIMENSION_DISPLAY.precision,
      showUnit: typeof value.showUnit === "boolean" ? value.showUnit : true
    };
  } catch {
    return DEFAULT_DIMENSION_DISPLAY;
  }
}

/** The driving dimension a click on this curve should open: the edge nearer to the click for a rectangle, the diameter for a circle. */
export function dimensionForClick(entity: SketchEntity, clickMm: Vec2): "length" | "width" | "height" | "radius" | undefined {
  if (entity.kind === "line") return "length";
  if (entity.kind === "circle") return "radius";
  if (entity.kind === "rectangle") {
    const radians = (entity.rotationDeg * Math.PI) / 180;
    const dx = clickMm[0] - entity.center[0];
    const dy = clickMm[1] - entity.center[1];
    const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
    const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
    return Math.abs(Math.abs(localY) - entity.heightMm / 2) <= Math.abs(Math.abs(localX) - entity.widthMm / 2) ? "width" : "height";
  }
  return undefined;
}
