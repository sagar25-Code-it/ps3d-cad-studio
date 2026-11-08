import { describeDimension, describeExpressionError, EMPTY_EXPRESSION_ENVIRONMENT, evaluateExpression } from "./expressions.js";

/**
 * Typed lengths and the display unit.
 *
 * A project is stored in millimetres. The unit it is shown in (millimetres or inches) only changes how lengths are written and read:
 * a bare number typed into a dimension field means the display unit, and a number with a unit (`12 mm`, `1/2 in`, `3/4"`, `5' 3 1/2"`,
 * `25,4 mm`, `10 mil`) means exactly that, whatever the display unit is. The text is read by the expression engine, so fractions, mixed
 * numbers, brackets and the other units all work in the same way they do in a parameter.
 */
export type LengthUnit = "mm" | "in";

export const LENGTH_UNIT_MM: Readonly<Record<LengthUnit, number>> = { mm: 1, in: 25.4 };

export type LengthParse =
  | { readonly ok: true; readonly valueMm: number }
  | { readonly ok: false; readonly message: string };

function normalizeLengthText(text: string): string {
  let result = text.trim()
    .replace(/[“”″]/gu, '"')
    .replace(/[‘’′]/gu, "'")
    .replace(/µm/gu, "um")
    .replace(/ /gu, " ");
  // A comma between digits is a decimal comma when nothing else in the text uses commas (a function would): 25,4 mm.
  if (/^[-+]?\d+,\d+(?:\s*[A-Za-z"']+)?$/u.test(result)) result = result.replace(",", ".");
  return result;
}

/** Reads what a person typed as a length in millimetres. A bare number takes `defaultUnit`. */
export function parseLengthInput(text: string, defaultUnit: LengthUnit = "mm"): LengthParse {
  const normalized = normalizeLengthText(text);
  if (normalized === "") return { ok: false, message: "Type a length, like 12, 12 mm, 1/2 in or 3/4\"." };
  const evaluated = evaluateExpression(normalized, EMPTY_EXPRESSION_ENVIRONMENT);
  if (!evaluated.ok) return { ok: false, message: describeExpressionError(evaluated.error) };
  const quantity = evaluated.quantity;
  if (quantity.angle === 0 && quantity.length === 0) return { ok: true, valueMm: Number((quantity.value * LENGTH_UNIT_MM[defaultUnit]).toPrecision(12)) };
  if (quantity.angle === 0 && quantity.length === 1) return { ok: true, valueMm: quantity.value };
  return { ok: false, message: `A length is needed, but this gives ${describeDimension(quantity)}.` };
}

/** A length in millimetres as a number in the display unit. */
export function toDisplayLength(valueMm: number, unit: LengthUnit): number {
  return valueMm / LENGTH_UNIT_MM[unit];
}

export function lengthUnitSuffix(unit: LengthUnit): string {
  return unit === "in" ? " in" : " mm";
}

/** Writes a length for display: `25.4 mm`, or `1 in` (decimal inches), or with `fractions` the nearest 1/64: `1 1/2 in`. */
export function formatLength(valueMm: number, unit: LengthUnit, options: { readonly digits?: number; readonly fractions?: boolean } = {}): string {
  if (!Number.isFinite(valueMm)) return "-";
  const digits = options.digits ?? (unit === "in" ? 4 : 3);
  const shown = toDisplayLength(valueMm, unit);
  if (unit === "in" && options.fractions === true) {
    const sixtyFourths = Math.round(Math.abs(shown) * 64);
    const whole = Math.floor(sixtyFourths / 64);
    let numerator = sixtyFourths % 64;
    let denominator = 64;
    while (numerator > 0 && numerator % 2 === 0) { numerator /= 2; denominator /= 2; }
    const sign = shown < 0 && sixtyFourths > 0 ? "-" : "";
    const parts = [whole > 0 || numerator === 0 ? String(whole) : "", numerator === 0 ? "" : `${numerator}/${denominator}`].filter((part) => part !== "");
    return `${sign}${parts.join(" ")} in`;
  }
  return `${Number(shown.toFixed(digits))}${lengthUnitSuffix(unit)}`;
}
