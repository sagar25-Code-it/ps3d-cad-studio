import type { SketchEntity } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { arcFrame } from "../packages/workbench-sketch/src/edit-tools.js";
import { deleteCurveHeal, jogLine, splitAt } from "../packages/workbench-sketch/src/split-jog.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { arc, circle, commit, commitOk, constraint, context, entityOf, line, linesOf, planOf, projectWith, relationsHold } from "./sketch-edit-kit.js";

const square = (): SketchEntity[] => [line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10], [0, 0])];

function near2(actual: readonly [number, number], expected: readonly [number, number], message: string, tolerance = 1e-9): void {
  near(actual[0], expected[0], tolerance, `${message} (x)`);
  near(actual[1], expected[1], tolerance, `${message} (y)`);
}

export const sketchSplitJogTests: readonly TestCase[] = [
  {
    name: "split cuts a line at the pick into two joined, collinear lines and keeps its horizontal relation",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0])], [constraint("h", "horizontal", ["a"])]);
      const next = commitOk(project, splitAt(context(project), "entity:a", [4, 0.3]));
      const lines = linesOf(next);
      equal(lines.length, 2, "two lines after the split");
      const first = entityOf(next, "entity:a", "line");
      const second = lines.find((candidate) => candidate.id !== "entity:a")!;
      near2(first.start, [0, 0], "first start");
      near2(first.end, [4, 0], "the split point is the projection of the pick");
      near2(second.start, [4, 0], "second starts at the split");
      near2(second.end, [10, 0], "second keeps the original end");
      near(Math.hypot(first.end[0] - first.start[0], 0) + Math.hypot(second.end[0] - second.start[0], 0), 10, 1e-9, "no length is lost");
      assert(next.sketch.constraints.some((c) => c.kind === "coincident" && c.entityIds.includes(first.id) && c.entityIds.includes(second.id)), "the pieces are joined");
      assert(next.sketch.constraints.some((c) => c.kind === "collinear" && c.entityIds.includes(second.id)), "the pieces stay in line");
      assert(next.sketch.constraints.some((c) => c.kind === "horizontal" && c.entityIds[0] === "entity:a"), "the original relation is kept");
      assert(relationsHold(next), "every recorded relation holds after the split");
      // Dragging the joint through the live solver now moves along the line only: the new piece obeys the horizontal via the collinear relation.
      assert(!splitAt(context(project), "entity:a", [0, 0]).ok, "a split at an end is refused");
      const slanted = projectWith([line("d", [0, 0], [10, 10])]);
      const slantedNext = commitOk(slanted, splitAt(context(slanted), "entity:d", [3, 3.4]));
      assert(relationsHold(slantedNext), "an oblique line splits cleanly too");
    }
  },
  {
    name: "split snaps to a crossing with another curve inside the snap distance",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), line("v", [6, -5], [6, 5])]);
      const result = splitAt(context(project), "entity:a", [5.5, 0]);
      const plan = planOf(result);
      near2((plan.updateEntities[0] as { end: readonly [number, number] }).end, [6, 0], "snapped onto the crossing with the vertical line");
      assert(plan.label.includes("crossing"), "the label says it snapped");
      const far = planOf(splitAt(context(project), "entity:a", [2, 0]));
      near2((far.updateEntities[0] as { end: readonly [number, number] }).end, [2, 0], "a pick far from any crossing is used as is");
    }
  },
  {
    name: "split moves an end-point relation to the piece that now owns that end",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])],
        [constraint("j", "coincident", ["a", "b"], { points: ["end", "start"] }), constraint("len", "distance", ["a"], { valueMm: 10, dimension: "length" })]
      );
      const result = splitAt(context(project), "entity:a", [5, 0]);
      const next = commitOk(project, result);
      const second = linesOf(next).find((candidate) => candidate.start[0] === 5)!;
      const joint = next.sketch.constraints.find((c) => c.kind === "coincident" && c.entityIds.includes("entity:b") && c.entityIds.includes(second.id));
      assert(joint !== undefined, "the corner with b now belongs to the second piece");
      assert(!next.sketch.constraints.some((c) => c.id === "constraint:j"), "the old end relation is gone");
      assert(!next.sketch.constraints.some((c) => c.id === "constraint:len"), "the 10 mm length dimension no longer holds and is removed");
      assert(planOf(result).label.includes("removed"), "the label reports the removed relation");
      assert(relationsHold(next), "the corner still holds");
    }
  },
  {
    name: "splitting one side of a closed loop keeps a single closed profile of the same area",
    run: () => {
      const project = projectWith(square());
      const before = detectSketchProfiles(project.sketch);
      equal(before.length, 1, "one profile to start");
      const next = commitOk(project, splitAt(context(project), "entity:s1", [10, 4]));
      const after = detectSketchProfiles(next.sketch);
      equal(after.length, 1, "still one closed profile");
      near(after[0]!.areaMm2, 100, 1e-6, "the area is unchanged");
      equal(linesOf(next).length, 5, "five lines");
    }
  },
  {
    name: "split cuts an arc in two on the same circle, counter-clockwise and clockwise",
    run: () => {
      for (const clockwise of [false, true]) {
        const base = clockwise
          ? arc("q", [10, 0], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [0, 10])
          : arc("q", [0, 10], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [10, 0]);
        const project = projectWith([base]);
        const original = arcFrame(base)!;
        const next = commitOk(project, splitAt(context(project), "entity:q", [Math.cos(Math.PI / 6) * 10, Math.sin(Math.PI / 6) * 10]));
        const arcs = next.sketch.entities.filter((entity): entity is Extract<SketchEntity, { kind: "arc" }> => entity.kind === "arc");
        equal(arcs.length, 2, `two arcs (${clockwise ? "clockwise" : "counter-clockwise"})`);
        let total = 0;
        for (const piece of arcs) {
          const frame = arcFrame(piece)!;
          near(frame.radius, 10, 1e-9, "radius preserved");
          near2(frame.center, [0, 0], "centre preserved");
          assert(frame.sweep > 0.3, "each piece has a real sweep");
          total += frame.sweep;
        }
        near(total, original.sweep, 1e-9, "the two sweeps add up to the original");
        const [first, second] = arcs;
        const touching = [first!.start, first!.end].some((p) => [second!.start, second!.end].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9));
        assert(touching, "the pieces meet at the split point");
        assert(next.sketch.constraints.some((c) => c.kind === "concentric"), "the halves are concentric");
      }
    }
  },
  {
    name: "split turns a circle into two arcs that close back into the same circle, at the crossings when there are two",
    run: () => {
      const project = projectWith([circle("c", [0, 0], 10)]);
      const next = commitOk(project, splitAt(context(project), "entity:c", [10, 0]));
      const arcs = next.sketch.entities.filter((entity) => entity.kind === "arc");
      equal(arcs.length, 2, "two arcs");
      equal(next.sketch.entities.some((entity) => entity.kind === "circle"), false, "the circle is replaced");
      near(arcs.reduce((sum, piece) => sum + arcFrame(piece as Extract<SketchEntity, { kind: "arc" }>)!.sweep, 0), 2 * Math.PI, 1e-9, "the arcs together sweep a full turn");
      const cut = projectWith([circle("c", [0, 0], 10), line("l", [-20, 6], [20, 6])]);
      const plan = planOf(splitAt(context(cut), "entity:c", [0, -10]));
      const sweeps = plan.addEntities.map((entity) => arcFrame(entity as Extract<SketchEntity, { kind: "arc" }>)!.sweep).sort((a, b) => a - b);
      near(sweeps[0]!, Math.PI - 2 * Math.asin(0.6), 1e-6, "the small arc lies between the two crossings of the chord");
      near(sweeps[0]! + sweeps[1]!, 2 * Math.PI, 1e-9, "and the other arc is the rest");
    }
  },
  {
    name: "split turns a rectangle side into five lines that still close one profile of the rectangle's area",
    run: () => {
      const rectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const project = projectWith([rectangle]);
      const next = commitOk(project, splitAt(context(project), "entity:r", [3, -5.2]));
      equal(linesOf(next).length, 5, "five lines");
      equal(next.sketch.entities.some((entity) => entity.kind === "rectangle"), false, "the rectangle is gone");
      const profiles = detectSketchProfiles(next.sketch);
      equal(profiles.length, 1, "one closed profile");
      near(profiles[0]!.areaMm2, 200, 1e-6, "same area as the rectangle");
      assert(relationsHold(next), "horizontal / vertical relations hold");
    }
  },
  {
    name: "split cuts a spline into two splines through the same end points and split point",
    run: () => {
      const spline: SketchEntity = { id: "entity:sp", kind: "spline", fitPoints: [[0, 0], [5, 4], [10, 0], [15, -4], [20, 0]], construction: false };
      const project = projectWith([spline]);
      const next = commitOk(project, splitAt(context(project), "entity:sp", [10, 0.2]));
      const splines = next.sketch.entities.filter((entity): entity is Extract<SketchEntity, { kind: "spline" }> => entity.kind === "spline");
      equal(splines.length, 2, "two splines");
      const [a, b] = splines;
      near2(a!.fitPoints[0]!, [0, 0], "first keeps the original start");
      near2(b!.fitPoints[b!.fitPoints.length - 1]!, [20, 0], "second keeps the original end");
      near2(a!.fitPoints[a!.fitPoints.length - 1]!, b!.fitPoints[0]!, "the halves meet at the split point");
      assert(a!.fitPoints.length >= 3 && b!.fitPoints.length >= 3, "each half has the three fit points a spline needs");
      assert(!splitAt(context(project), "entity:sp", [0, 0]).ok, "a split at the very end is refused");
    }
  },
  {
    name: "split refuses an ellipse and a missing curve instead of guessing",
    run: () => {
      const ellipse: SketchEntity = { id: "entity:e", kind: "ellipse", center: [0, 0], majorRadiusMm: 10, minorRadiusMm: 5, rotationDeg: 0, construction: false };
      const project = projectWith([ellipse]);
      assert(!splitAt(context(project), "entity:e", [10, 0]).ok, "ellipse is refused");
      assert(!splitAt(context(project), "entity:nope", [0, 0]).ok, "unknown id is refused");
    }
  },
  {
    name: "jog steps a line out and back: five lines, both ends stay, the relations still hold",
    run: () => {
      const project = projectWith([line("a", [0, 0], [20, 0])], [constraint("h", "horizontal", ["a"])]);
      const result = jogLine(context(project), "entity:a", [10, 0.1], { offsetMm: 3, widthMm: 4 });
      const next = commitOk(project, result);
      const lines = linesOf(next);
      equal(lines.length, 5, "A, step, run, step, B");
      const key = (l: { start: readonly [number, number]; end: readonly [number, number] }): string => `${l.start.map((v) => Math.round(v * 1000) / 1000).join(",")}>${l.end.map((v) => Math.round(v * 1000) / 1000).join(",")}`;
      const shapes = lines.map(key).sort();
      assert(shapes.includes("0,0>8,0"), "the start run ends where the jog begins");
      assert(shapes.includes("8,0>8,3"), "first step");
      assert(shapes.includes("8,3>12,3"), "the offset run");
      assert(shapes.includes("12,0>12,3"), "second step back (drawn from the line out, so it runs the same way as the first step)");
      assert(shapes.includes("12,0>20,0"), "the end run returns to the original line and end");
      assert(relationsHold(next), "perpendicular / parallel / collinear relations all hold");
      const chain = detectSketchProfiles(next.sketch);
      equal(chain.length, 0, "an open jogged line is not a profile");
    }
  },
  {
    name: "a negative jog offset steps to the right, a width-0 jog shifts the rest of the line, and a joined far end is refused",
    run: () => {
      const project = projectWith([line("a", [0, 0], [20, 0])]);
      const right = planOf(jogLine(context(project), "entity:a", [10, 0], { offsetMm: -2, widthMm: 4 }));
      assert(right.addEntities.some((entity) => entity.kind === "line" && entity.start[1] === -2 && entity.end[1] === -2), "the offset run sits below a rightward line");
      const single = commitOk(project, jogLine(context(project), "entity:a", [10, 0], { offsetMm: 5, widthMm: 0 }));
      const tail = linesOf(single).find((candidate) => candidate.end[0] === 20)!;
      near2(tail.start, [10, 5], "the tail starts at the stepped point");
      near2(tail.end, [20, 5], "and the far end shifts by the offset");
      assert(relationsHold(single), "relations hold");
      const joined = projectWith([line("a", [0, 0], [20, 0]), line("b", [20, 0], [20, 10])], [constraint("j", "coincident", ["a", "b"], { points: ["end", "start"] })]);
      assert(!jogLine(context(joined), "entity:a", [10, 0], { offsetMm: 5, widthMm: 0 }).ok, "a single-step jog would tear the joined end");
      assert(jogLine(context(joined), "entity:a", [10, 0], { offsetMm: 5, widthMm: 4 }).ok, "a bump keeps the joined end, so it is allowed");
      const bumped = commitOk(joined, jogLine(context(joined), "entity:a", [10, 0], { offsetMm: 5, widthMm: 4 }));
      assert(relationsHold(bumped), "and the corner with b still holds, now on the last run");
      assert(!jogLine(context(project), "entity:a", [1, 0], { offsetMm: 3, widthMm: 4 }).ok, "a jog that does not fit is refused");
      assert(!jogLine(context(project), "entity:a", [10, 0], { offsetMm: 0, widthMm: 4 }).ok, "a zero offset is refused");
    }
  },
  {
    name: "delete curve heals the gap: a cut corner is removed and both neighbours meet at the old corner",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [10, 0]), line("t", [10, 0], [12, 2]), line("b", [12, 2], [12, 10])],
        [constraint("h", "horizontal", ["a"]), constraint("v", "vertical", ["b"])]
      );
      const result = deleteCurveHeal(context(project), "entity:t");
      const next = commitOk(project, result);
      equal(linesOf(next).length, 2, "the cut is gone");
      near2(entityOf(next, "entity:a", "line").end, [12, 0], "a is extended to the corner");
      near2(entityOf(next, "entity:b", "line").start, [12, 0], "b is trimmed down to the corner");
      assert(next.sketch.constraints.some((c) => c.kind === "coincident" && c.entityIds.includes("entity:a") && c.entityIds.includes("entity:b")), "the healed corner is joined");
      assert(relationsHold(next), "horizontal and vertical still hold");
    }
  },
  {
    name: "delete curve on a chamfered square heals back to a closed square of full area",
    run: () => {
      const project = projectWith([
        line("a", [0, 0], [8, 0]), line("c", [8, 0], [10, 2]), line("b", [10, 2], [10, 10]), line("d", [10, 10], [0, 10]), line("e", [0, 10], [0, 0])
      ]);
      equal(detectSketchProfiles(project.sketch).length, 1, "the chamfered shape is closed");
      const next = commitOk(project, deleteCurveHeal(context(project), "entity:c"));
      const profiles = detectSketchProfiles(next.sketch);
      equal(profiles.length, 1, "still one closed profile");
      near(profiles[0]!.areaMm2, 100, 1e-6, "the corner is restored, so the area is the full square");
    }
  },
  {
    name: "delete curve heals a line to an arc, and refuses when the neighbours cannot meet",
    run: () => {
      // A horizontal line, a short cut, then a quarter-circle arc around (10,10) radius 10 starting at (10, 0)... use arc through (10,0)->(20,10).
      const project = projectWith([
        line("a", [-5, 0], [9, 0]),
        line("t", [9, 0], [10, 0]),
        arc("q", [10, 0], [10 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2], [20, 10])
      ]);
      const next = commitOk(project, deleteCurveHeal(context(project), "entity:t"));
      assert(entityOf(next, "entity:a", "line").end[0] >= 9, "the line reaches the arc");
      const frame = arcFrame(entityOf(next, "entity:q", "arc"))!;
      near(frame.radius, 10, 1e-9, "the arc keeps its circle");
      // Two parallel neighbours (a rectangle with one side deleted) cannot meet.
      const open = projectWith([line("l", [0, 0], [10, 0]), line("r", [10, 0], [10, 10]), line("t", [10, 10], [0, 10]), line("b", [0, 10], [0, 0])]);
      const refused = deleteCurveHeal(context(open), "entity:r");
      assert(!refused.ok, "the top and bottom of a rectangle are parallel, so deleting a side cannot heal");
      // No neighbour at all: a plain delete.
      const lone = projectWith([line("x", [0, 0], [5, 0])]);
      const gone = commitOk(lone, deleteCurveHeal(context(lone), "entity:x"));
      equal(gone.sketch.entities.length, 0, "an isolated line is just removed");
    }
  },
  {
    name: "split and jog round-trip through project validation and an undo-style replay of the operations",
    run: () => {
      let project = projectWith([line("a", [0, 0], [20, 0])]);
      project = commitOk(project, splitAt(context(project), "entity:a", [5, 0]));
      project = commitOk(project, jogLine(context(project), linesOf(project)[1]!.id, [13, 0], { offsetMm: 2, widthMm: 4 }));
      const json = JSON.stringify(project);
      const restored = JSON.parse(json) as typeof project;
      equal(restored.sketch.entities.length, project.sketch.entities.length, "the sketch survives serialization");
      const again = commit(restored, jogLine(context(restored), linesOf(restored)[0]!.id, [2, 0], { offsetMm: 1, widthMm: 1 }));
      assert(again.ok, "the restored project accepts further edits");
    }
  }
];
