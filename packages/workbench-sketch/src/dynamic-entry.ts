import { EMPTY_EXPRESSION_ENVIRONMENT, describeDimension, evaluateExpression, type Quantity, type Vec2 } from "../../workbench-core/src/index.js";
import { solveDynamicInput, type DynamicField, type DynamicFieldId, type DynamicValues } from "./dynamic-input.js";
import type { InferenceGuide } from "./inference.js";
import type { SketchTool } from "./index.js";

/**
 * What the user types into the dynamic-input fields, read the way the dimension editor reads it: plain numbers, units
 * (`12 mm`, `0.5 in`, `1/2in`, `45 deg`), expressions (`2*5`, `10+5`) and parameter names (`2*pin_r`) through the
 * expression engine of workbench-core. Absolute and relative coordinates take a prefix: `#12,5` is the point (12, 5) and
 * `@12,5` is 12 right and 5 up from the previous point; `#` and `@` also work in the X and Y fields on their own.
 *
 * Anything that cannot be read is an error that is shown on the field and stops the point from being placed: the old input
 * silently dropped it and placed the cursor's value instead.
 */

/** Evaluates a piece of text to a quantity. The studio passes one that knows the project's parameters. */
export type EvaluateText = (text: string) => { readonly ok: true; readonly quantity: Quantity } | { readonly ok: false; readonly message: string };

/** The evaluator for text with numbers, units and functions but no parameter names. */
export const plainEvaluator: EvaluateText = (text) => {
  const result = evaluateExpression(text, EMPTY_EXPRESSION_ENVIRONMENT);
  return result.ok ? result : { ok: false, message: result.error.message };
};

export type FieldParse =
  | { readonly ok: true; readonly value: number; readonly prefix: "" | "@" | "#" }
  | { readonly ok: false; readonly message: string };

const FRACTION_WITH_UNIT = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|in|deg|rad)$/;
const DECIMAL_COMMA = /^([+-]?\d*),(\d+)(\s*[a-zA-Z]*)$/;

/** The unit a bare number is read in: the document's. A length typed with a unit (`12 mm`, `0.5 in`) never depends on it. */
export type EntryUnit = "mm" | "in";
const MM_PER_INCH = 25.4;

/** A number written with both a comma and a point (1,000.5): neither a decimal comma nor something the expression engine can read. */
const COMMA_AND_POINT = /^[+-]?\d[\d,]*,\d[\d,]*\.\d+\s*[a-zA-Z]*$|^[+-]?\d+\.\d+,\d+/;

/** Makes `1/2in` mean half an inch (the engine reads it as one over two inches), `7,5 mm` seven and a half, and `45°` forty-five degrees. */
function friendlyText(rawText: string): string {
  const text = rawText.replace(/\s*[°º]/g, " deg");
  const fraction = FRACTION_WITH_UNIT.exec(text);
  if (fraction !== null) return `(${fraction[1]}/${fraction[2]})*1 ${fraction[3]}`;
  const comma = DECIMAL_COMMA.exec(text);
  if (comma !== null) return `${comma[1] === "" ? "0" : comma[1]}.${comma[2]}${comma[3] ?? ""}`;
  return text;
}

const KIND_WORDS: Readonly<Record<DynamicField["kind"], string>> = { length: "a length", angle: "an angle", coordinate: "a length" };

/**
 * Reads one field's text. A length or coordinate must come out as a length (a plain number is millimetres); an angle must
 * be an angle (a plain number is degrees). A `@` or `#` prefix is accepted on X and Y only (see parseCoordinatePair for pairs).
 */
export function parseFieldEntry(text: string, field: DynamicField, evaluate: EvaluateText = plainEvaluator, unit: EntryUnit = "mm"): FieldParse {
  let body = text.trim();
  let prefix: "" | "@" | "#" = "";
  if (body.startsWith("@") || body.startsWith("#")) {
    prefix = body[0] as "@" | "#";
    body = body.slice(1).trim();
    if (field.kind !== "coordinate") return { ok: false, message: `${prefix} only works in the X and Y fields, or as a pair such as ${prefix}12,5.` };
  }
  if (body === "" || body === "-" || body === "+") return { ok: false, message: `Type ${KIND_WORDS[field.kind]} for ${field.label.toLowerCase()}.` };
  if (COMMA_AND_POINT.test(body)) return { ok: false, message: `Write ${body.replace(/,(?=\d{3}(\D|$))/g, "")} without the thousands comma: a comma here is a decimal comma (7,5 is 7.5).` };
  const evaluated = evaluate(friendlyText(body));
  if (!evaluated.ok) return { ok: false, message: evaluated.message };
  const quantity = evaluated.quantity;
  const isScalar = quantity.length === 0 && quantity.angle === 0;
  if (field.kind === "angle") {
    if (!(isScalar || (quantity.angle === 1 && quantity.length === 0))) return { ok: false, message: `${field.label} needs an angle, not ${describeDimension(quantity)}.` };
  } else if (!(isScalar || (quantity.length === 1 && quantity.angle === 0))) {
    return { ok: false, message: `${field.label} needs a length, not ${describeDimension(quantity)}.` };
  }
  if (!Number.isFinite(quantity.value)) return { ok: false, message: `${field.label} is not a finite number.` };
  // A bare number is in the document's unit; the field is millimetres underneath, so a bare 2 in an inch document is 50.8.
  const bare = isScalar && field.kind !== "angle";
  return { ok: true, value: bare && unit === "in" ? quantity.value * MM_PER_INCH : quantity.value, prefix };
}

/**
 * Splits `a,b` or `a;b` at the separator that is not inside brackets. With a semicolon the commas are decimal commas (`#1,5;2,5`). Without
 * one the pair must have exactly one comma: a second comma used to be read as the decimal comma of the second number, so `#1,2,3` placed
 * the point (1, 2.3) without a word. Returns an error message when the separators are ambiguous.
 */
function splitPair(text: string): readonly [string, string] | { readonly error: string } | undefined {
  let depth = 0;
  const commas: number[] = [];
  const semicolons: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && character === ",") commas.push(index);
    else if (depth === 0 && character === ";") semicolons.push(index);
  }
  if (semicolons.length > 1) return { error: "A coordinate pair has one semicolon between X and Y, for example #1,5;2,5." };
  if (semicolons.length === 1) return [text.slice(0, semicolons[0]!), text.slice(semicolons[0]! + 1)];
  if (commas.length > 1) return { error: "A coordinate pair has one comma between X and Y. Write decimals with a point (#1.5,2.5), or separate X and Y with a semicolon when you use decimal commas (#1,5;2,5)." };
  if (commas.length === 1) return [text.slice(0, commas[0]!), text.slice(commas[0]! + 1)];
  return undefined;
}

export type PairParse =
  | { readonly ok: true; readonly x: number; readonly y: number; readonly relative: boolean }
  | { readonly ok: false; readonly message: string };

/** `#x,y` (absolute) or `@x,y` (relative to the previous point). Returns undefined when the text is not a coordinate pair at all. */
export function parseCoordinatePair(text: string, evaluate: EvaluateText = plainEvaluator, unit: EntryUnit = "mm"): PairParse | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("@") && !trimmed.startsWith("#")) return undefined;
  const relative = trimmed.startsWith("@");
  const split = splitPair(trimmed.slice(1));
  if (split === undefined) return undefined;
  if ("error" in split) return { ok: false, message: split.error };
  const pair = split;
  const xField: DynamicField = { id: "x", label: "X", unit: "mm", kind: "coordinate" };
  const yField: DynamicField = { id: "y", label: "Y", unit: "mm", kind: "coordinate" };
  const x = parseFieldEntry(pair[0], xField, evaluate, unit);
  if (!x.ok) return { ok: false, message: x.message };
  const y = parseFieldEntry(pair[1], yField, evaluate, unit);
  if (!y.ok) return { ok: false, message: y.message };
  return { ok: true, x: x.value, y: y.value, relative };
}

export interface DynamicEntryInput {
  readonly tool: SketchTool;
  readonly placed: readonly Vec2[];
  readonly cursor: Vec2;
  readonly fields: readonly DynamicField[];
  /** The text in each field; a missing or blank field follows the cursor. */
  readonly texts: Partial<Record<DynamicFieldId, string>>;
  readonly evaluate?: EvaluateText;
  /** What `@` is measured from when no point has been placed yet: the last point of the previous shape. Defaults to the origin. */
  readonly lastPoint?: Vec2;
  /** The document's unit: a bare number typed in a length field is in it (default millimetres). */
  readonly unit?: EntryUnit;
}

export type DynamicEntryResult =
  | {
      readonly ok: true;
      readonly point: Vec2;
      /** Things the input did that the user should be told: a negative size that was flipped, an angle that was wrapped. */
      readonly notes: readonly string[];
      readonly guides: readonly InferenceGuide[];
      readonly typed: DynamicValues;
    }
  | {
      readonly ok: false;
      /** One message per field that could not be used. */
      readonly errors: Partial<Record<DynamicFieldId, string>>;
      /** The sentence for the status line. */
      readonly message: string;
    };

/** The first problem in a set of per-field errors, as one sentence. */
function firstMessage(errors: Partial<Record<DynamicFieldId, string>>, fields: readonly DynamicField[]): string {
  for (const field of fields) {
    const message = errors[field.id];
    if (message !== undefined) return `${field.label}: ${message}`;
  }
  return "The typed input could not be used.";
}

/**
 * Reads every typed field and computes the point to place. Returns `ok: false` with a message per bad field when anything
 * typed cannot be read or does not give a valid shape; the caller must not place a point then.
 */
export function resolveDynamicEntry(input: DynamicEntryInput): DynamicEntryResult {
  const evaluate = input.evaluate ?? plainEvaluator;
  const reference: Vec2 = input.placed.at(-1) ?? input.lastPoint ?? [0, 0];
  const errors: Partial<Record<DynamicFieldId, string>> = {};
  const typed: DynamicValues = {};
  const typedFields = input.fields.filter((field) => (input.texts[field.id] ?? "").trim() !== "");

  // A coordinate pair in any field names the whole point.
  for (const field of typedFields) {
    const pair = parseCoordinatePair(input.texts[field.id]!, evaluate, input.unit ?? "mm");
    if (pair === undefined) continue;
    if (!pair.ok) return { ok: false, errors: { [field.id]: pair.message }, message: `${field.label}: ${pair.message}` };
    const point: Vec2 = pair.relative ? [reference[0] + pair.x, reference[1] + pair.y] : [pair.x, pair.y];
    return { ok: true, point: [Math.round(point[0] * 1e9) / 1e9, Math.round(point[1] * 1e9) / 1e9], notes: [`${pair.relative ? "Relative" : "Absolute"} coordinates (${formatEntryNumber(pair.x, input.unit ?? "mm")}, ${formatEntryNumber(pair.y, input.unit ?? "mm")}) ${input.unit ?? "mm"}.`], guides: [], typed: {} };
  }

  for (const field of typedFields) {
    const parsed = parseFieldEntry(input.texts[field.id]!, field, evaluate, input.unit ?? "mm");
    if (!parsed.ok) { errors[field.id] = parsed.message; continue; }
    let value = parsed.value;
    if (parsed.prefix === "@") value += field.id === "x" ? reference[0] : reference[1];
    typed[field.id] = value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors, message: firstMessage(errors, input.fields) };

  const solved = solveDynamicInput(input.tool, input.placed, input.cursor, typed);
  if (solved.point === undefined) {
    const failed = solved.errorFields ?? [];
    const named = failed.filter((id) => input.fields.some((field) => field.id === id));
    const fieldErrors: Partial<Record<DynamicFieldId, string>> = {};
    for (const id of named) fieldErrors[id] = solved.error ?? "Not usable.";
    return { ok: false, errors: fieldErrors, message: solved.error ?? "The typed input could not be used." };
  }
  return { ok: true, point: solved.point, notes: solved.notes, guides: solved.guides, typed };
}

/** Which fields currently hold text that cannot be read, for showing an error state while the user types. Blank fields are fine. */
export function fieldErrorsFor(fields: readonly DynamicField[], texts: Partial<Record<DynamicFieldId, string>>, evaluate: EvaluateText = plainEvaluator, unit: EntryUnit = "mm"): Partial<Record<DynamicFieldId, string>> {
  const errors: Partial<Record<DynamicFieldId, string>> = {};
  for (const field of fields) {
    const text = texts[field.id];
    if (text === undefined || text.trim() === "") continue;
    // A lone sign or prefix is a half-typed value, not yet an error.
    if (/^[-+@#]?$/.test(text.trim())) continue;
    const pair = parseCoordinatePair(text, evaluate, unit);
    if (pair !== undefined) { if (!pair.ok) errors[field.id] = pair.message; continue; }
    const parsed = parseFieldEntry(text, field, evaluate, unit);
    if (!parsed.ok) errors[field.id] = parsed.message;
  }
  return errors;
}

/** A millimetre value as the number shown in the document's unit (no unit symbol), trimmed of float dust. */
export function formatEntryNumber(valueMm: number, unit: EntryUnit): number {
  const shown = unit === "in" ? valueMm / MM_PER_INCH : valueMm;
  return Number(shown.toFixed(unit === "in" ? 4 : 3));
}

/** The unit a typed-input field is labelled with: lengths follow the document, angles stay in degrees. */
export function entryUnitLabel(field: Pick<DynamicField, "kind" | "unit">, unit: EntryUnit): string {
  return field.kind === "angle" ? field.unit : unit;
}
