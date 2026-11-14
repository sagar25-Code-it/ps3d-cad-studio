import { applyWorkbenchOperation, designOf, type DesignSolidFeature, type GeneralSolidBody, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { committedSketch, rect } from "./pipeline-kit.js";
import { assert } from "./test-kit.js";

/** Shared fixtures for the history (timeline and browser) tests. */

export const PLATE_BODY = "general-body:plate";

export const tetra = (id: string, visible = true): GeneralSolidBody => ({
  id, name: id, visible, color: "#b9c2c8",
  positionsMm: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
});

export const stepOf = (id: string, name: string, kind: DesignSolidFeature["kind"], extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id, name, kind, suppressed: false, sketchFeatureId: "feature:s1", profileIds: [], valueMm: 6, bodyId: PLATE_BODY, ...extra });

/** Job 1 as the timeline holds it: Sketch, then a plate extrude, a hole cut and a boss join (three steps of one body). */
export function plateHoleFillet(): WorkbenchProject {
  const { project } = committedSketch("datum:xy", [rect("plate", 0, 0, 80, 50)]);
  const history = designOf(project);
  const steps = [stepOf("feature:extrude-1", "Extrude 1", "extrude"), stepOf("feature:cut-1", "Cut 1", "extrude", { operation: "cut" }), stepOf("feature:join-1", "Join 1", "extrude", { operation: "join", valueMm: 4 })];
  return { ...project, activeWorkspace: "part", part: { ...project.part, generalBodies: [tetra(PLATE_BODY)] }, design: { ...history, features: [...history.features, ...steps], rollbackIndex: history.features.length + steps.length } };
}

let serial = 0;
export function applyOp(project: WorkbenchProject, operation: Record<string, unknown> & { readonly kind: string }): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-history-${serial}`, expectedRevision: project.revision } as unknown as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

export function refusedOp(project: WorkbenchProject, operation: Record<string, unknown> & { readonly kind: string }): string {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-history-${serial}`, expectedRevision: project.revision } as unknown as WorkbenchOperation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.diagnostics[0]?.message ?? "";
}
