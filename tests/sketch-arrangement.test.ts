import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { rebuildDependents, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, WORKBENCH_LIMITS } from "../packages/workbench-core/src/index.js";
import {
  buildSketchEntity,
  closedShapesOf,
  detectSketchProfiles,
  diagnoseProfiles,
  explainNoProfiles,
  lostProfileRefs,
  matchProfileRef,
  profileInBox,
  profileOutlineMm,
  resolveProfileRegion,
  sampleArc,
  sampleSpline,
  type SketchProfile
} from "../packages/workbench-sketch/src/index.js";
import { breakAtIntersections } from "../packages/workbench-sketch/src/break-intersections.js";
import { filletCorners, chamferCorners } from "../packages/workbench-sketch/src/edit-tools.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { splitAt } from "../packages/workbench-sketch/src/split-jog.js";
import { commitOk, context, newId, projectWith } from "./sketch-edit-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

type P = readonly [number, number];
const line = (id: string, start: P, end: P): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });
const circle = (id: string, center: P, radiusMm: number): SketchEntity => ({ id: `entity:${id}`, kind: "circle", center, radiusMm, construction: false });
const rect = (id: string, center: P, widthMm: number, heightMm: number, rotationDeg = 0): SketchEntity => ({ id: `entity:${id}`, kind: "rectangle", center, widthMm, heightMm, rotationDeg, construction: false });
const arc = (id: string, start: P, mid: P, end: P): SketchEntity => ({ id: `entity:${id}`, kind: "arc", start, mid, end, construction: false });
const spline = (id: string, fitPoints: readonly P[]): SketchEntity => ({ id: `entity:${id}`, kind: "spline", fitPoints, construction: false });
const ellipse = (id: string, center: P, majorRadiusMm: number, minorRadiusMm: number, rotationDeg = 0): SketchEntity => ({ id: `entity:${id}`, kind: "ellipse", center, majorRadiusMm, minorRadiusMm, rotationDeg, construction: false });
const polyline = (prefix: string, points: readonly P[]): SketchEntity[] => points.map((point, index) => line(`${prefix}${index}`, point, points[(index + 1) % points.length]!));

function sketchOf(entities: readonly SketchEntity[], extra: Partial<WorkbenchSketch> = {}): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-arrangement").sketch, entities, constraints: [], ...extra };
}

const detect = (entities: readonly SketchEntity[], extra: Partial<WorkbenchSketch> = {}): readonly SketchProfile[] => detectSketchProfiles(sketchOf(entities, extra));
const areas = (profiles: readonly SketchProfile[]): number[] => profiles.map((profile) => profile.areaMm2).sort((a, b) => a - b);

function signedArea(points: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current[0] * next[1] - next[0] * current[1];
  }
  return twice / 2;
}

function meshVolume(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return Math.abs(total / 6);
}

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-arr-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const feature = (extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature => ({
  id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: "general-body:one", ...extra
});

function sketchFeature(project: WorkbenchProject): DesignSketchFeature {
  const found = designOf(project).features.find((candidate): candidate is DesignSketchFeature => candidate.kind === "sketch");
  assert(found !== undefined, "the project has a sketch feature");
  return found;
}

/** A project whose working sketch holds `entities`, finished into the timeline as "feature:sketch-1". */
function finished(entities: readonly SketchEntity[]): WorkbenchProject {
  const base = createWorkbenchProject("project:test-arrangement");
  return run({ ...base, sketch: { ...base.sketch, entities, constraints: [] } }, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
}

async function volumeOf(entities: readonly SketchEntity[], profileIds: readonly string[], extra: Partial<DesignSolidFeature> = {}): Promise<{ readonly volume: number; readonly message?: string; readonly warnings: readonly string[] }> {
  const built = await rebuildSolidFeature(feature({ profileIds, ...extra }), sketchFeature(finished(entities)));
  if (!built.ok) return { volume: Number.NaN, message: built.message, warnings: [] };
  return { volume: meshVolume(built.body.positionsMm, built.body.indices), warnings: built.warnings ?? [] };
}


export const sketchArrangementTests: readonly TestCase[] = [
  {
    name: "Region detection P-01/E03/T06/P08: crossing, T-junction and overlapping geometry splits into every enclosed region",
    run: () => {
      const hashLines = [line("h1", [0, 10], [30, 10]), line("h2", [0, 20], [30, 20]), line("v1", [10, 0], [10, 30]), line("v2", [20, 0], [20, 30])];
      equal(detect(hashLines).length, 1, "(a) a # of four crossing lines encloses one centre cell");
      near(detect(hashLines)[0]!.areaMm2, 100, 1e-9, "(a) and it is 10 x 10");
      const grid = detect([...polyline("b", [[0, 0], [30, 0], [30, 30], [0, 30]]), ...hashLines]);
      equal(grid.length, 9, "(b) a 30 x 30 border crossed by two lines each way gives 9 cells");
      for (const cell of grid) near(cell.areaMm2, 100, 1e-9, "(b) every cell is 10 x 10");
      const overlapping = detect([...polyline("a", [[0, 0], [20, 0], [20, 20], [0, 20]]), ...polyline("b", [[10, 10], [30, 10], [30, 30], [10, 30]])]);
      equal(overlapping.length, 3, "(c) two overlapping squares give three regions");
      equal(JSON.stringify(areas(overlapping)), JSON.stringify([100, 300, 300]), "(c) the overlap and the two L-shaped remainders");
      const crossedCircle = detect([rect("r", [0, 0], 20, 20), circle("c", [10, 0], 8)]);
      equal(crossedCircle.length, 3, "(d) a rectangle and a circle crossing its edge give three regions");
      near(crossedCircle.reduce((sum, profile) => sum + profile.areaMm2, 0), 400 + (Math.PI * 64) / 2, 1e-6, "(d) the three regions tile the union exactly (the half of the circle outside the rectangle is added)");
      const halves = detect([circle("c", [0, 0], 10), line("d", [-10, 0], [10, 0])]);
      equal(halves.length, 2, "(e) a circle with a diameter gives two half discs");
      near(halves[0]!.areaMm2, Math.PI * 50, 1e-9, "(e) each is exactly half the disc");
      const rectHalves = detect([rect("r", [0, 0], 20, 10), line("m", [-12, 0], [12, 0])]);
      equal(rectHalves.length, 2, "(f) a rectangle and a line across it give two halves (the overshoot is ignored)");
      near(rectHalves[0]!.areaMm2, 100, 1e-9, "(f) each half is 20 x 5");
      const divided = detect([line("a", [0, 0], [10, 0]), line("a2", [10, 0], [20, 0]), line("b", [20, 0], [20, 10]), line("b2", [20, 10], [20, 20]), line("c", [20, 20], [10, 20]), line("c2", [10, 20], [0, 20]), line("d", [0, 20], [0, 10]), line("d2", [0, 10], [0, 0]), line("mid", [0, 10], [20, 10])]);
      equal(divided.length, 2, "(g) a square with a divider whose ends sit on edge midpoints gives two halves");
      equal(rect("x", [0, 0], 1, 1).kind, "rectangle", "builders sanity");
    }
  },
  {
    name: "Region detection P-02/E02/T06: a branching vertex no longer destroys the loop; stubs are ignored and shared edges split",
    run: () => {
      const square = polyline("s", [[0, 0], [10, 0], [10, 10], [0, 10]]);
      const alone = detect(square);
      const withStub = detect([...square, line("stub", [10, 10], [15, 15])]);
      equal(withStub.length, 1, "a stub from a corner leaves the square as a profile");
      equal(withStub[0]!.id, alone[0]!.id, "with the same id as before the stub was drawn");
      const diagonal = detect([...square, line("d", [0, 0], [10, 10])]);
      equal(diagonal.length, 2, "a diagonal gives two triangles");
      near(diagonal[0]!.areaMm2, 50, 1e-9, "of half the square");
      const touching = detect([...polyline("a", [[0, 0], [10, 0], [10, 10], [0, 10]]), ...polyline("b", [[10, 10], [20, 10], [20, 20], [10, 20]])]);
      equal(touching.length, 2, "two squares touching at a corner give both");
      const sharedEdge = detect([line("1", [0, 0], [10, 0]), line("2", [10, 0], [20, 0]), line("3", [20, 0], [20, 10]), line("4", [20, 10], [10, 10]), line("5", [10, 10], [0, 10]), line("6", [0, 10], [0, 0]), line("shared", [10, 0], [10, 10])]);
      equal(sharedEdge.length, 2, "two squares of seven lines share one edge and both are found");
      const halfDiscs = detect([arc("top", [-10, 0], [0, 10], [10, 0]), arc("bottom", [10, 0], [0, -10], [-10, 0]), line("chord", [-10, 0], [10, 0])]);
      equal(halfDiscs.length, 2, "two half discs (an arc and a chord each) sharing a diameter are both found");
      near(halfDiscs[0]!.areaMm2, Math.PI * 50, 1e-6, "each is half the disc");
    }
  },
  {
    name: "Region detection P-03/E13/T22/P24: curve ends join across gaps up to the tolerance, wherever they fall on a rounding grid",
    run: () => {
      const squareWithGap = (gap: number, x = 0): SketchEntity[] => polyline("g", [[0, 0], [10, 0], [10, 10], [0, 10]]).map((entity, index) => (index === 3 && entity.kind === "line" ? { ...entity, end: [x, gap] as P } : entity));
      for (const gap of [1e-12, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 0.005]) equal(detect(squareWithGap(gap)).length, 1, `a gap of ${gap} mm closes the square`);
      for (const gap of [0.05, 0.5, 0.75]) equal(detect(squareWithGap(gap)).length, 0, `a gap of ${gap} mm is not closed (profiles join across at most 0.01 mm)`);
      // The old 1e-6 rounding grid: two points a hair apart that straddle a grid line.
      const straddle = [line("s0", [0, 0], [10, 4.9999995]), line("s1", [10, 4.9999995 + 4e-13], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10], [0, 0])];
      equal(detect(straddle).length, 1, "two ends 4e-13 apart that straddle a rounding boundary still join");
      const noise = polyline("n", [[0.0000005, 0], [10, 0.0000004], [10.0000005, 10], [0, 10.0000005]]);
      equal(detect(noise).length, 1, "coordinate noise of a micron does not open a loop");
      equal(detect(squareWithGap(1e-5)).length, 1, "a 5e-5 style gap is a profile, so the Create solid button has something to build");
      // A tighter sketch snap tolerance narrows the reach.
      equal(detect(squareWithGap(0.005), { snapToleranceMm: 0.001 }).length, 0, "the reach never exceeds the sketch snap tolerance");
      // The repair report tells the truth about what joins.
      const project = projectWith(squareWithGap(0.5));
      const report = analyzeSketch(context(project));
      const gap = report.issues.find((issue) => issue.category === "gap");
      assert(gap !== undefined && !gap.detail.includes("still join,") && /not closed/u.test(gap.detail), `a 0.5 mm gap says the chain is not closed: ${gap?.detail}`);
      const close = analyzeSketch(context(projectWith(squareWithGap(0.008))));
      equal(close.closedProfiles, 1, "a gap inside the tolerance gives a closed profile");
    }
  },
  {
    name: "Diagnostics P-04/P-18/E02: Validate Sketch and the Create solid reason name the gap, the curves and the point",
    run: () => {
      const open = polyline("o", [[0, 0], [10, 0], [10, 10], [0, 10]]).map((entity, index) => (index === 3 && entity.kind === "line" ? { ...entity, end: [0, 0.5] as P } : entity));
      const sketch = sketchOf(open);
      const reasons = explainNoProfiles(sketch);
      assert(reasons.length > 0 && /0\.5 mm/u.test(reasons[0]!) && /o0/u.test(reasons[0]!) && /o3/u.test(reasons[0]!), `the reason names the gap and both curves: ${reasons.join(" | ")}`);
      const diagnosis = diagnoseProfiles(sketch);
      const gap = diagnosis.problems.find((problem) => problem.code === "gap");
      assert(gap !== undefined && gap.at !== undefined && gap.entityIds.length === 2, "the gap is located and has two curves");
      near(gap.distanceMm ?? 0, 0.5, 1e-9, "its size is reported");
      const report = analyzeSketch(context(projectWith(open)));
      assert(report.summary.some((line) => /0 closed profiles/u.test(line) && /0\.5 mm/u.test(line)), `the summary says why there is no profile: ${report.summary.join(" | ")}`);
      assert(!report.usableForSolid, "a broken loop is not usable for a solid");
      // A free end that stops short of another curve's side.
      const short = diagnoseProfiles(sketchOf([...polyline("s", [[0, 0], [10, 0], [10, 10], [0, 10]]), line("rib", [5, 0.3], [5, 8])]));
      assert(short.problems.some((problem) => problem.code === "short" && /0\.3 mm short/u.test(problem.message)), "a rib that stops 0.3 mm short of the edge is named");
      // Crossing and overlap are reported rather than silently merged.
      const cross = diagnoseProfiles(sketchOf([line("a", [0, 0], [10, 10]), line("b", [0, 10], [10, 0]), ...polyline("f", [[-5, -5], [15, -5], [15, 15], [-5, 15]])]));
      assert(cross.problems.some((problem) => problem.code === "crossing"), "a crossing is listed so the engineer sees why the square has four regions");
      const dup = diagnoseProfiles(sketchOf([...polyline("s", [[0, 0], [10, 0], [10, 10], [0, 10]]), line("d1", [0, 0], [6, 0]), line("d2", [4, 0], [10, 0])]));
      assert(dup.problems.some((problem) => problem.code === "overlap"), "overlapping edges are reported as an overlap, not as a gap");
      assert(!dup.problems.some((problem) => problem.code === "gap"), "and are not misdiagnosed as a gap");
      // Hidden and construction-only sketches say so.
      const hidden = explainNoProfiles(sketchOf([{ ...rect("r", [0, 0], 10, 10), construction: true }]));
      assert(/construction|hidden/iu.test(hidden.join(" ")), `construction-only sketch: ${hidden.join(" ")}`);
      equal(explainNoProfiles(sketchOf([])).length, 1, "an empty sketch says there is nothing to enclose");
      // checkSketch no longer says profiles need exactly two curves.
      const report2 = analyzeSketch(context(projectWith([...polyline("s", [[0, 0], [10, 0], [10, 10], [0, 10]]), line("d", [0, 0], [10, 10])])));
      assert(report2.closedProfiles === 2 && report2.issues.some((issue) => issue.category === "region"), "a square with a diagonal reports its two profiles and the junction");
    }
  },
  {
    name: "Profile identity P-05/P06/P07: a feature built on a region survives a fillet, a chamfer, a split and unrelated geometry",
    run: async () => {
      const rectangle = rect("r", [0, 0], 20, 10);
      const original = detect([rectangle])[0]!;
      assert(original.ref !== undefined && original.ref.startsWith("profile:r~"), `a profile carries a geometric reference: ${original.ref}`);
      const before = await volumeOf([rectangle], [original.ref!]);
      near(before.volume, 2000, 1e-6, "the rectangle extrudes to 20 x 10 x 10");
      // Fillet all four corners: the rectangle is replaced by eight entities and its id disappears.
      const project = projectWith([rectangle]);
      const filleted = commitOk(project, filletCorners(context(project), ["entity:r"], 2));
      equal(detect(filleted.sketch.entities).some((profile) => profile.id === original.id), false, "the old id is gone after the fillet");
      const after = await volumeOf(filleted.sketch.entities, [original.ref!]);
      assert(!Number.isNaN(after.volume), `the feature still builds: ${after.message}`);
      near(after.volume, (200 - (4 - Math.PI) * 4) * 10, 5, "and follows the rounded outline");
      const chamfered = commitOk(project, chamferCorners(context(project), ["entity:r"], 2));
      const afterChamfer = await volumeOf(chamfered.sketch.entities, [original.ref!]);
      near(afterChamfer.volume, (200 - 8) * 10, 1, "a chamfer is followed too");
      // Four lines, one side split at its middle: the loop id changes, the region does not.
      const square = polyline("q", [[0, 0], [10, 0], [10, 10], [0, 10]]);
      const squareProfile = detect(square)[0]!;
      const sproject = projectWith(square);
      const splitProject = commitOk(sproject, splitAt(context(sproject), "entity:q0", [5, 0]));
      const splitProfile = detect(splitProject.sketch.entities)[0]!;
      equal(splitProfile.areaMm2, squareProfile.areaMm2, "splitting a side leaves the region");
      assert(splitProfile.id !== squareProfile.id, "though its loop id changed");
      equal(matchProfileRef(squareProfile.ref!, [splitProfile])?.how, "geometry", "the stored reference finds it again by its geometry");
      const rebuilt = await volumeOf(splitProject.sketch.entities, [squareProfile.ref!]);
      near(rebuilt.volume, 1000, 1e-6, "the split-side square still extrudes through its stored reference");
      // Unrelated geometry far away changes nothing.
      const withFar = await volumeOf([...square, circle("far", [100, 100], 5)], [squareProfile.ref!]);
      near(withFar.volume, 1000, 1e-6, "an unrelated circle does not disturb the feature");
    }
  },
  {
    name: "Profile identity P06 (pipeline): reopening a sketch, adding a chamfer line and shortening two sides keeps the solid through rebuildDependents",
    run: async () => {
      const quad: readonly SketchEntity[] = polyline("w", [[0, 0], [30, 0], [30, 20], [0, 20]]);
      const first = detect(quad)[0]!;
      let project = finished(quad);
      const built = await rebuildSolidFeature(feature({ profileIds: [first.ref!] }), sketchFeature(project));
      assert(built.ok, "the extrude builds");
      project = run(project, { kind: "add-design-solid", feature: feature({ profileIds: [first.ref!] }), body: built.body });
      // Cut the corner (30,20) with a chamfer line: shorten the two sides that meet there and add the diagonal.
      const edited = quad.map((entity) => (entity.id === "entity:w1" && entity.kind === "line" ? { ...entity, end: [30, 15] as P } : entity.id === "entity:w2" && entity.kind === "line" ? { ...entity, start: [25, 20] as P } : entity)).map((entity) => ({ ...entity, id: entity.id.replace("entity:w", "entity:v") }));
      const cutProject = run(project, { kind: "apply-sketch-edit", label: "Chamfer the corner", removeEntityIds: quad.map((entity) => entity.id), updateEntities: [], addEntities: [...edited, line("chamfer", [30, 15], [25, 20])], addConstraints: [] });
      const recommitted = run(cutProject, { kind: "commit-design-sketch", featureId: "feature:sketch-9", name: "Sketch 9" });
      const results = await rebuildDependents(recommitted, "feature:sketch-1");
      assert(results.length === 1 && results[0]!.body !== undefined && results[0]!.message === undefined, `the feature rebuilt: ${results[0]?.message}`);
      near(meshVolume(results[0]!.body!.positionsMm, results[0]!.body!.indices), (600 - 12.5) * 10, 1, "the solid follows the chamfered outline");
      // A profile that truly disappears is reported by name.
      const gone = run(project, { kind: "apply-sketch-edit", label: "Remove the sketch", removeEntityIds: quad.map((entity) => entity.id), updateEntities: [], addEntities: [circle("lonely", [0, 0], 4)], addConstraints: [] });
      const goneCommitted = run(gone, { kind: "commit-design-sketch", featureId: "feature:sketch-10", name: "Sketch 10" });
      const lost = await rebuildDependents(goneCommitted, "feature:sketch-1");
      assert(lost[0]?.message !== undefined && /Extrude 1/u.test(lost[0].message) && /no longer exists/u.test(lost[0].message), `the lost region names the feature: ${lost[0]?.message}`);
      equal(lostProfileRefs(detect([circle("lonely", [0, 0], 4)]), [first.ref!]).length, 1, "lostProfileRefs lists it with its size and place");
    }
  },
  {
    name: "Profile identity P07 (pipeline): drawing a circle inside an extruded region later does not change the extrude",
    run: async () => {
      const plate = rect("p", [0, 0], 60, 60);
      const profile = detect([plate])[0]!;
      const before = await volumeOf([plate], [profile.ref!]);
      near(before.volume, 36000, 1e-6, "the plate extrudes to 60 x 60 x 10");
      const withCircle = [plate, circle("boss", [0, 0], 10)];
      const after = await volumeOf(withCircle, [profile.ref!]);
      near(after.volume, 36000, 1e-6, "adding a circle inside keeps the stored region solid: no hole appears");
      // Choosing the ring on purpose still gives the hole, and the disc is its own region.
      const ring = detect(withCircle).find((candidate) => candidate.holes !== undefined)!;
      const holed = await volumeOf(withCircle, [ring.ref!]);
      near(holed.volume, (3600 - Math.PI * 100) * 10, 25, "a region picked with its hole keeps the hole");
      const disc = detect(withCircle).find((candidate) => candidate.holes === undefined && candidate.boundary.kind === "circle")!;
      near((await volumeOf(withCircle, [disc.ref!])).volume, Math.PI * 100 * 10, 25, "and the disc extrudes on its own");
    }
  },
  {
    name: "Region selection P-07: holes that touch or cross the outline are reported, crossings can be cut as notches",
    run: async () => {
      const plate = rect("p", [0, 0], 20, 20);
      const clear = await volumeOf([plate, circle("h", [0, 0], 3)], []);
      near(clear.volume, (400 - Math.PI * 9) * 10, 8, "a hole clear of the edge is cut");
      assert(clear.warnings.length === 0, "with nothing to warn about");
      for (const x of [8, 9, 10, 12]) {
        const crossing = await volumeOf([plate, circle("h", [x, 0], 3)], []);
        assert(crossing.warnings.some((warning) => /crosses the outline/u.test(warning)), `a hole at x=${x} that crosses the edge is reported, not dropped silently: ${crossing.warnings.join("|")}`);
      }
      const tangent = await volumeOf([plate, circle("h", [7, 0], 3)], []);
      assert(Number.isNaN(tangent.volume) && /touches/u.test(tangent.message ?? ""), `a tangent hole is refused with a reason that names the touch: ${tangent.message}`);
      // The crossing circle can be cut as a notch by picking the regions.
      const profiles = detect([plate, circle("h", [8, 0], 3)]);
      equal(profiles.length, 3, "the plate and the crossing circle make three regions");
      const notched = profiles.find((profile) => profile.boundary.kind === "curve-loop" && profile.areaMm2 > 300)!;
      const result = await volumeOf([plate, circle("h", [8, 0], 3)], [notched.ref!]);
      near(result.volume, notched.areaMm2 * 10, 40, "picking the plate region cuts the notch");
      assert(notched.areaMm2 < 400 - 5, "which has the circle's bite taken out");
    }
  },
  {
    name: "Multi-profile P-08/P09: several disjoint or nested regions extrude together; overlap is refused with its own message",
    run: async () => {
      const four = [circle("c1", [0, 0], 5), circle("c2", [20, 0], 5), circle("c3", [0, 20], 5), circle("c4", [20, 20], 5)];
      const profiles = detect(four);
      const all = await volumeOf(four, profiles.map((profile) => profile.ref!));
      near(all.volume, 4 * Math.PI * 25 * 10, 4 * 25, "four circles extrude as one feature, four cylinders");
      const byId = resolveProfileRegion(profiles, profiles.map((profile) => profile.id), { includeIslands: true });
      assert(byId.ok && byId.value.groups.length === 4, "bare ids of disjoint profiles give four groups too");
      const twoRects = [rect("a", [0, 0], 10, 10), rect("b", [30, 0], 10, 10)];
      near((await volumeOf(twoRects, detect(twoRects).map((profile) => profile.ref!))).volume, 2000, 1e-6, "two disjoint rectangles extrude together");
      // Nested: concentric circles r30, r20, r10 with only the outer named, or nothing.
      const rings = [circle("a", [0, 0], 30), circle("b", [0, 0], 20), circle("c", [0, 0], 10)];
      const expected = Math.PI * (900 - 400 + 100) * 10;
      near((await volumeOf(rings, [])).volume, expected, expected * 0.002, "concentric circles with nothing selected give the ring and the core");
      near((await volumeOf(rings, ["profile:a"])).volume, expected, expected * 0.002, "the outer named alone gives a ring plus its core island (P09 b)");
      // Overlap.
      const overlap = [rect("r1", [0, 0], 20, 20), rect("r2", [10, 10], 20, 20)];
      const clash = resolveProfileRegion(detect(overlap), ["profile:r1", "profile:r2"], { includeIslands: true });
      assert(!clash.ok && /overlap/u.test(clash.diagnostics[0]?.message ?? "") && !/outside/u.test(clash.diagnostics[0]?.message ?? ""), `overlapping outlines get an overlap message: ${clash.ok ? "" : clash.diagnostics[0]?.message}`);
      const regions = detect(overlap);
      equal(regions.length, 3, "the overlap is three regions");
      near((await volumeOf(overlap, regions.map((profile) => profile.ref!))).volume, 7000, 1e-6, "selecting all three regions extrudes the union");
      near((await volumeOf(overlap, [regions.find((profile) => profile.areaMm2 === 100)!.ref!])).volume, 1000, 1e-6, "the lens alone extrudes");
      // Loft and sweep take one region.
      const loft = await rebuildSolidFeature(feature({ kind: "loft", profileIds: profiles.map((profile) => profile.ref!), loftTopScale: 1 }), sketchFeature(finished(four)));
      assert(!loft.ok && /one region/u.test(loft.message), `a loft says it takes one region: ${loft.ok ? "" : loft.message}`);
      // A cut and a revolve take several as well.
      const revolveRegions = [rect("e", [30, 10], 10, 10), rect("f", [60, 10], 10, 10)];
      const revolved = await rebuildSolidFeature(feature({ kind: "revolve", valueMm: 360, profileIds: detect(revolveRegions).map((profile) => profile.ref!) }), sketchFeature(finished(revolveRegions)));
      assert(revolved.ok, `a revolve takes two separate regions: ${revolved.ok ? "" : revolved.message}`);
    }
  },
  {
    name: "Region selection P-14/P-15/P-16: overlapping holes merge, an unknown id fails by name, a plate can be filled or holed",
    run: async () => {
      const plate = [rect("p", [0, 0], 40, 40), circle("a", [-3, 0], 5), circle("b", [3, 0], 5)];
      const merged = await volumeOf(plate, []);
      const union = 2 * Math.PI * 25 - (2 * 25 * Math.acos(0.6) - 3 * 8);
      near(merged.volume, (1600 - union) * 10, 40, "two overlapping holes are one void of their union area");
      const unknown = resolveProfileRegion(detect(plate), ["profile:gone"], { includeIslands: true });
      assert(!unknown.ok && /gone/u.test(unknown.diagnostics[0]?.message ?? ""), "an unknown id fails and names the id instead of using the largest profile");
      const unknownRef = resolveProfileRegion(detect(plate), ["profile:gone~a100~x500~y500~h0"], { includeIslands: true });
      assert(!unknownRef.ok, "and so does an unknown reference far from every region");
      const simple = [rect("q", [0, 0], 20, 20), circle("h", [0, 0], 3)];
      const regions = detect(simple);
      const ring = regions.find((profile) => profile.holes !== undefined)!;
      const disc = regions.find((profile) => profile.holes === undefined)!;
      const holed = await volumeOf(simple, [ring.ref!]);
      const full = await volumeOf(simple, [ring.ref!, disc.ref!]);
      near(full.volume, 4000, 1e-6, "ring and disc together extrude the full plate");
      assert(holed.volume < full.volume - 200, "the ring alone keeps the hole");
      const bare = resolveProfileRegion(regions, [ring.id], { includeIslands: true });
      assert(bare.ok && bare.value.holes.length === 1, "a bare id still means the outline with the outlines inside it as holes");
      const silhouette = resolveProfileRegion(regions, [ring.ref!], { includeIslands: false });
      assert(silhouette.ok && silhouette.value.holes.length === 0, "includeIslands false gives the outline alone");
    }
  },
  {
    name: "Region detection P-09/T08/T07: closed fit-point splines bound a region, join smoothly, and uneven clicks do not loop",
    run: () => {
      const closed = spline("s", [[10, 0], [0, 10], [-10, 0], [0, -10], [10, 0]]);
      const profiles = detect([closed]);
      equal(profiles.length, 1, "a closed fit-point spline is a profile");
      assert(profiles[0]!.areaMm2 > 200 && profiles[0]!.areaMm2 < Math.PI * 100, `the smooth outline is rounder than its diamond (200) and inside the circle (314): ${profiles[0]!.areaMm2}`);
      const created = buildSketchEntity("spline", [[0, 0], [10, 0], [10, 10], [0, 0]], "entity:made");
      assert(created.ok, "the spline tool accepts a closing point");
      if (created.ok) equal(detect([created.value]).length, 1, "and the result bounds a region");
      const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as const;
      const samples = sampleSpline(square, 16);
      const turn = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number => {
        const u = [b[0] - a[0], b[1] - a[1]];
        const v = [c[0] - b[0], c[1] - b[1]];
        return Math.acos(Math.max(-1, Math.min(1, (u[0]! * v[0]! + u[1]! * v[1]!) / (Math.hypot(u[0]!, u[1]!) * Math.hypot(v[0]!, v[1]!)))));
      };
      const last = samples.length - 1;
      const joinAngle = (turn(samples[last - 1]!, samples[last]!, samples[1]!) * 180) / Math.PI;
      const interiorAngle = (turn(samples[15]!, samples[16]!, samples[17]!) * 180) / Math.PI;
      near(joinAngle, interiorAngle, 0.5, `the closing join turns like the other corners of the square (${interiorAngle.toFixed(1)} degrees), where the old clamped end kinked by 84`);
      for (const fit of [[[0, 0], [1, 10], [100, 10]], [[0, 0], [1, 0], [2, 5], [40, 5], [41, 0]]] as const) {
        const curve = sampleSpline(fit, 16);
        let backwards = 0;
        for (let index = 1; index < curve.length; index += 1) if (curve[index]![0] < curve[index - 1]![0] - 1e-9) backwards += 1;
        const xs = curve.map((point) => point[0]);
        equal(backwards, 0, `uneven clicks ${JSON.stringify(fit)}: x never runs backwards`);
        assert(Math.min(...xs) >= -1e-6 && Math.max(...xs) <= fit[fit.length - 1]![0] + 1e-6, "and the curve stays within the fit points' range");
      }
      const even = sampleSpline([[0, 0], [10, 8], [20, 10], [30, 6]], 4);
      near(even[0]![0], 0, 0, "evenly spaced splines keep their first sample exactly");
    }
  },
  {
    name: "Region detection P-10: self-crossing outlines are split into simple regions, not offered as one profile",
    run: () => {
      const bowTie = detect(polyline("w", [[0, 0], [10, 10], [10, 0], [0, 20]]));
      equal(bowTie.length, 2, "an asymmetric bow-tie is two triangles");
      assert(areas(bowTie).every((value) => value > 10), "each with a positive area");
      const symmetric = detect(polyline("x", [[0, 0], [10, 10], [10, 0], [0, 10]]));
      equal(symmetric.length, 2, "a symmetric bow-tie (net area zero) is two triangles, not dropped");
      const star = polyline("p", [0, 1, 2, 3, 4].map((k) => [Math.cos((Math.PI / 2) + (k * 4 * Math.PI) / 5) * 10, Math.sin((Math.PI / 2) + (k * 4 * Math.PI) / 5) * 10] as P));
      equal(detect(star).length, 6, "a pentagram is five tips and the middle pentagon");
      for (const profile of detect(star)) assert(signedArea(profileOutlineMm(profile.boundary)) > 0, "every region outline is a simple counter-clockwise polygon");
      const loopy = detect([spline("l", [[0, 0], [20, 20], [20, 0], [0, 20]])]);
      assert(loopy.length >= 1, "a spline that crosses itself bounds the loop it makes");
    }
  },
  {
    name: "Region detection P-11/T21: curves are sampled by a chord-error bound and arc-bounded areas are exact",
    run: async () => {
      for (const radius of [2, 10, 100, 500, 5000]) {
        const outline = profileOutlineMm({ kind: "circle", center: [0, 0], radiusMm: radius });
        const sagitta = radius * (1 - Math.cos(Math.PI / outline.length));
        assert(sagitta <= 0.0101, `r=${radius}: chord error ${sagitta.toFixed(4)} mm is within 0.01 mm`);
      }
      const big = profileOutlineMm({ kind: "circle", center: [0, 0], radiusMm: 500 });
      assert(big.length > 300, `a large circle gets many more than 72 facets (${big.length})`);
      const semicircles = detect([arc("u", [-10, 0], [0, 10], [10, 0]), arc("d", [10, 0], [0, -10], [-10, 0])]);
      equal(semicircles.length, 1, "two semicircles form a profile");
      near(semicircles[0]!.areaMm2, Math.PI * 100, 1e-9, "whose area is exact, not the facet polygon");
      const slot = detect([line("top", [0, 10], [30, 10]), arc("ra", [30, 10], [40, 0], [30, -10]), line("bot", [30, -10], [0, -10]), arc("la", [0, -10], [-10, 0], [0, 10])]);
      near(slot[0]!.areaMm2, 600 + Math.PI * 100, 1e-9, "a slot is the rectangle plus the disc exactly");
      const cylinder = await createGeneralSolidBody({ profile: detect([circle("c", [0, 0], 10)])[0]!, plane: "xy", operation: "extrude", valueMm: 10, bodyId: "general-body:cyl", name: "Cylinder", color: "#fff" });
      assert(cylinder.ok, "the cylinder builds");
      if (cylinder.ok) near(meshVolume(cylinder.body.positionsMm, cylinder.body.indices), Math.PI * 100 * 10, Math.PI * 100 * 10 * 0.0025, "its volume is within 0.25 percent of exact");
      const sampled = sampleArc([0, 0], [5, 5], [10, 0]);
      for (const point of sampled) near(Math.hypot(point[0] - 5, point[1]), 5, 1e-9, "arc samples lie on the circle through the three points");
    }
  },
  {
    name: "Region detection P-12: degenerate or invalid primitives are skipped, and the diagnosis says so",
    run: () => {
      const bad: SketchEntity[] = [
        rect("w0", [0, 0], 0, 5), rect("w1", [0, 0], 0.001, 5), circle("r0", [20, 0], 0), circle("rneg", [30, 0], -3), circle("rinf", [40, 0], Number.POSITIVE_INFINITY),
        rect("nan", [0, 20], Number.NaN, 5), ellipse("enan", [10, 20], Number.NaN, 3), ...polyline("nl", [[0, 40], [10, 40], [10, Number.NaN], [0, 50]])
      ];
      equal(detect(bad).length, 0, "none of them becomes a profile");
      const diagnosis = diagnoseProfiles(sketchOf(bad));
      assert(diagnosis.problems.some((problem) => problem.code === "skipped"), "the diagnosis lists what was skipped");
      for (const profile of detect([rect("ok", [0, 0], 10, 10), circle("also", [30, 0], 4)])) assert(Number.isFinite(profile.areaMm2) && profile.areaMm2 > 0, "valid shapes keep finite positive areas");
    }
  },
  {
    name: "Region detection P-13: duplicate and overlapping edges merge instead of killing the loop",
    run: () => {
      const square = polyline("s", [[0, 0], [10, 0], [10, 10], [0, 10]]);
      equal(detect([...square, line("dup", [0, 0], [10, 0])]).length, 1, "a side drawn twice");
      equal(detect([...square, line("dup", [10, 0], [0, 0])]).length, 1, "or twice, reversed");
      equal(detect([...square, ...polyline("t", [[0, 0], [10, 0], [10, 10], [0, 10]])]).length, 1, "two identical squares are one profile");
      const overlapped = detect([line("b1", [0, 0], [6, 0]), line("b2", [4, 0], [10, 0]), line("r", [10, 0], [10, 10]), line("t", [10, 10], [0, 10]), line("l", [0, 10], [0, 0])]);
      equal(overlapped.length, 1, "a bottom edge drawn as two overlapping lines");
      near(overlapped[0]!.areaMm2, 100, 1e-9, "still the 10 x 10 square");
      equal(detect([circle("c1", [0, 0], 5), circle("c2", [0, 0], 5)]).length, 1, "two identical circles are one region");
    }
  },
  {
    name: "Region detection P-17: every outline winds counter-clockwise whatever the kind or the drawing direction",
    run: () => {
      const clockwise = polyline("cw", [[0, 0], [0, 10], [10, 10], [10, 0]]);
      const counter = polyline("ccw", [[30, 0], [40, 0], [40, 10], [30, 10]]);
      const kinds = detect([clockwise, counter, [rect("r", [60, 0], 10, 10, 20)], [circle("c", [90, 0], 4)], [ellipse("e", [110, 0], 6, 3, 25)], [arc("a1", [130, 0], [135, 5], [140, 0]), line("a2", [140, 0], [130, 0])]].flat());
      equal(kinds.length, 6, "six profiles of six kinds");
      for (const profile of kinds) assert(signedArea(profileOutlineMm(profile.boundary)) > 0, `${profile.boundary.kind} winds counter-clockwise`);
      const ring = detect([rect("o", [0, 0], 20, 20), circle("i", [0, 0], 4)]).find((profile) => profile.holes !== undefined)!;
      for (const hole of ring.holes!) assert(signedArea(profileOutlineMm(hole.boundary)) > 0, "a hole's own outline is counter-clockwise too");
    }
  },
  {
    name: "Region detection P-18: a crossing box picks the region it touches, not every region whose bounding box overlaps",
    run: () => {
      const profiles = detect([circle("big", [0, 0], 20), circle("small", [60, 0], 5)]);
      const big = profiles.find((profile) => profile.id === "profile:big")!;
      const cornerBox = { min: [16, 16] as P, max: [30, 30] as P };
      equal(profileInBox(big, cornerBox, "crossing"), false, "a box in the corner of the circle's bounding box misses the circle");
      equal(profileInBox(big, { min: [10, 10], max: [30, 30] }, "crossing"), true, "a box that reaches into the disc picks it");
      equal(profileInBox(big, { min: [-5, -5], max: [5, 5] }, "crossing"), true, "a box wholly inside the disc picks it");
      equal(profileInBox(big, { min: [-30, -30], max: [30, 30] }, "window"), true, "a window around it picks it");
      equal(profileInBox(big, { min: [-10, -10], max: [10, 10] }, "window"), false, "a window across part of it does not");
      const ring = detect([rect("o", [0, 0], 40, 40), circle("i", [0, 0], 10)]).find((profile) => profile.holes !== undefined)!;
      equal(profileInBox(ring, { min: [-3, -3], max: [3, 3] }, "crossing"), false, "a box wholly inside the ring's hole does not pick the ring");
    }
  },
  {
    name: "Break at intersections: one step splits every crossing curve through the real operation, and the regions stay the same",
    run: () => {
      const hash = [line("h1", [0, 10], [30, 10]), line("h2", [0, 20], [30, 20]), line("v1", [10, 0], [10, 30]), line("v2", [20, 0], [20, 30])];
      const project = projectWith([...polyline("b", [[0, 0], [30, 0], [30, 30], [0, 30]]), ...hash]);
      const before = detectSketchProfiles(project.sketch);
      const broken = commitOk(project, breakAtIntersections(context(project)));
      assert(broken.sketch.entities.length > project.sketch.entities.length, `curves were split (${project.sketch.entities.length} -> ${broken.sketch.entities.length})`);
      const after = detectSketchProfiles(broken.sketch);
      equal(after.length, before.length, "the same nine regions");
      equal(JSON.stringify(areas(after)), JSON.stringify(areas(before)), "with the same areas");
      assert(!breakAtIntersections(context(broken)).ok, "breaking again finds nothing left to break");
      // A rectangle cut by a diagonal becomes lines, a circle crossed twice becomes arcs.
      const mixed = projectWith([rect("r", [0, 0], 20, 20), line("d", [-15, -15], [15, 15]), circle("c", [10, 0], 8)]);
      const plan = breakAtIntersections(context(mixed));
      assert(plan.ok, "the mixed sketch breaks");
      const result = commitOk(mixed, plan);
      assert(!result.sketch.entities.some((entity) => entity.kind === "rectangle" || entity.kind === "circle"), "the rectangle and the circle were replaced by their pieces");
      assert(result.sketch.entities.some((entity) => entity.kind === "arc"), "the circle became arcs");
      near(detectSketchProfiles(result.sketch).reduce((sum, profile) => sum + profile.areaMm2, 0), detectSketchProfiles(mixed.sketch).reduce((sum, profile) => sum + profile.areaMm2, 0), 0.5, "the total enclosed area is unchanged");
      // Only the selected curves are cut.
      const some = projectWith([line("a", [0, 0], [20, 0]), line("b", [10, -5], [10, 5]), line("c", [5, -5], [5, 5])]);
      const only = commitOk(some, breakAtIntersections(context(some), ["entity:a"]));
      equal(only.sketch.entities.filter((entity) => entity.id !== "entity:b" && entity.id !== "entity:c").length, 3, "selecting a alone cuts a into three pieces and leaves b and c");
      const none = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]);
      const refusal = breakAtIntersections(context(none));
      assert(!refusal.ok && /nothing to break/u.test(refusal.diagnostics[0]?.message ?? ""), "curves that never meet say there is nothing to break");
      assert(newId("entity").startsWith("entity:"), "ids are minted by the context");
    }
  },
  {
    name: "Edit limits P12: one sketch edit carries up to the sketch limit, and says which limit it hit",
    run: () => {
      const base = createWorkbenchProject("project:test-limits");
      const empty = { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
      const lines = (count: number): SketchEntity[] => Array.from({ length: count }, (_, index) => line(`n${index}`, [index * 3, 0], [index * 3 + 2, 1 + (index % 7)]));
      const joints = (count: number) => Array.from({ length: count - 1 }, (_, index) => ({ id: `constraint:j${index}`, kind: "coincident" as const, entityIds: [`entity:n${index}`, `entity:n${index + 1}`], points: ["end", "start"] as const }));
      void joints;
      for (const count of [101, 120, 201, 300, 500]) {
        const applied = applyWorkbenchOperation(empty, { kind: "apply-sketch-edit", operationId: `operation:limit-${count}`, expectedRevision: empty.revision, label: `Add ${count} lines`, removeEntityIds: [], updateEntities: [], addEntities: lines(count), addConstraints: [] });
        assert(applied.ok, `${count} lines in one edit: ${applied.ok ? "" : applied.diagnostics[0]?.message}`);
      }
      const tooMany = applyWorkbenchOperation(empty, { kind: "apply-sketch-edit", operationId: "operation:limit-501", expectedRevision: empty.revision, label: "Too many", removeEntityIds: [], updateEntities: [], addEntities: lines(501), addConstraints: [] });
      assert(!tooMany.ok && /at most 500/u.test(tooMany.diagnostics[0]?.message ?? "") && /501/u.test(tooMany.diagnostics[0]?.message ?? ""), `the limit is named: ${tooMany.ok ? "" : tooMany.diagnostics[0]?.message}`);
      equal(WORKBENCH_LIMITS.maxEntities, 500, "the sketch limit is 500 curves");
    }
  },
  {
    name: "Legacy compatibility: isolated shapes keep their ids, kinds and exact areas, and are deterministic under shuffling",
    run: () => {
      const base: SketchEntity[] = [...polyline("a", [[0, 0], [10, 0], [10, 10], [0, 10]]), arc("r1", [20, 0], [25, 5], [20, 10]), line("t", [20, 10], [15, 10]), line("b", [15, 0], [20, 0]), line("l", [15, 10], [15, 0]), circle("c", [0, 30], 5), rect("rr", [40, 0], 10, 10, 30), ellipse("e", [60, 0], 8, 4, 15)];
      const reference = JSON.stringify(detect(base).map((profile) => [profile.id, profile.areaMm2, profileOutlineMm(profile.boundary)]));
      let seed = 7;
      const random = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      for (let round = 0; round < 20; round += 1) {
        const shuffled = [...base].sort(() => random() - 0.5);
        equal(JSON.stringify(detect(shuffled).map((profile) => [profile.id, profile.areaMm2, profileOutlineMm(profile.boundary)])), reference, "a shuffled entity order gives identical ids, areas and outlines");
      }
      const profiles = detect(base);
      const byKind = (kind: string): SketchProfile => profiles.find((profile) => profile.boundary.kind === kind)!;
      equal(byKind("circle").id, "profile:c", "a circle keeps the profile:<entity> id");
      equal(byKind("rectangle").id, "profile:rr", "a rectangle too");
      near(byKind("ellipse").areaMm2, Math.PI * 8 * 4, 1e-9, "an ellipse keeps its exact area");
      assert(profiles.some((profile) => /^profile:loop-[0-9a-f]{8}$/u.test(profile.id)), "a loop of lines keeps the loop-<hash> id");
      const shapes = closedShapesOf(profiles);
      assert(shapes !== undefined && shapes.length >= profiles.length, "the drawn outlines are available for bare ids");
    }
  },
  {
    name: "Performance: 500 curves and 8000 lines are split into regions in well under a second",
    run: () => {
      const mixed: SketchEntity[] = [];
      for (let index = 0; index < 125; index += 1) {
        const x = (index % 25) * 12;
        const y = Math.floor(index / 25) * 12;
        mixed.push(...polyline(`q${index}`, [[x, y], [x + 8, y], [x + 8, y + 8], [x, y + 8]]));
      }
      equal(mixed.length, 500, "500 lines");
      let started = performance.now();
      const profiles = detect(mixed);
      const elapsed = performance.now() - started;
      equal(profiles.length, 125, "125 squares");
      assert(elapsed < 1000, `500 curves take ${elapsed.toFixed(0)} ms`);
      const crossing: SketchEntity[] = [];
      for (let index = 0; index < 20; index += 1) crossing.push(line(`h${index}`, [0, index * 5], [100, index * 5]), line(`v${index}`, [index * 5, 0], [index * 5, 100]));
      started = performance.now();
      const cells = detect(crossing);
      const crossElapsed = performance.now() - started;
      equal(cells.length, 19 * 19, "a 20 x 20 grid of crossing lines gives 361 cells");
      assert(crossElapsed < 1000, `the grid takes ${crossElapsed.toFixed(0)} ms`);
      const big: SketchEntity[] = [];
      for (let index = 0; index < 2000; index += 1) big.push(...polyline(`s${index}`, [[index * 20, 0], [index * 20 + 10, 0], [index * 20 + 10, 10], [index * 20, 10]]));
      started = performance.now();
      equal(detect(big).length, 2000, "2000 squares");
      assert(performance.now() - started < 2500, "8000 lines stay fast");
    }
  },
  {
    name: "Region detection: an ellipse cut by a line, and a hand-made profile list, keep exact areas and the old behaviour",
    run: () => {
      const halves = detect([ellipse("e", [0, 0], 10, 5, 30), line("l", [-12, 0], [12, 0])]);
      equal(halves.length, 2, "an ellipse crossed by a line gives two regions");
      near(halves[0]!.areaMm2 + halves[1]!.areaMm2, Math.PI * 50, 0.05, "which tile the ellipse");
      const handmade: SketchProfile[] = [
        { id: "profile:big", entityIds: ["entity:big"], boundary: { kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 20, rotationDeg: 0 }, areaMm2: 400, centroid: [0, 0] },
        { id: "profile:in", entityIds: ["entity:in"], boundary: { kind: "circle", center: [0, 0], radiusMm: 3 }, areaMm2: 28.27, centroid: [0, 0] }
      ];
      const region = resolveProfileRegion(handmade, [], { includeIslands: true });
      assert(region.ok && region.value.outer.id === "profile:big" && region.value.holes.length === 1, "profiles put together by hand still resolve as plate and hole");
      const far = resolveProfileRegion([...handmade, { id: "profile:far", entityIds: ["entity:far"], boundary: { kind: "circle", center: [200, 0], radiusMm: 5 }, areaMm2: 78.5, centroid: [200, 0] }], ["profile:big", "profile:far"], { includeIslands: false });
      assert(far.ok && far.value.groups.length === 2, "and a disjoint profile is a second region");
    }
  }
];

