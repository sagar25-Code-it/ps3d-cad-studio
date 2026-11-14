import type { DesignParameter, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import {
  designOf,
  evaluateDesignExpressions,
  findParameterCycle,
  MAX_DESIGN_PARAMETERS,
  modelValueRowsOf,
  previewModelValue,
  type ModelValueEdit,
  type ModelValueRow,
  parameterNameProblem,
  parseExpression,
  renameParameterReferences
} from "../../../packages/workbench-core/src/index.js";

/**
 * The Change Parameters table as the dialog edits it. Rows are plain data so the live checks and the operation they turn into are
 * testable without React: `analyseParameterRows` says what is wrong with each row right now, and `parameterOperationOf` builds the
 * `set-design-parameters` operation (with the renames the user made) once nothing blocks.
 */

export interface ParameterRow {
  /** Stable for the life of the dialog, so a row keeps its identity while its name is being typed. */
  readonly key: string;
  /** The name the row had when the dialog opened; absent for a row added in the dialog. A different `name` is a rename. */
  readonly originalName?: string;
  readonly name: string;
  readonly expression: string;
  readonly unit: DesignParameter["unit"];
  readonly comment: string;
}

export interface ParameterRowReport {
  readonly nameProblem?: string;
  readonly expressionProblem?: string;
  /** What the expression gives right now, in the row's unit: "8 mm". */
  readonly valueText?: string;
  /** The steps, sketch dimensions and other parameters that use this parameter, by label. */
  readonly usedBy: readonly string[];
}

export interface ParameterTableReport {
  readonly rows: Readonly<Record<string, ParameterRowReport>>;
  /** A problem with the table as a whole (a circular reference, a parameter still in use), or undefined. */
  readonly tableProblem?: string;
  /** True when nothing blocks Apply. */
  readonly ready: boolean;
}

export function parameterRowsOf(project: WorkbenchProject): readonly ParameterRow[] {
  return (designOf(project).parameters ?? []).map((parameter, index) => ({ key: `row-${index}`, originalName: parameter.name, ...parameter }));
}

/** The labels of every expression that refers to each parameter name, from the project as it is now. */
function usersByName(project: WorkbenchProject): ReadonlyMap<string, readonly string[]> {
  const users = new Map<string, string[]>();
  for (const binding of evaluateDesignExpressions(designOf(project), project.sketch).bindings) {
    const parsed = parseExpression(binding.expression);
    if (!parsed.ok) continue;
    for (const name of new Set(parsed.references.filter((reference) => reference.owner === undefined).map((reference) => reference.name))) {
      users.set(name, [...(users.get(name) ?? []), binding.label]);
    }
  }
  return users;
}

const trim = (value: number): string => String(Number(value.toFixed(6)));

export function analyseParameterRows(project: WorkbenchProject, rows: readonly ParameterRow[]): ParameterTableReport {
  const users = usersByName(project);
  const report: Record<string, { nameProblem?: string; expressionProblem?: string; valueText?: string; usedBy: readonly string[] }> = {};
  const seen = new Map<string, string>();
  const renames = new Map<string, string>();

  for (const row of rows) {
    const entry: { nameProblem?: string; expressionProblem?: string; valueText?: string; usedBy: readonly string[] } = { usedBy: row.originalName === undefined ? [] : users.get(row.originalName) ?? [] };
    report[row.key] = entry;
    const nameProblem = parameterNameProblem(row.name);
    if (nameProblem !== undefined) entry.nameProblem = nameProblem;
    else if (seen.has(row.name)) { entry.nameProblem = `"${row.name}" is used twice.`; report[seen.get(row.name)!]!.nameProblem = `"${row.name}" is used twice.`; }
    else seen.set(row.name, row.key);
    if (row.originalName !== undefined && row.originalName !== row.name && nameProblem === undefined) renames.set(row.originalName, row.name);
    if (row.comment.length > 200) entry.expressionProblem = "The comment is longer than 200 characters.";
    if (row.expression.trim() === "") entry.expressionProblem = "Type a value or an expression.";
    else {
      const parsed = parseExpression(row.expression);
      if (!parsed.ok) entry.expressionProblem = `${parsed.error.message} (character ${parsed.error.position + 1})`;
    }
  }

  // Evaluate the rows the way the operation will: renames applied to every expression first.
  const usable: DesignParameter[] = rows
    .filter((row) => report[row.key]!.nameProblem === undefined && report[row.key]!.expressionProblem === undefined)
    .map((row) => ({ name: row.name, expression: renames.size === 0 ? row.expression : renameParameterReferences(row.expression, renames), unit: row.unit, comment: row.comment }));
  const history = { ...designOf(project), parameters: usable };
  const evaluated = evaluateDesignExpressions(history);
  for (const row of rows) {
    const entry = report[row.key]!;
    if (entry.nameProblem !== undefined || entry.expressionProblem !== undefined) continue;
    const result = evaluated.bindings.find((binding) => binding.source === "parameter" && binding.ownerId === row.name);
    if (result === undefined) continue;
    if (result.ok && result.value !== undefined) entry.valueText = `${trim(result.value)}${row.unit === "mm" ? " mm" : row.unit === "deg" ? "°" : ""}`;
    else entry.expressionProblem = `${result.message ?? "This expression cannot be evaluated."}${result.position === undefined ? "" : ` (character ${result.position + 1})`}`;
  }

  let tableProblem: string | undefined;
  if (rows.length > MAX_DESIGN_PARAMETERS) tableProblem = `A project holds at most ${MAX_DESIGN_PARAMETERS} parameters.`;
  const cycle = findParameterCycle(history);
  if (tableProblem === undefined && cycle !== undefined) tableProblem = `Circular reference: ${cycle.join(" → ")}. A value cannot depend on itself.`;
  if (tableProblem === undefined) {
    const kept = new Set(rows.flatMap((row) => row.originalName === undefined ? [] : [row.originalName]));
    const removed = (designOf(project).parameters ?? []).map((parameter) => parameter.name).filter((name) => !kept.has(name));
    const blocked = removed.find((name) => (users.get(name) ?? []).length > 0);
    if (blocked !== undefined) tableProblem = `"${blocked}" is still used by ${users.get(blocked)!.slice(0, 3).join(", ")}. Change those first, or keep the parameter.`;
  }

  const rowsOk = rows.every((row) => report[row.key]!.nameProblem === undefined && report[row.key]!.expressionProblem === undefined);
  return { rows: report, ...(tableProblem === undefined ? {} : { tableProblem }), ready: rowsOk && tableProblem === undefined };
}

export function parameterOperationOf(rows: readonly ParameterRow[]): { readonly parameters: readonly DesignParameter[]; readonly renames: readonly { readonly from: string; readonly to: string }[] } {
  return {
    parameters: rows.map((row) => ({ name: row.name, expression: row.expression.trim(), unit: row.unit, comment: row.comment })),
    renames: rows.flatMap((row) => row.originalName !== undefined && row.originalName !== row.name ? [{ from: row.originalName, to: row.name }] : [])
  };
}

/** A name for a new row that no row uses yet: param1, param2, ... */
export function nextParameterName(rows: readonly ParameterRow[]): string {
  const taken = new Set(rows.map((row) => row.name));
  for (let index = 1; index <= MAX_DESIGN_PARAMETERS + 1; index += 1) if (!taken.has(`param${index}`)) return `param${index}`;
  return "param";
}

/** The values of every bound step and sketch dimension for the read-only list at the bottom of the dialog. */
export function boundValuesOf(project: WorkbenchProject): readonly { readonly label: string; readonly expression: string; readonly valueText: string; readonly problem?: string }[] {
  return evaluateDesignExpressions(designOf(project), project.sketch).bindings
    .filter((binding) => binding.source !== "parameter")
    .map((binding) => ({
      label: binding.label,
      expression: binding.expression,
      valueText: binding.ok && binding.value !== undefined ? `${trim(binding.value)}${binding.dimension === "length" ? " mm" : binding.dimension === "angle" ? "°" : ""}` : "",
      ...(binding.ok ? {} : { problem: binding.message ?? "This expression cannot be used." })
    }));
}

// ---------------------------------------------------------------------------------------------
// HS-08: the model parameters section (every step's numbers and every timeline sketch's dimensions)
// ---------------------------------------------------------------------------------------------

/** One model parameter as the dialog edits it: the row of the project plus the text typed in its expression cell. */
export interface ModelParameterRow extends ModelValueRow {
  readonly key: string;
  /** What the cell holds now; the row is changed when this differs from `row.text`. */
  readonly typed: string;
}

export function modelParameterRowsOf(project: WorkbenchProject): readonly ModelParameterRow[] {
  return modelValueRowsOf(project).map((row) => ({ ...row, key: `${row.ownerId}|${row.fieldId}`, typed: row.text }));
}

/** The groups of the section, in timeline order: one per step or sketch, each with its rows. */
export function groupModelParameterRows(rows: readonly ModelParameterRow[]): readonly { readonly ownerId: string; readonly group: string; readonly groupKind: "step" | "sketch"; readonly rows: readonly ModelParameterRow[] }[] {
  const groups: { ownerId: string; group: string; groupKind: "step" | "sketch"; rows: ModelParameterRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.ownerId === row.ownerId) last.rows.push(row);
    else groups.push({ ownerId: row.ownerId, group: row.group, groupKind: row.groupKind, rows: [row] });
  }
  return groups;
}

/** The edits Apply sends: only the rows whose text was changed. */
export function modelValueEditsOf(rows: readonly ModelParameterRow[]): readonly ModelValueEdit[] {
  return rows.filter((row) => row.typed.trim() !== row.text.trim()).map((row) => ({ ownerId: row.ownerId, fieldId: row.fieldId, text: row.typed.trim() }));
}

export interface ModelRowReport {
  /** What the typed text gives, in the row's unit ("15 mm"); absent for a row that is not changed. */
  readonly valueText?: string;
  readonly problem?: string;
}

/**
 * What each changed model row comes to, or why it is refused, checked against the project as it is (with no other pending edit).
 * Unchanged rows have no report: their value is the one the project holds.
 */
export function analyseModelRows(project: WorkbenchProject, rows: readonly ModelParameterRow[]): Readonly<Record<string, ModelRowReport>> {
  const reports: Record<string, ModelRowReport> = {};
  for (const row of rows) {
    if (row.typed.trim() === row.text.trim()) continue;
    const preview = previewModelValue(project, { ownerId: row.ownerId, fieldId: row.fieldId, text: row.typed });
    reports[row.key] = preview.ok ? { valueText: preview.valueText } : { problem: preview.message };
  }
  return reports;
}
