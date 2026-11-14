import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyPlainSize, renamedForOperation } from "../apps/studio-web/src/feature-parameters.js";
import { FeatureEditDialog } from "../apps/studio-web/src/ui/FeatureEditDialog.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, type DesignSketchFeature, type DesignSolidFeature, type GeneralSolidBody, type SketchEntity, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** HS-06: Edit Feature is docked with no backdrop (the model stays live), and a join, cut or intersect step can switch between them. */

const BODY = "general-body:block";
let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-editdock-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const rectangle = (id: string, width: number, height: number): SketchEntity => ({ id, kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const volumeOf = (body: GeneralSolidBody): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const stepOf = (project: WorkbenchProject, id: string): DesignSolidFeature => designOf(project).features.find((feature): feature is DesignSolidFeature => feature.id === id)!;

/** A 60 x 40 x 20 block (Sketch 1, Extrude 1) and a 20 x 20 square sketched on its top face plane (Sketch 2) cut 5 mm down into it (Cut 1). */
async function blockWithCut(): Promise<WorkbenchProject> {
  let project = createWorkbenchProject("project:test-edit-dock");
  project = { ...project, sketch: { ...project.sketch, entities: [rectangle("entity:outline", 60, 40)], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const first = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: first.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, first);
  assert(built.ok, "the block builds");
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  project = run(project, { kind: "new-design-sketch", plane: "datum:xy", offsetMm: 20 });
  project = run(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rectangle("entity:pocket", 20, 20)], addConstraints: [], label: "Draw" });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
  const cut: DesignSolidFeature = { id: "feature:cut-1", name: "Cut 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-2", profileIds: [], valueMm: 5, bodyId: BODY, operation: "cut", direction: "flipped" };
  const added = run(project, { kind: "add-design-solid", feature: cut, body: bodyOf(project) });
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

export const editFeatureDockTests: readonly TestCase[] = [
  {
    name: "Edit Feature is docked with no backdrop and is not modal; a join, cut or intersect step has an Operation choice and a step that makes a body does not",
    run: async () => {
      const project = await blockWithCut();
      const dialog = (feature: DesignSolidFeature): string => renderToStaticMarkup(createElement(FeatureEditDialog, { feature, project, busy: false, onApply: () => undefined, onClose: () => undefined }));
      const html = dialog(stepOf(project, "feature:cut-1"));
      assert(html.includes("feature-edit-dock") && !html.includes('role="dialog"'), "docked, and not a dialog");
      assert(!html.includes('aria-modal="true"'), "no modal marker");
      assert(html.includes('aria-label="Operation"') && html.includes("Join (add to the solid)") && html.includes("Cut (remove from the solid)") && html.includes("Intersect"), "the operation can be changed");
      assert(/<option value="cut" selected="">/u.test(html) || html.includes('value="cut"'), "the cut is the chosen one");
      assert(html.includes('aria-label="Cut extent"'), "a cut still offers Through all");
      const base = dialog(stepOf(project, "feature:extrude-1"));
      assert(!base.includes('aria-label="Operation"'), "a step that makes a body of its own has nothing to switch to");
    }
  },
  {
    name: "Switching a cut to a join renames it to the next free Join number, drops Through all, rebuilds the solid and keeps the rest of the step",
    run: async () => {
      const project = await blockWithCut();
      const cut = stepOf(project, "feature:cut-1");
      near(volumeOf(bodyOf(project)), 60 * 40 * 20 - 20 * 20 * 5, 60 * 40 * 20 * 0.005, "the pocket is cut");
      const same = applyPlainSize(cut, { text: "5", direction: "flipped", throughAll: false, operation: "cut" }, project);
      assert(same.ok && same.feature.operation === "cut" && same.feature.name === "Cut 1", "choosing the operation it already has changes nothing");
      const switched = applyPlainSize(cut, { text: "5", direction: "flipped", throughAll: false, operation: "join" }, project);
      assert(switched.ok, `the switch is accepted: ${switched.ok ? "" : switched.message}`);
      if (!switched.ok) return;
      equal(switched.feature.operation, "join", "it is a join now");
      equal(switched.feature.name, "Join 1", "named for what it does");
      equal(switched.feature.direction, "flipped", "its direction is kept");
      equal(switched.feature.sketchFeatureId, "feature:sketch-2", "and its sketch");
      const updated = run(project, { kind: "update-design-solid", feature: switched.feature, body: bodyOf(project) });
      const rebuilt = run(updated, { kind: "regenerate-design", results: await replayAllBodies(updated) });
      near(volumeOf(bodyOf(rebuilt)), 60 * 40 * 20, 60 * 40 * 20 * 0.005, "the pocket is gone: the join adds a box that lies inside the block");
      assert(designOf(rebuilt).features.every((feature) => feature.health === undefined), "no step is flagged");
      const refused = applyPlainSize({ ...cut, extent: "through-all" }, { text: "5", direction: "one-side", throughAll: true, operation: "join" }, project);
      assert(!refused.ok && refused.message.includes("Through all"), "Through all on a join is refused with the reason");
      const dropped = applyPlainSize({ ...cut, extent: "through-all" }, { text: "5", direction: "one-side", throughAll: false, operation: "intersect" }, project);
      assert(dropped.ok && dropped.feature.extent === undefined && dropped.feature.operation === "intersect" && dropped.feature.name === "Intersect 1", "leaving a cut drops its through-all extent");
    }
  },
  {
    name: "The new name is the next free number for the verb, and a name the person chose is left alone",
    run: () => {
      const feature: DesignSolidFeature = { id: "feature:x", name: "Cut 3", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s", profileIds: [], valueMm: 1, bodyId: BODY, operation: "cut" };
      equal(renamedForOperation(feature, "join", ["Join 1", "Join 2"]), "Join 3", "Join 1 and Join 2 are taken");
      equal(renamedForOperation(feature, "join", []), "Join 1", "the first one");
      equal(renamedForOperation({ ...feature, name: "Pocket for the screw" }, "join", []), "Pocket for the screw", "a name the person chose stays");
    }
  },
];
