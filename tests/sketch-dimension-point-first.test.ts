import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { firstPickAfterPoint, firstPickPrompt, pairForCurveClick, resolveDimensionPair, type DimensionPick } from "../packages/workbench-sketch/src/dimension-pick.js";
import { circ, fresh, line, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Sketch Dimension: pick order does not matter. A point picked first and a line second gives the distance from the point to the line,
 * the same as the line first and the point second. (The point used to be forgotten as a first pick, so the line's own length opened.)
 */

/** A plate edge along y = 0, a second edge up from its right end, a hole at (15, 12), and a construction centreline along x = 0. */
function sketch(): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], label: "Draw", addConstraints: [],
    addEntities: [line("edge", [0, 0], [40, 0]), line("side", [40, 0], [40, 25]), circ("hole", 15, 12, 3), line("axis", [0, -5], [0, 30], true), line("step", [8, 5], [8, 20])]
  });
}

/** What the tool does for a click on a point followed by a click on a curve. */
function pointThenCurve(project: WorkbenchProject, point: DimensionPick, curveId: string): ReturnType<typeof pairForCurveClick> {
  const first = firstPickAfterPoint({ entityId: point.entityId, ref: point.ref }, 1);
  assert(first !== undefined, "a single picked point is kept as the first pick");
  return pairForCurveClick(project.sketch, first, curveId);
}

export const sketchDimensionPointFirstTests: readonly TestCase[] = [
  {
    name: "Sketch Dimension: a point picked first and a line second gives the point-to-line distance, the same as the line first",
    run: () => {
      const project = sketch();
      // The centre of the hole, then the bottom edge: 12 mm (hole to edge).
      const centreFirst = pointThenCurve(project, { entityId: "entity:hole", ref: "center" }, "entity:edge");
      assert(centreFirst?.status === "ready", `the pair is ready for the value editor: ${centreFirst?.status ?? "no pair"}`);
      if (centreFirst?.status !== "ready") return;
      equal(centreFirst.dimension.dimension, "point-line", "it is a distance to the line, not the line's length");
      near(centreFirst.dimension.measured, 12, 1e-9, "the hole is 12 mm from the edge");
      const edgeFirst = resolveDimensionPair(project.sketch, { entityId: "entity:edge" }, { entityId: "entity:hole", ref: "center" });
      equal(JSON.stringify(centreFirst), JSON.stringify(edgeFirst), "exactly what the line first and the point second gives");

      // The end of one line, then another line: 32 mm from the top of the step line to the right side.
      const endFirst = pointThenCurve(project, { entityId: "entity:step", ref: "end" }, "entity:side");
      assert(endFirst?.status === "ready" && endFirst.dimension.dimension === "point-line", "a line end and a line give a distance too");
      if (endFirst?.status === "ready") near(endFirst.dimension.measured, 32, 1e-9, "32 mm");
    }
  },
  {
    name: "Sketch Dimension: a point first and a centreline second waits to be placed (diameter across it or distance to it); a circle second pairs the two points",
    run: () => {
      const project = sketch();
      const across = pointThenCurve(project, { entityId: "entity:step", ref: "end" }, "entity:axis");
      assert(across?.status === "place-across", `a point and a centreline are placed across it: ${across?.status ?? "no pair"}`);
      equal(JSON.stringify(across), JSON.stringify(resolveDimensionPair(project.sketch, { entityId: "entity:axis" }, { entityId: "entity:step", ref: "end" })), "as with the centreline picked first");
      const toCentre = pointThenCurve(project, { entityId: "entity:step", ref: "start" }, "entity:hole");
      assert(toCentre?.status === "place", "a point and a circle are placed as the distance between the point and the centre");
    }
  },
  {
    name: "Sketch Dimension: a click on the line a picked point belongs to, or lies on, is for that line; two picked points keep no first pick",
    run: () => {
      const project = sketch();
      equal(pointThenCurve(project, { entityId: "entity:edge", ref: "end" }, "entity:edge"), undefined, "the line's own end, then the line: the line's length");
      equal(pointThenCurve(project, { entityId: "entity:edge", ref: "end" }, "entity:side"), undefined, "the corner two lines share, then the other line: no zero distance, that line's length");
      equal(pairForCurveClick(project.sketch, undefined, "entity:edge"), undefined, "with nothing picked before, the click is for the curve");
      equal(firstPickAfterPoint({ entityId: "entity:hole", ref: "center" }, 2), undefined, "two picked points are placed as a pair and keep no first pick");
      equal(firstPickAfterPoint({ entityId: "entity:hole", ref: undefined }, 1), undefined, "a point that can only be measured is not a first pick");
      // A curve picked first still pairs with a second curve as before.
      const twoLines = pairForCurveClick(project.sketch, { entityId: "entity:edge" }, "entity:side");
      assert(twoLines?.status === "ready" && twoLines.dimension.dimension === "angle", "two lines that are not parallel still give the angle");
      assert(/^Point picked\./u.test(firstPickPrompt({ entityId: "entity:hole", ref: "center" }, false)), "the banner says a point is picked and what to click next");
      assert(/Type the length/u.test(firstPickPrompt({ entityId: "entity:step" }, true)) && /Type the value/u.test(firstPickPrompt({ entityId: "entity:hole" }, false)), "and keeps its wording for a picked curve");
    }
  },
];
