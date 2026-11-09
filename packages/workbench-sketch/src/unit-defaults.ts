import { parseLengthInput } from "../../workbench-core/src/index.js";
import { gridSteps } from "./camera.js";
import { SNAP_STEP_CHOICES } from "./snap-assist.js";
import { formatLength, formatLengthWithUnit, mmToUnit, unitToMm, type SketchLengthUnit } from "./sketch-units.js";

/**
 * What an inch document gets in place of the metric numbers the sketch environment was built around: the grid, the snap steps, the starting
 * values of the edit panels and the option fields. A millimetre document is unchanged. The sketch is stored in millimetres either way; these
 * only choose which round numbers the person sees and snaps to.
 */

const MM_PER_INCH = 25.4;

/** The base grid of an inch document: a tenth of an inch, which gives the 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5 inch ladder. */
export const INCH_GRID_BASE_MM = 0.1 * MM_PER_INCH;

/** The metric base grid the sketch starts with (a sketch that kept it has no grid of its own in inches). */
const METRIC_DEFAULT_GRID_MM = 5;

/** The snap steps an inch document offers besides "follow the grid", in inches. */
export const SNAP_STEP_CHOICES_INCH: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.0625, 0.1, 0.125, 0.25, 0.5, 1];

/**
 * Minor and major grid spacing in millimetres for the document's unit. Millimetres keep the 1-2-5 ladder from the sketch's own grid.
 * Inches use a decimal-inch ladder; a grid the person set themselves in an inch document is kept, converted.
 */
export function gridStepsForUnit(baseMm: number, mmPerPx: number, unit: SketchLengthUnit, minPixels = 14): { readonly minorMm: number; readonly majorMm: number } {
  if (unit === "mm") return gridSteps(baseMm, mmPerPx, minPixels);
  const base = Math.abs(baseMm - METRIC_DEFAULT_GRID_MM) < 1e-9 ? INCH_GRID_BASE_MM : baseMm;
  // gridSteps is unit-free: fed inches it answers in inches.
  const inches = gridSteps(mmToUnit(base, "in"), mmToUnit(mmPerPx, "in"), minPixels);
  return { minorMm: unitToMm(inches.minorMm, "in"), majorMm: unitToMm(inches.majorMm, "in") };
}

/** The snap steps the palette lists, in millimetres, for the document's unit. */
export function snapStepChoicesMm(unit: SketchLengthUnit): readonly number[] {
  return unit === "in" ? SNAP_STEP_CHOICES_INCH.map((step) => Number((step * MM_PER_INCH).toPrecision(12))) : SNAP_STEP_CHOICES;
}

/** A length with its unit for a label: `0.0625 in`, `5 mm`. */
export function labelLength(valueMm: number, unit: SketchLengthUnit): string {
  return formatLengthWithUnit(valueMm, unit, unit === "in" ? 4 : 3);
}

const INCH_NICE_STEPS: readonly number[] = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 6, 12, 24];

/**
 * A starting value for a field. A millimetre document keeps the metric default; an inch document gets the round inch size nearest to it
 * (2 mm becomes 1/16 in, 5 mm 1/4 in, 10 mm 1/2 in), so a field does not open on 0.1969 in.
 */
export function defaultLengthMm(metricMm: number, unit: SketchLengthUnit): number {
  if (unit === "mm" || !(metricMm > 0)) return metricMm;
  const inches = metricMm / MM_PER_INCH;
  let best = INCH_NICE_STEPS[0]!;
  for (const step of INCH_NICE_STEPS) if (Math.abs(Math.log(step / inches)) < Math.abs(Math.log(best / inches))) best = step;
  return Number((best * MM_PER_INCH).toPrecision(12));
}

/** The starting text of a length field for a metric default, in the document's unit. */
export function defaultLengthText(metricMm: number, unit: SketchLengthUnit): string {
  return formatLength(defaultLengthMm(metricMm, unit), unit, unit === "in" ? 4 : 3);
}

/** A length kept in millimetres as text, shown in the document's unit (a field that is not a number is returned as it is). */
export function lengthTextToDisplay(textMm: string, unit: SketchLengthUnit): string {
  if (unit === "mm" || textMm.trim() === "") return textMm;
  const value = Number(textMm.trim().replace(",", "."));
  return Number.isFinite(value) ? String(Number(mmToUnit(value, unit).toFixed(5))) : textMm;
}

/** What was typed in the document's unit, as text in millimetres for the stored option (not a number: returned as it is). */
export function lengthTextFromDisplay(text: string, unit: SketchLengthUnit): string {
  if (unit === "mm" || text.trim() === "") return text;
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) ? String(Number(unitToMm(value, unit).toPrecision(10))) : text;
}

export type PlaneOffsetRead = { readonly ok: true; readonly valueMm: number } | { readonly ok: false; readonly message: string };

/** The offset of a sketch plane as the text the dialog starts with. */
export function planeOffsetText(offsetMm: number, unit: SketchLengthUnit): string {
  return formatLength(offsetMm, unit, unit === "in" ? 4 : 3);
}

/** Reads the dialog's offset: a bare number is in the document's unit, a number with a unit (0.5 in, 12 mm) is exactly that. Empty is 0. */
export function readPlaneOffset(text: string, unit: SketchLengthUnit): PlaneOffsetRead {
  if (text.trim() === "") return { ok: true, valueMm: 0 };
  const read = parseLengthInput(text, unit);
  if (!read.ok) return { ok: false, message: `The offset ${read.message.charAt(0).toLowerCase()}${read.message.slice(1)}` };
  if (Math.abs(read.valueMm) > 100_000) return { ok: false, message: `The offset must be within ±${unit === "in" ? "3937 inches" : "100000 mm"}.` };
  return { ok: true, valueMm: read.valueMm };
}

/** The sketch's base grid as a label ("5 mm", "0.1 in"): an inch document shows its inch base, not the metric 5 mm converted to 0.1969 in. */
export function baseGridLabel(gridMm: number, unit: SketchLengthUnit): string {
  return labelLength(unit === "in" && Math.abs(gridMm - METRIC_DEFAULT_GRID_MM) < 1e-9 ? INCH_GRID_BASE_MM : gridMm, unit);
}
