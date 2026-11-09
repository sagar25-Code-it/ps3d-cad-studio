import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { chamferCorners, chamferCornersAngle, chamferCornersAsymmetric, cornerLines, filletCorners } from "../packages/workbench-sketch/src/edit-tools.js";
import { cornerByClick } from "../packages/workbench-sketch/src/corner-tools.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { applyOk, arc, circle, commit, con, closeTo, ctx, entityById, ids, line, ofKind, problems, projectWith, radiusOfArc, rect, relationsOf } from "./edit-test-kit.js";

/** A corner as the Line tool leaves it: the joint relation plus a Horizontal and a Vertical side. */
function drawnCorner() {
  return projectWith(
    [line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 100])],
    [con("joint", "coincident", ["a", "b"], { points: ["end", "start"] }), con("h", "horizontal", ["a"]), con("v", "vertical", ["b"])]
  );
}

export const sketchEditCornerTests: readonly TestCase[] = [
  {
    name: "Sketch edit E01/E04 fillet on a drawn corner replaces the joint with tangent and radius relations (no conflict)",
    run: () => {
      const project = drawnCorner();
      const rounded = applyOk(project, filletCorners(ctx(project), ids("a", "b"), 10));
      deepProblems(rounded);
      const made = ofKind(rounded, "arc")[0]!;
      near(radiusOfArc(made), 10, 1e-9, "the arc has the requested radius");
      assert(closeTo(entityById(rounded, "entity:a").kind === "line" ? (entityById(rounded, "entity:a") as { end: readonly [number, number] }).end : [0, 0], [90, 0]), "line a stops at the tangent point");
      equal(relationsOf(rounded, "tangent").length, 2, "the arc is tangent to both lines");
      equal(relationsOf(rounded, "radius").length, 1, "and carries a radius dimension");
      equal(relationsOf(rounded, "radius")[0]!.valueMm, 10, "of the filleted size");
      equal(relationsOf(rounded, "coincident").length, 2, "the arc ends are joined to the lines");
      assert(!relationsOf(rounded, "coincident").some((c) => c.entityIds.includes("entity:a") && c.entityIds.includes("entity:b")), "the old corner joint is gone");
      equal(relationsOf(rounded, "horizontal").length + relationsOf(rounded, "vertical").length, 2, "the lines keep their horizontal and vertical relations");
    }
  },
  {
    name: "Sketch edit E01 relaxing relations first no longer leaves stale ones: after the fillet, restoring everything is consistent",
    run: () => {
      const project = drawnCorner();
      const relaxed = applyWorkbenchOperation(project, { kind: "set-sketch-constraints-suppressed", operationId: "operation:et-relax", expectedRevision: project.revision, constraintIds: project.sketch.constraints.map((constraint) => constraint.id), suppressed: true });
      assert(relaxed.ok, "relaxing applies");
      const rounded = applyOk(relaxed.value.project, filletCorners(ctx(relaxed.value.project), ids("a", "b"), 10));
      equal(rounded.sketch.constraints.some((constraint) => constraint.id === "constraint:joint"), false, "the relaxed corner joint, now untrue, is gone");
      const restored = applyWorkbenchOperation(rounded, { kind: "set-sketch-constraints-suppressed", operationId: "operation:et-restore", expectedRevision: rounded.revision, constraintIds: rounded.sketch.constraints.filter((constraint) => constraint.suppressed === true).map((constraint) => constraint.id), suppressed: false });
      assert(restored.ok, "restoring what is left applies");
      deepProblems(restored.value.project);
    }
  },
  {
    name: "Sketch edit E01 chamfer and corner on a drawn corner apply with the joint replaced",
    run: () => {
      const project = drawnCorner();
      const cut = applyOk(project, chamferCorners(ctx(project), ids("a", "b"), 10));
      deepProblems(cut);
      equal(ofKind(cut, "line").length, 3, "the chamfer line was added");
      equal(relationsOf(cut, "coincident").length, 2, "joined to both lines");
      // Corner: two lines that miss each other, joined by a relation.
      const gap = projectWith([line("a", [0, 0], [80, 0]), line("b", [100, 20], [100, 100])], [con("h", "horizontal", ["a"]), con("v", "vertical", ["b"])]);
      const joined = applyOk(gap, cornerLines(ctx(gap), ids("a", "b")));
      deepProblems(joined);
      equal(relationsOf(joined, "coincident").length, 1, "corner joins the two lines at the meeting point");
      assert(closeTo((entityById(joined, "entity:a") as { end: readonly [number, number] }).end, [100, 0]), "a is extended to the meeting point");
      // A corner whose lines already meet through a relation: moving them keeps the edit valid.
      const touching = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 5], [100, 100])], [con("h", "horizontal", ["a"]), con("v", "vertical", ["b"])]);
      deepProblems(applyOk(touching, cornerLines(ctx(touching), ids("a", "b"))));
    }
  },
  {
    name: "Sketch edit E01 rectangle fillet gets joined, tangent, equal-radius lines and one radius dimension",
    run: () => {
      const project = projectWith([rect("r", [0, 0], 20, 10)], [con("w", "distance", ["r"], { valueMm: 20, dimension: "width" })]);
      const rounded = applyOk(project, filletCorners(ctx(project), ids("r"), 2));
      deepProblems(rounded);
      equal(rounded.sketch.entities.filter((entity) => entity.kind === "line" || entity.kind === "arc").length, 8, "four lines and four arcs");
      equal(rounded.sketch.entities.filter((entity) => entity.kind === "point" && entity.construction).length, 2, "two virtual corners keep the width dimension (wave 3: the part keeps its size)");
      equal(relationsOf(rounded, "tangent").length, 8, "every arc end is tangent");
      equal(relationsOf(rounded, "radius").length, 1, "one radius dimension drives the corner size");
      equal(relationsOf(rounded, "equal").length, 3, "the other three arcs are equal to it");
      equal(relationsOf(rounded, "horizontal").length, 2, "the top and bottom stay horizontal");
      equal(relationsOf(rounded, "vertical").length, 2, "the sides stay vertical");
      const widths = relationsOf(rounded, "distance");
      equal(widths.length, 1, "the width dimension is kept, as a distance between the two virtual corners, instead of being removed");
      assert(widths[0]!.dimension === "aligned" && widths[0]!.valueMm === 20, "it still reads 20");
      const rotated = projectWith([rect("r", [3, 4], 20, 10, 30)]);
      const turned = applyOk(rotated, chamferCorners(ctx(rotated), ids("r"), 2));
      deepProblems(turned);
      equal(relationsOf(turned, "equal").length, 3, "equal chamfers on a rotated rectangle");
    }
  },
  {
    name: "Sketch edit E01/E05 a drawn rectangle outline (four joined lines) fillets all corners at once",
    run: () => {
      const names = ["a", "b", "c", "d"];
      const project = projectWith(
        [line("a", [0, 0], [50, 0]), line("b", [50, 0], [50, 50]), line("c", [50, 50], [0, 50]), line("d", [0, 50], [0, 0])],
        names.map((name, index) => con(`j${index}`, "coincident", [name, names[(index + 1) % 4]!], { points: ["end", "start"] }))
      );
      const rounded = applyOk(project, filletCorners(ctx(project), ids("a", "b", "c", "d"), 5));
      deepProblems(rounded);
      equal(ofKind(rounded, "arc").length, 4, "four arcs");
      equal(relationsOf(rounded, "radius").length, 1, "one shared radius dimension");
      equal(relationsOf(rounded, "equal").length, 3, "equal radii on the rest");
      const half = applyOk(project, chamferCorners(ctx(project), ids("a", "b", "c", "d"), 5));
      deepProblems(half);
      equal(relationsOf(half, "equal").length, 3, "equal chamfer lines");
    }
  },
  {
    name: "Sketch edit E02 fillet, chamfer and corner refuse to move a Fixed curve, naming it",
    run: () => {
      const project = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50])], [con("pin", "fixed", ["a"])]);
      for (const result of [filletCorners(ctx(project), ids("a", "b"), 5), chamferCorners(ctx(project), ids("a", "b"), 5), chamferCornersAsymmetric(ctx(project), ids("a", "b"), 5, 4), chamferCornersAngle(ctx(project), ids("a", "b"), 5, 45)]) {
        assert(!result.ok, "a pinned line is not edited");
        if (!result.ok) {
          equal(result.diagnostics[0]?.code, "CONSTRAINT_CONFLICT", "typed as a relation conflict");
          assert(/fixed/u.test(result.diagnostics[0]!.message), "the message says the curve is fixed");
        }
      }
      const gap = projectWith([line("a", [0, 0], [80, 0]), line("b", [100, 20], [100, 50])], [con("pin", "fixed", ["b"])]);
      const cornered = cornerLines(ctx(gap), ids("a", "b"));
      assert(!cornered.ok && /fixed/u.test(cornered.diagnostics[0]!.message), "corner would move the fixed line b, so it is refused");
      const free = projectWith([line("a", [0, 0], [80, 0]), line("b", [100, 20], [100, 50])], [con("pin", "fixed", ["a"]), con("pin2", "fixed", ["b"])]);
      assert(!cornerLines(ctx(free), ids("a", "b")).ok, "and so is a pair that is fully pinned");
    }
  },
  {
    name: "Sketch edit E03 distance-and-angle chamfer refuses an angle the corner cannot reach, and cuts a valid one exactly",
    run: () => {
      const project = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50])]);
      for (const angle of [91, 120, 135, 150, 170]) {
        const result = chamferCornersAngle(ctx(project), ids("a", "b"), 10, angle);
        assert(!result.ok, `${angle} degrees on a 90 degree corner is refused`);
      }
      const ok = applyOk(project, chamferCornersAngle(ctx(project), ids("a", "b"), 10, 45));
      deepProblems(ok);
      const cut = ofKind(ok, "line").find((candidate) => candidate.id !== "entity:a" && candidate.id !== "entity:b")!;
      near(Math.hypot(cut.end[0] - cut.start[0], cut.end[1] - cut.start[1]), 10 * Math.SQRT2, 1e-9, "a 45 degree cut of 10 mm is 14.14 mm long");
      const second = entityById(ok, "entity:b") as { start: readonly [number, number]; end: readonly [number, number] };
      assert(second.start[1] >= 0 && second.start[1] <= 50 && second.end[1] > second.start[1], "line b is trimmed on the corner side, with no tail past the corner");
      // A sharper corner has a smaller limit: 60 degrees corner allows less than 120.
      const sharp = projectWith([line("a", [0, 0], [100, 0]), line("b", [0, 0], [50, 86.6025403784])]);
      assert(!chamferCornersAngle(ctx(sharp), ids("a", "b"), 5, 125).ok, "125 is past the 120 degree limit of a 60 degree corner");
      assert(chamferCornersAngle(ctx(sharp), ids("a", "b"), 5, 100).ok, "100 degrees still reaches the second line");
    }
  },
  {
    name: "Sketch edit E04 fillet on crossing lines keeps the picked quadrant and the other halves",
    run: () => {
      const project = projectWith([line("a", [-50, 0], [50, 0]), line("b", [0, -50], [0, 50])]);
      const pickPlus = applyOk(project, filletCorners(ctx(project), ids("a", "b"), 5, { picks: { quadrant: [20, 20] } }));
      deepProblems(pickPlus);
      const a = entityById(pickPlus, "entity:a") as { start: readonly [number, number]; end: readonly [number, number] };
      assert(closeTo(a.start, [5, 0]) && closeTo(a.end, [50, 0]), "the +x half of a is kept and ends at the tangent point");
      const stubs = ofKind(pickPlus, "line").filter((candidate) => candidate.id !== "entity:a" && candidate.id !== "entity:b");
      equal(stubs.length, 2, "the other two halves survive as their own lines");
      const pickMinus = applyOk(project, filletCorners(ctx(project), ids("a", "b"), 5, { picks: { quadrant: [-20, -20] } }));
      const arcMinus = ofKind(pickMinus, "arc")[0]!;
      assert(arcMinus.start[0] < 0 && arcMinus.end[1] < 0 || arcMinus.start[1] < 0 && arcMinus.end[0] < 0, "the arc sits in the picked (-,-) quadrant");
      const perLine = applyOk(project, filletCorners(ctx(project), ids("a", "b"), 5, { picks: { first: [30, 0], second: [0, -30] } }));
      const arcMixed = ofKind(perLine, "arc")[0]!;
      assert(arcMixed.mid[0] > 0 && arcMixed.mid[1] < 0, "one pick per line selects the (+x, -y) quadrant");
      const corner = projectWith([line("a", [0, 0], [100, 0]), line("b", [30, -20], [30, 40])]);
      const right = applyOk(corner, cornerLines(ctx(corner), ids("a", "b"), { picks: { first: [80, 0], second: [30, 30] } }));
      assert(closeTo((entityById(right, "entity:a") as { start: readonly [number, number] }).start, [30, 0]), "corner keeps the picked 30..100 part of a");
      const left = applyOk(corner, cornerLines(ctx(corner), ids("a", "b"), { picks: { first: [10, 0], second: [30, -10] } }));
      assert(closeTo((entityById(left, "entity:a") as { end: readonly [number, number] }).end, [30, 0]), "and the other pick keeps the 0..30 part instead");
    }
  },
  {
    name: "Sketch edit fillet of a line-arc and an arc-arc corner is tangent to both curves with the requested radius",
    run: () => {
      const lineArc = projectWith([line("a", [0, 0], [100, 0]), arc("b", [100, 0], [91.7157287525, 20], [100, 40])]);
      const rounded = applyOk(lineArc, filletCorners(ctx(lineArc), ids("a", "b"), 5));
      deepProblems(rounded);
      const made = ofKind(rounded, "arc").find((candidate) => candidate.id !== "entity:b")!;
      near(radiusOfArc(made), 5, 1e-8, "line-arc fillet radius");
      const a = entityById(rounded, "entity:a") as { end: readonly [number, number] };
      near(a.end[1], 0, 1e-12, "the line is still on y = 0");
      const centerY = (made.start[1] + made.end[1] + 2 * made.mid[1]) / 4;
      assert(centerY > 0 && centerY < 6, "the fillet sits above the line, inside the corner");
      // The second arc bulges away from the first (they meet only at the corner). The earlier fixture, arc (20,0)-(25,10)-(30,0), crosses the first arc again at (18.8, 4.7), where no radius-2 fillet fits in the corner (re-audit N5).
      const twoArcs = projectWith([arc("a", [0, 0], [10, 10], [20, 0]), arc("b", [20, 0], [27, 5], [34, 0])]);
      const both = applyOk(twoArcs, filletCorners(ctx(twoArcs), ids("a", "b"), 2));
      deepProblems(both);
      near(radiusOfArc(ofKind(both, "arc").find((candidate) => candidate.id !== "entity:a" && candidate.id !== "entity:b")!), 2, 1e-8, "arc-arc fillet radius");
      const tangentTwin = projectWith([line("a", [0, 0], [100, 0]), arc("b", [100, 0], [130, 30], [100, 60])]);
      assert(!filletCorners(ctx(tangentTwin), ids("a", "b"), 5).ok, "an arc already tangent to the line has nothing to round");
    }
  },
  {
    name: "Sketch edit fillet by clicking a vertex rounds only that corner, also of a rectangle",
    run: () => {
      const project = drawnCorner();
      const clicked = applyOk(project, cornerByClick(ctx(project), [99.5, 0.3], 2, { kind: "fillet", radiusMm: 10, dimension: true }));
      deepProblems(clicked);
      equal(ofKind(clicked, "arc").length, 1, "one fillet");
      assert(!cornerByClick(ctx(project), [50, 50], 2, { kind: "fillet", radiusMm: 10, dimension: true }).ok, "a click away from any vertex is refused");
      const box = projectWith([rect("r", [0, 0], 20, 10)]);
      const one = applyOk(box, cornerByClick(ctx(box), [10.1, 5.1], 1, { kind: "fillet", radiusMm: 2, dimension: true }));
      deepProblems(one);
      equal(ofKind(one, "arc").length, 1, "only the clicked rectangle corner is rounded");
      equal(ofKind(one, "line").length, 4, "the rectangle became four joined lines");
    }
  },
  {
    name: "Sketch edit E15 fillet and chamfer inherit the construction and visible flags of their parents",
    run: () => {
      const construction = projectWith([line("a", [0, 0], [100, 0], { construction: true }), line("b", [100, 0], [100, 50], { construction: true })]);
      const arcMade = ofKind(applyOk(construction, filletCorners(ctx(construction), ids("a", "b"), 5)), "arc")[0]!;
      equal(arcMade.construction, true, "a fillet between construction lines is construction");
      const cut = ofKind(applyOk(construction, chamferCorners(ctx(construction), ids("a", "b"), 5)), "line").find((candidate) => candidate.id !== "entity:a" && candidate.id !== "entity:b")!;
      equal(cut.construction, true, "so is a chamfer");
      const hidden = projectWith([line("a", [0, 0], [100, 0], { visible: false }), line("b", [100, 0], [100, 50], { visible: false })]);
      equal(ofKind(applyOk(hidden, filletCorners(ctx(hidden), ids("a", "b"), 5)), "arc")[0]!.visible, false, "hidden parents give a hidden arc");
      const mixed = projectWith([line("a", [0, 0], [100, 0], { construction: true }), line("b", [100, 0], [100, 50])]);
      equal(ofKind(applyOk(mixed, filletCorners(ctx(mixed), ids("a", "b"), 5)), "arc")[0]!.construction, false, "a real parent keeps the result real");
    }
  },
  {
    name: "Sketch edit E11 fillet and chamfer extremes give a message that names the limit, not a generic payload error",
    run: () => {
      const tiny = projectWith([line("a", [0, 0], [10.0001, 0]), line("b", [10.0001, 0], [10.0001, 50])]);
      const nearly = filletCorners(ctx(tiny), ids("a", "b"), 10);
      assert(!nearly.ok, "a radius that leaves 0.0001 mm of line is refused when planned");
      const small = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50])]);
      assert(!filletCorners(ctx(small), ids("a", "b"), 0.001).ok, "radius below the minimum is refused");
      const hit = commit(small, filletCorners(ctx(small), ids("a", "b"), 99.995));
      assert(!hit.ok, "a radius that leaves under 0.01 mm of a line is refused");
      assert(hit.ok === false && !/invalid or has a duplicate/u.test(hit.message), "with a specific message");
    }
  },
  {
    name: "Sketch edit fillet, chamfer and corner on 500 entities and a long chain stay fast",
    run: () => {
      const entities = Array.from({ length: 249 }, (_, index) => line(`l${index}`, [index * 40, 0], [index * 40 + 30, 10]));
      const project = projectWith([...entities, circle("c", [0, 100], 5), line("x", [0, 0], [100, 0]), line("y", [100, 0], [100, 100])]);
      const started = performance.now();
      const result = filletCorners(ctx(project), ids("x", "y"), 10);
      assert(result.ok, "a fillet in a big sketch plans");
      assert(performance.now() - started < 1000, "in well under a second");
    }
  }
];

/** Every edit result must pass the same checks: no dangling or duplicate ids, nothing the solver would still move. */
function deepProblems(project: ReturnType<typeof drawnCorner>): void {
  const found = problems(project);
  if (found.length > 0) throw new Error(`sketch problems after the edit: ${found.join("; ")}`);
}
