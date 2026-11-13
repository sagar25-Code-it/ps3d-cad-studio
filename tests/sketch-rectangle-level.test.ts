import { bornConstraintsFor } from "../packages/workbench-sketch/src/auto-constraints.js";
import { analyzeWorkbenchSketch, buildSketchEntity, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import { dragLiveSketch, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { fresh, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * A rectangle drawn corner to corner (or from its centre) is level from birth, so a width, a height and two distances that place it
 * make it fully constrained. Before, its turn stayed a free degree of freedom unless a corner sat on a point.
 */

function drawn(tool: Exclude<SketchTool, "select">, points: readonly Vec2[], id = "entity:r"): SketchEntity {
  const built = buildSketchEntity(tool, points, id);
  assert(built.ok, `${tool} builds`);
  return built.value;
}

function born(tool: SketchTool, entity: SketchEntity): readonly WorkbenchSketchConstraint[] {
  let serial = 0;
  return bornConstraintsFor({ tool, entity, newId: () => `constraint:own-${serial += 1}` });
}

/** An empty sketch with one rectangle 80 x 50 whose lower-left corner is at (10, 15), its size dimensions, and the given extra relations. */
function plate(extra: readonly WorkbenchSketchConstraint[], entity: SketchEntity = drawn("rectangle", [[10, 15], [90, 65]])): WorkbenchProject {
  let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  project = pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [entity], label: "Rectangle",
    addConstraints: [
      ...extra,
      { id: "constraint:w", kind: "distance", entityIds: [entity.id], valueMm: 80, dimension: "width" },
      { id: "constraint:h", kind: "distance", entityIds: [entity.id], valueMm: 50, dimension: "height" }
    ]
  });
  project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "sketch:origin", secondEntityId: entity.id, dimension: "horizontal", points: ["self", "corner-0"], valueMm: 10 });
  return pipelineRun(project, { kind: "set-sketch-dimension", entityId: "sketch:origin", secondEntityId: entity.id, dimension: "vertical", points: ["self", "corner-0"], valueMm: 15 });
}

export const sketchRectangleLevelTests: readonly TestCase[] = [
  {
    name: "Rectangle tools: a corner-to-corner or centre rectangle is born with Horizontal; a rectangle drawn at an angle and other shapes are not",
    run: () => {
      const twoPoint = drawn("rectangle", [[0, 0], [40, 25]]);
      equal(born("rectangle", twoPoint).map((relation) => `${relation.kind}:${relation.entityIds.join("+")}`).join(","), "horizontal:entity:r", "2-point rectangle");
      equal(born("rectangle-center", drawn("rectangle-center", [[0, 0], [20, 10]])).map((relation) => relation.kind).join(","), "horizontal", "centre rectangle");
      const turned = drawn("rectangle-three-point", [[0, 0], [30, 30], [20, 40]]);
      assert(turned.kind === "rectangle" && Math.abs(turned.rotationDeg) > 1, "the 3-point rectangle is turned");
      equal(born("rectangle-three-point", turned).length, 0, "a 3-point rectangle keeps the angle it was drawn at and gets no Horizontal");
      equal(born("circle", drawn("circle", [[0, 0], [5, 0]])).length, 0, "a circle gets nothing");
      equal(born("line", drawn("line", [[0, 0], [5, 0]])).length, 0, "a line gets nothing here (its Horizontal comes from the inference guide)");
    }
  },
  {
    name: "Rectangle with a width, a height and two distances from the origin is fully constrained (it stayed 1 degree of freedom short)",
    run: () => {
      const entity = drawn("rectangle", [[10, 15], [90, 65]]);
      const before = analyzeWorkbenchSketch(plate([], entity).sketch);
      equal(`${before.classification}:${before.degreesOfFreedom}`, "underconstrained:1", "without the born relation the turn is still free");
      const project = plate(born("rectangle", entity), entity);
      const after = analyzeWorkbenchSketch(project.sketch);
      equal(`${after.classification}:${after.degreesOfFreedom}`, "fully-constrained:0", "with it the rectangle is fully constrained");
      equal(after.conflicts.length, 0, "and nothing conflicts");
      // Save and reload keeps the relation and the state.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "reloads");
      if (!reloaded.ok) return;
      equal(analyzeWorkbenchSketch(reloaded.value.sketch).classification, "fully-constrained", "still fully constrained after reload");
      // Removing the relation (what Undo of the draw step or deleting its glyph does) gives the freedom back.
      const removed = pipelineRun(project, { kind: "delete-sketch-constraint", constraintId: "constraint:own-1" });
      equal(analyzeWorkbenchSketch(removed.sketch).degreesOfFreedom, 1, "deleting Horizontal frees the turn again");
    }
  },
  {
    name: "A level rectangle with no dimensions still resizes when a corner is dragged, and stays level",
    run: () => {
      const entity = drawn("rectangle", [[0, 0], [40, 20]]);
      let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: born("rectangle", entity), label: "Rectangle" });
      equal(analyzeWorkbenchSketch(project.sketch).degreesOfFreedom, 4, "position and size are free, the turn is not");
      const dragged = dragLiveSketch(project.sketch, { entityId: entity.id, point: "corner-2", positionMm: [55, 32] });
      assert(dragged.ok, `the drag solves: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const moved = dragged.entities.find((candidate) => candidate.id === entity.id);
      assert(moved?.kind === "rectangle", "still a rectangle");
      near(moved.rotationDeg, 0, 1e-9, "it did not turn");
      near(moved.center[0] + moved.widthMm / 2, 55, 1e-6, "the dragged corner follows the pointer in X");
      near(moved.center[1] + moved.heightMm / 2, 32, 1e-6, "and in Y");
    }
  },
  {
    name: "A rectangle saved before this change (no Horizontal) loads with the same geometry and the same freedom as before",
    run: () => {
      let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("old", 50, 40, 80, 50)], addConstraints: [], label: "Old rectangle" });
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "reloads");
      if (!reloaded.ok) return;
      const old = reloaded.value.sketch.entities.find((entity) => entity.id === "entity:old");
      assert(old?.kind === "rectangle" && old.widthMm === 80 && old.heightMm === 50 && old.center[0] === 50 && old.center[1] === 40, "same rectangle");
      equal(reloaded.value.sketch.constraints.length, 0, "no relation is invented on load");
      equal(analyzeWorkbenchSketch(reloaded.value.sketch).degreesOfFreedom, 5, "a free rectangle keeps its five degrees of freedom");
    }
  },
];
