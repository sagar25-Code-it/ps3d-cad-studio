import { designOf, parseWorkbenchProjectText, serializeWorkbenchProject, type DesignSketchFeature, type SketchEntity, type WorkbenchProject, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { cancelSketchSession, changedTimelineFeatureIds, commitWorkingSketchAtomically, workingSketchState } from "../apps/studio-web/src/sketch-session.js";
import { fresh, line, meshStats, pipelineRun, rect, solidFeature } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * A dimension used by name (d1) somewhere else: the edit of an open sketch stays in that sketch until Finish, Cancel puts everything
 * back, and Finish rebuilds the bodies of every sketch and step that followed the name, not only those built on the finished sketch.
 */

const pinned = (id: string): WorkbenchSketchConstraint[] => [
  { id: `constraint:fix-${id}`, kind: "fixed", entityIds: [`entity:${id}`], points: ["start"] },
  { id: `constraint:level-${id}`, kind: "horizontal", entityIds: [`entity:${id}`] }
];

const sketchOf = (project: WorkbenchProject, featureId: string): WorkbenchSketch => {
  const found = designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === featureId && feature.kind === "sketch");
  assert(found !== undefined, `${featureId} is in the timeline`);
  return found.sketch;
};
const lineLength = (sketch: WorkbenchSketch, id: string): number => {
  const entity = sketch.entities.find((candidate): candidate is Extract<SketchEntity, { kind: "line" }> => candidate.id === id && candidate.kind === "line");
  assert(entity !== undefined, `${id} is a line`);
  return Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
};
const boxWidth = (sketch: WorkbenchSketch): number => {
  const entity = sketch.entities.find((candidate): candidate is Extract<SketchEntity, { kind: "rectangle" }> => candidate.id === "entity:box" && candidate.kind === "rectangle");
  assert(entity !== undefined, "the box is a rectangle");
  return entity.widthMm;
};
const valueOf = (sketch: WorkbenchSketch, name: string): number | undefined => sketch.constraints.find((constraint) => constraint.name === name)?.valueMm;
const bodyWidth = (project: WorkbenchProject, bodyId: string): number => {
  const body = project.part.generalBodies?.find((candidate) => candidate.id === bodyId);
  assert(body !== undefined, `${bodyId} is in the part`);
  const stats = meshStats(body);
  return stats.hi[0] - stats.lo[0];
};

/** Sketch 1 (feature:s1): line a with a length of 80 (d1) and line b whose length is typed as d1 / 2. */
function oneSketchWithFollower(): WorkbenchProject {
  let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  project = pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], label: "Lines",
    addEntities: [line("a", [0, 0], [80, 0]), line("b", [0, 20], [50, 20])],
    addConstraints: [...pinned("a"), ...pinned("b"), { id: "constraint:len-a", kind: "distance", entityIds: ["entity:a"], valueMm: 80, dimension: "length" }]
  });
  project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:b", dimension: "length", valueMm: 1, expression: "d1 / 2" });
  return pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
}

/** Sketch 1: line a, length 80 (d1). Sketch 2: a 20 mm high box whose width is typed as d1 / 2, extruded 10 mm into Extrude 1. */
async function boxFollowingAnotherSketch(): Promise<WorkbenchProject> {
  let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  project = pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], label: "Line",
    addEntities: [line("a", [0, 0], [80, 0])],
    addConstraints: [...pinned("a"), { id: "constraint:len-a", kind: "distance", entityIds: ["entity:a"], valueMm: 80, dimension: "length" }]
  });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
  project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy" });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("box", 0, 0, 50, 20)], addConstraints: [], label: "Box" });
  project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:box", dimension: "width", valueMm: 1, expression: "d1 / 2" });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Sketch 2" });
  const second = designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === "feature:s2" && feature.kind === "sketch");
  assert(second !== undefined, "Sketch 2 is in the timeline");
  near(boxWidth(second.sketch), 40, 1e-6, "the box is d1 / 2 = 40 wide");
  const step = solidFeature("extrude", second, { id: "feature:extrude-1", name: "Extrude 1", bodyId: "general-body:extrude-1", valueMm: 10 });
  const body = await rebuildSolidFeature(step, second);
  assert(body.ok, "the box extrudes");
  return pipelineRun(project, { kind: "add-design-solid", feature: step, body: body.body });
}

export const sketchDimensionFollowTests: readonly TestCase[] = [
  {
    name: "Named dimension in an open sketch: the edit stays in the working sketch, the timeline copy is untouched, and Cancel puts the follower back",
    run: () => {
      const finished = oneSketchWithFollower();
      const stored = JSON.stringify(sketchOf(finished, "feature:s1"));
      let project = pipelineRun(finished, { kind: "edit-design-sketch", featureId: "feature:s1" });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 100 });
      near(lineLength(project.sketch, "entity:a"), 100, 1e-6, "the working sketch has d1 = 100");
      near(lineLength(project.sketch, "entity:b"), 50, 1e-6, "and its follower went to 50 at once");
      equal(JSON.stringify(sketchOf(project, "feature:s1")), stored, "the timeline copy is exactly as it was before Finish");
      equal(workingSketchState(project).kind, "edited", "the session is an edit of that sketch");

      const cancelled = cancelSketchSession(project, undefined);
      assert(cancelled.ok && cancelled.value.kind === "discarded", "Cancel discards the edit");
      if (!cancelled.ok || cancelled.value.kind !== "discarded") return;
      const back = cancelled.value.project;
      equal(JSON.stringify(back.sketch), stored, "the sketch is back exactly as it was");
      near(lineLength(back.sketch, "entity:a"), 80, 1e-6, "d1 is 80 again");
      near(lineLength(back.sketch, "entity:b"), 40, 1e-6, "and the follower is 40 again, not the discarded 50");
      equal(valueOf(back.sketch, "d2"), 40, "its stored value is 40");
      equal(back.sketch.constraints.find((constraint) => constraint.name === "d2")?.expression, "d1 / 2", "and it still follows d1");
      equal(JSON.stringify(sketchOf(back, "feature:s1")), stored, "the timeline still holds the same sketch");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(back));
      assert(reloaded.ok && valueOf(reloaded.value.sketch, "d2") === 40, "what is saved after Cancel is the old value");
    }
  },
  {
    name: "Named dimension in an open sketch: Finish carries the edit and its follower into the timeline as one step",
    run: async () => {
      let project = pipelineRun(oneSketchWithFollower(), { kind: "edit-design-sketch", featureId: "feature:s1" });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 100 });
      const outcome = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch" });
      assert(outcome.ok, "Finish is accepted");
      if (!outcome.ok) return;
      const stored = sketchOf(outcome.value.project, "feature:s1");
      near(lineLength(stored, "entity:a"), 100, 1e-6, "the timeline has d1 = 100");
      near(lineLength(stored, "entity:b"), 50, 1e-6, "and the follower at 50");
      equal(workingSketchState(outcome.value.project).kind, "clean", "nothing is left unfinished");
    }
  },
  {
    name: "A solid on a sketch that uses another sketch's d1 is rebuilt when d1 changes: not before Finish, and with the sketch on Finish",
    run: async () => {
      const built = await boxFollowingAnotherSketch();
      near(bodyWidth(built, "general-body:extrude-1"), 40, 1e-3, "the body starts 40 wide");

      let project = pipelineRun(built, { kind: "edit-design-sketch", featureId: "feature:s1" });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 120 });
      near(boxWidth(sketchOf(project, "feature:s2")), 40, 1e-6, "Sketch 2 in the timeline does not move while Sketch 1 is still open");
      equal(changedTimelineFeatureIds(built, project).length, 0, "nothing in the timeline changed yet");

      // Cancel here leaves sketch and body in step at 40.
      const cancelled = cancelSketchSession(project, undefined);
      assert(cancelled.ok && cancelled.value.kind === "discarded", "Cancel discards the edit");
      if (cancelled.ok && cancelled.value.kind === "discarded") {
        near(boxWidth(sketchOf(cancelled.value.project, "feature:s2")), 40, 1e-6, "after Cancel the box is still 40");
        near(bodyWidth(cancelled.value.project, "general-body:extrude-1"), 40, 1e-3, "and so is its body");
      }

      const outcome = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch" });
      assert(outcome.ok, "Finish is accepted");
      if (!outcome.ok) return;
      const after = outcome.value.project;
      near(boxWidth(sketchOf(after, "feature:s2")), 60, 1e-6, "Sketch 2 followed d1 to 60");
      assert(outcome.value.rebuilt.some((result) => result.featureId === "feature:extrude-1"), "the step built on Sketch 2 was rebuilt");
      equal(outcome.value.failed.length, 0, "with no failure");
      near(bodyWidth(after, "general-body:extrude-1"), 60, 1e-3, "and its body is 60 wide, in step with its sketch");
      equal(after.revision, project.revision + 2, "the sketch update and the rebuilt body are the two operations of one Finish");

      // Save, reload, change d1 back the other way.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(after));
      assert(reloaded.ok, "the project reloads");
      if (!reloaded.ok) return;
      let again = pipelineRun(reloaded.value, { kind: "edit-design-sketch", featureId: "feature:s1" });
      again = pipelineRun(again, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 80 });
      const second = await commitWorkingSketchAtomically(again, { featureId: "feature:unused", name: "Sketch" });
      assert(second.ok, "the second Finish is accepted");
      if (!second.ok) return;
      near(bodyWidth(second.value.project, "general-body:extrude-1"), 40, 1e-3, "after a reload the body follows d1 back to 40");
    }
  },
  {
    name: "A step whose distance uses a sketch dimension by name is rebuilt when that sketch is finished with a new value",
    run: async () => {
      let project = await boxFollowingAnotherSketch();
      const step = designOf(project).features.find((feature) => feature.id === "feature:extrude-1");
      assert(step !== undefined && step.kind !== "sketch", "Extrude 1 is a step");
      const body = project.part.generalBodies?.find((candidate) => candidate.id === "general-body:extrude-1");
      assert(body !== undefined, "the body is in the part");
      // Distance = d1 / 8 (10 mm while d1 is 80).
      project = pipelineRun(project, { kind: "update-design-solid", feature: { ...step, expressions: { distance: "d1 / 8" } }, body: body! });
      project = pipelineRun(project, { kind: "edit-design-sketch", featureId: "feature:s1" });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 160 });
      const held = designOf(project).features.find((feature) => feature.id === "feature:extrude-1");
      assert(held !== undefined && held.kind !== "sketch" && held.valueMm === 10, "the step keeps its 10 mm while the sketch is open");
      const outcome = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch" });
      assert(outcome.ok, "Finish is accepted");
      if (!outcome.ok) return;
      const after = designOf(outcome.value.project).features.find((feature) => feature.id === "feature:extrude-1");
      assert(after !== undefined && after.kind !== "sketch" && after.valueMm === 20, "the step's distance followed d1 to 20");
      const rebuiltBody = outcome.value.project.part.generalBodies?.find((candidate) => candidate.id === "general-body:extrude-1");
      assert(rebuiltBody !== undefined, "the body is still there");
      const stats = meshStats(rebuiltBody!);
      near(stats.hi[2] - stats.lo[2], 20, 1e-3, "and the body is 20 mm tall");
      near(stats.hi[0] - stats.lo[0], 80, 1e-3, "and 80 wide (d1 / 2)");
    }
  },
];
