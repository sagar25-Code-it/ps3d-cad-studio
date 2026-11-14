import { designOf, validSolidFeaturePayload } from "./design.js";
import { boundValueProblem, findBindableField, bindableFieldsOf } from "./feature-bindings.js";
import { parseExpression } from "./expressions.js";
import { checkSketchDimensionQuantity, dimensionOfKind, evaluateDesignExpressions } from "./parameter-graph.js";
import { dimensionNameOf, redriveDimension } from "./sketch-dimension-edit.js";
import { isDrivingDimension } from "./dimension-names.js";
import { sketchEntityNames } from "./sketch-names.js";
import type { DesignFeature, DesignSketchFeature, DesignSolidFeature, WorkbenchProject, WorkbenchSketchConstraint } from "./types.js";

/**
 * HS-08: the model parameters of a design, as the Change Parameters table lists them. Every number a timeline step takes (its bindable
 * fields) and every driving dimension of a timeline sketch is a row, grouped under its step. A row has the text it is driven by (an
 * expression, or the plain number) and, when edited in the table, goes back to the project as a `ModelValueEdit` inside the same
 * operation as the user-parameter table, so one Apply is one undo step.
 */

export interface ModelValueEdit {
  /** The timeline step, or timeline sketch, the value belongs to. */
  readonly ownerId: string;
  /** A step: the bindable field id (`distance`). A sketch: the id of the dimension constraint. */
  readonly fieldId: string;
  /** A plain number, or an expression (`plate_h / 2`, `d1 * 2`, `Extrude1.distance`). */
  readonly text: string;
}

export interface ModelValueRow {
  readonly ownerId: string;
  readonly fieldId: string;
  /** The group heading: the step's or sketch's name. */
  readonly group: string;
  readonly groupKind: "step" | "sketch";
  /** The name the row is known by: the field's label for a step ("Distance"), the dimension's own name for a sketch ("d1"). */
  readonly name: string;
  /** What kind of thing it is, in words: "length of Line 2". Empty for a step's field. */
  readonly detail: string;
  readonly unit: "mm" | "deg" | "";
  /** The text the value is driven by: its expression when bound, otherwise the plain number. */
  readonly text: string;
  /** True when `text` is an expression. */
  readonly bound: boolean;
  /** The value now, as a number in mm, degrees or plain. */
  readonly value: number;
}

const trim = (value: number): string => String(Number(value.toFixed(6)));

const plainNumber = (text: string): number | undefined => {
  const typed = text.trim().replace(/,(?=\d)/u, ".");
  const value = Number(typed);
  return typed !== "" && Number.isFinite(value) ? value : undefined;
};

/** Every model parameter of the timeline, in timeline order: steps by their bindable fields, sketches by their driving dimensions. */
export function modelValueRowsOf(project: WorkbenchProject): readonly ModelValueRow[] {
  const rows: ModelValueRow[] = [];
  for (const feature of designOf(project).features) {
    if (feature.kind === "sketch") {
      const names = sketchEntityNames(feature.sketch.entities);
      for (const constraint of feature.sketch.constraints) {
        if (!isDrivingDimension(constraint)) continue;
        const value = constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
        if (value === undefined) continue;
        const subject = constraint.entityIds.map((id) => names.get(id) ?? "").filter((name) => name !== "").join(" and ");
        rows.push({
          ownerId: feature.id, fieldId: constraint.id, group: feature.name, groupKind: "sketch",
          name: constraint.name ?? "dimension", detail: `${dimensionNameOf(constraint)}${subject === "" ? "" : ` of ${subject}`}`,
          unit: constraint.kind === "angle" ? "deg" : "mm",
          text: constraint.expression ?? trim(value), bound: constraint.expression !== undefined, value
        });
      }
      continue;
    }
    for (const field of bindableFieldsOf(feature)) {
      const value = field.read(feature);
      if (value === undefined) continue;
      const expression = feature.expressions?.[field.id];
      rows.push({
        ownerId: feature.id, fieldId: field.id, group: feature.name, groupKind: "step", name: field.label, detail: "",
        unit: field.dimension === "length" ? "mm" : field.dimension === "angle" ? "deg" : "",
        text: expression ?? trim(value), bound: expression !== undefined, value
      });
    }
  }
  return rows;
}

export type ModelValueOutcome =
  | { readonly ok: true; readonly project: WorkbenchProject; readonly touched: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly relatedIds: readonly string[] };

const refuse = (message: string, relatedIds: readonly string[]): ModelValueOutcome => ({ ok: false, message, relatedIds });

/**
 * Puts the edited model parameters into the timeline. A plain number sets the value and unbinds the field (a sketch dimension is
 * driven to the number and its geometry follows); an expression binds the field to it. Nothing is evaluated against the other
 * expressions here: the caller runs the expression engine over the result, which sets every bound number and refuses what does not
 * evaluate.
 */
export function applyModelValueEdits(project: WorkbenchProject, edits: readonly ModelValueEdit[]): ModelValueOutcome {
  const history = designOf(project);
  let features: readonly DesignFeature[] = history.features;
  const touched = new Set<string>();
  for (const edit of edits) {
    const feature = features.find((candidate) => candidate.id === edit.ownerId);
    if (feature === undefined) return refuse(`The step ${edit.ownerId} is not in the timeline, so its value cannot be changed.`, [edit.ownerId]);
    const typed = edit.text.trim();
    if (typed === "") return refuse(`${feature.name}: type a value or an expression.`, [edit.ownerId]);
    const plain = plainNumber(typed);
    if (plain === undefined) {
      const parsed = parseExpression(typed);
      if (!parsed.ok) return refuse(`${feature.name}: ${parsed.error.message} (character ${parsed.error.position + 1})`, [edit.ownerId]);
    }
    if (feature.kind === "sketch") {
      const constraint = feature.sketch.constraints.find((candidate) => candidate.id === edit.fieldId && isDrivingDimension(candidate));
      if (constraint === undefined) return refuse(`${feature.name} has no driving dimension ${edit.fieldId}.`, [edit.ownerId]);
      const label = `${feature.name} ${constraint.name ?? "dimension"}`;
      let next: WorkbenchSketchConstraint;
      let sketch = feature.sketch;
      if (plain === undefined) {
        next = { ...constraint, expression: typed };
        sketch = { ...sketch, constraints: sketch.constraints.map((candidate) => candidate.id === constraint.id ? next : candidate) };
      } else {
        const checked = checkSketchDimensionQuantity(dimensionNameOf(constraint), { value: plain, ...dimensionOfKind(constraint.kind === "angle" ? "angle" : "length") });
        if (!checked.ok) return refuse(`${label}: ${checked.message}`, [edit.ownerId]);
        const { expression: _unbound, ...rest } = constraint;
        void _unbound;
        next = constraint.kind === "angle" ? { ...rest, valueDeg: plain } : { ...rest, valueMm: plain };
        sketch = { ...sketch, constraints: sketch.constraints.map((candidate) => candidate.id === constraint.id ? next : candidate) };
        // Relaxed dimensions take the number but are not enforced; the others move their geometry and what hangs on it.
        if (next.suppressed !== true) {
          const redriven = redriveDimension(sketch, next);
          if (!redriven.ok) return refuse(`${label}: the sketch could not follow this value (${redriven.applied.diagnostics[0]?.message ?? "the relations cannot all hold"}).`, [edit.ownerId]);
          sketch = redriven.sketch;
        }
      }
      const updated: DesignSketchFeature = { ...feature, sketch };
      features = features.map((candidate) => candidate.id === feature.id ? updated : candidate);
    } else {
      const field = findBindableField(feature, edit.fieldId);
      if (field === undefined) return refuse(`${feature.name} has no number called "${edit.fieldId}" that can be changed here.`, [edit.ownerId]);
      let next: DesignSolidFeature;
      if (plain === undefined) {
        next = { ...feature, expressions: { ...(feature.expressions ?? {}), [field.id]: typed } };
      } else {
        const problem = boundValueProblem(field, plain);
        if (problem !== undefined) return refuse(`${feature.name}: ${problem}`, [edit.ownerId]);
        const { expressions, ...unbound } = feature;
        const remaining = Object.fromEntries(Object.entries(expressions ?? {}).filter(([key]) => key !== field.id));
        next = field.write(Object.keys(remaining).length === 0 ? unbound as DesignSolidFeature : { ...unbound, expressions: remaining } as DesignSolidFeature, plain);
      }
      if (!validSolidFeaturePayload(next)) return refuse(`${feature.name}: that value is outside what this step supports.`, [edit.ownerId]);
      features = features.map((candidate) => candidate.id === feature.id ? next : candidate);
    }
    touched.add(edit.ownerId);
  }
  return { ok: true, project: { ...project, design: { ...history, features } }, touched: [...touched] };
}

/** The live value of one typed model parameter, for the cell while it is being edited: what it comes to, or why not. */
export function previewModelValue(project: WorkbenchProject, edit: ModelValueEdit): { readonly ok: true; readonly valueText: string } | { readonly ok: false; readonly message: string } {
  const applied = applyModelValueEdits(project, [edit]);
  if (!applied.ok) return { ok: false, message: applied.message };
  const report = evaluateDesignExpressions(designOf(applied.project));
  const plain = plainNumber(edit.text);
  const row = modelValueRowsOf(applied.project).find((candidate) => candidate.ownerId === edit.ownerId && candidate.fieldId === edit.fieldId);
  if (plain !== undefined) return { ok: true, valueText: `${trim(plain)}${row?.unit === "mm" ? " mm" : row?.unit === "deg" ? "°" : ""}` };
  const binding = report.bindings.find((candidate) => candidate.ownerId === edit.ownerId && candidate.fieldId === edit.fieldId);
  if (binding === undefined) return { ok: false, message: "This expression cannot be evaluated." };
  if (!binding.ok || binding.value === undefined) return { ok: false, message: `${binding.message ?? "This expression cannot be evaluated."}${binding.position === undefined ? "" : ` (character ${binding.position + 1})`}` };
  return { ok: true, valueText: `${trim(binding.value)}${binding.dimension === "length" ? " mm" : binding.dimension === "angle" ? "°" : ""}` };
}
