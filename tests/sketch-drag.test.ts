import type { SketchEntity, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { dragSketchHandle, grabHandlesOf, type DragHandle } from "../packages/workbench-sketch/src/drag.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

function sketchOf(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-drag").sketch, entities, constraints };
}

function drag(sketch: WorkbenchSketch, id: string, handle: DragHandle, from: Vec2, to: Vec2) {
  const result = dragSketchHandle(sketch, id, handle, from, to);
  assert(result.ok, `the drag is accepted: ${result.ok ? "" : result.message}`);
  return result;
}

function lineOf(entities: readonly SketchEntity[], id: string): Extract<SketchEntity, { kind: "line" }> {
  const found = entities.find((entity) => entity.id === id);
  assert(found?.kind === "line", `${id} is a line`);
  return found;
}

export const sketchDragTests: readonly TestCase[] = [
  {
    name: "dragging a free line end moves only that end and never touches the input sketch",
    run: () => {
      const sketch = sketchOf([line("e:a", [0, 0], [10, 0])]);
      const snapshot = JSON.stringify(sketch);
      const moved = drag(sketch, "e:a", { kind: "point", ref: "end" }, [10, 0], [14, 7]);
      const a = lineOf(moved.entities, "e:a");
      near(a.start[0], 0, 1e-9, "the start stays");
      near(a.end[0], 14, 1e-9, "the end follows the pointer (x)");
      near(a.end[1], 7, 1e-9, "the end follows the pointer (y)");
      equal(JSON.stringify(sketch), snapshot, "the original sketch is untouched");
    }
  },
  {
    name: "dragging the middle of a line translates it and keeps its length and direction",
    run: () => {
      const sketch = sketchOf([line("e:a", [0, 0], [12, 5])]);
      const moved = drag(sketch, "e:a", { kind: "body" }, [6, 2.5], [10, -3.5]);
      const a = lineOf(moved.entities, "e:a");
      near(a.end[0] - a.start[0], 12, 1e-9, "the same run");
      near(a.end[1] - a.start[1], 5, 1e-9, "the same rise");
      near(a.start[0], 4, 1e-9, "shifted by the pointer delta (x)");
      near(a.start[1], -6, 1e-9, "shifted by the pointer delta (y)");
    }
  },
  {
    name: "a joint follows the dragged end from either side, because the dragged point is pinned while the relations relax",
    run: () => {
      const joint: WorkbenchSketchConstraint = { id: "constraint:joint", kind: "coincident", entityIds: ["e:a", "e:b"], points: ["end", "start"] };
      const sketch = sketchOf([line("e:a", [0, 0], [10, 0]), line("e:b", [10, 0], [20, 8])], [joint]);
      // Drag the first line's end: the second line's start follows.
      const fromFirst = drag(sketch, "e:a", { kind: "point", ref: "end" }, [10, 0], [12, 4]);
      near(lineOf(fromFirst.entities, "e:b").start[0], 12, 1e-9, "B's start follows A's end (x)");
      near(lineOf(fromFirst.entities, "e:b").start[1], 4, 1e-9, "B's start follows A's end (y)");
      near(lineOf(fromFirst.entities, "e:b").end[0], 20, 1e-9, "B's far end stays");
      // Drag the second line's start (the point that would normally be the one to move onto the first): the first line's end follows it.
      const fromSecond = drag(sketch, "e:b", { kind: "point", ref: "start" }, [10, 0], [9, -3]);
      near(lineOf(fromSecond.entities, "e:b").start[0], 9, 1e-9, "the dragged point stays where the pointer put it (x)");
      near(lineOf(fromSecond.entities, "e:b").start[1], -3, 1e-9, "the dragged point stays where the pointer put it (y)");
      near(lineOf(fromSecond.entities, "e:a").end[0], 9, 1e-9, "A's end follows (x)");
      near(lineOf(fromSecond.entities, "e:a").end[1], -3, 1e-9, "A's end follows (y)");
      near(lineOf(fromSecond.entities, "e:a").start[0], 0, 1e-9, "A's start stays");
    }
  },
  {
    name: "a Horizontal line stays horizontal while an end is dragged, and a Fixed curve refuses to move",
    run: () => {
      const horizontal: WorkbenchSketchConstraint = { id: "constraint:h", kind: "horizontal", entityIds: ["e:a"] };
      const sketch = sketchOf([line("e:a", [0, 0], [10, 0])], [horizontal]);
      const moved = drag(sketch, "e:a", { kind: "point", ref: "end" }, [10, 0], [16, 5]);
      const a = lineOf(moved.entities, "e:a");
      near(a.end[0], 16, 1e-9, "the end moves along x");
      near(a.start[1], a.end[1], 1e-9, "the line is still level");

      const pinned = sketchOf([line("e:a", [0, 0], [10, 0])], [{ id: "constraint:fix", kind: "fixed", entityIds: ["e:a"] }]);
      const refused = dragSketchHandle(pinned, "e:a", { kind: "point", ref: "end" }, [10, 0], [14, 3]);
      assert(!refused.ok, "a Fixed line does not move");
      const refusedBody = dragSketchHandle(pinned, "e:a", { kind: "body" }, [5, 0], [9, 3]);
      assert(!refusedBody.ok, "nor does it translate");
    }
  },
  {
    name: "circles: the centre moves the circle, the radius handle resizes it, and an equal-radius twin resizes too",
    run: () => {
      const twin: WorkbenchSketchConstraint = { id: "constraint:equal", kind: "equal", entityIds: ["e:c1", "e:c2"] };
      const sketch = sketchOf([circle("e:c1", [0, 0], 5), circle("e:c2", [30, 0], 5)], [twin]);
      const moved = drag(sketch, "e:c1", { kind: "point", ref: "center" }, [0, 0], [3, 4]);
      const c1 = moved.entities.find((entity) => entity.id === "e:c1");
      assert(c1?.kind === "circle" && c1.center[0] === 3 && c1.center[1] === 4, "the circle follows the pointer");
      const resized = drag(sketch, "e:c1", { kind: "radius" }, [5, 0], [8, 0]);
      const first = resized.entities.find((entity) => entity.id === "e:c1");
      const second = resized.entities.find((entity) => entity.id === "e:c2");
      assert(first?.kind === "circle" && Math.abs(first.radiusMm - 8) < 1e-9, "the dragged circle takes the new radius");
      assert(second?.kind === "circle" && Math.abs(second.radiusMm - 8) < 1e-9, "its Equal twin follows");
      const body = drag(sketch, "e:c2", { kind: "body" }, [30, 0], [34, -2]);
      const shifted = body.entities.find((entity) => entity.id === "e:c2");
      assert(shifted?.kind === "circle" && shifted.center[0] === 34 && shifted.center[1] === -2, "dragging the outline body moves the circle by the pointer delta");
      assert(!dragSketchHandle(sketch, "e:c1", { kind: "radius" }, [5, 0], [0, 0]).ok, "a zero radius is refused");
    }
  },
  {
    name: "arcs: the centre moves the arc, an end reshapes it, and three collinear points are refused",
    run: () => {
      const r = 10;
      const arc: SketchEntity = { id: "e:arc", kind: "arc", start: [r, 0], mid: [r * Math.SQRT1_2, r * Math.SQRT1_2], end: [0, r], construction: false };
      const sketch = sketchOf([arc]);
      const [centreHandle] = grabHandlesOf(arc).filter((handle) => handle.id.endsWith(":center"));
      assert(centreHandle !== undefined, "an arc offers its centre");
      near(centreHandle.point[0], 0, 1e-9, "the centre is where the circle through the three points says (x)");
      const moved = drag(sketch, "e:arc", { kind: "point", ref: "center" }, [0, 0], [5, 5]);
      const shifted = moved.entities.find((entity) => entity.id === "e:arc");
      assert(shifted?.kind === "arc" && Math.abs(shifted.start[0] - (r + 5)) < 1e-9 && Math.abs(shifted.start[1] - 5) < 1e-9, "the whole arc moved with its centre");
      const reshaped = drag(sketch, "e:arc", { kind: "arc-point", which: "end" }, [0, r], [-6, 8]);
      const bent = reshaped.entities.find((entity) => entity.id === "e:arc");
      assert(bent?.kind === "arc" && bent.end[0] === -6 && bent.end[1] === 8 && bent.start[0] === r, "only the dragged end changed");
      // Start (r, 0), middle (0.707r, 0.707r) and an end on the same straight line through them.
      const straight = dragSketchHandle(sketch, "e:arc", { kind: "arc-point", which: "end" }, [0, r], [r + 2 * (r * Math.SQRT1_2 - r), 2 * r * Math.SQRT1_2]);
      assert(!straight.ok, "three points in a line do not make an arc");
    }
  },
  {
    name: "rectangles move as a block and a corner resizes about the opposite corner, also when rotated",
    run: () => {
      const rect: SketchEntity = { id: "e:r", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const sketch = sketchOf([rect]);
      const moved = drag(sketch, "e:r", { kind: "body" }, [0, 0], [5, -2]);
      const shifted = moved.entities.find((entity) => entity.id === "e:r");
      assert(shifted?.kind === "rectangle" && shifted.center[0] === 5 && shifted.center[1] === -2 && shifted.widthMm === 20, "the rectangle moved by the pointer delta");
      // Corner 2 is the top right (10, 5); drag it to (20, 15): the opposite corner (-10, -5) stays.
      const grown = drag(sketch, "e:r", { kind: "corner", index: 2 }, [10, 5], [20, 15]);
      const big = grown.entities.find((entity) => entity.id === "e:r");
      assert(big?.kind === "rectangle", "still a rectangle");
      near(big.widthMm, 30, 1e-9, "wider");
      near(big.heightMm, 20, 1e-9, "taller");
      near(big.center[0], 5, 1e-9, "centre moved to keep the opposite corner (x)");
      near(big.center[1], 5, 1e-9, "centre moved to keep the opposite corner (y)");
      // Rotated by 90 degrees: width runs along +Y.
      const turned: SketchEntity = { ...rect, id: "e:t", rotationDeg: 90 };
      const resized = drag(sketchOf([turned]), "e:t", { kind: "corner", index: 2 }, [-5, 10], [-5, 20]);
      const stretched = resized.entities.find((entity) => entity.id === "e:t");
      assert(stretched?.kind === "rectangle", "still a rectangle");
      near(stretched.widthMm, 30, 1e-9, "the rotated width grew along its own axis");
      near(stretched.heightMm, 10, 1e-9, "the other side is unchanged");
      assert(!dragSketchHandle(sketch, "e:r", { kind: "corner", index: 2 }, [10, 5], [-10, 5]).ok, "collapsing a side is refused");
    }
  },
  {
    name: "splines move by a fit point or as a whole, and fixed or unknown targets are refused politely",
    run: () => {
      const spline: SketchEntity = { id: "e:s", kind: "spline", fitPoints: [[0, 0], [10, 10], [20, 0]], construction: false };
      const sketch = sketchOf([spline]);
      const moved = drag(sketch, "e:s", { kind: "fit", index: 1 }, [10, 10], [10, 16]);
      const a = moved.entities.find((entity) => entity.id === "e:s");
      assert(a?.kind === "spline" && a.fitPoints[1]![1] === 16 && a.fitPoints[0]![1] === 0, "only the fit point moved");
      const whole = drag(sketch, "e:s", { kind: "body" }, [10, 5], [13, 1]);
      const b = whole.entities.find((entity) => entity.id === "e:s");
      assert(b?.kind === "spline" && b.fitPoints[0]![0] === 3 && b.fitPoints[2]![1] === -4, "every fit point shifted");
      assert(!dragSketchHandle(sketch, "e:missing", { kind: "body" }, [0, 0], [1, 1]).ok, "a deleted curve cannot be dragged");
      assert(!dragSketchHandle(sketch, "e:s", { kind: "radius" }, [0, 0], [1, 1]).ok, "a spline has no radius handle");
    }
  },
  {
    name: "each curve offers the grab handles Fusion users expect",
    run: () => {
      equal(grabHandlesOf(line("e:l", [0, 0], [5, 0])).map((handle) => handle.id.split(":").at(-1)).join(","), "start,end", "a line offers its two ends");
      equal(grabHandlesOf(circle("e:c", [0, 0], 4)).map((handle) => handle.id.split(":").at(-1)).join(","), "center,radius", "a circle offers centre and radius");
      equal(grabHandlesOf({ id: "e:r", kind: "rectangle", center: [0, 0], widthMm: 4, heightMm: 2, rotationDeg: 0, construction: false }).length, 4, "a rectangle offers four corners");
      equal(grabHandlesOf({ id: "e:p", kind: "point", point: [1, 1], construction: false }).length, 1, "a point offers itself");
      equal(grabHandlesOf({ id: "e:s", kind: "spline", fitPoints: [[0, 0], [1, 1], [2, 0], [3, 1]], construction: false }).length, 4, "a spline offers every fit point");
    }
  },
  {
    name: "a dragged sketch is accepted as one edit by the project: no relation is left unsatisfied",
    run: () => {
      const base = createWorkbenchProject("project:test-drag-commit");
      const joint: WorkbenchSketchConstraint = { id: "constraint:joint", kind: "coincident", entityIds: ["e:a", "e:b"], points: ["end", "start"] };
      const project = { ...base, sketch: { ...base.sketch, entities: [line("e:a", [0, 0], [10, 0]), line("e:b", [10, 0], [20, 8])], constraints: [joint] } };
      const moved = drag(project.sketch, "e:b", { kind: "point", ref: "start" }, [10, 0], [9, -3]);
      const changedEntities = moved.entities.filter((entity, index) => entity !== project.sketch.entities[index]);
      const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: "operation:test-drag-commit", expectedRevision: 0, removeEntityIds: [], updateEntities: changedEntities, addEntities: [], addConstraints: [], label: "Moved a joint" });
      assert(applied.ok, `the committed edit is accepted: ${applied.ok ? "" : applied.diagnostics[0]?.message ?? ""}`);
      equal(applied.value.project.revision, 1, "one drag is one revision");
    }
  }
];
