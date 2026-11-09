import { parseLengthInput } from "../../workbench-core/src/index.js";
import { formatLength, type SketchLengthUnit } from "./sketch-units.js";

/**
 * Reading what a person typed into the number fields of the edit and pattern panels, in the unit the document is shown in.
 *
 * A length field takes a bare number in the document's unit (inches in an inch document), or a number with a unit that wins over it
 * (`10mm`, `0.5 in`, `1/2"`), a fraction, an expression of numbers, and either a decimal comma (`12,5`) or a thousands comma written
 * with a decimal point (`1,000.5`). A plain number field (a count, an angle, a factor) takes the same number forms and a trailing
 * degree sign. Anything else is NaN, never 0, so a half-typed field blocks the edit instead of applying a default.
 */

/** `1,000.5` is a thousand and a half; `12,5` is twelve and a half (decimal comma). */
function separated(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes(",") && trimmed.includes(".") && trimmed.indexOf(",") < trimmed.indexOf(".")) return trimmed.replace(/,/g, "");
  return /^[+-]?\d+,\d+(\s*[a-zA-Z"']*)$/u.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
}

/** A count, an angle or a factor. NaN when the text is empty or not a number. */
export function parseNumberField(text: string): number {
  const cleaned = separated(text).replace(/\s*(°|deg|degrees?|×|x)$/iu, "");
  if (cleaned === "") return Number.NaN;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** A length in millimetres from text typed in `unit` (a bare number is in `unit`). NaN when the text is not a length. */
export function parseLengthField(text: string, unit: SketchLengthUnit): number {
  const cleaned = separated(text);
  if (cleaned === "") return Number.NaN;
  const read = parseLengthInput(cleaned, unit);
  return read.ok && Number.isFinite(read.valueMm) ? read.valueMm : Number.NaN;
}

/** A length in millimetres as the text a field starts with, in `unit`. */
export function formatLengthField(valueMm: number, unit: SketchLengthUnit): string {
  return formatLength(valueMm, unit, unit === "in" ? 4 : 3);
}

/** A field's text moved from one unit to the other (a bare number keeps its value in millimetres); text that is not a length is left alone. */
export function convertLengthField(text: string, from: SketchLengthUnit, to: SketchLengthUnit): string {
  if (from === to) return text;
  const valueMm = parseLengthField(text, from);
  return Number.isFinite(valueMm) ? formatLengthField(valueMm, to) : text;
}
