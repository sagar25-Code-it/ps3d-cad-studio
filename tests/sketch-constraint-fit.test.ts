import type { SketchConstraintKind, SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { constraintFit, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

type Kind = SketchEntity["kind"];
const KINDS: readonly Kind[] = ["line", "circle", "arc", "rectangle", "point", "spline"];

function make(kind: Kind, index: number): SketchEntity {
  const id = `entity:fit-${index}`;
  const dy = index * 25;
  switch (kind) {
    case "line": return { id, kind, start: [0, dy], end: [12, dy + 3 + index], construction: false };
    case "circle": return { id, kind, center: [30 + index * 3, dy], radiusMm: 4 + index, construction: false };
    case "arc": return { id, kind, start: [50, dy], mid: [55, dy + 5 + index], end: [60, dy], construction: false };
    case "rectangle": return { id, kind, center: [80, dy], widthMm: 10, heightMm: 6, rotationDeg: 0, construction: false };
    case "point": return { id, kind, point: [95, dy], construction: false };
    case "spline": return { id, kind, fitPoints: [[100, dy], [105, dy + 4], [110, dy]], construction: false };
  }
}

function tuples(length: number): readonly (readonly Kind[])[] {
  let result: (readonly Kind[])[] = [[]];
  for (let position = 0; position < length; position += 1) result = result.flatMap((prefix) => KINDS.map((kind) => [...prefix, kind]));
  return result;
}

function sketchWith(entities: readonly SketchEntity[], kind: SketchConstraintKind): WorkbenchSketch {
  return {
    ...createWorkbenchProject("project:test-constraint-fit").sketch,
    entities,
    constraints: [{ id: "constraint:fit", kind, entityIds: entities.map((entity) => entity.id) }]
  };
}

export const sketchConstraintFitTests: readonly TestCase[] = [
  {
    name: "the Constrain buttons, the solver and the analysis share one rule table, so they can never disagree about a pair",
    run: () => {
      const arities: readonly (readonly [SketchConstraintKind, number])[] = [
        ["horizontal", 1], ["vertical", 1], ["fixed", 1],
        ["parallel", 2], ["perpendicular", 2], ["collinear", 2], ["concentric", 2], ["equal", 2], ["tangent", 2],
        ["symmetry", 3]
      ];
      let compared = 0;
      for (const [kind, arity] of arities) {
        for (const combination of tuples(arity)) {
          const entities = combination.map((entityKind, index) => make(entityKind, index));
          const fit = constraintFit(kind, combination);
          const report = solveLiveSketch(sketchWith(entities, kind), entities.map((entity) => entity.id));
          // A geometric conflict (for example fixed circles of unequal radius) is a property of the numbers, not of the pair of kinds.
          if (!report.ok) continue;
          compared += 1;
          equal(report.unsolved.length === 0, fit.ok, `${kind} on ${combination.join("+")}: the rule table says ${fit.ok ? "it applies" : `it does not (${fit.reason})`} but the solver ${report.unsolved.length === 0 ? "enforced" : "skipped"} it`);
        }
      }
      assert(compared > 200, `the comparison covered ${compared} combinations`);
    }
  },
  {
    name: "a circle and an arc can be concentric: the analysis calls it satisfiable and an unrelated pair a conflict",
    run: () => {
      const circleArc = sketchWith([make("circle", 0), make("arc", 1)], "concentric");
      equal(analyzeWorkbenchSketch(circleArc).conflicts.length, 0, "a circle and an arc are a valid concentric pair");
      const lineLine = sketchWith([make("line", 0), make("line", 1)], "concentric");
      assert(analyzeWorkbenchSketch(lineLine).conflicts.length > 0, "two lines are not a valid concentric pair");
      equal(constraintFit("concentric", ["circle", "arc"]).ok, true, "the rule table agrees (circle + arc)");
      equal(constraintFit("concentric", ["line", "line"]).ok, false, "the rule table agrees (line + line)");
    }
  },
  {
    name: "disabled Constrain buttons carry a human reason from the rule table",
    run: () => {
      const rigid = constraintFit("parallel", ["rectangle", "line"]);
      assert(!rigid.ok && /Rectangles are rigid/.test(rigid.reason), "a rectangle explains that it is rigid");
      const needTwo = constraintFit("equal", ["line", "circle"]);
      assert(!needTwo.ok && /Equal needs/.test(needTwo.reason), "a mismatched equal pair says what it needs");
      const symmetric = constraintFit("symmetry", ["line", "line"]);
      assert(!symmetric.ok && /axis line/.test(symmetric.reason), "symmetry asks for an axis line");
      equal(constraintFit("tangent", ["circle", "line"]).ok, true, "tangent accepts a circle and a line in either order");
      equal(constraintFit("coincident", ["line", "line"]).ok, false, "coincident is recorded but not solved yet");
      equal(constraintFit("horizontal", [undefined]).ok, false, "a missing entity is never applicable");
    }
  }
];
