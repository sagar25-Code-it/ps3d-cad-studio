import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  type SketchEntity,
  type WorkbenchProject,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch, detectSketchProfiles, sampleSpline } from "../packages/workbench-sketch/src/index.js";
import {
  chamferCorners,
  checkSketch,
  constraintsOnEntities,
  cornerLines,
  extendAt,
  filletCorners,
  mirrorEntities,
  nearestEntityId,
  offsetEntities,
  patternEntities,
  trimAt,
  type SketchEditContext,
  type SketchEditResult
} from "../packages/workbench-sketch/src/edit-tools.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
const newId = (prefix: "entity" | "constraint"): string => `${prefix}:gen-${(serial += 1)}`;

function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const base = createWorkbenchProject("project:test-edit-tools");
  return { ...base, sketch: { ...base.sketch, entities, constraints } };
}

function context(project: WorkbenchProject): SketchEditContext {
  return { sketch: project.sketch, newId };
}

const line = (id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });
const circle = (id: string, center: readonly [number, number], radiusMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false });
const ids = (...names: string[]): string[] => names.map((name) => `entity:${name}`);

/** Applies a planned edit through the real operation, as the UI does. */
function commit(project: WorkbenchProject, result: SketchEditResult) {
  if (!result.ok) throw new Error(`edit planning failed: ${result.diagnostics[0]?.message}`);
  serial += 1;
  return applyWorkbenchOperation(project, {
    kind: "apply-sketch-edit",
    operationId: `operation:test-edit-${serial}`,
    expectedRevision: project.revision,
    label: result.value.label,
    removeEntityIds: result.value.removeEntityIds,
    updateEntities: result.value.updateEntities,
    addEntities: result.value.addEntities,
    addConstraints: result.value.addConstraints
  });
}

function entityOf<K extends SketchEntity["kind"]>(project: WorkbenchProject, id: string, kind: K): Extract<SketchEntity, { kind: K }> {
  const found = project.sketch.entities.find((entity) => entity.id === id);
  if (found?.kind !== kind) throw new Error(`expected ${kind} ${id}`);
  return found as Extract<SketchEntity, { kind: K }>;
}

function linesOf(project: WorkbenchProject): Extract<SketchEntity, { kind: "line" }>[] {
  return project.sketch.entities.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line");
}

function nearPoint(actual: readonly [number, number], expected: readonly [number, number], message: string, tolerance = 1e-9): void {
  near(actual[0], expected[0], tolerance, `${message} (x)`);
  near(actual[1], expected[1], tolerance, `${message} (y)`);
}

export const sketchEditToolTests: readonly TestCase[] = [
  {
    name: "offset moves a line to its left, a circle outward, and rejects an inward offset past the centre",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), circle("c", [0, 20], 5)]);
      const result = commit(project, offsetEntities(context(project), ids("a"), 2));
      assert(result.ok, "line offset applies");
      const copy = linesOf(result.value.project).find((candidate) => candidate.id !== "entity:a")!;
      nearPoint(copy.start, [0, 2], "left of a rightward line is up");
      nearPoint(copy.end, [10, 2], "end");
      const right = offsetEntities(context(project), ids("a"), -2);
      assert(right.ok && (right.value.addEntities[0] as Extract<SketchEntity, { kind: "line" }>).start[1] === -2, "a negative distance offsets to the other side");

      const grown = commit(project, offsetEntities(context(project), ids("c"), 3));
      assert(grown.ok, "circle offset applies");
      near(grown.value.project.sketch.entities.filter((e) => e.kind === "circle").map((e) => (e as { radiusMm: number }).radiusMm).sort((a, b) => a - b)[1]!, 8, 1e-12, "outward grows the radius");
      assert(!offsetEntities(context(project), ids("c"), -6).ok, "an inward offset larger than the radius is rejected");
      assert(!offsetEntities(context(project), ids("a"), 0).ok, "a zero distance is rejected");
    }
  },
  {
    name: "offset re-joins connected lines with mitred corners, outward for closed loops",
    run: () => {
      const square = [line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10], [0, 0])];
      const project = projectWith(square);
      const outward = offsetEntities(context(project), ids("s0", "s1", "s2", "s3"), 2);
      assert(outward.ok, "a closed loop offsets");
      equal(outward.value.addEntities.length, 4, "four new lines");
      const xs = outward.value.addEntities.flatMap((entity) => (entity.kind === "line" ? [entity.start[0], entity.end[0]] : []));
      near(Math.min(...xs), -2, 1e-9, "positive distance grows a closed loop");
      near(Math.max(...xs), 12, 1e-9, "on every side");
      const inward = offsetEntities(context(project), ids("s0", "s1", "s2", "s3"), -2);
      assert(inward.ok, "an inward loop offsets");
      near(Math.max(...inward.value.addEntities.flatMap((entity) => (entity.kind === "line" ? [entity.start[0], entity.end[0]] : []))), 8, 1e-9, "negative shrinks it");
      assert(!offsetEntities(context(project), ids("s0", "s1", "s2", "s3"), -6).ok, "collapsing the loop is rejected");

      const bend = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])]);
      const chain = offsetEntities(context(bend), ids("a", "b"), 1);
      assert(chain.ok, "an open chain offsets");
      const starts = chain.value.addEntities.map((entity) => (entity.kind === "line" ? [entity.start, entity.end] : []));
      nearPoint(starts[0]![0]!, [0, 1], "first line shifts left");
      nearPoint(starts[0]![1]!, [9, 1], "the corner is the mitre of both offsets");
      nearPoint(starts[1]![1]!, [9, 10], "second line shifts left of its own direction");
    }
  },
  {
    name: "offset resizes a rectangle and an arc about its centre",
    run: () => {
      const rectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const arc: SketchEntity = { id: "entity:a", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false };
      const project = projectWith([rectangle, arc]);
      const result = offsetEntities(context(project), ids("r", "a"), 2);
      assert(result.ok, "both offset");
      const grownRectangle = result.value.addEntities.find((entity) => entity.kind === "rectangle")!;
      equal(grownRectangle.kind === "rectangle" ? grownRectangle.widthMm : 0, 24, "width grows by twice the distance");
      equal(grownRectangle.kind === "rectangle" ? grownRectangle.heightMm : 0, 14, "height too");
      const grownArc = result.value.addEntities.find((entity) => entity.kind === "arc")!;
      assert(grownArc.kind === "arc", "an arc");
      near(Math.hypot(grownArc.mid[0], grownArc.mid[1]), 12, 1e-9, "the arc's radius grows from 10 to 12");
    }
  },
  {
    name: "mirror copies entities across a line and records symmetric relations that hold",
    run: () => {
      const rectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [5, 2], widthMm: 4, heightMm: 2, rotationDeg: 30, construction: false };
      const project = projectWith([line("a", [2, 1], [5, 3]), circle("c", [4, 6], 1.5), rectangle, line("axis", [0, -10], [0, 10])]);
      const planned = mirrorEntities(context(project), ids("a", "c", "r", "axis"));
      assert(planned.ok, "mirror plans");
      equal(planned.value.addEntities.length, 3, "one copy per mirrored entity");
      equal(planned.value.addConstraints.length, 2, "line and circle get symmetric relations; the rectangle does not");
      const committed = commit(project, planned);
      assert(committed.ok, "the mirrored sketch passes the solver without moving anything");
      const copyLine = linesOf(committed.value.project).find((candidate) => candidate.id !== "entity:a" && candidate.id !== "entity:axis")!;
      nearPoint(copyLine.start, [-2, 1], "line start mirrors");
      nearPoint(copyLine.end, [-5, 3], "line end mirrors");
      const copyCircle = committed.value.project.sketch.entities.find((entity) => entity.kind === "circle" && entity.id !== "entity:c")!;
      assert(copyCircle.kind === "circle", "circle copy");
      nearPoint(copyCircle.center, [-4, 6], "centre mirrors");
      const copyRectangle = committed.value.project.sketch.entities.find((entity) => entity.kind === "rectangle" && entity.id !== "entity:r")!;
      assert(copyRectangle.kind === "rectangle", "rectangle copy");
      nearPoint(copyRectangle.center, [-5, 2], "rectangle centre mirrors");
      near(copyRectangle.rotationDeg, 150, 1e-9, "a mirrored 30 degree rectangle sits at 150 degrees");
      assert(!mirrorEntities(context(project), ids("a")).ok, "a lone selection has no mirror line");
      assert(!mirrorEntities(context(project), ids("a", "c")).ok, "the last selection must be a line");
    }
  },
  {
    name: "rectangular and circular patterns place copies at the expected positions",
    run: () => {
      const project = projectWith([circle("c", [10, 0], 2)]);
      const grid = patternEntities(context(project), ids("c"), { kind: "rectangular", countX: 3, countY: 2, dxMm: 10, dyMm: 5 });
      assert(grid.ok, "grid pattern plans");
      equal(grid.value.addEntities.length, 5, "3 x 2 instances means five copies");
      const centres = grid.value.addEntities.map((entity) => (entity.kind === "circle" ? entity.center : [NaN, NaN] as const)).map(([x, y]) => `${x},${y}`).sort();
      equal(centres.join("|"), ["10,5", "20,0", "20,5", "30,0", "30,5"].sort().join("|"), "grid positions");
      const around = patternEntities(context(project), ids("c"), { kind: "circular", count: 4, angleDeg: 360, center: [0, 0] });
      assert(around.ok, "circular pattern plans");
      const ring = around.value.addEntities.map((entity) => (entity.kind === "circle" ? entity.center : [NaN, NaN] as const));
      nearPoint(ring[0]!, [0, 10], "90 degrees", 1e-9);
      nearPoint(ring[1]!, [-10, 0], "180 degrees", 1e-9);
      nearPoint(ring[2]!, [0, -10], "270 degrees", 1e-9);
      const arcOnly = patternEntities(context(project), ids("c"), { kind: "circular", count: 3, angleDeg: 90, center: [0, 0] });
      assert(arcOnly.ok, "a partial sweep plans");
      nearPoint((arcOnly.value.addEntities[1] as unknown as { center: [number, number] }).center, [0, 10], "the last instance lands at the full angle");
      assert(!patternEntities(context(project), ids("c"), { kind: "rectangular", countX: 1, countY: 1, dxMm: 5, dyMm: 5 }).ok, "one instance is not a pattern");
      assert(!patternEntities(context(project), ids("c"), { kind: "rectangular", countX: 20, countY: 20, dxMm: 5, dyMm: 5 }).ok, "pattern size is bounded");
      const rotatedRectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [10, 0], widthMm: 4, heightMm: 2, rotationDeg: 0, construction: false };
      const rotated = patternEntities(context(projectWith([rotatedRectangle])), ids("r"), { kind: "circular", count: 2, angleDeg: 90, center: [0, 0] });
      assert(rotated.ok && rotated.value.addEntities[0]!.kind === "rectangle" && (rotated.value.addEntities[0] as { rotationDeg: number }).rotationDeg === 90, "rectangles rotate with the pattern");
    }
  },
  {
    name: "corner extends and trims two lines to meet exactly",
    run: () => {
      const project = projectWith([line("a", [0, 0], [8, 0]), line("b", [10, 2], [10, 10])]);
      const result = commit(project, cornerLines(context(project), ids("a", "b")));
      assert(result.ok, "corner applies");
      nearPoint(entityOf(result.value.project, "entity:a", "line").end, [10, 0], "the first line extends to the corner");
      nearPoint(entityOf(result.value.project, "entity:b", "line").start, [10, 0], "the second line extends down to the corner");
      assert(!cornerLines(context(projectWith([line("a", [0, 0], [8, 0]), line("b", [0, 5], [8, 5])])), ids("a", "b")).ok, "parallel lines never meet");
      assert(!cornerLines(context(result.value.project), ids("a", "b")).ok, "lines that already meet are refused");
    }
  },
  {
    name: "fillet replaces a corner with a tangent arc and chamfer with a straight cut",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])]);
      const filleted = commit(project, filletCorners(context(project), ids("a", "b"), 2));
      assert(filleted.ok, "fillet applies");
      nearPoint(entityOf(filleted.value.project, "entity:a", "line").end, [8, 0], "the first line stops at the tangent point");
      nearPoint(entityOf(filleted.value.project, "entity:b", "line").start, [10, 2], "the second line starts at its tangent point");
      const arc = filleted.value.project.sketch.entities.find((entity) => entity.kind === "arc")!;
      assert(arc.kind === "arc", "an arc was added");
      nearPoint(arc.start, [8, 0], "arc starts at the first tangent point");
      nearPoint(arc.end, [10, 2], "arc ends at the second");
      nearPoint(arc.mid, [8 + Math.SQRT2, 2 - Math.SQRT2], "the midpoint sits on the circle of radius 2 about (8, 2)", 1e-9);
      assert(!filletCorners(context(project), ids("a", "b"), 20).ok, "a radius larger than the lines is rejected");

      const chamfered = commit(project, chamferCorners(context(project), ids("a", "b"), 3));
      assert(chamfered.ok, "chamfer applies");
      nearPoint(entityOf(chamfered.value.project, "entity:a", "line").end, [7, 0], "the first line stops 3 mm from the corner");
      const cut = linesOf(chamfered.value.project).find((candidate) => candidate.id !== "entity:a" && candidate.id !== "entity:b")!;
      nearPoint(cut.start, [7, 0], "the chamfer starts there");
      nearPoint(cut.end, [10, 3], "and ends 3 mm up the other line");
    }
  },
  {
    name: "fillet and chamfer round a whole rectangle into lines and arcs that still form one profile",
    run: () => {
      const rectangle: SketchEntity = { id: "entity:r", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
      const project = projectWith([rectangle]);
      const rounded = commit(project, filletCorners(context(project), ids("r"), 2));
      assert(rounded.ok, "rectangle fillet applies");
      equal(rounded.value.project.sketch.entities.length, 8, "four lines and four arcs replace the rectangle");
      const profiles = detectSketchProfiles(rounded.value.project.sketch);
      equal(profiles.length, 1, "the rounded rectangle is one closed profile");
      equal(profiles[0]!.boundary.kind, "curve-loop", "with arcs in it");
      near(profiles[0]!.areaMm2, 200 - (4 - Math.PI) * 4, 0.3, "area is the rectangle minus the corner slivers (within facet error)");
      const beveled = commit(project, chamferCorners(context(project), ids("r"), 2));
      assert(beveled.ok, "rectangle chamfer applies");
      equal(beveled.value.project.sketch.entities.length, 8, "eight lines");
      near(detectSketchProfiles(beveled.value.project.sketch)[0]!.areaMm2, 200 - 4 * 2, 1e-6, "four right-triangle corners of 2 mm legs are removed");
      assert(!filletCorners(context(project), ids("r"), 6).ok, "more than half the short side is rejected");
    }
  },
  {
    name: "trim removes the picked part of a line between its neighbouring crossings",
    run: () => {
      const crossings = [line("h", [0, 0], [10, 0]), line("v1", [4, -5], [4, 5]), line("v2", [7, -5], [7, 5])];
      const project = projectWith(crossings);
      const middle = commit(project, trimAt(context(project), "entity:h", [5.5, 0]));
      assert(middle.ok, "trimming between two crossings applies");
      const pieces = linesOf(middle.value.project).filter((candidate) => !candidate.id.startsWith("entity:v"));
      equal(pieces.length, 2, "the line splits in two");
      nearPoint(entityOf(middle.value.project, "entity:h", "line").end, [4, 0], "the first piece ends at the first crossing");
      assert(pieces.some((piece) => Math.abs(piece.start[0] - 7) < 1e-9 && Math.abs(piece.end[0] - 10) < 1e-9), "the second piece runs from the second crossing to the end");

      const start = commit(project, trimAt(context(project), "entity:h", [1, 0]));
      assert(start.ok, "trimming the start applies");
      nearPoint(entityOf(start.value.project, "entity:h", "line").start, [4, 0], "the start moves to the first crossing");
      const end = commit(project, trimAt(context(project), "entity:h", [9, 0]));
      assert(end.ok, "trimming the end applies");
      nearPoint(entityOf(end.value.project, "entity:h", "line").end, [7, 0], "the end moves to the last crossing");
      const alone = projectWith([line("h", [0, 0], [10, 0])]);
      const gone = commit(alone, trimAt(context(alone), "entity:h", [5, 0]));
      assert(gone.ok && gone.value.project.sketch.entities.length === 0, "a line nothing crosses is deleted");
    }
  },
  {
    name: "trim turns a crossed circle into the arc that remains, and shortens a crossed arc",
    run: () => {
      const project = projectWith([circle("c", [0, 0], 5), line("cut", [3, -10], [3, 10])]);
      const trimmed = commit(project, trimAt(context(project), "entity:c", [5, 0]));
      assert(trimmed.ok, "circle trim applies");
      assert(!trimmed.value.project.sketch.entities.some((entity) => entity.id === "entity:c"), "the circle is replaced");
      const arc = trimmed.value.project.sketch.entities.find((entity) => entity.kind === "arc")!;
      assert(arc.kind === "arc", "by an arc");
      nearPoint(arc.start, [3, 4], "the arc starts at the upper crossing", 1e-9);
      nearPoint(arc.end, [3, -4], "and ends at the lower one", 1e-9);
      nearPoint(arc.mid, [-5, 0], "going the long way round, away from the pick", 1e-9);
      const single = projectWith([circle("c", [0, 0], 5), line("cut", [20, -10], [20, 10])]);
      assert(!trimAt(context(single), "entity:c", [5, 0]).ok, "a circle nothing crosses cannot be trimmed");

      const half = projectWith([{ id: "entity:a", kind: "arc", start: [5, 0], mid: [0, 5], end: [-5, 0], construction: false }, line("cut", [3, -10], [3, 10])]);
      const shortened = commit(half, trimAt(context(half), "entity:a", [4.9, 1]));
      assert(shortened.ok, "arc trim applies");
      const rest = entityOf(shortened.value.project, "entity:a", "arc");
      nearPoint(rest.start, [3, 4], "the arc now starts at the crossing", 1e-9);
      nearPoint(rest.end, [-5, 0], "and keeps its far end", 1e-9);
    }
  },
  {
    name: "extend lengthens the end nearest the pick to the first curve beyond it",
    run: () => {
      const project = projectWith([line("a", [0, 0], [5, 0]), line("wall", [8, -3], [8, 3])]);
      const result = commit(project, extendAt(context(project), "entity:a", [4.5, 0]));
      assert(result.ok, "extend applies");
      nearPoint(entityOf(result.value.project, "entity:a", "line").end, [8, 0], "the end reaches the wall");
      assert(!extendAt(context(project), "entity:a", [0.2, 0]).ok, "nothing lies beyond the start, so it cannot extend");
    }
  },
  {
    name: "an edit that would break a recorded relation is refused until the relation is relaxed",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10]), line("c", [20, 0], [20, 10])],
        [{ id: "constraint:equal-bc", kind: "equal", entityIds: ["entity:b", "entity:c"] }]
      );
      const blocked = commit(project, filletCorners(context(project), ids("a", "b"), 2));
      assert(!blocked.ok, "the fillet shortens b, which would break equal(b, c)");
      equal(blocked.diagnostics[0]?.code, "CONSTRAINT_CONFLICT", "typed as a conflict");
      assert(blocked.diagnostics[0]!.recovery.includes("Relax Relations"), "and points at the fix");

      const relaxIds = constraintsOnEntities(project.sketch, ["entity:b"], "relations", false);
      equal(relaxIds.length, 1, "the relation is found on the selected entity");
      const relaxed = applyWorkbenchOperation(project, { kind: "set-sketch-constraints-suppressed", operationId: "operation:test-relax", expectedRevision: project.revision, constraintIds: relaxIds, suppressed: true });
      assert(relaxed.ok, "relaxing applies");
      const retry = commit(relaxed.value.project, filletCorners(context(relaxed.value.project), ids("a", "b"), 2));
      assert(retry.ok, "with the relation relaxed the fillet goes through");
      equal(constraintsOnEntities(retry.value.project.sketch, ["entity:b"], "relations", true).length, 1, "and the relation stays recorded as relaxed");
    }
  },
  {
    name: "relaxing ignores a relation in the solver and the degree-of-freedom estimate, and restoring re-applies it",
    run: () => {
      const base = projectWith([line("rail", [-20, 0], [20, 0]), circle("wheel", [0, 7], 3)], [{ id: "constraint:tangent", kind: "tangent", entityIds: ["entity:rail", "entity:wheel"] }]);
      const before = analyzeWorkbenchSketch(base.sketch).degreesOfFreedom;
      const relaxed = applyWorkbenchOperation(base, { kind: "set-sketch-constraints-suppressed", operationId: "operation:test-relax-2", expectedRevision: base.revision, constraintIds: ["constraint:tangent"], suppressed: true });
      assert(relaxed.ok, "relaxing applies");
      assert(analyzeWorkbenchSketch(relaxed.value.project.sketch).degreesOfFreedom > before, "a relaxed relation no longer removes freedom");
      near(entityOf(relaxed.value.project, "entity:wheel", "circle").radiusMm, 3, 1e-12, "relaxing never moves geometry");
      const restored = applyWorkbenchOperation(relaxed.value.project, { kind: "set-sketch-constraints-suppressed", operationId: "operation:test-restore", expectedRevision: relaxed.value.project.revision, constraintIds: ["constraint:tangent"], suppressed: false });
      assert(restored.ok, "restoring applies");
      near(entityOf(restored.value.project, "entity:wheel", "circle").radiusMm, 7, 1e-9, "restoring re-applies the relation");
      assert(restored.value.summary.includes("Restored"), restored.value.summary);
      const missing = applyWorkbenchOperation(base, { kind: "set-sketch-constraints-suppressed", operationId: "operation:test-missing", expectedRevision: base.revision, constraintIds: ["constraint:nope"], suppressed: true });
      assert(!missing.ok, "an unknown constraint is a broken reference");
    }
  },
  {
    name: "sketch checking reports open ends, tiny and duplicate curves, unsolved relations and the DOF state",
    run: () => {
      const closed = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10]), line("c", [10, 10], [0, 0])]);
      const clean = checkSketch(closed.sketch);
      equal(clean.errors, 0, "a closed triangle has no errors");
      assert(!clean.items.some((item) => item.message.startsWith("Open end")), "and no open ends");
      assert(clean.items.some((item) => item.message.includes("1 closed profile")), "it reports the profile count");

      const messy = projectWith(
        [line("open", [0, 0], [10, 0]), line("twin", [0, 0], [10, 0]), line("stray", [100, 100], [110, 100]), line("tiny", [30, 30], [30.05, 30]), circle("dot", [50, 0], 0.05)],
        [{ id: "constraint:rigid", kind: "horizontal", entityIds: ["entity:open"] }, { id: "constraint:weird", kind: "coincident", entityIds: ["entity:open", "entity:twin"] }]
      );
      const report = checkSketch(messy.sketch);
      assert(report.items.some((item) => item.message.startsWith("Open end")), "open ends are reported");
      assert(report.items.some((item) => item.message.includes("drawn twice")), "duplicates are reported");
      assert(report.items.some((item) => item.message.includes("shorter than 0.1 mm")), "tiny lines are reported");
      assert(report.items.some((item) => item.message.includes("radius under 0.1 mm")), "tiny circles are reported");
      assert(report.items.some((item) => item.message.startsWith("Recorded, not solved")), "unsolvable relations are reported");
      assert(report.items.some((item) => item.message.startsWith("Estimated degrees of freedom")), "the DOF estimate is reported");
      assert(report.warnings >= 5, "all of those are warnings");
    }
  },
  {
    name: "click picking finds the nearest curve within tolerance and ignores hidden ones",
    run: () => {
      const hidden: SketchEntity = { ...(line("hidden", [0, 1], [10, 1]) as Extract<SketchEntity, { kind: "line" }>), visible: false };
      const project = projectWith([line("a", [0, 0], [10, 0]), hidden, circle("c", [0, 20], 5)]);
      equal(nearestEntityId(project.sketch, [5, 0.2], 1), "entity:a", "a point beside the line picks it");
      equal(nearestEntityId(project.sketch, [5, 0.9], 1), "entity:a", "hidden curves are skipped");
      equal(nearestEntityId(project.sketch, [5, 5], 1), undefined, "nothing within tolerance");
      equal(nearestEntityId(project.sketch, [5, 20], 1), "entity:c", "a point on the circle picks it");
    }
  },
  {
    name: "points and splines are sketch entities; a spline closes a profile and extrudes like an arc",
    run: () => {
      const fit: readonly (readonly [number, number])[] = [[0, 0], [5, 4], [10, 0]];
      const samples = sampleSpline(fit);
      assert(samples.length > 10, "the spline is sampled into short edges");
      nearPoint(samples[0]!, [0, 0], "the first sample is the first fit point");
      nearPoint(samples[samples.length - 1]!, [10, 0], "the last sample is the last fit point");
      assert(samples.some((sample) => Math.abs(sample[0] - 5) < 0.6 && sample[1] > 3.5), "the curve rises through the middle point");

      const spline: SketchEntity = { id: "entity:sp", kind: "spline", fitPoints: fit, construction: false };
      const point: SketchEntity = { id: "entity:pt", kind: "point", point: [3, 3], construction: true };
      const project = projectWith([spline, line("base", [10, 0], [0, 0]), point]);
      const profiles = detectSketchProfiles(project.sketch);
      equal(profiles.length, 1, "the spline and its chord close one profile");
      const boundary = profiles[0]!.boundary;
      assert(boundary.kind === "curve-loop" && boundary.segments.some((segment) => segment.kind === "spline"), "the spline is its own segment");
      assert(profiles[0]!.areaMm2 > 20, "with the area under the curve");

      const added = applyWorkbenchOperation(createWorkbenchProject("project:test-point"), { kind: "add-sketch-entity", operationId: "operation:test-point", expectedRevision: 0, entity: point });
      assert(added.ok, "a point entity validates");
      const tooFew = applyWorkbenchOperation(createWorkbenchProject("project:test-spline"), { kind: "add-sketch-entity", operationId: "operation:test-spline", expectedRevision: 0, entity: { id: "entity:bad", kind: "spline", fitPoints: [[0, 0], [1, 1]], construction: false } });
      assert(!tooFew.ok, "a spline needs at least three fit points");
    }
  }
];
