import {
  applyWorkbenchOperation,
  type WorkbenchOperation,
  type WorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { MIRROR_AXIS_X, mirrorEntities, patternEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { offsetEntities } from "../packages/workbench-sketch/src/offset-tools.js";
import { chamferCornersAngle, filletCorners } from "../packages/workbench-sketch/src/corner-tools.js";
import { deleteCurveHeal, splitAt } from "../packages/workbench-sketch/src/split-jog.js";
import { applyOk, arc, circle, commit, con, ctx, ids, line, newId, ofKind, projectWith, spline } from "./edit-test-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Wave 2 (ui2): the re-audit findings on the sketch edit tools. Every case plans an edit and commits it through the real operation. */

let serial = 0;
function setDimension(project: WorkbenchProject, entityId: string, dimension: "length" | "radius", valueMm: number): ReturnType<typeof applyWorkbenchOperation> {
  serial += 1;
  const operation = { kind: "set-sketch-dimension", operationId: `operation:ui2-edit-${serial}`, expectedRevision: project.revision, entityId, dimension, valueMm } as WorkbenchOperation;
  return applyWorkbenchOperation(project, operation);
}

function redundancies(project: WorkbenchProject): string[] {
  const report = analyzeSketch({ sketch: project.sketch, newId });
  return report.issues.filter((issue) => issue.category === "redundant" || issue.category === "conflict").map((issue) => issue.title);
}

const square = (): ReturnType<typeof line>[] => [line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 60]), line("c", [100, 60], [0, 60]), line("d", [0, 60], [0, 0])];
const squareRelations = () => [
  con("c1", "coincident", ["a", "b"], { points: ["end", "start"] }), con("c2", "coincident", ["b", "c"], { points: ["end", "start"] }),
  con("c3", "coincident", ["c", "d"], { points: ["end", "start"] }), con("c4", "coincident", ["d", "a"], { points: ["end", "start"] }),
  con("h1", "horizontal", ["a"]), con("h2", "horizontal", ["c"]), con("v1", "vertical", ["b"]), con("v2", "vertical", ["d"]),
  con("w", "distance", ["a"], { valueMm: 100, dimension: "length" }), con("hh", "distance", ["b"], { valueMm: 60, dimension: "length" })
];

export const sketchUi2EditTests: readonly TestCase[] = [
  {
    name: "Re-audit edit N1: a pattern or mirror copy follows its source's dimension, so editing the source dimension keeps the sketch solvable",
    run: () => {
      // Pattern of a circle with a Radius dimension: one dimension (the source's), the copies are Equal to it.
      let project = projectWith([circle("c", [20, 0], 5)], [con("r", "radius", ["c"], { valueMm: 5 })]);
      project = applyOk(project, patternEntities(ctx(project), ids("c"), { kind: "rectangular", countX: 3, countY: 1, dxMm: 30, dyMm: 0 }));
      equal(project.sketch.constraints.filter((relation) => relation.kind === "radius").length, 1, "the radius dimension stays on the source only");
      equal(project.sketch.constraints.filter((relation) => relation.kind === "equal").length, 2, "and each copy is Equal to it");
      const edited = setDimension(project, "entity:c", "radius", 8);
      assert(edited.ok, `editing the source radius is accepted: ${edited.ok ? "" : edited.diagnostics[0]?.message}`);
      if (edited.ok) {
        const radii = ofKind(edited.value.project, "circle").map((entity) => entity.radiusMm);
        assert(radii.length === 3 && radii.every((radius) => Math.abs(radius - 8) < 1e-6), `every copy follows: ${radii.join(", ")}`);
      }
      // A line with a Length dimension, patterned.
      let bar = projectWith([line("l", [0, 0], [40, 0])], [con("len", "distance", ["l"], { valueMm: 40, dimension: "length" })]);
      bar = applyOk(bar, patternEntities(ctx(bar), ids("l"), { kind: "rectangular", countX: 1, countY: 3, dxMm: 0, dyMm: 10 }));
      const longer = setDimension(bar, "entity:l", "length", 55);
      assert(longer.ok, `a patterned line's length can be edited: ${longer.ok ? "" : longer.diagnostics[0]?.message}`);
      // Mirror about a line.
      let mirrored = projectWith([line("a", [10, 0], [30, 0]), line("axis", [0, -100], [0, 100])], [con("h", "horizontal", ["a"]), con("d", "distance", ["a"], { valueMm: 20, dimension: "length" })]);
      mirrored = applyOk(mirrored, mirrorEntities(ctx(mirrored), ids("a", "axis")));
      const lengthened = setDimension(mirrored, "entity:a", "length", 35);
      assert(lengthened.ok, `a mirrored line's source length can be edited: ${lengthened.ok ? "" : lengthened.diagnostics[0]?.message}`);
      let disc = projectWith([circle("c", [20, 0], 5), line("axis", [0, -100], [0, 100])], [con("r", "radius", ["c"], { valueMm: 5 })]);
      disc = applyOk(disc, mirrorEntities(ctx(disc), ids("c", "axis")));
      assert(setDimension(disc, "entity:c", "radius", 8).ok, "a mirrored circle's source radius can be edited");
      // About the sketch axis there is no symmetry relation, so the copy keeps its own dimension (nothing ties it to the source).
      let free = projectWith([circle("c", [20, 5], 5)], [con("r", "radius", ["c"], { valueMm: 5 })]);
      free = applyOk(free, mirrorEntities(ctx(free), ids("c").concat(MIRROR_AXIS_X)));
      equal(free.sketch.constraints.filter((relation) => relation.kind === "radius").length, 2, "mirrored about the sketch axis the copy is independent and keeps its own radius");
      assert(setDimension(free, "entity:c", "radius", 8).ok, "and editing the source is still fine");
    }
  },
  {
    name: "Re-audit edit N3: split, mirror, pattern and offset leave no redundant relation for the Repair panel to list",
    run: () => {
      let cur = projectWith(square(), squareRelations());
      for (let step = 0; step < 6; step += 1) {
        const longest = cur.sketch.entities.filter((entity) => entity.kind === "line" && entity.start[1] === 0 && entity.end[1] === 0).sort((x, y) => (y.kind === "line" && x.kind === "line" ? (y.end[0] - y.start[0]) - (x.end[0] - x.start[0]) : 0))[0]!;
        if (longest.kind !== "line") throw new Error("expected a line");
        cur = applyOk(cur, splitAt(ctx(cur), longest.id, [(longest.start[0] + longest.end[0]) / 2, 0]));
        equal(JSON.stringify(redundancies(cur)), "[]", `after split ${step + 1} the sketch is not over-defined`);
      }
      // The pieces still stay in one straight line: dragging the far end of the last piece through the live solver keeps them level.
      const pieces = cur.sketch.entities.filter((entity) => entity.kind === "line" && entity.start[1] === 0 && entity.end[1] === 0);
      equal(pieces.length, 7, "seven pieces along the bottom");

      // Mirror of a joined polygon.
      let polygon = projectWith(
        [line("s1", [10, 0], [30, 0]), line("s2", [30, 0], [30, 20]), line("s3", [30, 20], [10, 20]), line("s4", [10, 20], [10, 0]), line("ax", [0, -10], [0, 40])],
        [con("j1", "coincident", ["s1", "s2"], { points: ["end", "start"] }), con("j2", "coincident", ["s2", "s3"], { points: ["end", "start"] }), con("j3", "coincident", ["s3", "s4"], { points: ["end", "start"] }), con("j4", "coincident", ["s4", "s1"], { points: ["end", "start"] }), con("hh", "horizontal", ["s1"])]
      );
      polygon = applyOk(polygon, mirrorEntities(ctx(polygon), ids("s1", "s2", "s3", "s4", "ax")));
      equal(JSON.stringify(redundancies(polygon)), "[]", "a mirrored joined polygon is not over-defined");

      // Rectangular pattern of a closed, constrained rectangle.
      let box = projectWith(square(), squareRelations());
      box = applyOk(box, patternEntities(ctx(box), ids("a", "b", "c", "d"), { kind: "rectangular", countX: 3, countY: 2, dxMm: 150, dyMm: 100 }));
      equal(JSON.stringify(redundancies(box)), "[]", "a patterned rectangle is not over-defined");
      assert(setDimension(box, "entity:a", "length", 120).ok, "and its source dimension can still be edited");

      // Offset of a closed loop.
      let loop = projectWith(square(), squareRelations());
      loop = applyOk(loop, offsetEntities(ctx(loop), ids("a", "b", "c", "d"), 5));
      equal(JSON.stringify(redundancies(loop)), "[]", "an offset loop is not over-defined");
    }
  },
  {
    name: "Re-audit edit N4: a split or a heal that the old relations could not survive is settled at plan time, so Apply never fails with a solver conflict",
    run: () => {
      // (a) an arc with an arc-length dimension.
      const A = arc("a", [0, 0], [10, 10], [20, 0]);
      const withArcLength = projectWith([A, line("x", [5, -5], [5, 20])], [con("al", "arc-length", ["a"], { valueMm: 31.4159 })]);
      const split = splitAt(ctx(withArcLength), "entity:a", [10, 10]);
      assert(split.ok, "the split plans");
      const done = commit(withArcLength, split);
      assert(done.ok, `and commits: ${done.ok ? "" : done.message}`);
      if (done.ok) assert(!done.project.sketch.constraints.some((relation) => relation.kind === "arc-length"), "the arc-length dimension of the whole arc is dropped with the split, not left to conflict");
      // (b) a spline pair joined by Smooth.
      const smooth = projectWith(
        [spline("s1", [[0, 0], [10, 10], [20, 10]]), spline("s2", [[20, 10], [30, 10], [40, 0]])],
        [con("sm", "smooth", ["s1", "s2"], { points: ["end", "start"] })]
      );
      const splitSpline = splitAt(ctx(smooth), "entity:s1", [10, 10]);
      assert(splitSpline.ok && commit(smooth, splitSpline).ok, "splitting a spline that is smooth-joined to another goes through");
      // (c) heal the chamfer of a patterned rectangle.
      const base = [...squareRelations().filter((relation) => relation.kind !== "distance")];
      let plate = projectWith(square(), base);
      const chamfer = chamferCornersAngle(ctx(plate), ids("a", "b"), 10, 45);
      plate = applyOk(plate, chamfer.ok ? chamfer : (() => { throw new Error("chamfer"); })());
      const made = plate.sketch.entities.find((entity) => !["a", "b", "c", "d"].some((name) => entity.id === `entity:${name}`))!;
      const patterned = applyOk(plate, patternEntities(ctx(plate), [...ids("a", "b", "c", "d"), made.id], { kind: "rectangular", countX: 2, countY: 1, dxMm: 200, dyMm: 0 }));
      const healed = deleteCurveHeal(ctx(patterned), made.id);
      assert(healed.ok, "the heal plans");
      const healedCommit = commit(patterned, healed);
      assert(healedCommit.ok, `and commits (the Equal links to the deleted chamfer are settled): ${healedCommit.ok ? "" : healedCommit.message}`);
    }
  },
  {
    name: "Re-audit edit N5: a fillet between a line and an arc that cross twice never rounds the far crossing or deletes the lobe between them",
    run: () => {
      const L = 102.64308851212263;
      const lobe = projectWith([line("a", [0, 0], [L, 0]), arc("b", [L, 0], [69.9262220544923, 10.580884763053923], [43.919416565434595, -11.913437663499886])]);
      const refused = filletCorners(ctx(lobe), ids("a", "b"), 6.81907750829123);
      assert(!refused.ok, "a radius that does not fit in the corner is refused, not placed at the other crossing");
      if (!refused.ok) assert(/cross again/u.test(refused.diagnostics[0]!.message), `and the message says why: ${refused.diagnostics[0]!.message}`);
      // A radius that does fit rounds the corner at the shared end.
      const fits = applyOk(lobe, filletCorners(ctx(lobe), ids("a", "b"), 3));
      const a = fits.sketch.entities.find((entity) => entity.id === "entity:a")!;
      assert(a.kind === "line" && a.end[0] > 90, `the line is cut back only a little at the corner (ends at x = ${a.kind === "line" ? a.end[0].toFixed(1) : "?"})`);
      // Picking the far crossing rounds that corner instead, with the part up to it kept.
      const far = filletCorners(ctx(lobe), ids("a", "b"), 3, { near: [51.14, 0] });
      assert(far.ok, `a click at the other crossing rounds that corner: ${far.ok ? "" : far.diagnostics[0]?.message}`);
      // 300 random line/arc corners: no accepted fillet removes more than the fillet itself would (the old build deleted up to 51 mm).
      let seed = 99;
      const random = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const between = (low: number, high: number): number => low + (high - low) * random();
      let checked = 0;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const length = between(40, 120);
        const radius = between(15, 50);
        const angle = between(0.3, 2.8);
        const direction = random() < 0.5 ? 1 : -1;
        const centre: readonly [number, number] = [length - radius * Math.cos(angle), -radius * Math.sin(angle)];
        const sweep = between(0.8, 2.2) * direction;
        const at = (a: number): readonly [number, number] => [centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)];
        const project = projectWith([line("a", [0, 0], [length, 0]), arc("b", [length, 0], at(angle + sweep / 2), at(angle + sweep))]);
        const radiusFillet = between(1, 8);
        const result = filletCorners(ctx(project), ids("a", "b"), radiusFillet);
        if (!result.ok) continue;
        checked += 1;
        const cut = result.value.updateEntities.find((entity) => entity.id === "entity:a");
        const reach = cut !== undefined && cut.kind === "line" ? length - cut.end[0] : 0;
        assert(reach < Math.max(radiusFillet * 3, 40), `the line is cut back by ${reach.toFixed(1)} mm for a ${radiusFillet.toFixed(1)} mm fillet`);
      }
      assert(checked > 150, `most random corners still round (${checked} of 300)`);
    }
  },
  {
    name: "Re-audit edit N6: a closed profile smaller than the snap tolerance still offsets (the join tolerance follows the feature size)",
    run: () => {
      for (const side of [0.05, 0.08, 0.1, 1]) {
        const tiny = projectWith([line("a", [0, 0], [side, 0]), line("b", [side, 0], [side, side]), line("c", [side, side], [0, side]), line("d", [0, side], [0, 0])]);
        for (const distance of [0.01, -0.01]) {
          const result = offsetEntities(ctx(tiny), ids("a", "b", "c", "d"), distance);
          assert(result.ok, `a ${side} mm square offsets by ${distance} mm: ${result.ok ? "" : result.diagnostics[0]?.message}`);
        }
      }
    }
  },
  {
    name: "Re-audit edit N7: edit messages name curves as 'Line 3' or 'the new arc', never as an id fragment, and the angle-chamfer limit is the real limit",
    run: () => {
      const uuid = "3f2a91bc-1111-4222-8333-444455556666";
      const corner = projectWith([line(`user-${uuid}`, [0, 0], [50, 0]), line("other", [50, 0], [51, 0.9])]);
      const fillet = filletCorners(ctx(corner), [`entity:user-${uuid}`, "entity:other"], 10);
      const text = fillet.ok ? "ok" : fillet.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      assert(!/3f2a91bc|pr-\d|et-\d|user-/u.test(text), `no id fragment in: ${text}`);
      const sliver = projectWith([line("a", [0, 0], [50, 0]), line("b", [50, 0], [50.3, 0.0001])]);
      const problem = filletCorners(ctx(sliver), ids("a", "b"), 0.01);
      if (!problem.ok) assert(!/\bpr-\d|\bet-\d/u.test(problem.diagnostics[0]!.message), `a new curve is not named by an id: ${problem.diagnostics[0]!.message}`);
      const fixedLine = projectWith([line(`user-${uuid}`, [0, 0], [10, 0]), line("b", [10, 0], [10, 10])], [con("f", "fixed", [`user-${uuid}`])]);
      const pinned = splitAt(ctx(fixedLine), `entity:user-${uuid}`, [5, 0]);
      assert(pinned.ok, "a fixed line can be split (both halves keep the Fixed relation)");
      // 89.6 degrees on a 90 degree corner: the message gives the largest angle that is allowed, not the corner's own limit.
      const right = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 100])]);
      const tooSteep = chamferCornersAngle(ctx(right), ids("a", "b"), 10, 89.6);
      assert(!tooSteep.ok, "89.6 degrees is refused on a 90 degree corner");
      if (!tooSteep.ok) {
        const message = tooSteep.diagnostics[0]!.message;
        assert(/at most 89\.5/u.test(message), `the message names the real maximum, 89.5 degrees: ${message}`);
      }
      assert(chamferCornersAngle(ctx(right), ids("a", "b"), 10, 80).ok, "80 degrees is accepted");
    }
  }
];
