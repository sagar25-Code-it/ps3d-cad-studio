import type { SketchDimensionName, SketchPointRef, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../../packages/workbench-core/src/index.js";
import { locateDimensionConstraint } from "../../../../../packages/workbench-core/src/index.js";
import { circleDimensionRequest, type CircleDimensionFacts } from "../../../../../packages/workbench-sketch/src/dimension-edit-model.js";
import type { DimensionTextRead } from "../../../../../packages/workbench-sketch/src/dimension-text.js";
import { halvedExpression, unhalvedExpression } from "../../dimension-expression.js";

/**
 * Turns what a person typed into a dimension field (a number, or a parameter expression) into the `set-sketch-dimension` request, for
 * every field that edits a dimension. One place decides how a circle's diameter, a circle's radius and every other dimension are sent,
 * so the canvas editor and each inspector field agree and a Diameter dimension is never contradicted by a Radius one.
 */

/** A read that can be applied: a value (millimetres, or degrees for an angle) or an expression. */
export type AcceptedDimensionRead = Extract<DimensionTextRead, { readonly kind: "value" | "expression" }>;

export interface DimensionApply {
  readonly dimension: SketchDimensionName;
  /** Millimetres (degrees for an angle). For an expression this is a placeholder: the project evaluates the expression and uses its result. */
  readonly valueMm: number;
  readonly expression?: string;
}

/** The value sent along with an expression; the project replaces it with what the expression gives. */
const EXPRESSION_PLACEHOLDER = 1;

export function applyOf(dimension: SketchDimensionName, read: AcceptedDimensionRead): DimensionApply {
  return read.kind === "value" ? { dimension, valueMm: read.value } : { dimension, valueMm: EXPRESSION_PLACEHOLDER, expression: read.expression };
}

/** A diameter typed (or bound) for a circle. A Diameter dimension takes it as is; a Radius dimension takes half of it. */
export function circleDiameterApply(read: AcceptedDimensionRead, diameterConstraint: boolean): DimensionApply {
  if (read.kind === "value") return circleDimensionRequest(read.value, diameterConstraint);
  return diameterConstraint
    ? { dimension: "diameter", valueMm: EXPRESSION_PLACEHOLDER, expression: read.expression }
    : { dimension: "radius", valueMm: EXPRESSION_PLACEHOLDER, expression: halvedExpression(read.expression) };
}

/** A radius typed (or bound) for a circle. A Radius dimension takes it as is; a Diameter dimension takes twice it, so the two never disagree. */
export function circleRadiusApply(read: AcceptedDimensionRead, diameterConstraint: boolean): DimensionApply {
  if (!diameterConstraint) return applyOf("radius", read);
  return read.kind === "value"
    ? { dimension: "diameter", valueMm: read.value * 2 }
    : { dimension: "diameter", valueMm: EXPRESSION_PLACEHOLDER, expression: unhalvedExpression(read.expression) };
}

/** The expression a circle's diameter is bound to, as the diameter (a bound Radius dimension is shown doubled), or undefined. */
export function circleDiameterExpression(facts: CircleDimensionFacts): string | undefined {
  const expression = facts.constraint?.expression;
  if (expression === undefined) return undefined;
  return facts.diameterConstraint ? expression : unhalvedExpression(expression);
}

/** The expression a circle's radius is bound to, as the radius (a bound Diameter dimension is shown halved), or undefined. */
export function circleRadiusExpression(facts: CircleDimensionFacts): string | undefined {
  const expression = facts.constraint?.expression;
  if (expression === undefined) return undefined;
  return facts.diameterConstraint ? halvedExpression(expression) : expression;
}

/** The driving dimension a request would change, if the sketch has one, so its bound expression can be shown and edited as text. */
export function drivingDimensionOf(sketch: Pick<WorkbenchSketch, "entities" | "constraints">, request: { readonly entityId: string; readonly dimension: SketchDimensionName; readonly secondEntityId?: string; readonly points?: readonly SketchPointRef[] }): WorkbenchSketchConstraint | undefined {
  const found = locateDimensionConstraint(sketch as WorkbenchSketch, request);
  return found === undefined || found.driven === true || found.suppressed === true ? undefined : found;
}

/** The expression a dimension is bound to, or undefined when it is a plain number (or absent). */
export function boundExpressionOf(sketch: Pick<WorkbenchSketch, "entities" | "constraints">, request: { readonly entityId: string; readonly dimension: SketchDimensionName; readonly secondEntityId?: string; readonly points?: readonly SketchPointRef[] }): string | undefined {
  return drivingDimensionOf(sketch, request)?.expression;
}
