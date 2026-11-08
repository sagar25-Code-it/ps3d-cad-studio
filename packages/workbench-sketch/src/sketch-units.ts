/**
 * Display units for the sketch. The sketch itself is always stored in millimetres; this module only converts what the person reads
 * and types. A bare number is in the document's display unit (millimetres or inches), and a typed unit suffix ("12 mm", "0.5in", `2"`)
 * wins over it, so an inch-based designer can type a metric value and the other way round.
 */

export type SketchLengthUnit = "mm" | "in";

const MM_PER_UNIT: Readonly<Record<string, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export function mmToUnit(valueMm: number, unit: SketchLengthUnit): number {
  return valueMm / (MM_PER_UNIT[unit] ?? 1);
}

export function unitToMm(value: number, unit: SketchLengthUnit): number {
  return value * (MM_PER_UNIT[unit] ?? 1);
}

/** A length as text in the display unit, without the unit symbol: 25.4 mm reads "1" in inches. Trailing zeros are dropped. */
export function formatLength(valueMm: number, unit: SketchLengthUnit, digits = unit === "in" ? 4 : 3): string {
  return String(Number(mmToUnit(valueMm, unit).toFixed(digits)));
}

/** A length with its unit symbol: "25.4 mm" or "1 in". */
export function formatLengthWithUnit(valueMm: number, unit: SketchLengthUnit, digits?: number): string {
  return `${formatLength(valueMm, unit, digits)} ${unit}`;
}

/** The unit word for labels and accessible names: "millimetres" or "inches". */
export function unitWord(unit: SketchLengthUnit): string {
  return unit === "in" ? "inches" : "millimetres";
}

const LENGTH_TEXT = /^\s*(-?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(mm|cm|m|in|ft|"|')?\s*$/iu;

/**
 * Reads a typed length and returns millimetres, or undefined when the text is not a plain number with an optional unit (an
 * expression such as `plate_w / 2` is left to the expression parser). A comma is accepted as the decimal separator.
 */
export function parseLengthText(text: string, defaultUnit: SketchLengthUnit): number | undefined {
  const match = LENGTH_TEXT.exec(text);
  if (match === null) return undefined;
  const number = Number((match[1] ?? "").replace(",", "."));
  if (!Number.isFinite(number)) return undefined;
  const suffix = (match[2] ?? "").toLowerCase();
  const unit = suffix === "" ? defaultUnit : suffix === '"' ? "in" : suffix === "'" ? "ft" : suffix;
  const perUnit = MM_PER_UNIT[unit];
  return perUnit === undefined ? undefined : number * perUnit;
}

const ANGLE_TEXT = /^\s*(-?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(°|deg|degrees?)?\s*$/iu;

/** Reads a typed angle in degrees; a trailing ° or "deg" is accepted. */
export function parseAngleText(text: string): number | undefined {
  const match = ANGLE_TEXT.exec(text);
  if (match === null) return undefined;
  const value = Number((match[1] ?? "").replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

// The dimension labels drawn on the canvas are built deep inside dimension-layout.ts; this is the one place they learn the display unit.
let labelUnit: SketchLengthUnit = "mm";

export function setDimensionLabelUnit(unit: SketchLengthUnit): void {
  labelUnit = unit;
}

/** A dimension label's number in the unit set by `setDimensionLabelUnit` (millimetres by default). */
export function formatDimensionLabelValue(valueMm: number): string {
  return formatLength(valueMm, labelUnit, 3);
}

/** The unit the descriptions and dimension labels are written in right now (millimetres until the workspace says otherwise). */
export function getDimensionLabelUnit(): SketchLengthUnit {
  return labelUnit;
}

/** A length in millimetres as text with its unit in the current label unit: "25.4 mm" or "1 in". For status lines, titles and tooltips. */
export function describeLength(valueMm: number, digits = 3): string {
  return formatLengthWithUnit(valueMm, labelUnit, labelUnit === "in" ? Math.max(digits, 4) : digits);
}

/** The same without the symbol, for lists such as "from 0, 0 to 25, 0". */
export function describeLengthNumber(valueMm: number, digits = 2): string {
  return formatLength(valueMm, labelUnit, labelUnit === "in" ? Math.max(digits, 4) : digits);
}

/** "millimetres" or "inches" in the current label unit, for spoken text. */
export function describeUnitWord(): string {
  return unitWord(labelUnit);
}
