import { copySketchSelection, parseClipboard, pasteSketchClipboard, serializeClipboard } from "../packages/workbench-sketch/src/sketch-clipboard.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { applyOk, arc, circle, con, ctx, ids, line, ofKind, projectWith, relationsOf, spline } from "./edit-test-kit.js";

function roundTrip(project: ReturnType<typeof projectWith>, names: string[]) {
  const copied = copySketchSelection(project.sketch, ids(...names));
  assert(copied.ok, "copy works");
  return { copied: copied.value, parsed: parseClipboard(serializeClipboard(copied.value)) };
}

export const sketchEditClipboardTests: readonly TestCase[] = [
  {
    name: "Sketch edit E10 the clipboard text round-trips every relation kind, including angle value, ratio, driven and pierce",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [100, 0]), line("b", [100, 0], [100, 50]), line("i", [0, 10], [50, 10]), spline("s", [[0, 30], [20, 40], [40, 30]]), arc("r", [0, 60], [10, 70], [20, 60]), circle("c", [60, 60], 5)],
        [
          con("angle", "angle", ["a", "b"], { valueDeg: 90 }),
          con("driven", "angle", ["a", "b"], { driven: true }),
          con("smooth", "smooth", ["s", "i"], { points: ["end", "start"] }),
          con("arclen", "arc-length", ["r"], { valueMm: 15.7 }),
          con("perim", "perimeter", ["c"], { valueMm: 31.4 }),
          con("refraction", "refraction", ["a", "b", "i"], { ratio: 1.5 }),
          con("pierce", "pierce", ["c"], { pierce: { kind: "axis", axisId: "axis:z" } } as never)
        ]
      );
      const { copied, parsed } = roundTrip(project, ["a", "b", "i", "s", "r", "c"]);
      equal(copied.constraints.length, 7, "all seven relations are copied");
      assert(parsed.ok, parsed.ok ? "" : `parse refused: ${parsed.diagnostics[0]?.message}`);
      if (!parsed.ok) return;
      equal(parsed.value.constraints.length, 7, "and all seven survive the text form");
      const angle = parsed.value.constraints.find((constraint) => constraint.id === "constraint:angle")!;
      equal(angle.valueDeg, 90, "the angle value is kept");
      equal(parsed.value.constraints.find((constraint) => constraint.id === "constraint:driven")!.driven, true, "the driven flag is kept");
      equal(parsed.value.constraints.find((constraint) => constraint.id === "constraint:refraction")!.ratio, 1.5, "the ratio is kept");
      assert(parsed.value.constraints.find((constraint) => constraint.id === "constraint:pierce")!.pierce !== undefined, "and the pierce reference");
    }
  },
  {
    name: "Sketch edit E10 the clipboard refuses coordinates beyond the project limit and unknown extra fields",
    run: () => {
      const good = { format: "ps3d-sketch-clipboard/1", entities: [{ id: "entity:x", kind: "line", start: [0, 0], end: [10, 0], construction: false }], constraints: [], from: "t", leftBehind: 0 };
      assert(parseClipboard(JSON.stringify(good)).ok, "a plain line is accepted");
      const far = { ...good, entities: [{ ...good.entities[0]!, end: [500_000, 0] }] };
      const farResult = parseClipboard(JSON.stringify(far));
      assert(!farResult.ok, "500000 mm is beyond the 10000 mm project limit");
      const extra = { ...good, entities: [{ ...good.entities[0]!, secret: "x" }] };
      assert(!parseClipboard(JSON.stringify(extra)).ok, "an unknown field on an entity is refused");
      const extraRelation = { ...good, constraints: [{ id: "constraint:a", kind: "horizontal", entityIds: ["entity:x"], evil: true }] };
      assert(!parseClipboard(JSON.stringify(extraRelation)).ok, "and on a relation");
      const withExpression = { ...good, constraints: [{ id: "constraint:d", kind: "distance", entityIds: ["entity:x"], valueMm: 10, dimension: "length", expression: "2 * pin_r" }] };
      const parsed = parseClipboard(JSON.stringify(withExpression));
      assert(parsed.ok && parsed.value.constraints[0]!.expression === undefined && parsed.value.constraints[0]!.valueMm === 10, "a parameter expression is dropped but its value is kept");
    }
  },
  {
    name: "Sketch edit E18 pasting a parallel pair whose lines run opposite ways keeps the relation instead of dropping every relation",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [100, 0]), line("c", [100, 50], [0, 50])],
        [con("par", "parallel", ["a", "c"]), con("hor", "horizontal", ["a"])]
      );
      const copied = copySketchSelection(project.sketch, ids("a", "c"));
      assert(copied.ok, "copy works");
      if (!copied.ok) return;
      const pasted = applyOk(project, pasteSketchClipboard(ctx(project), copied.value, { offsetMm: [0, 200] }));
      const solved = solveLiveSketch(pasted.sketch);
      assert(solved.ok, "the pasted sketch solves");
      // The original pair already reads as a solver quirk; the pasted copy must not add to it.
      const fresh = pasted.sketch.entities.filter((entity) => !["entity:a", "entity:c"].includes(entity.id)).map((entity) => entity.id);
      assert(solved.ok && !solved.movedIds.some((id) => fresh.includes(id)), "no pasted line would be moved by the solver");
      equal(relationsOf(pasted, "parallel").length, 2, "the pasted pair is still parallel");
      equal(relationsOf(pasted, "horizontal").length, 2, "and horizontal");
      equal(ofKind(pasted, "line").length, 4, "four lines");
    }
  }
];
