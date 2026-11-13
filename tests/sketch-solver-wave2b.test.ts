import { dragLiveSketch, solveLiveSketch, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { filletCorners } from "../packages/workbench-sketch/src/edit-tools.js";
import { analyzeWorkbenchSketch, detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { buildRoundedRectangle } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { buildSlot, type ShapeIds } from "../packages/workbench-sketch/src/shapes.js";
import type { SketchEntity, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { describeConstraint, entityOrdinalLabels, redundantConstraintIds } from "../packages/workbench-sketch/src/constraint-glyph-layout.js";
import { analyzeSketch, repairAll } from "../packages/workbench-sketch/src/sketch-repair.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { commitOk, context as editContext } from "./sketch-edit-kit.js";
import {
  addConstraint, analysis, apply, arc, AXIS_X, AXIS_Y, circle, get, line, lengthDim, lengthOf, ORIGIN, projectWith, refuseDimension, rel, run, setDimension,
  type Arc, type Circle, type Line, type Vec
} from "./sketch-solver-kit.js";

/**
 * Wave 2 regression tests for the sketch solver, second part: the angle, tangent, message, analysis and Repair issues of the re-audit.
 * Each one runs the re-audit repro through the real operations, the live solver, the drag handler or the Repair panel's model.
 */

const lineAt = (project: WorkbenchProject, name: string): Line => get(project, name, "line");
const angleOf = (l: Line): number => Math.atan2(l.end[1] - l.start[1], l.end[0] - l.start[0]);

function samePoint(actual: Vec, expected: Vec, message: string, tolerance = 1e-6): void {
  near(actual[0], expected[0], tolerance, `${message} (x)`);
  near(actual[1], expected[1], tolerance, `${message} (y)`);
}

/** The radius of the circle through an arc's three points. */
function radiusOfArc(a: Arc): number {
  const [x1, y1] = a.start;
  const [x2, y2] = a.mid;
  const [x3, y3] = a.end;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  return Math.hypot(x1 - ux, y1 - uy);
}

function centreOfArc(a: Arc): Vec {
  const [x1, y1] = a.start;
  const [x2, y2] = a.mid;
  const [x3, y3] = a.end;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  return [
    ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d,
    ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d
  ];
}

function filletedCorner(): WorkbenchProject {
  const s2 = Math.SQRT1_2;
  return projectWith([line("l1", [0, 0], [40, 0]), arc("f", [40, 0], [40 + 5 * s2, 5 - 5 * s2], [45, 5]), line("l2", [45, 5], [45, 40])], [
    rel("coincident", ["l1", "f"], { points: ["end", "start"] }),
    rel("coincident", ["f", "l2"], { points: ["end", "start"] }),
    rel("tangent", ["l1", "f"]),
    rel("tangent", ["l2", "f"]),
    rel("horizontal", ["l1"]),
    rel("vertical", ["l2"])
  ]);
}

function lBracket(): WorkbenchProject {
  const points: readonly Vec[] = [[0, 0], [100, 0], [100, 40], [65, 40], [65, 80], [0, 80]];
  const entities = points.map((start, index) => line(`p${index}`, start, points[(index + 1) % points.length]!));
  const constraints = points.flatMap((start, index) => {
    const end = points[(index + 1) % points.length]!;
    return [rel("coincident", [`p${index}`, `p${(index + 1) % points.length}`], { points: ["end", "start"] }), rel(start[1] === end[1] ? "horizontal" : "vertical", [`p${index}`])];
  });
  return projectWith(entities, constraints);
}

function grid(size: number): WorkbenchProject {
  const entities: Line[] = [];
  const relations = [];
  const ends = new Map<string, { id: string; ref: "start" | "end" }[]>();
  const note = (key: string, id: string, ref: "start" | "end"): void => { ends.set(key, [...(ends.get(key) ?? []), { id, ref }]); };
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size - 1; i += 1) {
      entities.push(line(`h${i}_${j}`, [i * 10, j * 10], [(i + 1) * 10, j * 10]) as Line);
      relations.push(rel("horizontal", [`h${i}_${j}`]));
      note(`${i},${j}`, `h${i}_${j}`, "start");
      note(`${i + 1},${j}`, `h${i}_${j}`, "end");
    }
  }
  for (let j = 0; j < size - 1; j += 1) {
    for (let i = 0; i < size; i += 1) {
      entities.push(line(`v${i}_${j}`, [i * 10, j * 10], [i * 10, (j + 1) * 10]) as Line);
      relations.push(rel("vertical", [`v${i}_${j}`]));
      note(`${i},${j}`, `v${i}_${j}`, "start");
      note(`${i},${j + 1}`, `v${i}_${j}`, "end");
    }
  }
  for (const list of ends.values()) {
    for (let k = 1; k < list.length; k += 1) relations.push(rel("coincident", [list[0]!.id, list[k]!.id], { points: [list[0]!.ref, list[k]!.ref] }));
  }
  return projectWith(entities, relations);
}

export const sketchSolverWave2MoreTests: readonly TestCase[] = [
  {
    name: "Re-audit solver S8: an equal-length chain edit keeps the neighbour's direction, and a perpendicular arm still translates",
    run: () => {
      let project = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [15, 8])], [rel("coincident", ["a", "b"], { points: ["end", "start"] })]);
      project = addConstraint(project, rel("equal", ["a", "b"]));
      const before = angleOf(lineAt(project, "b"));
      const edited = setDimension(project, "a", "length", 30);
      near(lengthOf(lineAt(edited, "b")), 30, 1e-9, "b is as long as a (Equal)");
      near(angleOf(lineAt(edited, "b")), before, 1e-6, "and b did not turn (it used to swing by 29 degrees)");
      samePoint(lineAt(edited, "b").start, [30, 0], "b starts where a ends");
      let arm = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])], [rel("coincident", ["a", "b"], { points: ["end", "start"] })]);
      arm = addConstraint(arm, rel("perpendicular", ["a", "b"]));
      arm = setDimension(arm, "a", "length", 30);
      samePoint(lineAt(arm, "b").end, [30, 10], "the perpendicular arm is moved, not stretched");
    }
  },
  {
    name: "Re-audit solver N4: an angle dimension to a sketch axis turns the line about its start and keeps its length",
    run: () => {
      const free = projectWith([line("l", [10, 5], [50, 5])]);
      for (const degrees of [30, 45, 90, 120, 170]) {
        const axisSecond = setDimension(free, "l", "angle", degrees, { second: AXIS_X });
        near(lengthOf(lineAt(axisSecond, "l")), 40, 1e-6, `the line is still 40 long at ${degrees} degrees (axis second)`);
        samePoint(lineAt(axisSecond, "l").start, [10, 5], `the start did not move (${degrees}, axis second)`);
        const axisFirst = run(free, { kind: "set-sketch-dimension", entityId: AXIS_X, secondEntityId: "entity:l", dimension: "angle", valueMm: degrees });
        near(lengthOf(lineAt(axisFirst, "l")), 40, 1e-6, `the line is still 40 long at ${degrees} degrees (axis first)`);
        samePoint(lineAt(axisFirst, "l").start, [10, 5], `the start did not move (${degrees}, axis first)`);
      }
      const home = projectWith([line("l", [0, 0], [40, 0])], [rel("coincident", [ORIGIN, "l"], { points: ["self", "start"] })]);
      near(lengthOf(lineAt(setDimension(home, "l", "angle", 90, { second: AXIS_X }), "l")), 40, 1e-6, "a line from the origin keeps its length at 90 degrees too (it grew to 85.73)");
      const withCircle = addConstraint(projectWith([line("l", [0, 0], [40, 0]), circle("c", [20, 8], 8)]), rel("tangent", ["l", "c"]));
      near(lengthOf(lineAt(setDimension(withCircle, "l", "angle", 30, { second: AXIS_X }), "l")), 40, 1e-6, "and so does a line with a tangent circle (it reached 42)");
    }
  },
  {
    name: "Re-audit solver N5: an angle dimension that turns a line by exactly 180 degrees is accepted, from either side",
    run: () => {
      const corner = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10])], [rel("coincident", ["a", "b"], { points: ["start", "start"] })]);
      const flipped = setDimension(corner, "a", "angle", 270, { second: "b" });
      samePoint(lineAt(flipped, "b").end, [0, -10], "angle 270 between two lines that began at 90 swings the second line to point down");
      for (const degrees of [269.99, 270.01, 180, 90, 0]) setDimension(corner, "a", "angle", degrees, { second: "b" });
      const back = setDimension(setDimension(corner, "a", "angle", 90, { second: "b" }), "a", "angle", 270, { second: "b" });
      samePoint(lineAt(back, "b").end, [0, -10], "an already dimensioned corner goes 90 to 270 too");
      const level = projectWith([line("l", [0, 0], [10, 0])]);
      samePoint(lineAt(setDimension(level, "l", "angle", 180, { second: AXIS_X }), "l").end, [-10, 0], "a line at 0 degrees to the X axis turns to 180");
      const diagonal = projectWith([line("a", [0, 0], [10, 10]), line("b", [0, 0], [10, 0])], [rel("coincident", ["a", "b"], { points: ["start", "start"] })]);
      samePoint(lineAt(setDimension(diagonal, "b", "angle", 225, { second: "a" }), "a").end, [-10, -10], "45 to 225 turns the line through the half turn");
    }
  },
  {
    name: "Re-audit solver N6: an undimensioned arc or circle keeps its radius when connected lines are edited or dragged",
    run: () => {
      const corner = filletedCorner();
      for (const length of [20, 60, 200]) {
        near(radiusOfArc(get(setDimension(corner, "l1", "length", length), "f", "arc")), 5, 1e-6, `the fillet radius stays 5 at l1 = ${length}`);
      }
      let toggled = corner;
      for (let index = 0; index < 30; index += 1) toggled = setDimension(toggled, "l1", "length", index % 2 === 0 ? 80 : 40);
      near(radiusOfArc(get(toggled, "f", "arc")), 5, 1e-6, "after 30 alternating edits the radius is still 5 (it reached 5.43)");

      const slot = projectWith([line("t", [0, 5], [40, 5]), arc("r", [40, 5], [45, 0], [40, -5]), line("b", [40, -5], [0, -5]), arc("l", [0, -5], [-5, 0], [0, 5])], [
        rel("tangent", ["t", "r"]), rel("tangent", ["b", "r"]), rel("tangent", ["b", "l"]), rel("tangent", ["t", "l"]), rel("equal", ["r", "l"]),
        rel("coincident", ["t", "r"], { points: ["end", "start"] }), rel("coincident", ["r", "b"], { points: ["end", "start"] }),
        rel("coincident", ["b", "l"], { points: ["end", "start"] }), rel("coincident", ["l", "t"], { points: ["end", "start"] })
      ]);
      for (const length of [80, 20]) {
        const edited = setDimension(slot, "t", "length", length);
        near(radiusOfArc(get(edited, "r", "arc")), 5, 1e-6, `the slot cap radius stays 5 at line = ${length} (it grew to 5.5)`);
        near(radiusOfArc(get(edited, "l", "arc")), 5, 1e-6, "and so does the other cap");
      }
      const touching = addConstraint(projectWith([line("a", [0, 0], [100, 0]), circle("c", [30, 10], 10)]), rel("tangent", ["a", "c"]));
      const dragged = dragLiveSketch(touching.sketch, { entityId: "entity:c", point: "center", positionMm: [50, 25] });
      assert(dragged.ok, "the drag works");
      if (dragged.ok) near((dragged.entities.find((entity) => entity.id === "entity:c") as Circle).radiusMm, 10, 1e-9, "the dragged circle keeps radius 10 (it grew to 10.59)");
    }
  },
  {
    name: "Re-audit solver N7: a circle or arc can be made tangent to a sketch axis, in either order, and stays tangent",
    run: () => {
      const plate = projectWith([circle("c", [5, 8], 3)]);
      for (const names of [["c", AXIS_X], [AXIS_X, "c"], ["c", AXIS_Y], [AXIS_Y, "c"]] as const) {
        const tangent = addConstraint(plate, rel("tangent", names));
        const c = get(tangent, "c", "circle");
        const distance = (names as readonly string[]).includes(AXIS_X) ? Math.abs(c.center[1]) : Math.abs(c.center[0]);
        near(distance, c.radiusMm, 1e-9, `the circle touches the axis (${names.join(", ")})`);
      }
      const onX = addConstraint(plate, rel("tangent", ["c", AXIS_X]));
      near(Math.abs(get(setDimension(onX, "c", "radius", 6), "c", "circle").center[1]), 6, 1e-9, "after a radius edit it still touches the axis");
      const arcOnAxis = addConstraint(projectWith([arc("a", [15, 10], [10, 15], [5, 10])]), rel("tangent", ["a", AXIS_Y]));
      const placed = get(arcOnAxis, "a", "arc");
      near(Math.abs(centreOfArc(placed)[0]), radiusOfArc(placed), 1e-6, "an arc takes a tangent to the Y axis too");
    }
  },
  {
    name: "Re-audit solver N8: a refused dimension names the dimension just entered, and a long loop is cut to a readable list",
    run: () => {
      let triangle = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [5, 8]), line("c", [5, 8], [0, 0])], [
        rel("coincident", ["a", "b"], { points: ["end", "start"] }), rel("coincident", ["b", "c"], { points: ["end", "start"] }), rel("coincident", ["c", "a"], { points: ["end", "start"] })
      ]);
      triangle = setDimension(setDimension(triangle, "a", "length", 10), "b", "length", 9);
      const message = refuseDimension(triangle, "c", "length", 30);
      assert(/Length 30 on Line 3/.test(message), `the message names the dimension just entered: ${message}`);
      assert(/Length 10 on Line 1/.test(message) && /Length 9 on Line 2/.test(message), "and the dimensions it conflicts with");

      let bracket = lBracket();
      for (const [name, value] of [["p0", 100], ["p1", 40], ["p2", 35], ["p3", 40], ["p4", 65]] as const) bracket = setDimension(bracket, name, "length", value);
      const bracketMessage = refuseDimension(bracket, "p0", "length", 30);
      assert(bracketMessage.length < 420, `a closed loop gives a short message (${bracketMessage.length} characters)`);
      assert((bracketMessage.match(/These relations/g) ?? []).length === 1, "with one sentence, not two that repeat each other");
      assert(/Length 30 on Line 1/.test(bracketMessage), "naming the edit");

      const stairs: Line[] = [];
      const relations = [];
      for (let index = 0; index < 150; index += 1) {
        const horizontal = index % 2 === 0;
        const from: Vec = index === 0 ? [0, 0] : stairs[index - 1]!.end;
        stairs.push(line(`s${index}`, from, horizontal ? [from[0] + 10, from[1]] : [from[0], from[1] + 10]) as Line);
        relations.push(rel(horizontal ? "horizontal" : "vertical", [`s${index}`]), lengthDim(`s${index}`, 10));
        if (index > 0) relations.push(rel("coincident", [`s${index - 1}`, `s${index}`], { points: ["end", "start"] }));
      }
      relations.push(rel("coincident", ["s149", "s0"], { points: ["end", "start"] }));
      const hugeMessage = refuseDimension(projectWith(stairs, relations), "s0", "length", 25);
      assert(hugeMessage.length < 600, `a 150-line closed staircase conflict stays readable (${hugeMessage.length} characters)`);
      assert(/more/.test(hugeMessage), "and says how many more relations are involved");
    }
  },
  {
    name: "Re-audit solver N9: a stale but solvable sketch with redundant relations is not classed as a conflict",
    run: () => {
      const entities = [line("b", [0, 0], [50, 0]), line("r", [50, 0], [50, 30]), line("t", [50, 30], [6, 30]), line("l", [6, 30], [0, 0])];
      const joins = [["b", "r"], ["r", "t"], ["t", "l"], ["l", "b"]].map(([a, b]) => rel("coincident", [a!, b!], { points: ["end", "start"] }));
      const stale = projectWith(entities, [...joins, rel("horizontal", ["b"]), rel("horizontal", ["t"]), rel("vertical", ["r"]), rel("vertical", ["l"]), lengthDim("b", 50), lengthDim("t", 50)]);
      assert(solveLiveSketch(stale.sketch).ok, "the live solver solves it");
      const result = analysis(stale);
      assert(result.classification !== "conflict", `the analysis agrees, saying ${result.classification}`);
      equal(result.conflictSets.length, 0, "with no conflict sets");
      assert(result.redundant.length >= 1, "and names the redundant relation");

      const holes = [];
      const holeRelations = [];
      for (let i = 0; i < 6; i += 1) for (let j = 0; j < 6; j += 1) holes.push(circle(`h${i}_${j}`, [i * 20 + 0.3 * (j % 2), j * 20], 5));
      for (let i = 0; i < 6; i += 1) {
        for (let j = 0; j < 6; j += 1) {
          holeRelations.push({ id: `constraint:gr${i}_${j}`, kind: "radius" as const, dimension: "radius" as const, entityIds: [`entity:h${i}_${j}`], valueMm: 5 });
          if (i > 0) holeRelations.push({ id: `constraint:gx${i}_${j}`, kind: "distance" as const, dimension: "horizontal" as const, entityIds: [`entity:h${i - 1}_${j}`, `entity:h${i}_${j}`], points: ["center", "center"] as const, valueMm: 20 });
          if (j > 0) holeRelations.push({ id: `constraint:gy${i}_${j}`, kind: "distance" as const, dimension: "vertical" as const, entityIds: [`entity:h${i}_${j - 1}`, `entity:h${i}_${j}`], points: ["center", "center"] as const, valueMm: 20 });
        }
      }
      equal(analysis(projectWith(holes, holeRelations)).conflictSets.length, 0, "a hole grid with consistent dimensions has no conflict before its first solve");

      const real = projectWith([line("a", [0, 0], [20, 0]), line("b", [0, 5], [30, 5])], [rel("equal", ["a", "b"]), lengthDim("a", 20), lengthDim("b", 30)]);
      equal(analysis(real).classification, "conflict", "relations that truly contradict stay a conflict");
    }
  },
  {
    name: "Re-audit solver N10: edits leave undimensioned geometry exactly where the relations put it, with no dust",
    run: () => {
      const bracket = lBracket();
      samePoint(lineAt(setDimension(bracket, "p0", "length", 30), "p3").start, [65, 40], "the notch stays at x = 65 after p0 = 30 (it was 64.999806)", 1e-9);
      samePoint(lineAt(setDimension(bracket, "p1", "length", 100), "p3").start, [65, 100], "p1 = 100 puts the notch at 65, 100", 1e-9);

      const edited = setDimension(grid(11), "h4_5", "length", 25);
      const lengths = new Set(edited.sketch.entities.map((entity) => Math.round(lengthOf(entity as Line) * 1e9) / 1e9));
      assert([...lengths].every((value) => value === 10 || value === 25), `every line of the 11 by 11 grid is 10 or 25 long, no dust: ${[...lengths].join(", ")}`);
      const row = edited.sketch.entities.filter((entity): entity is Line => entity.kind === "line" && /^entity:h\d+_5$/.test(entity.id));
      near(Math.max(...row.map((entity) => entity.end[0])), 115, 1e-9, "the cells to the right travelled with the widened one, not over it");
      assert(row.every((entity) => entity.end[0] > entity.start[0]), "and no cell is folded back over its neighbour");
    }
  },
  {
    name: "Re-audit solver N11: a sketch past the relation limit says which limit",
    run: () => {
      const entities = Array.from({ length: 400 }, (_, index) => line(`s${index}`, [0, index], [10, index]));
      const relations = entities.flatMap((_, index) => [rel("horizontal", [`s${index}`]), lengthDim(`s${index}`, 10), rel("fixed", [`s${index}`])]).slice(0, 1_001);
      const result = apply(projectWith(entities, relations), { kind: "set-sketch-dimension", entityId: "entity:s0", dimension: "length", valueMm: 12 });
      assert(!result.ok, "the edit is refused");
      const text = result.ok ? "" : result.diagnostics[0]?.message ?? "";
      assert(/1,000/.test(text) && /relations/.test(text), `and says the relation limit, not "invalid": ${text}`);
      assert(!/invalid or exceeds/.test(text), "without the generic wording");
    }
  },
  {
    name: "Re-audit engineer-gap N1: a coincident and tangent line-arc joint is not redundant, so a filleted plate reports its true freedom",
    run: () => {
      const joint = projectWith([line("a", [0, 0], [10, 0]), arc("t", [10, 0], [10 + 5 * Math.SQRT1_2, 5 - 5 * Math.SQRT1_2], [15, 5])], [
        rel("coincident", ["a", "t"], { points: ["end", "start"] }), rel("tangent", ["a", "t"])
      ]);
      const bare = analysis(joint);
      equal(bare.redundant.length, 0, "no relation is redundant at the joint");
      equal(bare.rank, 3, "the joint and the tangent remove three numbers");
      equal(bare.degreesOfFreedom, 6, "a line (4) and an arc (5) with a tangent joint have 6 left");

      let plate = projectWith([line("b", [0, 0], [80, 0]), line("r", [80, 0], [80, 50]), line("t", [80, 50], [0, 50]), line("l", [0, 50], [0, 0])], [
        rel("coincident", ["b", "r"], { points: ["end", "start"] }), rel("coincident", ["r", "t"], { points: ["end", "start"] }),
        rel("coincident", ["t", "l"], { points: ["end", "start"] }), rel("coincident", ["l", "b"], { points: ["end", "start"] }),
        rel("horizontal", ["b"]), rel("horizontal", ["t"]), rel("vertical", ["r"]), rel("vertical", ["l"])
      ]);
      for (const [first, second] of [["b", "r"], ["r", "t"], ["t", "l"], ["l", "b"]] as const) {
        plate = commitOk(plate, filletCorners(editContext(plate), [`entity:${first}`, `entity:${second}`], 5));
      }
      const filleted = analysis(plate);
      equal(filleted.redundant.length, 0, "the filleted plate has no redundant relations");
      equal(filleted.degreesOfFreedom, 4, "and its freedom is 4 (width, height and a position), not 12");
      const report = analyzeSketch(editContext(plate));
      assert(!report.issues.some((issue) => /redundant|Over-defined/i.test(issue.title)), "Repair lists no 'Over-defined' tangent");
      const tangents = plate.sketch.constraints.filter((c) => c.kind === "tangent").length;
      equal(repairAll(editContext(plate)).sketch.constraints.filter((c) => c.kind === "tangent").length, tangents, "Fix all keeps every tangent");
    }
  },
  {
    name: "Re-audit edit-tools N2: after a fillet, Fix all keeps the tangents and a drag keeps the arc tangent",
    run: () => {
      const corner = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 60])], [rel("coincident", ["a", "b"], { points: ["end", "start"] })]);
      const rounded = commitOk(corner, filletCorners(editContext(corner), ["entity:a", "entity:b"], 10));
      equal(analysis(rounded).redundant.length, 0, "a bare fillet reports no over-defined relation");
      const fixed = repairAll(editContext(rounded));
      equal(fixed.sketch.constraints.filter((c) => c.kind === "tangent").length, 2, "Fix all leaves both tangents");
      const dragged = dragLiveSketch(fixed.sketch, { entityId: "entity:b", point: "end", positionMm: [120, 80] });
      assert(dragged.ok, "the drag works");
      if (!dragged.ok) return;
      const fillet = dragged.entities.find((entity) => entity.kind === "arc") as Arc;
      const a = dragged.entities.find((entity) => entity.id === "entity:a") as Line;
      const b = dragged.entities.find((entity) => entity.id === "entity:b") as Line;
      const centre = centreOfArc(fillet);
      const radius = radiusOfArc(fillet);
      const distanceTo = (l: Line): number => Math.abs((l.end[0] - l.start[0]) * (centre[1] - l.start[1]) - (l.end[1] - l.start[1]) * (centre[0] - l.start[0])) / lengthOf(l);
      near(distanceTo(a), radius, 1e-6, "the arc is tangent to the first line after the drag");
      near(distanceTo(b), radius, 1e-6, "and to the second (it was off by 0.385 mm once the tangents were deleted)");
    }
  },
  {
    name: "Re-audit engineer-gap N2: Repair treats the origin and the axes as present, and the records read them by name",
    run: () => {
      const homed = addConstraint(lBracket(), { id: "constraint:home", kind: "coincident", entityIds: [ORIGIN, "entity:p0"], points: ["self", "start"] });
      const report = analyzeSketch(editContext(homed));
      assert(!report.issues.some((issue) => /no longer exists/.test(issue.title)), "no 'refer to a curve that no longer exists' error");
      equal(report.usableForSolid, true, "the profile is still usable for a solid");
      equal(repairAll(editContext(homed)).sketch.constraints.some((c) => c.id === "constraint:home"), true, "Fix all keeps the origin relation");
      const labels = entityOrdinalLabels(homed.sketch.entities);
      const text = describeConstraint(homed.sketch.constraints.find((c) => c.id === "constraint:home")!, labels);
      assert(/the origin/.test(text) && !/missing/.test(text), `the record reads: ${text}`);
      const axis = describeConstraint({ id: "constraint:ax", kind: "coincident", entityIds: ["entity:p0", AXIS_X], points: ["start", "curve"] }, labels);
      assert(/the X axis/.test(axis), `and for an axis: ${axis}`);
    }
  },
  {
    name: "Re-audit solver S3: the app's own slot and rounded rectangle stay closed and keep their caps when a line or radius is edited",
    run: () => {
      let counter = 0;
      const ids: ShapeIds = { entity: () => `entity:s3-${(counter += 1)}`, constraint: () => `constraint:s3-${(counter += 1)}` };
      /** Largest distance between the end of each entity and the start of the next one around the ring. */
      const worstGap = (project: WorkbenchProject): number => {
        // The outline only: a slot's construction centreline is not part of the ring.
        const ring = project.sketch.entities.filter((entity) => !entity.construction);
        let worst = 0;
        ring.forEach((entity, index) => {
          const next = ring[(index + 1) % ring.length]!;
          if ((entity.kind !== "line" && entity.kind !== "arc") || (next.kind !== "line" && next.kind !== "arc")) return;
          worst = Math.max(worst, Math.hypot(entity.end[0] - next.start[0], entity.end[1] - next.start[1]));
        });
        return worst;
      };
      const build = (shape: { readonly entities: readonly SketchEntity[]; readonly constraints: readonly WorkbenchSketchConstraint[] }): WorkbenchProject => projectWith(shape.entities, shape.constraints);
      const edit = (project: WorkbenchProject, entity: SketchEntity, dimension: "length" | "radius", valueMm: number): WorkbenchProject => run(project, { kind: "set-sketch-dimension", entityId: entity.id, dimension, valueMm });

      const slotShape = buildSlot([0, 0], [40, 0], [20, 5], ids);
      assert(slotShape.ok, "the slot builds");
      const slot = build(slotShape.value);
      const [top, endCap] = slot.sketch.entities;
      for (const length of [80, 20]) {
        const edited = edit(slot, top!, "length", length);
        assert(worstGap(edited) < 1e-6, `slot line ${length}: the caps stay joined to the sides (gap ${worstGap(edited)}; it was 40 and 20 mm)`);
        const cap = edited.sketch.entities.find((entity) => entity.id === endCap!.id) as Arc;
        near(radiusOfArc(cap), 5, 1e-6, `slot line ${length}: the cap radius stays 5`);
        assert(detectSketchProfiles(edited.sketch).length === 1, `slot line ${length}: it still bounds one profile`);
      }

      const roundedShape = buildRoundedRectangle([0, 0], [60, 40], 6, ids);
      assert(roundedShape.ok, "the rounded rectangle builds");
      const rounded = build(roundedShape.value);
      const [bottom, corner] = rounded.sketch.entities;
      for (const length of [50, 30]) {
        const edited = edit(rounded, bottom!, "length", length);
        assert(worstGap(edited) < 1e-6, `rounded rectangle bottom ${length}: the corners stay joined (gap ${worstGap(edited)}; it was 2 and 18 mm)`);
        assert(detectSketchProfiles(edited.sketch).length === 1, `rounded rectangle bottom ${length}: it still bounds one profile`);
      }
      const smaller = edit(rounded, corner!, "radius", 3);
      assert(worstGap(smaller) < 1e-6, `rounded rectangle radius 3: the corners stay joined (gap ${worstGap(smaller)}; it was 1.5 mm)`);
      assert(detectSketchProfiles(smaller.sketch).length === 1, "rounded rectangle radius 3: it still bounds one profile");
    }
  },
  {
    name: "Re-audit engineer-gap N7: solver-detected redundancy reaches the canvas helper and the record list through redundantConstraintIds",
    run: () => {
      const box = projectWith([line("a", [0, 0], [20, 0]), line("b", [0, 10], [20, 10])], [rel("horizontal", ["a"]), rel("horizontal", ["b"]), rel("parallel", ["a", "b"])]);
      const result = analyzeWorkbenchSketch(box.sketch);
      equal(result.redundant.length, 1, "the analysis finds the redundant Parallel");
      equal(result.redundantConstraintIds.length, 1, "and lists its id in redundantConstraintIds");
      const flagged = redundantConstraintIds(box.sketch.constraints, result);
      equal(flagged.has(result.redundantConstraintIds[0]!), true, "the canvas helper flags the same relation");
      equal(flagged.has(box.sketch.constraints[0]!.id), false, "and not the relations that stand");
    }
  }
];
