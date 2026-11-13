import { designOf } from "./design.js";
import type { FieldPreview } from "./design-parameters.js";
import { checkSketchDimensionQuantity, evaluateTextInDesign } from "./parameter-graph.js";
import type { SketchDimensionName, WorkbenchProject } from "./types.js";

/**
 * Checking an expression typed into a sketch dimension, for every kind of dimension the solver supports: a length, a radius or diameter,
 * an angle, an arc length, a perimeter, a distance between points, to a line or between lines, and an ellipse's radii.
 *
 * `previewDimensionExpression` only knows a length of at least the smallest size; a distance between two things may be zero, and an
 * angle is in degrees. This reads the name of the dimension, so each kind is judged by its own rule (the same rule the project applies
 * when the dimension is bound and re-evaluated), and the person gets the reason in words they can act on.
 */
export function previewSketchDimensionExpression(project: WorkbenchProject, dimension: SketchDimensionName, text: string): FieldPreview {
  const evaluated = evaluateTextInDesign(designOf(project), text, project.sketch);
  if (!evaluated.ok) return { ok: false, message: explainBindingProblem(evaluated.message), ...(evaluated.position === undefined ? {} : { position: evaluated.position }) };
  const checked = checkSketchDimensionQuantity(dimension, evaluated.quantity);
  if (!checked.ok) return { ok: false, message: checked.message };
  const value = checked.quantity.value;
  return { ok: true, value, text: dimension === "angle" ? `${Number(value.toFixed(6))}°` : `${Number(value.toFixed(6))} mm` };
}

/** Adds the way out to the messages that name a missing parameter, which is the usual slip when typing a dimension expression. */
export function explainBindingProblem(message: string): string {
  if (/^Unknown name/u.test(message)) return `${message.replace(/\s*\(character \d+\)\s*$/u, "")} Add that parameter first (Parameters, fx) or check the spelling.`;
  return message;
}
