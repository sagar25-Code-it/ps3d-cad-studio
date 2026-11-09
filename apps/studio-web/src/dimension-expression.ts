/**
 * A circle is dimensioned by its diameter on the canvas, but the model stores the radius. An expression typed for the diameter is
 * therefore stored halved, as `(expression) / 2`, and shown again without the wrapper when the dimension is edited.
 */

/** `plate_w` becomes `(plate_w) / 2`: the radius that goes with a typed diameter expression. */
export function halvedExpression(diameterExpression: string): string {
  return `(${diameterExpression.trim()}) / 2`;
}

/** The diameter expression that `halvedExpression` wrapped, or the whole expression when it was not wrapped that way. */
export function unhalvedExpression(radiusExpression: string): string {
  const wrapped = /^\((.*)\) \/ 2$/u.exec(radiusExpression);
  // The brackets must be one pair around everything: "(a) / 2 + (b) / 2" starts and ends like a wrapper but is not one.
  if (wrapped?.[1] !== undefined && closesAtEnd(wrapped[1])) return wrapped[1];
  return `(${radiusExpression}) * 2`;
}

/** Whether the text between a wrapper's outer brackets is balanced, so the first bracket really closes at the last one. */
function closesAtEnd(inner: string): boolean {
  let depth = 0;
  for (const char of inner) {
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}
