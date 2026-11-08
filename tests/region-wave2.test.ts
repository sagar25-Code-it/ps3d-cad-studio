import { isRebuildFailure, isRebuildNote, rebuildSolidFeature, replayBody } from "../apps/studio-web/src/design-regeneration.js";
import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { triangulateLoops } from "../packages/occt-kernel-adapter/src/polygon.js";
import { breakAtIntersections, detectSketchProfiles, explainNoProfiles, resolveProfileRegion } from "../packages/workbench-sketch/src/index.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { filletCorners } from "../packages/workbench-sketch/src/edit-tools.js";
import * as editKit from "./sketch-edit-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circ, line, rect, sketchFeatureOf, sketchOf, solidFeature, volumeOf } from "./region-wave2-kit.js";
import type { DesignFeature, DesignSolidFeature, SketchEntity, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validSolidFeaturePayload, MAX_PROFILE_REFS } from "../packages/workbench-core/src/index.js";
import type { SketchProfile } from "../packages/workbench-sketch/src/index.js";

/** Rebuilds a feature of the given kind on the region the picker names (its stable reference, as the sketch stores it). */
async function buildOn(entities: readonly SketchEntity[], kind: DesignSolidFeature["kind"], extra: Partial<DesignSolidFeature>, pick: (profiles: readonly SketchProfile[]) => readonly string[], plane: "xy" | "xz" | "yz" = "xy") {
  const sketch = sketchOf(entities, { plane: plane === "xy" ? "datum:xy" : plane === "xz" ? "datum:xz" : "datum:yz" });
  const profiles = detectSketchProfiles(sketch);
  return rebuildSolidFeature(solidFeature(kind, { profileIds: pick(profiles), ...extra }), sketchFeatureOf(sketch));
}
const holed = (profiles: readonly SketchProfile[]): readonly string[] => [profiles.find((profile) => (profile.holes?.length ?? 0) > 0)!.ref!];
const tube = [circ("o", [0, 0], 10), circ("i", [0, 0], 8)];

/**
 * Region engine, wave 2: the re-audit of the merged build found rows of equal holes that could not be triangulated, holes dropped
 * from sweeps, lofts, revolves and edge-treated extrusions, and warnings that never reached the timeline.
 */

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

export const regionWave2Tests: readonly TestCase[] = [
  {
    name: "region N-01: every order of a row of four equal holes triangulates, and the caps keep the plate area",
    run: () => {
      // The caps are built in a frame turned a quarter turn (the kernel's plane basis), where every hole tops out at the same x.
      const turn = (point: readonly [number, number]): readonly [number, number] => [-point[1] / 1000, point[0] / 1000];
      const circle = (cx: number, count: number): (readonly [number, number])[] => Array.from({ length: count }, (_, index) => turn([cx + 3 * Math.cos((2 * Math.PI * index) / count), 3 * Math.sin((2 * Math.PI * index) / count)])).reverse();
      const outer = ([[-100, -50], [100, -50], [100, 50], [-100, 50]] as const).map(turn);
      for (const order of permutations([0, 1, 2, 3])) {
        const holes = order.map((index) => circle(-90 + 8 * index, 72));
        const triangles = triangulateLoops(outer, holes);
        const points = [...outer, ...holes.flat()];
        let area = 0;
        for (let index = 0; index < triangles.length; index += 3) {
          const a = points[triangles[index]!]!; const b = points[triangles[index + 1]!]!; const c = points[triangles[index + 2]!]!;
          area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
        }
        const holeArea = holes.reduce((total, hole) => total + Math.abs(hole.reduce((sum, p, i) => sum + p[0] * hole[(i + 1) % hole.length]![1] - hole[(i + 1) % hole.length]![0] * p[1], 0) / 2), 0);
        near(area * 1e6, 200 * 100 - holeArea * 1e6, 1e-6, `order ${order.join("")} keeps outline minus holes`);
      }
    }
  },
  {
    name: "region N-01: the whole sweep of 210 row and grid layouts of equal holes extrudes (was 50 failures)",
    run: async () => {
      let tried = 0;
      const failed: string[] = [];
      for (const rows of [1, 2, 3]) for (const cols of [2, 3, 4, 5, 6, 8, 10]) for (const pitch of [10, 12.5, 15, 20, 25]) for (const radius of [2, 4]) {
        const width = cols * pitch + 40;
        const height = rows * pitch + 40;
        const entities = [rect("p", [0, 0], width, height)];
        for (let i = 0; i < cols; i += 1) for (let j = 0; j < rows; j += 1) entities.push(circ(`h${i}_${j}`, [-((cols - 1) * pitch) / 2 + i * pitch, -((rows - 1) * pitch) / 2 + j * pitch], radius));
        const built = await rebuildSolidFeature(solidFeature("extrude"), sketchFeatureOf(sketchOf(entities)));
        tried += 1;
        if (!built.ok) { failed.push(`${rows}x${cols}@${pitch} r${radius}: ${built.message}`); continue; }
        const expected = (width * height - cols * rows * Math.PI * radius * radius) * 10;
        near(volumeOf(built.body.positionsMm, built.body.indices), expected, expected * 0.01, `${rows}x${cols}@${pitch} r${radius}: the plate minus every hole`);
      }
      equal(tried, 210, "all 210 layouts are tried");
      equal(failed.length, 0, `no layout fails to extrude: ${failed.slice(0, 3).join(" | ")}`);
    }
  },
  {
    name: "region N-01: any order of the holes of a region builds the same plate through createGeneralSolidBody",
    run: async () => {
      const entities = [rect("p", [0, 0], 200, 100), ...[0, 1, 2, 3].map((index) => circ(`c${index}`, [-90 + 8 * index, 0], 3))];
      const region = resolveProfileRegion(detectSketchProfiles(sketchOf(entities)), [], { includeIslands: true });
      assert(region.ok, "the region resolves");
      for (const order of permutations(region.value.holes)) {
        const built = await createGeneralSolidBody({ profile: region.value.outer, holes: order, plane: "xy", operation: "extrude", valueMm: 10, bodyId: "b", name: "n", color: "#fff" });
        assert(built.ok, `hole order ${order.map((hole) => hole.entityIds[0]!.slice(-2)).join("")} builds: ${built.ok ? "" : built.message}`);
      }
    }
  },
  {
    name: "pipeline N-01: a region picked by its single reference keeps its hole in a sweep, a loft and an extrude alike",
    run: async () => {
      const ring = Math.PI * (100 - 64) * 20;
      for (const [kind, extra] of [["extrude", {}], ["sweep", { sweepDirectionMm: [0, 0, 1] }], ["loft", { loftTopScale: 1 }]] as const) {
        const built = await buildOn(tube, kind, { valueMm: 20, ...extra }, holed);
        assert(built.ok, `${kind} of the ring builds: ${built.ok ? "" : built.message}`);
        near(volumeOf(built.body.positionsMm, built.body.indices), ring, ring * 0.01, `${kind} of the ring is a tube, not a solid disc (${(Math.PI * 100 * 20).toFixed(0)})`);
      }
    }
  },
  {
    name: "pipeline N-01: a revolve of a region with a hole turns the hole into a void (full turn) or a tunnel (partial turn), on every side of the axis",
    run: async () => {
      const expectedFull = (400 - Math.PI * 9) * 2 * Math.PI * 20;
      const plate = (cx: number): SketchEntity[] => [rect("r", [cx, 10], 20, 20), circ("h", [cx, 10], 3)];
      const full = await buildOn(plate(20), "revolve", { valueMm: 360 }, holed);
      assert(full.ok, `full revolve builds: ${full.ok ? "" : full.message}`);
      near(volumeOf(full.body.positionsMm, full.body.indices), expectedFull, expectedFull * 0.005, "the full turn keeps the void (a solid torus would be 50201)");
      const quarter = await buildOn(plate(20), "revolve", { valueMm: 90 }, holed);
      assert(quarter.ok, `quarter revolve builds: ${quarter.ok ? "" : quarter.message}`);
      near(volumeOf(quarter.body.positionsMm, quarter.body.indices), expectedFull / 4, expectedFull / 4 * 0.01, "the quarter turn has the tunnel through both end faces");
      const mirrored = await buildOn(plate(-20), "revolve", { valueMm: 360 }, holed);
      assert(mirrored.ok, `a region on the negative side of the axis revolves: ${mirrored.ok ? "" : mirrored.message}`);
      near(volumeOf(mirrored.body.positionsMm, mirrored.body.indices), expectedFull, expectedFull * 0.005, "the mirror image has the same void");
      const aboutX = await buildOn([rect("r", [10, 20], 20, 20), circ("h", [10, 20], 3)], "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-axis", axis: "x" } }, holed);
      assert(aboutX.ok, `a revolve about the sketch X axis builds: ${aboutX.ok ? "" : aboutX.message}`);
      near(volumeOf(aboutX.body.positionsMm, aboutX.body.indices), expectedFull, expectedFull * 0.005, "the hole survives a revolve about the X axis");
      for (const plane of ["xz", "yz"] as const) {
        const onPlane = await buildOn(plate(20), "revolve", { valueMm: 360 }, holed, plane);
        assert(onPlane.ok, `a revolve on the ${plane} plane builds: ${onPlane.ok ? "" : onPlane.message}`);
        near(volumeOf(onPlane.body.positionsMm, onPlane.body.indices), expectedFull, expectedFull * 0.005, `the hole survives on the ${plane} plane`);
      }
    }
  },
  {
    name: "pipeline N-01: an extrude with a chamfer or fillet keeps the holes of its region and says the treatment is on the outline",
    run: async () => {
      const plate = [rect("r", [0, 0], 40, 30), circ("h", [0, 0], 4)];
      const chamfered = await buildOn(plate, "extrude", { valueMm: 20, edge: { kind: "chamfer", sizeMm: 1 } }, holed);
      assert(chamfered.ok, `a chamfered plate with a hole builds: ${chamfered.ok ? "" : chamfered.message}`);
      const expected = (1200 - 4 * 0.5 - Math.PI * 16) * 20;
      near(volumeOf(chamfered.body.positionsMm, chamfered.body.indices), expected, expected * 0.005, "the hole is cut (a filled hole would be 24000 - 100)");
      assert((chamfered.warnings ?? []).some((warning) => /holes keep their sharp edges/u.test(warning)), "it says the treatment is on the outline");
      const filleted = await buildOn(plate, "extrude", { valueMm: 20, edge: { kind: "fillet", sizeMm: 2 } }, holed);
      assert(filleted.ok, `a filleted plate with a hole builds: ${filleted.ok ? "" : filleted.message}`);
      assert(volumeOf(filleted.body.positionsMm, filleted.body.indices) < 24000 - Math.PI * 16 * 20 * 0.99, "the filleted plate has its hole too");
    }
  },
  {
    name: "pipeline N-01: a pipe swept along a two-line path from another sketch is hollow when its region is picked by one reference",
    run: async () => {
      const profileSketch = sketchFeatureOf(sketchOf(tube));
      const pathSketch = { ...sketchFeatureOf(sketchOf([line("p1", [0, 0], [0, 50]), line("p2", [0, 50], [50, 50])], { plane: "datum:xz" })), id: "feature:path", name: "Path" };
      const ref = holed(detectSketchProfiles(profileSketch.sketch));
      const feature = solidFeature("sweep", { profileIds: ref, valueMm: 50, sweepPath: { sketchFeatureId: "feature:path", entityIds: ["entity:p1", "entity:p2"] } });
      const built = await rebuildSolidFeature(feature, profileSketch, "#b9c2c8", (id) => (id === "feature:path" ? pathSketch : undefined));
      assert(built.ok, `the pipe builds: ${built.ok ? "" : built.message}`);
      const hollow = Math.PI * 36 * 100;
      near(volumeOf(built.body.positionsMm, built.body.indices), hollow, hollow * 0.03, "the pipe is a tube along 100 mm of path (a solid bar would be 31416)");
    }
  },
  {
    name: "region N-02: a hole tangent to the outline, or within the tolerance of it, is an error on the region-reference path (it used to give a full plate, even 4001 mm3 of 4000)",
    run: async () => {
      for (const cx of [6.99, 7, 7.01]) {
        const built = await buildOn([rect("r", [0, 0], 20, 20), circ("h", [cx, 0], 3)], "extrude", { valueMm: 10 }, (profiles) => [profiles[0]!.ref!]);
        assert(!built.ok, `hole at x=${cx} is refused on the reference path (it built ${built.ok ? volumeOf(built.body.positionsMm, built.body.indices).toFixed(2) : ""})`);
        assert(/hole h touches the outline/u.test(built.message), `the message names the hole and the wall: ${built.message}`);
      }
      const crescent = await buildOn([circ("o", [0, 0], 10), circ("i", [5, 0], 5)], "extrude", { valueMm: 10 }, (profiles) => [profiles[0]!.ref!]);
      assert(!crescent.ok && /hole i touches the outline/u.test(crescent.message), "an internally tangent circle is refused, not a full disc");
      const ids = await buildOn([rect("r", [0, 0], 20, 20), circ("h", [7, 0], 3)], "extrude", { valueMm: 10 }, () => []);
      assert(!ids.ok, "the empty selection refuses it too: both paths agree");
      // The region reference still notches the plate for a hole that crosses the edge.
      const crossing = await buildOn([rect("r", [0, 0], 20, 20), circ("h", [9, 0], 3)], "extrude", { valueMm: 10 }, (profiles) => [profiles[0]!.ref!]);
      assert(crossing.ok, "a crossing circle notches the plate");
      near(volumeOf(crossing.body.positionsMm, crossing.body.indices), 3799.8, 3, "the notched plate");
    }
  },
  {
    name: "region N-10: holes that touch or lie within 0.01 mm of each other are named in the message instead of a kernel role clash",
    run: async () => {
      for (const gap of [0, 0.005]) {
        const half = 5 + gap / 2;
        const built = await buildOn([rect("p", [0, 0], 40, 40), circ("a", [-half, 0], 5), circ("b", [half, 0], 5)], "extrude", { valueMm: 10 }, (profiles) => [profiles[0]!.ref!]);
        assert(!built.ok, "holes with a zero-width wall between them are refused");
        assert(/holes a and b touch/u.test(built.message) && !/roles must be unique/u.test(built.message), `the message names the holes (gap ${gap}): ${built.ok ? "" : built.message}`);
      }
      const apart = await buildOn([rect("p", [0, 0], 40, 40), circ("a", [-5.02, 0], 5), circ("b", [5.02, 0], 5)], "extrude", { valueMm: 10 }, (profiles) => [profiles[0]!.ref!]);
      assert(apart.ok, "holes 0.04 mm apart build");
      near(volumeOf(apart.body.positionsMm, apart.body.indices), (1600 - 2 * Math.PI * 25) * 10, 30, "the plate minus both holes");
    }
  },
  {
    name: "region N-03: a hole left out or a crossing circle reaches the feature's health message on replay, as a note and not as a failure",
    run: async () => {
      const BODY = "general-body:b";
      const replayed = async (entities: SketchEntity[], profileIds: (profiles: readonly SketchProfile[]) => readonly string[]) => {
        const sketch = sketchOf(entities);
        const features: DesignFeature[] = [sketchFeatureOf(sketch), solidFeature("extrude", { profileIds: profileIds(detectSketchProfiles(sketch)), bodyId: BODY })];
        const project: WorkbenchProject = { ...createWorkbenchProject("project:test-notes"), design: { features, rollbackIndex: features.length, editingSketchId: null } } as WorkbenchProject;
        return replayBody(project, BODY);
      };
      const crossing = await replayed([rect("r", [0, 0], 20, 20), circ("h", [9, 0], 3)], () => []);
      const result = crossing.find((entry) => entry.body !== undefined)!;
      assert(result.message !== undefined && /crosses the outline of r/u.test(result.message), `the crossing circle is reported: ${result.message}`);
      assert(isRebuildNote(result.message) && !isRebuildFailure(result), "and it is a note: the step was applied, so it must not block or count as a failure");
      near(volumeOf(result.body!.positionsMm, result.body!.indices), 4000, 0.01, "the plate is whole (the crossing circle is not a hole)");
      const clean = await replayed([rect("r", [0, 0], 20, 20), circ("h", [0, 0], 3)], () => []);
      assert(clean.every((entry) => entry.message === undefined), "a plain plate with a bore has no message");
      const refused = await replayed([rect("r", [0, 0], 20, 20), circ("h", [7, 0], 3)], (profiles) => [profiles[0]!.ref!]);
      assert(refused.some((entry) => isRebuildFailure(entry) && /hole h touches the outline/u.test(entry.message!)), "a failure that has a region reason carries it");
    }
  },
  {
    name: "region N-06: a feature stores a whole grid of region references (the cap was 64), through add-design-solid as well",
    run: async () => {
      const circles: SketchEntity[] = [];
      for (let index = 0; index < 70; index += 1) circles.push(circ(`c${index}`, [(index % 20) * 10, Math.floor(index / 20) * 10], 2));
      const sketch = sketchOf(circles);
      const profiles = detectSketchProfiles(sketch);
      assert(profiles.length === 70, "the grid has 70 regions");
      const feature = solidFeature("extrude", { profileIds: profiles.map((profile) => profile.ref!), valueMm: 5, sketchFeatureId: "feature:sketch-1", bodyId: "general-body:grid" });
      assert(validSolidFeaturePayload(feature) && validSolidFeaturePayload({ ...feature, profileIds: Array.from({ length: 200 }, (_, i) => `profile:c${i}_a12.566_x0_y0_h0_e`) }), "70 and 200 references are a valid payload");
      assert(validSolidFeaturePayload({ ...feature, profileIds: Array.from({ length: MAX_PROFILE_REFS }, (_, i) => `profile:c${i}`) }) && !validSolidFeaturePayload({ ...feature, profileIds: Array.from({ length: MAX_PROFILE_REFS + 1 }, (_, i) => `profile:c${i}`) }), "and the cap is the named limit");
      let project: WorkbenchProject = { ...createWorkbenchProject("project:test-grid"), sketch };
      const committed = applyWorkbenchOperation(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1", operationId: "operation:grid-1", expectedRevision: project.revision } as never);
      assert(committed.ok, `the grid sketch commits: ${committed.ok ? "" : committed.diagnostics[0]?.message}`);
      project = committed.value.project;
      const sketchFeature = project.design!.features[0]!;
      assert(sketchFeature.kind === "sketch", "the sketch is in the timeline");
      const built = await rebuildSolidFeature(feature, sketchFeature);
      assert(built.ok, `the 70 regions extrude together: ${built.ok ? "" : built.message}`);
      const added = applyWorkbenchOperation(project, { kind: "add-design-solid", feature, body: built.body, operationId: "operation:grid-2", expectedRevision: project.revision } as never);
      assert(added.ok, `add-design-solid accepts 70 references: ${added.ok ? "" : added.diagnostics[0]?.message}`);
    }
  },
  {
    name: "region N-04: a reference whose region a new line cut into pieces takes the piece that fits best and says so; equal pieces are refused by name",
    run: async () => {
      const plate = [rect("p", [0, 0], 40, 20)];
      const ref = detectSketchProfiles(sketchOf(plate))[0]!.ref!;
      const off = sketchOf([...plate, line("m", [-5, -15], [-5, 15])]);
      const matched = resolveProfileRegion(detectSketchProfiles(off), [ref], { includeIslands: true });
      assert(matched.ok, "an off-centre line leaves a best match");
      assert(matched.value.warnings.some((warning) => /63% of the original/u.test(warning)), `the region used covers 63% and the message says it: ${matched.value.warnings.join(" | ")}`);
      const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(off));
      assert(built.ok && /63%/u.test((built.warnings ?? []).join(" ")), "the rebuild carries the same note");
      const centred = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([...plate, line("m", [0, -15], [0, 15])])));
      assert(!centred.ok && /split by new geometry into 2 regions of about the same size/u.test(centred.message), `a centred line splits it into equals and the message says so: ${centred.ok ? "" : centred.message}`);
      const stub = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([...plate, line("m", [0, 10], [0, 25])])));
      assert(stub.ok && (stub.warnings ?? []).length === 0, "a line that only touches from outside changes nothing and says nothing");
    }
  },
  {
    name: "region N-05: break at intersections keeps the corner joints of the curves it splits and joins their pieces",
    run: () => {
      const joint = (id: string, a: string, b: string) => editKit.constraint(id, "coincident", [a, b], { points: ["end", "start"] });
      const project = editKit.projectWith(
        [editKit.line("a", [0, 0], [10, 0]), editKit.line("b", [10, 0], [10, 10]), editKit.line("c", [10, 10], [0, 10]), editKit.line("d", [0, 10], [0, 0]), editKit.line("x", [-2, 5], [12, 5])],
        [joint("j1", "a", "b"), joint("j2", "b", "c"), joint("j3", "c", "d"), joint("j4", "d", "a"), editKit.constraint("h", "horizontal", ["a"])]
      );
      const plan = breakAtIntersections(editKit.context(project));
      assert(plan.ok, "the square and the line cross");
      const after = editKit.commitOk(project, plan);
      const coincident = after.sketch.constraints.filter((constraint) => constraint.kind === "coincident");
      const entities = after.sketch.entities;
      const near2 = (a: readonly [number, number], b: readonly [number, number]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
      const end = (id: string, point: string | undefined): readonly [number, number] => {
        const entity = entities.find((candidate) => candidate.id === id);
        assert(entity !== undefined && entity.kind === "line", "a joint names a line that exists");
        return point === "start" ? entity.start : entity.end;
      };
      // Every corner of the square is still held by a joint between the two pieces that meet there.
      for (const corner of [[0, 0], [10, 0], [10, 10], [0, 10]] as const) {
        const held = coincident.some((constraint) => constraint.entityIds.length === 2 && constraint.entityIds.every((id, position) => near2(end(id, constraint.points?.[position]), corner)));
        assert(held, `the corner (${corner.join(", ")}) is still joined`);
      }
      assert(coincident.length >= 4 + 2, `corner joints plus the joints between pieces (${coincident.length})`);
      assert(after.sketch.constraints.length >= project.sketch.constraints.length, "no relation was lost on the way");
      assert(editKit.relationsHold(after), "all the relations still hold");
    }
  },
  {
    name: "region N-07: Validate Sketch lists the crossings of a grid as one entry, not one per crossing",
    run: () => {
      for (const n of [5, 20]) {
        const entities: SketchEntity[] = [];
        for (let i = 0; i <= n; i += 1) entities.push(line(`h${i}`, [0, i * 10], [n * 10, i * 10]), line(`v${i}`, [i * 10, 0], [i * 10, n * 10]));
        const report = analyzeSketch(editKit.context(editKit.projectWith(entities)));
        const crossings = report.issues.filter((issue) => issue.category === "region" && issue.severity === "info");
        assert(report.issues.length <= 2, `a ${n}x${n} grid has ${report.issues.length} entries (it had one per crossing)`);
        assert(crossings.length === 1 && /Curves (cross|meet)/u.test(crossings[0]!.title), `the crossings are one entry: ${crossings.map((issue) => issue.title).join(" | ")}`);
        assert(report.closedProfiles === n * n, "and the regions are all counted");
      }
    }
  },
  {
    name: "region N-08: a two-profile loft of identical squares does not twist, whatever corner each outline starts at",
    run: async () => {
      const square = (prefix: string, points: readonly (readonly [number, number])[]): SketchEntity[] => points.map((point, index) => line(`${prefix}${index}`, point, points[(index + 1) % points.length]!));
      const first = square("a", [[0, 0], [10, 0], [10, 10], [0, 10]]);
      const variants: Record<string, SketchEntity[]> = {
        "same start": square("b", [[30, 30], [40, 30], [40, 40], [30, 40]]),
        "starting at the top right": square("b", [[40, 40], [30, 40], [30, 30], [40, 30]]),
        "drawn clockwise": square("b", [[30, 30], [30, 40], [40, 40], [40, 30]]),
        "starting at the bottom right, clockwise": square("b", [[40, 30], [30, 30], [30, 40], [40, 40]])
      };
      for (const [name, second] of Object.entries(variants)) {
        const sketch = sketchOf([...first, ...second]);
        const profiles = detectSketchProfiles(sketch);
        const bottom = profiles.find((profile) => profile.centroid[0] < 20)!;
        const top = profiles.find((profile) => profile.centroid[0] > 20)!;
        const built = await rebuildSolidFeature(solidFeature("loft", { profileIds: [bottom.id], loftSecondaryProfileIds: [top.id] }), sketchFeatureOf(sketch));
        assert(built.ok, `${name}: the loft builds`);
        near(volumeOf(built.body.positionsMm, built.body.indices), 1000, 1, `${name}: a straight prism of 1000 mm3, not a twisted 333`);
      }
    }
  },
  {
    name: "region N-09: resolving a plate with 2000 notches and holes stays fast, with the same result",
    run: () => {
      const entities: SketchEntity[] = [rect("plate", [300, 100], 700, 400)];
      for (let i = 0; i < 2000; i += 1) entities.push(circ(`c${i}`, [(i % 50) * 12, Math.floor(i / 50) * 12], 4));
      const profiles = detectSketchProfiles(sketchOf(entities));
      const started = performance.now();
      const largest = resolveProfileRegion(profiles, [profiles[0]!.ref!], { includeIslands: true });
      const everything = resolveProfileRegion(profiles, profiles.map((profile) => profile.ref!), { includeIslands: true });
      const elapsed = performance.now() - started;
      assert(largest.ok && everything.ok, "both selections resolve");
      equal(largest.value.holes.length, 1250, "the circles wholly inside the plate are its holes");
      equal(everything.value.groups.length, 701, "and picking every region gives the plate with its notches and the discs");
      // About 0.4 s on its own and a few seconds late in a long run (the heap is full by then); the old code needed 10 s even on its own.
      assert(elapsed < 6000, `resolving took ${elapsed.toFixed(0)} ms (the old code took about 10 s)`);
    }
  },
  {
    name: "region N-11: the reason a sketch has no region reads cleanly, with no '1 more open ends' and no doubled full stop",
    run: () => {
      const parallel = sketchOf([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]);
      const reasons = explainNoProfiles(parallel);
      assert(reasons.some((reason) => /^1 more open end\.$/u.test(reason)), `the count agrees with its noun: ${reasons.join(" | ")}`);
      assert(!reasons.some((reason) => /1 more open ends/u.test(reason)), "no '1 more open ends'");
      const report = analyzeSketch(editKit.context(editKit.projectWith([editKit.line("a", [0, 0], [10, 0]), editKit.line("b", [10, 0], [10, 10])])));
      assert(report.summary.every((sentence) => !/\.\./u.test(sentence)), `no sentence ends in two full stops: ${report.summary.join(" | ")}`);
    }
  },
  {
    name: "region P-05 recheck: a region reference survives a fillet of the curves that bounded it",
    run: async () => {
      const square = (): SketchEntity[] => [line("s0", [0, 0], [20, 0]), line("s1", [20, 0], [20, 20]), line("s2", [20, 20], [0, 20]), line("s3", [0, 20], [0, 0])];
      const joints = [["j0", "s0", "s1"], ["j1", "s1", "s2"], ["j2", "s2", "s3"], ["j3", "s3", "s0"]].map(([id, a, b]) => editKit.constraint(id!, "coincident", [a!, b!], { points: ["end", "start"] }));
      const project = editKit.projectWith(square(), joints);
      const picked = detectSketchProfiles(project.sketch)[0]!;
      const filleted = editKit.commitOk(project, filletCorners(editKit.context(project), ["entity:s0", "entity:s1"], 3));
      for (const stored of [picked.ref!, picked.id]) {
        const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [stored] }), sketchFeatureOf(filleted.sketch));
        assert(built.ok, `the reference ${stored} is found again after a fillet: ${built.ok ? "" : built.message}`);
        near(volumeOf(built.body.positionsMm, built.body.indices), (400 - (4 - Math.PI) * 9 / 4) * 10, 5, "and the plate keeps its rounded corner");
      }
    }
  }
];
