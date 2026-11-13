import { lineExtentPlacement, placeLineExtent, placementPreview } from "../packages/workbench-sketch/src/dimension-pick.js";
import { pointDistanceLayout } from "../packages/workbench-sketch/src/point-distance-layout.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { fresh, line, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * One line picked in Sketch Dimension: its length opens at once, and a placement click above, below or beside the line gives its
 * horizontal or vertical extent instead, with the dimension drawn at the pointer before the click.
 */

/** A sketch with one sloped line from (0, 0) to (40, 30) held at its start, and one level line. */
function sloped(): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], label: "Lines",
    addEntities: [line("slope", [0, 0], [40, 30]), line("level", [0, -20], [50, -20])],
    addConstraints: [{ id: "constraint:pin", kind: "coincident", entityIds: ["sketch:origin", "entity:slope"], points: ["self", "start"] }]
  });
}

const lineOf = (project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "line" }> => {
  const entity = project.sketch.entities.find((candidate) => candidate.id === id);
  assert(entity?.kind === "line", `${id} is a line`);
  return entity;
};

export const sketchDimensionPlacementTests: readonly TestCase[] = [
  {
    name: "Sketch Dimension on one sloped line: placing above or below gives its horizontal extent, beside it the vertical one, on it its length",
    run: () => {
      const sketch = sloped().sketch;
      const pick = { entityId: "entity:slope" };
      const placement = lineExtentPlacement(sketch, pick);
      assert(placement !== undefined, "a sloped line has extents to place");
      equal(`${placement.entityId}|${placement.secondEntityId}|${placement.points.join("+")}`, "entity:slope|entity:slope|start+end", "measured between its own ends");
      equal(lineExtentPlacement(sketch, { entityId: "entity:level" }), undefined, "a level line's extent is its length, so nothing more is offered");
      equal(lineExtentPlacement(sketch, { entityId: "entity:slope", ref: "end" }), undefined, "a picked point is not a picked line");
      const above = placeLineExtent(sketch, pick, [20, 45]);
      assert(above !== undefined && typeof above !== "string" && above.dimension === "horizontal", "above the line: the horizontal extent");
      if (above !== undefined && typeof above !== "string") near(above.measured, 40, 1e-9, "which is 40");
      const beside = placeLineExtent(sketch, pick, [55, 15]);
      assert(beside !== undefined && typeof beside !== "string" && beside.dimension === "vertical", "beside the line: the vertical extent");
      if (beside !== undefined && typeof beside !== "string") near(beside.measured, 30, 1e-9, "which is 30");
      equal(placeLineExtent(sketch, pick, [20, 15]), undefined, "inside the line's own box the placement means its length");
      equal(placeLineExtent(sketch, pick, [60, 60]), undefined, "and so does a corner away from both spans");
      // The preview is the dimension the click would make.
      const preview = placementPreview(sketch, placement, [20, 45]);
      assert(preview !== undefined && preview.constraint.dimension === "horizontal", "the preview above the line is the horizontal extent");
      if (preview === undefined) return;
      const layout = pointDistanceLayout(sketch, preview.constraint, preview.measured, 0.1);
      assert(layout !== undefined, "it has a layout");
      if (layout !== undefined) near(Math.abs(layout.dimensionLine.to[0] - layout.dimensionLine.from[0]), 40, 1e-9, "its dimension line spans the 40 mm");
    }
  },
  {
    name: "The horizontal and vertical extents of one line drive it: 60 across and 30 up fix the line that is pinned at its start",
    run: () => {
      let project = sloped();
      const before = analyzeWorkbenchSketch({ ...project.sketch, entities: project.sketch.entities.filter((entity) => entity.id === "entity:slope") }).degreesOfFreedom;
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:slope", secondEntityId: "entity:slope", dimension: "horizontal", points: ["start", "end"], valueMm: 60 });
      near(lineOf(project, "entity:slope").end[0], 60, 1e-6, "the end is 60 across");
      near(lineOf(project, "entity:slope").end[1], 30, 1e-6, "its height did not change");
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:slope", secondEntityId: "entity:slope", dimension: "vertical", points: ["start", "end"], valueMm: 25 });
      near(lineOf(project, "entity:slope").end[1], 25, 1e-6, "the end is 25 up");
      near(lineOf(project, "entity:slope").start[0], 0, 1e-9, "the pinned start stayed");
      const only: WorkbenchProject["sketch"] = { ...project.sketch, entities: project.sketch.entities.filter((entity) => entity.id === "entity:slope") };
      equal(analyzeWorkbenchSketch(only).degreesOfFreedom, before - 2, "the two extents take the line's two remaining freedoms");
      const again = placeLineExtent(project.sketch, { entityId: "entity:slope" }, [20, 45]);
      assert(again !== undefined && typeof again !== "string" && again.existing?.value === 60, "placing above the line again opens the stored 60");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok && reloaded.value.sketch.constraints.filter((constraint) => constraint.kind === "distance").length === 2, "both dimensions survive save and reload");
    }
  },
];
