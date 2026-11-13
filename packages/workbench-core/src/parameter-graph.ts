import { ENVELOPE_LIMITS } from "./envelope-limits.js";
import { dimensionNameOf } from "./sketch-dimension-edit.js";
import { sketchEntityName } from "./sketch-names.js";
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
import type { DesignHistory, DesignParameter, DesignSolidFeature, SketchDimensionName, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";
import { DIMENSION_NAME_PATTERN, dimensionNamed } from "./dimension-names.js";

/**
 * The expression engine's view of a project: user parameters, bound feature numbers and bound sketch dimensions form a graph in
 * which an expression depends on the names it uses. This module reads that graph (no project changes): it finds cycles, and
 * evaluates every expression in dependency order, so one broken expression marks only itself and what depends on it.
 */

export const MAX_DESIGN_PARAMETERS = 200;
export const MAX_COMMENT_LENGTH = 200;
/** The same envelope the sketch dimension operation enforces: a side up to 200 m, a radius up to 100 m (see envelope-limits.ts). */
export const SKETCH_DIMENSION_RANGE_MM = { min: ENVELOPE_LIMITS.minGeometryMm, max: ENVELOPE_LIMITS.maxSketchSizeMm } as const;

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

/** The long dimensions (arc length, perimeter, diameter) reach twice as far as a length. */
const LONG_DIMENSIONS: readonly SketchDimensionName[] = ["arc-length", "perimeter", "diameter"];
/** A distance between points or lines may be zero. */
const ZERO_ALLOWED: readonly SketchDimensionName[] = ["aligned", "horizontal", "vertical", "point-line", "line-line"];

/**
 * Whether an evaluated expression is acceptable as the value of the named sketch dimension, and the value it gives (millimetres, or
 * degrees for an angle). Shared by the bound dimensions of a project and by the live preview of what a person is typing.
 */
export function checkSketchDimensionQuantity(name: SketchDimensionName, quantity: Quantity): NodeResult {
  const scalar = quantity.length === 0 && quantity.angle === 0;
  if (name === "angle") {
    // An angle dimension takes degrees: a plain number means degrees, "30 deg" and "0.5 rad" convert.
    if (!scalar && !(quantity.length === 0 && quantity.angle === 1)) return { ok: false, message: `An angle dimension needs an angle, but this expression gives ${describeDimension(quantity)}.` };
    if (!(quantity.value >= 0 && quantity.value < 360)) return { ok: false, message: `An angle dimension must be at least 0° and under 360°, but this expression gives ${Number(quantity.value.toFixed(6))}°.` };
    return { ok: true, quantity: { value: quantity.value, ...dimensionOfKind("angle") } };
  }
  if (!scalar && !(quantity.length === 1 && quantity.angle === 0)) return { ok: false, message: `A dimension needs a length, but this expression gives ${describeDimension(quantity)}.` };
  const minimum = ZERO_ALLOWED.includes(name) ? 0 : SKETCH_DIMENSION_RANGE_MM.min;
  const maximum = name === "radius" ? ENVELOPE_LIMITS.maxSketchRadiusMm : LONG_DIMENSIONS.includes(name) ? SKETCH_DIMENSION_RANGE_MM.max * 2 : SKETCH_DIMENSION_RANGE_MM.max;
  if (!(quantity.value >= minimum && quantity.value <= maximum)) {
    return { ok: false, message: `A dimension must be between ${minimum} and ${maximum} mm, but this expression gives ${Number(quantity.value.toFixed(6))} mm.` };
  }
  return { ok: true, quantity: { value: quantity.value, ...dimensionOfKind("length") } };
}

function sketchDimensionOf(constraint: WorkbenchSketchConstraint): SketchDimensionName {
  return dimensionNameOf(constraint);
}

/** The sketches whose dimensions can carry expressions: each timeline sketch, then the working sketch. */
function sketchesOf(history: DesignHistory, working: WorkbenchSketch | undefined): readonly { readonly ownerId: string; readonly name: string; readonly sketch: WorkbenchSketch }[] {
  const owners = history.features.flatMap((feature) => feature.kind === "sketch" ? [{ ownerId: feature.id, name: feature.name, sketch: feature.sketch }] : []);
  return working === undefined ? owners : [...owners, { ownerId: working.id, name: "Working sketch", sketch: working }];
}

const DIMENSION_WORD: Readonly<Record<SketchDimensionName, string>> = {
  length: "length", width: "width", height: "height", radius: "radius", diameter: "diameter", angle: "angle", "arc-length": "arc length", perimeter: "perimeter",
  aligned: "distance", horizontal: "horizontal distance", vertical: "vertical distance", "point-line": "distance to line", "line-line": "distance between lines",
  "major-radius": "major radius", "minor-radius": "minor radius"
};

class Evaluation {
  private readonly parameters = new Map<string, DesignParameter>();
  private readonly aliases = new Map<string, DesignSolidFeature[]>();
  private readonly memo = new Map<string, NodeResult>();
  private readonly visiting: string[] = [];

  constructor(private readonly history: DesignHistory, private readonly working?: WorkbenchSketch) {
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
    if (key.startsWith("p:") || key.startsWith("d:")) return key.slice(2);
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
        // The name of a sketch dimension (d1, d2 ...): its value now, or what its own expression gives.
        const named = DIMENSION_NAME_PATTERN.test(reference.name) ? dimensionNamed(this.history, this.working, reference.name) : undefined;
        if (named !== undefined) {
          const node = this.dimensionNode(reference.name, named);
          return node.ok ? node : { ok: false, message: `Dimension ${reference.name} has a problem: ${node.message}` };
        }
        if (DIMENSION_NAME_PATTERN.test(reference.name)) return { ok: false, message: `No dimension is called "${reference.name}". Dimension names are shown on each dimension; a deleted or reference dimension has none.` };
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

  /** A named sketch dimension as a value: an angle in degrees or a length in millimetres. A bound one gives what its expression gives. */
  dimensionNode(name: string, constraint: WorkbenchSketchConstraint): NodeResult {
    return this.nodeFor(`d:${name}`, () => {
      if (constraint.expression !== undefined) return this.sketchNode(constraint);
      const value = constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
      if (value === undefined) return { ok: false, message: "it has no value." };
      return { ok: true, quantity: { value, ...dimensionOfKind(constraint.kind === "angle" ? "angle" : "length") } };
    });
  }

  sketchNode(constraint: WorkbenchSketchConstraint): NodeResult {
    const evaluated = this.evaluateText(constraint.expression!);
    if (!evaluated.ok) return evaluated;
    return checkSketchDimensionQuantity(constraint.kind === "angle" ? "angle" : sketchDimensionOf(constraint), evaluated.quantity);
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
export function evaluateTextInDesign(history: DesignHistory, text: string, working?: WorkbenchSketch): { readonly ok: true; readonly quantity: Quantity } | { readonly ok: false; readonly message: string; readonly position?: number } {
  return new Evaluation(history, working).evaluateText(text);
}

/** Evaluates every expression in the history, and in the working sketch if one is given. */
export function evaluateDesignExpressions(history: DesignHistory, working?: WorkbenchSketch): ExpressionReport {
  const evaluation = new Evaluation(history, working);
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
      const label = `${owner.name} · ${DIMENSION_WORD[dimension]} of ${constraint.entityIds[0] === undefined ? "?" : sketchEntityName(owner.sketch, constraint.entityIds[0])}`;
      const node = evaluation.sketchNode(constraint);
      bindings.push(node.ok
        ? { source: "sketch", ownerId: owner.ownerId, fieldId: constraint.id, label, expression: constraint.expression, ok: true, value: node.quantity.value, dimension: constraint.kind === "angle" ? "angle" : "length" }
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
