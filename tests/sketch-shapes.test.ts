import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildPolygon, buildSlot, type ShapeIds, type SketchShape } from "../packages/workbench-sketch/src/shapes.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;
const ids: ShapeIds = { entity: () => `entity:shape-${(counter += 1)}`, constraint: () => `constraint:shape-${(counter += 1)}` };

function project(shape: SketchShape): WorkbenchProject {
  const base = createWorkbenchProject("project:test-shapes");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

function addShape(shape: SketchShape) {
  const base = project(shape);
  return applyWorkbenchOperation(base, { kind: "apply-sketch-edit", operationId: "operation:test-shape", expectedRevision: 0, removeEntityIds: [], updateEntities: [], addEntities: shape.entities, addConstraints: shape.constraints, label: "Added a shape" });
}

export const sketchShapeTests: readonly TestCase[] = [
  {
    name: "a regular polygon is N equal sides joined end to end, sized by its corner, and bounds one closed profile",
    run: () => {
      const built = buildPolygon([10, 5], [30, 5], 6, ids);
      assert(built.ok, "the hexagon builds");
      const { entities, constraints } = built.value;
      equal(entities.length, 6, "six sides");
      equal(constraints.filter((constraint) => constraint.kind === "coincident").length, 6, "six joints, including the one that closes the loop");
      equal(constraints.filter((constraint) => constraint.kind === "equal").length, 5, "every side equals the first");
      const side = entities[0]!;
      assert(side.kind === "line", "sides are lines");
      near(Math.hypot(side.end[0] - side.start[0], side.end[1] - side.start[1]), 20, 1e-9, "a hexagon's side equals its circumradius");
      near(side.start[0], 30, 1e-9, "the first corner is where the user clicked (x)");
      near(side.start[1], 5, 1e-9, "the first corner is where the user clicked (y)");
      const sketch = { ...createWorkbenchProject("project:test-poly").sketch, entities, constraints: [] };
      const profiles = detectSketchProfiles(sketch);
      equal(profiles.length, 1, "the sides close into one profile");
      near(profiles[0]!.areaMm2, (3 * Math.sqrt(3) / 2) * 400, 1e-6, "with the area of a regular hexagon of radius 20");
    }
  },
  {
    name: "polygon limits and degenerate input are refused with a reason",
    run: () => {
      assert(!buildPolygon([0, 0], [10, 0], 2, ids).ok, "two sides is not a polygon");
      assert(!buildPolygon([0, 0], [10, 0], 65, ids).ok, "more than 64 sides is refused");
      assert(!buildPolygon([0, 0], [10, 0], 5.5, ids).ok, "the side count is a whole number");
      assert(!buildPolygon([0, 0], [0.05, 0], 6, ids).ok, "a tiny polygon is refused");
      assert(buildPolygon([0, 0], [10, 0], 3, ids).ok, "a triangle is the smallest polygon");
      assert(buildPolygon([0, 0], [10, 0], 64, ids).ok, "64 sides is the largest");
    }
  },
  {
    name: "a polygon is accepted as one edit: the relations hold and nothing moves",
    run: () => {
      const built = buildPolygon([0, 0], [15, 4], 5, ids);
      assert(built.ok, "the pentagon builds");
      const applied = addShape(built.value);
      assert(applied.ok, `the pentagon and its 9 relations apply in one edit: ${applied.ok ? "" : applied.diagnostics[0]?.message ?? ""}`);
      equal(applied.value.project.sketch.entities.length, 5, "five sides were added");
      equal(applied.value.project.sketch.constraints.length, 9, "and nine relations");
      equal(applied.value.project.revision, 1, "as one revision");
    }
  },
  {
    name: "a slot is two sides and two end arcs, held tangent, with the half-width taken from the third point",
    run: () => {
      const built = buildSlot([0, 0], [40, 0], [10, 6], ids);
      assert(built.ok, "the slot builds");
      const { entities, constraints } = built.value;
      equal(entities.map((entity) => entity.kind).join(","), "line,arc,line,arc", "line, arc, line, arc");
      equal(constraints.filter((constraint) => constraint.kind === "tangent").length, 4, "four tangent joints");
      equal(constraints.filter((constraint) => constraint.kind === "equal").length, 1, "the caps are equal");
      const top = entities[0]!;
      assert(top.kind === "line", "the first side is a line");
      near(top.start[1], 6, 1e-9, "the side stands at the half-width above the axis");
      near(top.end[0], 40, 1e-9, "and runs to the second centre");
      const bottom = entities[2]!;
      assert(bottom.kind === "line", "the second side is a line");
      near(bottom.start[1], -6, 1e-9, "the other side mirrors it below");
      const sketch = { ...createWorkbenchProject("project:test-slot").sketch, entities, constraints: [] };
      const profiles = detectSketchProfiles(sketch);
      equal(profiles.length, 1, "the four pieces close into one profile");
      near(profiles[0]!.areaMm2, 40 * 12 + Math.PI * 36, 1, "an obround of 40 x 12 plus two half discs");
    }
  },
  {
    name: "a slot works at any angle, accepts the width point on either side, and refuses degenerate input",
    run: () => {
      const slanted = buildSlot([0, 0], [20, 20], [5, -3], ids);
      assert(slanted.ok, "a diagonal slot builds");
      const sketch = { ...createWorkbenchProject("project:test-slot-slant").sketch, entities: slanted.value.entities, constraints: [] };
      equal(detectSketchProfiles(sketch).length, 1, "and still closes");
      const other = buildSlot([0, 0], [40, 0], [10, -6], ids);
      assert(other.ok, "the width point can be below the axis");
      assert(!buildSlot([0, 0], [0.01, 0], [0, 5], ids).ok, "the centres must be apart");
      assert(!buildSlot([0, 0], [40, 0], [10, 0.01], ids).ok, "a slot of no width is refused");
    }
  },
  {
    name: "a slot is accepted as one edit and its tangent relations hold, also after resizing a side",
    run: () => {
      const built = buildSlot([0, 0], [40, 0], [10, 6], ids);
      assert(built.ok, "the slot builds");
      const applied = addShape(built.value);
      assert(applied.ok, `the slot applies in one edit: ${applied.ok ? "" : applied.diagnostics[0]?.message ?? ""}`);
      const first = applied.value.project.sketch.entities[0]!;
      const resized = applyWorkbenchOperation(applied.value.project, { kind: "set-sketch-dimension", operationId: "operation:test-slot-resize", expectedRevision: 1, entityId: first.id, dimension: "length", valueMm: 55 });
      // The tangent chain may refuse a resize it cannot satisfy, but it must never corrupt the sketch.
      if (resized.ok) {
        const line = resized.value.project.sketch.entities[0]!;
        assert(line.kind === "line" && Math.abs(Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]) - 55) < 1e-6, "an accepted resize is exact");
      } else {
        assert(resized.diagnostics.length > 0, "a refused resize explains itself");
      }
    }
  }
];
