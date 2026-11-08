import { bindableFieldsOf, boundValueProblem, featureAlias, findBindableField, type BindableDimension, type BindableField } from "./feature-bindings.js";
import {
  describeDimension,
  describeExpressionError,
  evaluateParsedExpression,
  isReservedExpressionName,
  MAX_EXPRESSION_LENGTH,
  parseExpression,
  type ExpressionReference,
  type Quantity,
  type ReferenceResolution
} from "./expressions.js";
import type { DesignHistory, DesignParameter, DesignSolidFeature, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * The expression engine's view of a project: user parameters, bound feature numbers and bound sketch dimensions form a graph in
 * which an expression depends on the names it uses. This module reads that graph (no project changes): it finds cycles, and
 * evaluates every expression in dependency order, so one broken expression marks only itself and what depends on it.
 */

export const MAX_DESIGN_PARAMETERS = 200;
export const MAX_COMMENT_LENGTH = 200;
/** The same envelope the sketch dimension operation enforces. */
export const SKETCH_DIMENSION_RANGE_MM = { min: 0.01, max: 10_000 } as const;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/u;

/** Why a parameter cannot have this name, or undefined when it can. */
export function parameterNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || name === "") return "A parameter needs a name.";
  if (!NAME_PATTERN.test(name)) return `"${name}" is not a valid name. Use letters, digits and underscores, starting with a letter or underscore, up to 48 characters.`;
  if (isReservedExpressionName(name)) return `"${name}" already means a unit or a function in expressions. Choose another name.`;
  return undefined;
}

/** The dimension a quantity of this kind has, as the evaluator tracks it. */
export const dimensionOfKind = (dimension: BindableDimension): { readonly length: number; readonly angle: number } =>
  dimension === "length" ? { length: 1, angle: 0 } : dimension === "angle" ? { length: 0, angle: 1 } : { length: 0, angle: 0 };

export type BindingSource = "parameter" | "feature" | "sketch";

/** One expression in the project, and what it came to. */
export interface BindingResult {
  readonly source: BindingSource;
  /** The parameter name, the feature ID, or the ID of the sketch feature (or the working sketch) holding the dimension. */
  readonly ownerId: string;
  /** "" for a parameter; the field ID of a feature; the constraint ID of a sketch dimension. */
  readonly fieldId: string;
  /** Human text for lists and messages: `pin_r`, `Extrude 1 · Distance`, `Sketch 1 · length of entity:line-1`. */
  readonly label: string;
  readonly expression: string;
  readonly ok: boolean;
  /** In millimetres, degrees or a plain number, depending on what the expression drives. */
  readonly value?: number;
  readonly dimension?: BindableDimension;
  readonly message?: string;
  /** Zero-based character offset of the problem inside `expression`, when the problem is in the text. */
  readonly position?: number;
}

export interface ExpressionReport {
  readonly bindings: readonly BindingResult[];
  readonly issues: readonly BindingResult[];
}

type NodeResult = { readonly ok: true; readonly quantity: Quantity } | { readonly ok: false; readonly message: string; readonly position?: number };

function sketchDimensionOf(constraint: WorkbenchSketchConstraint): "length" | "width" | "height" | "radius" | undefined {
  return constraint.dimension ?? (constraint.kind === "radius" ? "radius" : undefined);
}

/** The sketches whose dimensions can carry expressions: each timeline sketch, then the working sketch. */
function sketchesOf(history: DesignHistory, working: WorkbenchSketch | undefined): readonly { readonly ownerId: string; readonly name: string; readonly sketch: WorkbenchSketch }[] {
  const owners = history.features.flatMap((feature) => feature.kind === "sketch" ? [{ ownerId: feature.id, name: feature.name, sketch: feature.sketch }] : []);
  return working === undefined ? owners : [...owners, { ownerId: working.id, name: "Working sketch", sketch: working }];
}

const DIMENSION_WORD: Readonly<Record<"length" | "width" | "height" | "radius", string>> = { length: "length", width: "width", height: "height", radius: "radius" };

class Evaluation {
  private readonly parameters = new Map<string, DesignParameter>();
  private readonly aliases = new Map<string, DesignSolidFeature[]>();
  private readonly memo = new Map<string, NodeResult>();
  private readonly visiting: string[] = [];

  constructor(private readonly history: DesignHistory) {
    for (const parameter of history.parameters ?? []) this.parameters.set(parameter.name, parameter);
    for (const feature of history.features) {
      if (feature.kind === "sketch") continue;
      const alias = featureAlias(feature);
      this.aliases.set(alias, [...(this.aliases.get(alias) ?? []), feature]);
    }
  }

  /** The graph key of the node a reference points at, or undefined when it points at a plain (unbound) value or nothing. */
  keyOf(reference: ExpressionReference): string | undefined {
    if (reference.owner === undefined) return this.parameters.has(reference.name) ? `p:${reference.name}` : undefined;
    const owners = this.aliases.get(reference.owner);
    if (owners === undefined || owners.length !== 1) return undefined;
    const feature = owners[0]!;
    const field = findBindableField(feature, reference.name);
    return field !== undefined && feature.expressions?.[field.id] !== undefined ? `f:${feature.id}:${field.id}` : undefined;
  }

  labelOfKey(key: string): string {
    if (key.startsWith("p:")) return key.slice(2);
    const [, featureId, fieldId] = /^f:([^:]+:[^:]+):(.+)$/u.exec(key) ?? [];
    const feature = this.history.features.find((candidate) => candidate.id === featureId);
    return feature === undefined || feature.kind === "sketch" ? key : `${featureAlias(feature)}.${fieldId}`;
  }

  /** The nodes an expression's text depends on. Text that does not parse depends on nothing. */
  dependenciesOf(text: string): readonly string[] {
    const parsed = parseExpression(text);
    if (!parsed.ok) return [];
    return [...new Set(parsed.references.flatMap((reference) => { const key = this.keyOf(reference); return key === undefined ? [] : [key]; }))];
  }

  expressionOfKey(key: string): string | undefined {
    if (key.startsWith("p:")) return this.parameters.get(key.slice(2))?.expression;
    const [, featureId, fieldId] = /^f:([^:]+:[^:]+):(.+)$/u.exec(key) ?? [];
    const feature = this.history.features.find((candidate) => candidate.id === featureId);
    return feature === undefined || feature.kind === "sketch" ? undefined : feature.expressions?.[fieldId!];
  }

  allKeys(): readonly string[] {
    const keys = [...this.parameters.keys()].map((name) => `p:${name}`);
    for (const feature of this.history.features) {
      if (feature.kind === "sketch") continue;
      for (const field of Object.keys(feature.expressions ?? {})) keys.push(`f:${feature.id}:${field}`);
    }
    return keys;
  }

  /** The first cycle among parameters and bound feature values, as the names along it, or undefined. */
  findCycle(): readonly string[] | undefined {
    const done = new Set<string>();
    const path: string[] = [];
    const visit = (key: string): readonly string[] | undefined => {
      const at = path.indexOf(key);
      if (at >= 0) return [...path.slice(at), key].map((entry) => this.labelOfKey(entry));
      if (done.has(key)) return undefined;
      path.push(key);
      const text = this.expressionOfKey(key);
      if (text !== undefined) {
        for (const dependency of this.dependenciesOf(text)) {
          const found = visit(dependency);
          if (found !== undefined) return found;
        }
      }
      path.pop();
      done.add(key);
      return undefined;
    };
    for (const key of this.allKeys()) {
      const found = visit(key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  evaluateText(text: string): NodeResult {
    const parsed = parseExpression(text);
    if (!parsed.ok) return { ok: false, message: parsed.error.message, position: parsed.error.position };
    const result = evaluateParsedExpression(parsed, { resolve: (reference) => this.resolve(reference) });
    return result.ok ? result : { ok: false, message: result.error.message, position: result.error.position };
  }

  private nodeFor(key: string, compute: () => NodeResult): NodeResult {
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    if (this.visiting.includes(key)) return { ok: false, message: `Circular reference: ${[...this.visiting.slice(this.visiting.indexOf(key)), key].map((entry) => this.labelOfKey(entry)).join(" → ")}.` };
    this.visiting.push(key);
    const result = compute();
    this.visiting.pop();
    this.memo.set(key, result);
    return result;
  }

  parameterNode(name: string): NodeResult {
    return this.nodeFor(`p:${name}`, () => {
      const parameter = this.parameters.get(name)!;
      const evaluated = this.evaluateText(parameter.expression);
      if (!evaluated.ok) return evaluated;
      return this.fitParameterUnit(parameter, evaluated.quantity);
    });
  }

  /** A parameter's unit is a promise about what it is: a bare number takes the unit, and a value of the wrong kind is refused. */
  fitParameterUnit(parameter: DesignParameter, quantity: Quantity): NodeResult {
    const wanted = parameter.unit === "mm" ? dimensionOfKind("length") : parameter.unit === "deg" ? dimensionOfKind("angle") : dimensionOfKind("none");
    const scalar = quantity.length === 0 && quantity.angle === 0;
    if (scalar || (quantity.length === wanted.length && quantity.angle === wanted.angle)) return { ok: true, quantity: { value: quantity.value, length: wanted.length, angle: wanted.angle } };
    return { ok: false, message: `"${parameter.name}" is set to ${parameter.unit === "" ? "a plain number" : parameter.unit === "mm" ? "a length (mm)" : "an angle (deg)"}, but this expression gives ${describeDimension(quantity)}.` };
  }

  featureNode(feature: DesignSolidFeature, field: BindableField): NodeResult {
    const text = feature.expressions?.[field.id];
    const dimension = dimensionOfKind(field.dimension);
    if (text === undefined) {
      const value = field.read(feature);
      return value === undefined ? { ok: false, message: `${feature.name} has no ${field.label.toLowerCase()} set.` } : { ok: true, quantity: { value, ...dimension } };
    }
    return this.nodeFor(`f:${feature.id}:${field.id}`, () => {
      const evaluated = this.evaluateText(text);
      if (!evaluated.ok) return evaluated;
      return this.fitFieldDimension(field, evaluated.quantity);
    });
  }

  fitFieldDimension(field: BindableField, quantity: Quantity): NodeResult {
    const wanted = dimensionOfKind(field.dimension);
    const scalar = quantity.length === 0 && quantity.angle === 0;
    if (!scalar && (quantity.length !== wanted.length || quantity.angle !== wanted.angle)) {
      return { ok: false, message: `${field.label} needs ${describeDimension(wanted)}, but this expression gives ${describeDimension(quantity)}.` };
    }
    const problem = boundValueProblem(field, quantity.value);
    return problem === undefined ? { ok: true, quantity: { value: quantity.value, ...wanted } } : { ok: false, message: problem };
  }

  resolve(reference: ExpressionReference): ReferenceResolution {
    if (reference.owner === undefined) {
      if (!this.parameters.has(reference.name)) {
        return { ok: false, message: `Unknown name "${reference.name}". Add it in Change Parameters, or write Feature.value to use a feature's number.` };
      }
      const node = this.parameterNode(reference.name);
      return node.ok ? node : { ok: false, message: `Parameter "${reference.name}" has a problem: ${node.message}` };
    }
    const owners = this.aliases.get(reference.owner);
    if (owners === undefined) return { ok: false, message: `No feature is called "${reference.owner}". Write a feature's name without spaces, like Extrude1.distance.` };
    if (owners.length > 1) return { ok: false, message: `More than one feature is called "${reference.owner}". Rename one of them.` };
    const feature = owners[0]!;
    const field = findBindableField(feature, reference.name);
    if (field === undefined) {
      const known = bindableFieldsOf(feature).map((candidate) => candidate.id).join(", ");
      return { ok: false, message: `${feature.name} has no value called "${reference.name}"${known === "" ? "; it has no numbers an expression can use" : `. It has: ${known}`}.` };
    }
    const node = this.featureNode(feature, field);
    return node.ok ? node : { ok: false, message: `${feature.name}.${field.id} has a problem: ${node.message}` };
  }

  sketchNode(constraint: WorkbenchSketchConstraint): NodeResult {
    const evaluated = this.evaluateText(constraint.expression!);
    if (!evaluated.ok) return evaluated;
    const quantity = evaluated.quantity;
    const scalar = quantity.length === 0 && quantity.angle === 0;
    if (!scalar && !(quantity.length === 1 && quantity.angle === 0)) return { ok: false, message: `A dimension needs a length, but this expression gives ${describeDimension(quantity)}.` };
    if (!(quantity.value >= SKETCH_DIMENSION_RANGE_MM.min && quantity.value <= SKETCH_DIMENSION_RANGE_MM.max)) {
      return { ok: false, message: `A dimension must be between ${SKETCH_DIMENSION_RANGE_MM.min} and ${SKETCH_DIMENSION_RANGE_MM.max} mm, but this expression gives ${Number(quantity.value.toFixed(6))} mm.` };
    }
    return { ok: true, quantity: { value: quantity.value, ...dimensionOfKind("length") } };
  }
}

/**
 * The first circular reference among parameters and bound feature numbers, written as the names along it
 * (`["a", "b", "a"]`), or undefined when there is none.
 */
export function findParameterCycle(history: DesignHistory): readonly string[] | undefined {
  return new Evaluation(history).findCycle();
}

/** Evaluates a piece of text against the parameters and steps of a history, without binding it anywhere. */
export function evaluateTextInDesign(history: DesignHistory, text: string): { readonly ok: true; readonly quantity: Quantity } | { readonly ok: false; readonly message: string; readonly position?: number } {
  return new Evaluation(history).evaluateText(text);
}

/** Evaluates every expression in the history, and in the working sketch if one is given. */
export function evaluateDesignExpressions(history: DesignHistory, working?: WorkbenchSketch): ExpressionReport {
  const evaluation = new Evaluation(history);
  const bindings: BindingResult[] = [];
  for (const parameter of history.parameters ?? []) {
    const node = evaluation.parameterNode(parameter.name);
    bindings.push(node.ok
      ? { source: "parameter", ownerId: parameter.name, fieldId: "", label: parameter.name, expression: parameter.expression, ok: true, value: node.quantity.value, dimension: parameter.unit === "mm" ? "length" : parameter.unit === "deg" ? "angle" : "none" }
      : { source: "parameter", ownerId: parameter.name, fieldId: "", label: parameter.name, expression: parameter.expression, ok: false, message: node.message, ...(node.position === undefined ? {} : { position: node.position }) });
  }
  for (const feature of history.features) {
    if (feature.kind === "sketch" || feature.expressions === undefined) continue;
    for (const [fieldId, expression] of Object.entries(feature.expressions)) {
      const field = findBindableField(feature, fieldId);
      const label = `${feature.name} · ${field?.label ?? fieldId}`;
      if (field === undefined) {
        bindings.push({ source: "feature", ownerId: feature.id, fieldId, label, expression, ok: false, message: `${feature.name} no longer has a "${fieldId}" value.` });
        continue;
      }
      const node = evaluation.featureNode(feature, field);
      bindings.push(node.ok
        ? { source: "feature", ownerId: feature.id, fieldId, label, expression, ok: true, value: node.quantity.value, dimension: field.dimension }
        : { source: "feature", ownerId: feature.id, fieldId, label, expression, ok: false, message: node.message, ...(node.position === undefined ? {} : { position: node.position }) });
    }
  }
  for (const owner of sketchesOf(history, working)) {
    for (const constraint of owner.sketch.constraints) {
      if (constraint.expression === undefined) continue;
      const dimension = sketchDimensionOf(constraint);
      const label = `${owner.name} · ${dimension === undefined ? "dimension" : DIMENSION_WORD[dimension]} of ${constraint.entityIds[0] ?? "?"}`;
      const node = evaluation.sketchNode(constraint);
      bindings.push(node.ok
        ? { source: "sketch", ownerId: owner.ownerId, fieldId: constraint.id, label, expression: constraint.expression, ok: true, value: node.quantity.value, dimension: "length" }
        : { source: "sketch", ownerId: owner.ownerId, fieldId: constraint.id, label, expression: constraint.expression, ok: false, message: node.message, ...(node.position === undefined ? {} : { position: node.position }) });
    }
  }
  return { bindings, issues: bindings.filter((binding) => !binding.ok) };
}

/** A binding's problem as one line, with the character it points at when the problem is in the text. */
export function describeBindingIssue(binding: BindingResult): string {
  const where = binding.position === undefined ? "" : ` (character ${binding.position + 1} of "${binding.expression}")`;
  return `${binding.label}: ${binding.message ?? "has a problem"}${where}`;
}

/** Re-exported so callers that only look at expression text can render a parse error the same way. */
export { describeExpressionError, MAX_EXPRESSION_LENGTH };

/**
 * Whether a saved parameter table is well formed: a bounded list of uniquely named parameters, each with a parseable expression, a
 * known unit and a short comment, and no circular reference through them or through bound feature numbers. Whether the names an
 * expression uses exist is not checked here; that is evaluation, and a broken name is reported where it is used.
 */
export function validParameterTable(history: DesignHistory): boolean {
  const parameters = history.parameters;
  if (parameters === undefined) return true;
  if (!Array.isArray(parameters) || parameters.length > MAX_DESIGN_PARAMETERS) return false;
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (typeof parameter !== "object" || parameter === null) return false;
    const keys = Object.keys(parameter);
    if (keys.length !== 4 || !["name", "expression", "unit", "comment"].every((key) => keys.includes(key))) return false;
    if (parameterNameProblem(parameter.name) !== undefined || names.has(parameter.name)) return false;
    names.add(parameter.name);
    if (typeof parameter.expression !== "string" || parameter.expression.trim() === "" || parameter.expression.length > MAX_EXPRESSION_LENGTH || !parseExpression(parameter.expression).ok) return false;
    if (!["mm", "deg", ""].includes(parameter.unit)) return false;
    if (typeof parameter.comment !== "string" || parameter.comment.length > MAX_COMMENT_LENGTH) return false;
  }
  return findParameterCycle(history) === undefined;
}
