import { DEFAULT_CURVE_TOOL_OPTIONS, buildCurveTool } from "../packages/workbench-sketch/src/curve-tools.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { SHAPE_CASES, arcRadius, dimension, dimensionEdits, dragAndCommit, editOutcomeProblem, everyHandle, projectWith, shapeIds, shapeProblem, worstJointGap } from "./sketch-shape-kit.js";

/**
 * Wave-2 regression suite for the app's parametric shapes (slot, rounded rectangle, regular polygon, parallelogram):
 * after every dimension edit, every kind of handle drag and a JSON round trip each one must stay closed, one profile, joints
 * at gap 0, and keep what makes it that shape (equal caps, tangent sides, equal sides on one circle, parallel sides).
 * The re-audit found slots and rounded rectangles torn apart (T02, S3, S18, UX N3) and polygons only equilateral (T01, T03, N3).
 */
export const sketchShapeJointTests: readonly TestCase[] = SHAPE_CASES.flatMap((shapeCase): TestCase[] => [
  {
    name: `${shapeCase.name}: is built closed with one profile and holds its shape`,
    run: () => {
      const project = projectWith(shapeCase.build());
      equal(shapeProblem(project.sketch, shapeCase.family), undefined, "the freshly placed shape");
    }
  },
  {
    name: `${shapeCase.name}: stays one closed profile through every dimension edit`,
    run: () => {
      const shape = shapeCase.build();
      const project = projectWith(shape);
      const edits = dimensionEdits(project, shapeCase.family, shape);
      assert(edits.length > 0, "there are dimensions to edit");
      for (const edit of edits) {
        const result = dimension(project, edit);
        assert(result.ok, `${edit.label} is accepted: ${result.ok ? "" : result.message}`);
        equal(shapeProblem(result.project.sketch, shapeCase.family), undefined, `after ${edit.label}`);
        equal(editOutcomeProblem(project.sketch, result.project.sketch, shapeCase.family, edit), undefined, `the outcome of ${edit.label}`);
      }
    }
  },
  {
    name: `${shapeCase.name}: stays one closed profile through a drag of every handle and every line body`,
    run: () => {
      const project = projectWith(shapeCase.build());
      const handles = everyHandle(project.sketch);
      assert(handles.length > 0, "there are handles");
      for (const grab of handles) {
        for (const delta of [[2.5, 1.5], [-3, 2]] as const) {
          const result = dragAndCommit(project, grab.entityId, grab.handle, grab.point, [grab.point[0] + delta[0], grab.point[1] + delta[1]]);
          // A handle that cannot move the shape (a refusal with a reason) is fine; one that moves it must keep it whole.
          if (!result.ok) continue;
          equal(shapeProblem(result.project.sketch, shapeCase.family), undefined, `after dragging ${grab.label} of ${grab.entityId} by ${delta.join(",")}`);
        }
      }
    }
  },
  {
    name: `${shapeCase.name}: drags are accepted, not refused, for the line ends`,
    run: () => {
      const project = projectWith(shapeCase.build());
      for (const grab of everyHandle(project.sketch).filter((candidate) => candidate.label === "line Line end" || candidate.label === "line Line start")) {
        const result = dragAndCommit(project, grab.entityId, grab.handle, grab.point, [grab.point[0] + 2.5, grab.point[1] + 1.5]);
        assert(result.ok, `dragging ${grab.label} of ${grab.entityId} is accepted: ${result.ok ? "" : result.message}`);
      }
    }
  },
  {
    name: `${shapeCase.name}: survives a JSON round trip and is still editable`,
    run: () => {
      const shape = shapeCase.build();
      const original = projectWith(shape);
      const reloaded = JSON.parse(JSON.stringify(original)) as typeof original;
      equal(shapeProblem(reloaded.sketch, shapeCase.family), undefined, "the reloaded shape");
      const edits = dimensionEdits(reloaded, shapeCase.family, shape);
      const first = edits[0]!;
      const result = dimension(reloaded, first);
      assert(result.ok, `${first.label} is accepted after reload: ${result.ok ? "" : result.message}`);
      equal(shapeProblem(result.project.sketch, shapeCase.family), undefined, "after a dimension edit of the reloaded shape");
      const handle = everyHandle(result.project.sketch)[0]!;
      const dragged = dragAndCommit(result.project, handle.entityId, handle.handle, handle.point, [handle.point[0] + 1, handle.point[1] + 1]);
      if (dragged.ok) equal(shapeProblem(dragged.project.sketch, shapeCase.family), undefined, "after a drag of the reloaded shape");
      const again = JSON.parse(JSON.stringify(result.project)) as typeof original;
      equal(shapeProblem(again.sketch, shapeCase.family), undefined, "after a second round trip");
    }
  }
]);

/** The curved slots carry the same joints now: they stay one closed profile through a radius edit and a drag of every handle. */
export const sketchArcSlotJointTests: readonly TestCase[] = ([
  ["slot-arc-three-point", [[0, 0], [10, 6], [20, 0], [10, 9]]],
  ["slot-arc-center", [[0, 0], [10, 0], [0, 10], [11, 4]]]
] as const).map(([tool, points]): TestCase => ({
  name: `Curve creation T02: a ${tool} arc slot stays one closed profile through radius edits and handle drags`,
  run: () => {
    const built = buildCurveTool(tool, points as never, DEFAULT_CURVE_TOOL_OPTIONS, shapeIds());
    assert(built.ok, "the arc slot builds");
    const project = projectWith(built.value);
    equal(built.value.constraints.filter((constraint) => constraint.kind === "coincident").length, 4, "four joints");
    for (const arc of project.sketch.entities.filter((entity) => entity.kind === "arc")) {
      const edited = dimension(project, { entityId: arc.id, dimension: "radius", valueMm: arcRadius(arc)! * 0.8 });
      assert(edited.ok, `radius edit of ${arc.id}: ${edited.ok ? "" : edited.message}`);
      equal(detectSketchProfiles(edited.project.sketch).length, 1, "one profile after the radius edit");
      assert(worstJointGap(edited.project.sketch) < 1e-6, "joints closed after the radius edit");
    }
    for (const grab of everyHandle(project.sketch)) {
      const dragged = dragAndCommit(project, grab.entityId, grab.handle, grab.point, [grab.point[0] + 2.5, grab.point[1] + 1.5]);
      if (!dragged.ok) continue;
      equal(detectSketchProfiles(dragged.project.sketch).length, 1, `one profile after dragging ${grab.label}`);
      assert(worstJointGap(dragged.project.sketch) < 1e-6, `joints closed after dragging ${grab.label}`);
    }
  }
}));
