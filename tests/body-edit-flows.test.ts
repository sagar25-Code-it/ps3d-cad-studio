import type { DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { BODY, addAndReplay, blockProject, bodyOf, click, driveHandler, editStep, volumeOfBody } from "./body-edit-timeline.test.js";
import { face } from "./body-edits.test.js";
import { applyParameterValues, parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { bodyEditFeature } from "../apps/studio-web/src/body-edit-handlers.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function apply(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-flows-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}
const stepCount = (project: WorkbenchProject): number => designOf(project).features.length;

export const bodyEditFlowTests: readonly TestCase[] = [
  {
    name: "The Flex ribbon flow bends or twists the clicked body from the answers given, and bad answers record nothing",
    run: async () => {
      const { project } = await blockProject();
      const bend = await driveHandler(project, "flex", [click([-20, -15, 0], [0, 0, -1])], ["bend", "0, 0, 1", "45", ""]);
      const rho = 40 / (Math.PI / 4);
      near(volumeOfBody(bend.project), 20 * (Math.PI / 4) * (30 * rho - 450), 20 * (Math.PI / 4) * (30 * rho - 450) * 0.01, "the block was bent 45° about the clicked line");
      const step = designOf(bend.project).features.find((feature): feature is DesignSolidFeature => feature.kind === "flex")!;
      assert(step.bodyEdit?.kind === "flex" && step.bodyEdit.mode === "bend" && step.bodyEdit.zoneLengthMm === undefined, "the step records a bend over the rest of the body");
      const twist = await driveHandler(project, "flex", [click([0, 0, 0], [0, 0, -1])], ["twist", "0, 0, 1", "30"]);
      near(volumeOfBody(twist.project), 24000, 24000 * 0.03, "a twisted block keeps its volume");
      const sizeAfter = solidMetrics(bodyOf(twist.project).positionsMm, bodyOf(twist.project).indices).sizeMm;
      assert(sizeAfter[0] > 40 || sizeAfter[1] > 30, "and its corners swung out beyond the original footprint");
      for (const [label, answers] of [["zero angle", ["bend", "0, 0, 1", "0", ""]], ["no axis", ["bend", "0, 0, 0", "45", ""]], ["unknown mode", ["fold", "0, 0, 1", "45", ""]], ["bend over 180", ["bend", "0, 0, 1", "270", ""]], ["negative zone", ["bend", "0, 0, 1", "45", "-5"]]] as const) {
        const refused = await driveHandler(project, "flex", [click([-20, -15, 0], [0, 0, -1])], answers);
        equal(stepCount(refused.project), stepCount(project), `${label} records nothing`);
      }
      const tooTight = await driveHandler(project, "flex", [click([-20, -15, 0], [0, 0, -1])], ["bend", "0, 0, 1", "170", "10"]);
      equal(stepCount(tooTight.project), stepCount(project), "a bend that would fold the block is not recorded");
      assert(tooTight.statuses.some((text) => text.startsWith("Not applied")), "and the reason is shown");
    }
  },
  {
    name: "The Wrap ribbon flow embosses the chosen closed sketch onto the clicked cylinder (Enter keeps the newest) and refuses a flat click or an unknown mode",
    run: async () => {
      const CAN = "general-body:can";
      let project = apply(createWorkbenchProject("project:test-wrap-flow"), { kind: "new-design-sketch", plane: "datum:xy" });
      project = apply(project, { kind: "add-sketch-entity", entity: { id: "entity:can", kind: "circle", center: [0, 0], radiusMm: 15, construction: false } });
      project = apply(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Can sketch" });
      const base: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 20, bodyId: CAN };
      const built = await rebuildSolidFeature(base, designOf(project).features[0] as never);
      assert(built.ok, "the can builds");
      if (!built.ok) return;
      project = apply(project, { kind: "add-design-solid", feature: base, body: built.body });
      const volume = (current: WorkbenchProject): number => solidMetrics(bodyOf(current, CAN).positionsMm, bodyOf(current, CAN).indices).volumeMm3;
      const plain = volume(project);
      // The can's own sketch is a closed circle too, so with the label sketch there are two candidates and Wrap now asks
      // which to use (PT-02: the newest is never taken silently); an empty answer keeps the newest, a name picks that one.
      project = apply(project, { kind: "new-design-sketch", plane: "datum:xy" });
      project = apply(project, { kind: "add-sketch-entity", entity: { id: "entity:label", kind: "rectangle", center: [0, 0], widthMm: 10, heightMm: 8, rotationDeg: 0, construction: false } });
      project = apply(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Label sketch" });
      const done = await driveHandler(project, "wrap", [click([15, 0, 10], [1, 0, 0], CAN)], ["", "emboss", "1"], CAN);
      near(volume(done.project) - plain, 80 * (1 + 1 / 30), 80 * 0.03, "the label sketch was wrapped on and raised 1 mm");
      const step = designOf(done.project).features.find((feature): feature is DesignSolidFeature => feature.kind === "wrap")!;
      equal(step.sketchFeatureId, "feature:sketch-2", "an empty answer keeps the newest sketch");
      assert(step.bodyEdit?.kind === "wrap" && step.bodyEdit.face.pointMm[0] === 15, "and remembers where the cylinder was clicked");
      const cut = await driveHandler(project, "wrap", [click([15, 0, 10], [1, 0, 0], CAN)], ["Label sketch", "deboss", "0.8"], CAN);
      near(plain - volume(cut.project), 80 * 0.8 * (1 - 0.8 / 30), 80 * 0.04, "a deboss takes the label out of the surface");
      const flat = await driveHandler(project, "wrap", [click([0, 0, 20], [0, 0, 1], CAN)], ["", "emboss", "1"], CAN);
      equal(stepCount(flat.project), stepCount(project), "a click on the flat end records nothing");
      assert(flat.statuses.some((text) => text.includes("flat")), "and says the face is flat");
      const wrongMode = await driveHandler(project, "wrap", [click([15, 0, 10], [1, 0, 0], CAN)], ["", "engrave", "1"], CAN);
      equal(stepCount(wrongMode.project), stepCount(project), "an unknown mode records nothing");
      const wrongSketch = await driveHandler(project, "wrap", [click([15, 0, 10], [1, 0, 0], CAN)], ["No such sketch", "emboss", "1"], CAN);
      equal(stepCount(wrongSketch.project), stepCount(project), "an unknown sketch name records nothing instead of falling back to the newest");
      const { project: block } = await blockProject();
      const none = await driveHandler(block, "wrap", [click([20, 0, 10], [1, 0, 0])], ["emboss", "1"]);
      equal(stepCount(none.project), stepCount(block), "a flat wall of a box is not a cylinder, so nothing is recorded");
      assert(none.statuses.some((text) => text.includes("flat")), "and the flow says the face is flat");
    }
  },
  {
    name: "The Rib / Web ribbon flow builds a rib from the open curves of the latest sketch and explains itself when there are none",
    run: async () => {
      const { project: block } = await blockProject();
      let project = await addAndReplay(block, editStep("shell-flow", "shell", { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [face([0, 0, 20], [0, 0, 1])] }, 2));
      const cup = volumeOfBody(project);
      const noCurves = await driveHandler(project, "web", [], ["2", "symmetric"]);
      equal(stepCount(noCurves.project), stepCount(project), "without an open sketch nothing is recorded");
      assert(noCurves.statuses.some((text) => text.includes("open profile")), "and the message says what to draw");
      project = apply(project, { kind: "new-design-sketch", plane: "datum:xz" });
      project = apply(project, { kind: "add-sketch-entity", entity: { id: "entity:rib-a", kind: "line", start: [-10, 12], end: [10, 12], construction: false } });
      project = apply(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Rib sketch" });
      const done = await driveHandler(project, "web", [], ["2", "symmetric"]);
      near(volumeOfBody(done.project) - cup, 36 * 2 * 10, 0.7, "a 2 mm rib from the floor to the drawn line, wall to wall");
      const step = designOf(done.project).features.find((feature): feature is DesignSolidFeature => feature.kind === "web")!;
      equal(step.sketchFeatureId, "feature:sketch-2", "the step records the rib's sketch");
      assert(step.bodyEdit?.kind === "web" && step.bodyEdit.entityIds.join() === "entity:rib-a" && step.bodyEdit.extendToBody, "and its curve");
      const bad = await driveHandler(project, "web", [], ["-1", "symmetric"]);
      equal(stepCount(bad.project), stepCount(project), "a negative thickness records nothing");
      const wrongSide = await driveHandler(project, "web", [], ["2", "diagonal"]);
      equal(stepCount(wrongSide.project), stepCount(project), "an unknown direction records nothing");
      assert(BODY.length > 0, "the block id is shared");
    }
  }
  ,{
    name: "The inspector edits the numbers of a rib, wrap and flex step and keeps them valid",
    run: async () => {
      const { base } = await blockProject();
      const web = bodyEditFeature("web", { kind: "web", thicknessMm: 2, direction: "symmetric", entityIds: ["entity:a"], extendToBody: true }, base, BODY, 2);
      const fields = parameterFieldsOf(web)!;
      assert(["thickness", "direction", "side", "extend"].every((id) => fields.some((field) => field.id === id)), "a rib lists thickness, thickness direction, side and ends");
      const edited = applyParameterValues(web, { thickness: "3", direction: "one-side", side: "flipped", extend: "as-drawn" });
      assert(edited.ok && edited.feature.bodyEdit?.kind === "web" && edited.feature.bodyEdit.thicknessMm === 3 && edited.feature.bodyEdit.direction === "one-side" && edited.feature.bodyEdit.flip === true && !edited.feature.bodyEdit.extendToBody, "the edit changes all four");
      const auto = edited.ok ? applyParameterValues(edited.feature, { thickness: "3", direction: "one-side", side: "auto", extend: "to-body" }) : edited;
      assert(auto.ok && auto.feature.bodyEdit?.kind === "web" && !("flip" in auto.feature.bodyEdit), "choosing the automatic side removes the stored side");
      assert(!applyParameterValues(web, { thickness: "0", direction: "symmetric", side: "auto", extend: "to-body" }).ok, "a zero thickness is refused");
      const wrap = bodyEditFeature("wrap", { kind: "wrap", mode: "emboss", heightMm: 1, face: { pointMm: [15, 0, 10], normalMm: [1, 0, 0] } }, base, BODY, 1);
      const wrapped = applyParameterValues(wrap, { height: "0.5", mode: "deboss" });
      assert(wrapped.ok && wrapped.feature.bodyEdit?.kind === "wrap" && wrapped.feature.bodyEdit.mode === "deboss" && wrapped.feature.bodyEdit.heightMm === 0.5 && wrapped.feature.bodyEdit.face.pointMm[0] === 15, "a wrap's height and mode change and its face is kept");
      assert(wrapped.ok && wrapped.feature.name.startsWith("Wrap · deboss 0.5 mm"), "and its name follows: " + (wrapped.ok ? wrapped.feature.name : ""));
      const flex = bodyEditFeature("flex", { kind: "flex", mode: "bend", angleDeg: 45, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1] }, base, BODY, 45);
      const flexed = applyParameterValues(flex, { angle: "-30", axis: "0, 1, 0", axisPoint: "5, 0, 0" });
      assert(flexed.ok && flexed.feature.bodyEdit?.kind === "flex" && flexed.feature.bodyEdit.angleDeg === -30 && flexed.feature.bodyEdit.axisDirectionMm[1] === 1 && flexed.feature.bodyEdit.axisPointMm[0] === 5, "a flex's angle, axis and point change");
      assert(!applyParameterValues(flex, { angle: "200", axis: "0, 0, 1", axisPoint: "0, 0, 0" }).ok, "a bend over 180 degrees is refused");
      assert(parameterFieldsOf(bodyEditFeature("replace-face", { kind: "replace-face", faces: [face([0, 0, 20], [0, 0, 1])], toPlane: { pointMm: [0, 0, 18], normalMm: [0, 0, 1] } }, base, BODY, 1)) === undefined, "a replace face has no numbers to edit");
    }
  }
];

export const bodyEditMenuTests: readonly TestCase[] = [
  {
    name: "The Modify menu lists the face-driven edits, disabled until a solid is selected, and each entry starts its own flow",
    run: async () => {
      const { buildWorkbenchMenus } = await import("../apps/studio-web/src/ui/menu-model.js");
      const calls: string[] = [];
      const noop = (): void => undefined;
      const actions = {
        onUndo: noop, onRedo: noop, onCommandPalette: noop, onNewSketch: noop, onCreateSolidFromSketch: noop, onCreatePrimitive: noop, onCombine: noop, onInsertToAssembly: noop,
        onMasterCart: noop, onRenderStudio: noop, onEditSelectedFeature: noop, onToggleSuppressSelected: noop, onDeleteSelected: noop, onMoveSelectedBody: noop, onResizeSelectedBody: noop,
        onModifyGeneralBody: (modifier: string) => { calls.push(`modify:${modifier}`); }, onBodyEdit: (mode: string) => { calls.push(`edit:${mode}`); },
        onFit: noop, onHome: noop, onToggleGrid: noop, onWorkspace: noop, onDesignHealth: noop, onMeasure: noop, onExchange: noop, onAccess: noop, onConnectAi: noop,
        onExportStl: noop, onPlateJson: noop, onLearning: noop, onShortcuts: noop
      };
      const state = { workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 1, previewBodySelected: false, generalBodySelected: false, selectionDeletable: false } as const;
      const items = (generalBodySelected: boolean): ReadonlyMap<string, { readonly disabled?: boolean | undefined; readonly action: () => void }> => new Map(buildWorkbenchMenus({ ...state, generalBodySelected }, actions as never).flatMap((menu) => menu.items).map((entry) => [entry.id, entry]));
      const ids = ["modify.draft", "modify.offset-region", "modify.replace-face", "modify.web", "modify.wrap", "modify.flex"];
      const off = items(false);
      assert(ids.every((id) => off.get(id)?.disabled === true), "every face edit is disabled with no solid selected");
      const on = items(true);
      assert(ids.every((id) => on.get(id)?.disabled !== true), "and enabled with one");
      for (const id of ids) on.get(id)!.action();
      on.get("modify.shell")!.action();
      equal(calls.join(","), "edit:draft,edit:offset-region,edit:replace-face,edit:web,edit:wrap,edit:flex,modify:shell", "each entry calls its own handler; Shell still goes through the modify handler, which opens the face-picking flow");
    }
  }
];
