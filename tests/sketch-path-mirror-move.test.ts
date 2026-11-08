import type { DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, designOf } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { buildPolygon, buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { withDynamicMirror, resolveMirrorAxis, mirrorPoints } from "../packages/workbench-sketch/src/dynamic-mirror.js";
import { describePath, healPathGaps, makePath, pathToSpline } from "../packages/workbench-sketch/src/make-path.js";
import { offsetMoveEntities } from "../packages/workbench-sketch/src/offset-move.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { arc, circle, commit, commitOk, constraint, context, entityOf, line, linesOf, newId, planOf, projectWith, relationsHold } from "./sketch-edit-kit.js";

function near2(actual: readonly [number, number], expected: readonly [number, number], message: string, tolerance = 1e-9): void {
  near(actual[0], expected[0], tolerance, `${message} (x)`);
  near(actual[1], expected[1], tolerance, `${message} (y)`);
}

/** A closed square of four lines with coincident corners and horizontal / vertical sides. */
function squareRegion(): { readonly entities: SketchEntity[]; readonly constraints: ReturnType<typeof constraint>[] } {
  const entities = [line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10], [0, 0])];
  const constraints = [
    constraint("c01", "coincident", ["s0", "s1"], { points: ["end", "start"] }),
    constraint("c12", "coincident", ["s1", "s2"], { points: ["end", "start"] }),
    constraint("c23", "coincident", ["s2", "s3"], { points: ["end", "start"] }),
    constraint("c30", "coincident", ["s3", "s0"], { points: ["end", "start"] }),
    constraint("h0", "horizontal", ["s0"]), constraint("v1", "vertical", ["s1"]), constraint("h2", "horizontal", ["s2"]), constraint("v3", "vertical", ["s3"])
  ];
  return { entities, constraints };
}

let serial = 0;
function runOp(project: WorkbenchProject, operation: Record<string, unknown>): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:path-test-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${String(operation.kind)} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

export const sketchPathMirrorMoveTests: readonly TestCase[] = [
  {
    name: "offset-move grows a closed region in place: same ids, joints and orientations kept, area changes",
    run: () => {
      const region = squareRegion();
      const project = projectWith(region.entities, region.constraints);
      const ids = region.entities.map((entity) => entity.id);
      const grown = commitOk(project, offsetMoveEntities(context(project), ids, { kind: "offset", distanceMm: 2 }));
      equal(grown.sketch.entities.length, 4, "no copies were made");
      assert(ids.every((id) => grown.sketch.entities.some((entity) => entity.id === id)), "every original id survives");
      const profiles = detectSketchProfiles(grown.sketch);
      equal(profiles.length, 1, "still one closed profile");
      near(profiles[0]!.areaMm2, 14 * 14, 1e-6, "the region grew by 2 mm on every side");
      assert(relationsHold(grown), "the joints and the horizontal / vertical relations all still hold");
      const shrunk = commitOk(project, offsetMoveEntities(context(project), ids, { kind: "offset", distanceMm: -2 }));
      near(detectSketchProfiles(shrunk.sketch)[0]!.areaMm2, 36, 1e-6, "a negative distance shrinks it");
      assert(!offsetMoveEntities(context(project), ids, { kind: "offset", distanceMm: -6 }).ok, "collapsing the region is refused");
    }
  },
  {
    name: "offset-move of one wall stretches the lines attached to it along their own direction",
    run: () => {
      const project = projectWith(
        [line("a", [0, 0], [10, 0]), line("c", [10, 0], [10, 10]), line("b", [10, 10], [0, 10])],
        [constraint("ac", "coincident", ["a", "c"], { points: ["end", "start"] }), constraint("cb", "coincident", ["c", "b"], { points: ["end", "start"] }), constraint("ha", "horizontal", ["a"]), constraint("vc", "vertical", ["c"]), constraint("hb", "horizontal", ["b"])]
      );
      const inward = commitOk(project, offsetMoveEntities(context(project), ["entity:c"], { kind: "offset", distanceMm: 2 }));
      near2(entityOf(inward, "entity:c", "line").start, [8, 0], "the wall moved to the left of its direction");
      near2(entityOf(inward, "entity:c", "line").end, [8, 10], "and kept its height");
      near2(entityOf(inward, "entity:a", "line").end, [8, 0], "the bottom line is trimmed back to meet it");
      near2(entityOf(inward, "entity:b", "line").start, [8, 10], "the top line is trimmed back too");
      assert(relationsHold(inward), "horizontal and vertical relations still hold");
      const outward = commitOk(project, offsetMoveEntities(context(project), ["entity:c"], { kind: "offset", distanceMm: -3 }));
      near2(entityOf(outward, "entity:a", "line").end, [13, 0], "a negative distance extends the neighbours instead");
      equal(linesOf(outward).length, 3, "no lines were added");
    }
  },
  {
    name: "offset-move refuses an arc or spline neighbour it cannot stretch, and a joined arc it would tear off",
    run: () => {
      const project = projectWith([line("a", [0, 0], [10, 0]), arc("q", [10, 0], [10 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2], [20, 10])]);
      assert(!offsetMoveEntities(context(project), ["entity:a"], { kind: "offset", distanceMm: 1 }).ok, "a line whose end meets an arc cannot be offset-moved with it attached");
      assert(!offsetMoveEntities(context(project), ["entity:q"], { kind: "offset", distanceMm: 1 }).ok, "an arc joined to a line cannot be moved in place");
      const ellipse: SketchEntity = { id: "entity:e", kind: "ellipse", center: [0, 0], majorRadiusMm: 3, minorRadiusMm: 2, rotationDeg: 0, construction: false };
      assert(!offsetMoveEntities(context(projectWith([ellipse])), ["entity:e"], { kind: "offset", distanceMm: 1 }).ok, "an ellipse is refused");
      const lone = projectWith([circle("c", [0, 0], 5)]);
      const bigger = commitOk(lone, offsetMoveEntities(context(lone), ["entity:c"], { kind: "offset", distanceMm: 2 }));
      near(entityOf(bigger, "entity:c", "circle").radiusMm, 7, 1e-12, "a free circle simply grows");
    }
  },
  {
    name: "offset-move by a vector carries the region and lets attached lines follow its corner",
    run: () => {
      const region = squareRegion();
      const tail = line("t", [10, 10], [20, 10]);
      const project = projectWith([...region.entities, tail], [...region.constraints, constraint("ct", "coincident", ["s1", "t"], { points: ["end", "start"] }), constraint("ht", "horizontal", ["t"])]);
      const ids = region.entities.map((entity) => entity.id);
      const moved = commitOk(project, offsetMoveEntities(context(project), ids, { kind: "vector", dxMm: 5, dyMm: 0 }));
      near2(entityOf(moved, "entity:s0", "line").start, [5, 0], "the region moved");
      near2(entityOf(moved, "entity:t", "line").start, [15, 10], "the tail's attached end followed");
      near2(entityOf(moved, "entity:t", "line").end, [20, 10], "its far end stayed");
      assert(relationsHold(moved), "relations hold");
      const slanted = commit(project, offsetMoveEntities(context(project), ids, { kind: "vector", dxMm: 5, dyMm: 3 }));
      assert(!slanted.ok, "a move that would tilt the tail's horizontal relation is refused by the operation");
      assert(slanted.ok === false && slanted.diagnostics[0]!.message.length > 10, "with a reason");
    }
  },
  {
    name: "make path chains scrambled curves into one ordered path, flags the gap, and measures it",
    run: () => {
      const l1 = line("l1", [0, 0], [10, 0]);
      const q = arc("q", [10, 0], [10 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2], [20, 10]);
      const l2 = line("l2", [20.3, 10], [20.3, 30]);
      const project = projectWith([l2, q, l1]);
      const path = makePath(project.sketch, ["entity:l2", "entity:l1", "entity:q"]);
      assert(path.ok, "a path is found");
      if (!path.ok) return;
      const order = path.value.segments.map((segment) => segment.entityId);
      assert(JSON.stringify(order) === JSON.stringify(["entity:l1", "entity:q", "entity:l2"]) || JSON.stringify(order) === JSON.stringify(["entity:l2", "entity:q", "entity:l1"]), `chain order follows the geometry, not the selection order (${order.join(",")})`);
      equal(path.value.closed, false, "an open path");
      equal(path.value.complete, true, "every selected curve is on it");
      equal(path.value.gaps.length, 1, "one gap");
      near(path.value.gaps[0]!.distanceMm, 0.3, 1e-9, "of 0.3 mm");
      near(path.value.lengthMm, 10 + (Math.PI / 2) * 10 + 20, 0.1, "length is the sum of the curves");
      const ends = [path.value.samples[0]!, path.value.samples[path.value.samples.length - 1]!].sort((a, b) => a[0] - b[0]);
      near2(ends[0]!, [0, 0], "one end of the polyline", 1e-9);
      near2(ends[1]!, [20.3, 30], "the other end", 1e-9);
      assert(describePath(path.value).some((text) => text.includes("Gap of 0.3")), "the report mentions the gap");
    }
  },
  {
    name: "heal path gaps closes the gap through the operation, and the path is then gap-free",
    run: () => {
      const l1 = line("l1", [0, 0], [10, 0]);
      const l2 = line("l2", [10.4, 0], [10.4, 8]);
      const l3 = line("l3", [10.4, 8.2], [0, 8.2]);
      const project = projectWith([l1, l2, l3]);
      const path = makePath(project.sketch, ["entity:l1", "entity:l2", "entity:l3"]);
      assert(path.ok && path.value.gaps.length === 2, "two gaps found");
      if (!path.ok) return;
      const healed = commitOk(project, healPathGaps(context(project), path.value));
      const again = makePath(healed.sketch, ["entity:l1", "entity:l2", "entity:l3"]);
      assert(again.ok && again.value.gaps.length === 0, "no gaps after healing");
      if (!again.ok) return;
      assert(healed.sketch.constraints.filter((c) => c.kind === "coincident").length >= 2, "the joints are recorded as coincident relations");
      assert(relationsHold(healed), "relations hold");
      assert(!healPathGaps(context(healed), again.value).ok, "healing a gap-free path says there is nothing to do");
    }
  },
  {
    name: "make path reports a closed loop, a branch and a curve that does not connect",
    run: () => {
      const region = squareRegion();
      const loop = makePath(projectWith(region.entities).sketch, region.entities.map((entity) => entity.id));
      assert(loop.ok && loop.value.closed && loop.value.gaps.length === 0, "a square is a closed loop");
      const withStray = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 0]), line("z", [50, 50], [60, 60])]);
      const stray = makePath(withStray.sketch, ["entity:a", "entity:b", "entity:z"]);
      assert(stray.ok && !stray.value.complete && stray.value.unlinkedIds.includes("entity:z"), "the stray line is left out");
      const fork = projectWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 5]), line("c", [10, 0], [20, -5])]);
      const forked = makePath(fork.sketch, ["entity:a", "entity:b", "entity:c"]);
      assert(forked.ok && forked.value.branchPoints.length >= 1, "the fork is flagged as a branch");
      assert(!makePath(withStray.sketch, []).ok, "an empty selection is refused");
      assert(!makePath(projectWith([circle("c", [0, 0], 4)]).sketch, ["entity:c"]).ok, "a circle cannot be part of a path");
    }
  },
  {
    name: "a made path joined into one spline is a real sweep path: the sweep builds a solid that follows it",
    run: async () => {
      // A profile circle plus an L-shaped chain of a line and an arc to sweep it along.
      const profile = circle("prof", [0, 0], 1);
      const l1 = line("p1", [0, 0], [20, 0]);
      const q = arc("p2", [20, 0], [20 + 10 * Math.SQRT1_2, 10 - 10 * Math.SQRT1_2], [30, 10]);
      let project = projectWith([profile, l1, q]);
      const path = makePath(project.sketch, ["entity:p1", "entity:p2"]);
      assert(path.ok, "the chain is a path");
      if (!path.ok) return;
      const joined = planOf(pathToSpline(context(project), path.value));
      const splineId = joined.addEntities[0]!.id;
      project = commitOk(project, joined);
      project = runOp(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketchFeature = designOf(project).features.find((feature) => feature.kind === "sketch");
      assert(sketchFeature !== undefined && sketchFeature.kind === "sketch", "sketch committed");
      if (sketchFeature === undefined || sketchFeature.kind !== "sketch") return;
      const profileId = detectSketchProfiles(sketchFeature.sketch).find((candidate) => candidate.boundary.kind === "circle")!.id;
      const feature: DesignSolidFeature = { id: "feature:sweep-1", name: "Sweep 1", kind: "sweep", suppressed: false, sketchFeatureId: sketchFeature.id, profileIds: [profileId], valueMm: 1, bodyId: "general-body:sweep", sweepPathEntityId: splineId };
      const built = await rebuildSolidFeature(feature, sketchFeature);
      assert(built.ok, `the sweep builds along the made path: ${built.ok ? "" : built.message}`);
      if (!built.ok) return;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < built.body.positionsMm.length; index += 3) { maxX = Math.max(maxX, built.body.positionsMm[index]!); maxY = Math.max(maxY, built.body.positionsMm[index + 1]!); }
      assert(maxX > 25, `the solid runs along the path to x ~ 30 (got ${maxX.toFixed(2)})`);
      assert(maxY > 8, `and up the arc to y ~ 10 (got ${maxY.toFixed(2)})`);
    }
  },
  {
    name: "dynamic mirror draws a line and its mirror image together, linked by a symmetry relation",
    run: () => {
      const axis = line("axis", [0, -20], [0, 20]);
      const project = projectWith([axis]);
      const drawn = { label: "Added Line", removeEntityIds: [], updateEntities: [], addEntities: [line("new", [5, 0], [9, 6])], addConstraints: [] };
      const outcome = withDynamicMirror(context(project), "entity:axis", drawn);
      equal(outcome.mirrored, 1, "one image");
      assert(outcome.plan.label.includes("mirrored"), "the label says so");
      const next = commitOk(project, outcome.plan);
      const image = linesOf(next).find((candidate) => candidate.id !== "entity:axis" && candidate.id !== "entity:new")!;
      near2(image.start, [-5, 0], "image start");
      near2(image.end, [-9, 6], "image end");
      assert(next.sketch.constraints.some((c) => c.kind === "symmetry" && c.entityIds.includes("entity:new") && c.entityIds.includes(image.id) && c.entityIds.includes("entity:axis")), "the pair is symmetric about the axis");
      assert(relationsHold(next), "relations hold");
      // Editing one side through the solver moves the other: the relation is live, not a one-off copy.
      equal(resolveMirrorAxis(next.sketch, ["entity:new", "entity:axis"])?.id, "entity:axis", "the last selected line is the axis");
      equal(resolveMirrorAxis(next.sketch, [])?.id, undefined, "no selection, no axis");
      near2(mirrorPoints(entityOf(project, "entity:axis", "line"), [[3, 4]])[0]!, [-3, 4], "the live ghost reflects points across the axis");
    }
  },
  {
    name: "dynamic mirror mirrors a slot, a polygon, a circle and a rectangle, and skips what lies on the axis",
    run: () => {
      const axis = line("axis", [0, -50], [0, 50]);
      let project = projectWith([axis]);
      const ids = { entity: () => newId("entity"), constraint: () => newId("constraint") };
      const slot = buildSlot([10, 0], [20, 0], [10, 2], ids);
      assert(slot.ok, "slot built");
      if (!slot.ok) return;
      const slotPlan = { label: "Added slot", removeEntityIds: [], updateEntities: [], addEntities: slot.value.entities, addConstraints: slot.value.constraints };
      const slotOutcome = withDynamicMirror(context(project), "entity:axis", slotPlan);
      equal(slotOutcome.mirrored, 4, "all four parts of the slot are mirrored");
      project = commitOk(project, slotOutcome.plan);
      equal(detectSketchProfiles(project.sketch).length, 2, "the slot and its image are two closed profiles");

      const polygon = buildPolygon([30, 20], [35, 20], 5, ids);
      assert(polygon.ok, "polygon built");
      if (!polygon.ok) return;
      const polyOutcome = withDynamicMirror(context(project), "entity:axis", { label: "Added polygon", removeEntityIds: [], updateEntities: [], addEntities: polygon.value.entities, addConstraints: polygon.value.constraints });
      equal(polyOutcome.mirrored, 5, "five sides mirrored");
      project = commitOk(project, polyOutcome.plan);
      equal(detectSketchProfiles(project.sketch).length, 4, "the polygon and its image add two more profiles");

      const dot: SketchEntity = { id: "entity:dot", kind: "circle", center: [15, -20], radiusMm: 3, construction: false };
      const rect: SketchEntity = { id: "entity:rect", kind: "rectangle", center: [25, -30], widthMm: 6, heightMm: 2, rotationDeg: 30, construction: false };
      const shapesOutcome = withDynamicMirror(context(project), "entity:axis", { label: "Added shapes", removeEntityIds: [], updateEntities: [], addEntities: [dot, rect], addConstraints: [] });
      project = commitOk(project, shapesOutcome.plan);
      const circles = project.sketch.entities.filter((entity) => entity.kind === "circle");
      equal(circles.length, 2, "the circle has an image");
      near2((circles.find((entity) => entity.id !== "entity:dot") as { center: readonly [number, number] }).center, [-15, -20], "at the mirrored centre");
      const rects = project.sketch.entities.filter((entity) => entity.kind === "rectangle") as Extract<SketchEntity, { kind: "rectangle" }>[];
      equal(rects.length, 2, "the rectangle has an image");
      near(Math.abs(rects.find((entity) => entity.id !== "entity:rect")!.rotationDeg), 150, 1e-9, "tilted the other way (30 deg mirrors to 150 deg)");
      assert(relationsHold(project), "all relations hold");

      const onAxis = withDynamicMirror(context(project), "entity:axis", { label: "Added line", removeEntityIds: [], updateEntities: [], addEntities: [line("spine", [0, 1], [0, 9])], addConstraints: [] });
      equal(onAxis.mirrored, 0, "a line on the axis has no separate image");
      equal(onAxis.skipped, 1, "and is reported as skipped");
      const none = withDynamicMirror(context(project), "entity:missing", slotPlan);
      equal(none.plan, slotPlan, "an unusable axis leaves the drawing plan alone");
      equal(withDynamicMirror(context(project), null, slotPlan).plan, slotPlan, "no axis, no mirroring");
    }
  }
];
