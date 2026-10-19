import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  type SketchEntity,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;

function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-solver");
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

function line(id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity {
  return { id: `entity:${id}`, kind: "line", start, end, construction: false };
}

function circle(id: string, center: readonly [number, number], radiusMm: number): SketchEntity {
  return { id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false };
}

function constrain(project: WorkbenchProject, kind: WorkbenchSketchConstraint["kind"], ids: readonly string[]) {
  serial += 1;
  const operation: WorkbenchOperation = {
    kind: "add-sketch-constraint",
    operationId: `operation:test-solve-${serial}`,
    expectedRevision: project.revision,
    constraint: { id: `constraint:test-${serial}`, kind, entityIds: ids.map((id) => `entity:${id}`) }
  };
  return applyWorkbenchOperation(project, operation);
}

function entity(project: WorkbenchProject, id: string): SketchEntity {
  const found = project.sketch.entities.find((candidate) => candidate.id === `entity:${id}`);
  if (found === undefined) throw new Error(`missing entity ${id}`);
  return found;
}

function lineOf(project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "line" }> {
  const found = entity(project, id);
  if (found.kind !== "line") throw new Error("not a line");
  return found;
}

function circleOf(project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "circle" }> {
  const found = entity(project, id);
  if (found.kind !== "circle") throw new Error("not a circle");
  return found;
}

function arcOf(project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "arc" }> {
  const found = entity(project, id);
  if (found.kind !== "arc") throw new Error("not an arc");
  return found;
}

export const sketchSolverTests: readonly TestCase[] = [
  {
    name: "the seeded default sketch already satisfies every one of its constraints, so solving moves nothing",
    run: () => {
      const project = createWorkbenchProject("project:test-default-solve");
      const everything = solveLiveSketch(project.sketch);
      assert(everything.ok, "the default constraints must be consistent");
      equal(everything.movedIds.length, 0, "nothing in the default sketch may move");
      equal(everything.unsolved.length, 0, "every default constraint is solvable");
      const mounts = solveLiveSketch(project.sketch, ["entity:left-mount"]);
      assert(mounts.ok && mounts.movedIds.length === 0, "the equal mount pair is already satisfied");
    }
  },
  {
    name: "horizontal and vertical straighten a slanted line, keeping its start",
    run: () => {
      const horizontal = constrain(projectWith([line("a", [0, 0], [10, 3])]), "horizontal", ["a"]);
      assert(horizontal.ok, "a horizontal constraint applies");
      const flat = lineOf(horizontal.value.project, "a");
      near(flat.end[1], 0, 1e-9, "the end snaps to the start's height");
      near(flat.end[0], 10, 1e-9, "the end keeps its X");
      assert(horizontal.value.summary.includes("Moved line"), `the status says what moved: ${horizontal.value.summary}`);

      const vertical = constrain(projectWith([line("b", [2, 1], [5, 9])]), "vertical", ["b"]);
      assert(vertical.ok, "a vertical constraint applies");
      near(lineOf(vertical.value.project, "b").end[0], 2, 1e-9, "the end snaps to the start's X");
    }
  },
  {
    name: "contradictory orientation constraints are rejected and leave the sketch unchanged",
    run: () => {
      const first = constrain(projectWith([line("a", [0, 0], [10, 3])]), "horizontal", ["a"]);
      assert(first.ok, "horizontal applies");
      const second = constrain(first.value.project, "vertical", ["a"]);
      assert(!second.ok, "horizontal plus vertical would collapse the line");
      equal(second.diagnostics[0]?.code, "CONSTRAINT_CONFLICT", "the conflict is typed");
      equal(first.value.project.sketch.constraints.length, 1, "the original project keeps one constraint");
    }
  },
  {
    name: "parallel, perpendicular and collinear turn the second line while keeping its length",
    run: () => {
      const base = projectWith([line("ref", [0, 0], [10, 0]), line("mover", [0, 5], [3, 9])]);
      const parallel = constrain(base, "parallel", ["ref", "mover"]);
      assert(parallel.ok, "parallel applies");
      const turned = lineOf(parallel.value.project, "mover");
      near(turned.end[1] - turned.start[1], 0, 1e-9, "parallel to a horizontal reference is horizontal");
      near(Math.hypot(turned.end[0] - turned.start[0], turned.end[1] - turned.start[1]), 5, 1e-9, "the length is preserved");

      const perpendicular = constrain(base, "perpendicular", ["ref", "mover"]);
      assert(perpendicular.ok, "perpendicular applies");
      near(lineOf(perpendicular.value.project, "mover").end[0] - lineOf(perpendicular.value.project, "mover").start[0], 0, 1e-9, "perpendicular to a horizontal reference is vertical");

      const collinear = constrain(base, "collinear", ["ref", "mover"]);
      assert(collinear.ok, "collinear applies");
      near(lineOf(collinear.value.project, "mover").start[1], 0, 1e-9, "the moving line lies on the reference line");
    }
  },
  {
    name: "tangent resizes a free circle to touch a line, and moves it instead once its radius is dimensioned",
    run: () => {
      const base = projectWith([line("rail", [-20, 0], [20, 0]), circle("wheel", [0, 7], 3)]);
      const resized = constrain(base, "tangent", ["rail", "wheel"]);
      assert(resized.ok, "line to circle tangency applies");
      near(circleOf(resized.value.project, "wheel").radiusMm, 7, 1e-9, "the circle grows until it touches the line");
      near(circleOf(resized.value.project, "wheel").center[1], 7, 1e-9, "its centre stays put");
      assert(resized.value.summary.includes("Resized circle wheel from radius 3 to 7"), `the status explains the resize: ${resized.value.summary}`);

      // Dimension the radius first: the same relation now moves the circle instead.
      const dimensioned = applyWorkbenchOperation(base, { kind: "set-sketch-dimension", operationId: "operation:test-radius-first", expectedRevision: base.revision, entityId: "entity:wheel", dimension: "radius", valueMm: 4 });
      assert(dimensioned.ok, "the radius dimension applies");
      const moved = constrain(dimensioned.value.project, "tangent", ["rail", "wheel"]);
      assert(moved.ok, "tangent applies to the dimensioned circle");
      near(circleOf(moved.value.project, "wheel").radiusMm, 4, 1e-9, "the dimensioned radius is kept");
      near(circleOf(moved.value.project, "wheel").center[1], 4, 1e-9, "the centre drops to one radius above the line");

      // Changing the dimension later keeps the circle tangent.
      const regrown = applyWorkbenchOperation(moved.value.project, { kind: "set-sketch-dimension", operationId: "operation:test-radius-again", expectedRevision: moved.value.project.revision, entityId: "entity:wheel", dimension: "radius", valueMm: 6 });
      assert(regrown.ok, "a new radius applies");
      near(circleOf(regrown.value.project, "wheel").radiusMm, 6, 1e-9, "the new radius is applied");
      near(circleOf(regrown.value.project, "wheel").center[1], 6, 1e-9, "and the circle still touches the line");
    }
  },
  {
    name: "tangent between two circles sets the free one to the external tangent radius",
    run: () => {
      const result = constrain(projectWith([circle("a", [0, 0], 5), circle("b", [12, 0], 2)]), "tangent", ["a", "b"]);
      assert(result.ok, "circle to circle tangency applies");
      near(circleOf(result.value.project, "b").radiusMm, 7, 1e-9, "|12 - 5| = 7 touches externally");
    }
  },
  {
    name: "tangent on pairs the solver cannot handle is recorded with a reason, not faked",
    run: () => {
      const twoLines = constrain(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 6])]), "tangent", ["a", "b"]);
      assert(twoLines.ok, "the relation is still recorded");
      assert(twoLines.value.summary.includes("Recorded, not solved"), `the status says it was not solved: ${twoLines.value.summary}`);
      equal(twoLines.value.project.sketch.constraints.length, 1, "the constraint is kept as design intent");
      near(lineOf(twoLines.value.project, "b").end[1], 6, 1e-12, "no geometry was changed");

      const rectangle: SketchEntity = { id: "entity:plate", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const withRectangle = constrain(projectWith([rectangle, circle("c", [30, 0], 4)]), "tangent", ["plate", "c"]);
      assert(withRectangle.ok && withRectangle.value.summary.includes("Rectangles are rigid"), "rectangles are rigid in the solver");
      const fixedRectangle = constrain(projectWith([rectangle]), "fixed", ["plate"]);
      assert(fixedRectangle.ok, "Fixed is always accepted on a rectangle");
    }
  },
  {
    name: "symmetric mirrors two lines or two circles about an axis line",
    run: () => {
      const lines = constrain(projectWith([line("a", [3, 1], [8, 4]), line("b", [-2, 0], [-9, 3]), line("axis", [0, -10], [0, 10])]), "symmetry", ["a", "b", "axis"]);
      assert(lines.ok, "line symmetry applies");
      const mirrored = lineOf(lines.value.project, "b");
      near(mirrored.start[0], -3, 1e-9, "start mirrors in X");
      near(mirrored.start[1], 1, 1e-9, "start keeps Y");
      near(mirrored.end[0], -8, 1e-9, "end mirrors in X");
      near(mirrored.end[1], 4, 1e-9, "end keeps Y");

      const circles = constrain(projectWith([circle("a", [4, 2], 3), circle("b", [-5, 1], 1), line("axis", [0, -10], [0, 10])]), "symmetry", ["a", "b", "axis"]);
      assert(circles.ok, "circle symmetry applies");
      near(circleOf(circles.value.project, "b").center[0], -4, 1e-9, "the centre mirrors");
      near(circleOf(circles.value.project, "b").center[1], 2, 1e-9, "the centre keeps Y");
      near(circleOf(circles.value.project, "b").radiusMm, 3, 1e-9, "the radius matches");

      const missingAxis = constrain(projectWith([line("a", [3, 1], [8, 4]), line("b", [-2, 0], [-9, 3]), circle("c", [0, 0], 2)]), "symmetry", ["a", "b", "c"]);
      assert(missingAxis.ok && missingAxis.value.summary.includes("Recorded, not solved"), "a non-line axis is recorded, not solved");
    }
  },
  {
    name: "three entities are only valid for symmetry",
    run: () => {
      const base = projectWith([line("a", [0, 0], [5, 0]), line("b", [0, 3], [5, 3]), line("c", [0, 6], [5, 6])]);
      const parallel = constrain(base, "parallel", ["a", "b", "c"]);
      assert(!parallel.ok, "parallel stays a one-or-two entity relation");
    }
  },
  {
    name: "arcs follow concentric and keep their drawing direction, clockwise or counter-clockwise",
    run: () => {
      const counter: SketchEntity = { id: "entity:ccw", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false };
      const clockwise: SketchEntity = { id: "entity:cw", kind: "arc", start: [10, 0], mid: [0, -10], end: [-10, 0], construction: false };
      const anchor = circle("anchor", [2, 3], 1);
      const ccw = constrain(projectWith([anchor, counter]), "concentric", ["anchor", "ccw"]);
      assert(ccw.ok, "concentric moves a counter-clockwise arc");
      const moved = arcOf(ccw.value.project, "ccw");
      near(moved.start[0], 12, 1e-9, "start shifts with the centre");
      near(moved.start[1], 3, 1e-9, "start keeps its height relative to the centre");
      near(moved.mid[1], 13, 1e-9, "the midpoint stays on the same side");
      near(moved.end[0], -8, 1e-9, "end shifts with the centre");

      const cw = constrain(projectWith([circle("anchor", [1, 1], 1), clockwise]), "concentric", ["anchor", "cw"]);
      assert(cw.ok, "concentric moves a clockwise arc");
      const turned = arcOf(cw.value.project, "cw");
      near(turned.start[0], 11, 1e-9, "a clockwise arc keeps its start at the right");
      near(turned.mid[1], -9, 1e-9, "and bulges downward still");
      near(turned.end[0], -9, 1e-9, "and ends at the left");
    }
  },
  {
    name: "equal and a radius dimension drive circles and lines",
    run: () => {
      const equal2 = constrain(projectWith([circle("a", [0, 0], 4), circle("b", [20, 0], 9)]), "equal", ["a", "b"]);
      assert(equal2.ok, "equal radius applies");
      near(circleOf(equal2.value.project, "b").radiusMm, 4, 1e-9, "the second circle takes the first radius");

      const lines = constrain(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [4, 5])]), "equal", ["a", "b"]);
      assert(lines.ok, "equal length applies");
      near(lineOf(lines.value.project, "b").end[0], 10, 1e-9, "the second line takes the first length");
    }
  },
  {
    name: "solving is limited to the constraint-connected geometry, so unrelated records never move",
    run: () => {
      const slanted = line("loose", [0, 0], [10, 3]);
      const project = projectWith(
        [slanted, line("ref", [0, 20], [10, 20]), line("mover", [0, 30], [4, 33])],
        [{ id: "constraint:old-horizontal", kind: "horizontal", entityIds: ["entity:loose"] }]
      );
      const result = constrain(project, "parallel", ["ref", "mover"]);
      assert(result.ok, "the new relation applies");
      near(lineOf(result.value.project, "loose").end[1], 3, 1e-12, "an older unsatisfied record elsewhere is left alone");
      near(lineOf(result.value.project, "mover").end[1], lineOf(result.value.project, "mover").start[1], 1e-9, "the related line was solved");
    }
  },
  {
    name: "a driving line length is re-applied with the rest of its relations",
    run: () => {
      const base = projectWith([line("a", [0, 0], [10, 0])]);
      const horizontal = constrain(base, "horizontal", ["a"]);
      assert(horizontal.ok, "horizontal applies");
      const lengthened = applyWorkbenchOperation(horizontal.value.project, { kind: "set-sketch-dimension", operationId: "operation:test-length", expectedRevision: horizontal.value.project.revision, entityId: "entity:a", dimension: "length", valueMm: 25 });
      assert(lengthened.ok, "the length dimension applies");
      const result = lineOf(lengthened.value.project, "a");
      near(result.end[0], 25, 1e-9, "the line takes the new length");
      near(result.end[1], 0, 1e-9, "and stays horizontal");
    }
  }
];
