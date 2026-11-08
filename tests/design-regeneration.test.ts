import type { DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { extrudeStartOffsetMm, rebuildDependents, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-regen-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function extent(positions: readonly number[], axis: 0 | 1 | 2): { readonly min: number; readonly max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let index = axis; index < positions.length; index += 3) { min = Math.min(min, positions[index]!); max = Math.max(max, positions[index]!); }
  return { min, max };
}

/** Signed volume of a closed triangle mesh, in cubic millimetres. */
function volume(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3; const b = indices[index + 1]! * 3; const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return Math.abs(total / 6);
}

const feature = (extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature => ({
  id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: "general-body:one", ...extra
});

function finished(): WorkbenchProject {
  return run(createWorkbenchProject("project:test-regen"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
}

function sketchFeatureOf(project: WorkbenchProject) {
  const found = designOf(project).features[0]!;
  assert(found.kind === "sketch", "the first feature is the sketch");
  return found;
}

export const designRegenerationTests: readonly TestCase[] = [
  {
    name: "an extrude feature rebuilds from its sketch snapshot as a plate with its bore, to the requested height",
    run: async () => {
      const project = finished();
      const rebuilt = await rebuildSolidFeature(feature(), sketchFeatureOf(project));
      assert(rebuilt.ok, `the solid builds: ${rebuilt.ok ? "" : rebuilt.message}`);
      equal(rebuilt.body.id, "general-body:one", "it carries the feature's body ID");
      equal(rebuilt.body.name, "Extrude 1", "and the feature's name");
      const z = extent(rebuilt.body.positionsMm, 2);
      near(z.min, 0, 1e-6, "it starts on the sketch plane");
      near(z.max, 10, 1e-6, "and rises by the distance");
      // The centre bore is fully inside the outline; the two mounting circles cross its edge, so they are not holes.
      const flat = 60 * 40 * 10 - Math.PI * 5 ** 2 * 10;
      near(volume(rebuilt.body.positionsMm, rebuilt.body.indices), flat, flat * 0.03, "the plate minus its centre bore (within tessellation error)");
    }
  },
  {
    name: "symmetric and flipped extrusions start on the right side of the sketch plane, on every datum plane",
    run: async () => {
      const project = finished();
      const sketch = sketchFeatureOf(project);
      const symmetric = await rebuildSolidFeature(feature({ direction: "symmetric" }), sketch);
      assert(symmetric.ok, "symmetric builds");
      near(extent(symmetric.body.positionsMm, 2).min, -5, 1e-6, "symmetric starts half the height below the plane");
      near(extent(symmetric.body.positionsMm, 2).max, 5, 1e-6, "and ends half above");
      const flipped = await rebuildSolidFeature(feature({ direction: "flipped" }), sketch);
      assert(flipped.ok, "flipped builds");
      near(extent(flipped.body.positionsMm, 2).min, -10, 1e-6, "flipped goes the other way");
      near(extent(flipped.body.positionsMm, 2).max, 0, 1e-6, "ending on the plane");
      near(extentStart({ kind: "extrude", valueMm: 8, direction: "symmetric" }), -4, 1e-12, "the offset helper agrees");
      // On the XZ plane the extrusion runs along -Y.
      const onXz = run(createWorkbenchProject("project:test-regen-xz"), { kind: "set-sketch-plane", plane: "datum:xz" });
      const xzProject = run(onXz, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const xz = await rebuildSolidFeature(feature(), sketchFeatureOf(xzProject));
      assert(xz.ok, "an XZ extrude builds");
      near(extent(xz.body.positionsMm, 1).min, -10, 1e-6, "it extends along -Y");
      near(extent(xz.body.positionsMm, 1).max, 0, 1e-6, "from the plane");
    }
  },
  {
    name: "editing a sketch and rebuilding its dependents changes the solid, and a feature whose profile vanished is reported, not guessed",
    run: async () => {
      let project = finished();
      const first = await rebuildSolidFeature(feature(), sketchFeatureOf(project));
      assert(first.ok, "the solid builds");
      project = run(project, { kind: "add-design-solid", feature: feature(), body: first.body });
      const before = volume(first.body.positionsMm, first.body.indices);
      // Widen the plate in the working sketch and finish the sketch again: its snapshot is updated in place.
      // The seeded plate outline is Fixed, and fixed geometry cannot be dimensioned (Unfix it first): relax that one relation.
      project = run(project, { kind: "set-sketch-constraints-suppressed", constraintIds: ["constraint:outline-fixed"], suppressed: true });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "width", valueMm: 90 });
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-9", name: "Sketch 9" });
      equal(designOf(project).features.length, 2, "the sketch was updated, not duplicated");
      const results = await rebuildDependents(project, "feature:sketch-1");
      equal(results.length, 1, "one dependent solid");
      assert(results[0]!.body !== undefined, "it rebuilt");
      project = run(project, { kind: "regenerate-design", results });
      const after = volume(project.part.generalBodies![0]!.positionsMm, project.part.generalBodies![0]!.indices);
      assert(after > before * 1.3, `the plate got bigger: ${before.toFixed(0)} -> ${after.toFixed(0)} mm3`);

      // Delete the outline from the working sketch: the extrude's recorded profile is gone, so the feature is flagged.
      const picked = run(project, { kind: "add-design-solid", feature: feature({ id: "feature:extrude-2", name: "Extrude 2", bodyId: "general-body:two", profileIds: ["profile:centered-bore-profile"] }), body: { ...first.body, id: "general-body:two", name: "Extrude 2" } });
      const without = run(picked, { kind: "delete-sketch-entity", entityId: "entity:centered-bore-profile" });
      const recommitted = run(without, { kind: "commit-design-sketch", featureId: "feature:sketch-10", name: "Sketch 10" });
      const flagged = await rebuildDependents(recommitted, "feature:sketch-1");
      const second = flagged.find((result) => result.featureId === "feature:extrude-2");
      assert(second?.message !== undefined && /no longer exists/.test(second.message), "the lost profile is reported with a reason");
    }
  },
  {
    name: "a revolve feature builds from a profile on one side of the axis",
    run: async () => {
      let project = createWorkbenchProject("project:test-regen-revolve");
      project = { ...project, sketch: { ...project.sketch, entities: [{ id: "entity:r", kind: "rectangle", center: [30, 10], widthMm: 20, heightMm: 20, rotationDeg: 0, construction: false }], constraints: [] } };
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const rebuilt = await rebuildSolidFeature(feature({ kind: "revolve", valueMm: 360, bodyId: "general-body:rev", name: "Revolve 1" }), sketchFeatureOf(project));
      assert(rebuilt.ok, `the revolve builds: ${rebuilt.ok ? "" : rebuilt.message}`);
      assert(rebuilt.body.indices.length > 100, "a swept solid has many triangles");
    }
  }
];

function extentStart(feature: Pick<DesignSolidFeature, "kind" | "valueMm" | "direction">): number {
  return extrudeStartOffsetMm(feature);
}
