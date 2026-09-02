import type { SketchDiagnostic } from "./types.js";

export interface ExpressionResult {
  readonly ok: boolean;
  readonly value?: number;
  readonly diagnostic?: SketchDiagnostic;
}

type Token =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "operator"; readonly value: "+" | "-" | "*" | "/" }
  | { readonly kind: "left" }
  | { readonly kind: "right" };

/**
 * Evaluates a deliberately small, deterministic arithmetic language. It never
 * uses eval/Function and therefore accepts only numbers, parameter names,
 * parentheses, and + - * /. Unary minus is supported.
 */
export function evaluateSketchExpression(
  expression: string,
  parameters: Readonly<Record<string, number>>,
  relatedId: string
): ExpressionResult {
  const tokenized = tokenize(expression, parameters, relatedId);
  if (!tokenized.ok) return tokenized;
  const tokens = tokenized.tokens ?? [];
  if (tokens.length === 0) return invalid(expression, relatedId, "The expression is empty or incomplete.");

  let cursor = 0;
  type ParseResult = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: ExpressionResult };
  const failure = (detail: string): ParseResult => ({ ok: false, error: invalid(expression, relatedId, detail) });
  const finite = (value: number): ParseResult => Number.isFinite(value)
    ? { ok: true, value }
    : failure("The expression produces a non-finite value.");

  const parsePrimary = (): ParseResult => {
    const token = tokens[cursor];
    if (token === undefined) return failure("The expression has an incomplete operation.");
    if (token.kind === "number" || token.kind === "identifier") {
      cursor += 1;
      return finite(token.kind === "number" ? token.value : parameters[token.value]!);
    }
    if (token.kind !== "left") return failure(token.kind === "right"
      ? "The closing parenthesis has no value before it."
      : "An operand is required before the operator.");
    cursor += 1;
    const nested = parseAddSubtract();
    if (!nested.ok) return nested;
    if (tokens[cursor]?.kind !== "right") return failure("The expression has unmatched parentheses.");
    cursor += 1;
    return nested;
  };

  const parseUnary = (): ParseResult => {
    const token = tokens[cursor];
    if (token?.kind === "operator" && (token.value === "+" || token.value === "-")) {
      cursor += 1;
      const operand = parseUnary();
      return operand.ok ? finite(token.value === "-" ? -operand.value : operand.value) : operand;
    }
    return parsePrimary();
  };

  const parseMultiplyDivide = (): ParseResult => {
    let left = parseUnary();
    if (!left.ok) return left;
    while (true) {
      const next = tokens[cursor];
      if (next?.kind !== "operator" || (next.value !== "*" && next.value !== "/")) break;
      const operator = next.value;
      cursor += 1;
      const right = parseUnary();
      if (!right.ok) return right;
      left = finite(operator === "*" ? left.value * right.value : left.value / right.value);
      if (!left.ok) return left;
    }
    return left;
  };

  function parseAddSubtract(): ParseResult {
    let left = parseMultiplyDivide();
    if (!left.ok) return left;
    while (true) {
      const next = tokens[cursor];
      if (next?.kind !== "operator" || (next.value !== "+" && next.value !== "-")) break;
      const operator = next.value;
      cursor += 1;
      const right = parseMultiplyDivide();
      if (!right.ok) return right;
      left = finite(operator === "+" ? left.value + right.value : left.value - right.value);
      if (!left.ok) return left;
    }
    return left;
  }

  const parsed = parseAddSubtract();
  if (!parsed.ok) return parsed.error;
  if (cursor !== tokens.length) {
    const token = tokens[cursor]!;
    return invalid(expression, relatedId, token.kind === "right"
      ? "The expression has unmatched parentheses."
      : "An operator is required between values.");
  }
  return { ok: true, value: parsed.value };
}

function tokenize(
  expression: string,
  parameters: Readonly<Record<string, number>>,
  relatedId: string
): ExpressionResult & { readonly tokens?: readonly Token[] } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      const match = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (match === null) return invalid(expression, relatedId, `Invalid number at character ${index + 1}.`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) return invalid(expression, relatedId, "A numeric literal is not finite.");
      tokens.push({ kind: "number", value });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      const name = match[0];
      if (!Object.prototype.hasOwnProperty.call(parameters, name) || !Number.isFinite(parameters[name])) {
        return invalid(expression, relatedId, `Parameter '${name}' is missing or non-finite.`);
      }
      tokens.push({ kind: "identifier", value: name });
      index += name.length;
      continue;
    }
    if (character === "+" || character === "-" || character === "*" || character === "/") {
      tokens.push({ kind: "operator", value: character });
      index += 1;
      continue;
    }
    if (character === "(") tokens.push({ kind: "left" });
    else if (character === ")") tokens.push({ kind: "right" });
    else return invalid(expression, relatedId, `Unsupported character '${character}' at position ${index + 1}.`);
    index += 1;
  }
  return { ok: true, tokens };
}

function invalid(expression: string, relatedId: string, detail: string): ExpressionResult {
  return {
    ok: false,
    diagnostic: {
      code: "INVALID_EXPRESSION",
      severity: "error",
      message: `${detail} Received '${expression}'.`,
      relatedIds: [relatedId],
      recovery: "Use finite numbers, declared parameter names, parentheses, and + - * / only.",
      unsupported: false
    }
  };
}
