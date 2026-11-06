import type { DesignSolidFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, dependentsOf, designOf, isFeatureActive, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-design-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function refused(project: WorkbenchProject, operation: Op): string {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-design-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.diagnostics[0]?.message ?? "";
}

const tetra = (id: string, visible = true): GeneralSolidBody => ({
  id, name: id, visible, color: "#b9c2c8",
  positionsMm: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
});

const extrude = (id: string, sketchFeatureId: string, bodyId: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature => ({
  id, name: `Extrude ${id}`, kind: "extrude", suppressed: false, sketchFeatureId, profileIds: [], valueMm: 10, bodyId, ...extra
});

/** A project with one finished sketch and one extrude built on it. */
function withExtrude(): WorkbenchProject {
  let project = createWorkbenchProject("project:test-design");
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  return run(project, { kind: "add-design-solid", feature: extrude("feature:extrude-1", "feature:sketch-1", "general-body:one"), body: tetra("general-body:one") });
}

export const designTimelineTests: readonly TestCase[] = [
  {
    name: "finishing a sketch adds a timeline feature, and finishing it again updates that feature instead of adding another",
    run: () => {
      let project = createWorkbenchProject("project:test-design-sketch");
      equal(designOf(project).features.length, 0, "a new project has an empty timeline");
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      equal(designOf(project).features.length, 1, "one sketch feature");
      equal(designOf(project).rollbackIndex, 1, "the marker sits after it");
      equal(designOf(project).editingSketchId, "feature:sketch-1", "the working sketch is now that feature");
      const edited = run(project, { kind: "add-sketch-entity", entity: { id: "entity:extra", kind: "circle", center: [0, 0], radiusMm: 3, construction: false } });
      const again = run(edited, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
      equal(designOf(again).features.length, 1, "still one feature");
      const first = designOf(again).features[0]!;
      assert(first.kind === "sketch" && first.sketch.entities.some((entity) => entity.id === "entity:extra"), "its snapshot picked up the new curve");
      equal(first.name, "Sketch 1", "and kept its name");
    }
  },
  {
    name: "a solid feature needs an existing sketch feature, owns one body and follows the timeline",
    run: () => {
      const project = withExtrude();
      const features = designOf(project).features;
      equal(features.map((feature) => feature.kind).join(","), "sketch,extrude", "sketch then extrude");
      equal((project.part.generalBodies ?? []).length, 1, "the solid is in the part");
      equal(refused(createWorkbenchProject("project:test-design-orphan"), { kind: "add-design-solid", feature: extrude("feature:extrude-1", "feature:missing", "general-body:one"), body: tetra("general-body:one") }).length > 0, true, "an extrude without a sketch is refused");
      refused(project, { kind: "add-design-solid", feature: extrude("feature:extrude-2", "feature:sketch-1", "general-body:other"), body: tetra("general-body:mismatch") });
      refused(project, { kind: "add-design-solid", feature: extrude("feature:extrude-1", "feature:sketch-1", "general-body:two"), body: tetra("general-body:two") });
      assert(dependentsOf(designOf(project), "feature:sketch-1").some((feature) => feature.id === "feature:extrude-1"), "the extrude depends on the sketch");
    }
  },
  {
    name: "suppressing a feature or rolling the marker back hides its solid, and restoring shows it again",
    run: () => {
      let project = withExtrude();
      const visible = (): boolean => project.part.generalBodies!.find((body) => body.id === "general-body:one")!.visible;
      equal(visible(), true, "visible at first");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:extrude-1", suppressed: true });
      equal(visible(), false, "suppressing the extrude hides the solid");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:extrude-1", suppressed: false });
      equal(visible(), true, "unsuppressing shows it");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:sketch-1", suppressed: true });
      equal(visible(), false, "suppressing the sketch it is built on hides it too");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:sketch-1", suppressed: false });
      project = run(project, { kind: "set-design-rollback", index: 1 });
      equal(visible(), false, "rolling back before the extrude hides it");
      assert(!isFeatureActive(designOf(project), "feature:extrude-1") && isFeatureActive(designOf(project), "feature:sketch-1"), "only the sketch is active");
      project = run(project, { kind: "set-design-rollback", index: 2 });
      equal(visible(), true, "rolling forward shows it");
      refused(project, { kind: "set-design-rollback", index: 3 });
    }
  },
  {
    name: "a feature added while rolled back is inserted at the marker and the marker moves past it",
    run: () => {
      let project = withExtrude();
      project = run(project, { kind: "set-design-rollback", index: 1 });
      project = run(project, { kind: "add-design-solid", feature: extrude("feature:extrude-2", "feature:sketch-1", "general-body:two"), body: tetra("general-body:two") });
      equal(designOf(project).features.map((feature) => feature.id).join(","), "feature:sketch-1,feature:extrude-2,feature:extrude-1", "inserted before the rolled-back feature");
      equal(designOf(project).rollbackIndex, 2, "the marker is after the new feature");
      const bodies = project.part.generalBodies!;
      equal(bodies.find((body) => body.id === "general-body:two")!.visible, true, "the new solid is active");
      equal(bodies.find((body) => body.id === "general-body:one")!.visible, false, "the later one stays rolled back");
    }
  },
  {
    name: "deleting a sketch removes the features and solids built on it and keeps the marker consistent",
    run: () => {
      let project = withExtrude();
      project = run(project, { kind: "add-design-solid", feature: extrude("feature:extrude-2", "feature:sketch-1", "general-body:two"), body: tetra("general-body:two") });
      const removed = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-1" });
      equal(designOf(removed).features.length, 0, "the sketch and both extrudes are gone");
      equal((removed.part.generalBodies ?? []).length, 0, "and so are their solids");
      equal(designOf(removed).rollbackIndex, 0, "the marker is at the start");
      equal(designOf(removed).editingSketchId, null, "nothing is being edited");
      const one = run(project, { kind: "delete-design-feature", featureId: "feature:extrude-2" });
      equal(designOf(one).features.length, 2, "deleting just an extrude keeps the sketch and the other extrude");
      equal(designOf(one).rollbackIndex, 2, "and the marker follows");
      refused(project, { kind: "delete-design-feature", featureId: "feature:nope" });
    }
  },
  {
    name: "rebuilding after a sketch edit replaces the solid, keeps its visibility and flags a feature that failed",
    run: () => {
      let project = withExtrude();
      const bigger: GeneralSolidBody = { ...tetra("general-body:one"), positionsMm: [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 20] };
      project = run(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: bigger }] });
      equal(project.part.generalBodies![0]!.positionsMm[3], 20, "the solid was replaced");
      project = run(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", message: "The profile no longer exists." }] });
      const feature = designOf(project).features[1]!;
      assert(feature.kind !== "sketch" && feature.health?.message === "The profile no longer exists.", "the failure is recorded on the feature");
      project = run(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: bigger }] });
      assert(designOf(project).features[1]!.health === undefined, "a successful rebuild clears the flag");
      refused(project, { kind: "regenerate-design", results: [{ featureId: "feature:sketch-1", body: bigger }] });
      refused(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: tetra("general-body:other") }] });
    }
  },
  {
    name: "a finished sketch can be reopened, and a new sketch starts empty on its own plane",
    run: () => {
      let project = withExtrude();
      project = run(project, { kind: "new-design-sketch", plane: "datum:yz" });
      equal(project.sketch.entities.length, 0, "the new sketch is empty");
      equal(project.sketch.plane, "datum:yz", "on the chosen plane");
      equal(project.activeWorkspace, "sketch", "and the sketch workspace is open");
      equal(designOf(project).editingSketchId, null, "it is not tied to a feature yet");
      assert(designOf(project).features.length === 2, "the timeline is untouched");
      project = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
      assert(project.sketch.entities.length > 0, "reopening loads the finished sketch back");
      equal(designOf(project).editingSketchId, "feature:sketch-1", "and remembers which feature it is");
      refused(project, { kind: "edit-design-sketch", featureId: "feature:extrude-1" });
      const emptied = run(project, { kind: "new-design-sketch", plane: "datum:xy" });
      refused(emptied, { kind: "commit-design-sketch", featureId: "feature:sketch-9", name: "Empty" });
    }
  },
  {
    name: "the timeline is saved with the project, old projects without one still load, and a corrupted timeline is refused",
    run: () => {
      const project = withExtrude();
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(reloaded.ok, `a project with a timeline round-trips: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
      equal(designOf(reloaded.value).features.length, 2, "with its features");
      const legacy = createWorkbenchProject("project:test-legacy");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(legacy))).ok, "a project saved before the timeline existed still loads");
      assert(legacy.design === undefined, "and has no timeline until one is made");
      const corrupt = (mutate: (design: Record<string, unknown>) => void) => {
        const copy = JSON.parse(JSON.stringify(project)) as { design: Record<string, unknown> };
        mutate(copy.design);
        return validateWorkbenchProject(copy);
      };
      assert(!corrupt((design) => { design["rollbackIndex"] = 9; }).ok, "a rollback marker past the end is refused");
      assert(!corrupt((design) => { (design["features"] as Record<string, unknown>[])[1]!["sketchFeatureId"] = "feature:missing"; }).ok, "a solid built on a missing sketch is refused");
      assert(!corrupt((design) => { (design["features"] as Record<string, unknown>[])[1]!["id"] = "feature:sketch-1"; }).ok, "a duplicate feature ID is refused");
      assert(!corrupt((design) => { design["editingSketchId"] = "feature:extrude-1"; }).ok, "the edited sketch must be a sketch feature");
      assert(!corrupt((design) => { (design["features"] as Record<string, unknown>[])[1]!["valueMm"] = 0; }).ok, "a zero-size solid is refused");
    }
  },
  {
    name: "renaming a feature changes only its name",
    run: () => {
      const project = run(withExtrude(), { kind: "rename-design-feature", featureId: "feature:extrude-1", name: "Base plate" });
      equal(designOf(project).features[1]!.name, "Base plate", "renamed");
      refused(project, { kind: "rename-design-feature", featureId: "feature:extrude-1", name: "   " });
    }
  },
  {
    name: "deleting or combining a solid removes its timeline step so the history never lists a step with nothing behind it",
    run: () => {
      let project = withExtrude();
      project = run(project, { kind: "add-design-solid", feature: extrude("feature:extrude-2", "feature:sketch-1", "general-body:two"), body: tetra("general-body:two") });
      const deleted = run(project, { kind: "delete-general-body", bodyId: "general-body:one" });
      equal(designOf(deleted).features.map((feature) => feature.id).join(","), "feature:sketch-1,feature:extrude-2", "deleting a feature-owned body removes its step");
      equal(designOf(deleted).rollbackIndex, 2, "and the marker follows");
      const merged = run(project, { kind: "boolean-general-bodies", targetBodyId: "general-body:one", toolBodyId: "general-body:two", mode: "join", keepTool: false, body: tetra("general-body:merged") });
      equal(designOf(merged).features.map((feature) => feature.id).join(","), "feature:sketch-1", "combining both solids leaves only the sketch step");
      equal((merged.part.generalBodies ?? []).map((body) => body.id).join(","), "general-body:merged", "and an ordinary merged body");
    }
  }
];
