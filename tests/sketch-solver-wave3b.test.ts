import { dragLiveSketch, solveLiveSketch } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { repairAll, validateSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { readFileSync } from "node:fs";
import { dragSketchHandle, grabHandlesOf } from "../packages/workbench-sketch/src/drag.js";
import { buildCurveTool, DEFAULT_CURVE_TOOL_OPTIONS } from "../packages/workbench-sketch/src/curve-tools.js";
import { buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { addConstraint, analysis, apply, arc, circle, get, lengthOf, line, projectWith, rect, refuse, rel, run, setDimension, type Arc, type Line, type Vec } from "./sketch-solver-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

/**
 * Wave 3 regression tests, second part (second re-audit: Curve creation tools F2 and F3, Constraint solver R2-8 and R2-10, Sketch
 * environment R2-6). Same rule as the first part: the re-audit repro through the real code path, then the outcome the audit asked for.
 */

function circleOf(a: Arc): { readonly c: Vec; readonly r: number } {
  const [ax, ay] = a.start;
  const [bx, by] = a.mid;
  const [cx, cy] = a.end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

/** The angle in degrees between the two radii at the point where arc `a` ends and arc `b` starts: 0 (or 180) when the joint is tangent. */
function jointKinkDeg(project: WorkbenchProject): number {
  const a = get(project, "ar", "arc");
  const b = get(project, "sim1", "arc");
  const first = circleOf(a);
  const second = circleOf(b);
  const p = a.end;
  const u: Vec = [(p[0] - first.c[0]) / first.r, (p[1] - first.c[1]) / first.r];
  const v: Vec = [(p[0] - second.c[0]) / second.r, (p[1] - second.c[1]) / second.r];
  const sin = Math.abs(u[0] * v[1] - u[1] * v[0]);
  return (Math.asin(Math.min(1, sin)) * 180) / Math.PI;
}

/** Arc (50,0)-(60,10)-(70,0) and the arc the Arc-tangent tool draws from its end to (90,-30): relations coincident and tangent. */
function tangentArcs(): WorkbenchProject {
  const centre: Vec = [102.5, 0];
  const radius = 32.5;
  const endAngle = (Math.atan2(-30, 90 - centre[0]) * 180) / Math.PI + 360;
  const midAngle = (180 + endAngle) / 2;
  const rad = (degrees: number): number => (degrees * Math.PI) / 180;
  const second = arc("sim1", [70, 0], [centre[0] + radius * Math.cos(rad(midAngle)), centre[1] + radius * Math.sin(rad(midAngle))], [90, -30]);
  return projectWith(
    [arc("ar", [50, 0], [60, 10], [70, 0]), second],
    [rel("coincident", ["ar", "sim1"], { points: ["end", "start"] }), rel("tangent", ["ar", "sim1"])]
  );
}

export const sketchSolverWave3bTests: readonly TestCase[] = [
  {
    name: "Wave3 F2: a tangent arc started on an arc end is not redundant: no over-defined warning, Fix all keeps the Tangent, and a drag keeps the joint tangent (was a 12.3 degree kink after Fix all deleted it)",
    run: () => {
      const project = tangentArcs();
      near(jointKinkDeg(project), 0, 0.01, "the drawn joint is tangent to begin with");
      const analysis = analyzeWorkbenchSketch(project.sketch);
      assert(analysis.redundant.length === 0, `the analysis finds nothing redundant: ${analysis.redundant.map((entry) => entry.labels.join(" ; ")).join(" | ")}`);
      const context = { sketch: project.sketch, newId: (prefix: string) => `${prefix}:g1` };
      const report = validateSketch(context);
      assert(!report.issues.some((issue) => issue.category === "redundant"), `Validate Sketch raises no Over-defined issue: ${report.issues.map((issue) => issue.title).join(" | ")}`);
      const repaired = repairAll(context);
      assert(repaired.sketch.constraints.some((constraint) => constraint.kind === "tangent"), "Fix all keeps the Tangent");
      const arcOne = repaired.sketch.entities[0]!;
      assert(arcOne.kind === "arc", "the first entity is the arc");
      if (arcOne.kind !== "arc") return;
      const dragged = dragLiveSketch(repaired.sketch, { entityId: arcOne.id, point: "mid", positionMm: [arcOne.mid[0] + 4, arcOne.mid[1] + 6] });
      assert(dragged.ok, `the drag is accepted: ${dragged.ok ? "" : dragged.message}`);
      if (!dragged.ok) return;
      const after = { ...project, sketch: { ...repaired.sketch, entities: dragged.entities } };
      near(jointKinkDeg(after), 0, 0.01, "the joint is still tangent after the drag");
      const gap = Math.hypot(get(after, "ar", "arc").end[0] - get(after, "sim1", "arc").start[0], get(after, "ar", "arc").end[1] - get(after, "sim1", "arc").start[1]);
      near(gap, 0, 1e-6, "and still joined");
    }
  },
  {
    name: "Wave3 F2: a chain of three tangent arcs, and a tangent added later with the coincident already there, are not redundant either",
    run: () => {
      const base = tangentArcs();
      const third = arc("sim2", [90, -30], [100, -45], [120, -50]);
      const chain = projectWith([...base.sketch.entities, third], [...base.sketch.constraints, rel("coincident", ["sim1", "sim2"], { points: ["end", "start"] })]);
      const withTangent = addConstraint(chain, rel("tangent", ["sim1", "sim2"]));
      const analysis = analyzeWorkbenchSketch(withTangent.sketch);
      assert(analysis.redundant.length === 0, `no redundancy in a three-arc chain: ${analysis.redundant.map((entry) => entry.labels.join(" ; ")).join(" | ")}`);
      const bare = projectWith(base.sketch.entities, [rel("coincident", ["ar", "sim1"], { points: ["end", "start"] })]);
      const added = addConstraint(bare, rel("tangent", ["ar", "sim1"]));
      assert(analyzeWorkbenchSketch(added.sketch).redundant.length === 0, "adding the Tangent to joined arcs is not redundant");
      near(jointKinkDeg({ ...added, sketch: added.sketch }), 0, 0.01, "and makes the joint tangent");
      // A tangent that really is redundant (stated twice) is still found.
      const twice = projectWith(base.sketch.entities, [...base.sketch.constraints, rel("tangent", ["ar", "sim1"])]);
      assert(analyzeWorkbenchSketch(twice.sketch).redundant.length > 0, "a Tangent stated twice is still redundant");
    }
  },
  {
    name: "Wave3 F3: contradictory opposite-side lengths on a parallelogram, a rounded rectangle and a slot are refused as a named conflict (they collapsed the parallelogram flat, crossed the rounded rectangle and turned the slot into a cusped lens)",
    run: () => {
      let counter = 0;
      const ids = { entity: () => `entity:q${++counter}`, constraint: () => `constraint:q${++counter}` };
      const make = (entities: readonly SketchEntityLike[], constraints: readonly ConstraintLike[]): WorkbenchProject => projectWith(entities as never, constraints as never);
      const lengthOfLineAt = (project: WorkbenchProject, index: number): string => project.sketch.entities.filter((entity) => entity.kind === "line")[index]!.id;
      const setLength = (project: WorkbenchProject, index: number, valueMm: number) => ({ kind: "set-sketch-dimension" as const, entityId: lengthOfLineAt(project, index), dimension: "length" as const, valueMm });

      const parallelogram = buildCurveTool("parallelogram", [[0, 0], [20, 0], [28, 10]], DEFAULT_CURVE_TOOL_OPTIONS, ids);
      assert(parallelogram.ok, "the parallelogram builds");
      if (!parallelogram.ok) return;
      let project = make(parallelogram.value.entities, parallelogram.value.constraints);
      project = run(project, setLength(project, 0, 12));
      const flat = refuse(project, setLength(project, 2, 7));
      assert(/Length 7 on Line 3/u.test(flat) && /flat/u.test(flat) && /Length 12 on Line 1/u.test(flat) && /Parallel/u.test(flat) && !/entity:/u.test(flat), `parallelogram: the refusal names the dimensions and the fold: ${flat}`);
      project = run(project, setLength(project, 2, 12));
      near(lengthOf(get(project, project.sketch.entities[2]!.id.slice(7), "line")), 12, 1e-6, "an equal opposite side is still accepted");

      const rounded = buildCurveTool("rectangle-rounded", [[0, 0], [50, 30]], { ...DEFAULT_CURVE_TOOL_OPTIONS, cornerRadiusMm: 6 }, ids);
      assert(rounded.ok, "the rounded rectangle builds");
      if (!rounded.ok) return;
      project = make(rounded.value.entities, rounded.value.constraints);
      project = run(project, setLength(project, 3, 14.21));
      project = run(project, setLength(project, 2, 36.56));
      const crossing = refuse(project, setLength(project, 0, 48.02));
      assert(/Length 48\.02 on Line 1/u.test(crossing) && /cross itself/u.test(crossing) && /Length 36\.56 on Line 3/u.test(crossing), `rounded rectangle: ${crossing}`);

      const slot = buildSlot([0, 0], [20, 0], [10, 3], ids);
      assert(slot.ok, "the slot builds");
      if (!slot.ok) return;
      project = make(slot.value.entities, slot.value.constraints);
      project = run(project, setLength(project, 0, 30));
      const lens = refuse(project, setLength(project, 1, 12));
      assert(/Length 12 on Line 2/u.test(lens) && /double back/u.test(lens) && /Length 30 on Line 1/u.test(lens), `slot: ${lens}`);
      project = run(project, setLength(project, 1, 30));
      // The same through add-sketch-constraint.
      const viaConstraint = apply(make(slot.value.entities, slot.value.constraints), { kind: "add-sketch-constraint", constraint: { id: "constraint:lens-a", kind: "distance", dimension: "length", entityIds: [lengthOfLineAt(project, 0)], valueMm: 30 } });
      assert(viaConstraint.ok, `a first length is accepted through add-sketch-constraint: ${viaConstraint.ok ? "" : viaConstraint.diagnostics[0]?.message}`);
      if (!viaConstraint.ok) return;
      const second = apply(viaConstraint.value.project, { kind: "add-sketch-constraint", constraint: { id: "constraint:lens-b", kind: "distance", dimension: "length", entityIds: [lengthOfLineAt(project, 1)], valueMm: 12 } });
      assert(!second.ok && /Length 12 on Line 2/u.test(second.ok ? "" : second.diagnostics[0]?.message ?? "") && /Length 30 on Line 1/u.test(second.ok ? "" : second.diagnostics[0]?.message ?? ""), `and the second contradictory length is refused there too: ${second.ok ? "accepted" : second.diagnostics[0]?.message}`);
    }
  },
  {
    name: "Wave3 R2-8: a rectangle pinned at a corner or its centre stays exactly axis aligned through 200 mixed drags and dimension edits (was up to 0.0069 degrees of residual turn, and one drag left 0.00019)",
    run: () => {
      let seed = 3;
      const random = (): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      for (const [label, centre, pin] of [["corner-0 on the origin", [50, 30], "corner-0"], ["centre on the origin", [0, 0], "center"]] as const) {
        let project = projectWith([rect("r", centre, 100, 60)], [rel("coincident", ["r", "sketch:origin"], { points: [pin, "self"] })]);
        for (let step = 0; step < 200; step += 1) {
          const entity = get(project, "r", "rectangle");
          const operation = Math.floor(random() * 3);
          if (operation < 2) {
            const result = apply(project, { kind: "set-sketch-dimension", entityId: entity.id, dimension: operation === 0 ? "width" : "height", valueMm: 20 + random() * 150 });
            if (result.ok) project = result.value.project;
          } else {
            const handles = grabHandlesOf(entity);
            const handle = handles[Math.floor(random() * handles.length)]!;
            const dragged = dragSketchHandle(project.sketch, entity.id, handle.handle, handle.point, [handle.point[0] + (random() - 0.5) * 80, handle.point[1] + (random() - 0.5) * 80]);
            if (dragged.ok) project = { ...project, sketch: { ...project.sketch, entities: dragged.entities } };
          }
          assert(Math.abs(get(project, "r", "rectangle").rotationDeg) === 0, `${label}: step ${step} leaves the rectangle exactly axis aligned, not ${get(project, "r", "rectangle").rotationDeg} degrees`);
        }
      }
      // A rectangle that is turned on purpose, or has a Horizontal of its own, keeps working as before.
      const turned = projectWith([rect("r", [50, 30], 100, 60, 30)], [rel("coincident", ["r", "sketch:origin"], { points: ["corner-0", "self"] })]);
      near(get(run(turned, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 80 }), "r", "rectangle").rotationDeg, 30, 1e-6, "a 30 degree rectangle keeps its turn");
    }
  },
  {
    name: "Wave3 UX R2-6: a Rectangle-tool rectangle with its corner on the origin, a width and a height reads fully constrained (DOF 0); a free rectangle keeps its five degrees of freedom and an explicit Horizontal still works",
    run: () => {
      const free = projectWith([rect("r", [40, 25], 80, 50)], []);
      assert(analysis(free).degreesOfFreedom === 5, `a free rectangle has 5 degrees of freedom, not ${analysis(free).degreesOfFreedom}`);
      let project = addConstraint(free, rel("coincident", ["r", "sketch:origin"], { points: ["corner-0", "self"] }));
      project = setDimension(project, "r", "width", 80);
      project = setDimension(project, "r", "height", 50);
      const result = analysis(project);
      assert(result.degreesOfFreedom === 0 && result.classification === "fully-constrained", `corner + width + height is fully constrained: DOF ${result.degreesOfFreedom}, ${result.classification}`);
      assert(result.redundant.length === 0 && result.conflicts.length === 0, "and nothing is redundant or in conflict");
      // The same with the centre on the origin.
      let centred = addConstraint(projectWith([rect("r", [0, 0], 80, 50)], []), rel("coincident", ["r", "sketch:origin"], { points: ["center", "self"] }));
      centred = setDimension(setDimension(centred, "r", "width", 80), "r", "height", 50);
      assert(analysis(centred).degreesOfFreedom === 0, "centre + width + height is fully constrained too");
      // An explicit Horizontal on the rectangle replaces the default hold: it is not redundant.
      const explicit = addConstraint(project, rel("horizontal", ["r"]));
      assert(analysis(explicit).redundant.length === 0 && analysis(explicit).degreesOfFreedom === 0, "an explicit Horizontal is accepted without a redundancy warning");
      // A rectangle pinned at two corners is not held: its turn follows the pins.
      const twoPins = addConstraint(addConstraint(free, rel("coincident", ["r", "sketch:origin"], { points: ["corner-0", "self"] })), rel("coincident", ["r", "sketch:axis-y"], { points: ["corner-3", "curve"] }));
      assert(analysis(twoPins).degreesOfFreedom >= 2, "two pins do not pretend to fix the turn");
    }
  },
  {
    name: "Wave3 R2-10: adding the same relations in another order always gives geometry that satisfies them all, with the same degrees of freedom, deterministically and stable under a re-solve (the notes no longer claim identical coordinates)",
    run: () => {
      let seed = 5;
      const random = (): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const shuffle = <T,>(list: readonly T[]): T[] => {
        const out = [...list];
        for (let index = out.length - 1; index > 0; index -= 1) {
          const other = Math.floor(random() * (index + 1));
          [out[index], out[other]] = [out[other]!, out[index]!];
        }
        return out;
      };
      const join = (a: string, b: string) => rel("coincident", [a, b], { points: ["end", "start"] });
      const cases: readonly { readonly name: string; readonly entities: readonly ReturnType<typeof line>[]; readonly relations: readonly ReturnType<typeof rel>[] }[] = [
        { name: "triangle", entities: [line("a", [0, 0], [10, 1]), line("b", [10, 1], [6, 9]), line("c", [6, 9], [0.5, 0.2])], relations: [join("a", "b"), join("b", "c"), join("c", "a"), rel("horizontal", ["a"]), rel("equal", ["a", "b"])] },
        { name: "perpendicular and parallel quad", entities: [line("a", [0, 0], [20, 1]), line("b", [20, 1], [19, 12]), line("c", [19, 12], [1, 11]), line("d", [1, 11], [0.2, 0.1])], relations: [join("a", "b"), join("b", "c"), join("c", "d"), join("d", "a"), rel("perpendicular", ["a", "b"]), rel("parallel", ["a", "c"]), rel("equal", ["a", "c"])] }
      ];
      for (const entry of cases) {
        const dofs = new Set<number>();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const order = shuffle(entry.relations);
          const build = (): WorkbenchProject => order.reduce((project, relation) => addConstraint(project, relation), projectWith(entry.entities, []));
          const first = build();
          assert(JSON.stringify(first.sketch.entities) === JSON.stringify(build().sketch.entities), `${entry.name}: the same order twice gives exactly the same geometry`);
          const result = analysis(first);
          assert(result.conflicts.length === 0, `${entry.name}: every order satisfies the relations (no conflicts)`);
          dofs.add(result.degreesOfFreedom);
          const again = solveLiveSketch(first.sketch);
          assert(again.ok, `${entry.name}: a re-solve is accepted`);
          if (!again.ok) continue;
          const drift = Math.max(...again.entities.map((e, index) => {
            const before = first.sketch.entities[index]!;
            return e.kind === "line" && before.kind === "line" ? Math.max(Math.abs(e.start[0] - before.start[0]), Math.abs(e.start[1] - before.start[1]), Math.abs(e.end[0] - before.end[0]), Math.abs(e.end[1] - before.end[1])) : 0;
          }));
          assert(drift < 1e-6, `${entry.name}: solving the result again moves nothing (${drift})`);
        }
        assert(dofs.size === 1, `${entry.name}: every order has the same degrees of freedom (${[...dofs].join(", ")})`);
      }
      const notes = readFileSync("docs/SKETCH_SOLVER_NOTES.md", "utf8");
      assert(!/adding the same relations in another order gives the same geometry\./u.test(notes), "the notes do not claim identical geometry for another order");
      assert(/another order gives geometry that satisfies all of them/u.test(notes), "the notes state what is guaranteed");
    }
  },
  {
    name: "Wave3 R2-1: the 250-circle chain with tangent lines (500 curves, 999 relations) edits in under 5 s and drags in under 3 s, and the notes publish the measured numbers (was 12 s and 9.5 s)",
    run: () => {
      const entities: SketchEntityLike[] = [];
      const constraints: ConstraintLike[] = [];
      for (let index = 0; index < 250; index += 1) {
        entities.push(circle(`c${index}`, [index * 20, 0], 10), line(`g${index}`, [index * 20 - 10, -10], [index * 20 + 10, -10]));
        if (index > 0) constraints.push(rel("tangent", [`c${index - 1}`, `c${index}`]));
        constraints.push(rel("tangent", [`g${index}`, `c${index}`]), rel("horizontal", [`g${index}`]));
      }
      constraints.push({ id: "constraint:r0", kind: "radius", entityIds: ["entity:c0"], valueMm: 10, dimension: "radius" });
      for (let index = 1; index < 250; index += 1) constraints.push(rel("equal", ["c0", `c${index}`]));
      const project = projectWith(entities as never, constraints as never);
      const started = performance.now();
      const edited = apply(project, { kind: "set-sketch-dimension", entityId: "entity:c0", dimension: "radius", valueMm: 14 });
      const editMs = performance.now() - started;
      assert(edited.ok, `the edit is accepted: ${edited.ok ? "" : edited.diagnostics[0]?.message}`);
      assert(editMs < 5000, `the edit took ${editMs.toFixed(0)} ms (bound 5000 ms; about 0.5 s measured, the released build needed 12 s)`);
      const dragStarted = performance.now();
      const dragged = dragLiveSketch(project.sketch, { entityId: "entity:c125", point: "center", positionMm: [2500, 15] });
      const dragMs = performance.now() - dragStarted;
      assert(dragged.ok, "the drag is accepted");
      assert(dragMs < 3000, `the drag took ${dragMs.toFixed(0)} ms (bound 3000 ms; about 0.15 s measured, the released build needed 9.5 s)`);
      const notes = readFileSync("docs/SKETCH_SOLVER_NOTES.md", "utf8");
      assert(/250 of them \(500 curves, 999 relations\)/u.test(notes) && !/500 entities with 1000 constraints solve in about 0\.1 s/u.test(notes), "the notes carry the measured table, not the old 0.1 s claim");
    }
  },
  {
    name: "Wave3 R2-11: the same-curve-twice message reads 'A collinear', 'An equal', 'A parallel' and names no raw id",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])], []);
      for (const [kind, article] of [["collinear", "A"], ["equal", "An"], ["parallel", "A"], ["perpendicular", "A"]] as const) {
        const message = refuse(project, { kind: "add-sketch-constraint", constraint: rel(kind, ["a", "a"]) });
        assert(message.startsWith(`${article} ${kind} constraint relates two different curves`), `${kind}: "${message}"`);
        assert(!/entity:/u.test(message), `${kind}: the message names no raw id`);
      }
    }
  }
];

type SketchEntityLike = unknown;
type ConstraintLike = unknown;
void ([] as readonly Line[]);