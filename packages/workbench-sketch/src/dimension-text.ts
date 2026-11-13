import { parseLengthField, parseNumberField } from "./edit-fields.js";
import { parseAngleText, type SketchLengthUnit } from "./sketch-units.js";

/**
 * What a person typed into any dimension field: the canvas dimension editor and every inspector field (a length, a size, a distance
 * between things, an ellipse radius, an angle). One reader for all of them, so every field accepts the same three things:
 *
 *  - a plain value, with a unit if wanted (`12`, `12 mm`, `1/2 in`, `45` or `45°` for an angle),
 *  - a parameter name or an expression over them (`plate_w / 4`, `2 * pin_r + 1 mm`), which binds the dimension so it follows the
 *    parameter when that changes,
 *  - or nothing usable, which comes back with a message that says what to type.
 *
 * Whether an expression is right (the name exists, the result is a length, it is in range) is decided by the project, which knows the
 * parameters; this module only separates a number from an expression and checks a number's range.
 */
export type DimensionTextRead =
  | { readonly kind: "value"; /** Millimetres, or degrees for an angle. */ readonly value: number }
  | { readonly kind: "expression"; readonly expression: string }
  | { readonly kind: "invalid"; readonly message: string };

export interface DimensionTextOptions {
  readonly unit: SketchLengthUnit;
  /** An angle in degrees instead of a length. */
  readonly angle?: boolean;
  /** A distance between two things may be zero; a size may not. */
  readonly zeroAllowed?: boolean;
  /** What the field is called, for the message: "a distance", "the diameter". */
  readonly subject?: string;
}

/** Smallest and largest size a sketch can hold, in millimetres (the envelope limits the project enforces). */
export const DIMENSION_TEXT_MIN_MM = 0.01;
export const DIMENSION_TEXT_MAX_MM = 200_000;

export function readDimensionText(text: string, options: DimensionTextOptions): DimensionTextRead {
  const typed = text.trim();
  const given = options.subject ?? "a length";
  const subject = /^(a|an|the) /u.test(given) ? given : `the ${given}`;
  if (typed === "" || typed === "-" || typed === "+") {
    return { kind: "invalid", message: options.angle === true
      ? "Type the angle in degrees, or a parameter such as turn_angle / 2."
      : `Type ${subject} (for example 12 or 0.5 in), or a parameter such as plate_w / 4.` };
  }
  if (options.angle === true) {
    const plain = parseAngleText(typed);
    const value = plain ?? (Number.isFinite(parseNumberField(typed)) ? parseNumberField(typed) : undefined);
    if (value === undefined) return { kind: "expression", expression: typed };
    if (value < 0 || value >= 360) return { kind: "invalid", message: "Type an angle from 0 up to 360 degrees." };
    return { kind: "value", value };
  }
  const valueMm = parseLengthField(typed, options.unit);
  if (!Number.isFinite(valueMm)) return { kind: "expression", expression: typed };
  if (valueMm < 0) return { kind: "invalid", message: "A dimension cannot be negative. Type zero or more for a distance, more than zero for a size." };
  if (valueMm === 0 && options.zeroAllowed !== true) return { kind: "invalid", message: "Type a size greater than zero." };
  if (valueMm > 0 && valueMm < DIMENSION_TEXT_MIN_MM) return { kind: "invalid", message: `The smallest size a sketch can hold is ${DIMENSION_TEXT_MIN_MM} mm. Type a larger value.` };
  if (valueMm > DIMENSION_TEXT_MAX_MM) return { kind: "invalid", message: "The largest sketch size is 200,000 mm (200 m). Type a smaller value." };
  return { kind: "value", value: valueMm };
}

/** Whether a dimension name may be zero when it is a distance between two things (a hole on the axis is 0 from it). */
export function dimensionAllowsZero(dimension: string): boolean {
  return dimension === "aligned" || dimension === "horizontal" || dimension === "vertical" || dimension === "point-line" || dimension === "line-line";
}

/**
 * Puts `insert` into the text of a value editor where the selection is: it replaces what is selected (the whole value, when the
 * editor has just opened) or goes in at the caret. Used when a dimension is clicked while another is being edited, to write its
 * name. Returns the new text and where the caret goes.
 */
export function insertAtSelection(text: string, selectionStart: number | null, selectionEnd: number | null, insert: string): { readonly text: string; readonly caret: number } {
  const start = Math.max(0, Math.min(selectionStart ?? text.length, text.length));
  const end = Math.max(start, Math.min(selectionEnd ?? start, text.length));
  return { text: `${text.slice(0, start)}${insert}${text.slice(end)}`, caret: start + insert.length };
}
