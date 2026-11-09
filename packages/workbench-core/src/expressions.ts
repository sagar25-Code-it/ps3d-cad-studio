/**
 * A small, safe expression language for parametric dimensions: `2 * pin_r`, `Extrude1.distance / 2 + 1.5 mm`, `sin(30 deg) * 10`.
 *
 * It is a hand-written tokenizer and recursive-descent parser over a closed grammar, with its own evaluator. Nothing is ever
 * passed to `eval`, `Function` or any dynamic code path, so a project file cannot run code by carrying an expression.
 *
 * Values carry a dimension: a length is held in millimetres and an angle in degrees, with exponents so that `mm * mm` is an area
 * and `mm / mm` is a plain number. Unit suffixes (`mm`, `cm`, `m`, `um`, `in` or `"`, `ft` or `'`, `mil`, `deg`, `rad`) convert into those base
 * units when the number is read, so `1 in` is exactly `25.4`. A unit after a fraction or a mixed number applies to the whole of it
 * (`1/2 in`, `1 1/2 in`, `(1/2) in`), and feet and inches can be written together (`5' 3 1/2"`).
 *
 * Every failure is a deterministic `ExpressionError` with the character offset where it was found, never a thrown exception.
 */

/** The dimension of a value: how many times it is a length and an angle. A plain number has both at zero. */
export interface Dimension {
  readonly length: number;
  readonly angle: number;
}

/** A value in base units (millimetres, degrees) with its dimension. */
export interface Quantity extends Dimension {
  readonly value: number;
}

export interface ExpressionError {
  readonly message: string;
  /** Zero-based character offset in the source where the problem starts. */
  readonly position: number;
  /** How many characters the problem covers (at least 1). */
  readonly length: number;
}

/** A name used in an expression: `pin_r`, or `Extrude1.distance` (owner `Extrude1`, name `distance`). */
export interface ExpressionReference {
  readonly owner?: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export const MAX_EXPRESSION_LENGTH = 400;
const MAX_DEPTH = 48;

export const EXPRESSION_UNITS: Readonly<Record<string, { readonly factor: number; readonly dimension: Dimension }>> = {
  mm: { factor: 1, dimension: { length: 1, angle: 0 } },
  cm: { factor: 10, dimension: { length: 1, angle: 0 } },
  m: { factor: 1000, dimension: { length: 1, angle: 0 } },
  in: { factor: 25.4, dimension: { length: 1, angle: 0 } },
  ft: { factor: 304.8, dimension: { length: 1, angle: 0 } },
  mil: { factor: 0.0254, dimension: { length: 1, angle: 0 } },
  thou: { factor: 0.0254, dimension: { length: 1, angle: 0 } },
  um: { factor: 0.001, dimension: { length: 1, angle: 0 } },
  deg: { factor: 1, dimension: { length: 0, angle: 1 } },
  rad: { factor: 180 / Math.PI, dimension: { length: 0, angle: 1 } }
};

export const EXPRESSION_FUNCTIONS = ["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "min", "max", "round", "floor", "ceil", "pi"] as const;
const FUNCTION_SET: ReadonlySet<string> = new Set(EXPRESSION_FUNCTIONS);

/** Words a parameter cannot be called, because the language already gives them a meaning. */
export function isReservedExpressionName(name: string): boolean {
  return Object.hasOwn(EXPRESSION_UNITS, name) || FUNCTION_SET.has(name);
}

// ---------------------------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------------------------

export type ExpressionNode =
  | { readonly type: "number"; readonly quantity: Quantity; readonly start: number; readonly end: number }
  | { readonly type: "reference"; readonly reference: ExpressionReference }
  | { readonly type: "unary"; readonly operator: "-" | "+"; readonly operand: ExpressionNode; readonly start: number; readonly end: number }
  | { readonly type: "binary"; readonly operator: "+" | "-" | "*" | "/" | "^"; readonly left: ExpressionNode; readonly right: ExpressionNode; readonly operatorAt: number; readonly start: number; readonly end: number }
  | { readonly type: "call"; readonly name: string; readonly args: readonly ExpressionNode[]; readonly start: number; readonly end: number };

export type ParsedExpression =
  | { readonly ok: true; readonly node: ExpressionNode; readonly references: readonly ExpressionReference[]; readonly source: string }
  | { readonly ok: false; readonly error: ExpressionError };

type Token =
  | { readonly type: "number"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly type: "name"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly type: "symbol"; readonly text: "+" | "-" | "*" | "/" | "^" | "(" | ")" | "," | "."; readonly start: number; readonly end: number }
  | { readonly type: "end"; readonly text: ""; readonly start: number; readonly end: number };

class ExpressionFailure extends Error {
  readonly detail: ExpressionError;
  constructor(message: string, position: number, length = 1) {
    super(message);
    this.detail = { message, position, length: Math.max(1, length) };
  }
}

const NUMBER_PATTERN = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/y;

/**
 * Splits the source into tokens. A dot directly after a name and before a letter is the separator in `Extrude1.distance`; any other
 * dot belongs to a number such as `.5` or `2.5`.
 */
function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let previousWasName = false;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { index += 1; continue; }
    if (char === "." && previousWasName && /[A-Za-z_]/u.test(source[index + 1] ?? "")) {
      tokens.push({ type: "symbol", text: ".", start: index, end: index + 1 });
      index += 1;
      previousWasName = false;
      continue;
    }
    if (/[0-9.]/u.test(char)) {
      NUMBER_PATTERN.lastIndex = index;
      const match = NUMBER_PATTERN.exec(source);
      if (match === null) throw new ExpressionFailure(char === "." ? "A dot must sit between a feature name and a value name, like Extrude1.distance." : "This is not a number.", index);
      tokens.push({ type: "number", text: match[0], start: index, end: index + match[0].length });
      index += match[0].length;
      previousWasName = false;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      NAME_PATTERN.lastIndex = index;
      const match = NAME_PATTERN.exec(source)!;
      tokens.push({ type: "name", text: match[0], start: index, end: index + match[0].length });
      index += match[0].length;
      previousWasName = true;
      continue;
    }
    // A double quote is inches and a single quote feet, written straight after a number: 3/4" and 5'.
    if (char === '"' || char === "'") {
      tokens.push({ type: "name", text: char === '"' ? "in" : "ft", start: index, end: index + 1 });
      index += 1;
      previousWasName = false;
      continue;
    }
    if ("+-*/^(),".includes(char)) {
      tokens.push({ type: "symbol", text: char as "+", start: index, end: index + 1 });
      index += 1;
      previousWasName = false;
      continue;
    }
    throw new ExpressionFailure(`Unexpected character "${char}".`, index);
  }
  tokens.push({ type: "end", text: "", start: source.length, end: source.length });
  return tokens;
}
/** Removes floating-point noise from a conversion (25.400000000000002 becomes 25.4) without changing the meaning of the number. */
function clean(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (Math.abs(value) < 1e-15) return 0;
  return Number(value.toPrecision(15));
}

class Parser {
  private index = 0;
  private depth = 0;
  readonly references: ExpressionReference[] = [];

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token { return this.tokens[this.index]!; }
  private next(): Token { const token = this.tokens[this.index]!; if (token.type !== "end") this.index += 1; return token; }
  private isSymbol(text: string): boolean { const token = this.peek(); return token.type === "symbol" && token.text === text; }

  parse(): ExpressionNode {
    if (this.peek().type === "end") throw new ExpressionFailure("The expression is empty. Type a number or a formula.", 0);
    const node = this.expression();
    const rest = this.peek();
    if (rest.type !== "end") {
      if (rest.type === "symbol" && rest.text === ")") throw new ExpressionFailure('This ")" has no matching "(".', rest.start);
      if (rest.type === "symbol" && rest.text === ",") throw new ExpressionFailure("A comma only belongs between the values of a function, like max(a, b).", rest.start);
      throw new ExpressionFailure(`Unexpected "${rest.text}". An operator (+ - * / ^) is expected here.`, rest.start, rest.end - rest.start);
    }
    return node;
  }

  private enter(at: number): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ExpressionFailure("The expression is nested too deeply.", at);
  }

  private leave(): void { this.depth -= 1; }

  private expression(): ExpressionNode {
    let left = this.term();
    for (;;) {
      const token = this.peek();
      if (token.type === "symbol" && (token.text === "+" || token.text === "-")) {
        this.next();
        const right = this.term();
        left = { type: "binary", operator: token.text, left, right, operatorAt: token.start, start: nodeStart(left), end: nodeEnd(right) };
      } else return left;
    }
  }

  private term(): ExpressionNode {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token.type === "symbol" && (token.text === "*" || token.text === "/")) {
        this.next();
        const right = this.unary();
        left = { type: "binary", operator: token.text, left, right, operatorAt: token.start, start: nodeStart(left), end: nodeEnd(right) };
      } else return left;
    }
  }

  private unary(): ExpressionNode {
    const token = this.peek();
    if (token.type === "symbol" && (token.text === "-" || token.text === "+")) {
      this.next();
      this.enter(token.start);
      const operand = this.unary();
      this.leave();
      return { type: "unary", operator: token.text, operand, start: token.start, end: nodeEnd(operand) };
    }
    return this.power();
  }

  private power(): ExpressionNode {
    const base = this.primary();
    const token = this.peek();
    if (token.type === "symbol" && token.text === "^") {
      this.next();
      this.enter(token.start);
      // Right associative, and the exponent may itself be negated: 2 ^ -1.
      const exponent = this.unary();
      this.leave();
      return { type: "binary", operator: "^", left: base, right: exponent, operatorAt: token.start, start: nodeStart(base), end: nodeEnd(exponent) };
    }
    return base;
  }

  private primary(): ExpressionNode {
    const token = this.next();
    if (token.type === "number") return this.numberWithUnit(token);
    if (token.type === "symbol" && token.text === "(") {
      this.enter(token.start);
      const inner = this.expression();
      this.leave();
      const close = this.next();
      if (close.type !== "symbol" || close.text !== ")") throw new ExpressionFailure('Missing ")" to close this "(".', token.start);
      // A unit right after a bracket applies to the whole of it: (1/2) in.
      const after = this.peek();
      if (after.type === "name" && Object.hasOwn(EXPRESSION_UNITS, after.text)) {
        this.next();
        const unit = EXPRESSION_UNITS[after.text]!;
        const unitNode: ExpressionNode = { type: "number", quantity: { value: unit.factor, length: unit.dimension.length, angle: unit.dimension.angle }, start: after.start, end: after.end };
        return { type: "binary", operator: "*", left: inner, right: unitNode, operatorAt: after.start, start: token.start, end: after.end };
      }
      return inner;
    }
    if (token.type === "name") return this.nameOrCall(token);
    if (token.type === "end") throw new ExpressionFailure("The expression ends too early. A value is expected after the last operator.", token.start);
    throw new ExpressionFailure(`Unexpected "${token.text}". A number, a name or "(" is expected here.`, token.start, token.end - token.start);
  }

  /**
   * Reads a number literal and the unit after it. A fraction or a mixed number is one literal, so the unit applies to all of it:
   * `1/2 in` is half an inch (not one over two inches) and `1 1/2 in` is one and a half.
   */
  private readLiteral(token: Extract<Token, { type: "number" }>): { readonly value: number; readonly end: number; readonly unitName?: string } {
    let value = Number(token.text);
    if (!Number.isFinite(value)) throw new ExpressionFailure("This number is too large.", token.start, token.end - token.start);
    let end = token.end;
    const first = this.tokens[this.index];
    const second = this.tokens[this.index + 1];
    const third = this.tokens[this.index + 2];
    const isInteger = (candidate: Token | undefined): candidate is Extract<Token, { type: "number" }> => candidate !== undefined && candidate.type === "number" && /^\d+$/u.test(candidate.text);
    const isSlash = (candidate: Token | undefined): boolean => candidate !== undefined && candidate.type === "symbol" && candidate.text === "/";
    const isUnitName = (candidate: Token | undefined): boolean => candidate !== undefined && candidate.type === "name" && Object.hasOwn(EXPRESSION_UNITS, candidate.text);
    if (/^\d+$/u.test(token.text) && isInteger(first) && isSlash(second) && isInteger(third) && Number(third.text) !== 0) {
      value += Number(first.text) / Number(third.text);
      this.index += 3;
      end = third.end;
    } else if (isSlash(first) && second !== undefined && second.type === "number" && isUnitName(third) && Number(second.text) !== 0) {
      value /= Number(second.text);
      this.index += 2;
      end = second.end;
    }
    const following = this.peek();
    if (following.type === "name") {
      if (!Object.hasOwn(EXPRESSION_UNITS, following.text)) {
        throw new ExpressionFailure(`"${following.text}" is not a unit. Units are mm, cm, m, um, in, ft, mil, deg and rad. To multiply by a name, write "*" between them.`, following.start, following.end - following.start);
      }
      this.next();
      return { value, end: following.end, unitName: following.text };
    }
    return { value, end };
  }

  private numberWithUnit(token: Extract<Token, { type: "number" }>): ExpressionNode {
    const literal = this.readLiteral(token);
    if (literal.unitName === undefined) return { type: "number", quantity: { value: literal.value, length: 0, angle: 0 }, start: token.start, end: literal.end };
    const unit = EXPRESSION_UNITS[literal.unitName]!;
    let value = literal.value * unit.factor;
    let end = literal.end;
    // Feet and inches together: 5' 3 1/2" or 5 ft 3 in. A bare second number after feet is inches.
    if (literal.unitName === "ft" && this.peek().type === "number") {
      const inches = this.readLiteral(this.next() as Extract<Token, { type: "number" }>);
      if (inches.unitName !== undefined && inches.unitName !== "in") throw new ExpressionFailure("After feet, give the inches with in or \".", token.start, inches.end - token.start);
      value += inches.value * 25.4;
      end = inches.end;
    }
    return { type: "number", quantity: { value: clean(value), length: unit.dimension.length, angle: unit.dimension.angle }, start: token.start, end };
  }

  private nameOrCall(token: Extract<Token, { type: "name" }>): ExpressionNode {
    if (this.isSymbol("(")) {
      if (!FUNCTION_SET.has(token.text)) throw new ExpressionFailure(`Unknown function "${token.text}". Functions are ${EXPRESSION_FUNCTIONS.filter((name) => name !== "pi").join(", ")}.`, token.start, token.end - token.start);
      this.next();
      const args: ExpressionNode[] = [];
      if (!this.isSymbol(")")) {
        for (;;) {
          this.enter(token.start);
          args.push(this.expression());
          this.leave();
          if (this.isSymbol(",")) { this.next(); continue; }
          break;
        }
      }
      const close = this.next();
      if (close.type !== "symbol" || close.text !== ")") throw new ExpressionFailure(`Missing ")" to close ${token.text}(.`, close.type === "end" ? close.start : close.start, Math.max(1, close.end - close.start));
      return { type: "call", name: token.text, args, start: token.start, end: close.end };
    }
    if (Object.hasOwn(EXPRESSION_UNITS, token.text)) throw new ExpressionFailure(`"${token.text}" is a unit. Write a number before it, like 5 ${token.text}.`, token.start, token.end - token.start);
    if (token.text === "pi") return { type: "call", name: "pi", args: [], start: token.start, end: token.end };
    if (FUNCTION_SET.has(token.text)) throw new ExpressionFailure(`"${token.text}" is a function. Write ${token.text}(…) with its value in brackets.`, token.start, token.end - token.start);
    if (this.isSymbol(".")) {
      this.next();
      const field = this.next();
      if (field.type !== "name") throw new ExpressionFailure(`A value name is expected after "${token.text}.".`, field.start, Math.max(1, field.end - field.start));
      const reference: ExpressionReference = { owner: token.text, name: field.text, start: token.start, end: field.end };
      this.references.push(reference);
      return { type: "reference", reference };
    }
    const reference: ExpressionReference = { name: token.text, start: token.start, end: token.end };
    this.references.push(reference);
    return { type: "reference", reference };
  }
}

function nodeStart(node: ExpressionNode): number {
  return node.type === "reference" ? node.reference.start : node.start;
}

function nodeEnd(node: ExpressionNode): number {
  return node.type === "reference" ? node.reference.end : node.end;
}

/** Parses an expression without evaluating it. Names and references are collected, not resolved. */
export function parseExpression(source: string): ParsedExpression {
  if (typeof source !== "string") return { ok: false, error: { message: "The expression must be text.", position: 0, length: 1 } };
  if (source.length > MAX_EXPRESSION_LENGTH) return { ok: false, error: { message: `The expression is longer than ${MAX_EXPRESSION_LENGTH} characters.`, position: MAX_EXPRESSION_LENGTH, length: 1 } };
  try {
    const parser = new Parser(tokenize(source));
    const node = parser.parse();
    return { ok: true, node, references: [...parser.references], source };
  } catch (error) {
    if (error instanceof ExpressionFailure) return { ok: false, error: error.detail };
    throw error;
  }
}

/** The error as one line: the message and where it is, counting characters from 1 the way a person reads them. */
export function describeExpressionError(error: ExpressionError): string {
  return `${error.message} (character ${error.position + 1})`;
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export type ReferenceResolution =
  | { readonly ok: true; readonly quantity: Quantity }
  | { readonly ok: false; readonly message: string };

/** Looks up what a name stands for. The caller decides what exists: user parameters, feature values, anything else. */
export interface ExpressionEnvironment {
  readonly resolve: (reference: ExpressionReference) => ReferenceResolution;
  /**
   * What a plain number beside a length means in a sum, in millimetres per unit. Unset, it is one millimetre (`pin_r + 1` is one more
   * millimetre). A typed length in an inch document sets 25.4, so `5 + 1 in` is six inches.
   */
  readonly bareLengthFactor?: number;
}

export type EvaluatedExpression =
  | { readonly ok: true; readonly quantity: Quantity }
  | { readonly ok: false; readonly error: ExpressionError };

const isScalar = (quantity: Dimension): boolean => quantity.length === 0 && quantity.angle === 0;
const sameDimension = (a: Dimension, b: Dimension): boolean => a.length === b.length && a.angle === b.angle;

export function describeDimension(dimension: Dimension): string {
  if (isScalar(dimension)) return "a plain number";
  if (dimension.length === 1 && dimension.angle === 0) return "a length";
  if (dimension.length === 0 && dimension.angle === 1) return "an angle";
  const parts: string[] = [];
  if (dimension.length !== 0) parts.push(dimension.length === 1 ? "mm" : `mm^${dimension.length}`);
  if (dimension.angle !== 0) parts.push(dimension.angle === 1 ? "deg" : `deg^${dimension.angle}`);
  return `a value in ${parts.join("·")}`;
}

/** A quantity as text in its base unit: `25.4 mm`, `30 deg`, `0.5`. */
export function formatQuantity(quantity: Quantity): string {
  const text = String(Number(quantity.value.toFixed(6)));
  if (isScalar(quantity)) return text;
  const parts: string[] = [];
  if (quantity.length !== 0) parts.push(quantity.length === 1 ? "mm" : `mm^${quantity.length}`);
  if (quantity.angle !== 0) parts.push(quantity.angle === 1 ? "deg" : `deg^${quantity.angle}`);
  return `${text} ${parts.join("·")}`;
}

function finiteOrFail(value: number, at: number, length: number): number {
  if (!Number.isFinite(value)) throw new ExpressionFailure("The result is too large to use.", at, length);
  return value;
}

function evaluateNode(node: ExpressionNode, environment: ExpressionEnvironment): Quantity {
  switch (node.type) {
    case "number": return node.quantity;
    case "reference": {
      const resolved = environment.resolve(node.reference);
      if (!resolved.ok) throw new ExpressionFailure(resolved.message, node.reference.start, node.reference.end - node.reference.start);
      return resolved.quantity;
    }
    case "unary": {
      const operand = evaluateNode(node.operand, environment);
      return node.operator === "-" ? { ...operand, value: -operand.value } : operand;
    }
    case "binary": return evaluateBinary(node, environment);
    case "call": return evaluateCall(node, environment);
  }
}

function evaluateBinary(node: Extract<ExpressionNode, { type: "binary" }>, environment: ExpressionEnvironment): Quantity {
  const left = evaluateNode(node.left, environment);
  const right = evaluateNode(node.right, environment);
  const span = node.end - node.start;
  switch (node.operator) {
    case "+":
    case "-": {
      // A plain number beside a length or an angle takes that unit, so "pin_r + 1" means one more millimetre.
      let dimension: Dimension;
      let leftValue = left.value;
      let rightValue = right.value;
      const factor = environment.bareLengthFactor ?? 1;
      const isLength = (quantity: Dimension): boolean => quantity.length === 1 && quantity.angle === 0;
      if (sameDimension(left, right)) dimension = left;
      else if (isScalar(left)) { dimension = right; if (isLength(right)) leftValue *= factor; }
      else if (isScalar(right)) { dimension = left; if (isLength(left)) rightValue *= factor; }
      else throw new ExpressionFailure(`Cannot ${node.operator === "+" ? "add" : "subtract"} ${describeDimension(left)} and ${describeDimension(right)}.`, node.operatorAt, 1);
      return { value: finiteOrFail(node.operator === "+" ? leftValue + rightValue : leftValue - rightValue, node.start, span), length: dimension.length, angle: dimension.angle };
    }
    case "*":
      return { value: finiteOrFail(left.value * right.value, node.start, span), length: left.length + right.length, angle: left.angle + right.angle };
    case "/": {
      if (right.value === 0) throw new ExpressionFailure("Division by zero.", nodeStart(node.right), nodeEnd(node.right) - nodeStart(node.right));
      return { value: finiteOrFail(left.value / right.value, node.start, span), length: left.length - right.length, angle: left.angle - right.angle };
    }
    case "^": {
      if (!isScalar(right)) throw new ExpressionFailure("An exponent must be a plain number, without a unit.", nodeStart(node.right), nodeEnd(node.right) - nodeStart(node.right));
      if (!isScalar(left) && !Number.isInteger(right.value)) throw new ExpressionFailure(`A value with a unit can only be raised to a whole-number power (${describeDimension(left)} ^ ${right.value}).`, node.operatorAt, 1);
      if (left.value === 0 && right.value < 0) throw new ExpressionFailure("Division by zero.", node.start, span);
      const value = Math.pow(left.value, right.value);
      if (Number.isNaN(value)) throw new ExpressionFailure("This power has no real result (a negative number to a fractional power).", node.operatorAt, 1);
      return { value: finiteOrFail(clean(value), node.start, span), length: left.length * right.value, angle: left.angle * right.value };
    }
  }
}

function evaluateCall(node: Extract<ExpressionNode, { type: "call" }>, environment: ExpressionEnvironment): Quantity {
  const span = node.end - node.start;
  const args = node.args.map((argument) => evaluateNode(argument, environment));
  const arity = (minimum: number, maximum: number): void => {
    if (args.length < minimum || args.length > maximum) {
      const expected = minimum === maximum ? `${minimum} value${minimum === 1 ? "" : "s"}` : `${minimum} or more values`;
      throw new ExpressionFailure(`${node.name} takes ${expected}, but ${args.length} ${args.length === 1 ? "was" : "were"} given.`, node.start, span);
    }
  };
  const argumentAt = (index: number): ExpressionNode => node.args[index]!;
  switch (node.name) {
    case "pi": arity(0, 0); return { value: Math.PI, length: 0, angle: 0 };
    case "sin":
    case "cos":
    case "tan": {
      arity(1, 1);
      const angle = args[0]!;
      if (angle.angle !== 1 || angle.length !== 0) throw new ExpressionFailure(`${node.name} needs an angle: write 30 deg or 0.5 rad, not ${describeDimension(angle)}.`, nodeStart(argumentAt(0)), nodeEnd(argumentAt(0)) - nodeStart(argumentAt(0)));
      const radians = angle.value * Math.PI / 180;
      const value = node.name === "sin" ? Math.sin(radians) : node.name === "cos" ? Math.cos(radians) : Math.tan(radians);
      if (node.name === "tan" && Math.abs(value) > 1e12) throw new ExpressionFailure("The tangent of this angle is undefined.", node.start, span);
      return { value: clean(value), length: 0, angle: 0 };
    }
    case "asin":
    case "acos":
    case "atan": {
      arity(1, 1);
      const ratio = args[0]!;
      if (!isScalar(ratio)) throw new ExpressionFailure(`${node.name} needs a plain number, not ${describeDimension(ratio)}.`, nodeStart(argumentAt(0)), nodeEnd(argumentAt(0)) - nodeStart(argumentAt(0)));
      if (node.name !== "atan" && Math.abs(ratio.value) > 1) throw new ExpressionFailure(`${node.name} needs a number between -1 and 1.`, nodeStart(argumentAt(0)), nodeEnd(argumentAt(0)) - nodeStart(argumentAt(0)));
      const radians = node.name === "asin" ? Math.asin(ratio.value) : node.name === "acos" ? Math.acos(ratio.value) : Math.atan(ratio.value);
      return { value: clean(radians * 180 / Math.PI), length: 0, angle: 1 };
    }
    case "sqrt": {
      arity(1, 1);
      const operand = args[0]!;
      if (operand.value < 0) throw new ExpressionFailure("The square root of a negative number is not real.", nodeStart(argumentAt(0)), nodeEnd(argumentAt(0)) - nodeStart(argumentAt(0)));
      if (operand.length % 2 !== 0 || operand.angle % 2 !== 0) throw new ExpressionFailure(`Cannot take the square root of ${describeDimension(operand)}.`, nodeStart(argumentAt(0)), nodeEnd(argumentAt(0)) - nodeStart(argumentAt(0)));
      return { value: clean(Math.sqrt(operand.value)), length: operand.length / 2, angle: operand.angle / 2 };
    }
    case "abs": arity(1, 1); return { ...args[0]!, value: Math.abs(args[0]!.value) };
    case "round": arity(1, 1); return { ...args[0]!, value: roundHalfAwayFromZero(args[0]!.value) };
    case "floor": arity(1, 1); return { ...args[0]!, value: Math.floor(args[0]!.value) };
    case "ceil": arity(1, 1); return { ...args[0]!, value: Math.ceil(args[0]!.value) };
    case "min":
    case "max": {
      arity(1, 16);
      // Like addition, a plain number beside a dimensioned value takes that dimension.
      let dimension: Dimension = args[0]!;
      for (let index = 1; index < args.length; index += 1) {
        const candidate = args[index]!;
        if (sameDimension(dimension, candidate) || isScalar(candidate)) continue;
        if (isScalar(dimension)) { dimension = candidate; continue; }
        throw new ExpressionFailure(`${node.name} cannot compare ${describeDimension(dimension)} with ${describeDimension(candidate)}.`, nodeStart(argumentAt(index)), nodeEnd(argumentAt(index)) - nodeStart(argumentAt(index)));
      }
      const values = args.map((argument) => argument.value);
      return { value: node.name === "min" ? Math.min(...values) : Math.max(...values), length: dimension.length, angle: dimension.angle };
    }
    default:
      throw new ExpressionFailure(`Unknown function "${node.name}".`, node.start, span);
  }
}

function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Evaluates a parsed expression. Every failure, including one a name lookup reports, comes back as a positioned error. */
export function evaluateParsedExpression(parsed: Extract<ParsedExpression, { ok: true }>, environment: ExpressionEnvironment): EvaluatedExpression {
  try {
    return { ok: true, quantity: evaluateNode(parsed.node, environment) };
  } catch (error) {
    if (error instanceof ExpressionFailure) return { ok: false, error: error.detail };
    throw error;
  }
}

/** Parses and evaluates in one step. */
export function evaluateExpression(source: string, environment: ExpressionEnvironment): EvaluatedExpression {
  const parsed = parseExpression(source);
  if (!parsed.ok) return parsed;
  return evaluateParsedExpression(parsed, environment);
}

/** An environment with no names at all, for expressions made only of numbers, units and functions. */
export const EMPTY_EXPRESSION_ENVIRONMENT: ExpressionEnvironment = {
  resolve: (reference) => ({ ok: false, message: `Unknown name "${reference.owner === undefined ? reference.name : `${reference.owner}.${reference.name}`}".` })
};

// ---------------------------------------------------------------------------------------------
// Rewriting names
// ---------------------------------------------------------------------------------------------

/**
 * Rewrites the names in an expression. `rewrite` gets each reference and returns its replacement text (the whole reference, with
 * its owner if it has one), or undefined to leave it. Works on the exact character spans of a successful parse, so a longer name
 * that merely contains the old one (`pin_r2` for `pin_r`) is never touched. An expression that does not parse is returned as it is.
 */
export function rewriteReferences(source: string, rewrite: (reference: ExpressionReference) => string | undefined): string {
  const parsed = parseExpression(source);
  if (!parsed.ok) return source;
  let result = source;
  for (const reference of [...parsed.references].sort((a, b) => b.start - a.start)) {
    const replacement = rewrite(reference);
    if (replacement !== undefined) result = `${result.slice(0, reference.start)}${replacement}${result.slice(reference.end)}`;
  }
  return result;
}

/** Renames user parameters in an expression. `names` maps old to new, applied all at once so two names can be swapped. */
export function renameParameterReferences(source: string, names: ReadonlyMap<string, string>): string {
  return rewriteReferences(source, (reference) => reference.owner === undefined && names.has(reference.name) ? names.get(reference.name)! : undefined);
}

/** Renames the owner (feature alias) in `Owner.value` references. */
export function renameOwnerReferences(source: string, owners: ReadonlyMap<string, string>): string {
  return rewriteReferences(source, (reference) => reference.owner !== undefined && owners.has(reference.owner) ? `${owners.get(reference.owner)!}.${reference.name}` : undefined);
}
