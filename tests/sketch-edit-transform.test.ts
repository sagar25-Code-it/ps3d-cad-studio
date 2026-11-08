import { MIRROR_AXIS_X, MIRROR_AXIS_Y, mirrorEntities, patternEntities, selectionBounds, stretchEntities, transformEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { applyOk, arc, circle, commit, con, ctx, ellipse, entityById, ids, line, ofKind, problems, projectWith, radiusOfArc, rect, relationsOf, spline } from "./edit-test-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

function clean(project: WorkbenchProject): void {
  const found = problems(project);
  if (found.length > 0) throw new Error(`sketch problems after the edit: ${found.join("; ")}`);
}

type P = readonly [number, number];

export const sketchEditTransformTests: readonly TestCase[] = [
  {
    name: "Sketch edit E07 mirror carries internal relations, symmetry for every kind, and re-measures a mirrored angle",
    run: () => {
      const project = projectWith(
        [line("a", [10, 0], [30, 0]), line("b", [30, 0], [30, 20]), arc("r", [10, 10], [15, 15], [20, 10]), line("axis", [0, -10], [0, 40])],
        [
          con("j", "coincident", ["a", "b"], { points: ["end", "start"] }),
          con("h", "horizontal", ["a"]),
          con("len", "distance", ["a"], { valueMm: 20, dimension: "length" }),
          con("ang", "angle", ["a", "b"], { valueDeg: 90 })
        ]
      );
      const mirrored = applyOk(project, mirrorEntities(ctx(project), ids("a", "b", "r", "axis")));
      clean(mirrored);
      const copies = mirrored.sketch.entities.filter((entity) => !["a", "b", "r", "axis"].some((name) => entity.id === `entity:${name}`));
      equal(copies.length, 3, "one copy per mirrored entity");
      equal(relationsOf(mirrored, "symmetry").length, 3, "line, line and arc all get a symmetry relation about the axis");
      equal(relationsOf(mirrored, "horizontal").length, 2, "the horizontal relation is copied");
      equal(relationsOf(mirrored, "distance").length, 2, "and the length dimension");
      equal(relationsOf(mirrored, "coincident").length, 2, "and the joint between the lines");
      const copiedAngle = relationsOf(mirrored, "angle").find((relation) => relation.id !== "constraint:ang")!;
      near(copiedAngle.valueDeg!, 270, 1e-6, "a mirrored right angle measures 270 degrees from line to line (re-measured, not copied)");
    }
  },
  {
    name: "Sketch edit mirror about the sketch X or Y axis needs no helper line",
    run: () => {
      const project = projectWith([line("a", [10, 5], [30, 8]), circle("c", [20, 20], 3), rect("r", [40, 10], 10, 4, 30)]);
      const aboutX = applyOk(project, mirrorEntities(ctx(project), ids("a", "c", "r").concat(MIRROR_AXIS_X)));
      clean(aboutX);
      const flippedLine = aboutX.sketch.entities.find((entity) => entity.kind === "line" && entity.id !== "entity:a")!;
      assert(flippedLine.kind === "line" && flippedLine.start[1] === -5 && flippedLine.end[1] === -8 && flippedLine.start[0] === 10, "y is negated about the X axis");
      const flippedRect = ofKind(aboutX, "rectangle").find((entity) => entity.id !== "entity:r")!;
      near(flippedRect.rotationDeg, -30, 1e-9, "a rectangle's rotation mirrors");
      const aboutY = applyOk(project, mirrorEntities(ctx(project), ids("a").concat(MIRROR_AXIS_Y)));
      const other = aboutY.sketch.entities.find((entity) => entity.kind === "line" && entity.id !== "entity:a")!;
      assert(other.kind === "line" && other.start[0] === -10, "x is negated about the Y axis");
      equal(relationsOf(aboutY, "symmetry").length, 0, "no symmetry relation is recorded without an axis entity");
      assert(!mirrorEntities(ctx(project), [MIRROR_AXIS_X]).ok, "an axis alone is not a selection");
    }
  },
  {
    name: "Sketch edit E07/E12 patterns copy relations, keep copies the size of the source, and check the entity limit up front",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 5])], [con("j", "coincident", ["a", "b"], { points: ["end", "start"] }), con("h", "horizontal", ["a"]), con("len", "distance", ["a"], { valueMm: 10, dimension: "length" })]);
      const grid = applyOk(project, patternEntities(ctx(project), ids("a", "b"), { kind: "rectangular", countX: 3, countY: 1, dxMm: 20, dyMm: 0 }));
      clean(grid);
      equal(grid.sketch.entities.length, 6, "two copies of both lines");
      equal(relationsOf(grid, "coincident").length, 3, "each instance keeps its joint");
      equal(relationsOf(grid, "horizontal").length, 3, "and its horizontal relation");
      equal(relationsOf(grid, "distance").length, 3, "and its length dimension");
      assert(relationsOf(grid, "equal").length >= 4, "copies are tied to their source by equal relations");
      const crowd = projectWith(Array.from({ length: 40 }, (_, index) => circle(`c${index}`, [index * 3, 0], 1)));
      const tooMany = patternEntities(ctx(crowd), crowd.sketch.entities.map((entity) => entity.id), { kind: "rectangular", countX: 100, countY: 1, dxMm: 400, dyMm: 0 });
      assert(!tooMany.ok, "40 circles x 100 would be 3960 copies");
      if (!tooMany.ok) assert(/limit is 500/u.test(tooMany.diagnostics[0]!.message) && /3960/u.test(tooMany.diagnostics[0]!.message), "and the message counts them and names the limit");
      const many = projectWith(Array.from({ length: 30 }, (_, index) => circle(`c${index}`, [index * 3, 0], 1)));
      const withinSketchLimit = patternEntities(ctx(many), many.sketch.entities.map((entity) => entity.id), { kind: "rectangular", countX: 8, countY: 1, dxMm: 200, dyMm: 0 });
      assert(!withinSketchLimit.ok && /at most 200/u.test(withinSketchLimit.diagnostics[0]!.message), "a single edit that would add more than 200 entities says so");
    }
  },
  {
    name: "Sketch edit linear pattern at an angle, by total extent, and a circular pattern that would only stack duplicates",
    run: () => {
      const project = projectWith([circle("c", [0, 0], 2)]);
      const angled = applyOk(project, patternEntities(ctx(project), ids("c"), { kind: "rectangular", countX: 3, countY: 1, dxMm: 10, dyMm: 0, angleDeg: 90 }));
      const centers = ofKind(angled, "circle").map((entity) => entity.center);
      assert(centers.some((center) => Math.abs(center[0]) < 1e-9 && Math.abs(center[1] - 20) < 1e-9), "the pattern runs along +Y when the direction is 90 degrees");
      const extent = applyOk(project, patternEntities(ctx(project), ids("c"), { kind: "rectangular", countX: 5, countY: 1, dxMm: 100, dyMm: 0, extent: true }));
      const xs = ofKind(extent, "circle").map((entity) => entity.center[0]).sort((a, b) => a - b);
      equal(xs.join(","), "0,25,50,75,100", "total extent 100 over 5 instances is 25 mm spacing");
      const stacked = patternEntities(ctx(project), ids("c"), { kind: "circular", count: 6, angleDeg: 360, center: [0, 0] });
      assert(!stacked.ok && /stack/u.test(stacked.diagnostics[0]!.message), "a circle on the pattern centre is refused instead of stacking six copies");
      const ring = projectWith([circle("c", [10, 0], 1)]);
      const six = applyOk(ring, patternEntities(ctx(ring), ids("c"), { kind: "circular", count: 6, angleDeg: 360, center: [0, 0] }));
      equal(ofKind(six, "circle").length, 6, "a circle off the centre repeats six times");
    }
  },
  {
    name: "Sketch edit E09 a non-finite centre, angle, factor or distance is rejected with a message, never planned",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), circle("c", [5, 5], 2)]);
      const bad: readonly (readonly [string, () => ReturnType<typeof transformEntities>])[] = [
        ["rotate centre NaN", () => transformEntities(ctx(project), ids("a"), { kind: "rotate", angleDeg: 45, center: [Number.NaN, 0] }, false)],
        ["rotate copy centre NaN", () => transformEntities(ctx(project), ids("a"), { kind: "rotate", angleDeg: 45, center: [0, Number.NaN] }, true)],
        ["scale centre Infinity", () => transformEntities(ctx(project), ids("a"), { kind: "scale", factor: 2, center: [Number.POSITIVE_INFINITY, 0] }, false)],
        ["scale factor NaN", () => transformEntities(ctx(project), ids("a"), { kind: "scale", factor: Number.NaN, center: [0, 0] }, false)],
        ["move NaN", () => transformEntities(ctx(project), ids("a"), { kind: "move", dxMm: Number.NaN, dyMm: 1 }, false)],
        ["circular pattern centre NaN", () => patternEntities(ctx(project), ids("a"), { kind: "circular", count: 4, angleDeg: 360, center: [Number.NaN, 0] })],
        ["pattern spacing NaN", () => patternEntities(ctx(project), ids("a"), { kind: "rectangular", countX: 2, countY: 1, dxMm: Number.NaN, dyMm: 0 })],
        ["stretch NaN", () => stretchEntities(ctx(project), ids("a"), { x1: 0, y1: 0, x2: Number.NaN, y2: 1 }, 1, 0)]
      ];
      for (const [name, run] of bad) {
        const result = run();
        assert(!result.ok, `${name} is rejected at planning time`);
      }
    }
  },
  {
    name: "Sketch edit E08 scaling a rectangle or dimensioned lines rewrites the dimension values instead of leaving them stale or refusing",
    run: () => {
      const box = projectWith([rect("r", [0, 0], 100, 40)], [con("w", "distance", ["r"], { valueMm: 100, dimension: "width" }), con("h", "distance", ["r"], { valueMm: 40, dimension: "height" })]);
      const doubled = applyOk(box, transformEntities(ctx(box), ids("r"), { kind: "scale", factor: 2, center: [0, 0] }, false));
      clean(doubled);
      const width = relationsOf(doubled, "distance").find((relation) => relation.dimension === "width")!;
      equal(width.valueMm, 200, "the width dimension follows to 200");
      equal(relationsOf(doubled, "distance").find((relation) => relation.dimension === "height")!.valueMm, 80, "and the height to 80");

      const pair = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50])], [con("len", "distance", ["a"], { valueMm: 100, dimension: "length" }), con("joint", "coincident", ["a", "b"], { points: ["end", "start"] }), con("ang", "angle", ["a", "b"], { valueDeg: 90 })]);
      const scaled = applyOk(pair, transformEntities(ctx(pair), ids("a", "b"), { kind: "scale", factor: 2, center: [0, 0] }, false));
      clean(scaled);
      equal(relationsOf(scaled, "distance")[0]!.valueMm, 200, "a line length dimension is doubled");
      equal(relationsOf(scaled, "coincident").length, 1, "the joint survives");
      equal(relationsOf(scaled, "angle")[0]!.valueDeg, 90, "and the angle stays");

      const horizontal = projectWith([line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50])], [con("h", "horizontal", ["a"]), con("v", "vertical", ["b"])]);
      const turned = applyOk(horizontal, transformEntities(ctx(horizontal), ids("a", "b"), { kind: "rotate", angleDeg: 30, center: [0, 0] }, false));
      clean(turned);
      equal(relationsOf(turned, "horizontal").length + relationsOf(turned, "vertical").length, 0, "rotating drops the horizontal and vertical relations it breaks, with no conflict");
      const copyTurned = applyOk(horizontal, transformEntities(ctx(horizontal), ids("a", "b"), { kind: "rotate", angleDeg: 30, center: [0, 0] }, true));
      clean(copyTurned);
      equal(relationsOf(copyTurned, "horizontal").length, 1, "the original keeps its relations when a rotated copy is made");
    }
  },
  {
    name: "Sketch edit E08 stretching a rectangle updates its width dimension",
    run: () => {
      const box = projectWith([rect("r", [0, 0], 20, 10)], [con("w", "distance", ["r"], { valueMm: 20, dimension: "width" })]);
      const stretched = applyOk(box, stretchEntities(ctx(box), ids("r"), { x1: 5, y1: -10, x2: 15, y2: 10 }, 7, 0));
      clean(stretched);
      const rectangle = ofKind(stretched, "rectangle")[0]!;
      near(rectangle.widthMm, 27, 1e-9, "the right side moved 7 mm, so the rectangle is 27 wide");
      equal(relationsOf(stretched, "distance")[0]!.valueMm, 27, "and the width dimension reads 27 instead of the stale 20");
    }
  },
  {
    name: "Sketch edit E02 move, rotate, scale and stretch refuse a Fixed curve, a copy of it is allowed",
    run: () => {
      const project = projectWith([circle("c", [0, 0], 5)], [con("pin", "fixed", ["c"])]);
      const moved = transformEntities(ctx(project), ids("c"), { kind: "move", dxMm: 20, dyMm: 0 }, false);
      assert(!moved.ok && /fixed/u.test(moved.diagnostics[0]!.message), "move is refused");
      assert(!transformEntities(ctx(project), ids("c"), { kind: "scale", factor: 3, center: [0, 0] }, false).ok, "scale is refused");
      assert(!transformEntities(ctx(project), ids("c"), { kind: "rotate", angleDeg: 20, center: [10, 0] }, false).ok, "rotate is refused");
      assert(!stretchEntities(ctx(project), ids("c"), { x1: -1, y1: -1, x2: 1, y2: 1 }, 5, 0).ok, "stretch is refused");
      const copied = applyOk(project, transformEntities(ctx(project), ids("c"), { kind: "move", dxMm: 20, dyMm: 0 }, true));
      equal(relationsOf(copied, "fixed").length, 1, "a copy is free: only the original stays fixed");
    }
  },
  {
    name: "Sketch edit move and rotate can make several copies in one command; scale can be non-uniform",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0])]);
      const moved = applyOk(project, transformEntities(ctx(project), ids("a"), { kind: "move", dxMm: 0, dyMm: 15, copies: 3 }, true));
      equal(ofKind(moved, "line").length, 4, "three copies plus the original");
      equal(ofKind(moved, "line").map((entity) => entity.start[1]).sort((a, b) => a - b).join(","), "0,15,30,45", "each copy steps by the distance");
      const around = applyOk(project, transformEntities(ctx(project), ids("a"), { kind: "rotate", angleDeg: 90, center: [0, 0], copies: 3 }, true));
      equal(ofKind(around, "line").length, 4, "three rotated copies");
      const shape = projectWith([line("a", [0, 0], [10, 0]), circle("c", [20, 0], 4), rect("r", [0, 20], 10, 6)]);
      const stretched = applyOk(shape, transformEntities(ctx(shape), ids("a", "c", "r"), { kind: "scale", factor: 2, factorY: 1, center: [0, 0] }, false));
      clean(stretched);
      assert(stretched.sketch.entities.some((entity) => entity.kind === "ellipse"), "a circle scaled unevenly becomes an ellipse");
      const ellipseOf = ofKind(stretched, "ellipse")[0]!;
      near(ellipseOf.majorRadiusMm, 8, 1e-9, "with major radius 8");
      near(ellipseOf.minorRadiusMm, 4, 1e-9, "and minor radius 4");
      const widened = ofKind(stretched, "rectangle")[0]!;
      near(widened.widthMm, 20, 1e-9, "a rectangle doubles in width only");
      near(widened.heightMm, 6, 1e-9, "and keeps its height");
      const arcs = projectWith([arc("a", [10, 0], [0, 10], [-10, 0])]);
      assert(!transformEntities(ctx(arcs), ids("a"), { kind: "scale", factor: 2, factorY: 1, center: [0, 0] }, false).ok, "an arc cannot be scaled unevenly and says why");
    }
  },
  {
    name: "Sketch edit E16 selection bounds hold the true extent of arcs and ellipses",
    run: () => {
      const quarter = projectWith([arc("a", [10, 0], [-7.0710678, 7.0710678], [0, -10])]);
      const bounds = selectionBounds(quarter.sketch, ids("a"))!;
      near(bounds.x1, -10, 0.05, "the arc reaches x = -10");
      near(bounds.x2, 10, 0.05, "and x = 10");
      near(bounds.y1, -10, 0.05, "and y = -10");
      near(bounds.y2, 10, 0.05, "and y = +10");
      const flat = projectWith([ellipse("e", [0, 0], 30, 10)]);
      const ellipseBounds = selectionBounds(flat.sketch, ids("e"))!;
      near(ellipseBounds.y2, 10, 1e-9, "an ellipse 30 x 10 is 10 high, not 30");
      near(ellipseBounds.x2, 30, 1e-9, "and 30 wide");
      const tilted = projectWith([ellipse("e", [0, 0], 30, 10, 90)]);
      near(selectionBounds(tilted.sketch, ids("e"))!.y2, 30, 1e-9, "turned 90 degrees it is 30 high");
    }
  },
  {
    name: "Sketch edit E11 transform and stretch extremes name the limit they break",
    run: () => {
      const tiny = projectWith([line("a", [0, 0], [0.5, 0])]);
      const shrunk = transformEntities(ctx(tiny), ids("a"), { kind: "scale", factor: 0.01, center: [0, 0] }, false);
      assert(!shrunk.ok && /minimum is 0\.01/u.test(shrunk.diagnostics[0]!.message), "scale 0.01 of a 0.5 mm line names the 0.01 mm minimum");
      const far = projectWith([line("a", [0, 0], [10, 0])]);
      const farMove = transformEntities(ctx(far), ids("a"), { kind: "move", dxMm: 99_999, dyMm: 0 }, false);
      assert(!farMove.ok && /10000/u.test(farMove.diagnostics[0]!.message), "a move to 99999 names the 10000 mm sketch limit");
      const arcCollapse = projectWith([arc("a", [10, 0], [0, 10], [-10, 0])]);
      const squashed = stretchEntities(ctx(arcCollapse), ids("a"), { x1: -1, y1: 9, x2: 1, y2: 11 }, 0, -10);
      assert(!squashed.ok && /degenerate/u.test(squashed.diagnostics[0]!.message), "stretching an arc's middle onto its chord says it would be degenerate");
      const noAxis = projectWith([line("a", [1, 1], [5, 5]), line("axis", [3, 3], [3, 3.0001])]);
      assert(!mirrorEntities(ctx(noAxis), ids("a", "axis")).ok, "a zero-length mirror line is refused");
      const committed = commit(far, transformEntities(ctx(far), ids("a"), { kind: "move", dxMm: 5, dyMm: 0 }, false));
      assert(committed.ok, "an ordinary move still commits");
      void entityById;
      void radiusOfArc;
      void spline;
    }
  }
];
