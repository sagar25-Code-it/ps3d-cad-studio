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
  return wrapped?.[1] ?? `(${radiusExpression}) * 2`;
}
