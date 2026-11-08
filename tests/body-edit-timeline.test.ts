import type { BodyEditSpec, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, describeFeature, designOf, modifiesBody, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { analyzeFaces } from "../packages/workbench-geometry/src/face-analysis.js";
import { replayAllBodies, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { face } from "./body-edits.test.js";
import { applyParameterValues, parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { bodyEditFeature, createBodyEditHandlers, type BodyEditMode } from "../apps/studio-web/src/body-edit-handlers.js";
import type { ViewportMeasurePoint } from "../packages/viewport-three/src/index.js";

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
    name: "The inspector edits a body-edit step's numbers, keeps its faces, refreshes its name and the replay uses the new values",
    run: async () => {
      const { project, base } = await blockProject();
      const made = bodyEditFeature("shell", { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [top] }, base, BODY, 2);
      assert(validSolidFeaturePayload(made) && made.name.startsWith("Shell · 2 mm wall inside"), "the handler builds a valid, named step");
      const fields = parameterFieldsOf(made)!;
      assert(fields.some((field) => field.id === "wall") && fields.some((field) => field.id === "side"), "the dialog lists wall and side");
      const edited = applyParameterValues(made, { wall: "3", side: "inside" });
      assert(edited.ok, "a valid edit is accepted");
      if (!edited.ok) return;
      assert(edited.feature.bodyEdit?.kind === "shell" && edited.feature.bodyEdit.thicknessMm === 3 && edited.feature.bodyEdit.openFaces.length === 1, "thickness changed and the open face was kept");
      equal(edited.feature.valueMm, 3, "the timeline value follows");
      assert(edited.feature.name.startsWith("Shell · 3 mm wall inside"), "the name was refreshed: " + edited.feature.name);
      assert(!applyParameterValues(made, { wall: "-1", side: "inside" }).ok, "a negative wall is refused by the dialog");
      const current = await addAndReplay(project, edited.feature);
      near(volumeOfBody(current), 40 * 30 * 20 - 34 * 24 * 17, 1e-3, "the replay uses the edited 3 mm wall");
      const draftStep = bodyEditFeature("draft", { kind: "draft", angleDeg: 4, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([20, 0, 10], [1, 0, 0])] }, base, BODY, 4);
      const draftFields = parameterFieldsOf(draftStep)!;
      const draftEdit = applyParameterValues(draftStep, { angle: "-2", pull: "0, 0, 1" });
      assert(draftFields.length === 2 && draftEdit.ok && draftEdit.feature.bodyEdit?.kind === "draft" && draftEdit.feature.bodyEdit.angleDeg === -2, "a draft's angle may be edited to a negative value");
      assert(!applyParameterValues(draftStep, { angle: "0", pull: "0, 0, 1" }).ok, "a zero draft angle is refused");
      assert(!applyParameterValues(draftStep, { angle: "5", pull: "0, 0, 0" }).ok, "a zero pull direction is refused");
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

/** Drives the real ribbon handler with scripted clicks and prompt answers; commits exactly as the app does (apply, replay, regenerate). */
export async function driveHandler(initial: WorkbenchProject, mode: BodyEditMode, clicks: readonly (ViewportMeasurePoint | null)[], answers: readonly (string | null)[], bodyId: string = BODY): Promise<{ readonly project: WorkbenchProject; readonly statuses: string[]; readonly guides: number }> {
  let project = initial;
  const queue = [...clicks];
  const replies = [...answers];
  const statuses: string[] = [];
  let guideCalls = 0;
  const handlers = createBodyEditHandlers({
    project: () => project,
    selectedBodyId: () => bodyId,
    pick: async (instruction) => { statuses.push(instruction); return queue.length === 0 ? null : queue.shift()!; },
    commit: async (intent, mustApply) => {
      const first = applyWorkbenchOperation(project, { ...intent, operationId: `operation:test-handler-${++serial}`, expectedRevision: project.revision } as WorkbenchOperation);
      if (!first.ok) { statuses.push(first.diagnostics[0]?.message ?? "rejected"); return false; }
      const results = await replayAllBodies(first.value.project);
      const blocked = results.find((result) => result.featureId === mustApply && result.message !== undefined);
      if (blocked?.message !== undefined) { statuses.push(`Not applied: ${blocked.message}`); return false; }
      const second = applyWorkbenchOperation(first.value.project, { kind: "regenerate-design", results, operationId: `operation:test-handler-${++serial}`, expectedRevision: first.value.project.revision } as WorkbenchOperation);
      if (!second.ok) return false;
      project = second.value.project;
      return true;
    },
    say: (_state, text) => { statuses.push(text); },
    ask: () => (replies.length === 0 ? null : replies.shift()!),
    select: () => undefined,
    showGuides: (guides) => { if (guides.length > 0) guideCalls += 1; }
  });
  await handlers.run(mode);
  return { project, statuses, guides: guideCalls };
}
export const click = (point: readonly [number, number, number], normal: readonly [number, number, number], bodyId: string = BODY): ViewportMeasurePoint => ({ pointMm: point, semanticId: bodyId, normalMm: normal });

export const bodyEditHandlerTests: readonly TestCase[] = [
  {
    name: "The Shell ribbon flow: click the top face, answer the prompts, and the timeline holds a replayable shell; Esc or a bad answer records nothing",
    run: async () => {
      const { project } = await blockProject();
      const done = await driveHandler(project, "shell", [click([5, 3, 20], [0, 0, 1])], ["2.5", "inside"]);
      near(volumeOfBody(done.project), 40 * 30 * 20 - 35 * 25 * 17.5, 1e-3, "the clicked top face was opened and the 2.5 mm walls cut");
      const step = designOf(done.project).features.find((feature): feature is DesignSolidFeature => feature.kind === "shell")!;
      assert(step.bodyEdit?.kind === "shell" && step.bodyEdit.openFaces.length === 1 && step.bodyEdit.openFaces[0]!.normalMm[2] === 1, "the step records the picked face by point and direction");
      assert(done.guides > 0, "the picked face was outlined in the viewport");
      const sideOpen = await driveHandler(project, "shell", [click([20, 0, 10], [1, 0, 0]), click([-20, 0, 10], [-1, 0, 0])], ["2", "inside"]);
      near(volumeOfBody(sideOpen.project), 40 * 30 * 20 - 40 * 26 * 16, 1e-3, "two clicked side faces gave a tube open at both ends");
      const cancelled = await driveHandler(project, "shell", [], []);
      equal(designOf(cancelled.project).features.length, designOf(project).features.length, "Esc before any click records nothing");
      const badThickness = await driveHandler(project, "shell", [click([5, 3, 20], [0, 0, 1])], ["-3", "inside"]);
      equal(designOf(badThickness.project).features.length, designOf(project).features.length, "a negative thickness records nothing");
      assert(badThickness.statuses.some((text) => text.includes("positive")), "and says why");
      const tooThick = await driveHandler(project, "shell", [click([5, 3, 20], [0, 0, 1])], ["20", "inside"]);
      equal(designOf(tooThick.project).features.length, designOf(project).features.length, "a wall too thick for the block is not recorded");
      assert(tooThick.statuses.some((text) => text.startsWith("Not applied")), "the failure reason is reported");
      const wrongBody = await driveHandler(project, "shell", [{ pointMm: [5, 3, 20], semanticId: "general-body:other", normalMm: [0, 0, 1] }], ["2", "inside"]);
      equal(designOf(wrongBody.project).features.length, designOf(project).features.length, "a click on another body is ignored");
    }
  },
  {
    name: "The Draft, Offset Region and Replace Face ribbon flows record steps that give the measured result",
    run: async () => {
      const { project } = await blockProject();
      const k = Math.tan((5 * Math.PI) / 180);
      const drafted = await driveHandler(project, "draft", [
        click([0, 0, 0], [0, 0, -1]),
        click([20, 0, 10], [1, 0, 0]), click([-20, 0, 10], [-1, 0, 0]), click([0, 15, 10], [0, 1, 0]), click([0, -15, 10], [0, -1, 0])
      ], ["0, 0, 1", "5"]);
      near(volumeOfBody(drafted.project), 40 * 30 * 20 - 70 * k * 400 + (4 / 3) * k * k * 8000, 1e-3, "neutral bottom face, pull +Z, four walls: the tapered volume");
      const noWalls = await driveHandler(project, "draft", [click([0, 0, 0], [0, 0, -1])], ["0, 0, 1", "5"]);
      equal(designOf(noWalls.project).features.length, designOf(project).features.length, "a draft with no faces picked records nothing");
      const offset = await driveHandler(project, "offset-region", [click([0, 0, 20], [0, 0, 1])], ["4"]);
      near(volumeOfBody(offset.project), 40 * 30 * 24, 1e-3, "the clicked top face moved 4 mm up");
      const replaced = await driveHandler(project, "replace-face", [click([0, 0, 20], [0, 0, 1])], ["0 0 17 0 0 1"]);
      near(volumeOfBody(replaced.project), 40 * 30 * 17, 1e-3, "the top face was put on the plane z = 17");
      // A body with a slanted wall: replace the flat wall by the plane of the slanted one.
      let wedge = run(createWorkbenchProject("project:test-wedge"), { kind: "new-design-sketch", plane: "datum:xy" });
      const outline: readonly (readonly [number, number])[] = [[0, 0], [40, 0], [40, 20], [20, 20], [0, 10]];
      outline.forEach((start, index) => { wedge = run(wedge, { kind: "add-sketch-entity", entity: { id: `entity:edge-${index}`, kind: "line", start, end: outline[(index + 1) % outline.length]!, construction: false } }); });
      wedge = run(wedge, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const wedgeBase: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 30, bodyId: BODY };
      const wedgeBuilt = await rebuildSolidFeature(wedgeBase, sketchOf(wedge));
      assert(wedgeBuilt.ok, "the wedge builds");
      if (!wedgeBuilt.ok) return;
      wedge = run(wedge, { kind: "add-design-solid", feature: wedgeBase, body: wedgeBuilt.body });
      const slant = 1 / Math.sqrt(5);
      const toFace = await driveHandler(wedge, "replace-face", [click([40, 20, 15], [0, 1, 0]), null, click([10, 15, 15], [-slant, 2 * slant, 0])], ["face"]);
      assert(designOf(toFace.project).features.some((feature) => feature.kind !== "sketch" && feature.bodyEdit?.kind === "replace-face" && feature.bodyEdit.toFace !== undefined), "replace with a clicked face records the face reference");
      near(volumeOfBody(toFace.project), 30 * (400 + 400), 1e-3, "the flat wall now lies on the slanted wall's plane: the section is one slope from y 10 to y 30");
      const toPlaneBad = await driveHandler(wedge, "replace-face", [click([40, 20, 15], [0, 1, 0])], ["1 2"]);
      equal(designOf(toPlaneBad.project).features.length, designOf(wedge).features.length, "a malformed plane answer records nothing");
    }
  }
];
