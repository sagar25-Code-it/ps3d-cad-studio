import { designOf, validSolidFeaturePayload, type DesignChange } from "./design.js";
import {
  parseExpression,
  renameOwnerReferences,
  renameParameterReferences,
  type Quantity
} from "./expressions.js";
import { bindableFieldsOf, featureAlias, findBindableField } from "./feature-bindings.js";
import {
  describeBindingIssue,
  evaluateDesignExpressions,
  evaluateTextInDesign,
  findParameterCycle,
  MAX_COMMENT_LENGTH,
  MAX_DESIGN_PARAMETERS,
  parameterNameProblem,
  SKETCH_DIMENSION_RANGE_MM,
  type BindingResult
} from "./parameter-graph.js";
import { locateDimensionConstraint, redriveDimension, restateDimensionSummary } from "./sketch-dimension-edit.js";
import { dimensionTargetValue } from "./sketch-measure.js";
import type { DesignFeature, DesignHistory, DesignParameter, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";
import { isSketchDatumEntityId } from "./types.js";
import { reconcileSketchObjects } from "./sketch-objects.js";
import { failure } from "./validation.js";

/**
 * Applies the expression engine to a project: user parameters, numbers of timeline steps and sketch dimensions that are bound to
 * expressions. Everything here is a pure reducer step; the solids are rebuilt afterwards by the caller (the kernel is asynchronous)
 * and applied with `regenerate-design`, exactly as after a sketch edit.
 *
 * A bound number keeps its last good value in the step itself. When an expression stops evaluating (a name was removed, the result
 * is out of range) the step keeps that value and so keeps its geometry, and the problem is reported per step, not as a failed edit.
 */

/** Resizes a sketch entity to a driving dimension; the sketch operations own this rule, so it is passed in. */
export type SketchResizer = (entity: SketchEntity, dimension: "length" | "width" | "height" | "radius", valueMm: number) => SketchEntity | undefined;

const SAME = 1e-9;
const differs = (a: number, b: number): boolean => Math.abs(a - b) > SAME * Math.max(1, Math.abs(a), Math.abs(b));

function denied(message: string, relatedIds: readonly string[] = []): DesignChange {
  return failure("INVALID_OPERATION", message, relatedIds, "Fix the expression, or remove the reference, and try again.");
}

/** Whether anything in the project uses an expression, which is when edits need the extra settling step. */
export function usesExpressions(project: WorkbenchProject): boolean {
  const history = project.design;
  if (history === undefined) return project.sketch.constraints.some((constraint) => constraint.expression !== undefined);
  return (history.parameters?.length ?? 0) > 0
    || history.features.some((feature) => feature.kind === "sketch" ? feature.sketch.constraints.some((constraint) => constraint.expression !== undefined) : feature.expressions !== undefined)
    || project.sketch.constraints.some((constraint) => constraint.expression !== undefined);
}

export interface ExpressionApplication {
  readonly project: WorkbenchProject;
  readonly changedIds: readonly string[];
  /** Every expression that could not be used, with the reason. Their steps keep their last good numbers. */
  readonly issues: readonly BindingResult[];
  /** How many bound numbers and dimensions got a new value. */
  readonly updated: number;
}

function applySketchBindings(sketch: WorkbenchSketch, results: readonly BindingResult[], resize: SketchResizer): { readonly sketch: WorkbenchSketch; readonly updated: number; readonly issues: readonly BindingResult[] } {
  let current = sketch;
  let updated = 0;
  const issues: BindingResult[] = [];
  for (const result of results) {
    if (!result.ok || result.value === undefined) continue;
    void resize;
    const constraint = current.constraints.find((candidate) => candidate.id === result.fieldId);
    const currentValue = constraint === undefined ? undefined : constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
    if (constraint === undefined || currentValue === undefined || !differs(currentValue, result.value)) continue;
    const gone = constraint.entityIds.find((id) => !isSketchDatumEntityId(id) && !current.entities.some((candidate) => candidate.id === id));
    if (gone !== undefined) {
      issues.push({ ...result, ok: false, message: `The dimension of ${gone} can no longer be driven (the entity is gone or changed kind).` });
      continue;
    }
    const revalued: WorkbenchSketchConstraint = constraint.kind === "angle" ? { ...constraint, valueDeg: result.value } : { ...constraint, valueMm: result.value };
    const withValue: WorkbenchSketch = { ...current, constraints: current.constraints.map((candidate) => candidate.id === constraint.id ? revalued : candidate) };
    if (constraint.suppressed === true) {
      // A relaxed dimension takes the new number but is not enforced.
      current = withValue;
      updated += 1;
      continue;
    }
    // The dimension's geometry follows the new value and the relations around it are enforced again, so connected geometry follows (a joint, a tangent circle).
    const redriven = redriveDimension(withValue, revalued);
    if (!redriven.ok) {
      issues.push({ ...result, ok: false, message: `The sketch could not follow this value: ${redriven.applied.diagnostics[0]?.message ?? "the relations cannot all hold"}` });
      continue;
    }
    current = redriven.sketch;
    updated += 1;
  }
  // Associative pattern copies follow the source curve that a parameter just resized.
  if (updated > 0 && (current.patterns?.length ?? 0) > 0) {
    const followed = reconcileSketchObjects(sketch, current, new Set());
    if (followed.ok) current = followed.sketch;
  }
  return { sketch: current, updated, issues };
}

/**
 * Brings every bound number up to date with its expression: steps get the new value, sketch dimensions resize their geometry and
 * the sketch is solved again. An expression that fails changes nothing and is listed in `issues`. Safe to run any number of times.
 */
export function applyDesignExpressions(project: WorkbenchProject, resize: SketchResizer): ExpressionApplication {
  const history = designOf(project);
  const report = evaluateDesignExpressions(history, project.sketch);
  const issues: BindingResult[] = report.issues.filter((binding) => binding.source !== "sketch");
  const changedIds: string[] = [];
  let updated = 0;

  const features = history.features.map((feature): DesignFeature => {
    if (feature.kind === "sketch") {
      const own = report.bindings.filter((binding) => binding.source === "sketch" && binding.ownerId === feature.id);
      if (own.length === 0) return feature;
      const applied = applySketchBindings(feature.sketch, own, resize);
      issues.push(...own.filter((binding) => !binding.ok), ...applied.issues);
      if (applied.updated === 0) return feature;
      updated += applied.updated;
      changedIds.push(feature.id);
      return { ...feature, sketch: applied.sketch };
    }
    if (feature.expressions === undefined) return feature;
    const own = report.bindings.filter((binding) => binding.source === "feature" && binding.ownerId === feature.id && binding.ok && binding.value !== undefined);
    let candidate: DesignSolidFeature = feature;
    let count = 0;
    for (const binding of own) {
      const field = findBindableField(feature, binding.fieldId);
      if (field === undefined) continue;
      const stored = field.read(candidate);
      if (stored !== undefined && !differs(stored, binding.value!)) continue;
      candidate = field.write(candidate, binding.value!);
      count += 1;
    }
    if (count === 0) return feature;
    if (!validSolidFeaturePayload(candidate)) {
      issues.push(...own.map((binding): BindingResult => ({ ...binding, ok: false, message: `${feature.name} cannot take these values together: they are outside what this step supports.` })));
      return feature;
    }
    updated += count;
    changedIds.push(feature.id);
    return candidate;
  });

  const workingBindings = report.bindings.filter((binding) => binding.source === "sketch" && binding.ownerId === project.sketch.id);
  issues.push(...report.bindings.filter((binding) => binding.source === "sketch" && !binding.ok));
  let sketch = project.sketch;
  if (workingBindings.length > 0) {
    const applied = applySketchBindings(project.sketch, workingBindings, resize);
    issues.push(...applied.issues);
    if (applied.updated > 0) { sketch = applied.sketch; updated += applied.updated; changedIds.push(project.sketch.id); }
  }
  const unique = dedupe(issues);
  const flagged = flagExpressionHealth(features, unique);
  if (changedIds.length === 0 && flagged === features) return { project, changedIds, issues: unique, updated };
  return { project: { ...project, sketch, design: { ...history, features: flagged } }, changedIds, issues: unique, updated };
}

/** Every health message this module writes starts with this, so it can be told from a rebuild failure and cleared when the expression is fixed. */
export const EXPRESSION_HEALTH_PREFIX = "Expression: ";

/**
 * Marks the steps and sketches whose expressions cannot be used, with the reason, in the same `health` field a failed rebuild uses, so the
 * timeline, the model tree and the inspector flag them with no extra wiring. A mark from an earlier run that no longer applies is removed.
 * Returns the same array when nothing changes.
 */
function flagExpressionHealth(features: readonly DesignFeature[], issues: readonly BindingResult[]): readonly DesignFeature[] {
  let changed = false;
  const next = features.map((feature): DesignFeature => {
    const issue = issues.find((candidate) => (candidate.source === "feature" || candidate.source === "sketch") && candidate.ownerId === feature.id);
    if (issue !== undefined) {
      const message = `${EXPRESSION_HEALTH_PREFIX}${describeBindingIssue(issue)}`.slice(0, 400);
      if (feature.health?.message === message) return feature;
      changed = true;
      return { ...feature, health: { message } };
    }
    if (feature.health?.message.startsWith(EXPRESSION_HEALTH_PREFIX) === true) {
      changed = true;
      const { health: _cleared, ...rest } = feature;
      void _cleared;
      return rest as DesignFeature;
    }
    return feature;
  });
  return changed ? next : features;
}

function dedupe(issues: readonly BindingResult[]): readonly BindingResult[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.source}|${issue.ownerId}|${issue.fieldId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** What is wrong with the expressions of this project right now, per step. Empty when every bound number is in step with its expression. */
export function designExpressionIssues(project: WorkbenchProject, resize: SketchResizer): readonly BindingResult[] {
  if (!usesExpressions(project)) return [];
  return applyDesignExpressions(project, resize).issues;
}

/** The first problem with the expressions of a step, as one line, or undefined. For a timeline badge and tooltip. */
export function featureExpressionProblem(issues: readonly BindingResult[], featureId: string): string | undefined {
  const issue = issues.find((candidate) => (candidate.source === "feature" || candidate.source === "sketch") && candidate.ownerId === featureId);
  return issue === undefined ? undefined : describeBindingIssue(issue);
}

// ---------------------------------------------------------------------------------------------
// The parameter table
// ---------------------------------------------------------------------------------------------

export interface ParameterRename {
  readonly from: string;
  readonly to: string;
}

/** Applies a rewrite to every expression text in the project: parameters, steps, timeline sketches and the working sketch. */
function rewriteAllExpressions(project: WorkbenchProject, rewrite: (text: string) => string): WorkbenchProject {
  const history = designOf(project);
  const sketchWith = (sketch: WorkbenchSketch): WorkbenchSketch => sketch.constraints.some((constraint) => constraint.expression !== undefined)
    ? { ...sketch, constraints: sketch.constraints.map((constraint) => constraint.expression === undefined ? constraint : { ...constraint, expression: rewrite(constraint.expression) }) }
    : sketch;
  const features = history.features.map((feature): DesignFeature => {
    if (feature.kind === "sketch") return { ...feature, sketch: sketchWith(feature.sketch) };
    if (feature.expressions === undefined) return feature;
    return { ...feature, expressions: Object.fromEntries(Object.entries(feature.expressions).map(([key, text]) => [key, rewrite(text)])) };
  });
  const parameters = history.parameters?.map((parameter) => ({ ...parameter, expression: rewrite(parameter.expression) }));
  const nextHistory: DesignHistory = { ...history, features, ...(parameters === undefined ? {} : { parameters }) };
  return { ...project, sketch: sketchWith(project.sketch), ...(project.design === undefined && features.length === 0 && parameters === undefined ? {} : { design: nextHistory }) };
}

function tableProblem(parameters: readonly DesignParameter[]): string | undefined {
  if (parameters.length > MAX_DESIGN_PARAMETERS) return `A project holds at most ${MAX_DESIGN_PARAMETERS} parameters.`;
  const names = new Set<string>();
  for (const parameter of parameters) {
    const problem = parameterNameProblem(parameter.name);
    if (problem !== undefined) return problem;
    if (names.has(parameter.name)) return `The name "${parameter.name}" is used twice. Every parameter needs its own name.`;
    names.add(parameter.name);
    if (!["mm", "deg", ""].includes(parameter.unit)) return `${parameter.name}: the unit must be mm, deg or empty.`;
    if (typeof parameter.comment !== "string" || parameter.comment.length > MAX_COMMENT_LENGTH) return `${parameter.name}: the comment is longer than ${MAX_COMMENT_LENGTH} characters.`;
    if (typeof parameter.expression !== "string" || parameter.expression.trim() === "") return `${parameter.name}: type a value or an expression.`;
    const parsed = parseExpression(parameter.expression);
    if (!parsed.ok) return `${parameter.name}: ${parsed.error.message} (character ${parsed.error.position + 1})`;
  }
  return undefined;
}

function withoutEmptyTable(history: DesignHistory): DesignHistory {
  if ((history.parameters?.length ?? 0) > 0) return history;
  const { parameters: _none, ...rest } = history;
  void _none;
  return rest;
}

/** Which names a set of expression texts uses, as bare parameter references. */
function usedParameterNames(texts: readonly string[]): ReadonlySet<string> {
  const used = new Set<string>();
  for (const text of texts) {
    const parsed = parseExpression(text);
    if (parsed.ok) for (const reference of parsed.references) if (reference.owner === undefined) used.add(reference.name);
  }
  return used;
}

function allExpressionTexts(project: WorkbenchProject): readonly string[] {
  const history = designOf(project);
  const fromSketch = (sketch: WorkbenchSketch): readonly string[] => sketch.constraints.flatMap((constraint) => constraint.expression === undefined ? [] : [constraint.expression]);
  return [
    ...(history.parameters ?? []).map((parameter) => parameter.expression),
    ...history.features.flatMap((feature) => feature.kind === "sketch" ? fromSketch(feature.sketch) : Object.values(feature.expressions ?? {})),
    ...fromSketch(project.sketch)
  ];
}

/**
 * Replaces the parameter table. Renames are applied everywhere first, so no reference breaks; a parameter that is still used cannot
 * be removed; a circular reference or an expression that does not evaluate is refused. After that, every bound number is
 * re-evaluated and the project comes back with the new values (the solids are rebuilt by the caller).
 */
export function setDesignParameters(project: WorkbenchProject, parameters: readonly DesignParameter[], renames: readonly ParameterRename[], resize: SketchResizer): DesignChange {
  const history = designOf(project);
  const before = history.parameters ?? [];
  const problem = tableProblem(parameters);
  if (problem !== undefined) return denied(problem);

  const newNames = new Set(parameters.map((parameter) => parameter.name));
  const renameMap = new Map<string, string>();
  for (const rename of renames) {
    if (rename.from === rename.to) continue;
    if (!before.some((parameter) => parameter.name === rename.from)) return denied(`"${rename.from}" is not an existing parameter, so it cannot be renamed.`);
    if (!newNames.has(rename.to)) return denied(`The renamed parameter "${rename.to}" is not in the new table.`);
    if (renameMap.has(rename.from) || [...renameMap.values()].includes(rename.to)) return denied(`The rename of "${rename.from}" to "${rename.to}" repeats another rename.`);
    renameMap.set(rename.from, rename.to);
  }

  // Put the new table in, then rewrite every expression for the renames in one pass (so two names can swap).
  const withTable: WorkbenchProject = { ...project, design: { ...history, parameters } };
  const renamed = renameMap.size === 0 ? withTable : rewriteAllExpressions(withTable, (text) => renameParameterReferences(text, renameMap));

  // A parameter that something still uses cannot be removed.
  const gone = before.map((parameter) => parameter.name).filter((name) => !newNames.has(name) && !renameMap.has(name));
  if (gone.length > 0) {
    const stillUsed = usedParameterNames(allExpressionTexts(renamed));
    const blocked = gone.find((name) => stillUsed.has(name));
    if (blocked !== undefined) return denied(`"${blocked}" is still used by an expression, so it cannot be removed. Change those expressions first.`, [blocked]);
  }

  const settledHistory = designOf(renamed);
  const cycle = findParameterCycle(settledHistory);
  if (cycle !== undefined) return denied(`Circular reference: ${cycle.join(" → ")}. A value cannot depend on itself.`, cycle);

  // Every parameter must evaluate; a broken step or dimension is reported, not refused.
  const report = evaluateDesignExpressions(settledHistory, renamed.sketch);
  const broken = report.bindings.find((binding) => binding.source === "parameter" && !binding.ok);
  if (broken !== undefined) return denied(describeBindingIssue(broken), [broken.ownerId]);

  const applied = applyDesignExpressions(renamed, resize);
  const finalHistory = designOf(applied.project);
  const withoutEmpty = withoutEmptyTable(finalHistory);
  // Audit IDs must be stable IDs, which a parameter name is not, so the table's rows are named by position.
  const changedIds = [...new Set([...parameters.map((_parameter, index) => `parameter:row-${index + 1}`), ...applied.changedIds])];
  const rewritten = renameMap.size === 0 ? "" : ` Renamed ${[...renameMap].map(([from, to]) => `${from} to ${to}`).join(", ")} in every expression.`;
  const trouble = applied.issues.filter((issue) => issue.source !== "parameter");
  return {
    ok: true,
    value: {
      project: { ...applied.project, design: withoutEmpty },
      changedIds,
      summary: `Saved ${parameters.length} parameter${parameters.length === 1 ? "" : "s"}.${rewritten} ${applied.updated} bound value${applied.updated === 1 ? "" : "s"} changed.${trouble.length === 0 ? "" : ` ${trouble.length} could not be used: ${describeBindingIssue(trouble[0]!)}`}`
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Settling other operations
// ---------------------------------------------------------------------------------------------

const SETTLING_KINDS: ReadonlySet<WorkbenchOperation["kind"]> = new Set(["add-design-solid", "update-design-solid", "commit-design-sketch", "set-sketch-dimension", "delete-design-feature", "rename-design-feature", "regenerate-design"]);

/**
 * Runs after an operation that can change what an expression refers to or what it drives: a step was added or edited, a sketch was
 * finished, a dimension was bound, a step was deleted or renamed. It carries a step rename into the expressions that name the step,
 * refuses a circular reference, binds a typed sketch expression, and re-evaluates everything bound, so a change to one step reaches
 * the numbers that depend on it. An edit whose own expression does not evaluate is refused instead of saved.
 */
export function settleDesignExpressions(before: WorkbenchProject, operation: WorkbenchOperation, result: DesignChange, resize: SketchResizer): DesignChange {
  if (!result.ok || !SETTLING_KINDS.has(operation.kind)) return result;
  let project = result.value.project;
  const summary = result.value.summary;

  if (operation.kind === "rename-design-feature") {
    const oldFeature = designOf(before).features.find((feature) => feature.id === operation.featureId);
    const newFeature = designOf(project).features.find((feature) => feature.id === operation.featureId);
    if (oldFeature !== undefined && newFeature !== undefined && oldFeature.kind !== "sketch" && newFeature.kind !== "sketch") {
      const from = featureAlias(oldFeature);
      const to = featureAlias(newFeature);
      if (from !== to) project = rewriteAllExpressions(project, (text) => renameOwnerReferences(text, new Map([[from, to]])));
    }
  }

  if (operation.kind === "set-sketch-dimension" && operation.expression !== undefined) {
    const dimension = operation.dimension;
    const target = locateDimensionConstraint(project.sketch, { entityId: operation.entityId, dimension, ...(operation.secondEntityId === undefined ? {} : { secondEntityId: operation.secondEntityId }), ...(operation.points === undefined ? {} : { points: operation.points }) });
    if (target === undefined) return result;
    const parsed = parseExpression(operation.expression);
    if (!parsed.ok) return denied(`${parsed.error.message} (character ${parsed.error.position + 1})`, [operation.entityId]);
    project = { ...project, sketch: { ...project.sketch, constraints: project.sketch.constraints.map((constraint) => constraint.id === target.id ? { ...constraint, expression: operation.expression! } : constraint) } };
  }

  if (!usesExpressions(project)) return operation.kind === "rename-design-feature" ? { ok: true, value: { ...result.value, project } } : result;

  const cycle = findParameterCycle(designOf(project));
  if (cycle !== undefined) return denied(`Circular reference: ${cycle.join(" → ")}. A value cannot depend on itself.`, cycle);

  const applied = applyDesignExpressions(project, resize);
  // The edit's own expressions must work: refuse a step or dimension whose expression cannot be evaluated.
  const ownId = operation.kind === "add-design-solid" || operation.kind === "update-design-solid" ? operation.feature.id
    : operation.kind === "set-sketch-dimension" ? project.sketch.id : undefined;
  if (ownId !== undefined) {
    const own = applied.issues.find((issue) => issue.ownerId === ownId && (issue.source === "feature" || (operation.kind === "set-sketch-dimension" && issue.source === "sketch")));
    if (own !== undefined) return denied(describeBindingIssue(own), [own.ownerId]);
  }
  const changedIds = [...new Set([...result.value.changedIds, ...applied.changedIds])];
  const note = applied.updated === 0 ? "" : ` ${applied.updated} bound value${applied.updated === 1 ? "" : "s"} followed the change.`;
  let stated = summary;
  if (operation.kind === "set-sketch-dimension" && operation.expression !== undefined) {
    const bound = locateDimensionConstraint(applied.project.sketch, { entityId: operation.entityId, dimension: operation.dimension, ...(operation.secondEntityId === undefined ? {} : { secondEntityId: operation.secondEntityId }), ...(operation.points === undefined ? {} : { points: operation.points }) });
    const evaluated = bound === undefined ? undefined : dimensionTargetValue(bound);
    if (evaluated !== undefined) stated = restateDimensionSummary(summary, operation, evaluated, project.sketch);
  }
  return { ok: true, value: { project: applied.project, changedIds, summary: `${stated}${note}` } };
}

// ---------------------------------------------------------------------------------------------
// Binding a step's numbers (used by the Edit feature dialog and by tests)
// ---------------------------------------------------------------------------------------------

export type FeatureBinding =
  | { readonly ok: true; readonly feature: DesignSolidFeature; readonly values: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly fieldId: string; readonly message: string; readonly position?: number };

/**
 * Returns the step with `texts` (field ID to expression) bound to its fields and the fields set to what the expressions give right
 * now. A field not in `texts` is unbound but keeps its number. Nothing is changed in the project: the caller sends the returned
 * step through `update-design-solid` (or `add-design-solid`).
 */
export function bindFeatureExpressions(project: WorkbenchProject, feature: DesignSolidFeature, texts: Readonly<Record<string, string>>): FeatureBinding {
  const { expressions: _previous, ...plain } = feature;
  void _previous;
  const entries = Object.entries(texts).filter(([, text]) => text.trim() !== "");
  const candidate: DesignSolidFeature = entries.length === 0 ? plain : { ...plain, expressions: Object.fromEntries(entries.map(([key, text]) => [key, text.trim()])) };
  for (const [fieldId, text] of entries) {
    if (findBindableField(candidate, fieldId) === undefined) return { ok: false, fieldId, message: `${feature.name} has no number called "${fieldId}" that an expression can drive.` };
    const parsed = parseExpression(text);
    if (!parsed.ok) return { ok: false, fieldId, message: parsed.error.message, position: parsed.error.position };
  }
  if (entries.length === 0) return { ok: true, feature: candidate, values: {} };
  const history = designOf(project);
  const exists = history.features.some((existing) => existing.id === feature.id);
  const asHistory: DesignHistory = { ...history, features: exists ? history.features.map((existing) => existing.id === feature.id ? candidate : existing) : [...history.features, candidate] };
  const cycle = findParameterCycle(asHistory);
  if (cycle !== undefined) return { ok: false, fieldId: entries[0]![0], message: `Circular reference: ${cycle.join(" → ")}.` };
  const report = evaluateDesignExpressions(asHistory);
  const values: Record<string, number> = {};
  let next = candidate;
  for (const [fieldId] of entries) {
    const result = report.bindings.find((binding) => binding.source === "feature" && binding.ownerId === feature.id && binding.fieldId === fieldId);
    if (result === undefined || !result.ok || result.value === undefined) return { ok: false, fieldId, message: result?.message ?? "This expression could not be evaluated.", ...(result?.position === undefined ? {} : { position: result.position }) };
    const field = findBindableField(next, fieldId)!;
    values[fieldId] = result.value;
    next = field.write(next, result.value);
  }
  if (!validSolidFeaturePayload(next)) return { ok: false, fieldId: entries[0]![0], message: "Those values are outside what this step supports." };
  return { ok: true, feature: next, values };
}

/** The result of evaluating some text for a field of a step, for live feedback while typing. */
export type FieldPreview = { readonly ok: true; readonly value: number; readonly text: string } | { readonly ok: false; readonly message: string; readonly position?: number };

/** Evaluates `text` as the value of one field of `feature` against the project, without changing anything. */
export function previewFieldExpression(project: WorkbenchProject, feature: DesignSolidFeature, fieldId: string, text: string): FieldPreview {
  const field = findBindableField(feature, fieldId);
  if (field === undefined) return { ok: false, message: "This number cannot be driven by an expression." };
  const bound = bindFeatureExpressions(project, feature, { [fieldId]: text });
  if (!bound.ok) return { ok: false, message: bound.message, ...(bound.position === undefined ? {} : { position: bound.position }) };
  const value = bound.values[fieldId]!;
  const unit = field.dimension === "length" ? " mm" : field.dimension === "angle" ? "°" : "";
  return { ok: true, value, text: `${Number(value.toFixed(6))}${unit}` };
}

/** Evaluates `text` as a sketch dimension (a length in mm) against the project, for live feedback while typing. */
export function previewDimensionExpression(project: WorkbenchProject, text: string): FieldPreview {
  const evaluated = evaluateTextInDesign(designOf(project), text, project.sketch);
  if (!evaluated.ok) return evaluated;
  const quantity: Quantity = evaluated.quantity;
  if (!(quantity.angle === 0 && (quantity.length === 0 || quantity.length === 1))) return { ok: false, message: "A dimension needs a length." };
  if (!(quantity.value >= SKETCH_DIMENSION_RANGE_MM.min && quantity.value <= SKETCH_DIMENSION_RANGE_MM.max)) return { ok: false, message: `A dimension must be between ${SKETCH_DIMENSION_RANGE_MM.min} and ${SKETCH_DIMENSION_RANGE_MM.max} mm.` };
  return { ok: true, value: quantity.value, text: `${Number(quantity.value.toFixed(6))} mm` };
}

/** The names the Edit feature dialog can offer as references for a step: `Extrude1.distance` and so on. */
export function referenceNamesOf(feature: DesignSolidFeature): readonly string[] {
  return bindableFieldsOf(feature).map((field) => `${featureAlias(feature)}.${field.id}`);
}

