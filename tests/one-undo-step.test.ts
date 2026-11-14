import { applyIntent, commitWorkingSketchAtomically } from "../apps/studio-web/src/sketch-session.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { designOf, validateWorkbenchProject, type DesignSketchFeature, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { PLATE_BODY, plateHoleFillet, stepOf, tetra } from "./history-kit.js";
import { fresh, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * HS-25: one command is one undo step. The app records one project per command (every Undo step is one recorded project), so the
 * contract tested here is that a command's changes can all be computed on a base project and end as ONE valid project: the sketch
 * finished by Create solid and the solid step, and a Combine's step plus the hiding of its consumed tool.
 */

function withWorkingRectangle(): WorkbenchProject {
  return pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("plate", 0, 0, 60, 40)], addConstraints: [], label: "Draw" });
}

export const oneUndoStepTests: readonly TestCase[] = [
  {
    name: "Create solid from a sketch that is not in the timeline yet: the finished sketch and the solid step come out as one project",
    run: async () => {
      const before = withWorkingRectangle();
      equal(designOf(before).features.length, 0, "the sketch is not in the timeline yet");
      const committed = await commitWorkingSketchAtomically(before, { featureId: "feature:sketch-a", name: "Sketch 1" });
      assert(committed.ok, "the sketch finishes");
      if (!committed.ok) return;
      // The finished sketch is a base for the command; it is NOT recorded as an undo state of its own.
      const base = committed.value.project;
      const sketch = designOf(base).features.find((feature): feature is DesignSketchFeature => feature.kind === "sketch")!;
      const step: DesignSolidFeature = { id: "feature:extrude-a", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 12, bodyId: "general-body:a" };
      const built = await rebuildSolidFeature(step, sketch);
      assert(built.ok, "the solid builds");
      if (!built.ok) return;
      const added = applyIntent(base, { kind: "add-design-solid", feature: step, body: built.body });
      assert(added.ok, "the step is added to the base");
      if (!added.ok) return;
      const after = added.value.project;
      equal(designOf(after).features.map((feature) => feature.kind).join(","), "sketch,extrude", "the sketch and the extrude are both in the final project");
      equal((after.part.generalBodies ?? []).length, 1, "with its solid");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(after))).ok, "the combined project saves and reloads");
      equal(designOf(before).features.length, 0, "the project before the command is untouched, so one Undo returns to it");
    }
  },
  {
    name: "Combine with a consumed tool: the combine step and the hiding of the tool are one project",
    run: () => {
      const plate = plateHoleFillet();
      const history = designOf(plate);
      const boss = stepOf("feature:extrude-2", "Extrude 2", "extrude", { bodyId: "general-body:boss" });
      const withBoss: WorkbenchProject = { ...plate, part: { ...plate.part, generalBodies: [...(plate.part.generalBodies ?? []), tetra("general-body:boss")] }, design: { ...history, features: [...history.features, boss], rollbackIndex: history.features.length + 1 } };
      const combine = stepOf("feature:combine-1", "Join Extrude 2", "combine", { operation: "direct-edit", valueMm: 1, combineToolBodyIds: ["general-body:boss"], combineMode: "join" });
      const target = withBoss.part.generalBodies!.find((body) => body.id === PLATE_BODY)!;
      const added = applyIntent(withBoss, { kind: "add-design-solid", feature: combine, body: target });
      assert(added.ok, "the combine step is added");
      if (!added.ok) return;
      const hidden = applyIntent(added.value.project, { kind: "toggle-general-body-visibility", bodyId: "general-body:boss" });
      assert(hidden.ok, "the tool is hidden on the same project");
      if (!hidden.ok) return;
      const after = hidden.value.project;
      assert(designOf(after).features.some((feature) => feature.id === "feature:combine-1"), "the combine is in the timeline");
      equal(after.part.generalBodies!.find((body) => body.id === "general-body:boss")!.visible, false, "the consumed tool is hidden");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(after))).ok, "the result saves and reloads");
      equal(withBoss.part.generalBodies!.find((body) => body.id === "general-body:boss")!.visible, true, "the project before the command is untouched, so one Undo returns to it");
    }
  },
];
