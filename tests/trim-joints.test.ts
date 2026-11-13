import { dragLiveSketch, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type Vec2, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch, detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { trimAt } from "../packages/workbench-sketch/src/edit-tools.js";
import { powerTrim } from "../packages/workbench-sketch/src/trim-extend.js";
import { applyOk, arc, circle, closeTo, con, ctx, line, ofKind, problems, projectWith, rect, relationsOf, spline } from "./edit-test-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Trim ties each new end to the curve it was cut against: a joint when the cut lands on that curve's own end, otherwise point on curve.
 * The pieces of a trimmed outline therefore stay together when one of them is dragged.
 */

type Arc = Extract<SketchEntity, { kind: "arc" }>;

function clean(project: WorkbenchProject): void {
  const found = problems(project);
  if (found.length > 0) throw new Error(`sketch problems after the edit: ${found.join("; ")}`);
}

const tieText = (relation: WorkbenchSketchConstraint): string => `${relation.entityIds.join("+")}@${(relation.points ?? []).join("+")}`;

/** Two circles of radius 10, 12 mm apart, trimmed to the lens they share. They cross at (6, 8) and (6, -8). */
function lens(): WorkbenchProject {
  const project = projectWith([circle("a", [0, 0], 10), circle("b", [12, 0], 10)]);
  const first = applyOk(project, trimAt(ctx(project), "entity:a", [-10, 0]));
  return applyOk(first, trimAt(ctx(first), "entity:b", [22, 0]));
}

const gap = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const trimJointTests: readonly TestCase[] = [
  {
    name: "Trim joints: a line cut back to a crossing has its new end held on the cutting line, and follows that line when it moves",
    run: () => {
      const project = projectWith([line("a", [0, 0], [100, 0]), line("x", [60, -10], [60, 10])], [con("h", "horizontal", ["a"])]);
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:a", [80, 0]));
      clean(trimmed);
      const ties = relationsOf(trimmed, "coincident");
      equal(ties.map(tieText).join(), "entity:a+entity:x@end+curve", "one point-on-curve relation: the new end of a on x");
      // Drag the cutter sideways: the trimmed end goes with it.
      const dragged = dragLiveSketch(trimmed.sketch, { entityId: "entity:x", point: "start", positionMm: [70, -10] });
      assert(dragged.ok, `the drag solves: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const a = dragged.entities.find((entity) => entity.id === "entity:a");
      const x = dragged.entities.find((entity) => entity.id === "entity:x");
      assert(a?.kind === "line" && x?.kind === "line", "both lines are still there");
      // The end of a lies on the (moved) line x: the cross product of x's direction with the vector to the end is zero.
      const cross = (x.end[0] - x.start[0]) * (a.end[1] - x.start[1]) - (x.end[1] - x.start[1]) * (a.end[0] - x.start[0]);
      near(cross, 0, 1e-6, "the trimmed end stays on the cutter");
      near(a.end[1] - a.start[1], 0, 1e-6, "and the line stays horizontal");
    }
  },
  {
    name: "Trim joints: the middle cut out of a line ties both new ends, one to each cutter, and the far joint moves to the piece that owns that end",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [100, 0]), line("x", [30, -10], [30, 10]), line("y", [60, -10], [60, 10]), line("t", [100, 0], [100, -20])],
        [con("tie", "coincident", ["a", "t"], { points: ["end", "start"] })]
      );
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:a", [45, 0]));
      clean(trimmed);
      const right = ofKind(trimmed, "line").find((candidate) => candidate.start[0] === 60 && candidate.end[0] === 100);
      assert(right !== undefined, "the right-hand piece exists");
      const ties = relationsOf(trimmed, "coincident").map(tieText).sort();
      equal(ties.join(" | "), [`entity:a+entity:x@end+curve`, `${right.id}+entity:t@end+start`, `${right.id}+entity:y@start+curve`].sort().join(" | "), "left piece on x, right piece on y, and the old end joint on the right piece");
    }
  },
  {
    name: "Trim joints: a cut that lands on the other curve's own end makes a joint, and replaces the point-on-curve relation that end had",
    run: () => {
      // The stem ends on the bar (a T), held there by point on curve. Trimming the bar's right half back to the stem joins the two ends.
      const project = projectWith(
        [line("bar", [0, 0], [100, 0]), line("stem", [40, 30], [40, 0])],
        [con("on", "coincident", ["stem", "bar"], { points: ["end", "curve"] })]
      );
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:bar", [70, 0]));
      clean(trimmed);
      equal(relationsOf(trimmed, "coincident").map(tieText).join(), "entity:bar+entity:stem@end+end", "one joint between the two ends, and no leftover point-on-curve");
      equal(analyzeWorkbenchSketch(trimmed.sketch).redundant.length, 0, "nothing is redundant");
    }
  },
  {
    name: "Trim joints: a circle trimmed between two lines becomes an arc with both ends held on the lines and its radius kept",
    run: () => {
      const project = projectWith([circle("c", [0, 0], 5), line("p", [3, -10], [3, 10]), line("q", [-3, -10], [-3, 10])], [con("r", "radius", ["c"], { valueMm: 5, dimension: "radius" })]);
      const trimmed = applyOk(project, trimAt(ctx(project), "entity:c", [5, 0]));
      clean(trimmed);
      const piece = ofKind(trimmed, "arc")[0];
      assert(piece !== undefined, "the circle became an arc");
      const ties = relationsOf(trimmed, "coincident").map(tieText).sort();
      equal(ties.join(" | "), [`${piece.id}+entity:p@start+curve`, `${piece.id}+entity:p@end+curve`].sort().join(" | "), "both ends are on the line that cut them");
      assert(relationsOf(trimmed, "radius").some((relation) => relation.entityIds[0] === piece.id && relation.valueMm === 5), "the radius dimension is carried");
    }
  },
  {
    name: "Trim joints: an arc cut in the middle ties each new end to its cutter, whichever way the arc was drawn",
    run: () => {
      for (const reversed of [false, true]) {
        // Upper half circle of radius 10 from (10, 0) to (-10, 0), or drawn the other way round.
        const half = reversed ? arc("h", [-10, 0], [0, 10], [10, 0]) : arc("h", [10, 0], [0, 10], [-10, 0]);
        const project = projectWith([half, line("p", [5, 0], [5, 20]), line("q", [-5, 0], [-5, 20])]);
        const trimmed = applyOk(project, trimAt(ctx(project), "entity:h", [0, 10]));
        clean(trimmed);
        const arcs = ofKind(trimmed, "arc");
        equal(arcs.length, 2, "two pieces are left");
        for (const relation of relationsOf(trimmed, "coincident")) {
          const piece = arcs.find((candidate) => candidate.id === relation.entityIds[0]) as Arc;
          const cutter = relation.entityIds[1] === "entity:p" ? 5 : -5;
          const end = relation.points?.[0] === "start" ? piece.start : piece.end;
          near(end[0], cutter, 1e-9, `the tied end of ${piece.id} is the one at x = ${cutter} (${reversed ? "reversed" : "forward"} arc)`);
          equal(relation.points?.[1], "curve", "held on the cutter");
        }
        equal(relationsOf(trimmed, "coincident").length, 2, "one relation per new end");
      }
    }
  },
  {
    name: "Trim joints: two circles trimmed to a lens are two arcs joined at both ends, still one profile after an end is dragged, saved and reloaded",
    run: () => {
      const made = lens();
      clean(made);
      const arcs = ofKind(made, "arc");
      equal(arcs.length, 2, "two arcs");
      equal(ofKind(made, "circle").length, 0, "no circle is left");
      const ties = relationsOf(made, "coincident");
      equal(ties.length, 2, "two relations tie the lens");
      assert(ties.every((relation) => (relation.points ?? []).every((ref) => ref === "start" || ref === "end")), `both are end-to-end joints: ${ties.map(tieText).join(" | ")}`);
      equal(analyzeWorkbenchSketch(made.sketch).redundant.length, 0, "nothing redundant is left behind by the first trim");
      equal(detectSketchProfiles(made.sketch).length, 1, "the lens is one closed profile");
      // Drag the upper tip of the lens: both arcs go with it.
      const tip = arcs.flatMap((piece) => [{ piece, ref: "start" as const, at: piece.start }, { piece, ref: "end" as const, at: piece.end }]).find((end) => closeTo(end.at, [6, 8], 1e-6));
      assert(tip !== undefined, "an arc ends at the upper crossing (6, 8)");
      const dragged = dragLiveSketch(made.sketch, { entityId: tip.piece.id, point: tip.ref, positionMm: [7, 11] });
      assert(dragged.ok, `the drag solves: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const after = dragged.entities.filter((entity): entity is Arc => entity.kind === "arc");
      const ends = after.flatMap((piece) => [piece.start, piece.end]);
      const upper = ends.filter((point) => point[1] > 0);
      const lower = ends.filter((point) => point[1] < 0);
      assert(upper.length === 2 && lower.length === 2, "each arc has an upper and a lower end");
      assert(gap(upper[0]!, upper[1]!) < 1e-6 && gap(lower[0]!, lower[1]!) < 1e-6, `the ends still meet (upper gap ${gap(upper[0]!, upper[1]!)}, lower gap ${gap(lower[0]!, lower[1]!)})`);
      assert(gap(upper[0]!, [6, 8]) > 0.5, "and the tip really moved");
      equal(detectSketchProfiles({ ...made.sketch, entities: dragged.entities }).length, 1, "still one profile after the drag");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(made));
      assert(reloaded.ok && reloaded.value.sketch.constraints.filter((relation) => relation.kind === "coincident").length === 2, "the joints are saved");
    }
  },
  {
    name: "Trim joints: a cut against a spline or a rectangle leaves the end free (they cannot hold a point), and Power Trim ties its cuts",
    run: () => {
      const wavy = projectWith([line("a", [0, 0], [100, 0]), spline("s", [[50, -20], [55, -5], [50, 10], [55, 25]])]);
      const cutBySpline = applyOk(wavy, trimAt(ctx(wavy), "entity:a", [90, 0]));
      clean(cutBySpline);
      equal(relationsOf(cutBySpline, "coincident").length, 0, "no relation to a spline");
      const boxed = projectWith([line("a", [-50, 0], [50, 0]), rect("box", [0, 0], 40, 20)]);
      const cutByBox = applyOk(boxed, trimAt(ctx(boxed), "entity:a", [40, 0]));
      clean(cutByBox);
      equal(relationsOf(cutByBox, "coincident").length, 0, "no relation to a rectangle entity");
      const crossed = projectWith([line("a", [0, 0], [100, 0]), line("x", [60, -10], [60, 10])]);
      const swept = applyOk(crossed, powerTrim(ctx(crossed), [[80, -5], [80, 5]]));
      clean(swept);
      equal(relationsOf(swept, "coincident").map(tieText).join(), "entity:a+entity:x@end+curve", "a dragged trim ties the end the same way");
    }
  },
];
