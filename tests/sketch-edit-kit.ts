import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  type SketchEntity,
  type WorkbenchProject,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import type { SketchEditContext, SketchEditPlan, SketchEditResult } from "../packages/workbench-sketch/src/edit-tools.js";

/** Shared helpers for the sketch split / jog / path / clipboard / repair tests: build a sketch and apply a plan through the real operation. */
let serial = 0;
export const newId = (prefix: "entity" | "constraint"): string => `${prefix}:kit-${(serial += 1)}`;

export type Line = Extract<SketchEntity, { kind: "line" }>;
export type Arc = Extract<SketchEntity, { kind: "arc" }>;

export function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject(`project:kit-${(serial += 1)}`);
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

export function context(project: WorkbenchProject): SketchEditContext {
  return { sketch: project.sketch, newId };
}

export const line = (id: string, start: readonly [number, number], end: readonly [number, number]): Line => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });
export const circle = (id: string, center: readonly [number, number], radiusMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false });
export const arc = (id: string, start: readonly [number, number], mid: readonly [number, number], end: readonly [number, number]): Arc => ({ id: `entity:${id}`, kind: "arc", start, mid, end, construction: false });
export const ids = (...names: string[]): string[] => names.map((name) => `entity:${name}`);
export const constraint = (id: string, kind: WorkbenchSketchConstraint["kind"], entityIds: readonly string[], extra: Partial<WorkbenchSketchConstraint> = {}): WorkbenchSketchConstraint => ({ id: `constraint:${id}`, kind, entityIds: entityIds.map((entry) => `entity:${entry}`), ...extra });

export function planOf(result: SketchEditResult): SketchEditPlan {
  if (!result.ok) throw new Error(`edit planning failed: ${result.diagnostics[0]?.message}`);
  return result.value;
}

/** Applies a planned edit through the real `apply-sketch-edit` operation, exactly as the UI does. */
export function commit(project: WorkbenchProject, result: SketchEditResult | SketchEditPlan) {
  const plan = "ok" in result ? planOf(result) : result;
  serial += 1;
  return applyWorkbenchOperation(project, {
    kind: "apply-sketch-edit",
    operationId: `operation:kit-edit-${serial}`,
    expectedRevision: project.revision,
    label: plan.label.slice(0, 80),
    removeEntityIds: plan.removeEntityIds,
    updateEntities: plan.updateEntities,
    addEntities: plan.addEntities,
    addConstraints: plan.addConstraints,
    ...(plan.removeConstraintIds === undefined ? {} : { removeConstraintIds: plan.removeConstraintIds })
  });
}

/** Commits and returns the new project, failing the test with the operation's own message if it is refused. */
export function commitOk(project: WorkbenchProject, result: SketchEditResult | SketchEditPlan): WorkbenchProject {
  const applied = commit(project, result);
  if (!applied.ok) throw new Error(`operation refused: ${applied.diagnostics[0]?.message}`);
  return applied.value.project;
}

export function linesOf(project: WorkbenchProject): Line[] {
  return project.sketch.entities.filter((entity): entity is Line => entity.kind === "line");
}

export function entityOf<K extends SketchEntity["kind"]>(project: WorkbenchProject, id: string, kind: K): Extract<SketchEntity, { kind: K }> {
  const found = project.sketch.entities.find((entity) => entity.id === id);
  if (found?.kind !== kind) throw new Error(`expected ${kind} ${id}`);
  return found as Extract<SketchEntity, { kind: K }>;
}

/** True when re-solving the whole sketch changes nothing: every recorded relation already holds. */
export function relationsHold(project: WorkbenchProject): boolean {
  const solved = solveLiveSketch(project.sketch);
  return solved.ok && solved.movedIds.length === 0;
}
