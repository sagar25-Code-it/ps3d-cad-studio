import { breakAtCrossings, extendAt, trimAt } from "../packages/workbench-sketch/src/edit-tools.js";
import { splitAt } from "../packages/workbench-sketch/src/split-jog.js";
import { sampleSpline } from "../packages/workbench-sketch/src/index.js";
import { powerTrim, trimToClosest } from "../packages/workbench-sketch/src/trim-extend.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { applyOk, arc, circle, closeTo, con, ctx, ellipse, entityById, ids, line, ofKind, problems, projectWith, radiusOfArc, rect, relationsOf, spline } from "./edit-test-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

function clean(project: WorkbenchProject): void {
  const found = problems(project);
  if (found.length > 0) throw new Error(`sketch problems after the edit: ${found.join("; ")}`);
}

type P = readonly [number, number];
const endOf = (project: WorkbenchProject, id: string): P => (entityById(project, id) as { end: P }).end;
const startOf = (project: WorkbenchProject, id: string): P => (entityById(project, id) as { start: P }).start;

export const sketchEditTrimTests: readonly TestCase[] = [
  {
    name: "Sketch edit E01 trim and extend at a joined end of Line-tool geometry apply (no conflict) and keep the sides' relations",
    run: () => {
      const joined = [con("joint", "coincident", ["a", "b"], { points: ["end", "start"] }), con("h", "horizontal", ["a"]), con("v", "vertical", ["b"])];
      const project = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50]), line("x", [60, -10], [60, 10])], joined);
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:a", [80, 0]));
      clean(trimmed);
      assert(closeTo(endOf(trimmed, "entity:a"), [60, 0]), "line a is cut back to the crossing");
      equal(relationsOf(trimmed, "horizontal").length, 1, "and stays horizontal");
      equal(relationsOf(trimmed, "coincident").length, 0, "the joint that no longer holds is dropped, not a conflict");
      // Extend the joined end of a toward a wall beyond it.
      const extendable = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50]), line("wall", [150, -20], [150, 20])], joined);
      const extended = applyOk(extendable, extendAt(ctx(extendable), "entity:a", [99, 0]));
      clean(extended);
      assert(closeTo(endOf(extended, "entity:a"), [150, 0]), "a reaches the wall");
      equal(relationsOf(extended, "horizontal").length, 1, "and is still horizontal");
    }
  },
  {
    name: "Sketch edit E14 trim keeps relations on the new pieces and a trimmed circle keeps its radius",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [100, 0]), line("x", [30, -10], [30, 10]), line("y", [60, -10], [60, 10]), line("t", [100, 0], [100, -20])],
        [con("h", "horizontal", ["a"]), con("d", "distance", ["a"], { valueMm: 100, dimension: "length" }), con("tie", "coincident", ["a", "t"], { points: ["end", "start"] })]
      );
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:a", [45, 0]));
      clean(trimmed);
      equal(relationsOf(trimmed, "horizontal").length, 2, "both pieces are horizontal");
      equal(relationsOf(trimmed, "distance").length, 0, "the length dimension no longer holds and is removed");
      const right = ofKind(trimmed, "line").find((candidate) => candidate.start[0] === 60 && candidate.end[0] === 100)!;
      assert(relationsOf(trimmed, "coincident").some((relation) => relation.entityIds.includes(right.id) && relation.entityIds.includes("entity:t")), "the joint at the far end moved to the piece that owns that end");

      const round = projectWith([circle("c", [0, 0], 5), line("cut", [3, -10], [3, 10])], [con("r", "radius", ["c"], { valueMm: 5, dimension: "radius" })]);
      const arcOnly = applyOk(round, trimAt(ctx(round), "entity:c", [5, 0]));
      clean(arcOnly);
      const piece = ofKind(arcOnly, "arc")[0]!;
      near(radiusOfArc(piece), 5, 1e-9, "the arc has the circle's radius");
      assert(relationsOf(arcOnly, "radius").some((relation) => relation.entityIds[0] === piece.id && relation.valueMm === 5), "and keeps the radius dimension");
    }
  },
  {
    name: "Sketch edit E14 an ellipse is a boundary for trim and extend",
    run: () => {
      const toExtend = projectWith([line("a", [-60, 0], [-40, 0]), ellipse("e", [0, 0], 30, 10)]);
      const extended = applyOk(toExtend, extendAt(ctx(toExtend), "entity:a", [-41, 0]));
      near(endOf(extended, "entity:a")[0], -30, 0.01, "the line runs on to the ellipse's end");
      const toTrim = projectWith([line("a", [-60, 0], [-10, 0]), ellipse("e", [0, 0], 30, 10)]);
      const trimmed = applyOk(toTrim, trimAt(ctx(toTrim), "entity:a", [-20, 0]));
      near(endOf(trimmed, "entity:a")[0], -30, 0.01, "trim cuts the part inside the ellipse boundary");
    }
  },
  {
    name: "Sketch edit E21 a rectangle can be trimmed in one click and its sides become joined lines",
    run: () => {
      const project = projectWith([rect("r", [0, 0], 20, 10), line("cut", [0, -10], [0, 10])]);
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:r", [5, -5]));
      clean(trimmed);
      equal(ofKind(trimmed, "rectangle").length, 0, "the rectangle is replaced");
      const lines = ofKind(trimmed, "line").filter((candidate) => candidate.id !== "entity:cut");
      equal(lines.length, 4, "by four lines, the bottom one cut at the crossing");
      const bottom = lines.find((candidate) => candidate.start[1] === -5 && candidate.end[1] === -5)!;
      near(Math.abs(bottom.end[0] - bottom.start[0]), 10, 1e-9, "the bottom edge keeps the 10 mm half that was not picked");
      equal(relationsOf(trimmed, "horizontal").length + relationsOf(trimmed, "vertical").length, 4, "sides keep horizontal and vertical");
    }
  },
  {
    name: "Sketch edit trim handles a spline: the remaining piece follows the original curve",
    run: () => {
      const project = projectWith([spline("s", [[0, 0], [10, 10], [20, 0], [30, 10]]), line("cut", [15, -5], [15, 15])]);
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:s", [25, 5]));
      clean(trimmed);
      const pieces = ofKind(trimmed, "spline");
      equal(pieces.length, 1, "one spline remains");
      near(pieces[0]!.fitPoints[pieces[0]!.fitPoints.length - 1]![0], 15, 1e-6, "ending exactly at the crossing x = 15");
      assert(pieces[0]!.fitPoints.length >= 4, "re-fitted with enough points to follow the curve");
    }
  },
  {
    name: "Sketch edit extend works on arcs and splines",
    run: () => {
      const project = projectWith([arc("a", [10, 0], [0, 10], [-10, 0]), line("floor", [-20, -5], [20, -5])]);
      const extended = applyOk(project, extendAt(ctx(project), "entity:a", [-9.9, 0.5]));
      clean(extended);
      const longer = entityById(extended, "entity:a") as { start: P; mid: P; end: P };
      near(Math.hypot(longer.end[0], longer.end[1]), 10, 1e-9, "the extended end is still on the circle");
      near(longer.end[1], -5, 1e-9, "and lies on the line it was extended to");
      near(longer.start[0], 10, 1e-9, "the other end is untouched");
      const curve = projectWith([spline("s", [[0, 0], [10, 10], [20, 0]]), line("w", [30, -20], [30, 20])]);
      const reached = applyOk(curve, extendAt(ctx(curve), "entity:s", [19, 0]));
      const fit = (entityById(reached, "entity:s") as unknown as { fitPoints: P[] }).fitPoints;
      near(fit[fit.length - 1]![0], 30, 1e-9, "the spline reaches the wall along its end tangent");
    }
  },
  {
    name: "Sketch edit Power Trim cuts every crossing a dragged path passes, and trim-to-closest cuts from the nearer end",
    run: () => {
      const project = projectWith([line("h", [0, 0], [100, 0]), line("v1", [30, -10], [30, 10]), line("v2", [60, -10], [60, 10])]);
      const swept = applyOk(project, powerTrim(ctx(project), [[20, 5], [70, -5]]));
      clean(swept);
      const horizontal = ofKind(swept, "line").filter((candidate) => candidate.start[1] === 0 && candidate.end[1] === 0);
      equal(horizontal.length, 2, "the horizontal line lost the part between the verticals");
      assert(!powerTrim(ctx(project), [[200, 5], [210, 5]]).ok, "a path that crosses nothing is refused");
      const closest = applyOk(project, trimToClosest(ctx(project), "entity:h", [20, 0]));
      assert(closeTo(startOf(closest, "entity:h"), [30, 0]), "trim to closest removes the end up to the first crossing, whatever the exact pick");
    }
  },
  {
    name: "Sketch edit Break at crossings cuts every crossing curve in one edit, keeping relations on the pieces",
    run: () => {
      const project = projectWith(
        [line("h", [0, 0], [100, 0]), line("v1", [30, -10], [30, 10]), line("v2", [60, -10], [60, 10]), circle("c", [80, 0], 10)],
        [con("hor", "horizontal", ["h"]), con("ver", "vertical", ["v1"])]
      );
      const broken = applyOk(project, breakAtCrossings(ctx(project)));
      clean(broken);
      const horizontals = ofKind(broken, "line").filter((candidate) => candidate.start[1] === 0 && candidate.end[1] === 0);
      equal(horizontals.length, 5, "the horizontal line is cut at x = 30, 60, 70 and 90 into five pieces");
      equal(relationsOf(broken, "horizontal").length, 1, "the horizontal relation stays on the first piece");
      assert(relationsOf(broken, "parallel").length >= 4, "and the pieces are chained by joints and parallel relations, so all stay on one horizontal line");
      assert(ofKind(broken, "circle").length === 0 && ofKind(broken, "arc").length === 2, "the circle, crossed twice by the line, became two arcs");
      assert(!breakAtCrossings(ctx(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]))).ok, "curves that never cross have nothing to break");
    }
  },
  {
    name: "Sketch edit E17 splitting a spline keeps both halves on the original curve (0.75 mm off before, under 0.02 mm now)",
    run: () => {
      const fit: P[] = [[0, 0], [10, 10], [20, 0], [30, 10]];
      const project = projectWith([spline("s", fit)]);
      const split = splitAt(ctx(project), "entity:s", [15, 5]);
      assert(split.ok, "the split plans");
      if (!split.ok) return;
      const halves = [...split.value.updateEntities, ...split.value.addEntities].filter((entity) => entity.kind === "spline");
      equal(halves.length, 2, "two splines");
      const original = sampleSpline(fit, 200);
      let worst = 0;
      for (const half of halves) {
        if (half.kind !== "spline") continue;
        for (const point of sampleSpline(half.fitPoints, 40)) {
          let best = Infinity;
          for (let index = 0; index < original.length - 1; index += 1) {
            const a = original[index]!;
            const b = original[index + 1]!;
            const d = [b[0] - a[0], b[1] - a[1]];
            const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * d[0]! + (point[1] - a[1]) * d[1]!) / (d[0]! * d[0]! + d[1]! * d[1]!)));
            best = Math.min(best, Math.hypot(point[0] - a[0] - d[0]! * t, point[1] - a[1] - d[1]! * t));
          }
          worst = Math.max(worst, best);
        }
      }
      assert(worst < 0.02, `halves stay within 0.02 mm of the original (worst ${worst.toFixed(4)} mm)`);
      const committed = applyOk(project, split);
      equal(ofKind(committed, "spline").length, 2, "and the split commits");
    }
  },
  {
    name: "Sketch edit E02/E11 trim and extend refuse a Fixed curve and never leave a sliver under the model minimum",
    run: () => {
      const fixed = projectWith([line("a", [0, 0], [100, 0]), line("x", [40, -5], [40, 5])], [con("f", "fixed", ["a"])]);
      const refused = trimAt(ctx(fixed), "entity:a", [10, 0]);
      assert(!refused.ok && /fixed/u.test(refused.diagnostics[0]!.message), "a fixed line is not trimmed");
      const wall = projectWith([line("a", [0, 0], [50, 0]), line("w", [80, -5], [80, 5])], [con("f", "fixed", ["a"])]);
      assert(!extendAt(ctx(wall), "entity:a", [49, 0]).ok, "or extended");
      const sliver = projectWith([line("a", [0, 0], [100, 0]), line("x", [0.005, -5], [0.005, 5]), line("y", [50, -5], [50, 5])]);
      const cut = applyOk(sliver, trimAt(ctx(sliver), "entity:a", [30, 0]));
      clean(cut);
      const pieces = ofKind(cut, "line").filter((candidate) => candidate.start[1] === 0 && candidate.end[1] === 0);
      equal(pieces.length, 1, "a 0.005 mm leftover is dropped with the cut part instead of failing validation");
    }
  }
];
