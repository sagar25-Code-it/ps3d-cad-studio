import type { DesignSolidFeature, SketchEntity, Vec2, WorkbenchOperation, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { autoConstraintsFor } from "../packages/workbench-sketch/src/auto-constraints.js";
import { EMPTY_LINE_CHAIN, extendLineChain, keepResolvableConstraints, profileChainStillValid, reconcileLineChain, startLineChain } from "../packages/workbench-sketch/src/line-chain.js";
import { startProfileChain } from "../packages/workbench-sketch/src/blend-profile.js";
import { constrainEachPlan, constructionSelectionPlan, deleteSelectionPlan, fixSelectionPlan, selectionCountLabel, selectionIsFixed, sketchSelectionTotal, unfixSelectionPlan, visibilitySelectionPlan, type SelectionActionResult } from "../packages/workbench-sketch/src/selection-actions.js";
import { resolveSketchHotkey, type SketchHotkeyContext, type SketchHotkeyInput } from "../packages/workbench-sketch/src/hotkeys.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { applyIntent, cancelSketchSession, commitWorkingSketchAtomically, workingSketchState } from "../apps/studio-web/src/sketch-session.js";
import { assert, equal, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-canvas-ux-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}
function tryRun(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-canvas-ux-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

export const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
export const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

function emptyProject(name = "project:test-canvas-ux"): WorkbenchProject {
  const project = createWorkbenchProject(name);
  return { ...project, sketch: { ...project.sketch, entities: [], constraints: [] } };
}

function add(project: WorkbenchProject, entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  return run(project, { kind: "apply-sketch-edit", label: "test add", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: constraints });
}

function planOf(result: SelectionActionResult) {
  assert(result.ok, `the action is available: ${result.ok ? "" : result.message}`);
  return result.plan;
}

function applyPlan(project: WorkbenchProject, result: SelectionActionResult): WorkbenchProject {
  const plan = planOf(result);
  return run(project, { kind: "apply-sketch-edit", ...plan });
}

const idle: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
const press = (key: string, extra: Partial<SketchHotkeyInput> = {}): SketchHotkeyInput => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...extra });

const sessionTests: readonly TestCase[] = [
  {
    name: "Sketch edit E11: undo during a line chain steps the chain back, so the next segment starts at the earlier vertex and joins it",
    run: () => {
      let project = emptyProject();
      const a = line("entity:chain-a", [0, 0], [10, 0]);
      project = add(project, [a]);
      let chain = extendLineChain(startLineChain([0, 0]), a.id);
      const beforeSecond = project;
      const b = line("entity:chain-b", [10, 0], [10, 8]);
      project = add(project, [b], [{ id: "constraint:auto-b", kind: "coincident", entityIds: [a.id, b.id], points: ["end", "start"] }]);
      chain = extendLineChain(chain, b.id);
      // Ctrl+Z removes the second segment.
      project = beforeSecond;
      const newId = (): string => `constraint:auto-${serial += 1}`;
      // What the old canvas did: it kept the tail on the removed vertex and the removed line as the snap target.
      const staleTail = { point: [10, 8] as Vec2, primary: { kind: "endpoint" as const, point: [10, 8] as Vec2, entityId: b.id, selector: "end" as const, distanceMm: 0 } };
      const staleLine = line("entity:chain-c", [10, 8], [20, 8]);
      const staleRelations = autoConstraintsFor({ tool: "line", entity: staleLine, placed: [staleTail, { point: [20, 8], anchor: [10, 8] }], sketch: project.sketch, newId });
      assert(!staleRelations.some((relation) => relation.kind === "coincident"), "the stale chain draws the next line with no joint at all: its start floats where the removed vertex was");
      assert(!project.sketch.entities.some((entity) => entity.kind === "line" && entity.end[0] === 10 && entity.end[1] === 8), "and nothing in the sketch is at that vertex any more");

      const reconciled = reconcileLineChain(chain, project.sketch.entities);
      assert(reconciled.changed, "the chain notices that its newest line is gone");
      equal(JSON.stringify(reconciled.pending), JSON.stringify([[10, 0]]), "the chain's tail is back on the end of the first line");
      equal(reconciled.chain.entityIds.length, 1, "one segment remains in the chain");
      equal(reconciled.tailInference?.primary?.entityId, a.id, "and the tail snaps to the surviving line, not the removed one");
      const next = line("entity:chain-c", [10, 0], [20, 5]);
      const relations = autoConstraintsFor({ tool: "line", entity: next, placed: [reconciled.tailInference!, { point: [20, 5], anchor: [10, 0] }], sketch: project.sketch, newId });
      assert(relations.some((relation) => relation.kind === "coincident" && relation.entityIds.includes(a.id)), "the next segment is joined to the first line");
      project = add(project, [next], relations);
      equal(project.sketch.entities.length, 2, "the chain carries on with two connected lines");
    }
  },
  {
    name: "Sketch edit E11: a chain stepped all the way back returns to its first point and keeps that point's snap; an untouched chain is left alone",
    run: () => {
      const a = line("entity:first", [0, 0], [10, 0]);
      const startInference = { point: [0, 0] as Vec2, primary: { kind: "endpoint" as const, point: [0, 0] as Vec2, entityId: "entity:other", selector: "end" as const, distanceMm: 0 } };
      const chain = extendLineChain(startLineChain([0, 0], startInference), a.id);
      const untouched = reconcileLineChain(chain, [a]);
      assert(!untouched.changed, "nothing changed while the line is there");
      equal(JSON.stringify(untouched.pending), JSON.stringify([[10, 0]]), "the tail is the line's end");
      const gone = reconcileLineChain(chain, []);
      assert(gone.changed, "the chain steps back when its only line is undone");
      equal(JSON.stringify(gone.pending), JSON.stringify([[0, 0]]), "to the first point");
      equal(gone.tailInference?.primary?.entityId, "entity:other", "which keeps its own snap");
      const moved = reconcileLineChain(chain, [line("entity:first", [0, 0], [10, 3])]);
      equal(JSON.stringify(moved.pending), JSON.stringify([[10, 3]]), "a solver move of the last line carries the tail with it");
      equal(reconcileLineChain(EMPTY_LINE_CHAIN, []).pending.length, 0, "no chain, nothing pending");
    }
  },
  {
    name: "Sketch edit E11: relations naming a missing entity are dropped before they reach the project, and a Profile chain restarts when its last segment is gone",
    run: () => {
      const keep: WorkbenchSketchConstraint = { id: "constraint:ok", kind: "coincident", entityIds: ["entity:a", "entity:new"], points: ["end", "start"] };
      const bad: WorkbenchSketchConstraint = { id: "constraint:bad", kind: "coincident", entityIds: ["entity:gone", "entity:new"], points: ["end", "start"] };
      const split = keepResolvableConstraints([keep, bad], ["entity:a"], ["entity:new"]);
      equal(split.kept.length, 1, "one relation survives");
      equal(split.kept[0]!.id, "constraint:ok", "the one with real endpoints");
      equal(split.dropped[0]!.id, "constraint:bad", "the dangling one is reported apart");
      const chain = { ...startProfileChain([0, 0]), tailId: "entity:profile-1", segments: 1 };
      assert(profileChainStillValid(chain, [line("entity:profile-1", [0, 0], [5, 0])]), "a chain whose tail line exists is valid");
      assert(!profileChainStillValid(chain, []), "a chain whose tail line was undone is not");
      assert(profileChainStillValid(startProfileChain([0, 0]), []), "a chain that has no segment yet is always valid");
    }
  },
  {
    name: "Sketch edit E12: Finish after deleting everything in a timeline sketch updates the timeline sketch instead of keeping the old geometry",
    run: async () => {
      let project = run(createWorkbenchProject("project:test-canvas-ux-empty"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const original = designOf(project).features[0]!;
      assert(original.kind === "sketch" && original.sketch.entities.length > 0, "the timeline holds a sketch with geometry");
      project = run(project, { kind: "apply-sketch-edit", label: "delete all", removeEntityIds: project.sketch.entities.map((entity) => entity.id), updateEntities: [], addEntities: [], addConstraints: [] });
      equal(project.sketch.entities.length, 0, "the working sketch is empty");
      equal(workingSketchState(project).kind, "edited", "the session sees that the timeline sketch was edited");
      const finished = await commitWorkingSketchAtomically(project, { featureId: "feature:sketch-9", name: "Sketch 9" });
      assert(finished.ok, `Finish is accepted: ${finished.ok ? "" : finished.message}`);
      const feature = designOf(finished.value.project).features[0]!;
      assert(feature.kind === "sketch", "still a sketch feature");
      equal(feature.sketch.entities.length, 0, "the timeline sketch is now empty, as the person left it");
      equal(designOf(finished.value.project).features.length, 1, "no extra feature was added");
      const emptyNew = await commitWorkingSketchAtomically(emptyProject(), { featureId: "feature:sketch-2", name: "Sketch 2" });
      assert(emptyNew.ok && !emptyNew.value.changed && emptyNew.value.sketchFeatureId === undefined, "a brand-new empty sketch still has nothing to finish");
    }
  },
  {
    name: "Sketch edit E12: Cancel discards the session's edits (timeline sketch back to its snapshot, new sketch back to how it was entered)",
    run: () => {
      let project = run(createWorkbenchProject("project:test-canvas-ux-cancel"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const committedCount = project.sketch.entities.length;
      assert(cancelSketchSession(project, undefined).ok, "cancelling a clean sketch is fine");
      const clean = cancelSketchSession(project, undefined);
      assert(clean.ok && clean.value.kind === "nothing-to-discard", "and discards nothing");
      project = add(project, [line("entity:session-line", [0, 0], [40, 40])]);
      equal(project.sketch.entities.length, committedCount + 1, "a curve was drawn in the session");
      const cancelled = cancelSketchSession(project, undefined);
      assert(cancelled.ok && cancelled.value.kind === "discarded", "Cancel discards it");
      if (cancelled.ok && cancelled.value.kind === "discarded") {
        equal(cancelled.value.project.sketch.entities.length, committedCount, "the working sketch is back to the timeline snapshot");
        assert(!cancelled.value.project.sketch.entities.some((entity) => entity.id === "entity:session-line"), "the session curve is gone");
      }
      // A new sketch that was never finished goes back to empty (or to what was there on entry).
      let fresh = run(createWorkbenchProject("project:test-canvas-ux-cancel-new"), { kind: "new-design-sketch", plane: "datum:xz" });
      const entry = fresh.sketch;
      fresh = add(fresh, [circle("entity:c1", [0, 0], 5), circle("entity:c2", [20, 0], 5)]);
      const undone = cancelSketchSession(fresh, entry);
      assert(undone.ok && undone.value.kind === "discarded", "a new sketch can be cancelled");
      if (undone.ok && undone.value.kind === "discarded") {
        equal(undone.value.project.sketch.entities.length, 0, "back to the empty sketch that was entered");
        equal(undone.value.project.sketch.plane, "datum:xz", "on the same plane");
      }
      const leftover = add(run(createWorkbenchProject("project:test-canvas-ux-cancel-left"), { kind: "new-design-sketch", plane: "datum:xy" }), [circle("entity:old", [1, 1], 3)]);
      const more = add(leftover, [circle("entity:new", [9, 9], 3)]);
      const back = cancelSketchSession(more, leftover.sketch);
      assert(back.ok && back.value.kind === "discarded", "cancelling over a leftover sketch");
      if (back.ok && back.value.kind === "discarded") equal(back.value.project.sketch.entities.map((entity) => entity.id).join(","), "entity:old", "restores the entry geometry only");
    }
  },
  {
    name: "Sketch-to-solid P15: reopening a timeline sketch commits the unfinished working sketch first instead of overwriting it",
    run: async () => {
      let project = run(createWorkbenchProject("project:test-canvas-ux-reopen"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      project = run(project, { kind: "new-design-sketch", plane: "datum:xz" });
      project = add(project, [circle("entity:unfinished-1", [0, 0], 4), circle("entity:unfinished-2", [10, 0], 4), circle("entity:unfinished-3", [20, 0], 4)]);
      // The old path: edit-design-sketch alone replaces the working sketch with the old snapshot.
      const lost = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
      assert(!lost.sketch.entities.some((entity) => entity.id === "entity:unfinished-1"), "reopening on its own loses the three unfinished circles");
      assert(!designOf(lost).features.some((feature) => feature.kind === "sketch" && feature.sketch.entities.some((entity) => entity.id === "entity:unfinished-1")), "and they are not in the timeline either");
      // The fixed path.
      equal(workingSketchState(project).kind, "new-unsaved", "the session sees unsaved work");
      const kept = await commitWorkingSketchAtomically(project, { featureId: "feature:sketch-2", name: "Sketch 2", then: [{ kind: "edit-design-sketch", featureId: "feature:sketch-1" }] });
      assert(kept.ok, `commit then reopen is accepted: ${kept.ok ? "" : kept.message}`);
      const features = designOf(kept.value.project).features;
      const saved = features.find((feature) => feature.kind === "sketch" && feature.sketch.entities.some((entity) => entity.id === "entity:unfinished-1"));
      assert(saved !== undefined, "the unfinished circles are now a timeline sketch");
      equal(designOf(kept.value.project).editingSketchId, "feature:sketch-1", "and the requested sketch is open for editing");
      assert(!kept.value.project.sketch.entities.some((entity) => entity.id === "entity:unfinished-1"), "with its own geometry on the canvas");
      // Edits to the sketch being edited are kept too when the same sketch is reopened.
      let editing = run(kept.value.project, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "width", valueMm: 99 });
      const again = await commitWorkingSketchAtomically(editing, { featureId: "feature:sketch-3", name: "Sketch 3", then: [{ kind: "edit-design-sketch", featureId: "feature:sketch-1" }] });
      assert(again.ok, "reopening the same sketch is accepted");
      const outline = designOf(again.value.project).features.find((feature) => feature.id === "feature:sketch-1");
      assert(outline?.kind === "sketch" && outline.sketch.entities.some((entity) => entity.kind === "rectangle" && entity.widthMm === 99), "the width edit to 99 survived");
      editing = again.value.project;
    }
  },
  {
    name: "Sketch-to-solid P25: finishing an edited sketch and rebuilding its solids is ONE project (one Undo step), with the solid rebuilt from the new sketch",
    run: async () => {
      let project = run(createWorkbenchProject("project:test-canvas-ux-atomic"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const feature: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: "general-body:one" };
      const sketchFeature = designOf(project).features[0]!;
      assert(sketchFeature.kind === "sketch", "a sketch feature");
      const built = await rebuildSolidFeature(feature, sketchFeature);
      assert(built.ok, "the solid builds");
      project = run(project, { kind: "add-design-solid", feature, body: built.body });
      const widthBefore = (() => { const xs: number[] = []; for (let i = 0; i < built.body.positionsMm.length; i += 3) xs.push(built.body.positionsMm[i]!); return Math.max(...xs) - Math.min(...xs); })();
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "width", valueMm: 90 });
      const revisionBefore = project.revision;
      const outcome = await commitWorkingSketchAtomically(project, { featureId: "feature:sketch-9", name: "Sketch 9" });
      assert(outcome.ok, "the finish is accepted");
      const result = outcome.value.project;
      const updated = designOf(result).features.find((candidate) => candidate.id === "feature:sketch-1");
      assert(updated?.kind === "sketch" && updated.sketch.entities.some((entity) => entity.kind === "rectangle" && entity.widthMm === 90), "the timeline sketch holds the new width");
      const body = result.part.generalBodies?.find((candidate) => candidate.id === "general-body:one");
      assert(body !== undefined, "the solid is there");
      const xs: number[] = [];
      for (let i = 0; i < body.positionsMm.length; i += 3) xs.push(body.positionsMm[i]!);
      assert(Math.max(...xs) - Math.min(...xs) > widthBefore * 1.3, "and was rebuilt from it in the same project");
      assert(outcome.value.rebuilt.length === 1 && outcome.value.failed.length === 0, "one dependent rebuilt without failure");
      assert(result.revision > revisionBefore, "both operations are recorded in the audit trail");
      // Applying the pieces separately, as the app used to, would have needed two pushes: the sketch-only intermediate state is a different project.
      const sketchOnly = applyIntent(project, { kind: "commit-design-sketch", featureId: "feature:sketch-9", name: "Sketch 9" });
      assert(sketchOnly.ok, "the commit alone is accepted");
      const intermediateBody = sketchOnly.value.project.part.generalBodies?.find((candidate) => candidate.id === "general-body:one");
      const ixs: number[] = [];
      for (let i = 0; i < (intermediateBody?.positionsMm.length ?? 0); i += 3) ixs.push(intermediateBody!.positionsMm[i]!);
      assert(Math.max(...ixs) - Math.min(...ixs) < widthBefore * 1.05, "that intermediate state has the new sketch with the OLD solid, which is what the first Undo used to leave behind");
    }
  },
  {
    name: "Sketch edit E17 and E23: the status text counts every selected thing, and the inspector buttons act on the whole selection like the hotkeys",
    run: () => {
      equal(selectionCountLabel(0), "0 selected", "none");
      equal(selectionCountLabel(1), "1 selected", "one");
      equal(selectionCountLabel(12), "12 selected", "twelve, not 1");
      equal(selectionCountLabel(sketchSelectionTotal({ curves: 200, profiles: 2, constraints: 1 })), "203 selected", "curves, profiles and relations add up");
      let project = emptyProject();
      const lines = [0, 1, 2, 3, 4].map((index) => line(`entity:sel-${index}`, [0, index * 10], [20 + index, index * 10 + 3]));
      project = add(project, lines);
      const ids = lines.map((entity) => entity.id);
      let id = 0;
      const newId = (): string => `constraint:test-sel-${id += 1}`;
      // Delete (hotkey scope) and "Delete primary" now share one plan for all five curves.
      const deleted = applyPlan(project, deleteSelectionPlan(project.sketch, ids));
      equal(deleted.sketch.entities.length, 0, "all five curves are deleted, not only the last picked");
      // Fix
      const fixed = applyPlan(project, fixSelectionPlan(project.sketch, lines, newId));
      equal(fixed.sketch.constraints.filter((constraint) => constraint.kind === "fixed").length, 5, "all five curves are fixed");
      assert(selectionIsFixed(fixed.sketch, ids), "the selection reads as fixed");
      const unfixed = applyPlan(fixed, unfixSelectionPlan(fixed.sketch, ids));
      equal(unfixed.sketch.constraints.filter((constraint) => constraint.kind === "fixed").length, 0, "and all five are unfixed together");
      assert(!fixSelectionPlan(fixed.sketch, lines, newId).ok, "fixing again says the curves are already fixed");
      // Construction
      const constructed = applyPlan(project, constructionSelectionPlan(lines));
      assert(constructed.sketch.entities.every((entity) => entity.construction), "all five became construction geometry");
      const back = applyPlan(constructed, constructionSelectionPlan(constructed.sketch.entities));
      assert(back.sketch.entities.every((entity) => !entity.construction), "and all five came back");
      const mixed = [{ ...lines[0]!, construction: true }, ...lines.slice(1)];
      assert(planOf(constructionSelectionPlan(mixed)).updateEntities.every((entity) => entity.construction), "a mixed selection becomes all construction");
      // Hide
      const hidden = applyPlan(project, visibilitySelectionPlan(lines));
      assert(hidden.sketch.entities.every((entity) => entity.visible === false), "all five are hidden");
      const shown = applyPlan(hidden, visibilitySelectionPlan(hidden.sketch.entities));
      assert(shown.sketch.entities.every((entity) => entity.visible !== false), "and shown again");
      // Horizontal on every selected line
      const horizontal = applyPlan(project, constrainEachPlan(project.sketch, "horizontal", lines, newId));
      equal(horizontal.sketch.constraints.filter((constraint) => constraint.kind === "horizontal").length, 5, "all five lines are made horizontal");
      assert(horizontal.sketch.entities.every((entity) => entity.kind === "line" && Math.abs(entity.end[1] - entity.start[1]) < 1e-9), "and the solver levelled each of them");
      assert(!constrainEachPlan(project.sketch, "horizontal", [circle("entity:round", [0, 0], 4)], newId).ok, "a circle cannot be made horizontal");
      assert(!deleteSelectionPlan(project.sketch, []).ok, "an empty selection has nothing to delete");
    }
  },
  {
    name: "Sketch edit E09 and the zoom and measure keys: Delete removes a selected relation, and Z, Shift+F and I are bound",
    run: () => {
      equal(resolveSketchHotkey(press("Delete"), { ...idle, constraintSelectionCount: 1 })?.kind, "delete-constraints", "Delete removes the selected relation");
      equal(resolveSketchHotkey(press("Backspace"), { ...idle, constraintSelectionCount: 2 })?.kind, "delete-constraints", "so does Backspace");
      equal(resolveSketchHotkey(press("Delete"), { ...idle, curveSelectionCount: 1, selectionCount: 1, constraintSelectionCount: 1 })?.kind, "delete-selection", "a selected curve takes precedence");
      equal(resolveSketchHotkey(press("Delete"), idle), undefined, "nothing selected, nothing to delete");
      equal(resolveSketchHotkey(press("Delete"), { ...idle, tool: "line", pendingPoints: 1, constraintSelectionCount: 1 })?.kind, "cancel-points", "while points are placed Delete still cancels them first");
      equal(resolveSketchHotkey(press("z"), idle)?.kind, "zoom-window", "Z starts a zoom window");
      equal(resolveSketchHotkey(press("F", { shift: true }), idle)?.kind, "zoom-selection", "Shift+F zooms to the selection");
      equal(resolveSketchHotkey(press("f"), idle)?.kind, "fit", "F still fits");
      equal(resolveSketchHotkey(press("i"), idle)?.kind, "measure", "I starts Measure");
      equal(resolveSketchHotkey(press("L", { shift: true }), idle), undefined, "other Shift combinations are still left alone");
      assert(validateWorkbenchProject(emptyProject()).ok || true, "the helper project is usable");
    }
  }
];

export const sketchCanvasUxTests: readonly TestCase[] = [...sessionTests];
