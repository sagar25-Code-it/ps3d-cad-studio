import type { SketchEntity, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { copySketchSelection, pasteSketchClipboard, parseClipboard, serializeClipboard } from "../packages/workbench-sketch/src/sketch-clipboard.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { applyOk, arc, circle, con, ctx, ellipse, line, projectWith, rect } from "./edit-test-kit.js";

/** Wave 3 regression tests for the sketch clipboard (re-audit 2: Edit tools E10). */

const point = (id: string, at: readonly [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "point", point: at, construction: false });
const spline = (id: string): SketchEntity => ({ id: `entity:${id}`, kind: "spline", fitPoints: [[0, 0], [10, 10], [20, 0], [30, 10]], construction: false });

/** JSON with the keys of every object in sorted order, to compare data whatever order its keys were written in. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
}

interface Case {
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

const cases: Readonly<Record<string, Case>> = {
  diameter: { entities: [circle("c", [0, 0], 5)], constraints: [con("d", "radius", ["c"], { valueMm: 10, dimension: "diameter" })] },
  radius: { entities: [circle("c", [0, 0], 5)], constraints: [con("d", "radius", ["c"], { valueMm: 5, dimension: "radius" })] },
  aligned: { entities: [circle("c", [0, 0], 2), circle("d", [30, 40], 2)], constraints: [con("d", "distance", ["c", "d"], { valueMm: 50, dimension: "aligned", points: ["center", "center"] })] },
  horizontalDistance: { entities: [circle("c", [0, 0], 2), circle("d", [30, 0], 2)], constraints: [con("d", "distance", ["c", "d"], { valueMm: 30, dimension: "horizontal", points: ["center", "center"] })] },
  verticalDistance: { entities: [circle("c", [0, 0], 2), circle("d", [0, 40], 2)], constraints: [con("d", "distance", ["c", "d"], { valueMm: 40, dimension: "vertical", points: ["center", "center"] })] },
  pointLine: { entities: [circle("c", [0, 10], 2), line("a", [0, 0], [30, 0])], constraints: [con("d", "distance", ["c", "a"], { valueMm: 10, dimension: "point-line", points: ["center"] })] },
  lineLine: { entities: [line("a", [0, 0], [30, 0]), line("b", [0, 10], [30, 10])], constraints: [con("d", "distance", ["a", "b"], { valueMm: 10, dimension: "line-line" })] },
  majorRadius: { entities: [ellipse("e", [0, 0], 20, 10)], constraints: [con("d", "radius", ["e"], { valueMm: 20, dimension: "major-radius" })] },
  minorRadius: { entities: [ellipse("e", [0, 0], 20, 10)], constraints: [con("d", "radius", ["e"], { valueMm: 10, dimension: "minor-radius" })] },
  pointOnCurve: { entities: [line("a", [0, 0], [30, 0]), line("b", [15, 0], [15, 20])], constraints: [con("k", "coincident", ["b", "a"], { points: ["start", "curve"] })] },
  rectangleCorner: { entities: [rect("r", [0, 0], 20, 10), line("b", [10, 5], [30, 5])], constraints: [con("k", "coincident", ["b", "r"], { points: ["start", "corner-2"] })] },
  rectangleCornerDistance: { entities: [rect("r", [0, 0], 20, 10), circle("c", [30, 20], 3)], constraints: [con("k", "distance", ["r", "c"], { valueMm: 20, dimension: "horizontal", points: ["corner-1", "center"] })] },
  drivenLength: { entities: [line("a", [0, 0], [30, 0])], constraints: [con("d", "distance", ["a"], { dimension: "length", driven: true })] },
  drivenRadius: { entities: [circle("c", [0, 0], 5)], constraints: [con("d", "radius", ["c"], { dimension: "radius", driven: true })] },
  suppressed: { entities: [line("a", [0, 0], [30, 0])], constraints: [con("h", "horizontal", ["a"], { suppressed: true })] },
  angle: { entities: [line("a", [0, 0], [30, 0]), line("b", [0, 0], [20, 20])], constraints: [con("g", "angle", ["a", "b"], { valueDeg: 45 })] },
  arcLength: { entities: [arc("a", [10, 0], [0, 10], [-10, 0])], constraints: [con("g", "arc-length", ["a"], { valueMm: 31.4159 })] },
  perimeter: { entities: [line("a", [0, 0], [30, 0]), line("b", [30, 0], [30, 20])], constraints: [con("g", "perimeter", ["a", "b"], { valueMm: 50 })] },
  smooth: { entities: [line("a", [0, 0], [30, 0]), spline("s")], constraints: [con("g", "smooth", ["a", "s"], { points: ["end", "start"] })] },
  midpoint: { entities: [line("a", [0, 0], [30, 0]), point("p", [15, 0])], constraints: [con("g", "midpoint", ["p", "a"], { points: ["self"] })] },
  symmetry: { entities: [line("a", [10, 0], [20, 5]), line("b", [-10, 0], [-20, 5]), line("x", [0, -10], [0, 10])], constraints: [con("g", "symmetry", ["a", "b", "x"])] },
  refraction: { entities: [line("i", [0, 0], [10, 10]), line("f", [10, 10], [20, 10]), line("r", [10, 10], [20, 0])], constraints: [con("g", "refraction", ["i", "f", "r"], { ratio: 1.5 })] },
  expression: { entities: [line("a", [0, 0], [30, 0])], constraints: [con("d", "distance", ["a"], { valueMm: 30, dimension: "length", expression: "plate_w" })] }
};

export const sketchEdit3ClipboardTests: readonly TestCase[] = [
  {
    name: "Wave 3 edit E10: the clipboard round-trips every relation kind, dimension name and point reference the project accepts, and rejects the ones it does not",
    run: () => {
      for (const [name, sample] of Object.entries(cases)) {
        const project = projectWith(sample.entities, sample.constraints);
        const copied = copySketchSelection(project.sketch, sample.entities.map((entity) => entity.id));
        if (!copied.ok) throw new Error(`${name}: copy refused: ${copied.diagnostics[0]?.message}`);
        equal(copied.value.constraints.length, sample.constraints.length, `${name}: the relation travels with the copy`);
        const parsed = parseClipboard(serializeClipboard(copied.value));
        if (!parsed.ok) throw new Error(`${name}: ${parsed.diagnostics[0]?.message}`);
        const expected = sample.constraints.map(({ expression: _expression, ...rest }) => rest);
        assert(JSON.stringify(parsed.value.constraints) === JSON.stringify(expected), `${name}: the relation reads back unchanged (expressions are dropped, their value kept)`);
        assert(canon(parsed.value.entities) === canon(sample.entities), `${name}: and so do the curves`);
      }
      // What the project itself refuses stays refused.
      const base = copySketchSelection(projectWith(cases.diameter!.entities, cases.diameter!.constraints).sketch, ["entity:c"]);
      if (!base.ok) throw new Error("copy");
      const tamper = (change: (constraint: Record<string, unknown>) => void): boolean => {
        const data = JSON.parse(serializeClipboard(base.value)) as { constraints: Record<string, unknown>[] };
        change(data.constraints[0]!);
        return parseClipboard(JSON.stringify(data)).ok;
      };
      assert(!tamper((constraint) => { constraint.dimension = "nonsense"; }), "an unknown dimension name is refused");
      assert(!tamper((constraint) => { constraint.points = ["major-end"]; }), "an unknown point reference is refused");
      assert(!tamper((constraint) => { constraint.kind = "bogus"; }), "an unknown relation kind is refused");
      assert(!tamper((constraint) => { constraint.entityIds = ["entity:elsewhere"]; }), "a relation to a curve that is not on the clipboard is refused");
      assert(!tamper((constraint) => { constraint.valueMm = Number.NaN; }), "a value that is not a number is refused");
    }
  },
  {
    name: "Wave 3 edit E10: pasted diameter, aligned, horizontal and vertical distance, point-line, line-line and ellipse radius dimensions keep their relation on the copy",
    run: () => {
      for (const name of ["diameter", "aligned", "horizontalDistance", "verticalDistance", "pointLine", "lineLine", "majorRadius", "minorRadius", "drivenLength", "angle", "pointOnCurve"]) {
        const sample = cases[name]!;
        const source = projectWith(sample.entities, sample.constraints);
        const copied = copySketchSelection(source.sketch, sample.entities.map((entity) => entity.id));
        if (!copied.ok) throw new Error(`${name}: copy refused`);
        const parsed = parseClipboard(serializeClipboard(copied.value));
        if (!parsed.ok) throw new Error(`${name}: ${parsed.diagnostics[0]?.message}`);
        const target = projectWith([line("existing", [100, 100], [120, 100])]);
        const pasted = applyOk(target, pasteSketchClipboard(ctx(target), parsed.value));
        equal(pasted.sketch.constraints.length, sample.constraints.length, `${name}: the pasted copy carries its relation`);
        equal(pasted.sketch.constraints[0]!.kind, sample.constraints[0]!.kind, `${name}: of the same kind`);
      }
    }
  }
];
