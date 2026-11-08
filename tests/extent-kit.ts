import type { DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, modifiesBody } from "../packages/workbench-core/src/index.js";
import { replayAllBodies, replayBody, type RebuildResult } from "../apps/studio-web/src/design-regeneration.js";
import { assert } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
export function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-extent-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

export function volumeOf(body: GeneralSolidBody): number {
  let total = 0;
  for (let index = 0; index < body.indices.length; index += 3) {
    const a = body.indices[index]! * 3; const b = body.indices[index + 1]! * 3; const c = body.indices[index + 2]! * 3;
    const p = body.positionsMm;
    total += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return Math.abs(total / 6);
}

export function boundsOf(body: GeneralSolidBody): { readonly min: readonly number[]; readonly max: readonly number[] } {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < body.positionsMm.length; index += 1) {
    const axis = index % 3;
    min[axis] = Math.min(min[axis]!, body.positionsMm[index]!); max[axis] = Math.max(max[axis]!, body.positionsMm[index]!);
  }
  return { min, max };
}

/** Closed and manifold: every edge is shared by exactly two triangles, walked in opposite directions (vertices closer than 0.5 micrometre are one). */
export function isClosedManifold(body: GeneralSolidBody): boolean {
  const cell = 1e-3;
  const buckets = new Map<string, { id: number; x: number; y: number; z: number }[]>();
  let next = 0;
  const id = (index: number): number => {
    const x = body.positionsMm[index * 3]!; const y = body.positionsMm[index * 3 + 1]!; const z = body.positionsMm[index * 3 + 2]!;
    const cx = Math.floor(x / cell); const cy = Math.floor(y / cell); const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (const entry of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) if (Math.hypot(entry.x - x, entry.y - y, entry.z - z) < 5e-4) return entry.id;
    }
    const entry = { id: next, x, y, z };
    next += 1;
    const key = `${cx},${cy},${cz}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]); else bucket.push(entry);
    return entry.id;
  };
  const directed = new Map<string, number>();
  for (let triangle = 0; triangle < body.indices.length; triangle += 3) {
    const ids = [id(body.indices[triangle]!), id(body.indices[triangle + 1]!), id(body.indices[triangle + 2]!)];
    // A triangle with two corners on the same point has no area; it neither opens nor closes the surface.
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
    for (let k = 0; k < 3; k += 1) {
      const from = ids[k]!; const to = ids[(k + 1) % 3]!;
      directed.set(`${from}>${to}`, (directed.get(`${from}>${to}`) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    const [from, to] = key.split(">");
    if (count !== 1 || directed.get(`${to}>${from}`) !== 1) return false;
  }
  return directed.size > 0;
}

export const PLATE = "general-body:plate";
export const BLOCK = "general-body:block";

/** Adds a sketch holding `entity` on `plane` (optionally offset) and finishes it as `featureId`. */
export function withSketch(project: WorkbenchProject, featureId: string, entity: SketchEntity, plane: "datum:xy" | "datum:xz" | "datum:yz" = "datum:xy", offsetMm?: number): WorkbenchProject {
  let next = run(project, { kind: "new-design-sketch", plane, ...(offsetMm === undefined ? {} : { offsetMm }) });
  next = run(next, { kind: "add-sketch-entity", entity });
  return run(next, { kind: "commit-design-sketch", featureId, name: featureId });
}

/** Appends a solid step to the timeline: a new body is built and added, a join or cut is replayed into its body. */
export async function withStep(project: WorkbenchProject, feature: DesignSolidFeature): Promise<WorkbenchProject> {
  const staged: WorkbenchProject = { ...project, design: { ...designOf(project), features: [...designOf(project).features, feature], rollbackIndex: designOf(project).features.length + 1 } };
  if (modifiesBody(feature)) return apply(staged, await replayAllBodies(staged));
  const built = (await replayBody(staged, feature.bodyId)).find((result) => result.body !== undefined);
  assert(built?.body !== undefined, `${feature.id} builds: ${(await replayBody(staged, feature.bodyId)).map((result) => result.message ?? "").join("; ")}`);
  return run(project, { kind: "add-design-solid", feature, body: built.body });
}

export function apply(project: WorkbenchProject, results: readonly RebuildResult[]): WorkbenchProject {
  return run(project, { kind: "regenerate-design", results });
}

export const step = (id: string, sketchFeatureId: string, bodyId: string, extra: Partial<DesignSolidFeature> & Pick<DesignSolidFeature, "kind" | "valueMm">): DesignSolidFeature =>
  ({ id, name: id, suppressed: false, sketchFeatureId, profileIds: [], bodyId, ...extra }) as DesignSolidFeature;

export const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => {
  const body = project.part.generalBodies?.find((candidate) => candidate.id === id);
  assert(body !== undefined, `body ${id} exists`);
  return body;
};

/** A 100 x 100 plate 10 mm thick at z 0..10 and a 40 x 40 block at z 40..50 above it. */
export async function plateAndBlock(): Promise<WorkbenchProject> {
  let project = run(createWorkbenchProject("project:test-extent"), { kind: "commit-design-sketch", featureId: "feature:sketch-plate", name: "Plate sketch" });
  project = await withStep(project, step("feature:plate", "feature:sketch-plate", PLATE, { kind: "extrude", valueMm: 10 }));
  project = withSketch(project, "feature:sketch-block", { id: "entity:block", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 40, rotationDeg: 0, construction: false }, "datum:xy", 40);
  return withStep(project, step("feature:block", "feature:sketch-block", BLOCK, { kind: "extrude", valueMm: 10 }));
}

