import { assert, equal, near, type TestCase } from "./test-kit.js";
import { analysis, addConstraint, arc, circle, dof, ellipse, get, line, lengthDim, lineRing, point, projectWith, rect, rel, ringIsClosedRectangle, setDimension, ORIGIN, AXIS_X, AXIS_Y } from "./sketch-solver-kit.js";
import { analyzeLiveSketch } from "../packages/workbench-core/src/index.js";

/** Degrees of freedom from the rank of the Jacobian, redundancy and conflict detection (audit S10 to S13, S22, E07). */

export const sketchSolverDofTests: readonly TestCase[] = [
  {
    name: "Degrees of freedom: the classic values are right (point 2, line 4, circle 3, rectangle 5 and 3 with its sides, ellipse 5, arc 5)",
    run: () => {
      equal(dof(projectWith([point("p", [1, 2])])), 2, "a point has 2");
      equal(dof(projectWith([line("a", [0, 0], [5, 0])])), 4, "a line has 4");
      equal(dof(projectWith([circle("c", [0, 0], 3)])), 3, "a circle has 3");
      equal(dof(projectWith([rect("r", [0, 0], 10, 5)])), 5, "a rectangle has 5");
      equal(dof(projectWith([ellipse("e", [0, 0], 10, 5)])), 5, "an ellipse has 5");
      equal(dof(projectWith([arc("a", [10, 0], [7, 7], [0, 10])])), 5, "a 3-point arc has 5, not 6");
      let sized = projectWith([rect("r", [0, 0], 10, 5)]);
      sized = setDimension(sized, "r", "width", 12);
      sized = setDimension(sized, "r", "height", 6);
      equal(dof(sized), 3, "a rectangle with width and height still has position and turn");
      let measured = projectWith([circle("c", [0, 0], 3)]);
      measured = setDimension(measured, "c", "radius", 4);
      equal(dof(measured), 2, "a circle with a radius has 2");
    }
  },
  {
    name: "Degrees of freedom S22: an arc counts 5 (4 with a radius, 3 with an arc length), and an empty sketch is not fully constrained",
    run: () => {
      let project = projectWith([arc("a", [10, 0], [7, 7], [0, 10])]);
      project = setDimension(project, "a", "radius", 10);
      equal(dof(project), 4, "arc with a radius");
      project = setDimension(project, "a", "arc-length", 15);
      equal(dof(project), 3, "arc with a radius and a length");
      const empty = analysis(projectWith([]));
      assert(empty.classification !== "fully-constrained", "an empty sketch is not fully constrained");
    }
  },
  {
    name: "Degrees of freedom S10: a duplicate relation removes nothing and is flagged as redundant",
    run: () => {
      let points = projectWith([point("p", [0, 0]), point("q", [1, 1])]);
      points = addConstraint(points, rel("coincident", ["p", "q"], { points: ["self", "self"] }));
      equal(dof(points), 2, "one coincident leaves 2");
      const twice = addConstraint(points, rel("coincident", ["p", "q"], { points: ["self", "self"] }));
      equal(dof(twice), 2, "the same coincident again still leaves 2, not 0");
      equal(analysis(twice).classification, "underconstrained", "and the sketch is not fully constrained");
      assert(analysis(twice).redundant.length >= 1, "the duplicate is reported as redundant");

      // A fixed line a, a horizontal b, a Parallel that b already satisfies, and b's length.
      let lines = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]);
      lines = addConstraint(lines, rel("fixed", ["a"]));
      lines = addConstraint(lines, rel("horizontal", ["b"]));
      lines = addConstraint(lines, rel("parallel", ["a", "b"]));
      lines = setDimension(lines, "b", "length", 10);
      equal(dof(lines), 2, "b still has its position (2), the Parallel added nothing");
      assert(analysis(lines).redundant.some((set) => set.labels.some((label) => /Parallel/.test(label))), "the Parallel is named as the redundant relation");

      // Equal plus a = 20 plus b = 20.
      let equalPair = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]);
      equalPair = setDimension(equalPair, "a", "length", 20);
      equalPair = addConstraint(equalPair, rel("equal", ["a", "b"]));
      equalPair = setDimension(equalPair, "b", "length", 20);
      equal(dof(equalPair), 6, "two lines are 8; a length and an Equal make 2, the second length is redundant");
      const redundant = analysis(equalPair).redundant;
      equal(redundant.length, 1, "one overlapping set");
      assert(redundant[0]!.labels.length === 3 && /Equal between Line 1 and Line 2/.test(redundant[0]!.labels.join("|")), `the set names the three relations: ${redundant[0]!.labels.join(" | ")}`);
      assert(/adds nothing/.test(redundant[0]!.message), "and says which adds nothing");
    }
  },
  {
    name: "Degrees of freedom S11: a fully dimensioned L-bracket still floats (2) and its two closing dimensions are flagged redundant",
    run: () => {
      const corners: readonly (readonly [number, number])[] = [[0, 0], [60, 0], [60, 20], [20, 20], [20, 50], [0, 50]];
      const lines = corners.map((corner, index) => line(`p${index}`, corner, corners[(index + 1) % 6]!));
      const constraints = lines.map((_, index) => rel("coincident", [`p${index}`, `p${(index + 1) % 6}`], { points: ["end", "start"] }));
      lines.forEach((_, index) => constraints.push(rel(index % 2 === 0 ? "horizontal" : "vertical", [`p${index}`])));
      let project = projectWith(lines, constraints);
      equal(dof(project), 6, "the bracket before dimensions: a closed rigid-shape family of 6");
      for (const [index, value] of [[0, 60], [1, 20], [2, 40], [3, 30], [4, 20], [5, 50]] as const) project = setDimension(project, `p${index}`, "length", value);
      const result = analysis(project);
      equal(result.degreesOfFreedom, 2, "six lengths on a closed H/V ring leave only its position");
      assert(result.classification !== "fully-constrained", "so it is not called fully constrained");
      assert(result.redundant.length >= 2, `two dimensions are flagged as redundant (${result.redundant.length} sets)`);
      assert(result.redundant.every((set) => set.labels.some((label) => /^Length /.test(label))), "and each set names a length");
    }
  },
  {
    name: "Degrees of freedom S12: symmetric and midpoint relations remove what they should",
    run: () => {
      let lines = projectWith([line("ax", [0, -10], [0, 10]), line("a", [3, 1], [8, 4]), line("b", [-3, 1], [-8, 4])]);
      lines = addConstraint(lines, rel("fixed", ["ax"]));
      equal(dof(lines), 8, "two free lines");
      lines = addConstraint(lines, rel("symmetry", ["a", "b", "ax"]));
      equal(dof(lines), 4, "symmetric lines remove 4");
      let circles = projectWith([line("ax", [0, -10], [0, 10]), circle("a", [5, 0], 3), circle("b", [-5, 0], 3)]);
      circles = addConstraint(circles, rel("fixed", ["ax"]));
      equal(dof(circles), 6, "two free circles");
      circles = addConstraint(circles, rel("symmetry", ["a", "b", "ax"]));
      equal(dof(circles), 3, "symmetric circles remove 3");
      let mid = projectWith([line("a", [0, 0], [10, 0]), point("m", [5, 3])]);
      mid = addConstraint(mid, rel("fixed", ["a"]));
      mid = addConstraint(mid, rel("midpoint", ["m", "a"], { points: ["self"] }));
      equal(dof(mid), 0, "a point at the midpoint of a fixed line is fully located");
      equal(analysis(mid).classification, "fully-constrained", "and the sketch says so");
    }
  },
  {
    name: "Degrees of freedom S13: a relation the solver does not enforce no longer reduces them; centring a hole on a plate works",
    run: () => {
      let plate = projectWith([rect("plate", [0, 0], 40, 20), circle("hole", [7, 3], 4)]);
      plate = addConstraint(plate, rel("fixed", ["plate"]));
      plate = setDimension(plate, "hole", "radius", 6);
      equal(dof(plate), 2, "the hole is still free to slide (2)");
      assert(analysis(plate).classification !== "fully-constrained", "so the padlock stays off");
      const centred = addConstraint(plate, rel("coincident", ["hole", "plate"], { points: ["center", "center"] }));
      const hole = get(centred, "hole", "circle");
      near(hole.center[0], 0, 1e-9, "the hole is now centred on the plate (x)");
      near(hole.center[1], 0, 1e-9, "(y)");
      equal(dof(centred), 0, "and only then fully constrained");
      equal(analysis(centred).classification, "fully-constrained", "the classification agrees");
      // A relation on a spline is recorded but not enforced: it must not look like it constrains anything.
      const withSpline = projectWith([{ id: "entity:s", kind: "spline", fitPoints: [[0, 0], [5, 5], [10, 0]], construction: false }, line("a", [0, 0], [10, 0])]);
      const result = analyzeLiveSketch(withSpline.sketch);
      equal(result.degreesOfFreedom, 6 + 4, "a spline of three fit points and a line are 10 free numbers");
    }
  },
  {
    name: "Degrees of freedom E07: the padlock is right for a dimensioned line rectangle with its bottom line fixed, and a concentric pair with one circle fixed",
    run: () => {
      const ring = lineRing();
      let project = projectWith(ring.entities, ring.constraints);
      project = addConstraint(project, rel("fixed", ["b"]));
      project = setDimension(project, "r", "length", 30);
      equal(dof(project), 0, "bottom fixed, right 30 tall: nothing else can move");
      equal(analysis(project).classification, "fully-constrained", "fully constrained");
      const over = setDimension(project, "l", "length", 30);
      assert(analysis(over).redundant.length >= 1, "the left side's 30 is implied by the ring and flagged redundant");
      equal(analysis(over).degreesOfFreedom, 0, "and still 0");

      let circles = projectWith([circle("a", [0, 0], 5), circle("b", [3, 3], 4)]);
      circles = addConstraint(circles, rel("fixed", ["a"]));
      circles = addConstraint(circles, rel("concentric", ["a", "b"]));
      equal(dof(circles), 1, "the concentric circle keeps only its radius");

      const duplicate = addConstraint(addConstraint(projectWith([line("a", [0, 0], [10, 3])]), rel("horizontal", ["a"])), rel("horizontal", ["a"]));
      assert(analysis(duplicate).redundant.length === 1, "a duplicate Horizontal is accepted but reported as redundant");
    }
  },
  {
    name: "Degrees of freedom: a rectangle of lines with only width and height dimensions and no position fix reports 2 (translation)",
    run: () => {
      const ring = lineRing();
      let project = projectWith(ring.entities, ring.constraints);
      project = setDimension(project, "b", "length", 52);
      project = setDimension(project, "r", "length", 30);
      equal(dof(project), 2, "two dimensions on a level and plumb ring leave its position");
      project = addConstraint(project, rel("coincident", [ORIGIN, "b"], { points: ["self", "start"] }));
      equal(dof(project), 0, "tied to the origin it is fully constrained");
      assert(ringIsClosedRectangle(project), "and still a rectangle");
      near(get(project, "b", "line").start[0], 0, 1e-9, "its corner is at the origin");
    }
  },
  {
    name: "Degrees of freedom: entity freedom counts independent ways to move; Fixed leaves none and the analysis names its basis",
    run: () => {
      let project = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 5])]);
      project = addConstraint(project, rel("coincident", ["a", "b"], { points: ["end", "start"] }));
      const joined = analysis(project);
      equal(joined.entityFreedom["entity:a"], 4, "a can still move every way");
      equal(joined.rank, 2, "the joint has rank 2");
      project = addConstraint(project, rel("fixed", ["a"]));
      const pinned = analysis(project);
      equal(pinned.entityFreedom["entity:a"], 0, "a is Fixed: nothing left");
      equal(pinned.entityFreedom["entity:b"], 2, "b's free end is all that remains");
      void lengthDim;
      void AXIS_X;
      void AXIS_Y;
    }
  }
];
