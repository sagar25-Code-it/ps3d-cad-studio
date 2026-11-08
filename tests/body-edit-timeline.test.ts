import type { BodyEditSpec, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, describeFeature, designOf, modifiesBody, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { analyzeFaces } from "../packages/workbench-geometry/src/face-analysis.js";
import { replayAllBodies, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { face } from "./body-edits.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-bodyedit-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

export const BODY = "general-body:block";
export const sketchOf = (project: WorkbenchProject): DesignSketchFeature => designOf(project).features[0] as DesignSketchFeature;

/** A 40 x 30 rectangle sketch extruded 20 mm: a box from (-20, -15, 0) to (20, 15, 20), built through the real timeline. */
export async function blockProject(height = 20): Promise<{ readonly project: WorkbenchProject; readonly base: DesignSolidFeature }> {
  let project = run(createWorkbenchProject("project:test-body-edits"), { kind: "new-design-sketch", plane: "datum:xy" });
  project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:block", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 30, rotationDeg: 0, construction: false } });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const base: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: height, bodyId: BODY };
  const built = await rebuildSolidFeature(base, sketchOf(project));
  assert(built.ok, "the block builds");
  if (!built.ok) throw new Error("unreachable");
  return { project: run(project, { kind: "add-design-solid", feature: base, body: built.body }), base };
}

export const bodyOf = (project: WorkbenchProject, id = BODY): GeneralSolidBody => project.part.generalBodies!.find((body) => body.id === id)!;
export const volumeOfBody = (project: WorkbenchProject): number => solidMetrics(bodyOf(project).positionsMm, bodyOf(project).indices).volumeMm3;

export const editStep = (id: string, kind: DesignSolidFeature["kind"], bodyEdit: BodyEditSpec, valueMm = 1): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm, bodyId: BODY, operation: "direct-edit", bodyEdit });

/** Adds a body-edit step through add-design-solid and replays the whole timeline, as the app's commit does. */
export async function addAndReplay(project: WorkbenchProject, step: DesignSolidFeature): Promise<WorkbenchProject> {
  const added = run(project, { kind: "add-design-solid", feature: step, body: bodyOf(project) });
  const results = await replayAllBodies(added);
  return run(added, { kind: "regenerate-design", results });
}

export const replayed = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });

const top = face([0, 0, 20], [0, 0, 1]);

export const bodyEditTimelineTests: readonly TestCase[] = [
  {
    name: "A general shell step replays from the timeline, can be suppressed, and follows an edit of the block under it",
    run: async () => {
      const { project, base } = await blockProject();
      near(volumeOfBody(project), 40 * 30 * 20, 1e-3, "the block is a 40 x 30 x 20 box");
      const shell = editStep("shell-1", "shell", { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [top] }, 2);
      assert(validSolidFeaturePayload(shell), "the shell step is a valid feature");
      assert(modifiesBody(shell), "a shell with a body edit changes the existing body, it does not make a new one");
      let current = await addAndReplay(project, shell);
      near(volumeOfBody(current), 40 * 30 * 20 - 36 * 26 * 18, 1e-3, "the replay hollowed the block to its wall volume");
      assert(isClosedAndOriented(bodyOf(current).indices), "the shelled body is closed");
      assert(designOf(current).features.every((feature) => feature.health === undefined), "no step is flagged");
      assert(describeFeature(designOf(current), designOf(current).features.find((feature) => feature.id === shell.id)!).includes("2 mm wall inside"), "the timeline describes the shell");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(current)) as unknown).ok, "the project with a shell step survives a save and reload");
      const off = run(current, { kind: "set-design-feature-suppressed", featureId: shell.id, suppressed: true });
      near(volumeOfBody(await replayed(off)), 40 * 30 * 20, 1e-3, "a suppressed shell leaves the solid block");
      // Edit the base: the block becomes 30 mm tall; the shell's top face moved 10 mm and is still found.
      const taller: DesignSolidFeature = { ...base, valueMm: 30 };
      const rebuilt = await rebuildSolidFeature(taller, sketchOf(current));
      assert(rebuilt.ok, "the taller block builds");
      if (!rebuilt.ok) return;
      current = run(current, { kind: "update-design-solid", feature: taller, body: rebuilt.body });
      current = await replayed(current);
      near(volumeOfBody(current), 40 * 30 * 30 - 36 * 26 * 28, 1e-3, "after the base edit the shell is 30 mm tall with the same 2 mm walls");
      assert(designOf(current).features.every((feature) => feature.health === undefined), "still no step is flagged");
    }
  },
  {
    name: "A shell whose open face no longer exists is flagged on its step instead of silently doing something else",
    run: async () => {
      const { project } = await blockProject();
      const shell = editStep("shell-gone", "shell", { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [face([0, 0, 20], [0, 0, 1]), face([500, 0, 0], [1, 0, 0])] }, 2);
      const current = await addAndReplay(project, shell);
      const flagged = designOf(current).features.find((feature) => feature.id === shell.id);
      assert(flagged !== undefined && flagged.health !== undefined && flagged.health.message.includes("gone"), "the step carries the reason");
      near(volumeOfBody(current), 40 * 30 * 20, 1e-3, "the body keeps its previous shape");
    }
  },
  {
    name: "Draft, offset region and replace face stack on one body through the timeline and each leaves a closed solid",
    run: async () => {
      const { project } = await blockProject();
      const k = Math.tan((6 * Math.PI) / 180);
      const draft = editStep("draft-1", "draft", {
        kind: "draft", angleDeg: 6, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0],
        faces: [face([20, 0, 10], [1, 0, 0]), face([-20, 0, 10], [-1, 0, 0]), face([0, 15, 10], [0, 1, 0]), face([0, -15, 10], [0, -1, 0])]
      }, 6);
      let current = await addAndReplay(project, draft);
      near(volumeOfBody(current), 40 * 30 * 20 - 70 * k * 400 + (4 / 3) * k * k * 8000, 1e-3, "the draft step tapered all four walls");
      const offset = editStep("offset-1", "offset-region", { kind: "offset-region", distanceMm: 5, faces: [face([0, 0, 20], [0, 0, 1])] }, 5);
      current = await addAndReplay(current, offset);
      const afterOffset = volumeOfBody(current);
      assert(afterOffset > 40 * 30 * 20 - 70 * k * 400 + (4 / 3) * k * k * 8000, "the offset step made the drafted block taller");
      assert(typeof analyzeFaces(bodyOf(current)) !== "string", "closed and outward after the offset (welded check)");
      const replace = editStep("replace-1", "replace-face", { kind: "replace-face", faces: [face([0, 0, 25], [0, 0, 1])], toPlane: { pointMm: [0, 0, 22], normalMm: [0, 0, 1] } }, 1);
      current = await addAndReplay(current, replace);
      const size = solidMetrics(bodyOf(current).positionsMm, bodyOf(current).indices).sizeMm;
      near(size[2], 22, 1e-6, "the replace step moved the top onto the plane z = 22");
      assert(designOf(current).features.every((feature) => feature.health === undefined), "no step is flagged");
      equal(designOf(current).features.filter((feature) => feature.kind !== "sketch").length, 4, "the timeline lists the extrude and the three edits");
      // Rolling back below the draft shows the plain block again.
      const rolled = run(current, { kind: "set-design-rollback", index: 2 });
      near(volumeOfBody(await replayed(rolled)), 40 * 30 * 20, 1e-3, "rolled back to just the extrude, the block is plain again");
      const all = analyzeFaces(bodyOf(current));
      assert(typeof all !== "string" && all.regions.length === 6, "the finished body still has six flat faces");
    }
  },
  {
    name: "Body-edit payloads are validated: the pairing with direct-edit, the face lists, and the numbers",
    run: async () => {
      const { project } = await blockProject();
      const good = editStep("v-shell", "shell", { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [top] }, 2);
      assert(validSolidFeaturePayload(good), "a well-formed shell is valid");
      const reject = (label: string, feature: unknown): void => assert(!validSolidFeaturePayload(feature), `${label} is refused`);
      reject("a body edit without direct-edit", { ...good, operation: "join" });
      reject("a shell body edit on the wrong kind", { ...good, kind: "draft" });
      reject("an offset-region step with no body edit", { ...good, kind: "offset-region", bodyEdit: undefined, operation: "direct-edit" });
      reject("a negative wall", { ...good, bodyEdit: { kind: "shell", thicknessMm: -1, side: "inside", openFaces: [top] } });
      reject("an unknown side", { ...good, bodyEdit: { kind: "shell", thicknessMm: 2, side: "sideways", openFaces: [top] } });
      reject("a face with no direction", { ...good, bodyEdit: { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [{ pointMm: [0, 0, 0], normalMm: [0, 0, 0] }] } });
      reject("a draft with no faces", { ...good, kind: "draft", bodyEdit: { kind: "draft", angleDeg: 5, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [] } });
      reject("a draft with a zero pull", { ...good, kind: "draft", bodyEdit: { kind: "draft", angleDeg: 5, pullDirection: [0, 0, 0], neutralPointMm: [0, 0, 0], faces: [top] } });
      reject("a replace-face with both a face and a plane", { ...good, kind: "replace-face", bodyEdit: { kind: "replace-face", faces: [top], toFace: top, toPlane: top } });
      reject("a stray key in the body edit", { ...good, bodyEdit: { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [top], extra: 1 } });
      reject("the old shell fields next to a body edit", { ...good, shellOpenFace: "top" });
      assert(validSolidFeaturePayload(editStep("v-off", "offset-region", { kind: "offset-region", distanceMm: -3, faces: [top] }, 3)), "an offset region may be negative");
      assert(validSolidFeaturePayload(editStep("v-rep", "replace-face", { kind: "replace-face", faces: [top], toPlane: top })), "a replace face onto a plane is valid");
      // The operation itself is refused at the reducer, not just by the payload check.
      const bad = applyWorkbenchOperation(project, { kind: "add-design-solid", feature: { ...good, bodyEdit: { kind: "shell", thicknessMm: 0, side: "inside", openFaces: [] } }, body: bodyOf(project), operationId: "operation:test-bad-shell", expectedRevision: project.revision } as WorkbenchOperation);
      assert(!bad.ok, "add-design-solid refuses a shell with zero thickness");
    }
  }
];
