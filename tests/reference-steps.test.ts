import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConstructionAxis, DesignSketchFeature, ConstructionPlane, ConstructionPoint, DesignSolidFeature, PartPreviewBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  applyWorkbenchOperation, createWorkbenchProject, inactiveReferenceIds, resolveWorkbenchContextCommands, deleteImpact, describeFeature, designOf, isFeatureActive, isReferenceFeature, legacyReferenceItems, referenceStepOf, validateWorkbenchOperation, validateWorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { timelineFindings } from "../packages/workbench-health/src/timeline.js";
import { timelineSummary } from "../packages/workbench-mcp/src/timeline-summary.js";
import { planeFollowFrames, planeSketchFrame } from "../apps/studio-web/src/reference-follow.js";
import { referenceParameterFields } from "../apps/studio-web/src/reference-parameters.js";
import { applyParameterValues, parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { replayAllBodies, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { FeatureEditDialog } from "../apps/studio-web/src/ui/FeatureEditDialog.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { applyReferenceEdit } from "../apps/studio-web/src/reference-edit.js";
import { TimelineBar } from "../apps/studio-web/src/ui/TimelineBar.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Construction planes, axes, points and primitives as timeline steps. */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-refstep-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}
function refuse(project: WorkbenchProject, operation: Op): string {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-refstep-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.diagnostics[0]?.message ?? "";
}

const noop = (): void => undefined;
const fresh = (): WorkbenchProject => createWorkbenchProject("project:test-refsteps");
const offsetPlane = (id: string, name: string, offsetMm: number): ConstructionPlane => ({ id: `construction-plane:${id}`, name, visible: true, definition: { kind: "offset", basePlane: "datum:xy", offsetMm } });
const axisOf = (id: string, name: string): ConstructionAxis => ({ id: `construction-axis:${id}`, name, visible: true, definition: { kind: "point-and-direction", origin: [10, 0, 0], direction: [0, 0, 1] } });
const pointOf = (id: string, name: string): ConstructionPoint => ({ id: `construction-point:${id}`, name, visible: true, definition: { kind: "xyz", position: [1, 2, 3] } });
const box = (id: string, name: string): PartPreviewBody => ({ id: `part-body:${id}`, name, shape: "block", visible: true, color: "#b9c2c8", translationMm: [40, 0, 5], rotationDeg: [0, 0, 0], sizeMm: [20, 10, 10] });

const withAll = (): WorkbenchProject => {
  let project = fresh();
  project = run(project, { kind: "add-construction-axis", axis: axisOf("a1", "Spin axis") });
  project = run(project, { kind: "add-construction-plane", plane: offsetPlane("p1", "Plane 20", 20) });
  project = run(project, { kind: "add-construction-point", point: pointOf("pt1", "Point A") });
  project = run(project, { kind: "add-part-preview-bodies", bodies: [box("b1", "Box A")] });
  return project;
};
const stepOf = (project: WorkbenchProject, itemId: string): DesignSolidFeature => {
  const found = referenceStepOf(designOf(project), itemId);
  assert(found !== undefined, `${itemId} has a timeline step`);
  return found;
};
const visibleOf = (project: WorkbenchProject): Record<string, boolean> => ({
  axis: project.part.constructionAxes![0]!.visible, plane: project.part.construction![0]!.visible, point: project.part.constructionPoints![0]!.visible, box: project.part.previewBodies![0]!.visible
});

/** A sketch placed on the plane (it follows it), finished into the timeline. */
function sketchOnPlane(project: WorkbenchProject, planeId: string, featureId = "feature:s-on-plane"): WorkbenchProject {
  const plane = project.part.construction!.find((candidate) => candidate.id === planeId)!;
  assert(plane.definition.kind === "offset", "an offset plane");
  const frame = { originMm: [0, 0, plane.definition.offsetMm] as const, uAxis: [1, 0, 0] as const, normal: [0, 0, 1] as const };
  let next = run(project, { kind: "new-design-sketch", plane: "datum:xy", frame, planeRef: planeId });
  next = run(next, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 30, heightMm: 20, rotationDeg: 0, construction: false }], addConstraints: [], label: "Draw" });
  return run(next, { kind: "commit-design-sketch", featureId, name: "Sketch on plane" });
}

export const referenceStepTests: readonly TestCase[] = [
  {
    name: "A plane, axis, point and primitive added the old way each become a timeline step at the marker, in order, with the item of the part unchanged",
    run: () => {
      const project = withAll();
      const kinds = designOf(project).features.map((feature) => feature.kind);
      equal(kinds.join(","), "construction-axis,construction-plane,construction-point,primitive", "one step each, in the order they were made");
      equal(designOf(project).rollbackIndex, 4, "the marker is after them");
      const plane = stepOf(project, "construction-plane:p1");
      assert(isReferenceFeature(plane) && plane.reference.kind === "plane" && plane.bodyId === "construction-plane:p1", "the plane step owns the plane's definition");
      equal(plane.name, "Plane 20", "the step carries the item's name");
      equal(project.part.construction![0]!.name, "Plane 20", "and the item keeps it");
      equal(JSON.stringify(project.part.construction![0]!.definition), JSON.stringify({ kind: "offset", basePlane: "datum:xy", offsetMm: 20 }), "the definition is the one that was given");
      assert(describeFeature(designOf(project), plane).includes("20 mm"), `the step says what it is: ${describeFeature(designOf(project), plane)}`);
      assert(legacyReferenceItems(project).length === 0, "nothing is left outside the timeline");
    }
  },
  {
    name: "Two items with the same name get distinct step names, and the item follows its step",
    run: () => {
      let project = fresh();
      project = run(project, { kind: "add-construction-plane", plane: offsetPlane("p1", "Offset plane", 10) });
      project = run(project, { kind: "add-construction-plane", plane: offsetPlane("p2", "Offset plane", 20) });
      equal(designOf(project).features.map((feature) => feature.name).join("|"), "Offset plane|Offset plane (2)", "names stay unique (expressions use them)");
      equal(project.part.construction!.map((plane) => plane.name).join("|"), "Offset plane|Offset plane (2)", "the items carry the same names");
    }
  },
  {
    name: "Rolling the marker back hides every one of them and rolling forward shows them again; suppress and unsuppress do the same for one",
    run: () => {
      let project = withAll();
      project = run(project, { kind: "set-design-rollback", index: 2 });
      const half = visibleOf(project);
      assert(half.axis && half.plane && !half.point && !half.box, `only the steps before the marker are shown: ${JSON.stringify(half)}`);
      project = run(project, { kind: "set-design-rollback", index: 0 });
      assert(Object.values(visibleOf(project)).every((shown) => !shown), "everything is hidden at the start of the timeline");
      assert(inactiveReferenceIds(project).has("construction-plane:p1") && inactiveReferenceIds(project).size === 4, "the pickers are told which ones are off, so a sketch is not offered a plane that is rolled back");
      project = run(project, { kind: "set-design-rollback", index: 4 });
      assert(Object.values(visibleOf(project)).every((shown) => shown), "rolling forward shows them all again");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: stepOf(project, "part-body:b1").id, suppressed: true });
      assert(!visibleOf(project).box && visibleOf(project).plane, "a suppressed primitive is hidden and the rest stays");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: stepOf(project, "part-body:b1").id, suppressed: false });
      assert(visibleOf(project).box, "unsuppressed it is shown again");
    }
  },
  {
    name: "An item the person hid stays hidden through other edits, and a step that stops being live hides what it builds on",
    run: () => {
      let project = withAll();
      project = run(project, { kind: "toggle-construction-plane-visibility", planeId: "construction-plane:p1" });
      project = run(project, { kind: "set-part-parameter", parameter: "thicknessMm", value: 12 });
      assert(!visibleOf(project).plane, "an unrelated edit leaves a hidden plane hidden");
      // A plane perpendicular to an axis is live only while the axis is.
      project = run(project, { kind: "add-construction-plane", plane: { id: "construction-plane:perp", name: "Across the axis", visible: true, definition: { kind: "perpendicular-to-axis", axisId: "construction-axis:a1", point: [10, 0, 5] } } });
      const history = () => designOf(project);
      assert(isFeatureActive(history(), stepOf(project, "construction-plane:perp").id), "the plane is live while its axis is");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: stepOf(project, "construction-axis:a1").id, suppressed: true });
      assert(!isFeatureActive(history(), stepOf(project, "construction-plane:perp").id), "the plane is off when its axis is suppressed");
      assert(!project.part.construction!.find((plane) => plane.id === "construction-plane:perp")!.visible, "and hidden");
      project = run(project, { kind: "set-design-feature-suppressed", featureId: stepOf(project, "construction-axis:a1").id, suppressed: false });
      assert(project.part.construction!.find((plane) => plane.id === "construction-plane:perp")!.visible, "shown again with the axis");
    }
  },
  {
    name: "Editing a step changes the item; a clash of names, a change of kind and an out-of-range number are refused",
    run: () => {
      let project = withAll();
      const plane = stepOf(project, "construction-plane:p1");
      project = run(project, { kind: "update-design-reference", feature: { ...plane, reference: { kind: "plane", definition: { kind: "offset", basePlane: "datum:xy", offsetMm: 35 } } } });
      const item = project.part.construction![0]!;
      assert(item.definition.kind === "offset" && item.definition.offsetMm === 35, "the plane moved");
      equal(item.visible, true, "and kept its visibility");
      assert(refuse(project, { kind: "update-design-reference", feature: { ...stepOf(project, "construction-plane:p1"), name: "Spin axis" } }).includes("already called"), "a name another step has is refused");
      assert(refuse(project, { kind: "update-design-reference", feature: { ...stepOf(project, "construction-plane:p1"), kind: "construction-axis", reference: { kind: "axis", definition: { kind: "two-points", a: [0, 0, 0], b: [1, 0, 0] } } } }).includes("keeps its kind"), "a plane does not become an axis");
      assert(refuse(project, { kind: "update-design-reference", feature: { ...stepOf(project, "construction-plane:p1"), reference: { kind: "plane", definition: { kind: "offset", basePlane: "datum:xy", offsetMm: 5e9 } } } }).length > 0, "an offset beyond the model's reach is refused");
      const renamed = run(project, { kind: "rename-design-feature", featureId: stepOf(project, "construction-plane:p1").id, name: "Datum plane" });
      equal(renamed.part.construction![0]!.name, "Datum plane", "renaming the step renames the plane");
      const renamedByList = run(renamed, { kind: "rename-construction-plane", planeId: "construction-plane:p1", name: "Shelf" });
      equal(stepOf(renamedByList, "construction-plane:p1").name, "Shelf", "and renaming the plane the old way renames the step");
    }
  },
  {
    name: "A step's numbers take expressions: bound to a parameter, they follow it, and the plane follows them",
    run: () => {
      let project = withAll();
      const plane = stepOf(project, "construction-plane:p1");
      project = run(project, { kind: "set-design-parameters", parameters: [{ name: "gap", expression: "12 mm", unit: "mm", comment: "" }], modelValues: [{ ownerId: plane.id, fieldId: "offset", text: "gap * 2" }] });
      const bound = stepOf(project, "construction-plane:p1");
      equal(bound.expressions?.["offset"], "gap * 2", "the field is bound");
      const offset = (): number => { const d = project.part.construction![0]!.definition; return d.kind === "offset" ? d.offsetMm : NaN; };
      near(offset(), 24, 1e-9, "the plane sits where the expression says");
      project = run(project, { kind: "set-design-parameters", parameters: [{ name: "gap", expression: "20 mm", unit: "mm", comment: "" }] });
      near(offset(), 40, 1e-9, "changing the parameter moves the plane");
      const fields = referenceParameterFields(stepOf(project, "construction-plane:p1")).map((field) => field.id);
      equal(fields.join(","), "offset", `an offset plane has one number: ${fields.join(",")}`);
      const dialog = parameterFieldsOf(stepOf(project, "construction-plane:p1"));
      assert(dialog !== undefined && dialog.length === 1, "the Edit dialog lists it");
      const typed = applyParameterValues(stepOf(project, "construction-plane:p1"), { offset: "gap + 5" }, project);
      assert(typed.ok && typed.feature.reference?.kind === "plane" && typed.feature.reference.definition.kind === "offset" && typed.feature.reference.definition.offsetMm === 25, "typing an expression in the dialog evaluates it");
      const plain = applyParameterValues(stepOf(project, "construction-plane:p1"), { offset: "7.5" }, project);
      assert(plain.ok && plain.feature.expressions === undefined, "a plain number unbinds the field");
      const bad = applyParameterValues(stepOf(project, "construction-plane:p1"), { offset: "1e9" }, project);
      assert(!bad.ok, "a number beyond the limit is refused in the dialog");
    }
  },
  {
    name: "A primitive is a placed step: the dialog edits its size by the names of its shape, and resizing or moving it the old way is recorded in the step",
    run: () => {
      let project = withAll();
      const step = stepOf(project, "part-body:b1");
      const labels = referenceParameterFields(step).map((field) => field.label);
      assert(labels.includes("Width") && labels.includes("Depth") && labels.includes("Height"), `a box says Width, Depth and Height: ${labels.join(", ")}`);
      const edited = applyParameterValues(step, { sizeX: "30", sizeY: "10", sizeZ: "12", posx: "40", posy: "0", posz: "6", rotx: "0", roty: "0", rotz: "0" }, project);
      assert(edited.ok, `the edit is valid: ${edited.ok ? "" : edited.message}`);
      if (!edited.ok) return;
      project = run(project, { kind: "update-design-reference", feature: edited.feature });
      equal(project.part.previewBodies![0]!.sizeMm.join(","), "30,10,12", "the preview body follows its step");
      project = run(project, { kind: "set-part-preview-body-size", bodyId: "part-body:b1", sizeMm: [50, 10, 12] });
      const recorded = stepOf(project, "part-body:b1");
      assert(recorded.reference?.kind === "primitive" && recorded.reference.body.sizeMm[0] === 50, "a resize made the old way is recorded in the step");
      project = run(project, { kind: "set-part-preview-body-transform", bodyId: "part-body:b1", translationMm: [70, 5, 6], rotationDeg: [0, 0, 90] });
      const moved = stepOf(project, "part-body:b1");
      assert(moved.reference?.kind === "primitive" && moved.reference.body.translationMm.join(",") === "70,5,6" && moved.reference.body.rotationDeg[2] === 90, "a move is recorded too");
      const cylinder: PartPreviewBody = { ...box("c1", "Cylinder A"), shape: "cylinder", sizeMm: [16, 16, 30] };
      project = run(project, { kind: "add-part-preview-bodies", bodies: [cylinder] });
      const round = applyParameterValues(stepOf(project, "part-body:c1"), { sizeX: "20", sizeZ: "30", posx: "0", posy: "0", posz: "0", rotx: "0", roty: "0", rotz: "0" }, project);
      assert(round.ok && round.feature.reference?.kind === "primitive" && round.feature.reference.body.sizeMm.join(",") === "20,20,30", "a cylinder's diameter drives both of its round sizes");
      project = run(project, { kind: "delete-part-preview-body", bodyId: "part-body:b1" });
      assert(referenceStepOf(designOf(project), "part-body:b1") === undefined, "deleting the primitive deletes its step");
    }
  },
  {
    name: "A saved project reloads with its steps, and a step that disagrees with its item is not a valid project",
    run: () => {
      const project = withAll();
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(reloaded.ok, `the saved project is valid: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
      if (!reloaded.ok) return;
      equal(JSON.stringify(reloaded.value.design), JSON.stringify(project.design), "the timeline comes back as it was saved");
      equal(JSON.stringify(reloaded.value.part.construction), JSON.stringify(project.part.construction), "and so do the planes");
      const moved = { ...project, part: { ...project.part, construction: [{ ...project.part.construction![0]!, definition: { kind: "offset" as const, basePlane: "datum:xy" as const, offsetMm: 99 } }] } };
      assert(!validateWorkbenchProject(moved).ok, "a plane that no longer matches its step is refused");
      const lost = { ...project, part: { ...project.part, construction: [] } };
      assert(!validateWorkbenchProject(lost).ok, "a step whose plane is gone is refused");
      const stray = { ...project, design: { ...project.design!, features: project.design!.features.map((feature) => feature.kind === "construction-plane" ? { ...feature, sketchFeatureId: "feature:s1" } : feature) } };
      assert(!validateWorkbenchProject(stray).ok, "a construction step cannot name a sketch");
      const roll = run(project, { kind: "set-design-rollback", index: 1 });
      const again = validateWorkbenchProject(JSON.parse(JSON.stringify(roll)));
      assert(again.ok && again.value.design!.rollbackIndex === 1, "the marker position survives save and reload");
    }
  },
  {
    name: "A project saved before the timeline holds them keeps its items as they are, marked as outside the timeline, until they are added",
    run: () => {
      const base = fresh();
      const legacy: WorkbenchProject = { ...base, part: { ...base.part, construction: [offsetPlane("old", "Old plane", 15)], constructionAxes: [axisOf("old", "Old axis")], constructionPoints: [pointOf("old", "Old point")], previewBodies: [box("old", "Old box")] } };
      assert(validateWorkbenchProject(legacy).ok, "an older project still loads");
      equal(legacyReferenceItems(legacy).length, 4, "all four are outside the timeline");
      const touched = run(legacy, { kind: "set-part-parameter", parameter: "thicknessMm", value: 11 });
      equal((touched.design?.features ?? []).length, 0, "an unrelated edit does not move them into the timeline");
      const html = renderToStaticMarkup(createElement(ProjectTree, { project: legacy, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(legacy), onSelect: noop, onContextMenu: noop, onAdoptLegacy: noop }));
      assert(html.includes("not in the timeline"), "the browser marks them");
      assert(html.includes("Add 4 construction items to the timeline"), "and offers to add them");
      const added = run(legacy, { kind: "adopt-legacy-references" });
      equal(designOf(added).features.map((feature) => feature.kind).join(","), "construction-axis,construction-plane,construction-point,primitive", "adding them makes a step each, axes first so what is built on an axis finds it");
      equal(JSON.stringify(added.part.construction), JSON.stringify(legacy.part.construction), "no plane changed");
      equal(JSON.stringify(added.part.constructionAxes), JSON.stringify(legacy.part.constructionAxes), "no axis changed");
      equal(JSON.stringify(added.part.constructionPoints), JSON.stringify(legacy.part.constructionPoints), "no point changed");
      equal(JSON.stringify(added.part.previewBodies), JSON.stringify(legacy.part.previewBodies), "no primitive changed");
      assert(refuse(added, { kind: "adopt-legacy-references" }).includes("already"), "adding twice is refused with a reason");
      const withNew = run(legacy, { kind: "add-construction-plane", plane: offsetPlane("new", "New plane", 5) });
      equal(designOf(withNew).features.length, 1, "a new item gets a step");
      equal(legacyReferenceItems(withNew).length, 4, "and the older ones stay outside it");
    }
  },
  {
    name: "Deleting a plane says what is built on it and removes it; deleting an axis takes the plane and point made from it",
    run: () => {
      let project = withAll();
      project = sketchOnPlane(project, "construction-plane:p1");
      const plane = stepOf(project, "construction-plane:p1");
      const impact = deleteImpact(project, plane.id)!;
      equal(impact.dependents.length, 1, "the sketch placed on the plane is listed");
      equal(impact.dependents[0]!.name, "Sketch on plane", "by name");
      assert(impact.dependents[0]!.reason.includes("placed on Plane 20"), `with the reason: ${impact.dependents[0]!.reason}`);
      const gone = run(project, { kind: "delete-design-feature", featureId: plane.id });
      assert(gone.part.construction!.length === 0 && !designOf(gone).features.some((feature) => feature.id === "feature:s-on-plane"), "the plane and the sketch on it go");
      const viaList = run(project, { kind: "delete-construction-plane", planeId: "construction-plane:p1" });
      assert(!designOf(viaList).features.some((feature) => feature.id === "feature:s-on-plane") && viaList.part.construction!.length === 0, "deleting the plane the old way does the same");
      // An axis takes what is made from it.
      let built = withAll();
      built = run(built, { kind: "add-construction-plane", plane: { id: "construction-plane:perp", name: "Across the axis", visible: true, definition: { kind: "perpendicular-to-axis", axisId: "construction-axis:a1", point: [10, 0, 5] } } });
      const axis = stepOf(built, "construction-axis:a1");
      const axisImpact = deleteImpact(built, axis.id)!;
      assert(axisImpact.dependents.some((item) => item.name === "Across the axis" && item.reason.includes("built on Spin axis")), "the plane built on the axis is named");
      const noAxis = run(built, { kind: "delete-design-feature", featureId: axis.id });
      assert((noAxis.part.constructionAxes ?? []).length === 0 && noAxis.part.construction!.every((candidate) => candidate.id !== "construction-plane:perp"), "the axis and the plane across it are gone");
      const viaAxisList = run(built, { kind: "delete-construction-axis", axisId: "construction-axis:a1" });
      assert((viaAxisList.part.constructionAxes ?? []).length === 0 && viaAxisList.part.construction!.every((candidate) => candidate.id !== "construction-plane:perp") && !designOf(viaAxisList).features.some((feature) => feature.name === "Across the axis"), "deleting the axis the old way takes the plane across it and its step too");
    }
  },
  {
    name: "Reordering respects what a step is built on: a plane cannot move behind its sketch or before its axis, an independent primitive moves freely",
    run: () => {
      let project = withAll();
      project = sketchOnPlane(project, "construction-plane:p1");
      project = run(project, { kind: "add-construction-plane", plane: { id: "construction-plane:perp", name: "Across the axis", visible: true, definition: { kind: "perpendicular-to-axis", axisId: "construction-axis:a1", point: [10, 0, 5] } } });
      const features = designOf(project).features;
      const at = (id: string): number => features.findIndex((feature) => feature.id === id);
      const planeStep = stepOf(project, "construction-plane:p1");
      const sketchIndex = at("feature:s-on-plane");
      assert(refuse(project, { kind: "move-design-feature", featureId: planeStep.id, toIndex: features.length - 1 }).includes("Sketch on plane"), "the plane cannot move after the sketch placed on it");
      assert(refuse(project, { kind: "move-design-feature", featureId: "feature:s-on-plane", toIndex: at(planeStep.id) - 1 }).includes("Plane 20"), "the sketch cannot move before its plane");
      const perp = stepOf(project, "construction-plane:perp");
      assert(refuse(project, { kind: "move-design-feature", featureId: perp.id, toIndex: 0 }).includes("Spin axis"), "a plane cannot move before the axis it is built on");
      const primitive = stepOf(project, "part-body:b1");
      const moved = run(project, { kind: "move-design-feature", featureId: primitive.id, toIndex: 0 });
      equal(designOf(moved).features[0]!.id, primitive.id, "an independent primitive can go first");
      void sketchIndex;
    }
  },
  {
    name: "A sketch placed on an offset plane follows an edit of the offset, and the solid built on it moves with it",
    run: async () => {
      let project = withAll();
      project = sketchOnPlane(project, "construction-plane:p1");
      const sketchFeature = designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === "feature:s-on-plane" && feature.kind === "sketch")!;
      assert(sketchFeature.sketch.planeRef === "construction-plane:p1", "the sketch knows the plane it is placed on");
      assert(planeFollowFrames(project).length === 0, "a sketch on its plane has nothing to follow yet");
      const profileId = detectSketchProfiles(sketchFeature.sketch)[0]!.id;
      const step: DesignSolidFeature = { id: "feature:extrude-on-plane", name: "Extrude on plane", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s-on-plane", profileIds: [profileId], valueMm: 8, bodyId: "general-body:on-plane" };
      const built = await rebuildSolidFeature(step, sketchFeature);
      assert(built.ok, "the solid builds");
      if (!built.ok) return;
      project = run(project, { kind: "add-design-solid", feature: step, body: built.body });
      const zOf = (body: { readonly positionsMm: readonly number[] }): number => Math.min(...body.positionsMm.filter((_, index) => index % 3 === 2));
      near(zOf(project.part.generalBodies![0]!), 20, 1e-6, "the solid starts on the plane at 20 mm");
      // Edit the plane.
      project = run(project, { kind: "update-design-reference", feature: { ...stepOf(project, "construction-plane:p1"), reference: { kind: "plane", definition: { kind: "offset", basePlane: "datum:xy", offsetMm: 35 } } } });
      const frames = planeFollowFrames(project);
      equal(frames.length, 1, "one sketch has to follow");
      near(frames[0]!.frame.originMm[2], 35, 1e-9, "to the new offset");
      project = run(project, { kind: "follow-design-planes", frames });
      const moved = designOf(project).features.find((feature) => feature.id === "feature:s-on-plane")!;
      assert(moved.kind === "sketch" && moved.sketch.planeFrame?.originMm[2] === 35, "the sketch lies on the new plane");
      assert(planeFollowFrames(project).length === 0, "and has nothing more to follow");
      project = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      near(zOf(project.part.generalBodies![0]!), 35, 1e-6, "the rebuilt solid starts on the moved plane");
      // The sketch and what is built on it are off while the plane is suppressed.
      const off = run(project, { kind: "set-design-feature-suppressed", featureId: stepOf(project, "construction-plane:p1").id, suppressed: true });
      assert(!isFeatureActive(designOf(off), "feature:s-on-plane") && !isFeatureActive(designOf(off), "feature:extrude-on-plane"), "suppressing the plane turns off the sketch and the solid on it");
      assert(off.part.generalBodies![0]!.visible === false, "the solid is hidden");
      const on = run(off, { kind: "set-design-feature-suppressed", featureId: stepOf(off, "construction-plane:p1").id, suppressed: false });
      assert(on.part.generalBodies![0]!.visible === true && isFeatureActive(designOf(on), "feature:extrude-on-plane"), "and back with the plane");
    }
  },
  {
    name: "A sketch placed on an offset XZ plane keeps the sketch's Y axis up, like one on the XZ datum, and sits where the plane is drawn",
    run: () => {
      let project = fresh();
      project = run(project, { kind: "add-construction-plane", plane: { id: "construction-plane:xz", name: "Shelf", visible: true, definition: { kind: "offset", basePlane: "datum:xz", offsetMm: 20 } } });
      const frame = planeSketchFrame(project, "construction-plane:xz")!;
      assert(frame !== undefined, "the plane resolves");
      equal(frame.originMm.join(","), "0,20,0", "the origin is where the plane is drawn");
      equal(frame.uAxis.join(","), "1,0,0", "sketch X runs along world X");
      const y = [frame.normal[1]! * frame.uAxis[2]! - frame.normal[2]! * frame.uAxis[1]!, frame.normal[2]! * frame.uAxis[0]! - frame.normal[0]! * frame.uAxis[2]!, frame.normal[0]! * frame.uAxis[1]! - frame.normal[1]! * frame.uAxis[0]!];
      equal(y.map((value) => Math.abs(value) < 1e-12 ? 0 : value).join(","), "0,0,1", "and sketch Y runs up along world Z");
      assert(validateWorkbenchOperation({ operationId: "operation:test-frame", expectedRevision: project.revision, kind: "new-design-sketch", plane: "datum:xy", frame, planeRef: "construction-plane:xz" }).ok, "the frame is one a sketch accepts");
    }
  },
  {
    name: "The timeline strip draws a glyph and a name for each of them, and the health and MCP summaries read them as what they are",
    run: () => {
      const project = run(withAll(), { kind: "set-design-rollback", index: 3 });
      const html = renderToStaticMarkup(createElement(TimelineBar, { history: designOf(project), selectedFeatureId: null, busy: false, onSelect: noop, onEdit: noop, onRollback: noop, onSuppress: noop, onDelete: noop, onRename: noop, onMove: noop }));
      for (const name of ["Spin axis", "Plane 20", "Point A", "Box A"]) assert(html.includes(name), `${name} is on the strip`);
      assert(html.includes("rolled back"), "the step after the marker is marked as rolled back");
      const summary = timelineSummary(project) as { readonly features: readonly { readonly kind: string; readonly itemId?: string; readonly definition?: string }[] };
      assert(summary.features.some((feature) => feature.kind === "construction-plane" && feature.itemId === "construction-plane:p1" && (feature.definition ?? "").includes("20 mm")), "the MCP inspection names the item and what it is");
      const findings = timelineFindings(project);
      assert(!findings.some((finding) => finding.id.includes("orphan") || finding.id.includes("no-body")), `no step is reported as having lost its sketch or solid: ${findings.map((finding) => finding.id).join(", ")}`);
    }
  },
  {
    name: "The three new operations validate their payloads, and the old create operations still work on a project that already has a timeline",
    run: () => {
      const project = withAll();
      const plane = stepOf(project, "construction-plane:p1");
      const envelope = { operationId: "operation:test-valid", expectedRevision: project.revision };
      assert(validateWorkbenchOperation({ ...envelope, kind: "update-design-reference", feature: plane }).ok, "a plane step is accepted");
      assert(!validateWorkbenchOperation({ ...envelope, kind: "update-design-reference", feature: { ...plane, valueMm: 4 } }).ok, "a size on a construction step is refused");
      assert(!validateWorkbenchOperation({ ...envelope, kind: "update-design-reference", feature: { ...plane, reference: { kind: "axis", definition: { kind: "two-points", a: [0, 0, 0], b: [1, 0, 0] } } } }).ok, "a definition of another kind is refused");
      assert(!validateWorkbenchOperation({ ...envelope, kind: "follow-design-planes", frames: [{ featureId: "feature:s", frame: { originMm: [0, 0, 0], uAxis: [1, 0, 0], normal: [1, 0, 0] } }] }).ok, "a frame whose axes are not perpendicular is refused");
      assert(!validateWorkbenchOperation({ ...envelope, kind: "adopt-legacy-references", extra: true }).ok, "adopting takes no fields");
      assert(!validateWorkbenchOperation({ ...envelope, kind: "new-design-sketch", plane: "datum:xy", planeRef: "construction-plane:p1" }).ok, "a sketch cannot follow a plane without its frame");
      const back = run(project, { kind: "set-design-rollback", index: 1 });
      assert(refuse(back, { kind: "new-design-sketch", plane: "datum:xy", frame: { originMm: [0, 0, 20], uAxis: [1, 0, 0], normal: [0, 0, 1] }, planeRef: "construction-plane:p1" }).includes("rolled back or suppressed"), "a sketch cannot be placed on a plane that is after the marker");
      const created = run(project, { kind: "add-construction-axis", axis: axisOf("a2", "Second axis") });
      equal(designOf(created).features.length, 5, "an axis made the old way is a step after the existing ones");
      const rolled = run(project, { kind: "set-design-rollback", index: 2 });
      const added = run(rolled, { kind: "add-construction-point", point: pointOf("pt2", "Point B") });
      equal(designOf(added).features[2]!.name, "Point B", "a step made while the marker is back goes in at the marker");
      equal(designOf(added).rollbackIndex, 3, "and the marker moves past it");
      assert(added.part.constructionPoints!.find((point) => point.id === "construction-point:pt2")!.visible, "so it is shown");
    }
  }
  ,{
    name: "Double-clicking a step opens the Edit panel with its numbers, and applying an edit of a plane moves the sketches on it in one recorded project",
    run: async () => {
      let project = sketchOnPlane(withAll(), "construction-plane:p1");
      const plane = stepOf(project, "construction-plane:p1");
      const html = renderToStaticMarkup(createElement(FeatureEditDialog, { feature: plane, project, busy: false, onApply: noop, onClose: noop }));
      assert(html.includes("Plane 20") && html.includes('aria-label="Offset distance"') && html.includes("Sketches placed on this plane move with it"), "the panel names the step and offers its number");
      const box = renderToStaticMarkup(createElement(FeatureEditDialog, { feature: stepOf(project, "part-body:b1"), project, busy: false, onApply: noop, onClose: noop }));
      assert(box.includes('aria-label="Width"') && box.includes('aria-label="Height"'), "a primitive's panel uses the names of its shape");
      // The edit goes through the app's commit: the follow operation is recorded together with the edit, from the edited project.
      const calls: { intent: { kind: string }; forceReplay?: boolean; from?: WorkbenchProject }[] = [];
      const edited: DesignSolidFeature = { ...plane, reference: { kind: "plane", definition: { kind: "offset", basePlane: "datum:xy", offsetMm: 50 } } };
      const applied = await applyReferenceEdit({
        project: () => project,
        commit: (intent, _must, forceReplay, options) => { calls.push({ intent, ...(forceReplay === undefined ? {} : { forceReplay }), ...(options?.from === undefined ? {} : { from: options.from }) }); return Promise.resolve(true); },
        refuse: (message) => { throw new Error(message); }
      }, edited);
      assert(applied, "the edit is applied");
      equal(calls.length, 1, "in one commit");
      equal(calls[0]!.intent.kind, "follow-design-planes", "that moves the sketches onto the plane");
      equal(calls[0]!.forceReplay, true, "and rebuilds what is built on them");
      const from = calls[0]!.from!;
      assert(from.part.construction![0]!.definition.kind === "offset" && (from.part.construction![0]!.definition as { offsetMm: number }).offsetMm === 50, "starting from the project with the plane edited");
      // A plane with no sketch on it needs only the edit.
      project = withAll();
      const plain: typeof calls = [];
      await applyReferenceEdit({ project: () => project, commit: (intent, _must, forceReplay) => { plain.push({ intent, ...(forceReplay === undefined ? {} : { forceReplay }) }); return Promise.resolve(true); }, refuse: noop }, { ...stepOf(project, "construction-plane:p1"), reference: { kind: "plane", definition: { kind: "offset", basePlane: "datum:xy", offsetMm: 12 } } });
      equal(plain[0]!.intent.kind, "update-design-reference", "an unused plane is just replaced");
      let refused = "";
      await applyReferenceEdit({ project: () => project, commit: () => Promise.resolve(true), refuse: (message) => { refused = message; } }, { ...stepOf(project, "construction-plane:p1"), name: "Spin axis" });
      assert(refused.includes("already called"), "a refused edit says why");
    }
  },
  {
    name: "The browser rows of a stepped plane read from the step and open it on a double-click; the right-click menu of such a step has no profile sketch",
    run: () => {
      const project = withAll();
      const step = stepOf(project, "construction-plane:p1");
      const html = renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: noop, onContextMenu: noop, onOpenItem: noop, onAdoptLegacy: noop }));
      assert(html.includes(`data-tree-open-id="${step.id}"`), "the plane's row opens its step");
      assert(html.includes("20 mm from the XY plane"), "and says what the plane is");
      assert(!html.includes("not in the timeline") && !html.includes("to the timeline"), "no row says it is outside the timeline, and there is nothing to add");
      const menu = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "construction-plane:p1", selectionKind: "plane" as never, featureKind: "reference", featureState: { suppressed: false, markerAfter: false, hasSketch: false } });
      const ids = menu.map((command) => command.id);
      for (const id of ["feature.edit", "step.suppress", "step.rename", "step.roll-here", "step.delete"]) assert(ids.includes(id), `${id} is offered: ${ids.join(", ")}`);
      assert(!ids.includes("step.edit-profile"), "a construction step has no profile sketch to edit");
    }
  }
];
