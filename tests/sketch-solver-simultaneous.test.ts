import { dragSketchHandle } from "../packages/workbench-sketch/src/drag.js";
import { buildParallelogram, buildRoundedRectangle } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { buildPolygon, buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import {
  addConstraint, analysis, apply, arc, circle, dof, get, line, lengthDim, lengthOf, lineRing, point, projectWith, rect, refuse, refuseDimension, rel, ringIsClosedRectangle, run, setDimension,
  type Line, type Vec
} from "./sketch-solver-kit.js";

/**
 * Regression tests for the simultaneous sketch solver. Each test reproduces a repro from the sketch audit (Constraint solver section,
 * issues S1 to S23, and the E07, E08, P17, P18 issues) through the real code path: operations, the live solver, the drag handler.
 */

function shapeIds(prefix: string): { entity: () => string; constraint: () => string } {
  let n = 0;
  return { entity: () => `entity:${prefix}-${++n}`, constraint: () => `constraint:${prefix}-${++n}` };
}

export const sketchSolverSimultaneousTests: readonly TestCase[] = [
  {
    name: "Constraint solver S1: a closed 4-line rectangle pinned to a fixed point translates rigidly, whatever the offset",
    run: () => {
      for (const offset of [0.5, 2, 10, 100]) {
        const ring = lineRing(offset, 0);
        let project = projectWith([...ring.entities, point("o", [0, 0])], ring.constraints);
        project = addConstraint(project, rel("fixed", ["o"]));
        project = addConstraint(project, rel("coincident", ["o", "b"], { points: ["self", "start"] }));
        const b = get(project, "b", "line");
        near(b.start[0], 0, 1e-9, `the bottom-left corner lands on the point (offset ${offset})`);
        near(b.start[1], 0, 1e-9, "and on its height");
        assert(ringIsClosedRectangle(project), `the ring is still a closed level and plumb rectangle (offset ${offset})`);
        near(lengthOf(b), 52, 1e-6, "the bottom side kept its length: the move was rigid");
        near(lengthOf(get(project, "r", "line")), 30, 1e-6, "and so did the right side");
        near(get(project, "o", "point").point[0], 0, 0, "the fixed point never moved");
      }
    }
  },
  {
    name: "Constraint solver S2: every corner of a line-built rectangle can be dragged, by 0.001 mm or by 500 mm",
    run: () => {
      const ring = lineRing();
      const project = projectWith(ring.entities, ring.constraints);
      const corners: readonly (readonly [string, "start" | "end", Vec])[] = [["b", "start", [0, 0]], ["b", "end", [52, 0]], ["r", "end", [52, 30]], ["t", "end", [0, 30]]];
      for (const distance of [0.001, 0.1, 1, 5, 20]) {
        for (const [name, ref, from] of corners) {
          const target: Vec = [from[0] + distance, from[1] + distance * 0.5];
          const dragged = dragSketchHandle(project.sketch, `entity:${name}`, { kind: "point", ref }, from, target);
          assert(dragged.ok, `dragging ${name}.${ref} by ${distance} works: ${dragged.ok ? "" : dragged.message}`);
          if (!dragged.ok) continue;
          const moved = { ...project, sketch: { ...project.sketch, entities: dragged.entities } };
          const handled = get(moved, name, "line");
          const at = ref === "start" ? handled.start : handled.end;
          near(at[0], target[0], 1e-9, `the dragged corner follows the pointer (x) for ${name}.${ref}, ${distance}`);
          near(at[1], target[1], 1e-9, "and (y)");
          assert(ringIsClosedRectangle(moved), "the rectangle stays closed, level and plumb");
        }
      }
      const far = dragSketchHandle(project.sketch, "entity:b", { kind: "point", ref: "end" }, [52, 0], [500, -300]);
      assert(far.ok, "a drag to (500, -300) works");
      if (far.ok) {
        const moved = { ...project, sketch: { ...project.sketch, entities: far.entities } };
        assert(ringIsClosedRectangle(moved), "still a rectangle after a long drag");
        near(get(moved, "b", "line").end[0], 500, 1e-9, "the corner is where the pointer is");
      }
      const body = dragSketchHandle(project.sketch, "entity:b", { kind: "body" }, [26, 0], [30, 5]);
      assert(body.ok, "dragging the body of a side works");
    }
  },
  {
    name: "Constraint solver S2: a dimensioned rectangle drags by a corner without changing its dimensions",
    run: () => {
      const ring = lineRing();
      let project = projectWith(ring.entities, ring.constraints);
      project = setDimension(project, "b", "length", 52);
      project = setDimension(project, "r", "length", 30);
      const dragged = dragSketchHandle(project.sketch, "entity:b", { kind: "point", ref: "end" }, [52, 0], [60, 8]);
      assert(dragged.ok, `a dimensioned rectangle drags: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const moved = { ...project, sketch: { ...project.sketch, entities: dragged.entities } };
      near(lengthOf(get(moved, "b", "line")), 52, 1e-6, "the width dimension holds while dragging");
      near(lengthOf(get(moved, "r", "line")), 30, 1e-6, "and so does the height dimension");
      assert(ringIsClosedRectangle(moved), "and the rectangle stays whole");
    }
  },
  {
    name: "Constraint solver S3: the app's own polygon, slot, rounded rectangle and parallelogram can be resized and dragged",
    run: () => {
      // Hexagon: sides 10, 40, 200 (equal sides follow), then a vertex drag.
      const hexagon = buildPolygon([0, 0], [30, 0], 6, shapeIds("hex"));
      assert(hexagon.ok, "the hexagon builds");
      if (!hexagon.ok) return;
      let hex = projectWith(hexagon.value.entities, hexagon.value.constraints);
      const first = hexagon.value.entities[0]!.id.replace("entity:", "");
      for (const side of [10, 40, 200]) {
        hex = setDimension(hex, first, "length", side);
        for (const entity of hex.sketch.entities) near(lengthOf(entity as Line), side, 1e-6, `every side of the hexagon is ${side} after the edit`);
        const joined = hex.sketch.entities.every((entity, index, all) => {
          const next = all[(index + 1) % all.length] as Line;
          return Math.hypot((entity as Line).end[0] - next.start[0], (entity as Line).end[1] - next.start[1]) < 1e-6;
        });
        assert(joined, `the hexagon stays closed at side ${side}`);
      }
      const vertex = (hex.sketch.entities[2] as Line).start;
      const dragged = dragSketchHandle(hex.sketch, hex.sketch.entities[2]!.id, { kind: "point", ref: "start" }, vertex, [vertex[0] + 3, vertex[1] + 4]);
      assert(dragged.ok, `a hexagon vertex drags: ${dragged.ok ? "" : dragged.message}`);

      // Slot: the arc radius 5 to 12.
      const slotShape = buildSlot([0, 0], [40, 0], [0, 5], shapeIds("slot"));
      assert(slotShape.ok, "the slot builds");
      if (!slotShape.ok) return;
      const slotArc = slotShape.value.entities.find((entity) => entity.kind === "arc")!;
      const slot = setDimension(projectWith(slotShape.value.entities, slotShape.value.constraints), slotArc.id.replace("entity:", ""), "radius", 12);
      const radii = slot.sketch.entities.filter((entity) => entity.kind === "arc").map((entity) => (entity.kind === "arc" ? Math.hypot(entity.start[0] - entity.end[0], entity.start[1] - entity.end[1]) / 2 : 0));
      near(radii[0] ?? 0, radii[1] ?? 1, 1e-6, "both caps of the slot stay equal after the radius edit");

      // Rounded rectangle: corner radius 6 to 10.
      const rounded = buildRoundedRectangle([0, 0], [60, 40], 6, shapeIds("rr"));
      assert(rounded.ok, "the rounded rectangle builds");
      if (!rounded.ok) return;
      const corner = rounded.value.entities.find((entity) => entity.kind === "arc")!;
      const roundedProject = setDimension(projectWith(rounded.value.entities, rounded.value.constraints), corner.id.replace("entity:", ""), "radius", 10);
      const cornerArc = roundedProject.sketch.entities.find((entity) => entity.id === corner.id);
      assert(cornerArc?.kind === "arc", "the corner is still an arc");

      // Parallelogram: a side to 50, then a corner drag.
      const parallelogram = buildParallelogram([0, 0], [30, 0], [40, 20], shapeIds("pg"));
      assert(parallelogram.ok, "the parallelogram builds");
      if (!parallelogram.ok) return;
      let pg = projectWith(parallelogram.value.entities, parallelogram.value.constraints);
      pg = setDimension(pg, parallelogram.value.entities[0]!.id.replace("entity:", ""), "length", 50);
      near(lengthOf(pg.sketch.entities[0] as Line), 50, 1e-6, "the parallelogram side takes 50");
      near(lengthOf(pg.sketch.entities[2] as Line), 50, 1e-6, "and its opposite side follows (they stay parallel and equal in length)");
      const pgDrag = dragSketchHandle(pg.sketch, pg.sketch.entities[1]!.id, { kind: "point", ref: "end" }, (pg.sketch.entities[1] as Line).end, [70, 30]);
      assert(pgDrag.ok, `a parallelogram corner drags: ${pgDrag.ok ? "" : pgDrag.message}`);
    }
  },
  {
    name: "Constraint solver S4: a circle between two tangent lines can be resized, and the lines give way",
    run: () => {
      let project = projectWith([line("a", [-30, 10], [30, 10]), line("b", [-30, -10], [30, -10]), circle("c", [0, 0], 10)]);
      project = addConstraint(project, rel("tangent", ["a", "c"]));
      project = addConstraint(project, rel("tangent", ["b", "c"]));
      for (const radius of [25, 6]) {
        const resized = setDimension(project, "c", "radius", radius);
        const a = get(resized, "a", "line");
        const b = get(resized, "b", "line");
        const c = get(resized, "c", "circle");
        near(c.radiusMm, radius, 1e-9, `the radius is ${radius}`);
        near(Math.abs(a.start[1] - c.center[1]), radius, 1e-6, "the upper line still touches the circle");
        near(Math.abs(b.start[1] - c.center[1]), radius, 1e-6, "and so does the lower one");
      }
      // Adding the second tangent to a circle that already touches one line: the circle (free radius) and its centre find a place between them.
      let wedge = projectWith([circle("c", [0, 0], 5), line("a", [-20, 5], [20, 5]), line("b", [-20, -20], [20, 20])]);
      wedge = addConstraint(wedge, rel("tangent", ["a", "c"]));
      const result = (() => {
        try { return run(wedge, { kind: "add-sketch-constraint", constraint: rel("tangent", ["b", "c"]) }); } catch (error) { return error as Error; }
      })();
      if (result instanceof Error) {
        assert(/Tangent/.test(result.message), `if it cannot be done the conflict names the tangents: ${result.message}`);
      } else {
        const c = get(result, "c", "circle");
        const distance = (l: Line): number => Math.abs((l.end[0] - l.start[0]) * (c.center[1] - l.start[1]) - (l.end[1] - l.start[1]) * (c.center[0] - l.start[0])) / lengthOf(l);
        near(distance(get(result, "a", "line")), c.radiusMm, 1e-6, "tangent to the first line");
        near(distance(get(result, "b", "line")), c.radiusMm, 1e-6, "and to the second");
      }
    }
  },
  {
    name: "Constraint solver S5: lengthening a joined line slides its neighbour instead of folding it back over itself",
    run: () => {
      for (const length of [25, 40, 20]) {
        let project = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 0])]);
        project = addConstraint(project, rel("coincident", ["a", "b"], { points: ["end", "start"] }));
        project = addConstraint(project, rel("horizontal", ["a"]));
        project = addConstraint(project, rel("horizontal", ["b"]));
        project = setDimension(project, "b", "length", 10);
        project = setDimension(project, "a", "length", length);
        const a = get(project, "a", "line");
        const b = get(project, "b", "line");
        near(a.end[0], length, 1e-9, `a ends at ${length}`);
        near(b.start[0], length, 1e-9, "b starts where a ends");
        near(b.end[0], length + 10, 1e-9, `b slides to end at ${length + 10}: it runs the same way as before, not folded back`);
      }
      // A chain of three lines of 10: the first set to 25.
      let chain = projectWith([line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [20, 0]), line("s2", [20, 0], [30, 0])]);
      for (const name of ["s0", "s1", "s2"]) chain = addConstraint(chain, rel("horizontal", [name]));
      chain = addConstraint(chain, rel("coincident", ["s0", "s1"], { points: ["end", "start"] }));
      chain = addConstraint(chain, rel("coincident", ["s1", "s2"], { points: ["end", "start"] }));
      for (const name of ["s1", "s2"]) chain = setDimension(chain, name, "length", 10);
      chain = setDimension(chain, "s0", "length", 25);
      near(get(chain, "s1", "line").start[0], 25, 1e-9, "the second line starts at 25");
      near(get(chain, "s1", "line").end[0], 35, 1e-9, "and ends at 35, not 15");
      near(get(chain, "s2", "line").end[0], 45, 1e-9, "the third follows to 45");
    }
  },
  {
    name: "Constraint solver S6: chains of 3 to 50 dimensioned lines can be edited, in either constraint order",
    run: () => {
      for (const count of [3, 6, 9, 10, 12, 20, 50]) {
        for (const reversed of [false, true]) {
          const lines: ReturnType<typeof line>[] = [];
          const constraints: ReturnType<typeof rel>[] = [];
          for (let i = 0; i < count; i += 1) {
            lines.push(line(`c${i}`, [i * 10, 0], [(i + 1) * 10, 0]));
            constraints.push(rel("horizontal", [`c${i}`]), lengthDim(`c${i}`, 10));
            if (i > 0) constraints.push(rel("coincident", [`c${i - 1}`, `c${i}`], { points: ["end", "start"] }));
          }
          const project = projectWith(lines, reversed ? [...constraints].reverse() : constraints);
          const edited = setDimension(project, "c0", "length", 25);
          const last = get(edited, `c${count - 1}`, "line");
          near(last.start[0], (count - 1) * 10 + 15, 1e-6, `the last of ${count} lines shifted by 15 (${reversed ? "reversed" : "forward"})`);
          near(lengthOf(last), 10, 1e-6, "and kept its length");
        }
      }
      // A 64-gon with equal sides, side to 50.
      const gon = buildPolygon([0, 0], [800, 0], 64, shapeIds("gon"));
      assert(gon.ok, "the 64-gon builds");
      if (!gon.ok) return;
      const edited = setDimension(projectWith(gon.value.entities, gon.value.constraints), gon.value.entities[0]!.id.replace("entity:", ""), "length", 50);
      near(lengthOf(edited.sketch.entities[37] as Line), 50, 1e-5, "every side of the 64-gon follows the edit");
    }
  },
  {
    name: "Constraint solver S7: either entity of an equal or symmetric pair can be edited, and a rectangle with equal sides resizes",
    run: () => {
      const equal2 = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])], [rel("equal", ["a", "b"])]);
      for (const name of ["a", "b"]) {
        const edited = setDimension(equal2, name, "length", 30);
        near(lengthOf(get(edited, "a", "line")), 30, 1e-9, `editing ${name}: line a is 30`);
        near(lengthOf(get(edited, "b", "line")), 30, 1e-9, `editing ${name}: line b is 30`);
      }
      const mirror = projectWith([line("a", [3, 1], [8, 4]), line("b", [-3, 1], [-8, 4]), line("axis", [0, -10], [0, 10])], [rel("symmetry", ["a", "b", "axis"])]);
      for (const name of ["a", "b"]) {
        const edited = setDimension(mirror, name, "length", 30);
        near(lengthOf(get(edited, "a", "line")), 30, 1e-9, `editing ${name}: line a is 30`);
        near(lengthOf(get(edited, "b", "line")), 30, 1e-9, `editing ${name}: its mirror image follows`);
      }
      const ring = lineRing();
      const edited = setDimension(projectWith(ring.entities, [...ring.constraints, rel("equal", ["b", "t"])]), "b", "length", 200);
      assert(ringIsClosedRectangle(edited), "a rectangle with Equal top and bottom widens and stays a rectangle");
      near(lengthOf(get(edited, "t", "line")), 200, 1e-6, "the top follows the bottom");
    }
  },
  {
    name: "Constraint solver S8: changing one side's length translates the perpendicular arm instead of stretching it",
    run: () => {
      let project = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])]);
      project = addConstraint(project, rel("coincident", ["a", "b"], { points: ["end", "start"] }));
      project = addConstraint(project, rel("perpendicular", ["a", "b"]));
      project = setDimension(project, "a", "length", 30);
      const b = get(project, "b", "line");
      near(b.start[0], 30, 1e-9, "the arm starts at the new end of a (x)");
      near(b.start[1], 0, 1e-9, "(y)");
      near(b.end[0], 30, 1e-9, "the arm stays vertical");
      near(lengthOf(b), 10, 1e-9, "and is still 10 long: it was moved, not stretched");
    }
  },
  {
    name: "Constraint solver S9 and sketch environment E08: conflicts name the relations that contradict each other",
    run: () => {
      let equalPair = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 7])]);
      equalPair = addConstraint(equalPair, rel("equal", ["a", "b"]));
      equalPair = setDimension(equalPair, "a", "length", 20);
      const equalMessage = refuseDimension(equalPair, "b", "length", 30);
      assert(/Length 20 on Line 1/.test(equalMessage) && /Length 30 on Line 2/.test(equalMessage) && /Equal between Line 1 and Line 2/.test(equalMessage), `names both dimensions and the Equal: ${equalMessage}`);
      assert(!/passes|cyclic|nonlinear/i.test(equalMessage), "and uses no solver jargon");

      const parallelPair = addConstraint(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 7])]), rel("parallel", ["a", "b"]));
      const perpendicularMessage = refuse(parallelPair, { kind: "add-sketch-constraint", constraint: rel("perpendicular", ["a", "b"]) });
      assert(/Parallel between Line 1 and Line 2/.test(perpendicularMessage) && /Perpendicular between Line 1 and Line 2/.test(perpendicularMessage), `names Parallel and Perpendicular: ${perpendicularMessage}`);

      const squareCorner = addConstraint(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10])]), rel("perpendicular", ["a", "b"]));
      const angleMessage = refuseDimension(squareCorner, "a", "angle", 60, { second: "b" });
      assert(/Perpendicular between Line 1 and Line 2/.test(angleMessage) && /Angle 60° between Line 1 and Line 2/.test(angleMessage), `names the angle and the Perpendicular: ${angleMessage}`);

      const level = addConstraint(projectWith([line("a", [0, 0], [10, 3])]), rel("horizontal", ["a"]));
      const plumbMessage = refuse(level, { kind: "add-sketch-constraint", constraint: rel("vertical", ["a"]) });
      assert(/Horizontal on Line 1/.test(plumbMessage) && /Vertical on Line 1/.test(plumbMessage), `names Horizontal and Vertical: ${plumbMessage}`);

      let twins = projectWith([circle("a", [0, 0], 5), circle("b", [20, 0], 8)]);
      twins = addConstraint(twins, rel("equal", ["a", "b"]));
      twins = setDimension(twins, "a", "radius", 6);
      const radiusMessage = refuseDimension(twins, "b", "radius", 9);
      assert(/Radius 6 on Circle 1/.test(radiusMessage) && /Radius 9 on Circle 2/.test(radiusMessage) && /Equal between Circle 1 and Circle 2/.test(radiusMessage), `names both radii and the Equal: ${radiusMessage}`);

      const refusal = apply(equalPair, { kind: "set-sketch-dimension", entityId: "entity:b", dimension: "length", valueMm: 30 });
      assert(!refusal.ok, "the conflicting dimension is refused");
      const related = refusal.ok ? [] : refusal.diagnostics[0]?.relatedIds ?? [];
      assert(related.filter((id) => id.startsWith("constraint:")).length >= 3, `the diagnostic lists the constraint IDs, not a document ID: ${related.join(", ")}`);
      equal(refusal.ok ? "" : refusal.diagnostics[0]?.code, "CONSTRAINT_CONFLICT", "and is typed as a conflict");
    }
  },
  {
    name: "Constraint solver S9: a stored conflict is reported in the analysis with the names of the relations",
    run: () => {
      const stored = projectWith([line("a", [0, 0], [20, 0]), line("b", [0, 5], [30, 5])], [
        rel("equal", ["a", "b"]),
        { id: "constraint:sim-stored-a", kind: "distance", dimension: "length", entityIds: ["entity:a"], valueMm: 20 },
        { id: "constraint:sim-stored-b", kind: "distance", dimension: "length", entityIds: ["entity:b"], valueMm: 30 }
      ]);
      const result = analysis(stored);
      equal(result.classification, "conflict", "the analysis calls it a conflict");
      equal(result.conflictSets.length, 1, "one set of contradicting relations");
      assert(result.conflictSets[0]!.labels.some((label) => /Length 20 on Line 1/.test(label)) && result.conflictSets[0]!.labels.some((label) => /Length 30 on Line 2/.test(label)), "the set names both lengths");
      assert(result.conflicts.some((message) => /contradict/.test(message)), "and the conflicts list says so in plain words");
    }
  }
];
