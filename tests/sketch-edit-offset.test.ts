import { expandOffsetSelection, offsetEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { applyOk, arc, circle, commit, con, ctx, ellipse, ids, line, ofKind, problems, projectWith, radiusOfArc, relationsOf, spline } from "./edit-test-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";

function clean(project: WorkbenchProject): void {
  const found = problems(project);
  if (found.length > 0) throw new Error(`sketch problems after the edit: ${found.join("; ")}`);
}

/** A slot: two lines and two half-circles, with the lower line drawn right to left on purpose. */
function slot(lowerReversed = false) {
  return projectWith([
    line("t", [0, 10], [50, 10]),
    arc("ar", [50, 10], [60, 0], [50, -10]),
    lowerReversed ? line("b", [50, -10], [0, -10]) : line("b", [0, -10], [50, -10]),
    arc("al", [0, -10], [-10, 0], [0, 10])
  ]);
}

function dumbbell() {
  const points: [number, number][] = [[0, 0], [40, 0], [40, 20], [60, 20], [60, 0], [100, 0], [100, 50], [60, 50], [60, 30], [40, 30], [40, 50], [0, 50]];
  const names = points.map((_, index) => `d${index}`);
  return { project: projectWith(points.map((point, index) => line(names[index]!, point, points[(index + 1) % points.length]!))), names };
}

export const sketchEditOffsetTests: readonly TestCase[] = [
  {
    name: "Sketch edit E05 offset of a slot joins lines and arcs, goes outward whatever the line direction, and keeps relations",
    run: () => {
      for (const reversed of [false, true]) {
        const project = slot(reversed);
        const outward = applyOk(project, offsetEntities(ctx(project), ids("t", "ar", "b", "al"), 3));
        clean(outward);
        const copies = outward.sketch.entities.filter((entity) => !["t", "ar", "b", "al"].some((name) => entity.id === `entity:${name}`));
        const lines = copies.filter((entity) => entity.kind === "line");
        const arcs = copies.filter((entity) => entity.kind === "arc");
        equal(lines.length, 2, "two lines");
        equal(arcs.length, 2, "two arcs");
        const ys = lines.map((entity) => (entity.kind === "line" ? entity.start[1] : 0)).sort((a, b) => a - b);
        near(ys[0]!, -13, 1e-9, "the lower line moved down by 3 (outward), however it was drawn");
        near(ys[1]!, 13, 1e-9, "the upper line moved up by 3");
        for (const piece of arcs) near(piece.kind === "arc" ? radiusOfArc(piece) : 0, 13, 1e-9, "arcs grow to radius 13, joined to the lines");
        equal(relationsOf(outward, "parallel").length, 2, "the offset lines are parallel to their sources");
        equal(relationsOf(outward, "concentric").length, 2, "the offset arcs are concentric with theirs");
        equal(relationsOf(outward, "tangent").length >= 4, true, "and the smooth junctions stay tangent");
        // The result closes a profile with the right area (rectangle 50 x 26 plus a full circle of radius 13).
        const offsetOnly = { ...outward.sketch, entities: copies, constraints: [] };
        const profile = detectSketchProfiles(offsetOnly)[0]!;
        near(profile.areaMm2, 50 * 26 + Math.PI * 169, 3, "the offset outline encloses the expected area");
        const inward = applyOk(project, offsetEntities(ctx(project), ids("t", "ar", "b", "al"), -3));
        clean(inward);
        const radii = ofKind(inward, "arc").filter((entity) => !["ar", "al"].some((name) => entity.id === `entity:${name}`)).map(radiusOfArc);
        for (const radius of radii) near(radius, 7, 1e-9, "a negative distance shrinks the arcs to radius 7");
      }
    }
  },
  {
    name: "Sketch edit E05 picking one curve of a smooth chain offsets the whole tangent chain; a corner type closes outside corners",
    run: () => {
      const project = slot();
      equal(expandOffsetSelection(project.sketch, ids("t"), "tangent").length, 4, "the tangent chain of one slot line is the whole slot");
      equal(expandOffsetSelection(project.sketch, ids("t"), "none").length, 1, "chain none keeps the selection");
      const whole = applyOk(project, offsetEntities(ctx(project), ids("t"), 3));
      equal(whole.sketch.entities.length, 8, "one pick offsets all four curves");
      const single = applyOk(project, offsetEntities(ctx(project), ids("t"), 3, { chain: "none" }));
      equal(single.sketch.entities.length, 5, "or just the picked line");

      const elbow = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])]);
      const mitre = applyOk(elbow, offsetEntities(ctx(elbow), ids("a", "b"), -1, { corner: "mitre" }));
      equal(mitre.sketch.entities.length, 4, "mitre: two lines");
      const round = applyOk(elbow, offsetEntities(ctx(elbow), ids("a", "b"), -1, { corner: "round" }));
      equal(ofKind(round, "arc").length, 1, "round: a quarter arc closes the outside corner");
      near(radiusOfArc(ofKind(round, "arc")[0]!), 1, 1e-9, "of radius equal to the distance");
      const chamfer = applyOk(elbow, offsetEntities(ctx(elbow), ids("a", "b"), -1, { corner: "chamfer" }));
      equal(ofKind(chamfer, "line").length, 5, "chamfer: a straight cut closes it");
      clean(round);
      clean(chamfer);
    }
  },
  {
    name: "Sketch edit E06 offset refuses a neck narrower than twice the distance and accepts one just under it",
    run: () => {
      const { project, names } = dumbbell();
      for (const distance of [-6, -8]) {
        const refused = offsetEntities(ctx(project), ids(...names), distance);
        assert(!refused.ok, `${distance} on a 10 mm neck is refused`);
        if (!refused.ok) assert(/narrower than twice/u.test(refused.diagnostics[0]!.message), "with a message about the narrow feature");
      }
      const fine = applyOk(project, offsetEntities(ctx(project), ids(...names), -4.9));
      clean(fine);
      equal(fine.sketch.entities.length, 24, "4.9 mm still offsets all twelve edges");
    }
  },
  {
    name: "Sketch edit E13 a branching line network is refused with the junction named, a closed square alone offsets outward",
    run: () => {
      const square = [line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10]), line("c", [10, 10], [0, 10]), line("d", [0, 10], [0, 0])];
      const alone = projectWith(square);
      const grown = applyOk(alone, offsetEntities(ctx(alone), ids("a", "b", "c", "d"), 2));
      const xs = grown.sketch.entities.slice(4).flatMap((entity) => (entity.kind === "line" ? [entity.start[0], entity.end[0]] : []));
      near(Math.min(...xs), -2, 1e-9, "outward on the left");
      near(Math.max(...xs), 12, 1e-9, "and the right");
      const branched = projectWith([...square, line("x", [0, 0], [10, 10])]);
      const result = offsetEntities(ctx(branched), ids("a", "b", "c", "d", "x"), 2);
      assert(!result.ok, "a diagonal makes the selection branch");
      if (!result.ok) assert(/branches at/u.test(result.diagnostics[0]!.message), "and the message names the junction");
    }
  },
  {
    name: "Sketch edit E20 an open line offsets to the same side whichever way it was drawn; flip, both sides and a side point choose",
    run: () => {
      const forward = projectWith([line("a", [0, 0], [10, 0])]);
      const backward = projectWith([line("a", [10, 0], [0, 0])]);
      for (const project of [forward, backward]) {
        const plus = applyOk(project, offsetEntities(ctx(project), ids("a"), 5));
        near((ofKind(plus, "line")[1]!).start[1], 5, 1e-12, "positive lands at y = +5 for both drawing directions");
        const flipped = applyOk(project, offsetEntities(ctx(project), ids("a"), 5, { flip: true }));
        near((ofKind(flipped, "line")[1]!).start[1], -5, 1e-12, "flip puts it at y = -5");
        const both = applyOk(project, offsetEntities(ctx(project), ids("a"), 5, { both: true }));
        equal(ofKind(both, "line").length, 3, "both sides adds two lines");
        const picked = applyOk(project, offsetEntities(ctx(project), ids("a"), 5, { sidePoint: [4, -2] }));
        near((ofKind(picked, "line")[1]!).start[1], -5, 1e-12, "a side point below the line puts the copy below");
        const above = applyOk(project, offsetEntities(ctx(project), ids("a"), 5, { sidePoint: [4, 2] }));
        near((ofKind(above, "line")[1]!).start[1], 5, 1e-12, "and above puts it above");
      }
    }
  },
  {
    name: "Sketch edit offsets circles (concentric), ellipses and splines, and refuses the inward offset that folds",
    run: () => {
      const round = projectWith([circle("c", [0, 0], 10)]);
      const grown = applyOk(round, offsetEntities(ctx(round), ids("c"), 4));
      equal(relationsOf(grown, "concentric").length, 1, "an offset circle is concentric with its source");
      const ring = projectWith([ellipse("e", [0, 0], 30, 10)]);
      const around = applyOk(ring, offsetEntities(ctx(ring), ids("e"), 2));
      const outer = around.sketch.entities.find((entity) => entity.kind === "spline");
      assert(outer !== undefined && outer.kind === "spline", "an ellipse offsets to a spline");
      if (outer?.kind === "spline") {
        // The offset curve is 2 mm from the ellipse everywhere: check at the axis ends.
        const xs = outer.fitPoints.map((point) => point[0]);
        near(Math.max(...xs), 32, 0.05, "reaching x = 32 at the major axis end");
      }
      assert(!offsetEntities(ctx(ring), ids("e"), -9).ok, "inward past the smallest radius of curvature folds and is refused");
      const curve = projectWith([spline("s", [[0, 0], [20, 6], [40, 0], [60, 6]])]);
      const shifted = applyOk(curve, offsetEntities(ctx(curve), ids("s"), 1.5));
      assert(shifted.sketch.entities.some((entity) => entity.kind === "spline" && entity.id !== "entity:s"), "a spline offsets to a spline");
      const big = offsetEntities(ctx(curve), ids("s"), 40);
      assert(big.ok || big.diagnostics.length > 0, "large distances are judged with a message, not crashed");
    }
  },
  {
    name: "Sketch edit E11 an offset beyond the model limit says so; construction flags are inherited",
    run: () => {
      const huge = projectWith([line("a", [-99000, -99000], [99000, -99000]), line("b", [99000, -99000], [99000, 99000]), line("c", [99000, 99000], [-99000, 99000]), line("d", [-99000, 99000], [-99000, -99000])]);
      const result = offsetEntities(ctx(huge), ids("a", "b", "c", "d"), 2000);
      assert(!result.ok, "a 198000 mm square offset by 2000 would leave the 100000 mm limit");
      if (!result.ok) assert(/100000/u.test(result.diagnostics[0]!.message), "and the message names the limit");
      const construction = projectWith([line("a", [0, 0], [10, 0], { construction: true })]);
      equal(ofKind(applyOk(construction, offsetEntities(ctx(construction), ids("a"), 2)), "line")[1]!.construction, true, "the copy of a construction line is construction");
    }
  },
  {
    name: "Sketch edit offset of a drawn outline with joint relations applies without conflict",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [30, 0]), line("b", [30, 0], [30, 20]), line("c", [30, 20], [0, 20]), line("d", [0, 20], [0, 0])],
        ["a", "b", "c", "d"].map((name, index) => con(`j${index}`, "coincident", [name, ["b", "c", "d", "a"][index]!], { points: ["end", "start"] }))
      );
      const result = commit(project, offsetEntities(ctx(project), ids("a", "b", "c", "d"), 5));
      assert(result.ok, "the offset commits");
    }
  }
];
