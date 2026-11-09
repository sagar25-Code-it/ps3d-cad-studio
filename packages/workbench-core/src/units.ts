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

const VULGAR_FRACTIONS: Readonly<Record<string, string>> = {
  "\u00bd": "1/2", "\u00bc": "1/4", "\u00be": "3/4", "\u2153": "1/3", "\u2154": "2/3", "\u215b": "1/8", "\u215c": "3/8", "\u215d": "5/8", "\u215e": "7/8",
  "\u2155": "1/5", "\u2156": "2/5", "\u2157": "3/5", "\u2158": "4/5", "\u2159": "1/6", "\u215a": "5/6"
};

function normalizeLengthText(text: string, defaultUnit: LengthUnit): string {
  let result = text.trim()
    .replace(/[\u201c\u201d\u2033]/gu, '"')
    .replace(/[\u2018\u2019\u2032]/gu, "'")
    .replace(/\u00b5m/gu, "um")
    .replace(/\u00a0/gu, " ");
  // A vulgar fraction is a fraction, and one straight after a whole number makes a mixed number: 1<half> in is 1 1/2 in.
  result = result.replace(/(\d)?\s*([\u00bc-\u00be\u2153-\u215e])/gu, (_whole, digit: string | undefined, fraction: string) => `${digit === undefined ? "" : `${digit} `}${VULGAR_FRACTIONS[fraction] ?? fraction}`);
  // Drawing notation joins the whole number and the fraction with a hyphen: 2-1/2 in, 1-1/2". It is a mixed number when the document is
  // in inches or the text says inches; otherwise 2-1/2 is a subtraction. With spaces around the hyphen (12 - 1/2) it is always one.
  result = result.replace(/(?<![\d.\w])(\d+)-(\d+\/\d+)/gu, (whole, integer: string, fraction: string, offset: number, source: string) => {
    const inchUnitFollows = /^\s*(?:in\b|")/u.test(source.slice(offset + whole.length));
    return defaultUnit === "in" || inchUnitFollows ? `${integer} ${fraction}` : whole;
  });
  // Feet and inches written 5'-3 1/2": the hyphen separates the two, it is not a subtraction.
  result = result.replace(/(\d\s*(?:'|ft\b))\s*-\s*(?=\d)/gu, "$1 ");
  // A comma between digits is a decimal comma when nothing else in the text uses commas (a function would): 25,4 mm.
  if (/^[-+]?\d+,\d+(?:\s*[A-Za-z"']+)?$/u.test(result)) result = result.replace(",", ".");
  return result;
}

/** Reads what a person typed as a length in millimetres. A bare number takes `defaultUnit`, also beside a length in a sum: 5 + 1 in. */
export function parseLengthInput(text: string, defaultUnit: LengthUnit = "mm"): LengthParse {
  const normalized = normalizeLengthText(text, defaultUnit);
  if (normalized === "") return { ok: false, message: "Type a length, like 12, 12 mm, 1/2 in or 3/4\"." };
  const evaluated = evaluateExpression(normalized, { ...EMPTY_EXPRESSION_ENVIRONMENT, bareLengthFactor: LENGTH_UNIT_MM[defaultUnit] });
  if (!evaluated.ok) return { ok: false, message: describeExpressionError(evaluated.error) };
  const quantity = evaluated.quantity;
  if (quantity.angle === 0 && quantity.length === 0) return { ok: true, valueMm: Number((quantity.value * LENGTH_UNIT_MM[defaultUnit]).toPrecision(12)) };
  if (quantity.angle === 0 && quantity.length === 1) return { ok: true, valueMm: Number(quantity.value.toPrecision(12)) };
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
