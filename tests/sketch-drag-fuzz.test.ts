import { dragLiveSketch, solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import type { SketchEntity, SketchPointRef, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { assert, type TestCase } from "./test-kit.js";
import { circle, get, line, lengthOf, lineRing, projectWith, rel, ringIsClosedRectangle, run, setDimension, type Vec } from "./sketch-solver-kit.js";

/**
 * Drag-stability fuzz test, taken from the sketch research package ("fuzz test of 1,000 random drags without divergence").
 * Each scenario is dragged along many random pointer paths (small steps like a real mouse, with an occasional wild jump) from a
 * seeded generator, so a failure is reproducible: the message names the scenario, the path and the step.
 *
 * What must hold after EVERY drag, whatever the pointer did:
 *   1. it never throws;
 *   2. an accepted drag returns only finite numbers (no NaN, no Infinity);
 *   3. a refused drag says why in words, and the caller keeps the sketch it had;
 *   4. dimensions and shape relations are never violated by an accepted drag (the ring stays a closed, level rectangle of its size);
 *   5. an accepted result is a fixed point: solving it again moves nothing;
 *   6. geometry that no relation touches follows the pointer exactly.
 */

/** mulberry32: a small, well-known seeded generator. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const allFinite = (value: unknown): boolean => {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (value !== null && typeof value === "object") return Object.values(value).every(allFinite);
  return true;
};

const numbersOf = (value: unknown, out: number[] = []): number[] => {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const item of value) numbersOf(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) numbersOf(item, out);
  return out;
};

interface Handle { readonly entityId: string; readonly point: SketchPointRef; readonly at: Vec }

function handlesOf(sketch: WorkbenchSketch): Handle[] {
  const handles: Handle[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind === "line") {
      handles.push({ entityId: entity.id, point: "start", at: entity.start }, { entityId: entity.id, point: "end", at: entity.end });
    } else if (entity.kind === "circle") handles.push({ entityId: entity.id, point: "center", at: entity.center });
  }
  return handles;
}

interface Scenario {
  readonly name: string;
  readonly project: WorkbenchProject;
  /** Extra checks on an accepted result; return a problem sentence or undefined. */
  readonly invariant?: (project: WorkbenchProject) => string | undefined;
}

function ringScenario(): Scenario {
  const ring = lineRing(0, 0, 80, 50);
  let project = projectWith([...ring.entities, circle("h", [40, 25], 6)], ring.constraints);
  project = setDimension(project, "b", "length", 80);
  project = setDimension(project, "r", "length", 50);
  project = setDimension(project, "h", "radius", 6);
  return {
    name: "a dimensioned rectangle with a free hole",
    project,
    invariant: (next) => {
      if (!ringIsClosedRectangle(next, 1e-6)) return "the ring is no longer a closed, level rectangle";
      const bottom = lengthOf(get(next, "b", "line"));
      const right = lengthOf(get(next, "r", "line"));
      if (Math.abs(bottom - 80) > 1e-6 || Math.abs(right - 50) > 1e-6) return `the dimensions moved: ${bottom.toFixed(6)} x ${right.toFixed(6)} instead of 80 x 50`;
      const hole = get(next, "h", "circle");
      if (Math.abs(hole.radiusMm - 6) > 1e-6) return `the hole radius moved to ${hole.radiusMm}`;
      return undefined;
    }
  };
}

function staircaseScenario(): Scenario {
  const steps = 6;
  const entities: SketchEntity[] = [];
  const constraints = [];
  let cursor: Vec = [0, 0];
  for (let index = 0; index < steps; index += 1) {
    const next: Vec = index % 2 === 0 ? [cursor[0] + 15, cursor[1]] : [cursor[0], cursor[1] + 15];
    entities.push(line(`s${index}`, cursor, next));
    constraints.push(rel(index % 2 === 0 ? "horizontal" : "vertical", [`s${index}`]));
    if (index > 0) constraints.push(rel("coincident", [`s${index - 1}`, `s${index}`], { points: ["end", "start"] }), rel("equal", ["s0", `s${index}`]));
    cursor = next;
  }
  const project = setDimension(projectWith(entities, constraints), "s0", "length", 15);
  return {
    name: "a joined staircase of six equal steps",
    project,
    invariant: (next) => {
      for (let index = 0; index < steps; index += 1) {
        const step = get(next, `s${index}`, "line");
        if (Math.abs(lengthOf(step) - 15) > 1e-6) return `step ${index} is ${lengthOf(step).toFixed(6)} long instead of 15`;
      }
      return undefined;
    }
  };
}

function freeScenario(): Scenario {
  return {
    name: "free lines and a circle that no relation touches",
    project: projectWith([line("p", [0, 0], [30, 10]), line("q", [40, 0], [60, 25]), circle("c", [20, 40], 8)])
  };
}

const PATHS = 18;
const STEPS = 28;
const SCENARIOS = [ringScenario, staircaseScenario, freeScenario];

export const sketchDragFuzzTests: readonly TestCase[] = [
  {
    name: `Drag fuzz: ${PATHS * STEPS * SCENARIOS.length} seeded random drags over three sketches never throw, never return NaN, never break a dimension or shape relation, and settle to a fixed point`,
    run: () => {
      const durations: number[] = [];
      let accepted = 0;
      let refused = 0;
      SCENARIOS.forEach((build, scenarioIndex) => {
        const scenario = build();
        for (let path = 0; path < PATHS; path += 1) {
          const random = generator(1000 * (scenarioIndex + 1) + path);
          let sketch = scenario.project.sketch;
          for (let step = 0; step < STEPS; step += 1) {
            const where = `${scenario.name}, path ${path}, step ${step}`;
            const handles = handlesOf(sketch);
            const handle = handles[Math.floor(random() * handles.length)]!;
            // A walk like a real mouse, with an occasional jump across the sheet.
            const jump = random() < 0.08;
            const reach = jump ? 300 : 25;
            const target: Vec = [handle.at[0] + (random() - 0.5) * 2 * reach, handle.at[1] + (random() - 0.5) * 2 * reach];
            const started = performance.now();
            let report;
            try {
              report = dragLiveSketch(sketch, { entityId: handle.entityId, point: handle.point, positionMm: target });
            } catch (error) {
              assert(false, `${where}: the drag threw ${error instanceof Error ? error.message : String(error)}`);
              return;
            }
            durations.push(performance.now() - started);
            if (!report.ok) {
              refused += 1;
              assert(typeof report.message === "string" && report.message.trim().length > 0, `${where}: a refused drag explains itself`);
              continue; // the caller keeps the previous sketch
            }
            accepted += 1;
            assert(allFinite(report.entities), `${where}: the accepted drag holds only finite numbers`);
            const next = { ...scenario.project, sketch: { ...sketch, entities: report.entities } };
            const problem = scenario.invariant?.(next);
            assert(problem === undefined, `${where}: ${problem ?? ""}`);
            if (scenario.invariant === undefined) {
              // Nothing constrains these curves, so the dragged point must be exactly under the pointer.
              const moved = report.entities.find((entity) => entity.id === handle.entityId);
              const reached = moved === undefined ? undefined : pointOf(moved, handle.point);
              assert(reached !== undefined && Math.abs(reached[0] - target[0]) < 1e-9 && Math.abs(reached[1] - target[1]) < 1e-9, `${where}: free geometry follows the pointer exactly`);
            }
            if (step % 4 === 0) {
              const again = solveLiveSketch(next.sketch);
              if (again.ok) {
                const before = numbersOf(report.entities);
                const after = numbersOf(again.entities);
                let largest = 0;
                for (let index = 0; index < before.length; index += 1) largest = Math.max(largest, Math.abs((before[index] ?? 0) - (after[index] ?? 0)));
                assert(largest < 1e-4, `${where}: solving the accepted result again moved something by ${largest.toExponential(2)} mm`);
              }
            }
            sketch = next.sketch;
          }
        }
      });
      const total = accepted + refused;
      assert(total === PATHS * STEPS * SCENARIOS.length, `every drag was counted: ${total}`);
      assert(accepted / total >= 0.7, `most drags of these ordinary sketches are accepted: ${accepted} of ${total} (a solver that refuses everything would pass the checks above)`);
      durations.sort((left, right) => left - right);
      const median = durations[Math.floor(durations.length / 2)]!;
      // The research package's goal is 16 ms per drag frame (60 frames per second). These sketches measure about 0.5 ms, so the goal itself is the
      // bound: it has a margin of about 30 times for a slow or busy machine, and a solver change that made a drag step 30 times slower would fail it.
      assert(median < 16, `the median drag step fits in one 60 Hz frame: ${median.toFixed(2)} ms (bound 16 ms)`);
    }
  }
];

function pointOf(entity: SketchEntity, point: SketchPointRef): Vec | undefined {
  if (entity.kind === "line") return point === "start" ? entity.start : point === "end" ? entity.end : undefined;
  if (entity.kind === "circle") return point === "center" ? entity.center : undefined;
  return undefined;
}

void run;
