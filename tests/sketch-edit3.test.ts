import { applyWorkbenchOperation, type SketchEntity, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { dragSketchHandle } from "../packages/workbench-sketch/src/drag.js";
import { planPattern } from "../packages/workbench-sketch/src/pattern-path.js";
import { transformEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { chamferCorners, cornerByClick, filletCorners } from "../packages/workbench-sketch/src/corner-tools.js";
import { splitAt } from "../packages/workbench-sketch/src/split-jog.js";
import { trimAt } from "../packages/workbench-sketch/src/trim-extend.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { analyzeSketch, repairAll } from "../packages/workbench-sketch/src/sketch-repair.js";
import { applyOk, circle, commit, con, ctx, ids, line, ofKind, projectWith, rect, relationsOf } from "./edit-test-kit.js";

/** Wave 3 regression tests for the sketch edit tools (re-audit 2: Edit tools R2-1 to R2-5, E07, E10, N3; UX R2-1, R2-5). */

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Line = Extract<SketchEntity, { kind: "line" }>;

function run(project: WorkbenchProject, operation: Record<string, unknown>): WorkbenchProject {
  const result = applyWorkbenchOperation(project, { operationId: `operation:e3-${Math.random().toString(36).slice(2)}`, expectedRevision: project.revision, ...operation } as never);
  if (!result.ok) throw new Error(`operation refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}

/** Dangling or duplicate ids, non-finite numbers, or a solve that would still move geometry (the sketch origin and axes are valid references). */
function problems(project: WorkbenchProject): string[] {
  const found: string[] = [];
  const known = new Set([...project.sketch.entities.map((entity) => entity.id), "sketch:origin", "sketch:axis-x", "sketch:axis-y"]);
  for (const constraint of project.sketch.constraints) if (constraint.entityIds.some((id) => !known.has(id))) found.push(`dangling relation ${constraint.id}`);
  if (new Set(project.sketch.entities.map((entity) => entity.id)).size !== project.sketch.entities.length) found.push("duplicate entity ids");
  if (new Set(project.sketch.constraints.map((constraint) => constraint.id)).size !== project.sketch.constraints.length) found.push("duplicate relation ids");
  if (/NaN|null/u.test(JSON.stringify(project.sketch))) found.push("non-finite number in the sketch");
  const solved = solveLiveSketch(project.sketch);
  if (!solved.ok) found.push(`solve fails: ${solved.message}`);
  else if (solved.movedIds.length > 0) found.push(`solve would move ${solved.movedIds.join(", ")}`);
  return found;
}

const dof = (project: WorkbenchProject): number => analyzeWorkbenchSketch(project.sketch).degreesOfFreedom;

/** Width and height of the outline of lines and arc middles. */
function outline(project: WorkbenchProject): { readonly width: number; readonly height: number; readonly minX: number; readonly minY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const entity of project.sketch.entities) {
    if (entity.kind === "line") { xs.push(entity.start[0], entity.end[0]); ys.push(entity.start[1], entity.end[1]); }
    if (entity.kind === "arc") { xs.push(entity.mid[0]); ys.push(entity.mid[1]); }
  }
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), minX: Math.min(...xs), minY: Math.min(...ys) };
}

function plate(): WorkbenchProject {
  const lines = [line("b", [0, 0], [80, 0]), line("r", [80, 0], [80, 50]), line("t", [80, 50], [0, 50]), line("l", [0, 50], [0, 0])];
  const joints = [
    con("c1", "coincident", ["b", "r"], { points: ["end", "start"] }), con("c2", "coincident", ["r", "t"], { points: ["end", "start"] }),
    con("c3", "coincident", ["t", "l"], { points: ["end", "start"] }), con("c4", "coincident", ["l", "b"], { points: ["end", "start"] }),
    con("h1", "horizontal", ["b"]), con("h2", "horizontal", ["t"]), con("v1", "vertical", ["r"]), con("v2", "vertical", ["l"]),
    { id: "constraint:pin", kind: "coincident", entityIds: ["sketch:origin", "entity:b"], points: ["self", "start"] } as const,
    con("lb", "distance", ["b"], { valueMm: 80, dimension: "length" }), con("lr", "distance", ["r"], { valueMm: 50, dimension: "length" })
  ];
  return projectWith(lines, joints);
}

export const sketchEdit3Tests: readonly TestCase[] = [
  {
    name: "Wave 3 edit R2-1: dragging an end of a clockwise (fillet) arc moves that end, for all four corner orientations",
    run: () => {
      const corners: readonly (readonly [Vec2, Vec2, Vec2])[] = [[[0, 0], [100, 0], [0, 100]], [[100, 0], [0, 0], [100, 100]], [[100, 100], [0, 100], [100, 0]], [[0, 100], [100, 100], [0, 0]]];
      let clockwise = 0;
      for (const [corner, first, second] of corners) {
        const project = projectWith([line("a", corner, first), line("b", corner, second)], [con("k", "coincident", ["a", "b"], { points: ["start", "start"] })]);
        const rounded = applyOk(project, filletCorners(ctx(project), ids("a", "b"), 10));
        const made = ofKind(rounded, "arc")[0]!;
        const cross = (made.mid[0] - made.start[0]) * (made.end[1] - made.start[1]) - (made.mid[1] - made.start[1]) * (made.end[0] - made.start[0]);
        if (cross < 0) clockwise += 1;
        for (const which of ["start", "end"] as const) {
          const from = made[which];
          const to: Vec2 = [from[0] + 1, from[1] + 1];
          const dragged = dragSketchHandle(rounded.sketch, made.id, { kind: "arc-point", which }, from, to);
          if (!dragged.ok) throw new Error(`drag refused: ${dragged.message}`);
          const next = dragged.entities.find((entity) => entity.id === made.id) as Arc;
          assert(dist(next[which], to) < 0.01, `the ${which} of the arc follows the pointer (arc ${cross < 0 ? "clockwise" : "counter-clockwise"})`);
          const other = which === "start" ? "end" : "start";
          assert(dist(next[other], made[other]) < 3, `the ${other} stays near where it was`);
        }
      }
      equal(clockwise, 2, "two of the four orientations are clockwise arcs");
    }
  },
  {
    name: "Wave 3 edit R2-2: a fillet keeps the size dimensions, so the 80 x 50 plate stays 80 x 50 and fully constrained, and editing the radius does not resize it",
    run: () => {
      const start = plate();
      equal(dof(start), 0, "the dimensioned plate is fully constrained");
      const rounded = applyOk(start, cornerByClickAt(start, [80, 0], 6));
      equal(problems(rounded).join("; "), "", "the edit leaves a consistent sketch");
      equal(dof(rounded), 0, "still fully constrained after the fillet");
      const sizeDims = relationsOf(rounded, "distance").filter((c) => c.valueMm === 80 || c.valueMm === 50);
      equal(sizeDims.length, 2, "both size dimensions are still there");
      near(outline(rounded).width, 80, 1e-6, "80 wide");
      near(outline(rounded).height, 50, 1e-6, "50 tall");
      const bigger = run(rounded, { kind: "set-sketch-dimension", entityId: ofKind(rounded, "arc")[0]!.id, dimension: "radius", valueMm: 14 });
      near(outline(bigger).width, 80, 1e-6, "after the radius becomes 14 the plate is still 80 wide");
      near(outline(bigger).height, 50, 1e-6, "and 50 tall");
      near(outline(bigger).minX, 0, 1e-6, "and still anchored at the origin");
      equal(dof(bigger), 0, "and still fully constrained");
      // All four corners, one after the other.
      let all = start;
      for (const corner of [[80, 0], [80, 50], [0, 50], [0, 0]] as const) all = applyOk(all, cornerByClickAt(all, corner, 5));
      equal(dof(all), 0, "four rounded corners: still fully constrained");
      near(outline(all).width, 80, 1e-6, "80 wide after four corners");
      near(outline(all).height, 50, 1e-6, "50 tall after four corners");
    }
  },
  {
    name: "Wave 3 edit R2-2/UX R2-1: filleting every corner of a Rectangle keeps its width and height, and the radius edit keeps the part size",
    run: () => {
      const project = projectWith([rect("r", [50, 30], 100, 60)], [
        con("w", "distance", ["r"], { valueMm: 100, dimension: "width" }), con("h", "distance", ["r"], { valueMm: 60, dimension: "height" }),
        { id: "constraint:o", kind: "coincident", entityIds: ["sketch:origin", "entity:r"], points: ["self", "corner-0"] }
      ]);
      const rounded = applyOk(project, filletCorners(ctx(project), ids("r"), 8));
      equal(problems(rounded).join("; "), "", "consistent");
      const kept = relationsOf(rounded, "distance").map((c) => c.valueMm).sort();
      assert(kept.includes(100) && kept.includes(60), "the 100 and 60 dimensions are kept");
      assert(rounded.sketch.constraints.some((c) => c.kind === "coincident" && c.entityIds.includes("sketch:origin")), "the pin to the origin is kept");
      const bigger = run(rounded, { kind: "set-sketch-dimension", entityId: ofKind(rounded, "arc")[0]!.id, dimension: "radius", valueMm: 14 });
      near(outline(bigger).width, 100, 1e-6, "100 wide after R14");
      near(outline(bigger).height, 60, 1e-6, "60 tall after R14");
      near(outline(bigger).minX, 0, 1e-6, "anchored at the origin");
      near(outline(bigger).minY, 0, 1e-6, "anchored at the origin");
    }
  },
  {
    name: "Wave 3 edit R2-5: click fillet and chamfer of a Rectangle corner keep its origin pin and the lines attached to its other corners",
    run: () => {
      const attached = [line("t", [100, 0], [140, 0]), line("u", [0, 60], [0, 90])];
      const base = projectWith([rect("r", [50, 30], 100, 60), ...attached], [
        { id: "constraint:o", kind: "coincident", entityIds: ["sketch:origin", "entity:r"], points: ["self", "corner-0"] },
        { id: "constraint:j1", kind: "coincident", entityIds: ["entity:r", "entity:t"], points: ["corner-1", "start"] },
        { id: "constraint:j2", kind: "coincident", entityIds: ["entity:r", "entity:u"], points: ["corner-3", "start"] },
        con("w", "distance", ["r"], { valueMm: 100, dimension: "width" })
      ]);
      equal(problems(base).join("; "), "", "the start is consistent");
      for (const [name, spec] of [["fillet", { kind: "fillet", radiusMm: 8, dimension: true }], ["chamfer", { kind: "chamfer", firstMm: 6, secondMm: 6 }]] as const) {
        for (const corner of [[100, 60], [0, 0]] as const) {
          const done = applyOk(base, cornerByClick(ctx(base), corner as unknown as Vec2, 0.5, spec));
          equal(problems(done).join("; "), "", `${name} at ${corner}: consistent`);
          const pin = done.sketch.constraints.filter((c) => c.kind === "coincident" && c.entityIds.includes("sketch:origin"));
          equal(pin.length, 1, `${name} at ${corner}: the origin pin is kept`);
          const joints = done.sketch.constraints.filter((c) => c.kind === "coincident" && (c.entityIds.includes("entity:t") || c.entityIds.includes("entity:u")));
          equal(joints.length, 2, `${name} at ${corner}: both attached lines are still joined`);
          const moved = done.sketch.entities.filter((e) => e.id === "entity:t" || e.id === "entity:u");
          assert(moved.every((e, index) => dist((e as Line).start, index === 0 ? [100, 0] : [0, 60]) < 1e-6), `${name} at ${corner}: the attached lines did not move`);
          assert(done.sketch.constraints.some((c) => c.kind === "distance" && c.valueMm === 100), `${name} at ${corner}: the 100 mm width is still driven`);
        }
      }
      // Split and trim of a Rectangle side.
      const split = applyOk(base, splitAt(ctx(base), "entity:r", [50, 0]));
      equal(problems(split).join("; "), "", "split: consistent");
      equal(split.sketch.constraints.filter((c) => c.kind === "coincident" && c.entityIds.includes("sketch:origin")).length, 1, "split: the origin pin is kept");
      equal(split.sketch.constraints.filter((c) => c.kind === "coincident" && (c.entityIds.includes("entity:t") || c.entityIds.includes("entity:u"))).length, 2, "split: the attached lines are still joined");
      assert(split.sketch.constraints.some((c) => c.kind === "distance" && c.valueMm === 100), "split: the width is still driven");
      equal(dofOfSplitWidth(split), 100, "split: the outline is still 100 wide");
      const crossing = projectWith([...base.sketch.entities, line("x", [50, -20], [50, 80])], base.sketch.constraints);
      const trimmed = applyOk(crossing, trimAt(ctx(crossing), "entity:r", [75, 0]));
      equal(problems(trimmed).join("; "), "", "trim: consistent");
      equal(trimmed.sketch.constraints.filter((c) => c.kind === "coincident" && c.entityIds.includes("sketch:origin")).length, 1, "trim: the origin pin is kept");
      equal(trimmed.sketch.constraints.filter((c) => c.kind === "coincident" && c.entityIds.includes("entity:u")).length, 1, "trim: the line attached to the untouched corner is still joined");
    }
  },
  {
    name: "Wave 3 edit R2-5: a Rectangle pinned at its centre keeps the pin when a corner is rounded",
    run: () => {
      const base = projectWith([rect("r", [0, 0], 100, 60)], [{ id: "constraint:o", kind: "coincident", entityIds: ["sketch:origin", "entity:r"], points: ["self", "center"] }]);
      const done = applyOk(base, cornerByClick(ctx(base), [50, 30], 0.5, { kind: "fillet", radiusMm: 8, dimension: true }));
      equal(problems(done).join("; "), "", "consistent");
      assert(done.sketch.constraints.some((c) => c.kind === "coincident" && c.entityIds.includes("sketch:origin")), "the centre pin is carried by the construction diagonal");
      const chamfered = applyOk(base, filletCorners(ctx(base), ids("r"), 5));
      assert(chamfered.sketch.constraints.some((c) => c.kind === "coincident" && c.entityIds.includes("sketch:origin")), "filleting all corners keeps the centre pin as well");
    }
  }
];

function cornerByClickAt(project: WorkbenchProject, at: readonly [number, number], radiusMm: number) {
  return cornerByClick(ctx(project), at as unknown as Vec2, 0.5, { kind: "fillet", radiusMm, dimension: true });
}

function dofOfSplitWidth(project: WorkbenchProject): number {
  const xs = project.sketch.entities.filter((e): e is Line => e.kind === "line" && !e.construction).flatMap((e) => [e.start[0], e.end[0]]).filter((x) => x <= 100.0001);
  return Math.round(Math.max(...xs) - Math.min(...xs));
}

export const sketchEdit3SummaryTests: readonly TestCase[] = [
  {
    name: "Wave 3 UX R2-1: a dimension an edit has to let go of is named in the status text, and a re-expressed one is not reported as lost",
    run: () => {
      const base = projectWith([line("a", [0, 0], [100, 0]), line("x", [40, -20], [40, 20])], [con("h", "horizontal", ["a"]), con("len", "distance", ["a"], { valueMm: 100, dimension: "length" })]);
      const trimmed = commit(base, trimAt(ctx(base), "entity:a", [70, 0]));
      if (!trimmed.ok) throw new Error(trimmed.message);
      assert(/Dimensions let go: Length 100 on Line 1/u.test(trimmed.summary), `the summary names the dimension: ${trimmed.summary}`);
      const rounded = commit(plate(), cornerByClickAt(plate(), [80, 0], 6));
      if (!rounded.ok) throw new Error(rounded.message);
      assert(!/let go/u.test(rounded.summary), `a fillet that keeps both size dimensions does not report them lost: ${rounded.summary}`);
    }
  }
];

export const sketchEdit3RepairTests: readonly TestCase[] = [
  {
    name: "Wave 3 UX R2-5: Sketch Repair reads a Diameter dimension as a diameter (no false Conflict, right label, Fix all keeps the valid Equal)",
    run: () => {
      let project = projectWith([circle("a", [0, 0], 5), circle("b", [40, 0], 5)]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "diameter", valueMm: 10 });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:b", dimension: "radius", valueMm: 5 });
      project = run(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:eq", kind: "equal", entityIds: ["entity:a", "entity:b"] } });
      const report = analyzeSketch(ctx(project));
      equal(report.errors, 0, "a healthy sketch reports no error");
      assert(report.usableForSolid, "and stays usable for a solid");
      assert(!report.issues.some((issue) => /conflict/iu.test(issue.title)), "no Conflict issue");
      assert(report.issues.every((issue) => !/Radius on entity:a|Radius on a\b/u.test(`${issue.title} ${issue.detail}`)), "the diameter is not labelled as a radius");
      const fixed = repairAll(ctx(project));
      assert(fixed.sketch.constraints.some((c) => c.kind === "radius" && c.dimension === "diameter"), "Fix all keeps the diameter dimension");
      assert(!fixed.applied.some((text) => /Relax the equal/iu.test(text)), "and does not relax the Equal");
      // Both circles dimensioned by diameter and joined by Equal: a plain redundancy, never a conflict.
      let twin = projectWith([circle("a", [0, 0], 5), circle("b", [40, 0], 5)]);
      twin = run(twin, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "diameter", valueMm: 10 });
      twin = run(twin, { kind: "set-sketch-dimension", entityId: "entity:b", dimension: "diameter", valueMm: 10 });
      twin = run(twin, { kind: "add-sketch-constraint", constraint: { id: "constraint:eq", kind: "equal", entityIds: ["entity:a", "entity:b"] } });
      equal(analyzeSketch(ctx(twin)).errors, 0, "two equal diameters are not an error");
      // One circle with both a Radius and the matching Diameter.
      let both = projectWith([circle("a", [0, 0], 5)]);
      both = run(both, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "radius", valueMm: 5 });
      both = run(both, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "diameter", valueMm: 10 });
      equal(analyzeSketch(ctx(both)).errors, 0, "a radius and the matching diameter on one circle are redundant, not conflicting");
    }
  }
];

export const sketchEdit3PatternTests: readonly TestCase[] = [
  {
    name: "Wave 3 edit R2-3: fillet, chamfer, trim, split and move on copies of an associative pattern are refused with the way out, never reported OK with a stray arc",
    run: () => {
      const base = projectWith([line("a", [0, 0], [30, 0]), line("b", [30, 0], [30, 20])], [con("k", "coincident", ["a", "b"], { points: ["end", "start"] })]);
      const planned = planPattern(ctx(base), ["entity:a", "entity:b"], { kind: "rectangular", countX: 2, countY: 1, dxMm: 60, dyMm: 0, angleDeg: 0, extent: false });
      if (!planned.ok) throw new Error(planned.diagnostics[0]?.message);
      const patterned = applyOk(base, planned);
      const copies = patterned.sketch.entities.filter((entity) => entity.id.startsWith("entity:pat.")).map((entity) => entity.id);
      equal(copies.length, 2, "two copies");
      const refuse = (name: string, result: ReturnType<typeof filletCorners>): void => {
        assert(!result.ok, `${name}: refused instead of reporting OK`);
        if (!result.ok) assert(/pattern/u.test(result.diagnostics[0]!.message) && /source|dissolve/iu.test(result.diagnostics[0]!.message), `${name}: the message names the pattern and the way out`);
      };
      refuse("fillet", filletCorners(ctx(patterned), copies, 5));
      refuse("chamfer", chamferCorners(ctx(patterned), copies, 4));
      refuse("move", transformEntities(ctx(patterned), [copies[0]!], { kind: "move", dxMm: 5, dyMm: 5 }, false));
      const crossing = { ...patterned, sketch: { ...patterned.sketch, entities: [...patterned.sketch.entities, line("x", [75, -5], [75, 25])] } };
      refuse("trim", trimAt(ctx(crossing), copies[0]!, [65, 0]));
      refuse("split", splitAt(ctx(patterned), copies[0]!, [70, 0]));
      // The sketch is exactly as it was: no stray arc, every relation holds.
      equal(patterned.sketch.entities.filter((entity) => entity.kind === "arc").length, 0, "no stray arc");
      equal(problems(patterned).join("; "), "", "and the sketch is consistent");
      // Editing the source is still how a pattern is changed, and moving sources and copies together is allowed.
      const moved = applyOk(patterned, transformEntities(ctx(patterned), [...copies, "entity:a", "entity:b"], { kind: "move", dxMm: 5, dyMm: 5 }, false));
      equal(problems(moved).join("; "), "", "moving the sources together with their copies stays consistent");
      const longer = run(patterned, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 40 });
      equal(problems(longer).join("; "), "", "editing the source length still updates the copies");
    }
  }
];
