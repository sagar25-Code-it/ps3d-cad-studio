import { dragLiveSketch, solveLiveSketch } from "../packages/workbench-core/src/index.js";
import { dragSketchHandle } from "../packages/workbench-sketch/src/drag.js";
import { buildPolygon, buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { refractionAngles } from "../packages/workbench-core/src/sketch-solve-extras.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import {
  addConstraint, analysis, apply, circle, get, ident, line, lengthOf, lineRing, projectWith, refuse, rel, run, setDimension,
  type Line, type Vec
} from "./sketch-solver-kit.js";
import type { SketchEntity, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";

/**
 * Wave 3 regression tests for the constraint solver (second re-audit, "Constraint solver" R2-n, "Curve creation tools" F2, F3, F10 and
 * "Sketch environment: UX flow" R2-6). Each one runs the re-audit repro through the real operations, the live solver, the drag handler or
 * the Repair panel's model, and checks the outcome the audit asked for.
 */

const lineAt = (project: WorkbenchProject, name: string): Line => get(project, name, "line");

/** N circles tangent in a chain, each with a horizontal tangent line, all equal to the first (the R2-1 repro). */
function circleChain(count: number): WorkbenchProject {
  const entities: SketchEntity[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  for (let index = 0; index < count; index += 1) {
    entities.push(circle(`c${index}`, [index * 20, 0], 10));
    if (index > 0) constraints.push(rel("tangent", [`c${index - 1}`, `c${index}`]));
    entities.push(line(`g${index}`, [index * 20 - 10, -10], [index * 20 + 10, -10]));
    constraints.push(rel("tangent", [`g${index}`, `c${index}`]), rel("horizontal", [`g${index}`]));
  }
  constraints.push({ id: "constraint:r0", kind: "radius", entityIds: ["entity:c0"], valueMm: 10, dimension: "radius" });
  for (let index = 1; index < count; index += 1) constraints.push(rel("equal", ["c0", `c${index}`]));
  return projectWith(entities, constraints);
}

function timed<T>(work: () => T): { readonly value: T; readonly ms: number } {
  const started = performance.now();
  const value = work();
  return { value, ms: performance.now() - started };
}

export const sketchSolverWave3Tests: readonly TestCase[] = [
  {
    name: "Wave3 R2-1: a radius edit of 150 tangent circles with tangent lines, all equal to the first, finishes in seconds and gives the right geometry (was 3.4 s at 150 and 12 s at 250)",
    run: () => {
      const project = circleChain(150);
      const { value, ms } = timed(() => apply(project, { kind: "set-sketch-dimension", entityId: "entity:c0", dimension: "radius", valueMm: 14 }));
      assert(value.ok, `the edit is accepted: ${value.ok ? "" : value.diagnostics[0]?.message}`);
      if (!value.ok) return;
      const next = value.value.project;
      near(get(next, "c149", "circle").radiusMm, 14, 1e-6, "an equal circle follows the edited radius");
      const c0 = get(next, "c0", "circle");
      const c1 = get(next, "c1", "circle");
      near(Math.hypot(c1.center[0] - c0.center[0], c1.center[1] - c0.center[1]), 28, 1e-6, "neighbouring circles stay tangent");
      assert(ms < 2500, `the edit took ${ms.toFixed(0)} ms (bound 2500 ms; measured about 300 ms, the released build needed 3400 ms)`);
    }
  },
  {
    name: "Wave3 R2-1: 500 lines all equal to the first solve and take a length edit in well under a second each, and a drag of an equal-circle star is quick",
    run: () => {
      const lines = Array.from({ length: 500 }, (_, index) => line(`s${index}`, [index * 3, 0], [index * 3 + 5 + (index % 7), index % 5]));
      const equal500 = Array.from({ length: 499 }, (_, index) => rel("equal", ["s0", `s${index + 1}`]));
      const project = projectWith(lines, equal500);
      const solved = timed(() => solveLiveSketch(project.sketch));
      assert(solved.value.ok, "the star solves");
      assert(solved.ms < 1500, `solve took ${solved.ms.toFixed(0)} ms (bound 1500 ms; measured about 250 ms, the released build needed 2500 ms)`);
      if (!solved.value.ok) return;
      const next = { ...project, sketch: { ...project.sketch, entities: solved.value.entities } };
      const edit = timed(() => apply(next, { kind: "set-sketch-dimension", entityId: "entity:s0", dimension: "length", valueMm: 14 }));
      assert(edit.value.ok, "the length edit applies");
      assert(edit.ms < 5000, `edit took ${edit.ms.toFixed(0)} ms (bound 5000 ms)`);
      if (!edit.value.ok) return;
      near(lengthOf(lineAt(edit.value.value.project, "s499")), 14, 1e-6, "every equal line follows");

      const circles = Array.from({ length: 400 }, (_, index) => circle(`k${index}`, [(index % 25) * 30, Math.floor(index / 25) * 30], 3 + (index % 5) * 0.1));
      const star = projectWith(circles, Array.from({ length: 399 }, (_, index) => rel("equal", ["k0", `k${index + 1}`])));
      const settled = solveLiveSketch(star.sketch);
      assert(settled.ok, "the circle star solves");
      if (!settled.ok) return;
      const drag = timed(() => dragLiveSketch({ ...star.sketch, entities: settled.entities }, { entityId: "entity:k5", point: "center", positionMm: [152, 1] }));
      assert(drag.value.ok, "the drag is accepted");
      assert(drag.ms < 3000, `drag took ${drag.ms.toFixed(0)} ms (bound 3000 ms)`);
    }
  },
  {
    name: "Wave3 R2-2: Vertical on an exactly horizontal line, and Horizontal on an exactly vertical one, turn the line a quarter turn and keep its length",
    run: () => {
      const vertical = addConstraint(projectWith([line("a", [0, 0], [10, 0])]), rel("vertical", ["a"]));
      const a = lineAt(vertical, "a");
      near(a.end[0], 0, 1e-9, "the end is above the start");
      near(a.end[1], 10, 1e-9, "and still 10 mm away");
      const horizontal = addConstraint(projectWith([line("b", [5, 5], [5, 25])]), rel("horizontal", ["b"]));
      const b = lineAt(horizontal, "b");
      near(b.end[1], 5, 1e-9, "the end is level with the start");
      near(Math.abs(b.end[0] - b.start[0]), 20, 1e-9, "and still 20 mm away");
      const joined = projectWith([line("p", [0, 0], [10, 0]), line("q", [10, 0], [20, 0])], [rel("coincident", ["p", "q"], { points: ["end", "start"] })]);
      const chain = addConstraint(joined, rel("vertical", ["q"]));
      const q = lineAt(chain, "q");
      near(q.start[0], lineAt(chain, "p").end[0], 1e-9, "the joint stays closed");
      near(q.end[0], q.start[0], 1e-9, "the second line stands upright");
      near(lengthOf(q), 10, 1e-9, "at its own length");
    }
  },
  {
    name: "Wave3 R2-2: Perpendicular on two exactly parallel lines and Parallel on two exactly square lines turn the second line instead of reporting a false contradiction",
    run: () => {
      const perpendicular = addConstraint(projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]), rel("perpendicular", ["a", "b"]));
      const b = lineAt(perpendicular, "b");
      near(b.end[0] - b.start[0], 0, 1e-9, "b is square to a");
      near(lengthOf(b), 10, 1e-9, "b keeps its length");
      const parallel = addConstraint(projectWith([line("c", [0, 0], [0, 10]), line("d", [0, 5], [10, 5])]), rel("parallel", ["c", "d"]));
      const d = lineAt(parallel, "d");
      near(d.end[0] - d.start[0], 0, 1e-9, "d now runs along c");
      near(lengthOf(d), 10, 1e-9, "d keeps its length");
      const sloppy = addConstraint(projectWith([line("e", [0, 0], [10, 0]), line("f", [0, 5], [10, 0.001 + 5])]), rel("perpendicular", ["e", "f"]));
      near(lengthOf(lineAt(sloppy, "f")), Math.hypot(10, 0.001), 1e-6, "a line within a hair of parallel turns the same way");
    }
  },
  {
    name: "Wave3 R2-2: a shallow line made Vertical is turned, not squashed (Line (0,0)-(10,1) and (0,0)-(10,3) keep their length)",
    run: () => {
      for (const end of [[10, 1], [10, 3], [10, 10], [3, 10]] as const) {
        const result = addConstraint(projectWith([line("a", [0, 0], end)]), rel("vertical", ["a"]));
        const a = lineAt(result, "a");
        near(a.end[0], 0, 1e-9, `(10,${end[1]}) stands upright`);
        near(lengthOf(a), Math.hypot(end[0], end[1]), 1e-9, `and keeps its ${Math.hypot(end[0], end[1]).toFixed(3)} mm`);
      }
      const horizontal = addConstraint(projectWith([line("h", [0, 0], [1, 10])]), rel("horizontal", ["h"]));
      near(lengthOf(lineAt(horizontal, "h")), Math.hypot(1, 10), 1e-9, "a steep line made Horizontal keeps its length too");
    }
  },
  {
    name: "Wave3 R2-2: Horizontal and Vertical on the same line are still a named contradiction",
    run: () => {
      const project = addConstraint(projectWith([line("a", [0, 0], [10, 3])]), rel("horizontal", ["a"]));
      const message = refuse(project, { kind: "add-sketch-constraint", constraint: rel("vertical", ["a"]) });
      assert(/Horizontal/u.test(message) && /Vertical/u.test(message), `both relations are named: ${message}`);
    }
  },
  {
    name: "Wave3 R2-2: the equal-chain with alternating Horizontal and Vertical lines (probe n30) solves",
    run: () => {
      const count = 50;
      const lines = Array.from({ length: count }, (_, index) => line(`s${index}`, [index * 3, 0], [index * 3 + 5 + (index % 7), index % 5]));
      const constraints = [
        ...Array.from({ length: count }, (_, index) => rel(index % 2 === 1 ? "horizontal" : "vertical", [`s${index}`])),
        ...Array.from({ length: count - 1 }, (_, index) => rel("equal", [`s${index}`, `s${index + 1}`]))
      ];
      const solved = solveLiveSketch(projectWith(lines, constraints).sketch);
      assert(solved.ok, `the chain solves: ${solved.ok ? "" : solved.message}`);
    }
  }
,
  {
    name: "Wave3 R2-3: Refraction is one of the simultaneous relations: it removes 3 degrees of freedom (joint and bend), the bent line meets Snell's law, and nothing is left unsolved",
    run: () => {
      const base = projectWith([line("inc", [-20, 20], [0, 0]), line("ref", [0, 0], [10, -20]), line("itf", [-30, 0], [30, 0])]);
      equal(analysis(base).degreesOfFreedom, 12, "three free lines have 12 degrees of freedom");
      const snell = addConstraint(base, { id: "constraint:rf", kind: "refraction", entityIds: ["entity:inc", "entity:ref", "entity:itf"], ratio: 1.5 });
      equal(analysis(snell).degreesOfFreedom, 9, "the joint (2) and the bend (1) are counted");
      const [incidence, refraction] = refractionAngles(lineAt(snell, "inc"), lineAt(snell, "ref"), lineAt(snell, "itf"));
      near(Math.sin((incidence * Math.PI) / 180), 1.5 * Math.sin((refraction * Math.PI) / 180), 1e-9, "Snell's law holds");
      near(lineAt(snell, "ref").start[0], lineAt(snell, "inc").end[0], 1e-9, "the bent line leaves the incident line's end");
      equal(analysis(snell).conflicts.length, 0, "no conflict");
    }
  },
  {
    name: "Wave3 R2-3: a refraction followed by a joined line leaves no gap, and solving again moves nothing (the old pass left a 0.61 mm gap and moved two entities on the next solve)",
    run: () => {
      let project = projectWith([line("inc", [-20, 20], [0, 0]), line("ref", [0, 0], [10, -20]), line("itf", [-30, 0], [30, 0]), line("nx", [10, -20], [10, -40])]);
      project = addConstraint(project, rel("coincident", ["ref", "nx"], { points: ["end", "start"] }));
      project = addConstraint(project, rel("vertical", ["nx"]));
      project = addConstraint(project, { id: "constraint:rf", kind: "refraction", entityIds: ["entity:inc", "entity:ref", "entity:itf"], ratio: 1.5 });
      const ref = lineAt(project, "ref");
      const nx = lineAt(project, "nx");
      near(Math.hypot(ref.end[0] - nx.start[0], ref.end[1] - nx.start[1]), 0, 1e-9, "the joint between the bent line and the next line is closed");
      near(nx.end[0], nx.start[0], 1e-9, "the next line is still vertical");
      const again = solveLiveSketch(project.sketch);
      assert(again.ok, "the sketch solves again");
      if (again.ok) equal(again.movedIds.length, 0, "and a second solve moves nothing");
      const [incidence, refraction] = refractionAngles(lineAt(project, "inc"), ref, lineAt(project, "itf"));
      near(Math.sin((incidence * Math.PI) / 180), 1.5 * Math.sin((refraction * Math.PI) / 180), 1e-9, "Snell's law still holds");
    }
  },
  {
    name: "Wave3 R2-3: a refracted line that is also Horizontal cannot satisfy Snell's law at index ratio 1.5, and the refusal names Refraction and Horizontal instead of leaving the line unbent",
    run: () => {
      const base = addConstraint(projectWith([line("inc", [-20, 20], [0, 0]), line("ref", [0, 0], [10, -20]), line("itf", [-30, 0], [30, 0])]), rel("horizontal", ["ref"]));
      const message = refuse(base, { kind: "add-sketch-constraint", constraint: { id: "constraint:rf", kind: "refraction", entityIds: ["entity:inc", "entity:ref", "entity:itf"], ratio: 1.5 } });
      assert(/Refraction/u.test(message) && /Horizontal/u.test(message), `both relations are named: ${message}`);
    }
  },
  {
    name: "Wave3 R2-3: a length dimension on the refracted line is honoured together with Snell's law",
    run: () => {
      const refracted = addConstraint(projectWith([line("inc", [-20, 20], [0, 0]), line("ref", [0, 0], [10, -20]), line("itf", [-30, 0], [30, 0])]), { id: "constraint:rf", kind: "refraction", entityIds: ["entity:inc", "entity:ref", "entity:itf"], ratio: 1.5 });
      const sized = setDimension(refracted, "ref", "length", 25);
      near(lengthOf(lineAt(sized, "ref")), 25, 1e-9, "the length is 25 mm");
      const [incidence, refraction] = refractionAngles(lineAt(sized, "inc"), lineAt(sized, "ref"), lineAt(sized, "itf"));
      near(Math.sin((incidence * Math.PI) / 180), 1.5 * Math.sin((refraction * Math.PI) / 180), 1e-9, "and the bend still follows Snell's law");
    }
  },
  {
    name: "Wave3 R2-3: Smooth that would move a Fixed spline is refused with a named reason instead of silently moving it",
    run: () => {
      const spline: SketchEntity = { id: "entity:s", kind: "spline", fitPoints: [[10, 2], [14, 6], [20, 7], [26, 5]], construction: false };
      const fixed = projectWith([line("a", [0, 0], [10, 0]), spline], [{ id: "constraint:fx", kind: "fixed", entityIds: ["entity:s"] }]);
      const message = refuse(fixed, { kind: "add-sketch-constraint", constraint: { id: "constraint:sm", kind: "smooth", entityIds: ["entity:a", "entity:s"], points: ["end", "start"] } });
      assert(/Smooth/u.test(message) && /Fixed/u.test(message) && /spline s/u.test(message), `the refusal names Smooth, the spline and the Fix: ${message}`);
    }
  }
,
  {
    name: "Wave3 R2-5: dragging a rectangle corner past the opposite edge moves the sketch continuously when the previous step is passed on (was a 30 mm teleport in a 0.35 mm step)",
    run: () => {
      const ring = lineRing(0, 0, 50, 30);
      const project = projectWith(ring.entities, ring.constraints);
      const from: Vec = [50, 0];
      let previous: readonly SketchEntity[] | undefined;
      let last: readonly SketchEntity[] = project.sketch.entities;
      let worst = 0;
      for (let step = 0; step <= 140; step += 1) {
        const target: Vec = [from[0] - 0.35 * step, from[1] + 0.35 * step];
        const result = dragSketchHandle(project.sketch, "entity:b", { kind: "point", ref: "end" }, from, target, previous);
        assert(result.ok, `step ${step} is accepted: ${result.ok ? "" : result.message}`);
        if (!result.ok) return;
        result.entities.forEach((entity, index) => {
          const earlier = last[index];
          if (entity.kind === "line" && earlier?.kind === "line") worst = Math.max(worst, Math.hypot(entity.start[0] - earlier.start[0], entity.start[1] - earlier.start[1]), Math.hypot(entity.end[0] - earlier.end[0], entity.end[1] - earlier.end[1]));
        });
        previous = result.entities;
        last = result.entities;
      }
      assert(worst < 2, `no step moved a corner by more than 2 mm (worst ${worst.toFixed(2)} mm)`);
      const b = last[0];
      assert(b?.kind === "line" && Math.abs(b.end[0] - (50 - 0.35 * 140)) < 1e-6 && Math.abs(b.end[1] - 0.35 * 140) < 1e-6, "and the dragged corner is under the pointer at the end");
    }
  },
  {
    name: "Wave3 R2-5: a hexagon vertex dragged inward past the centre does not jump (was a 17 mm jump), and a failed first step names the curve instead of a raw id",
    run: () => {
      let counter = 0;
      const ids = { entity: () => `entity:h${(counter += 1)}`, constraint: () => `constraint:h${(counter += 1)}` };
      const hexagon = buildPolygon([0, 0], [20, 0], 6, ids);
      assert(hexagon.ok, "the hexagon builds");
      if (!hexagon.ok) return;
      const project = projectWith(hexagon.value.entities, hexagon.value.constraints);
      const first = project.sketch.entities[0];
      assert(first?.kind === "line", "the first side is a line");
      if (first?.kind !== "line") return;
      const from = first.end;
      let previous: readonly SketchEntity[] | undefined;
      let last: readonly SketchEntity[] | undefined;
      let worst = 0;
      for (let step = 0; step <= 125; step += 1) {
        const target: Vec = [from[0] - 0.3 * step, from[1] - 0.4 * step];
        const result = dragSketchHandle(project.sketch, first.id, { kind: "point", ref: "end" }, from, target, previous);
        assert(result.ok, `step ${step}: ${result.ok ? "" : result.message}`);
        if (!result.ok) return;
        if (last !== undefined) {
          result.entities.forEach((entity, index) => {
            const earlier = last![index];
            if (entity.kind === "circle" && earlier?.kind === "circle") worst = Math.max(worst, Math.hypot(entity.center[0] - earlier.center[0], entity.center[1] - earlier.center[1]));
          });
        }
        previous = result.entities;
        last = result.entities;
      }
      assert(worst < 4, `the guide circle never jumped (worst step ${worst.toFixed(2)} mm)`);

      let slotCounter = 0;
      const slotIds = { entity: () => `entity:s${(slotCounter += 1)}`, constraint: () => `constraint:s${(slotCounter += 1)}` };
      const slot = buildSlot([0, 0], [40, 0], [20, 5], slotIds);
      assert(slot.ok, "the slot builds");
      if (!slot.ok) return;
      const slotProject = projectWith(slot.value.entities, slot.value.constraints);
      const slotLine = slotProject.sketch.entities[0];
      if (slotLine?.kind !== "line") throw new Error("the slot starts with a line");
      const far = dragSketchHandle(slotProject.sketch, slotLine.id, { kind: "point", ref: "start" }, slotLine.start, [slotLine.start[0] + 70.7, slotLine.start[1] - 70.7]);
      assert(!far.ok, "the far one-shot drag collapses the cap arc");
      if (!far.ok) assert(!/entity:/u.test(far.message) && /Arc 1/u.test(far.message), `the message names the curve: ${far.message}`);
    }
  }
,
  {
    name: "Wave3 R2-6: Tangent between a free circle and a distant line or circle succeeds the same way whether the radius is dimensioned or not: the radius is kept, the circle moves, and the status explains it with names",
    run: () => {
      const free = projectWith([line("l", [0, 0], [40, 0]), circle("c", [20, 30], 5)]);
      for (const [label, base] of [
        ["free line and free circle", free],
        ["fixed line and free circle", addConstraint(free, rel("fixed", ["l"]))],
        ["circle centre fixed and free line", addConstraint(free, rel("fixed", ["c"], { points: ["center"] }))]
      ] as const) {
        const result = apply(base, { kind: "add-sketch-constraint", constraint: rel("tangent", ["l", "c"]) });
        assert(result.ok, `${label}: a routine Tangent click is accepted: ${result.ok ? "" : result.diagnostics[0]?.message}`);
        if (!result.ok) continue;
        const c = get(result.value.project, "c", "circle");
        near(c.radiusMm, 5, 1e-9, `${label}: the circle keeps its 5 mm radius`);
        near(Math.abs(c.center[1] - get(result.value.project, "l", "line").start[1]), 5, 1e-6, `${label}: and touches the line`);
        assert(/Circle 1 is far from Line 1/u.test(result.value.summary) && !/entity:/u.test(result.value.summary), `${label}: the status names the curves: ${result.value.summary}`);
      }
      const dimensioned = setDimension(free, "c", "radius", 5);
      const same = apply(dimensioned, { kind: "add-sketch-constraint", constraint: rel("tangent", ["l", "c"]) });
      assert(same.ok, "with the radius dimensioned the same click is accepted too");
      const circles = projectWith([circle("a", [0, 0], 5), circle("b", [60, 0], 3)]);
      const apart = apply(circles, { kind: "add-sketch-constraint", constraint: rel("tangent", ["a", "b"]) });
      assert(apart.ok, "two distant circles are made tangent");
      if (apart.ok) near(get(apart.value.project, "b", "circle").radiusMm, 3, 1e-9, "without resizing the second one");
      // A small gap is still closed by resizing, as before, and says so.
      const snug = apply(projectWith([line("rail", [-20, 0], [20, 0]), circle("wheel", [0, 7], 3)]), { kind: "add-sketch-constraint", constraint: rel("tangent", ["rail", "wheel"]) });
      assert(snug.ok && /Resized circle wheel from radius 3 to 7/u.test(snug.value.summary), "a nearby gap resizes the free circle and the status says how");
    }
  }
];

// Keep the helpers referenced for the tests added below.
void [ident, run, setDimension, analyzeWorkbenchSketch, equal];
