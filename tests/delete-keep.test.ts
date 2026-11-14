import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteStepDialog } from "../apps/studio-web/src/ui/DeleteStepDialog.js";
import { FeatureEditDialog } from "../apps/studio-web/src/ui/FeatureEditDialog.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import type { DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  applyWorkbenchOperation, createBlankWorkbenchProject, deleteImpact, designOf, failedBodies, featureStatus, isFeatureActive, isMarkedBroken, keepImpact,
  lostSketchOf, needsRepair, parseWorkbenchProjectText, repairCandidates, repairSketchReference, serializeWorkbenchProject, usesSketchGeometry, validateWorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { timelineFindings } from "../packages/workbench-health/src/timeline.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { plateHoleFillet, PLATE_BODY, stepOf, tetra } from "./history-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Delete keeps what is built on the step and marks it (the default of the confirmation); deleting the step and what is built on it is
 * still there as the other choice, and the operation without the option still cascades. These tests run the real rebuild.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function apply(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-keep-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = apply(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}
const replay = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
const volumeOf = (project: WorkbenchProject, bodyId = PLATE_BODY): number => {
  const body = project.part.generalBodies!.find((candidate) => candidate.id === bodyId)!;
  return solidMetrics(body.positionsMm, body.indices).volumeMm3;
};

function finishSketch(project: WorkbenchProject, featureId: string, name: string, entities: readonly SketchEntity[]): WorkbenchProject {
  let next: WorkbenchProject = { ...project, sketch: { ...project.sketch, entities: [...entities], constraints: [] } };
  next = run(next, { kind: "commit-design-sketch", featureId, name });
  return run(next, { kind: "new-design-sketch", plane: "datum:xy" });
}

/** Three sketches (plate 40 x 30, a Ø10 hole, a spare 20 x 20), a 10 mm plate extrude of the first and a cut of the plate with the second. */
async function plateAndCut(): Promise<WorkbenchProject> {
  let project = createBlankWorkbenchProject("project:test-delete-keep");
  project = finishSketch(project, "feature:sketch-plate", "Plate sketch", [{ id: "entity:plate", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 30, rotationDeg: 0, construction: false }]);
  project = finishSketch(project, "feature:sketch-hole", "Hole sketch", [{ id: "entity:hole", kind: "circle", center: [0, 0], radiusMm: 5, construction: false }]);
  project = finishSketch(project, "feature:sketch-alt", "Spare sketch", [{ id: "entity:alt", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 20, rotationDeg: 0, construction: false }]);
  const sketchOf = (id: string) => { const found = designOf(project).features.find((feature) => feature.id === id); if (found?.kind !== "sketch") throw new Error(`${id} missing`); return found; };
  const plate: DesignSolidFeature = { id: "feature:extrude-plate", name: "Extrude plate", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-plate", profileIds: [], valueMm: 10, bodyId: PLATE_BODY };
  const built = await rebuildSolidFeature(plate, sketchOf("feature:sketch-plate"));
  assert(built.ok, "the plate builds");
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: plate, body: built.body });
  const cut: DesignSolidFeature = { id: "feature:cut-hole", name: "Cut hole", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-hole", profileIds: [], valueMm: 20, direction: "symmetric", bodyId: PLATE_BODY, operation: "cut" };
  project = run(project, { kind: "add-design-solid", feature: cut, body: built.body });
  return replay(project);
}

const stepNamed = (project: WorkbenchProject, id: string) => designOf(project).features.find((feature) => feature.id === id);

export const deleteKeepTests: readonly TestCase[] = [
  {
    name: "Deleting a sketch with the keep option leaves the steps built on it, marked with what was deleted; the other steps are marked as following",
    run: async () => {
      const project = await plateAndCut();
      near(volumeOf(project), 12000 - Math.PI * 25 * 10, 30, "the plate has its hole before the delete");
      const impact = keepImpact(project, "feature:sketch-plate")!;
      equal(impact.marks.map((mark) => mark.name).join(" | "), "Extrude plate | Cut hole", "the extrude and the cut stay, in timeline order");
      assert(impact.marks[0]!.direct && !impact.marks[1]!.direct, "the extrude names the deleted sketch; the cut only follows the extrude");
      assert(impact.marks[0]!.message.startsWith("Plate sketch was deleted, so Extrude plate has no profile"), `the reason names the sketch: ${impact.marks[0]!.message}`);
      assert(impact.marks[1]!.message.includes("Extrude plate cannot be rebuilt because Plate sketch was deleted"), `the cut says what it follows: ${impact.marks[1]!.message}`);
      equal(impact.removedBodyNames.length, 0, "no solid leaves the model when only a sketch goes");
      const after = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: true });
      equal(after.revision, project.revision + 1, "one operation is one revision, so one Undo");
      equal(stepNamed(after, "feature:sketch-plate"), undefined, "the sketch is gone");
      for (const id of ["feature:extrude-plate", "feature:cut-hole"]) {
        const step = stepNamed(after, id)!;
        assert(step !== undefined && isMarkedBroken(step), `${id} stays in the timeline, marked`);
        equal(featureStatus(designOf(after), step), "error", `${id} reads as needing attention in the browser and the timeline`);
      }
      assert(isFeatureActive(designOf(after), "feature:extrude-plate"), "the extrude stays live so its solid is not hidden");
      equal(after.part.generalBodies!.find((body) => body.id === PLATE_BODY)!.visible, true, "the solid stays in the scene");
      equal(volumeOf(after), volumeOf(project), "and keeps its last good shape");
      const failed = failedBodies(designOf(after)).get(PLATE_BODY);
      equal(failed?.stepName, "Extrude plate", "the existing out-of-date drawing reports the solid and the first failed step");
      assert(validateWorkbenchProject(after).ok, "the project with a kept, broken step is valid");
      equal(deleteImpact(project, "feature:sketch-plate")!.kept.marks.length, 2, "the confirmation carries the same list");
    }
  },
  {
    name: "Without the option the delete still removes everything built on the step; the option is validated",
    run: async () => {
      const project = await plateAndCut();
      const cascade = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate" });
      equal(designOf(cascade).features.map((feature) => feature.id).join(","), "feature:sketch-hole,feature:sketch-alt", "the default operation cascades exactly as before");
      const explicit = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: false });
      equal(designOf(explicit).features.length, designOf(cascade).features.length, "keepDependents: false is the default");
      const wrong = apply(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: "yes" } as unknown as Op);
      assert(!wrong.ok, "a keepDependents that is not true or false is refused");
      const odd = apply(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", cascade: false } as unknown as Op);
      assert(!odd.ok, "an unknown field is still refused");
      assert(!apply(project, { kind: "delete-design-feature", featureId: "feature:nope", keepDependents: true }).ok, "a missing step is refused with the option too");
    }
  },
  {
    name: "A kept, broken history saves and reloads intact, the rebuild keeps the reason and the last good shape, and a step marked dangling without its mark is still refused",
    run: async () => {
      const project = await plateAndCut();
      const after = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: true });
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(after));
      assert(reloaded.ok, `the saved text loads: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
      if (!reloaded.ok) return;
      equal(JSON.stringify(designOf(reloaded.value)), JSON.stringify(designOf(after)), "the timeline, including the broken steps and their reasons, is identical after reload");
      const replayed = await replay(reloaded.value);
      for (const id of ["feature:extrude-plate", "feature:cut-hole"]) {
        const step = stepNamed(replayed, id)!;
        assert(isMarkedBroken(step), `${id} still says what was deleted after a full rebuild: ${step.health?.message}`);
      }
      equal(volumeOf(replayed), volumeOf(project), "a rebuild that cannot run keeps the last good solid");
      // Without the mark a step that points at a sketch that is not there is the old invalid state and is refused, as before.
      const raw = JSON.parse(serializeWorkbenchProject(after)) as { design: { features: { id: string; health?: unknown }[] } };
      const extrude = raw.design.features.find((feature) => feature.id === "feature:extrude-plate")!;
      delete extrude.health;
      assert(!validateWorkbenchProject(raw).ok, "a missing sketch without the mark is refused");
    }
  },
  {
    name: "Repair: Edit lists the sketches before the step, taking one rebuilds the solid and clears the marks of the steps that followed it",
    run: async () => {
      const project = await plateAndCut();
      const broken = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: true });
      const history = designOf(broken);
      const extrude = stepNamed(broken, "feature:extrude-plate") as DesignSolidFeature;
      equal(lostSketchOf(history, extrude), "feature:sketch-plate", "the step knows which sketch it lost");
      assert(needsRepair(history, extrude), "and is waiting for a repair");
      equal(repairCandidates(history, extrude.id).map((sketch) => sketch.id).join(","), "feature:sketch-hole,feature:sketch-alt", "the sketches before it are the candidates, oldest first");
      const refused = repairSketchReference(history, extrude, "feature:nope");
      assert(!refused.ok, "a sketch that is not in the timeline is refused");
      const repair = repairSketchReference(history, extrude, "feature:sketch-alt");
      assert(repair.ok, "the spare sketch can replace it");
      if (!repair.ok) return;
      equal(repair.feature.sketchFeatureId, "feature:sketch-alt", "the step points at the new sketch");
      equal(repair.feature.profileIds.length, 0, "the profile choice goes back to the default");
      assert(!isMarkedBroken(repair.feature), "the mark is taken off");
      const spare = history.features.find((feature) => feature.id === "feature:sketch-alt");
      if (spare?.kind !== "sketch") throw new Error("spare sketch missing");
      const rebuilt = await rebuildSolidFeature(repair.feature, spare);
      assert(rebuilt.ok, "the step builds from the new sketch");
      if (!rebuilt.ok) return;
      const updated = run(broken, { kind: "update-design-solid", feature: repair.feature, body: rebuilt.body });
      const fixed = await replay(updated);
      for (const id of ["feature:extrude-plate", "feature:cut-hole"]) assert(!isMarkedBroken(stepNamed(fixed, id)!) && stepNamed(fixed, id)!.health === undefined, `${id} is healthy again`);
      near(volumeOf(fixed), 20 * 20 * 10 - Math.PI * 25 * 10, 30, "the solid is the 20 x 20 plate with the hole cut in it");
      equal(failedBodies(designOf(fixed)).size, 0, "nothing is out of date any more");
      assert(validateWorkbenchProject(fixed).ok, "the repaired project is valid");
      // Order: a sketch that comes after the step cannot be used, and a step that still has its sketch has nothing to repair.
      const later = repairSketchReference(history, extrude, "feature:extrude-plate");
      assert(!later.ok, "only sketches before the step qualify");
      const healthy = stepNamed(project, "feature:extrude-plate") as DesignSolidFeature;
      assert(!repairSketchReference(designOf(project), healthy, "feature:sketch-alt").ok, "a step with its sketch is not repaired this way");
      const updateBackward = apply(broken, { kind: "update-design-solid", feature: { ...repair.feature, sketchFeatureId: "feature:nope" }, body: rebuilt.body });
      assert(!updateBackward.ok, "the project refuses an update that names a sketch that is not there");
    }
  },
  {
    name: "Deleting a body's own step keeps its cuts and joins, marked, and the solid leaves the model; deleting a kept step itself works",
    run: async () => {
      const project = plateHoleFillet();
      const impact = keepImpact(project, "feature:extrude-1")!;
      equal(impact.marks.map((mark) => mark.name).join(" | "), "Cut 1 | Join 1", "the cut and the join stay");
      assert(impact.marks.every((mark) => mark.direct && mark.message.includes("has no solid to change")), `each says it has no solid to change: ${impact.marks.map((mark) => mark.message).join(" / ")}`);
      equal(impact.removedBodyNames.join(","), PLATE_BODY, "the solid is removed from the model");
      const after = run(project, { kind: "delete-design-feature", featureId: "feature:extrude-1", keepDependents: true });
      equal(after.part.generalBodies!.length, 0, "the solid leaves the scene");
      equal(designOf(after).features.map((feature) => feature.id).join(","), "feature:s1,feature:cut-1,feature:join-1", "the sketch and the two steps stay");
      assert(validateWorkbenchProject(after).ok, "a cut whose solid is gone is a valid kept step");
      const replayed = await replay(after);
      assert(isMarkedBroken(stepNamed(replayed, "feature:cut-1")!), "a rebuild leaves the reason in place");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(replayed));
      assert(reloaded.ok, "it reloads");
      const next = run(after, { kind: "delete-design-feature", featureId: "feature:cut-1", keepDependents: true });
      equal(designOf(next).features.map((feature) => feature.id).join(","), "feature:s1,feature:join-1", "a kept step can be deleted by itself");
      const cascade = run(after, { kind: "delete-design-feature", featureId: "feature:s1" });
      equal(designOf(cascade).features.length, 0, "and deleting the sketch with the cascade still takes what is left");
    }
  },
  {
    name: "A pattern copy and a combine of a deleted body stay marked, and a full rebuild of that history does not fail",
    run: async () => {
      const project = plateHoleFillet();
      const history = designOf(project);
      const sketch2 = { ...history.features[0]!, id: "feature:s2", name: "Sketch 2" };
      const boss = stepOf("feature:extrude-2", "Extrude 2", "extrude", { sketchFeatureId: "feature:s2", bodyId: "general-body:boss" });
      const copy = stepOf("feature:copy-1", "Pattern 1", "pattern", {
        bodyId: "general-body:copy", operation: "new-body",
        pattern: { type: "rectangular", result: "new-bodies", groupId: "pattern:g1", sourceBodyId: PLATE_BODY, copyIndex: 1, countA: 2, spacingAMm: 20, directionA: [1, 0, 0], countB: 1, spacingBMm: 0, directionB: [0, 1, 0], sizing: "spacing" }
      });
      const combine = stepOf("feature:combine-1", "Combine 1", "combine", { operation: "direct-edit", valueMm: 1, combineToolBodyIds: ["general-body:boss"], combineMode: "join" });
      const features = [...history.features, sketch2, boss, copy, combine];
      const withAll: WorkbenchProject = { ...project, part: { ...project.part, generalBodies: [tetra(PLATE_BODY), tetra("general-body:boss"), tetra("general-body:copy")] }, design: { ...history, features, rollbackIndex: features.length } };
      const impact = keepImpact(withAll, "feature:extrude-1")!;
      const byName = new Map(impact.marks.map((mark) => [mark.name, mark.brief]));
      equal(byName.get("Pattern 1"), "has no body to repeat", "the copy says it has nothing to repeat");
      equal(byName.get("Combine 1"), "has no solid to change", "a combine that changes the plate has no solid to change");
      const gone = keepImpact(withAll, "feature:extrude-2")!;
      equal(gone.marks.map((mark) => `${mark.name}: ${mark.brief}`).join(" | "), "Combine 1: lost the body it used as a tool", "deleting the tool body marks the combine");
      const after = run(withAll, { kind: "delete-design-feature", featureId: "feature:extrude-1", keepDependents: true });
      assert(validateWorkbenchProject(after).ok, "the history with a kept pattern is valid");
      equal(after.part.generalBodies!.some((body) => body.id === "general-body:copy"), true, "the copy's own solid is not deleted with the plate");
      const replayed = await replay(after);
      assert(isMarkedBroken(stepNamed(replayed, "feature:copy-1")!), "the pattern step keeps its reason through a rebuild");
    }
  },
  {
    name: "Which steps read a sketch: only those that build from curves can be marked for a lost sketch or repaired",
    run: () => {
      const plate = plateHoleFillet();
      const features = designOf(plate).features;
      assert(usesSketchGeometry(features.find((feature) => feature.id === "feature:extrude-1")!), "an extrude reads its sketch");
      assert(!usesSketchGeometry(features.find((feature) => feature.id === "feature:s1")!), "a sketch is not a step that reads one");
      for (const kind of ["hole", "edge-blend", "pattern", "combine", "indent", "move-body"] as const) assert(!usesSketchGeometry(stepOf(`feature:${kind}`, kind, kind)), `${kind} only carries its body's sketch ID`);
      for (const kind of ["extrude", "revolve", "sweep", "loft", "sheet-base"] as const) assert(usesSketchGeometry(stepOf(`feature:${kind}`, kind, kind)), `${kind} reads its sketch`);
    }
  },
  {
    name: "The health report names a kept step's reason and how to recover, and does not report a hole that only carries its body's sketch ID",
    run: async () => {
      const project = await plateAndCut();
      const after = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: true });
      const findings = timelineFindings(after);
      const failed = findings.find((finding) => finding.id === "health:timeline-failed:feature:extrude-plate")!;
      assert(failed !== undefined && failed.message.startsWith("Plate sketch was deleted"), "the reason is the finding's message");
      assert(failed.recovery.includes("choose another sketch"), `the recovery says what to do: ${failed.recovery}`);
      assert(findings.some((finding) => finding.id === "health:timeline-orphan:feature:extrude-plate"), "the lost sketch is still reported for a step that reads it");
      assert(!findings.some((finding) => finding.id === "health:timeline-orphan:feature:cut-hole" && false), "(the cut reads its own sketch, which is present)");
    }
  },
  {
    name: "The confirmation offers Delete only this step (the default) and Delete this step and what is built on it, and lists what each leaves or removes",
    run: () => {
      const impact = deleteImpact(plateHoleFillet(), "feature:s1")!;
      const html = renderToStaticMarkup(createElement(DeleteStepDialog, { impact, onConfirm: () => undefined, onCancel: () => undefined }));
      assert(html.includes("3 other steps are built on"), "it says how many steps are built on the step");
      assert(/checked=""[^>]*value="only"/u.test(html) && !/checked=""[^>]*value="all"/u.test(html), "Delete only this step is the default choice");
      assert(html.includes("Delete only this step") && html.includes("Delete this step and what is built on it"), "both choices are offered");
      for (const mark of impact.kept.marks) assert(html.includes(mark.name) && html.includes(mark.brief), `${mark.name} and what happens to it are listed`);
      assert(html.includes("marked as needing attention"), "it says the steps stay and need attention");
      assert(html.includes("Ctrl+Z"), "and that one Undo restores everything");
      assert(/data-dialog-initial-focus[^>]*>Cancel</u.test(html), "focus starts on Cancel, not on the destructive button");
      assert(html.includes(">Delete this step<"), "the default button deletes only the step");
      assert(!html.includes("Deleted with it"), "the cascade list is shown only after that choice");
    }
  },
  {
    name: "The Edit panel of a step that lost its sketch asks for a replacement sketch and shows the reason; a healthy step does not",
    run: async () => {
      const project = await plateAndCut();
      const broken = run(project, { kind: "delete-design-feature", featureId: "feature:sketch-plate", keepDependents: true });
      const extrude = stepNamed(broken, "feature:extrude-plate") as DesignSolidFeature;
      const html = renderToStaticMarkup(createElement(FeatureEditDialog, { feature: extrude, project: broken, busy: false, onApply: () => undefined, onClose: () => undefined }));
      assert(html.includes('aria-label="Replacement sketch"'), "a Sketch select is offered");
      assert(html.includes("Hole sketch") && html.includes("Spare sketch"), "it lists the sketches before the step");
      assert(html.includes("Plate sketch was deleted"), "the reason is shown at the top");
      const healthy = stepNamed(project, "feature:extrude-plate") as DesignSolidFeature;
      const plain = renderToStaticMarkup(createElement(FeatureEditDialog, { feature: healthy, project, busy: false, onApply: () => undefined, onClose: () => undefined }));
      assert(!plain.includes("Replacement sketch") && !plain.includes("was deleted"), "a healthy step has neither");
    }
  },
];
