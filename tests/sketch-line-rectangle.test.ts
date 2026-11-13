import { analyzeWorkbenchSketch, buildLineRectangle, detectSketchProfiles, isShapeTool, requiredSketchPoints, type LineRectangleTool } from "../packages/workbench-sketch/src/index.js";
import type { PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { shapeSnapRelations } from "../packages/workbench-sketch/src/shape-snap-relations.js";
import { typedShapeIntent } from "../packages/workbench-sketch/src/typed-shape-intent.js";
import type { DynamicValues } from "../packages/workbench-sketch/src/dynamic-input.js";
import type { SketchShape } from "../packages/workbench-sketch/src/shapes.js";
import { dragLiveSketch, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { fresh, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * The rectangle tools draw four lines held together by relations, the way a designer expects, so a side is an ordinary line.
 * These tests place a rectangle the way the canvas does: the builder, then the relations its snapped clicks earn, then the
 * dimensions its typed sizes become, all in one edit.
 */

function ids(prefix: string): { readonly entity: () => string; readonly constraint: () => string } {
  let entities = 0;
  let constraints = 0;
  return { entity: () => `entity:${prefix}-${entities += 1}`, constraint: () => `constraint:${prefix}-${constraints += 1}` };
}

function built(tool: LineRectangleTool, points: readonly Vec2[], prefix = "r"): SketchShape {
  const shape = buildLineRectangle(tool, points, ids(prefix));
  assert(shape.ok, `${tool} builds: ${shape.ok ? "" : shape.diagnostics[0]?.message ?? ""}`);
  return shape.value;
}

const ORIGIN_SNAP: PlacedPointInference = { point: [0, 0], primary: { kind: "origin", point: [0, 0], selector: "point", distanceMm: 0 } };

/** What one use of a rectangle tool sends to the project: the shape, its snap relations and its typed sizes, as one edit. */
function draw(project: WorkbenchProject, tool: LineRectangleTool, placed: readonly PlacedPointInference[], typed: DynamicValues = {}, prefix = "r"): { readonly project: WorkbenchProject; readonly shape: SketchShape; readonly relations: readonly WorkbenchSketchConstraint[] } {
  const shape = built(tool, placed.map((entry) => entry.point), prefix);
  let serial = 0;
  const newId = (): string => `constraint:${prefix}-extra-${serial += 1}`;
  const relations = [
    ...shape.constraints,
    ...shapeSnapRelations({ tool, shape, placed, sketch: project.sketch, newId }),
    ...typedShapeIntent({ tool, shape, typed, newId })
  ];
  const next = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: relations, label: "Rectangle" });
  return { project: next, shape, relations };
}

const emptySketch = (): WorkbenchProject => pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
const kinds = (relations: readonly WorkbenchSketchConstraint[]): string => [...relations.map((relation) => relation.kind)].sort().join(",");
const lineOf = (project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "line" }> => {
  const entity = project.sketch.entities.find((candidate) => candidate.id === id);
  assert(entity?.kind === "line", `${id} is a line`);
  return entity;
};

export const sketchLineRectangleTests: readonly TestCase[] = [
  {
    name: "Rectangle tools are shape tools: R draws four joined lines, two Horizontal and two Vertical, whichever way the corners are dragged",
    run: () => {
      for (const tool of ["rectangle", "rectangle-center", "rectangle-three-point"] as const) assert(isShapeTool(tool), `${tool} places a whole shape`);
      equal(requiredSketchPoints("rectangle"), 2, "two clicks");
      equal(requiredSketchPoints("rectangle-three-point"), 3, "three clicks");
      for (const points of [[[10, 15], [90, 65]], [[90, 65], [10, 15]], [[10, 65], [90, 15]]] as const) {
        const shape = built("rectangle", points);
        equal(shape.entities.length, 4, "four curves");
        assert(shape.entities.every((entity) => entity.kind === "line" && !entity.construction), "all of them profile lines");
        equal(kinds(shape.constraints), "coincident,coincident,coincident,coincident,horizontal,horizontal,vertical,vertical", "joints and level / plumb sides");
        // Both clicked points are ends of sides, so a snapped corner can be joined to what it was snapped to.
        for (const click of points) assert(shape.entities.some((entity) => entity.kind === "line" && (Math.hypot(entity.start[0] - click[0], entity.start[1] - click[1]) < 1e-9)), `the click at ${click.join(",")} is a corner`);
        const project = pipelineRun(emptySketch(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints, label: "Rectangle" });
        const analysis = analyzeWorkbenchSketch(project.sketch);
        equal(analysis.degreesOfFreedom, 4, "position and size are free, nothing else");
        equal(analysis.conflicts.length, 0, "no relation conflicts");
        equal(detectSketchProfiles(project.sketch).length, 1, "one closed profile");
      }
      const flat = buildLineRectangle("rectangle", [[0, 0], [20, 0]], ids("flat"));
      assert(!flat.ok, "a rectangle with no height is refused");
    }
  },
  {
    name: "Rectangle from the origin typed 80 by 50 is dimensioned and fully constrained in one edit, and stays so after save and reload",
    run: () => {
      const before = emptySketch();
      const { project, shape, relations } = draw(before, "rectangle", [ORIGIN_SNAP, { point: [80, 50] }], { width: 80, height: 50 });
      equal(project.revision, before.revision + 1, "one edit, so one Undo step takes the whole rectangle away");
      const dimensions = relations.filter((relation) => relation.kind === "distance");
      equal(dimensions.map((relation) => `${relation.dimension}:${relation.valueMm}:${relation.entityIds.join("+")}`).join(" "), `length:80:${shape.entities[0]!.id} length:50:${shape.entities[1]!.id}`, "the typed width and height are length dimensions of the first and second side");
      assert(relations.some((relation) => relation.kind === "coincident" && relation.entityIds[0] === "sketch:origin"), "the corner clicked on the origin is joined to it");
      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(`${analysis.classification}:${analysis.degreesOfFreedom}`, "fully-constrained:0", "fully constrained");
      equal(analysis.conflicts.length, 0, "nothing conflicts");
      equal(analysis.redundant.length, 0, "nothing is redundant");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "the project reloads");
      if (!reloaded.ok) return;
      equal(reloaded.value.sketch.entities.length, 4, "four lines after reload");
      equal(analyzeWorkbenchSketch(reloaded.value.sketch).classification, "fully-constrained", "still fully constrained after reload");
      // Editing the width through the dimension moves the far side only.
      const widthId = relations.find((relation) => relation.kind === "distance" && relation.valueMm === 80)!.id;
      assert(project.sketch.constraints.some((constraint) => constraint.id === widthId), "the width dimension is stored");
      const wider = pipelineRun(project, { kind: "set-sketch-dimension", entityId: shape.entities[0]!.id, dimension: "length", valueMm: 100 });
      const bottom = lineOf(wider, shape.entities[0]!.id);
      const right = lineOf(wider, shape.entities[1]!.id);
      near(Math.abs(bottom.end[0] - bottom.start[0]), 100, 1e-6, "the first side is 100 long");
      near(Math.min(bottom.start[0], bottom.end[0]), 0, 1e-6, "its origin corner stays on the origin");
      near(Math.abs(right.end[1] - right.start[1]), 50, 1e-6, "the height is unchanged");
      equal(detectSketchProfiles(wider.sketch).length, 1, "still one closed profile");
    }
  },
  {
    name: "A side of a drawn rectangle is an ordinary line: it can be deleted on its own, and a dragged corner only resizes the rectangle",
    run: () => {
      const { project, shape } = draw(emptySketch(), "rectangle", [{ point: [0, 0] }, { point: [40, 20] }]);
      const dragged = dragLiveSketch(project.sketch, { entityId: shape.entities[1]!.id, point: "end", positionMm: [55, 32] });
      assert(dragged.ok, `the drag solves: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const sides = shape.entities.map((side) => dragged.entities.find((entity) => entity.id === side.id)).filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity?.kind === "line");
      equal(sides.length, 4, "four lines after the drag");
      near(sides[0]!.start[1], sides[0]!.end[1], 1e-6, "the first side is still level");
      near(sides[1]!.start[0], sides[1]!.end[0], 1e-6, "the second side is still plumb");
      near(sides[1]!.end[0], 55, 1e-4, "the dragged corner followed the pointer in x");
      near(sides[1]!.end[1], 32, 1e-4, "and in y");
      near(sides[0]!.start[0], 0, 1e-4, "the opposite corner did not move in x");
      near(sides[0]!.start[1], 0, 1e-4, "nor in y");
      // Delete the top side: three lines are left, the outline is open and no relation names the deleted side.
      const top = shape.entities[2]!.id;
      const opened = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [top], updateEntities: [], addEntities: [], addConstraints: [], label: "Delete side" });
      equal(opened.sketch.entities.length, 3, "three lines remain");
      assert(opened.sketch.constraints.every((constraint) => !constraint.entityIds.includes(top)), "the relations of the deleted side went with it");
      equal(detectSketchProfiles(opened.sketch).length, 0, "the outline is open");
    }
  },
  {
    name: "Centre rectangle on the origin: two construction diagonals, the centre held by Midpoint, fully constrained with a typed width and height",
    run: () => {
      const { project, shape, relations } = draw(emptySketch(), "rectangle-center", [ORIGIN_SNAP, { point: [30, 20] }], { width: 60, height: 40 });
      equal(shape.entities.length, 6, "four sides and two diagonals");
      equal(shape.entities.filter((entity) => entity.construction).length, 2, "the diagonals are construction lines");
      const midpoint = relations.find((relation) => relation.kind === "midpoint");
      assert(midpoint !== undefined && midpoint.entityIds[0] === "sketch:origin" && midpoint.entityIds[1] === shape.entities[4]!.id, "the origin is the midpoint of a diagonal");
      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(`${analysis.classification}:${analysis.degreesOfFreedom}`, "fully-constrained:0", "fully constrained");
      equal(analysis.conflicts.length, 0, "nothing conflicts");
      equal(detectSketchProfiles(project.sketch).length, 1, "the diagonals do not split the profile");
      // Changing the width keeps the rectangle centred on the origin.
      const wider = pipelineRun(project, { kind: "set-sketch-dimension", entityId: shape.entities[0]!.id, dimension: "length", valueMm: 100 });
      const bottom = lineOf(wider, shape.entities[0]!.id);
      near(Math.min(bottom.start[0], bottom.end[0]), -50, 1e-6, "left edge at -50");
      near(Math.max(bottom.start[0], bottom.end[0]), 50, 1e-6, "right edge at 50");
      near(bottom.start[1], -20, 1e-6, "the height is unchanged");
      // Without a snap the centre is free and nothing is recorded for it.
      const loose = draw(emptySketch(), "rectangle-center", [{ point: [5, 5] }, { point: [30, 20] }], {}, "loose");
      assert(loose.relations.every((relation) => relation.kind !== "midpoint"), "no Midpoint without a snapped centre");
      equal(analyzeWorkbenchSketch(loose.project.sketch).degreesOfFreedom, 4, "position and size are free");
    }
  },
  {
    name: "3-point rectangle: four lines at the drawn angle, each side Perpendicular to the next; a typed edge and height become dimensions",
    run: () => {
      const { project, shape, relations } = draw(emptySketch(), "rectangle-three-point", [{ point: [0, 0] }, { point: [30, 30] }, { point: [20, 40] }], { length: Math.hypot(30, 30), height: Math.hypot(10, 10) });
      equal(shape.entities.length, 4, "four lines");
      equal(kinds(shape.constraints), "coincident,coincident,coincident,coincident,perpendicular,perpendicular,perpendicular", "joints and square corners");
      equal(relations.filter((relation) => relation.kind === "distance").length, 2, "the typed edge and height are dimensions");
      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(analysis.degreesOfFreedom, 3, "position and turn are free once the two sizes are dimensioned");
      equal(analysis.conflicts.length, 0, "nothing conflicts");
      equal(detectSketchProfiles(project.sketch).length, 1, "one closed profile");
      const height = lineOf(project, shape.entities[1]!.id);
      near(Math.hypot(height.end[0] - height.start[0], height.end[1] - height.start[1]), Math.hypot(10, 10), 1e-6, "the height is the third point's distance from the first edge");
      assert(!buildLineRectangle("rectangle-three-point", [[0, 0], [30, 30], [40, 40]], ids("bad")).ok, "a third point on the first edge is refused");
    }
  },
  {
    name: "A corner snapped to the end of an existing line is joined to it, and a rectangle entity saved by an older build still loads and solves",
    run: () => {
      let project = emptySketch();
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:edge", kind: "line", start: [-20, 0], end: [0, 0], construction: false }], addConstraints: [], label: "Line" });
      const endSnap: PlacedPointInference = { point: [0, 0], primary: { kind: "endpoint", point: [0, 0], entityId: "entity:edge", selector: "end", distanceMm: 0 } };
      const drawn = draw(project, "rectangle", [endSnap, { point: [25, 10] }]);
      const joint = drawn.relations.find((relation) => relation.kind === "coincident" && relation.entityIds.includes("entity:edge"));
      assert(joint !== undefined, "the first corner is joined to the end of the line");
      const moved = dragLiveSketch(drawn.project.sketch, { entityId: "entity:edge", point: "end", positionMm: [3, 4] });
      assert(moved.ok, "dragging the line end solves");
      if (moved.ok) {
        const first = moved.entities.find((entity) => entity.id === drawn.shape.entities[0]!.id);
        assert(first?.kind === "line", "the first side is there");
        if (first?.kind === "line") near(Math.hypot(first.start[0] - 3, first.start[1] - 4), 0, 1e-4, "the rectangle's corner went with the line end");
      }
      // The rectangle entity kind is not retired: a saved one keeps its geometry and its freedom.
      const old = pipelineRun(emptySketch(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("old", 10, 5, 40, 20)], addConstraints: [{ id: "constraint:old-w", kind: "distance", entityIds: ["entity:old"], valueMm: 40, dimension: "width" }], label: "Old rectangle" });
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(old));
      assert(reloaded.ok, "the old project reloads");
      if (!reloaded.ok) return;
      const entity = reloaded.value.sketch.entities.find((candidate) => candidate.id === "entity:old");
      assert(entity?.kind === "rectangle" && entity.widthMm === 40 && entity.heightMm === 20 && entity.center[0] === 10, "the rectangle entity is unchanged");
      equal(analyzeWorkbenchSketch(reloaded.value.sketch).degreesOfFreedom, analyzeWorkbenchSketch(old.sketch).degreesOfFreedom, "with the same freedom as before");
      equal(detectSketchProfiles(reloaded.value.sketch).length, 1, "and it is still a profile");
    }
  },
];
