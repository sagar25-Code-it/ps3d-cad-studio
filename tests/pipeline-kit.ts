import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchDatumPlane, SketchEntity, WorkbenchOperation, WorkbenchProject, WorkbenchResult, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { rebuildSolidFeature, type SolidRebuild } from "../apps/studio-web/src/design-regeneration.js";
import { assert } from "./test-kit.js";

let serial = 0;
export type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

export function pipelineApply(project: WorkbenchProject, operation: Op): WorkbenchResult<{ readonly project: WorkbenchProject; readonly summary: string }> {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-pipeline-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

export function pipelineRun(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = pipelineApply(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

export function message(result: WorkbenchResult<unknown>): string {
  return result.ok ? "" : result.diagnostics.map((diagnostic) => diagnostic.message).join(" | ");
}

export const line = (id: string, from: readonly [number, number], to: readonly [number, number], construction = false): SketchEntity => ({ id: `entity:${id}`, kind: "line", start: from, end: to, construction });
export const rect = (id: string, cx: number, cy: number, w: number, h: number): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center: [cx, cy], widthMm: w, heightMm: h, rotationDeg: 0, construction: false });
export const circ = (id: string, cx: number, cy: number, r: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center: [cx, cy], radiusMm: r, construction: false });
export const fresh = (): WorkbenchProject => createWorkbenchProject("project:test-pipeline");

export interface PlaneOptions {
  readonly offsetMm?: number;
  readonly tilt?: { readonly axis: "x" | "y" | "z"; readonly angleDeg: number };
}

/** A project whose timeline holds one finished sketch (feature:s1 unless named) with the given curves. */
export function committedSketch(plane: SketchDatumPlane, entities: readonly SketchEntity[], options: PlaneOptions & { readonly project?: WorkbenchProject; readonly featureId?: string; readonly constraints?: readonly WorkbenchSketchConstraint[] } = {}): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  let project = options.project ?? fresh();
  const featureId = options.featureId ?? "feature:s1";
  project = pipelineRun(project, { kind: "new-design-sketch", plane, ...(options.offsetMm === undefined ? {} : { offsetMm: options.offsetMm }), ...(options.tilt === undefined ? {} : { tilt: options.tilt }) });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: options.constraints ?? [], label: "Draw" });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId, name: `Sketch ${featureId.slice(-2)}` });
  const sketch = designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === featureId && feature.kind === "sketch");
  assert(sketch !== undefined, "the sketch is in the timeline");
  return { project, sketch };
}

export function solidFeature(kind: DesignSolidFeature["kind"], sketch: DesignSketchFeature, extra: Partial<DesignSolidFeature> = {}, profileIndex = 0): DesignSolidFeature {
  const profiles = detectSketchProfiles(sketch.sketch);
  return { id: `feature:${kind}-1`, name: `${kind} 1`, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: extra.profileIds ?? [profiles[profileIndex]?.id ?? "profile:none"], valueMm: 10, bodyId: `general-body:${kind}-1`, ...extra };
}

export async function buildSolid(sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], extra: Partial<DesignSolidFeature> = {}, profileIndex = 0): Promise<SolidRebuild> {
  return rebuildSolidFeature(solidFeature(kind, sketch, extra, profileIndex), sketch);
}

export function meshStats(body: Pick<GeneralSolidBody, "positionsMm" | "indices">): { readonly volume: number; readonly lo: readonly [number, number, number]; readonly hi: readonly [number, number, number]; readonly triangles: number } {
  const p = body.positionsMm;
  let volume = 0;
  for (let index = 0; index < body.indices.length; index += 3) {
    const a = body.indices[index]! * 3; const b = body.indices[index + 1]! * 3; const c = body.indices[index + 2]! * 3;
    volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < p.length; index += 3) for (let axis = 0; axis < 3; axis += 1) { lo[axis] = Math.min(lo[axis]!, p[index + axis]!); hi[axis] = Math.max(hi[axis]!, p[index + axis]!); }
  return { volume, lo, hi, triangles: body.indices.length / 3 };
}

export function solidOf(result: SolidRebuild): GeneralSolidBody {
  assert(result.ok, `the solid builds: ${result.ok ? "" : result.message}`);
  return result.body;
}
