import type { DesignSolidFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, baseFeatureOf, createWorkbenchProject, dependentsOf, describeFeature, designOf, isFeatureActive, modifiesBody, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-chain-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function refused(project: WorkbenchProject, operation: Op): string {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-chain-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.diagnostics[0]?.message ?? "";
}

const tetra = (id: string, scale = 10): GeneralSolidBody => ({
  id, name: id, visible: true, color: "#b9c2c8",
  positionsMm: [0, 0, 0, scale, 0, 0, 0, scale, 0, 0, 0, scale],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
});

const solid = (id: string, sketchFeatureId: string, bodyId: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature => ({
  id, name: id, kind: "extrude", suppressed: false, sketchFeatureId, profileIds: [], valueMm: 10, bodyId, ...extra
});

/** A sketch, a body made from it, and a cut of that body made from a second sketch. */
function withCut(): WorkbenchProject {
  let project = createWorkbenchProject("project:test-chain");
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  project = run(project, { kind: "add-design-solid", feature: solid("feature:extrude-1", "feature:sketch-1", "general-body:one"), body: tetra("general-body:one") });
  project = run(project, { kind: "new-design-sketch", plane: "datum:xz" });
  project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:hole", kind: "circle", center: [0, 0], radiusMm: 2, construction: false } });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
  return run(project, { kind: "add-design-solid", feature: solid("feature:cut-1", "feature:sketch-2", "general-body:one", { operation: "cut", name: "Cut 1" }), body: tetra("general-body:one", 6) });
}

export const designChainTests: readonly TestCase[] = [
  {
    name: "a cut changes the shape of the body it modifies instead of adding a body",
    run: () => {
      const project = withCut();
      const bodies = project.part.generalBodies ?? [];
      equal(bodies.length, 1, "still one body");
      equal(bodies[0]!.positionsMm[3], 6, "its shape is the cut result");
      equal(designOf(project).features.map((feature) => feature.id).join(","), "feature:sketch-1,feature:extrude-1,feature:sketch-2,feature:cut-1", "the cut is a timeline step of its own");
      const cut = designOf(project).features[3]!;
      assert(modifiesBody(cut), "the cut modifies a body");
      equal(baseFeatureOf(designOf(project), "general-body:one")?.id, "feature:extrude-1", "the body belongs to its new-body step");
    }
  },
  {
    name: "a join or cut needs a body that an earlier step made",
    run: () => {
      let project = createWorkbenchProject("project:test-chain-orphan");
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      refused(project, { kind: "add-design-solid", feature: solid("feature:cut-1", "feature:sketch-1", "general-body:none", { operation: "cut" }), body: tetra("general-body:none") });
      const made = run(project, { kind: "add-design-solid", feature: solid("feature:extrude-1", "feature:sketch-1", "general-body:one"), body: tetra("general-body:one") });
      // Rolled back before the body's own step, the body is not available to modify.
      const before = run(made, { kind: "set-design-rollback", index: 1 });
      refused(before, { kind: "add-design-solid", feature: solid("feature:cut-1", "feature:sketch-1", "general-body:one", { operation: "cut" }), body: tetra("general-body:one") });
    }
  },
  {
    name: "a body stays shown while only its cut is suppressed, and goes with its own step",
    run: () => {
      let project = withCut();
      const visible = (): boolean => project.part.generalBodies!.find((body) => body.id === "general-body:one")!.visible;
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:cut-1", suppressed: true });
      equal(visible(), true, "suppressing the cut does not hide the body");
      equal(isFeatureActive(designOf(project), "feature:cut-1"), false, "the cut is off");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:cut-1", suppressed: false });
      project = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:extrude-1", suppressed: true });
      equal(visible(), false, "suppressing the body's own step hides it");
      equal(isFeatureActive(designOf(project), "feature:cut-1"), false, "a cut of a suppressed body is off too");
    }
  },
  {
    name: "deleting a cut keeps the body, and deleting the body's own step takes its cuts with it",
    run: () => {
      const project = withCut();
      const withoutCut = run(project, { kind: "delete-design-feature", featureId: "feature:cut-1" });
      equal((withoutCut.part.generalBodies ?? []).length, 1, "the body is still there");
      equal(designOf(withoutCut).features.some((feature) => feature.id === "feature:cut-1"), false, "the cut is gone");
      const withoutBody = run(project, { kind: "delete-design-feature", featureId: "feature:extrude-1" });
      equal((withoutBody.part.generalBodies ?? []).length, 0, "the body went with its step");
      equal(designOf(withoutBody).features.some((feature) => feature.id === "feature:cut-1"), false, "and so did the cut");
      const withoutSketch = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-1" });
      equal(designOf(withoutSketch).features.map((feature) => feature.id).join(","), "feature:sketch-2", "deleting the first sketch removes the body and its cut, not the cut's own sketch");
    }
  },
  {
    name: "what depends on a sketch includes the cuts of the bodies built from it",
    run: () => {
      const dependents = dependentsOf(designOf(withCut()), "feature:sketch-1").map((feature) => feature.id);
      assert(dependents.includes("feature:extrude-1") && dependents.includes("feature:cut-1"), "the body step and its cut both depend on the first sketch");
      const secondOnly = dependentsOf(designOf(withCut()), "feature:sketch-2").map((feature) => feature.id);
      equal(secondOnly.join(","), "feature:cut-1", "the second sketch only drives the cut");
    }
  },
  {
    name: "a saved timeline with a cut before its body, or a join of an unknown body, does not load",
    run: () => {
      const project = withCut();
      assert(validateWorkbenchProject(project).ok, "the project round-trips");
      const history = designOf(project);
      const swapped = { ...project, design: { ...history, features: [history.features[0]!, history.features[3]!, history.features[2]!, history.features[1]!] } };
      assert(!validateWorkbenchProject(JSON.parse(JSON.stringify(swapped))).ok, "a cut that comes before its body is refused");
      const bad = { ...project, design: { ...history, features: history.features.map((feature) => feature.id === "feature:cut-1" && feature.kind !== "sketch" ? { ...feature, bodyId: "general-body:unknown" } : feature) } };
      assert(!validateWorkbenchProject(JSON.parse(JSON.stringify(bad))).ok, "a cut of a body no step made is refused");
      const unknownOperation = { ...project, design: { ...history, features: history.features.map((feature) => feature.id === "feature:cut-1" ? { ...feature, operation: "melt" } : feature) } };
      assert(!validateWorkbenchProject(JSON.parse(JSON.stringify(unknownOperation))).ok, "an unknown operation is refused");
    }
  },
  {
    name: "a cut reads as a cut in the timeline's description",
    run: () => {
      const history = designOf(withCut());
      equal(describeFeature(history, history.features[3]!), "Cut 10 mm · from Sketch 2", "cut wording");
      equal(describeFeature(history, history.features[1]!), "10 mm · from Sketch 1", "a new body keeps the plain wording");
    }
  }
];
