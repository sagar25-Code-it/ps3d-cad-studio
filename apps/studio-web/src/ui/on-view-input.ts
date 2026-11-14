/**
 * Pure logic of the on-view input: the small numeric field that floats beside the cursor while a tool waits for a
 * value. It evaluates what was typed (a number, simple arithmetic, a unit, a named parameter), checks it against the
 * tool's limits, steps it with the arrow keys and places the box so it stays on screen.
 */

export type OnViewQuantity = "length" | "angle" | "count" | "scale";

export interface OnViewRequest {
  /** What is being asked for, shown beside the field ("Fillet radius"). */
  readonly label: string;
  readonly quantity: OnViewQuantity;
  readonly defaultValue: number;
  /** The smallest accepted value (inclusive unless `exclusiveMin`). */
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: boolean;
  /** Arrow-key step; Shift multiplies by 10 and Alt divides by 10. */
  readonly step?: number;
  /** Named values the expression may use, such as design parameters. */
  readonly variables?: Readonly<Record<string, number>>;
  /**
   * HS-07: evaluates text the field itself cannot (a parameter name, `Extrude1.distance / 2`) against the design. The answer says the
   * value was reached through an expression, so the step that asked can bind the field to the text instead of keeping only a number.
   */
  readonly resolve?: (text: string) => OnViewParse;
}

/** What the field gave back: the number, the text it came from, and whether that text is an expression to bind (it used a name the design knows). */
export interface OnViewAnswer {
  readonly value: number;
  readonly text: string;
  readonly bound: boolean;
}

/**
 * Evaluates the text for a request: the field's own arithmetic and units first; when that cannot read it and the request has a
 * `resolve`, the design's expressions (parameter names) are tried. `bound` is true only when the design's evaluator was needed.
 */
export function answerOnViewText(request: Pick<OnViewRequest, "quantity" | "variables" | "resolve">, text: string): (OnViewParse & { readonly bound: boolean }) {
  const own = evaluateOnViewText(text, request.quantity, request.variables ?? {});
  if (own.ok || request.resolve === undefined) return { ...own, bound: false };
  const resolved = request.resolve(text);
  // Keep the field's own message when the design cannot read it either, unless the design says something more useful about a name.
  return resolved.ok ? { ...resolved, bound: true } : { ok: false, message: resolved.message, bound: false };
}

export type OnViewParse = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

const LENGTH_UNITS: Readonly<Record<string, number>> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8 };
const ANGLE_UNITS: Readonly<Record<string, number>> = { deg: 1, "°": 1, rad: 180 / Math.PI };

export function unitLabel(quantity: OnViewQuantity): string {
  return quantity === "length" ? "mm" : quantity === "angle" ? "°" : quantity === "scale" ? "×" : "";
}

/**
 * Evaluates text typed into the field. Length fields are in millimetres and accept one unit at the end of the whole
 * expression (`1/2 in`, `(10 + 5) cm`); angle fields are in degrees and accept `deg`, `°` or `rad`. Arithmetic is
 * `+ - * /` with brackets and `^`; a comma is a decimal separator; names are looked up in `variables`.
 */
export function evaluateOnViewText(text: string, quantity: OnViewQuantity, variables: Readonly<Record<string, number>> = {}): OnViewParse {
  let source = text.trim();
  if (source === "") return { ok: false, message: "Type a value." };
  let factor = 1;
  const suffix = /\s*("|°|[a-zA-Z]+)\s*$/.exec(source);
  if (suffix !== null && suffix[1] !== undefined) {
    const unit = suffix[1].toLowerCase();
    // A trailing word is a unit only if it is one; otherwise it is a variable name and stays in the expression.
    if (unit in LENGTH_UNITS || unit in ANGLE_UNITS) {
      if (quantity === "length" && unit in LENGTH_UNITS) factor = LENGTH_UNITS[unit]!;
      else if (quantity === "angle" && unit in ANGLE_UNITS) factor = ANGLE_UNITS[unit]!;
      else return { ok: false, message: quantity === "length" ? `${suffix[1]} is not a length unit (use mm, cm, m, in or ft).` : quantity === "angle" ? `${suffix[1]} is not an angle unit (use deg or rad).` : "This field takes a plain number." };
      source = source.slice(0, suffix.index).trim();
      if (source === "") return { ok: false, message: "Type a number before the unit." };
    }
  }
  const parsed = parseExpression(source.replace(/,/g, "."), variables);
  if (!parsed.ok) return parsed;
  const value = parsed.value * factor;
  if (!Number.isFinite(value)) return { ok: false, message: "That is not a finite number." };
  if (quantity === "count" && !Number.isInteger(value)) return { ok: false, message: "Type a whole number." };
  return { ok: true, value };
}

/** Checks a value against the request's limits; returns the message to show, or undefined when it is acceptable. */
export function onViewLimitMessage(request: Pick<OnViewRequest, "min" | "max" | "exclusiveMin" | "quantity">, value: number): string | undefined {
  const unit = unitLabel(request.quantity);
  const shown = (number: number): string => `${Number(number.toFixed(6))}${unit === "" ? "" : ` ${unit}`}`;
  if (request.min !== undefined && (request.exclusiveMin === true ? value <= request.min : value < request.min)) {
    return request.exclusiveMin === true ? `Must be greater than ${shown(request.min)}.` : `Must be at least ${shown(request.min)}.`;
  }
  if (request.max !== undefined && value > request.max) return `Must be at most ${shown(request.max)}.`;
  return undefined;
}

/** The arrow-key step: `direction` is +1 or -1; Shift is 10x, Alt is 0.1x. */
export function stepOnViewValue(value: number, direction: 1 | -1, step: number, modifiers: { readonly shift?: boolean; readonly alt?: boolean } = {}): number {
  const size = step * (modifiers.shift === true ? 10 : 1) * (modifiers.alt === true ? 0.1 : 1);
  return Math.round((value + direction * size) / (size / 1000)) * (size / 1000);
}

export function formatOnViewValue(value: number): string {
  return String(Number(value.toFixed(6)));
}

export interface PlacedBox { readonly left: number; readonly top: number }

/** Puts a box of `size` beside the cursor, flipping to the other side where it would leave the viewport. */
export function placeNearCursor(cursor: { readonly x: number; readonly y: number }, size: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, offset = 16): PlacedBox {
  let left = cursor.x + offset;
  let top = cursor.y + offset;
  if (left + size.width > viewport.width - 4) left = cursor.x - offset - size.width;
  if (top + size.height > viewport.height - 4) top = cursor.y - offset - size.height;
  return { left: Math.max(4, Math.min(left, viewport.width - size.width - 4)), top: Math.max(4, Math.min(top, viewport.height - size.height - 4)) };
}

// -- expression parser ------------------------------------------------------------------------

function parseExpression(source: string, variables: Readonly<Record<string, number>>): OnViewParse {
  const tokens = tokenize(source);
  if (typeof tokens === "string") return { ok: false, message: tokens };
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const fail = (message: string): never => { throw new Error(message); };
  const sum = (): number => {
    let value = product();
    for (;;) {
      const token = peek();
      if (token === "+") { position += 1; value += product(); } else if (token === "-") { position += 1; value -= product(); } else return value;
    }
  };
  const product = (): number => {
    let value = unary();
    for (;;) {
      const token = peek();
      if (token === "*") { position += 1; value *= unary(); } else if (token === "/") {
        position += 1;
        const divisor = unary();
        if (divisor === 0) fail("Cannot divide by zero.");
        value /= divisor;
      } else return value;
    }
  };
  const unary = (): number => {
    const token = peek();
    if (token === "-") { position += 1; return -unary(); }
    if (token === "+") { position += 1; return unary(); }
    return power();
  };
  const power = (): number => {
    const base = atom();
    if (peek() === "^") { position += 1; return Math.pow(base, unary()); }
    return base;
  };
  const atom = (): number => {
    const token = peek();
    if (token === undefined) return fail("The expression ends too early.");
    position += 1;
    if (token === "(") {
      const value = sum();
      if (peek() !== ")") fail("A bracket is not closed.");
      position += 1;
      return value;
    }
    if (/^[0-9.]/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) fail(`${token} is not a number.`);
      return value;
    }
    if (/^[A-Za-z_]/.test(token)) {
      const value = variables[token];
      if (value === undefined) fail(`${token} is not a known parameter.`);
      return value as number;
    }
    return fail(`Unexpected ${token}.`);
  };
  try {
    const value = sum();
    if (position < tokens.length) return { ok: false, message: `Unexpected ${tokens[position]}.` };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "That cannot be evaluated." };
  }
}

function tokenize(source: string): string[] | string {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) { index += 1; continue; }
    if ("+-*/^()".includes(char)) { tokens.push(char); index += 1; continue; }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (number !== null) { tokens.push(number[0]); index += number[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (name !== null) { tokens.push(name[0]); index += name[0].length; continue; }
    return `Unexpected "${char}".`;
  }
  return tokens;
}
