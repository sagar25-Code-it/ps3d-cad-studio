import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineBar, TimelineMenu } from "../apps/studio-web/src/ui/TimelineBar.js";
import { dragHasStarted, dropIndexFor, edgeScroll, keyboardMoveTarget } from "../apps/studio-web/src/ui/timeline-drag.js";
import { designOf, moveDesignFeature, reorderProblem, reorderTargets, stepNeeds, validateWorkbenchProject, type DesignFeature, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyOp, plateHoleFillet, refusedOp, stepOf, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-03: a step can be moved to another place in the timeline, unless something would then come before what it is built on. */

const BOSS = "general-body:boss";

const order = (project: WorkbenchProject): string => designOf(project).features.map((feature) => feature.id.replace("feature:", "")).join(",");

/** s1, extrude-1 (plate), cut-1, join-1 (both on the plate), then s2, extrude-2 (a boss of its own) and a combine that takes the boss as a tool. */
function twoBodies(): WorkbenchProject {
  const project = plateHoleFillet();
  const history = designOf(project);
  const sketch2: DesignFeature = { ...history.features[0]!, id: "feature:s2", name: "Sketch 2" };
  const boss = stepOf("feature:extrude-2", "Extrude 2", "extrude", { sketchFeatureId: "feature:s2", bodyId: BOSS });
  const combine = stepOf("feature:combine-1", "Combine 1", "combine", { operation: "direct-edit", valueMm: 1, combineToolBodyIds: [BOSS], combineMode: "join" });
  const features = [...history.features, sketch2, boss, combine];
  return { ...project, part: { ...project.part, generalBodies: [tetra("general-body:plate"), tetra(BOSS)] }, design: { ...history, features, rollbackIndex: features.length } };
}

const move = (project: WorkbenchProject, id: string, toIndex: number): WorkbenchProject => applyOp(project, { kind: "move-design-feature", featureId: `feature:${id}`, toIndex });
const refused = (project: WorkbenchProject, id: string, toIndex: number): string => refusedOp(project, { kind: "move-design-feature", featureId: `feature:${id}`, toIndex });

export const designReorderTests: readonly TestCase[] = [
  {
    name: "Two independent steps swap, and the moved history is still a valid saved project",
    run: () => {
      const project = twoBodies();
      equal(order(project), "s1,extrude-1,cut-1,join-1,s2,extrude-2,combine-1", "the starting order");
      // The cut and the join both change the plate and do not depend on each other.
      const swapped = move(project, "join-1", 2);
      equal(order(swapped), "s1,extrude-1,join-1,cut-1,s2,extrude-2,combine-1", "the join now comes before the cut");
      equal(designOf(swapped).rollbackIndex, 7, "a project that was not rolled back stays at the end");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(swapped))) !== undefined, "the moved history saves and loads");
      // A whole second body (its sketch and its extrude) can move ahead of the plate's steps.
      const sketchFirst = move(project, "s2", 0);
      equal(order(sketchFirst), "s2,s1,extrude-1,cut-1,join-1,extrude-2,combine-1", "Sketch 2 can come first");
    }
  },
  {
    name: "A step cannot move before the sketch it is built on, and the sketch cannot move after the step built on it; the refusal names both",
    run: () => {
      const project = twoBodies();
      const early = refused(project, "extrude-1", 0);
      assert(early.includes("Extrude 1") && early.includes("Sketch") && early.includes("is built on"), `names the step and the sketch it is built on: ${early}`);
      const late = refused(project, "s1", 2);
      assert(late.includes("Extrude 1") && late.includes("is built on"), `the sketch cannot pass the extrude built on it: ${late}`);
      // The refused move changed nothing.
      equal(order(project), "s1,extrude-1,cut-1,join-1,s2,extrude-2,combine-1", "the history is as it was");
    }
  },
  {
    name: "A cut or join cannot move before the step that made its body, and that step cannot move after its cut",
    run: () => {
      const project = twoBodies();
      const before = refused(project, "cut-1", 1);
      assert(before.includes("Cut 1") && before.includes("Extrude 1") && before.includes("changes the body made by"), `the cut stays after the plate's own step: ${before}`);
      const after = refused(project, "extrude-1", 2);
      assert(after.includes("Extrude 1") && after.includes("Cut 1"), `the plate cannot be made after its cut: ${after}`);
    }
  },
  {
    name: "A combine cannot move before the step that made its tool body; a body used as a tool cannot move after the combine",
    run: () => {
      const project = twoBodies();
      assert(refused(project, "combine-1", 5).includes("Extrude 2"), "the combine names the tool body's step");
      assert(refused(project, "extrude-2", 6).includes("Combine 1"), "the boss step names the combine that uses it");
      const needs = stepNeeds(designOf(project), designOf(project).features[6]!);
      equal(needs.map((need) => need.id).sort().join(","), "feature:extrude-1,feature:extrude-2,feature:s1", "a combine needs its sketch, the step that made its body and the step that made its tool body");
    }
  },
  {
    name: "A sketch drawn on a face of a body stays after the steps that body had then, and sketches on planes are free to move",
    run: () => {
      const project = plateHoleFillet();
      const history = designOf(project);
      const faceSketch = history.features[0]!;
      assert(faceSketch.kind === "sketch", "the first step is a sketch");
      const sketchOnFace: DesignFeature = { ...faceSketch, id: "feature:s2", name: "Sketch 2", sketch: { ...faceSketch.sketch, planeFace: { bodyId: "general-body:plate", faceKey: "k", faceRole: "top", axis: "z", outwardPositive: true, coordinateMm: 6, areaMm2: 100 } } };
      const boss = stepOf("feature:extrude-2", "Extrude 2", "extrude", { sketchFeatureId: "feature:s2", bodyId: BOSS });
      // s1, extrude-1, cut-1, join-1, s2 (on a plate face), extrude-2
      const features = [...history.features, sketchOnFace, boss];
      const withFace: WorkbenchProject = { ...project, part: { ...project.part, generalBodies: [tetra("general-body:plate"), tetra(BOSS)] }, design: { ...history, features, rollbackIndex: features.length } };
      assert(refused(withFace, "s2", 1).includes("is drawn on a face of the body made by"), "the face sketch cannot go before the plate exists");
      assert(refused(withFace, "s2", 3).includes("Join 1"), "nor before the join that changed the plate's faces");
      assert(refused(withFace, "join-1", 4).includes("Sketch 2"), "and the join cannot move after the sketch drawn on its face");
      // A sketch on a plain plane has no such need: Sketch 2 (copied from Sketch 1, on a datum plane) can still go first.
      assert(reorderProblem(designOf(twoBodies()), "feature:s2", 0) === undefined, "a sketch on a datum plane moves freely");
    }
  },
  {
    name: "reorderTargets lists exactly the places a step may be dropped, the same answer reorderProblem gives",
    run: () => {
      const history = designOf(twoBodies());
      for (const feature of history.features) {
        const targets = reorderTargets(history, feature.id);
        for (let to = 0; to < history.features.length; to += 1) {
          equal(targets.includes(to), reorderProblem(history, feature.id, to) === undefined, `${feature.name} to ${to}`);
        }
      }
      equal(reorderTargets(history, "feature:extrude-1").join(","), "", "the plate's own step has nowhere to go: its sketch is before it and its cut right after");
      equal(reorderTargets(history, "feature:cut-1").join(","), "3,4,5,6", "a cut may move past the join and the later steps of other bodies, but never before its own body's step");
      assert(reorderProblem(history, "feature:cut-1", 2) !== undefined, "dropping a step where it already is is not a move");
      assert(reorderProblem(history, "feature:cut-1", 99) !== undefined && reorderProblem(history, "feature:nope", 1) !== undefined, "an outside place and a missing step are refused");
    }
  },
  {
    name: "The rollback marker stays between the same two steps, and a step only turns on or off by crossing it",
    run: () => {
      const project = twoBodies();
      // Marker after extrude-1 and cut-1: join-1 and everything after it is rolled back.
      const rolled = applyOp(project, { kind: "set-design-rollback", index: 3 });
      // The join (rolled back) moves in front of the cut, which is before the marker: it crosses the marker and turns on.
      const crossedOn = move(rolled, "join-1", 2);
      equal(order(crossedOn), "s1,extrude-1,join-1,cut-1,s2,extrude-2,combine-1", "join and cut swapped");
      equal(designOf(crossedOn).rollbackIndex, 4, "the join crossed the marker, so it is on and the marker follows it");
      // Dropped right at the marker, a rolled-back step stays rolled back.
      const atMarker = move(rolled, "s2", 3);
      equal(order(atMarker), "s1,extrude-1,cut-1,s2,join-1,extrude-2,combine-1", "Sketch 2 placed right after the cut");
      equal(designOf(atMarker).rollbackIndex, 3, "it came from behind the marker and stays there");
      // Moving the rolled-back sketch 2 to the front brings it before the marker: it turns on, the marker follows it.
      const forward = move(rolled, "s2", 0);
      equal(designOf(forward).rollbackIndex, 4, "Sketch 2 now sits before the marker, so the marker follows");
      // An active step moved behind the marker turns off.
      const off = move(rolled, "cut-1", 3);
      equal(order(off), "s1,extrude-1,join-1,cut-1,s2,extrude-2,combine-1", "cut moved behind the join");
      equal(designOf(off).rollbackIndex, 2, "and the marker now sits after the plate only");
    }
  },
  {
    name: "A pattern's copies keep their order, and a copy cannot move before its source body's step",
    run: () => {
      const project = plateHoleFillet();
      const history = designOf(project);
      const pattern = (index: number): DesignSolidFeature => stepOf(`feature:copy-${index}`, `Pattern ${index}`, "pattern", {
        bodyId: `general-body:copy-${index}`, operation: "new-body",
        pattern: { type: "rectangular", result: "new-bodies", groupId: "pattern:g1", sourceBodyId: "general-body:plate", copyIndex: index, countA: 3, spacingAMm: 20, directionA: [1, 0, 0], countB: 1, spacingBMm: 0, directionB: [0, 1, 0], sizing: "spacing" }
      });
      const features = [...history.features, pattern(1), pattern(2)];
      const withCopies: WorkbenchProject = { ...project, part: { ...project.part, generalBodies: [tetra("general-body:plate"), tetra("general-body:copy-1"), tetra("general-body:copy-2")] }, design: { ...history, features, rollbackIndex: features.length } };
      assert(refused(withCopies, "copy-1", 1).includes("repeats the body made by"), "a copy cannot come before the plate's step");
      assert(refused(withCopies, "copy-2", 4).includes("continues the pattern of"), "the second copy cannot come before the first");
      // The copies may still move ahead of the plate's later cut and join (they copy the body as it was before the group).
      equal(order(move(withCopies, "copy-1", 2)), "s1,extrude-1,copy-1,cut-1,join-1,copy-2", "one copy moved up among the plate's steps");
      // Rolled back before the copies they are hidden; a copy moved in front of the marker is on and shown again, the other stays off.
      const rolled = applyOp(withCopies, { kind: "set-design-rollback", index: 4 });
      const shown = (candidate: WorkbenchProject, id: string): boolean | undefined => candidate.part.generalBodies?.find((body) => body.id === id)?.visible;
      equal(shown(rolled, "general-body:copy-1"), false, "the copies are rolled back, so hidden");
      const crossed = move(rolled, "copy-1", 2);
      equal(designOf(crossed).rollbackIndex, 5, "the marker follows the step that crossed it");
      equal(shown(crossed, "general-body:copy-1"), true, "the copy that crossed the marker is shown");
      equal(shown(crossed, "general-body:copy-2"), false, "the other copy stays rolled back");
    }
  },
  {
    name: "A move is one project change: one revision, one summary, and the project stays valid after Undo-style reapplication",
    run: () => {
      const project = twoBodies();
      const result = moveDesignFeature(project, "feature:join-1", 2);
      assert(result.ok, "the move applies");
      const moved = applyOp(project, { kind: "move-design-feature", featureId: "feature:join-1", toIndex: 2 });
      equal(moved.revision, project.revision + 1, "exactly one revision");
      assert(result.ok && result.value.summary.includes("Join 1"), "the summary names the step");
      const refusedProject = refused(project, "extrude-1", 0);
      assert(refusedProject.length > 0, "a refused move says why");
      // Moving it back restores the original order exactly.
      equal(order(applyOp(moved, { kind: "move-design-feature", featureId: "feature:join-1", toIndex: 3 })), order(project), "moving it back restores the order");
    }
  },
  {
    name: "Dragging along the strip: the landing place is the count of other steps left of the pointer, a press must travel before it is a drag, the strip scrolls at its ends",
    run: () => {
      const centers = [20, 80, 140, 200];
      equal(dropIndexFor(centers, 5), 0, "left of everything lands first");
      equal(dropIndexFor(centers, 100), 2, "between the second and third lands third");
      equal(dropIndexFor(centers, 500), 4, "right of everything lands last");
      assert(!dragHasStarted(3) && dragHasStarted(-9), "a small move is still a click, a long one either way is a drag");
      equal(edgeScroll(0, 400, 10) < 0, true, "near the left end scrolls left");
      equal(edgeScroll(0, 400, 395) > 0, true, "near the right end scrolls right");
      equal(edgeScroll(0, 400, 200), 0, "in the middle it does not scroll");
      equal(keyboardMoveTarget(0, 5, "left"), undefined, "the first step cannot go earlier");
      equal(keyboardMoveTarget(4, 5, "right"), undefined, "the last step cannot go later");
      equal(keyboardMoveTarget(2, 5, "left"), 1, "Alt+Left moves one place earlier");
    }
  },
  {
    name: "The strip chips can be dragged (data-chip-id, a drag hint) and the step menu has Move earlier and Move later, closed with the reason when the move is refused",
    run: () => {
      const history = designOf(twoBodies());
      const noop = (): void => undefined;
      const bar = renderToStaticMarkup(createElement(TimelineBar, { history, selectedFeatureId: null, busy: false, onSelect: noop, onEdit: noop, onRollback: noop, onSuppress: noop, onDelete: noop, onRename: noop, onMove: noop }));
      assert(bar.includes('data-chip-id="feature:cut-1"') && bar.includes("drag to move"), "every chip can be picked up");
      const menu = (id: string): string => renderToStaticMarkup(createElement(TimelineMenu, { menuRef: { current: null }, feature: history.features.find((feature) => feature.id === id)!, history, placement: { left: 0, top: 0, maxHeight: 300 }, onClose: noop, onEdit: noop, onSuppress: noop, onRename: noop, onRollback: noop, onDelete: noop, onMove: noop }));
      const cut = menu("feature:cut-1");
      assert(cut.includes(">Move earlier<") && cut.includes(">Move later<"), "both entries are there");
      assert(/<button[^>]*disabled=""[^>]*title="Cut 1 cannot move before Extrude 1[^"]*"[^>]*>Move earlier/u.test(cut), "Move earlier is closed for the cut, and the tooltip says why");
      assert(!/<button[^>]*disabled=""[^>]*>Move later/u.test(cut), "Move later is open for the cut");
      assert(/disabled=""[^>]*title="[^"]* is the first step."[^>]*>Move earlier/u.test(menu("feature:s1")), "the first step says it is first");
    }
  },
];
