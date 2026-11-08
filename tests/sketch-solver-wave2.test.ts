import { dragSketchHandle } from "../packages/workbench-sketch/src/drag.js";
import { buildParallelogram } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { assert, near, type TestCase } from "./test-kit.js";
import {
  addConstraint, circle, get, line, lengthOf, point, projectWith, rect, rel, run, setDimension,
  type Line, type Rect, type Vec
} from "./sketch-solver-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

/**
 * Wave 2 regression tests for the sketch solver: each reproduces a repro from the re-audit of the merged build (Constraint solver section,
 * issues N1 to N11 and the S3/S8/S16 rechecks; the engineer-gap and edit-tools issues about redundancy) through the real code path.
 */

function shapeIds(prefix: string): { entity: () => string; constraint: () => string } {
  let n = 0;
  return { entity: () => `entity:${prefix}-${++n}`, constraint: () => `constraint:${prefix}-${++n}` };
}

const polygon = (points: readonly Vec[]): WorkbenchProject => {
  const count = points.length;
  const entities = points.map((start, index) => line(`p${index}`, start, points[(index + 1) % count]!));
  const constraints = points.map((_, index) => rel("coincident", [`p${index}`, `p${(index + 1) % count}`], { points: ["end", "start"] }));
  return projectWith(entities, constraints);
};

const open = (points: readonly Vec[]): WorkbenchProject => {
  const entities = points.slice(0, -1).map((start, index) => line(`p${index}`, start, points[index + 1]!));
  const constraints = entities.slice(1).map((_, index) => rel("coincident", [`p${index}`, `p${index + 1}`], { points: ["end", "start"] }));
  return projectWith(entities, constraints);
};

const lineAt = (project: WorkbenchProject, name: string): Line => get(project, name, "line");

/** Polygon area from each line's start (the lines are joined end to start). */
const areaOf = (project: WorkbenchProject): number => {
  const starts = project.sketch.entities.filter((entity): entity is Line => entity.kind === "line").map((entity) => entity.start);
  let sum = 0;
  starts.forEach((a, index) => {
    const b = starts[(index + 1) % starts.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  });
  return Math.abs(sum) / 2;
};

const joined = (project: WorkbenchProject): boolean => {
  const lines = project.sketch.entities.filter((entity): entity is Line => entity.kind === "line");
  return lines.every((entity, index) => {
    const next = lines[(index + 1) % lines.length]!;
    return Math.hypot(entity.end[0] - next.start[0], entity.end[1] - next.start[1]) < 1e-6;
  });
};

const samePoint = (actual: Vec, expected: Vec, message: string, tolerance = 1e-6): void => {
  near(actual[0], expected[0], tolerance, `${message} (x)`);
  near(actual[1], expected[1], tolerance, `${message} (y)`);
};

export const sketchSolverWave2Tests: readonly TestCase[] = [
  {
    name: "Re-audit solver N1: editing one side of a plain joined triangle, trapezoid or quad keeps the other vertices and the shape",
    run: () => {
      const triangle = polygon([[0, 0], [10, 0], [5, 8]]);
      for (const side of [20, 30, 5]) {
        const edited = setDimension(triangle, "p0", "length", side);
        near(lengthOf(lineAt(edited, "p0")), side, 1e-9, `the edited side is ${side}`);
        near(areaOf(edited), side * 4, 1e-6, `the triangle keeps its apex, so its area is base * height / 2 (${side})`);
        samePoint(lineAt(edited, "p1").end, [5, 8], "the apex did not move");
        assert(joined(edited), "and the triangle stays closed");
      }
      const trapezoid = polygon([[0, 0], [40, 0], [32, 20], [8, 20]]);
      for (const base of [70, 80, 100]) {
        const edited = setDimension(trapezoid, "p0", "length", base);
        near(lengthOf(lineAt(edited, "p0")), base, 1e-9, `the base is ${base}`);
        samePoint(lineAt(edited, "p1").end, [32, 20], `the top right vertex stayed (base ${base})`);
        samePoint(lineAt(edited, "p2").end, [8, 20], "and so did the top left one");
        assert(areaOf(edited) > 600, `the trapezoid kept its height, area ${areaOf(edited)} (base ${base})`);
      }
      const quad = polygon([[0, 0], [40, 5], [35, 30], [-5, 25]]);
      for (const side of [10, 50]) {
        const edited = setDimension(quad, "p2", "length", side);
        near(lengthOf(lineAt(edited, "p2")), side, 1e-9, `the third side is ${side}`);
        assert(areaOf(edited) > 500, `the quad is still a quad, area ${areaOf(edited)} (side ${side})`);
        samePoint(lineAt(edited, "p0").end, [40, 5], "an untouched vertex stayed");
      }
    }
  },
  {
    name: "Re-audit solver N2: an edit on an open polyline, a parallelogram or a trapezoid moves only the neighbour and keeps the shape's character",
    run: () => {
      const polyline = open([[0, 0], [10, 0], [10, 10], [20, 10], [20, 20]]);
      const longer = setDimension(polyline, "p0", "length", 30);
      samePoint(lineAt(longer, "p1").end, [10, 10], "p0 = 30: the far end of p1 stays");
      samePoint(lineAt(longer, "p2").end, [20, 10], "the p2/p3 joint stays where it was");
      samePoint(lineAt(longer, "p3").end, [20, 20], "and so does the last vertex");
      const taller = setDimension(polyline, "p1", "length", 25);
      samePoint(lineAt(taller, "p1").end, [10, 25], "p1 = 25 grows along its own direction");
      samePoint(lineAt(taller, "p2").end, [20, 10], "the p2/p3 joint stays where it was");
      samePoint(lineAt(taller, "p3").end, [20, 20], "and the last vertex too");

      const shapes = buildParallelogram([0, 0], [30, 0], [40, 15], shapeIds("pg"));
      assert(shapes.ok, "the parallelogram builds");
      if (!shapes.ok) return;
      const parallelogram = projectWith(shapes.value.entities, shapes.value.constraints);
      const first = shapes.value.entities[0]!.id.replace("entity:", "");
      const slanted = shapes.value.entities[1] as Line;
      const before = Math.atan2(slanted.end[1] - slanted.start[1], slanted.end[0] - slanted.start[0]);
      const edited = setDimension(parallelogram, first, "length", 50);
      const side = get(edited, shapes.value.entities[1]!.id.replace("entity:", ""), "line");
      const after = Math.atan2(side.end[1] - side.start[1], side.end[0] - side.start[0]);
      near(after, before, 1e-6, "the slanted side keeps its direction: the parallelogram does not turn into a rectangle");
      near(lengthOf(get(edited, first, "line")), 50, 1e-9, "and the base took 50");

      const trapezoid = polygon([[0, 0], [40, 0], [32, 20], [8, 20]]);
      const wider = setDimension(trapezoid, "p0", "length", 60);
      near(lineAt(wider, "p1").end[1], 20, 1e-6, "the trapezoid keeps its height 20 (it did not drop to 11.8)");
    }
  },
  {
    name: "Re-audit solver N3: a rectangle entity with a pinned corner is resized by a dimension without turning or stretching",
    run: () => {
      const plate = projectWith([rect("r", [50, 30], 100, 60)]);
      const pinned = addConstraint(plate, rel("fixed", ["r"], { points: ["corner-0"] }));
      const expectFrame = (project: WorkbenchProject, center: Vec, width: number, height: number, message: string): void => {
        const r = get(project, "r", "rectangle") as Rect;
        samePoint(r.center, center, `${message}: centre`, 1e-6);
        near(r.widthMm, width, 1e-6, `${message}: width`);
        near(r.heightMm, height, 1e-6, `${message}: height`);
        near(r.rotationDeg, 0, 1e-6, `${message}: no rotation`);
      };
      expectFrame(setDimension(pinned, "r", "height", 30), [50, 15], 100, 30, "point-fixed corner, height 30");
      expectFrame(setDimension(pinned, "r", "height", 20), [50, 10], 100, 20, "height 20");
      expectFrame(setDimension(pinned, "r", "width", 40), [20, 30], 40, 60, "width 40");
      expectFrame(setDimension(pinned, "r", "width", 140), [70, 30], 140, 60, "width 140");
    }
  },
  {
    name: "Re-audit solver N3: a rectangle whose corner sits on the origin keeps its frame through 20 width edits",
    run: () => {
      const plate = projectWith([rect("r", [50, 30], 100, 60)]);
      let project = addConstraint(plate, { id: "constraint:origin-corner", kind: "coincident", entityIds: ["sketch:origin", "entity:r"], points: ["self", "corner-0"] });
      project = setDimension(project, "r", "width", 140);
      let r = get(project, "r", "rectangle") as Rect;
      samePoint(r.center, [70, 30], "width 140 grows toward +x", 1e-6);
      near(r.rotationDeg, 0, 1e-6, "no rotation");
      near(r.heightMm, 60, 1e-6, "the height did not change");
      for (let index = 0; index < 20; index += 1) project = setDimension(project, "r", "width", index % 2 === 0 ? 100 : 140);
      r = get(project, "r", "rectangle") as Rect;
      near(r.rotationDeg, 0, 1e-6, "twenty width toggles leave the rectangle level");
      near(r.heightMm, 60, 1e-6, "and its height unchanged");
      project = setDimension(project, "r", "width", 100);
      project = setDimension(project, "r", "height", 30);
      r = get(project, "r", "rectangle") as Rect;
      samePoint(r.center, [50, 15], "height 30 keeps the corner on the origin", 1e-6);
      near(r.widthMm, 100, 1e-6, "and the width");
      near(r.rotationDeg, 0, 1e-6, "and the turn");
    }
  },
  {
    name: "Re-audit solver S16: a dimensioned rectangle dragged by a corner holds its size and does not turn",
    run: () => {
      let project = projectWith([rect("r", [50, 30], 100, 60)]);
      project = setDimension(project, "r", "width", 100);
      project = setDimension(project, "r", "height", 60);
      for (const target of [[100, 0], [130, 95], [60, 40], [80, 50]] as const) {
        const dragged = dragSketchHandle(project.sketch, "entity:r", { kind: "corner", index: 2 }, [100, 60], target);
        assert(dragged.ok, "the corner drag works");
        if (!dragged.ok) continue;
        const r = dragged.entities[0] as Rect;
        near(r.rotationDeg, 0, 1e-9, `no rotation after dragging to ${target.join(",")}`);
        near(r.widthMm, 100, 1e-9, "the width holds");
        near(r.heightMm, 60, 1e-9, "the height holds");
        samePoint([r.center[0] + 50, r.center[1] + 30], target, "and the corner is under the pointer", 1e-9);
      }
      let sketch = project.sketch;
      let at: Vec = [100, 60];
      for (let index = 0; index < 10; index += 1) {
        const next: Vec = [at[0] + 7, at[1] + 3];
        const dragged = dragSketchHandle(sketch, "entity:r", { kind: "corner", index: 2 }, at, next);
        assert(dragged.ok, "a small drag works");
        if (!dragged.ok) return;
        sketch = { ...sketch, entities: dragged.entities };
        at = next;
      }
      near((sketch.entities[0] as Rect).rotationDeg, 0, 1e-9, "ten small drags do not accumulate any turn");
    }
  },
  {
    name: "Re-audit solver N3: a line-built shape pinned with a point and a circle still solve (regression guard for the stiffer rectangle)",
    run: () => {
      const project = projectWith([rect("r", [0, 0], 20, 10), circle("c", [0, 0], 3), point("p", [30, 30])], [rel("coincident", ["c", "r"], { points: ["center", "center"] })]);
      const moved = run(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 40 });
      near(get(moved, "c", "circle").center[0], get(moved, "r", "rectangle").center[0], 1e-9, "the concentric circle follows the rectangle");
    }
  }
];
