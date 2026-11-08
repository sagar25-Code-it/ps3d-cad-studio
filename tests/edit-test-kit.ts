import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  validateWorkbenchProject,
  type SketchEntity,
  type Vec2,
  type WorkbenchProject,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { circumcircle, type SketchEditContext, type SketchEditResult } from "../packages/workbench-sketch/src/edit-tools.js";

/** Shared helpers for the sketch edit-tool regression tests: build a sketch, plan an edit, commit it through the real operation. */

let serial = 0;
export const newId = (prefix: "entity" | "constraint"): string => `${prefix}:et-${(serial += 1)}`;

export function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject(`project:et-${(serial += 1)}`);
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

export function ctx(project: WorkbenchProject): SketchEditContext {
  return { sketch: project.sketch, newId };
}

export const line = (id: string, start: readonly [number, number], end: readonly [number, number], extra: Partial<SketchEntity> = {}): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false, ...extra }) as SketchEntity;
export const circle = (id: string, center: readonly [number, number], radiusMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false });
export const arc = (id: string, start: readonly [number, number], mid: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "arc", start, mid, end, construction: false });
export const rect = (id: string, center: readonly [number, number], widthMm: number, heightMm: number, rotationDeg = 0): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center, widthMm, heightMm, rotationDeg, construction: false });
export const spline = (id: string, fitPoints: readonly (readonly [number, number])[]): SketchEntity => ({ id: `entity:${id}`, kind: "spline", fitPoints, construction: false });
export const ellipse = (id: string, center: readonly [number, number], majorRadiusMm: number, minorRadiusMm: number, rotationDeg = 0): SketchEntity => ({ id: `entity:${id}`, kind: "ellipse", center, majorRadiusMm, minorRadiusMm, rotationDeg, construction: false });
export const ids = (...names: string[]): string[] => names.map((name) => `entity:${name}`);
export const con = (id: string, kind: WorkbenchSketchConstraint["kind"], entities: readonly string[], extra: Partial<WorkbenchSketchConstraint> = {}): WorkbenchSketchConstraint =>
  ({ id: `constraint:${id}`, kind, entityIds: entities.map((entity) => `entity:${entity}`), ...extra }) as WorkbenchSketchConstraint;

/** Commits a planned edit through the real `apply-sketch-edit` operation exactly as the UI does, and revalidates the saved project. */
export function commit(project: WorkbenchProject, result: SketchEditResult): { readonly ok: true; readonly project: WorkbenchProject; readonly summary: string } | { readonly ok: false; readonly message: string; readonly code: string } {
  if (!result.ok) return { ok: false, message: result.diagnostics[0]?.message ?? "", code: result.diagnostics[0]?.code ?? "" };
  serial += 1;
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:et-${serial}`, expectedRevision: project.revision, ...result.value });
  if (!applied.ok) return { ok: false, message: applied.diagnostics[0]?.message ?? "", code: applied.diagnostics[0]?.code ?? "" };
  const revalidated = validateWorkbenchProject(JSON.parse(JSON.stringify(applied.value.project)) as unknown);
  if (!revalidated.ok) return { ok: false, message: `revalidation: ${revalidated.diagnostics[0]?.message ?? ""}`, code: "REVALIDATE" };
  return { ok: true, project: applied.value.project, summary: applied.value.summary };
}

/** Plans and commits; throws with the reason when either step refuses. */
export function applyOk(project: WorkbenchProject, result: SketchEditResult): WorkbenchProject {
  const committed = commit(project, result);
  if (!committed.ok) throw new Error(`edit failed [${committed.code}]: ${committed.message}`);
  return committed.project;
}

/** Problems with the sketch after an edit: dangling or duplicate IDs, non-finite numbers, or a solve that would still move geometry. */
export function problems(project: WorkbenchProject): string[] {
  const found: string[] = [];
  const entityIds = project.sketch.entities.map((entity) => entity.id);
  if (new Set(entityIds).size !== entityIds.length) found.push("duplicate entity ids");
  const known = new Set(entityIds);
  for (const constraint of project.sketch.constraints) if (constraint.entityIds.some((id) => !known.has(id))) found.push(`dangling relation ${constraint.id}`);
  const constraintIds = project.sketch.constraints.map((constraint) => constraint.id);
  if (new Set(constraintIds).size !== constraintIds.length) found.push("duplicate relation ids");
  if (/NaN|null/u.test(JSON.stringify(project.sketch))) found.push("non-finite number in the sketch");
  const solved = solveLiveSketch(project.sketch);
  if (!solved.ok) found.push(`solve fails: ${solved.message}`);
  else if (solved.movedIds.length > 0) found.push(`solve would move ${solved.movedIds.join(", ")}`);
  return found;
}

export function entityById(project: WorkbenchProject, id: string): SketchEntity {
  const found = project.sketch.entities.find((entity) => entity.id === id);
  if (found === undefined) throw new Error(`no entity ${id}`);
  return found;
}

export function ofKind<K extends SketchEntity["kind"]>(project: WorkbenchProject, kind: K): Extract<SketchEntity, { kind: K }>[] {
  return project.sketch.entities.filter((entity): entity is Extract<SketchEntity, { kind: K }> => entity.kind === kind);
}

export function relationsOf(project: WorkbenchProject, kind: WorkbenchSketchConstraint["kind"]): WorkbenchSketchConstraint[] {
  return project.sketch.constraints.filter((constraint) => constraint.kind === kind);
}

export function radiusOfArc(arcEntity: Extract<SketchEntity, { kind: "arc" }>): number {
  return circumcircle(arcEntity.start, arcEntity.mid, arcEntity.end)!.radiusMm;
}

export function closeTo(a: Vec2, b: Vec2, tolerance = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}
