import { matchingSketches } from "../apps/studio-web/src/explicit-pick.js";
import { designOf, sketchOrderProblem, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyOp, refusedOp, stepOf, tetra } from "./history-kit.js";
import { committedSketch, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-12: a step inserted at the rollback marker only uses what exists at that point of the timeline. */

const extrudeOn = (id: string, sketchFeatureId: string, bodyId: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  stepOf(id, `Extrude ${id.slice(-1)}`, "extrude", { sketchFeatureId, bodyId, ...extra });

/** Sketch A, an extrude on it, then Sketch B: timeline order s1, extrude-1, s2. */
function twoSketches(): WorkbenchProject {
  let { project } = committedSketch("datum:xy", [rect("a", 0, 0, 40, 30)], { featureId: "feature:s1" });
  project = applyOp(project, { kind: "add-design-solid", feature: extrudeOn("feature:extrude-1", "feature:s1", "general-body:one"), body: tetra("general-body:one") });
  return committedSketch("datum:xz", [rect("b", 0, 0, 20, 20)], { project, featureId: "feature:s2" }).project;
}

export const rollbackInsertTests: readonly TestCase[] = [
  {
    name: "Rolled back before a sketch, a solid built on that sketch is refused with a message that names it and says what to do",
    run: () => {
      const project = applyOp(twoSketches(), { kind: "set-design-rollback", index: 2 });
      equal(designOf(project).features.map((feature) => feature.id).join(","), "feature:s1,feature:extrude-1,feature:s2", "the marker sits after the first extrude, before Sketch B");
      const message = refusedOp(project, { kind: "add-design-solid", feature: extrudeOn("feature:extrude-2", "feature:s2", "general-body:two"), body: tetra("general-body:two") });
      const second = designOf(project).features[2]!.name;
      assert(message.includes(second), `the refusal names the sketch ${second}: ${message}`);
      assert(message.includes("rollback marker"), `and the marker: ${message}`);
    }
  },
  {
    name: "Rolled back, a solid on an earlier sketch is inserted at the marker, in the middle of the history, and the project stays valid",
    run: () => {
      const project = applyOp(twoSketches(), { kind: "set-design-rollback", index: 2 });
      const after = applyOp(project, { kind: "add-design-solid", feature: extrudeOn("feature:extrude-2", "feature:s1", "general-body:two"), body: tetra("general-body:two") });
      equal(designOf(after).features.map((feature) => feature.id).join(","), "feature:s1,feature:extrude-1,feature:extrude-2,feature:s2", "inserted at the marker, ahead of Sketch B");
      equal(designOf(after).rollbackIndex, 3, "the marker moves past the new step");
    }
  },
  {
    name: "A sweep path or a loft's second profile after the marker is refused the same way",
    run: () => {
      const project = applyOp(twoSketches(), { kind: "set-design-rollback", index: 2 });
      const sweep = extrudeOn("feature:sweep-1", "feature:s1", "general-body:sw", { kind: "sweep", sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:b-0"] } } as Partial<DesignSolidFeature>);
      const refused = refusedOp(project, { kind: "add-design-solid", feature: sweep, body: tetra("general-body:sw") });
      assert(refused.includes("rollback marker"), `a path in a later sketch is refused for the marker: ${refused}`);
      const loft = extrudeOn("feature:loft-1", "feature:s1", "general-body:lo", { kind: "loft", loftSecondarySketchFeatureId: "feature:s2", loftSecondaryProfileIds: ["profile:b"] } as Partial<DesignSolidFeature>);
      const refusedLoft = refusedOp(project, { kind: "add-design-solid", feature: loft, body: tetra("general-body:lo") });
      assert(refusedLoft.includes("rollback marker"), `a second profile in a later sketch is refused for the marker: ${refusedLoft}`);
    }
  },
  {
    name: "sketchOrderProblem and the sketch pickers agree: sketches after the marker are not offered, and a rolled-forward timeline offers all",
    run: () => {
      const forward = twoSketches();
      const history = designOf(forward);
      equal(sketchOrderProblem(history, ["feature:s2"], history.rollbackIndex, "feature:new"), undefined, "at the end every sketch is usable");
      equal(matchingSketches(history, () => true).map((sketch) => sketch.id).join(","), "feature:s2,feature:s1", "all finished sketches are offered, newest first");
      const back = designOf(applyOp(forward, { kind: "set-design-rollback", index: 2 }));
      equal(matchingSketches(back, () => true).map((sketch) => sketch.id).join(","), "feature:s1", "rolled back to 2, only the first sketch exists");
      const problem = sketchOrderProblem(back, ["feature:s2"], back.rollbackIndex, "feature:new");
      assert(problem !== undefined && !problem.ok && problem.diagnostics[0]!.recovery.includes("Roll the marker forward"), "and the refusal tells the person to roll forward or draw a new sketch");
      const start = designOf(applyOp(forward, { kind: "set-design-rollback", index: 0 }));
      equal(matchingSketches(start, () => true).length, 0, "rolled back to the start, none exists");
    }
  },
];
