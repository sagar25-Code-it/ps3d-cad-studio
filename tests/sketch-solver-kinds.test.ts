import { applyWorkbenchOperation, createWorkbenchProject, describeConstraint, entityNames } from "../packages/workbench-core/src/index.js";
import { arcShape } from "../packages/workbench-core/src/sketch-measure.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { dragSketchHandle } from "../packages/workbench-sketch/src/drag.js";
import { buildRoundedRectangle } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import {
  AXIS_X, AXIS_Y, ORIGIN, addConstraint, analysis, apply, arc, circle, dof, ellipse, get, line, lengthDim, lengthOf, lineRing, point, projectWith, rect, refuse, refuseDimension, rel, run, setDimension,
  type Arc, type Circle, type Line, type Point
} from "./sketch-solver-kit.js";

/** Fixed geometry, stale dimensions, limits and the new constraint and dimension kinds (audit S14 to S23, P17, P18, E06 and the missing capability list). */

const distanceToLine = (l: Line, p: readonly [number, number]): number => Math.abs((l.end[0] - l.start[0]) * (p[1] - l.start[1]) - (l.end[1] - l.start[1]) * (p[0] - l.start[0])) / lengthOf(l);

function shapeIds(prefix: string): { entity: () => string; constraint: () => string } {
  let n = 0;
  return { entity: () => `entity:${prefix}-${++n}`, constraint: () => `constraint:${prefix}-${++n}` };
}

export const sketchSolverKindsTests: readonly TestCase[] = [
  {
    name: "Constraint solver S14: fixed geometry is not silently resized by a dimension edit; the refusal names the Fix",
    run: () => {
      const fixedLine = addConstraint(projectWith([line("a", [0, 0], [10, 0])]), rel("fixed", ["a"]));
      const lineMessage = refuseDimension(fixedLine, "a", "length", 50);
      assert(/Length 50 on Line 1/.test(lineMessage) && /Fix on Line 1/.test(lineMessage), `names the length and the Fix: ${lineMessage}`);
      const fixedCircle = addConstraint(projectWith([circle("c", [0, 0], 10)]), rel("fixed", ["c"]));
      assert(/Radius 20 on Circle 1/.test(refuseDimension(fixedCircle, "c", "radius", 20)), "a fixed circle keeps its radius");
      const fixedRectangle = addConstraint(projectWith([rect("r", [0, 0], 60, 40)]), rel("fixed", ["r"]));
      assert(/Width 100 on Rectangle 1/.test(refuseDimension(fixedRectangle, "r", "width", 100)), "a fixed rectangle keeps its width");
      near(get(fixedLine, "a", "line").end[0], 10, 0, "and the geometry itself did not change");
      // A line with only its start fixed can still change length: the free end moves.
      const startFixed = addConstraint(projectWith([line("a", [0, 0], [10, 0])]), rel("fixed", ["a"], { points: ["start"] }));
      const grown = setDimension(startFixed, "a", "length", 25);
      near(get(grown, "a", "line").end[0], 25, 1e-9, "a point-level Fix lets the other end move");
      near(get(grown, "a", "line").start[0], 0, 0, "while the fixed start stays exactly where it was");
    }
  },
  {
    name: "Constraint solver S15: a radius dimension that disagrees with the circle snaps the circle; a relaxed radius restores",
    run: () => {
      const stale = addConstraint(projectWith([circle("c", [0, 0], 6)]), { id: "constraint:sim-stale", kind: "radius", entityIds: ["entity:c"], dimension: "radius", valueMm: 7 });
      near(get(stale, "c", "circle").radiusMm, 7, 1e-9, "the circle takes the dimension's 7 instead of the solve failing");
      let project = setDimension(projectWith([circle("c", [0, 0], 6)]), "c", "radius", 7);
      const ids = project.sketch.constraints.map((constraint) => constraint.id);
      project = run(project, { kind: "set-sketch-constraints-suppressed", constraintIds: ids, suppressed: true });
      project = { ...project, sketch: { ...project.sketch, entities: [{ ...get(project, "c", "circle"), radiusMm: 9 }] } };
      const restored = run(project, { kind: "set-sketch-constraints-suppressed", constraintIds: ids, suppressed: false });
      near(get(restored, "c", "circle").radiusMm, 7, 1e-9, "restoring the radius snaps the circle back to 7");
      let perimeter = setDimension(projectWith([circle("c", [0, 0], 6)]), "c", "perimeter", 62.83185307179586);
      const pids = perimeter.sketch.constraints.map((constraint) => constraint.id);
      perimeter = run(perimeter, { kind: "set-sketch-constraints-suppressed", constraintIds: pids, suppressed: true });
      perimeter = { ...perimeter, sketch: { ...perimeter.sketch, entities: [{ ...get(perimeter, "c", "circle"), radiusMm: 3 }] } };
      perimeter = run(perimeter, { kind: "set-sketch-constraints-suppressed", constraintIds: pids, suppressed: false });
      near(get(perimeter, "c", "circle").radiusMm, 10, 1e-9, "the same holds for a circle's perimeter");
    }
  },
  {
    name: "Constraint solver S16: a rectangle's width and height dimensions hold on restore and on a corner drag",
    run: () => {
      let project = projectWith([rect("r", [0, 0], 60, 40)]);
      project = setDimension(project, "r", "width", 60);
      project = setDimension(project, "r", "height", 40);
      const dragged = dragSketchHandle(project.sketch, "entity:r", { kind: "corner", index: 2 }, [30, 20], [80, 50]);
      assert(dragged.ok, "the corner drag is accepted");
      if (dragged.ok) {
        const moved = dragged.entities[0]!;
        assert(moved.kind === "rectangle", "still a rectangle");
        if (moved.kind === "rectangle") {
          near(moved.widthMm, 60, 1e-9, "the width dimension holds while dragging");
          near(moved.heightMm, 40, 1e-9, "and the height dimension too");
        }
      }
      const ids = project.sketch.constraints.map((constraint) => constraint.id);
      let relaxed = run(project, { kind: "set-sketch-constraints-suppressed", constraintIds: ids, suppressed: true });
      relaxed = { ...relaxed, sketch: { ...relaxed.sketch, entities: [{ ...get(relaxed, "r", "rectangle"), widthMm: 100 }] } };
      const restored = run(relaxed, { kind: "set-sketch-constraints-suppressed", constraintIds: ids, suppressed: false });
      near(get(restored, "r", "rectangle").widthMm, 60, 1e-9, "restoring the width dimension snaps the width back to 60");
    }
  },
  {
    name: "Constraint solver S17: tangent circles keep touching on the outside when a radius grows",
    run: () => {
      let project = projectWith([circle("a", [0, 0], 5), circle("b", [15, 0], 10)]);
      project = addConstraint(project, rel("tangent", ["a", "b"]));
      for (const radius of [30, 15]) {
        const resized = setDimension(project, "a", "radius", radius);
        const a = get(resized, "a", "circle");
        const b = get(resized, "b", "circle");
        near(Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]), a.radiusMm + b.radiusMm, 1e-6, `still external after the first circle becomes ${radius}`);
        near(b.radiusMm, 10, 1e-6, "the second circle kept its radius: it moved away instead of turning inside out");
      }
    }
  },
  {
    name: "Constraint solver S18: with the arc ends joined, editing one side of a rounded rectangle keeps the profile closed",
    run: () => {
      const rounded = buildRoundedRectangle([0, 0], [60, 40], 6, shapeIds("rr"));
      assert(rounded.ok, "the rounded rectangle builds");
      if (!rounded.ok) return;
      const ring = rounded.value.entities;
      // Join every line end to the arc end beside it (the new arc-end references).
      const joins = ring.map((entity, index) => {
        const next = ring[(index + 1) % ring.length]!;
        return rel("coincident", [entity.id.replace("entity:", ""), next.id.replace("entity:", "")], { points: ["end", "start"] });
      });
      let project = projectWith(ring, [...rounded.value.constraints, ...joins]);
      equal(detectSketchProfiles(project.sketch).length, 1, "the rounded rectangle is a closed profile");
      const bottom = ring.find((entity) => entity.kind === "line")!;
      project = setDimension(project, bottom.id.replace("entity:", ""), "length", 50);
      equal(detectSketchProfiles(project.sketch).length, 1, "after the bottom side is set to 50 the profile is still closed");
      near(lengthOf(get(project, bottom.id.replace("entity:", ""), "line")), 50, 1e-6, "and the side is 50");
      const cornerRadii = project.sketch.entities.filter((entity): entity is Arc => entity.kind === "arc").map((entity) => arcShape(entity.start, entity.mid, entity.end)!.radiusMm);
      assert(cornerRadii.every((value) => Math.abs(value - cornerRadii[0]!) < 1e-6), "the four corners stayed equal");
    }
  },
  {
    name: "Constraint solver S19: leaving the coordinate limit or the minimum size is explained",
    run: () => {
      const far = projectWith([line("a", [5000, 0], [5100, 0])]);
      const message = refuseDimension(far, "a", "length", 9000);
      assert(/10,000 mm/.test(message), `names the coordinate limit: ${message}`);
      const tiny = refuse(projectWith([]), { kind: "add-sketch-entity", entity: line("t", [0, 0], [0.005, 0]) });
      assert(/0\.01 mm/.test(tiny), `names the minimum size: ${tiny}`);
      const duplicate = refuse(projectWith([line("a", [0, 0], [5, 0])]), { kind: "add-sketch-entity", entity: line("a", [0, 1], [5, 1]) });
      assert(/already exists/.test(duplicate), `a repeated ID has its own message: ${duplicate}`);
    }
  },
  {
    name: "Constraint solver S20: NaN and Infinity in an entity or constraint return a diagnostic, never an exception",
    run: () => {
      const base = projectWith([line("a", [0, 0], [5, 0]), circle("c", [10, 0], 2)]);
      const attempts: readonly (() => ReturnType<typeof apply>)[] = [
        () => apply(base, { kind: "add-sketch-entity", entity: line("n", [0, 0], [Number.NaN, 1]) }),
        () => apply(base, { kind: "add-sketch-entity", entity: circle("n", [0, 0], Number.POSITIVE_INFINITY) }),
        () => apply(base, { kind: "add-sketch-constraint", constraint: { id: "constraint:sim-nan", kind: "radius", entityIds: ["entity:c"], dimension: "radius", valueMm: Number.NaN } }),
        () => apply(base, { kind: "add-sketch-constraint", constraint: { id: "constraint:sim-inf", kind: "angle", entityIds: ["entity:a", "entity:a"], valueDeg: Number.POSITIVE_INFINITY } }),
        () => apply(base, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: Number.NaN })
      ];
      for (const attempt of attempts) {
        let result: ReturnType<typeof apply> | undefined;
        let threw = false;
        try { result = attempt(); } catch { threw = true; }
        assert(!threw, "no exception escapes");
        assert(result !== undefined && !result.ok, "the operation is refused");
        assert(result !== undefined && !result.ok && /finite|number/.test(result.diagnostics[0]?.message ?? ""), "with a message about the number");
      }
    }
  },
  {
    name: "Constraint solver S21 and pipeline P17: relations that cannot mean anything are refused with the rule table's reason",
    run: () => {
      const base = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5]), circle("c", [30, 0], 5), circle("d", [50, 0], 5), arc("arc", [10, 10], [17, 17], [10, 24])]);
      const refused: readonly (readonly [string, Parameters<typeof rel>])[] = [
        ["parallel a with itself", ["parallel", ["a", "a"]]],
        ["equal a with itself", ["equal", ["a", "a"]]],
        ["collinear a with itself", ["collinear", ["a", "a"]]],
        ["concentric c with itself", ["concentric", ["c", "c"]]],
        ["perpendicular a with itself", ["perpendicular", ["a", "a"]]],
        ["horizontal on a circle", ["horizontal", ["c"]]],
        ["parallel line and circle", ["parallel", ["a", "c"]]],
        ["equal circle and line", ["equal", ["c", "a"]]],
        ["concentric two lines", ["concentric", ["a", "b"]]],
        ["radius on a line", ["radius", ["a"], { dimension: "radius", valueMm: 5 }]],
        ["distance on two circles", ["distance", ["c", "d"], { dimension: "length", valueMm: 100 }]],
        ["a radius without a value", ["radius", ["c"], { dimension: "radius" }]]
      ];
      for (const [label, [kind, names, extra]] of refused) {
        const result = apply(base, { kind: "add-sketch-constraint", constraint: rel(kind, names, extra) });
        assert(!result.ok, `${label} is refused`);
        assert(!result.ok && (result.diagnostics[0]?.message ?? "").length > 10, `${label} says why: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
      }
      const badPierce = apply(projectWith([point("p", [0, 0])]), { kind: "add-sketch-constraint", constraint: { id: "constraint:sim-pierce", kind: "pierce", entityIds: ["entity:p"], pierce: { kind: "axis", axisId: "axis:z" } } });
      assert(!badPierce.ok && /axis:z/.test(badPierce.diagnostics[0]?.message ?? ""), "a pierce onto an axis that does not exist is refused");
      equal(base.sketch.constraints.length, 0, "and the sketch was not changed by any of them");
      const circleArc = addConstraint(base, rel("equal", ["c", "arc"]));
      const joinedArc = get(circleArc, "arc", "arc");
      near(get(circleArc, "c", "circle").radiusMm, arcShape(joinedArc.start, joinedArc.mid, joinedArc.end)!.radiusMm, 1e-6, "a circle and an arc can still be equal");
    }
  },
  {
    name: "Constraint solver S22 and S23: a relaxed dimension keeps its relaxed state when its value is set again",
    run: () => {
      let project = setDimension(projectWith([line("a", [0, 0], [10, 0])]), "a", "length", 20);
      const id = project.sketch.constraints[0]!.id;
      project = run(project, { kind: "set-sketch-constraints-suppressed", constraintIds: [id], suppressed: true });
      const result = apply(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 30 });
      assert(result.ok, "the value can be set on a relaxed dimension");
      if (!result.ok) return;
      const stored = result.value.project.sketch.constraints[0]!;
      equal(stored.suppressed, true, "the dimension is still relaxed");
      equal(stored.valueMm, 30, "but remembers the new value");
      near(get(result.value.project, "a", "line").end[0], 20, 1e-9, "the geometry did not move");
      assert(/relaxed/.test(result.value.summary), `and the summary says so: ${result.value.summary}`);
      const restored = run(result.value.project, { kind: "set-sketch-constraints-suppressed", constraintIds: [id], suppressed: false });
      near(get(restored, "a", "line").end[0], 30, 1e-9, "restoring it enforces the new 30");
    }
  },
  {
    name: "New kinds: the sketch origin and the axes can be referenced; points sit on them and on lines, circles, arcs and ellipses",
    run: () => {
      let project = projectWith([line("a", [3, 4], [13, 4]), circle("c", [20, 20], 5), point("p", [5, 7]), point("q", [3, 4])]);
      project = addConstraint(project, rel("coincident", [ORIGIN, "a"], { points: ["self", "start"] }));
      near(get(project, "a", "line").start[0], 0, 1e-9, "a line start joins the origin (x)");
      near(get(project, "a", "line").start[1], 0, 1e-9, "(y)");
      near(get(project, "a", "line").end[0], 13, 1e-9, "the other end stayed");
      project = addConstraint(project, rel("coincident", ["c", ORIGIN], { points: ["center", "self"] }));
      near(get(project, "c", "circle").center[0], 0, 1e-9, "a circle centre joins the origin");
      project = addConstraint(project, rel("coincident", ["p", AXIS_X], { points: ["self", "curve"] }));
      project = addConstraint(project, rel("coincident", ["q", AXIS_Y], { points: ["self", "curve"] }));
      near(get(project, "p", "point").point[1], 0, 1e-9, "a point sits on the X axis");
      near(get(project, "q", "point").point[0], 0, 1e-9, "a point sits on the Y axis");
      near(get(project, "p", "point").point[0], 5, 1e-9, "sliding along the axis only: x unchanged");
      const reload = JSON.parse(JSON.stringify(project)) as typeof project;
      equal(reload.sketch.constraints.length, project.sketch.constraints.length, "the datum references survive a save and reload");

      let curves = projectWith([point("p", [10, 3]), circle("c", [0, 0], 5), line("l", [0, 0], [10, 10]), point("q", [4, 0]), arc("arc", [10, 0], [7, 7], [0, 10]), point("r", [3, 8]), ellipse("e", [0, 0], 10, 5), point("s", [6, 6])]);
      curves = addConstraint(curves, rel("coincident", ["p", "c"], { points: ["self", "curve"] }));
      near(Math.hypot(...get(curves, "p", "point").point), 5, 1e-9, "a point on a circle is one radius from its centre");
      curves = addConstraint(curves, rel("coincident", ["q", "l"], { points: ["self", "curve"] }));
      near(distanceToLine(get(curves, "l", "line"), get(curves, "q", "point").point), 0, 1e-9, "a point on a line");
      curves = addConstraint(curves, rel("coincident", ["r", "arc"], { points: ["self", "curve"] }));
      const solvedArc = get(curves, "arc", "arc");
      const shape = arcShape(solvedArc.start, solvedArc.mid, solvedArc.end)!;
      const rr = get(curves, "r", "point").point;
      near(Math.hypot(rr[0] - shape.center[0], rr[1] - shape.center[1]), shape.radiusMm, 1e-6, "a point on an arc lies on its circle");
      curves = addConstraint(curves, rel("coincident", ["s", "e"], { points: ["self", "curve"] }));
      const ss = get(curves, "s", "point").point;
      near((ss[0] / 10) ** 2 + (ss[1] / 5) ** 2, 1, 1e-6, "a point on an ellipse satisfies its equation");
      equal(dof(curves) % 1, 0, "the analysis stays an integer");
    }
  },
  {
    name: "New kinds: point-to-point distances (aligned, horizontal, vertical), from the origin, point to line and line to line drive geometry",
    run: () => {
      let pair = projectWith([point("p", [10, 0]), point("q", [20, 5])]);
      pair = setDimension(pair, "q", "horizontal", 30, { second: "p", points: ["self", "self"] });
      near(get(pair, "q", "point").point[0] - get(pair, "p", "point").point[0], 30, 1e-9, "the horizontal distance from p to q is 30: p moved, q (picked first) is the reference");
      near(get(pair, "q", "point").point[0], 20, 0, "q did not move");
      pair = setDimension(pair, "q", "vertical", 12, { second: "p", points: ["self", "self"] });
      near(Math.abs(get(pair, "q", "point").point[1] - get(pair, "p", "point").point[1]), 12, 1e-9, "the vertical distance is 12");
      near(get(pair, "q", "point").point[0], 20, 0, "the first-picked point never moved");
      const measured = analysis(pair);
      equal(measured.degreesOfFreedom, 4 - 2, "two distances took two degrees of freedom");

      let fromOrigin = projectWith([point("q", [20, 5])]);
      fromOrigin = setDimension(fromOrigin, ORIGIN, "aligned", 50, { second: "q", points: ["self", "self"] });
      near(Math.hypot(...get(fromOrigin, "q", "point").point), 50, 1e-9, "the distance from the origin is 50");
      equal(fromOrigin.sketch.constraints[0]!.entityIds[0], ORIGIN, "and the dimension names the origin");
      const hole = setDimension(setDimension(projectWith([circle("h", [20, 5], 3)]), ORIGIN, "horizontal", 40, { second: "h", points: ["self", "center"] }), ORIGIN, "vertical", 15, { second: "h", points: ["self", "center"] });
      near(get(hole, "h", "circle").center[0], 40, 1e-9, "a hole is located 40 across");
      near(get(hole, "h", "circle").center[1], 15, 1e-9, "and 15 up from the origin");
      equal(dof(hole), 1, "with its radius still free");

      let toLine = projectWith([line("l", [0, 0], [20, 0]), circle("c", [5, 3], 2)]);
      toLine = setDimension(toLine, "c", "point-line", 10, { second: "l", points: ["center"] });
      near(get(toLine, "c", "circle").center[1], 10, 1e-9, "a centre 10 from a line");
      near(get(toLine, "c", "circle").center[0], 5, 1e-9, "only along the perpendicular");

      let rails = projectWith([line("a", [0, 0], [20, 0]), line("b", [0, 4], [20, 4])]);
      rails = setDimension(rails, "a", "line-line", 12, { second: "b" });
      near(get(rails, "b", "line").start[1], 12, 1e-9, "two lines 12 apart");
      near(get(rails, "a", "line").start[1], 0, 0, "the first line is the reference");
      const stored = rails.sketch.constraints[0]!;
      equal(stored.dimension, "line-line", "the dimension kind is stored on the constraint");
      assert(/Distance 12 between Line 1 and Line 2/.test(describeConstraint(stored, entityNames(rails.sketch))), "its name reads naturally");
    }
  },
  {
    name: "New kinds: point-level Fix locks one end or a centre instead of the whole curve",
    run: () => {
      let project = projectWith([line("a", [0, 0], [10, 0]), circle("c", [5, 5], 3)]);
      project = addConstraint(project, rel("fixed", ["a"], { points: ["start"] }));
      project = addConstraint(project, rel("fixed", ["c"], { points: ["center"] }));
      equal(dof(project), 2 + 1, "the line keeps its end (2) and the circle its radius (1)");
      const longer = setDimension(project, "a", "length", 25);
      near(get(longer, "a", "line").end[0], 25, 1e-9, "the free end of the line can be dimensioned");
      const bigger = setDimension(project, "c", "radius", 8);
      near(get(bigger, "c", "circle").radiusMm, 8, 1e-9, "the radius of a circle whose centre is fixed can change");
      near(get(bigger, "c", "circle").center[0], 5, 0, "while its centre never moves");
      const dragged = dragSketchHandle(project.sketch, "entity:a", { kind: "point", ref: "start" }, [0, 0], [3, 3]);
      assert(!dragged.ok && /fixed/i.test(dragged.message), `the fixed end refuses to be dragged: ${dragged.ok ? "" : dragged.message}`);
      const freeEnd = dragSketchHandle(project.sketch, "entity:a", { kind: "point", ref: "end" }, [10, 0], [12, 4]);
      assert(freeEnd.ok, "while the other end drags freely");
    }
  },
  {
    name: "New kinds and E06: diameter, arc radius and ellipse axes and rotation are dimensions; equal works on ellipses",
    run: () => {
      const diameter = setDimension(projectWith([circle("c", [0, 0], 5)]), "c", "diameter", 30);
      near(get(diameter, "c", "circle").radiusMm, 15, 1e-9, "a diameter of 30 is a radius of 15");
      equal(diameter.sketch.constraints[0]!.dimension, "diameter", "and is stored as a diameter");
      equal(diameter.sketch.constraints[0]!.valueMm, 30, "with the value 30");

      const arcRadius = setDimension(projectWith([arc("a", [10, 0], [7, 7], [0, 10])]), "a", "radius", 12);
      const resized = get(arcRadius, "a", "arc");
      near(arcShape(resized.start, resized.mid, resized.end)!.radiusMm, 12, 1e-6, "an arc takes a radius dimension (E06)");

      let oval = projectWith([ellipse("e", [0, 0], 10, 5, 0)]);
      oval = setDimension(oval, "e", "major-radius", 14);
      oval = setDimension(oval, "e", "minor-radius", 6);
      oval = setDimension(oval, "e", "angle", 30);
      const e = get(oval, "e", "ellipse");
      near(e.majorRadiusMm, 14, 1e-9, "major axis dimension");
      near(e.minorRadiusMm, 6, 1e-9, "minor axis dimension");
      near(e.rotationDeg, 30, 1e-9, "rotation dimension");
      equal(dof(oval), 2, "an ellipse with both axes and its turn dimensioned has its centre left");
      assert(refuseDimension(projectWith([ellipse("e", [0, 0], 10, 5, 0)]), "e", "minor-radius", 12).length > 0, "a minor radius larger than the major radius is refused with a reason");

      let twins = projectWith([ellipse("e1", [0, 0], 10, 5, 0), ellipse("e2", [30, 0], 8, 3, 20)]);
      twins = addConstraint(twins, rel("equal", ["e1", "e2"]));
      near(get(twins, "e2", "ellipse").majorRadiusMm, 10, 1e-9, "equal ellipses share a major radius");
      near(get(twins, "e2", "ellipse").minorRadiusMm, 5, 1e-9, "and a minor radius");
      near(get(twins, "e2", "ellipse").rotationDeg, 20, 1e-9, "but keep their own turn");
    }
  },
  {
    name: "New kinds: arc ends join lines and other arcs, and a tangent line follows when the arc is resized",
    run: () => {
      let project = projectWith([line("l", [30, 0], [40, 5]), arc("a", [10, 0], [7, 7], [0, 10])]);
      project = addConstraint(project, rel("coincident", ["l", "a"], { points: ["start", "end"] }));
      const joined = get(project, "a", "arc");
      near(joined.end[0], 30, 1e-9, "the arc end sits on the line start (x)");
      near(joined.end[1], 0, 1e-9, "(y)");
      near(get(project, "l", "line").start[0], 30, 0, "the line, picked first, is the reference");
      const radius = Math.hypot(joined.start[0] - joined.end[0], joined.start[1] - joined.end[1]);
      assert(radius > 0.01 && Number.isFinite(radius), "the arc stays a valid arc");

      let fillet = projectWith([line("a", [0, 0], [20, 0]), arc("f", [20, 0], [24.4, 1.6], [26, 6]), line("b", [26, 6], [26, 30])]);
      fillet = addConstraint(fillet, rel("coincident", ["a", "f"], { points: ["end", "start"] }));
      fillet = addConstraint(fillet, rel("coincident", ["f", "b"], { points: ["end", "start"] }));
      fillet = addConstraint(fillet, rel("tangent", ["a", "f"]));
      fillet = addConstraint(fillet, rel("tangent", ["b", "f"]));
      const edited = setDimension(fillet, "f", "radius", 8);
      const f = get(edited, "f", "arc");
      const aLine = get(edited, "a", "line");
      const bLine = get(edited, "b", "line");
      near(Math.hypot(aLine.end[0] - f.start[0], aLine.end[1] - f.start[1]), 0, 1e-6, "the first line still ends where the fillet starts");
      near(Math.hypot(bLine.start[0] - f.end[0], bLine.start[1] - f.end[1]), 0, 1e-6, "and the second starts where it ends");
    }
  },
  {
    name: "New kinds: rectangle corners join lines, a rectangle can be made level, equal and concentric, and its sides are enforced",
    run: () => {
      let project = projectWith([rect("r", [0, 0], 40, 20, 10), line("l", [60, 5], [80, 5])]);
      project = addConstraint(project, rel("horizontal", ["r"]));
      near(get(project, "r", "rectangle").rotationDeg, 0, 1e-6, "Horizontal turns a rectangle level");
      project = addConstraint(project, rel("coincident", ["r", "l"], { points: ["corner-2", "start"] }));
      const corner = (rectangle: ReturnType<typeof get<"rectangle">>): readonly [number, number] => [rectangle.center[0] + rectangle.widthMm / 2, rectangle.center[1] + rectangle.heightMm / 2];
      const moved = get(project, "l", "line");
      near(moved.start[0], corner(get(project, "r", "rectangle"))[0], 1e-6, "the line's start is on the rectangle's upper right corner (x)");
      near(moved.start[1], corner(get(project, "r", "rectangle"))[1], 1e-6, "(y)");
      let pair = projectWith([rect("a", [0, 0], 40, 20), rect("b", [100, 0], 10, 5), circle("c", [50, 50], 4)]);
      pair = addConstraint(pair, rel("equal", ["a", "b"]));
      near(get(pair, "b", "rectangle").widthMm, 40, 1e-9, "equal rectangles share a width");
      near(get(pair, "b", "rectangle").heightMm, 20, 1e-9, "and a height");
      pair = addConstraint(pair, rel("concentric", ["a", "c"]));
      near(get(pair, "c", "circle").center[0], 0, 1e-9, "a circle can be concentric with a rectangle (x)");
      near(get(pair, "c", "circle").center[1], 0, 1e-9, "(y)");
    }
  },
  {
    name: "Pipeline P18: angle, arc-length and perimeter dimensions take expressions and follow the parameter table",
    run: () => {
      const base = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 3]), arc("arc", [30, 0], [37, 7], [30, 14]), circle("c", [60, 0], 5)]);
      let project = run(base, { kind: "set-design-parameters", parameters: [{ name: "ang", expression: "35", unit: "deg", comment: "" }, { name: "len", expression: "20", unit: "mm", comment: "" }] });
      project = setDimension(project, "a", "angle", 20, { second: "b", expression: "ang" });
      near(analysisAngle(project), 35, 1e-6, "the angle follows the parameter ang = 35");
      project = setDimension(project, "arc", "arc-length", 5, { expression: "len / 2" });
      project = setDimension(project, "c", "perimeter", 20, { expression: "len * 2" });
      near(Math.abs(get(project, "c", "circle").radiusMm - 40 / (2 * Math.PI)) , 0, 1e-6, "the circle perimeter is len * 2");
      project = run(project, { kind: "set-design-parameters", parameters: [{ name: "ang", expression: "50", unit: "deg", comment: "" }, { name: "len", expression: "30", unit: "mm", comment: "" }] });
      near(analysisAngle(project), 50, 1e-6, "changing ang to 50 turns the line");
      near(get(project, "c", "circle").radiusMm, 60 / (2 * Math.PI), 1e-6, "changing len to 30 resizes the circle");
      const stored = project.sketch.constraints.find((constraint) => constraint.kind === "angle");
      equal(stored?.expression, "ang", "the angle dimension stays bound to its expression");
      const message = refuseDimension(project, "a", "angle", 400, { second: "b" });
      assert(/360/.test(message), `an angle out of range says so: ${message}`);
    }
  },
  {
    name: "Drag: the dragged handle is held at the pointer, a fixed handle is refused, and a dimension stops the point where the dimension allows",
    run: () => {
      let project = projectWith([line("a", [0, 0], [10, 0])]);
      project = addConstraint(project, rel("horizontal", ["a"]));
      const dragged = dragSketchHandle(project.sketch, "entity:a", { kind: "point", ref: "end" }, [10, 0], [14, 6]);
      assert(dragged.ok, "the drag works");
      if (dragged.ok) {
        const l = dragged.entities[0] as Line;
        near(l.end[0], 14, 1e-9, "the end is exactly under the pointer (x)");
        near(l.end[1], 6, 1e-9, "(y)");
        near(l.start[1], 6, 1e-9, "the Horizontal relation keeps the line level, so the start follows in height");
      }
      let pinned = projectWith([line("a", [0, 0], [10, 0])]);
      pinned = addConstraint(pinned, rel("fixed", ["a"]));
      const refused = dragSketchHandle(pinned.sketch, "entity:a", { kind: "point", ref: "end" }, [10, 0], [14, 6]);
      assert(!refused.ok, "a fixed line cannot be dragged by an end");
      let sized = setDimension(projectWith([line("a", [0, 0], [10, 0])]), "a", "length", 10);
      const stopped = dragSketchHandle(sized.sketch, "entity:a", { kind: "point", ref: "end" }, [10, 0], [30, 0]);
      assert(stopped.ok, "a dimensioned line can still be dragged");
      if (stopped.ok) {
        const l = stopped.entities[0] as Line;
        near(lengthOf(l), 10, 1e-6, "its length dimension holds: the end goes as far toward the pointer as the dimension allows");
        sized = { ...sized, sketch: { ...sized.sketch, entities: stopped.entities } };
      }
    }
  },
  {
    name: "Determinism: the same sketch gives the same answer twice, in any constraint order, and unrelated geometry never moves",
    run: () => {
      const ring = lineRing(3, 2);
      const constraints = [...ring.constraints, lengthDim("b", 60), lengthDim("r", 25)];
      const forward = projectWith([...ring.entities, circle("far", [500, 500], 10)], constraints);
      const shuffled = projectWith([...ring.entities, circle("far", [500, 500], 10)], [...constraints].reverse());
      const first = setDimension(forward, "b", "length", 80);
      const again = setDimension(forward, "b", "length", 80);
      equal(JSON.stringify(first.sketch.entities), JSON.stringify(again.sketch.entities), "two runs are identical");
      const other = setDimension(shuffled, "b", "length", 80);
      for (const name of ["b", "r", "t", "l"]) {
        const x = get(first, name, "line");
        const y = get(other, name, "line");
        near(x.start[0], y.start[0], 1e-9, `${name} start x does not depend on the order the relations were added`);
        near(x.end[1], y.end[1], 1e-9, `${name} end y does not depend on the order`);
      }
      equal(JSON.stringify(get(first, "far", "circle")), JSON.stringify(get(forward, "far", "circle")), "a circle nothing relates to did not move at all");
      const solved = solveLiveSketch(first.sketch);
      assert(solved.ok && solved.movedIds.length === 0, "solving a solved sketch moves nothing");
    }
  },
  {
    name: "Performance: 500 entities with 1000 constraints solve and analyse in well under a second, and a 300-line chain edits quickly",
    run: () => {
      const entities = [];
      const constraints = [];
      for (let i = 0; i < 500; i += 1) {
        entities.push(line(`p${i}`, [0, i * 3], [20, i * 3 + 0.3]));
        constraints.push(rel("horizontal", [`p${i}`]), lengthDim(`p${i}`, 25));
      }
      const wide = projectWith(entities, constraints);
      let started = performance.now();
      const solved = solveLiveSketch(wide.sketch);
      const solveMs = performance.now() - started;
      assert(solved.ok, "the solve succeeds");
      assert(solveMs < 900, `500 entities and 1000 constraints solve in ${solveMs.toFixed(0)} ms`);
      started = performance.now();
      const result = analysis(wide);
      const analyseMs = performance.now() - started;
      equal(result.degreesOfFreedom, 1000, "500 lines with a direction and a length each leave 2 numbers apiece");
      assert(analyseMs < 900, `and analyse in ${analyseMs.toFixed(0)} ms`);

      const chain = [];
      const chainRelations = [];
      for (let i = 0; i < 300; i += 1) {
        chain.push(line(`s${i}`, [i * 5, (i % 2) * 3], [i * 5 + 5, ((i + 1) % 2) * 3]));
        chainRelations.push(lengthDim(`s${i}`, 5.5));
        if (i > 0) chainRelations.push(rel("coincident", [`s${i - 1}`, `s${i}`], { points: ["end", "start"] }));
      }
      const connected = projectWith(chain, chainRelations);
      started = performance.now();
      const edited = setDimension(connected, "s0", "length", 8);
      const editMs = performance.now() - started;
      near(lengthOf(get(edited, "s0", "line")), 8, 1e-9, "the first link took its length");
      assert(editMs < 900, `a connected 300-link chain edits in ${editMs.toFixed(0)} ms`);
    }
  },
  {
    name: "Solver package: the document API reports rank-based degrees of freedom, named relation sets and applied relations only in regenerate mode",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])], [rel("parallel", ["a", "b"]), rel("parallel", ["a", "b"])]);
      const report = analysis(project);
      equal(report.degreesOfFreedom, 7, "two lines, one parallel (the second is redundant)");
      equal(report.redundant.length, 1, "one redundant set");
      const created = applyWorkbenchOperation(createWorkbenchProject("project:test-sim-api"), { kind: "select-workspace", operationId: "operation:test-sim-api", expectedRevision: 0, workspace: "sketch" });
      assert(created.ok, "the project API still works beside the solver");
    }
  }
];

function analysisAngle(project: ReturnType<typeof projectWith>): number {
  const a = project.sketch.entities.find((entity) => entity.id === "entity:a") as Line;
  const b = project.sketch.entities.find((entity) => entity.id === "entity:b") as Line;
  const turn = (Math.atan2(b.end[1] - b.start[1], b.end[0] - b.start[0]) - Math.atan2(a.end[1] - a.start[1], a.end[0] - a.start[0])) * 180 / Math.PI;
  return ((turn % 360) + 360) % 360;
}

// Types used only by the signatures above.
export type { Circle, Point };
