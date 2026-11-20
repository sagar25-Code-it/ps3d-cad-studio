import { assert, near, type TestCase } from "./test-kit.js";
import { addConstraint, get, line, lengthOf, point, projectWith, rel, ringIsClosedRectangle, setDimension, lineRing, type Line, type Vec } from "./sketch-solver-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

/**
 * Golden sketches, taken from the sketch research package ("golden tests for 20 sketches, expected coordinates +-1e-6").
 * Each sketch is fully determined by its dimensions, so the answer is known from geometry alone and does not depend on the order the
 * relations were added or where the drawing started. They pin the solver to exact, analytic results: if a change to the solver, the
 * anchors or the dimension code moves a corner by more than a millionth of a millimetre, one of these fails.
 */

const TOLERANCE = 1e-6;

function pinned(project: WorkbenchProject, lineName: string): WorkbenchProject {
  const withPoint = projectWith([...project.sketch.entities, point("pin", [0, 0])], project.sketch.constraints);
  const fixed = addConstraint(withPoint, rel("fixed", ["pin"]));
  return addConstraint(fixed, rel("coincident", ["pin", lineName], { points: ["self", "start"] }));
}

const corner = (project: WorkbenchProject, name: string, end: "start" | "end"): Vec => {
  const entity: Line = get(project, name, "line");
  return end === "start" ? entity.start : entity.end;
};

function expectCorner(project: WorkbenchProject, name: string, end: "start" | "end", expected: Vec, label: string): void {
  const actual = corner(project, name, end);
  near(actual[0], expected[0], TOLERANCE, `${label}: x`);
  near(actual[1], expected[1], TOLERANCE, `${label}: y`);
}

/** Three joined lines a, b, c closing a triangle, drawn roughly (the solver has to find the exact shape). */
function roughTriangle(points: readonly [Vec, Vec, Vec]): WorkbenchProject {
  const [p0, p1, p2] = points;
  let project = projectWith([line("a", p0, p1), line("b", p1, p2), line("c", p2, p0)]);
  project = addConstraint(project, rel("coincident", ["a", "b"], { points: ["end", "start"] }));
  project = addConstraint(project, rel("coincident", ["b", "c"], { points: ["end", "start"] }));
  project = addConstraint(project, rel("coincident", ["c", "a"], { points: ["end", "start"] }));
  return project;
}

const direction = (entity: Line): Vec => {
  const length = lengthOf(entity);
  return [(entity.end[0] - entity.start[0]) / length, (entity.end[1] - entity.start[1]) / length];
};

export const sketchGoldenTests: readonly TestCase[] = [
  {
    name: "Golden sketch 1: an 80 x 50 rectangle pinned at the origin has its four corners at exactly (0,0), (80,0), (80,50), (0,50)",
    run: () => {
      const ring = lineRing(7, 3, 61, 33); // drawn at the wrong place and size on purpose
      let project = pinned(projectWith(ring.entities, ring.constraints), "b");
      project = setDimension(project, "b", "length", 80);
      project = setDimension(project, "r", "length", 50);
      assert(ringIsClosedRectangle(project, TOLERANCE), "the ring is a closed, level, plumb rectangle");
      expectCorner(project, "b", "start", [0, 0], "bottom-left");
      expectCorner(project, "b", "end", [80, 0], "bottom-right");
      expectCorner(project, "r", "end", [80, 50], "top-right");
      expectCorner(project, "t", "end", [0, 50], "top-left");
    }
  },
  {
    name: "Golden sketch 2: a six-step staircase of equal 15 mm steps climbs through exactly (15,0), (15,15), (30,15), (30,30), (45,30), (45,45)",
    run: () => {
      const entities = [] as ReturnType<typeof line>[];
      const constraints = [];
      let cursor: Vec = [1, 1];
      for (let index = 0; index < 6; index += 1) {
        const next: Vec = index % 2 === 0 ? [cursor[0] + 11, cursor[1] + 0.5] : [cursor[0] - 0.5, cursor[1] + 19];
        entities.push(line(`s${index}`, cursor, next));
        constraints.push(rel(index % 2 === 0 ? "horizontal" : "vertical", [`s${index}`]));
        if (index > 0) constraints.push(rel("coincident", [`s${index - 1}`, `s${index}`], { points: ["end", "start"] }), rel("equal", ["s0", `s${index}`]));
        cursor = next;
      }
      let project = pinned(projectWith(entities, constraints), "s0");
      project = setDimension(project, "s0", "length", 15);
      const expected: Vec[] = [[15, 0], [15, 15], [30, 15], [30, 30], [45, 30], [45, 45]];
      expected.forEach((at, index) => expectCorner(project, `s${index}`, "end", at, `end of step ${index}`));
      expectCorner(project, "s0", "start", [0, 0], "the first step starts on the pin");
    }
  },
  {
    name: "Golden sketch 3: three lengths of 30, 40 and 50 make a right triangle (the sides hold to a millionth, the corner between 30 and 40 is 90 degrees)",
    run: () => {
      let project = roughTriangle([[0, 0], [33, 2], [29, 35]]);
      project = setDimension(project, "a", "length", 30);
      project = setDimension(project, "b", "length", 40);
      project = setDimension(project, "c", "length", 50);
      near(lengthOf(get(project, "a", "line")), 30, TOLERANCE, "side a");
      near(lengthOf(get(project, "b", "line")), 40, TOLERANCE, "side b");
      near(lengthOf(get(project, "c", "line")), 50, TOLERANCE, "side c");
      const [ax, ay] = direction(get(project, "a", "line"));
      const [bx, by] = direction(get(project, "b", "line"));
      near(ax * bx + ay * by, 0, 1e-8, "the corner between the 30 and the 40 side is a right angle");
    }
  },
  {
    name: "Golden sketch 4: three equal sides of 20 mm make an equilateral triangle (every turn is exactly 120 degrees)",
    run: () => {
      let project = roughTriangle([[0, 0], [22, 1], [10, 16]]);
      project = addConstraint(project, rel("equal", ["a", "b"]));
      project = addConstraint(project, rel("equal", ["a", "c"]));
      project = setDimension(project, "a", "length", 20);
      for (const name of ["a", "b", "c"]) near(lengthOf(get(project, name, "line")), 20, TOLERANCE, `side ${name}`);
      const sides = ["a", "b", "c"].map((name) => direction(get(project, name, "line")));
      for (let index = 0; index < 3; index += 1) {
        const [x1, y1] = sides[index]!;
        const [x2, y2] = sides[(index + 1) % 3]!;
        near(x1 * x2 + y1 * y2, -0.5, 1e-8, `the turn after side ${index} is 120 degrees (cosine -1/2)`);
      }
    }
  }
];
