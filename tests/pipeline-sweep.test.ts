import type { DesignSketchFeature, DesignSolidFeature, SketchEntity } from "../packages/workbench-core/src/index.js";
import { dependentsOf, designOf } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { rebuildSolidFeature, sketchLookupOf } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, line, meshStats, pipelineRun, rect, solidFeature, solidOf } from "./pipeline-kit.js";

/** The profile IDs of a sketch, largest area first. */
const byArea = (sketch: DesignSketchFeature): string[] => detectSketchProfiles(sketch.sketch).slice().sort((a, b) => b.areaMm2 - a.areaMm2).map((profile) => profile.id);

interface SketchSpec {
  readonly plane: "datum:xy" | "datum:xz" | "datum:yz";
  readonly entities: readonly SketchEntity[];
  readonly offsetMm?: number;
  readonly tilt?: { readonly axis: "x" | "y" | "z"; readonly angleDeg: number };
}

/** A project with two finished sketches: the profile sketch (feature:s1) and a second one (feature:s2), each on its own plane. */
function twoSketches(first: SketchSpec, second: SketchSpec) {
  const a = committedSketch(first.plane, first.entities, { featureId: "feature:s1", ...(first.offsetMm === undefined ? {} : { offsetMm: first.offsetMm }), ...(first.tilt === undefined ? {} : { tilt: first.tilt }) });
  const b = committedSketch(second.plane, second.entities, { project: a.project, featureId: "feature:s2", ...(second.offsetMm === undefined ? {} : { offsetMm: second.offsetMm }), ...(second.tilt === undefined ? {} : { tilt: second.tilt }) });
  return { project: b.project, first: a.sketch, second: b.sketch, lookup: sketchLookupOf(designOf(b.project)) };
}

async function build(feature: DesignSolidFeature, sketch: DesignSketchFeature, lookup?: ReturnType<typeof sketchLookupOf>) {
  return rebuildSolidFeature(feature, sketch, "#b9c2c8", lookup);
}

const frustum = (r1: number, r2: number, h: number): number => Math.PI * h / 3 * (r1 * r1 + r1 * r2 + r2 * r2);

export const pipelineSweepTests: readonly TestCase[] = [
  {
    name: "P05 sweep and loft keep the holes of the profile: two concentric circles make a tube, not a bar",
    run: async () => {
      const tube = committedSketch("datum:xy", [circ("o", 0, 0, 10), circ("i", 0, 0, 8)]).sketch;
      const ids = byArea(tube);
      const expected = Math.PI * (100 - 64) * 50;
      const extrude = meshStats(solidOf(await buildSolid(tube, "extrude", { valueMm: 50, profileIds: ids })));
      near(extrude.volume, expected, expected * 0.01, "extrude of the same selection is the tube (the reference)");
      const sweep = meshStats(solidOf(await buildSolid(tube, "sweep", { valueMm: 50, profileIds: ids, sweepDirectionMm: [0, 0, 1] })));
      near(sweep.volume, expected, expected * 0.01, "sweep along Z: a tube of 5,655 mm3, not the 15,708 mm3 bar");
      const loft = meshStats(solidOf(await buildSolid(tube, "loft", { valueMm: 50, profileIds: ids, loftTopScale: 1 })));
      near(loft.volume, expected, expected * 0.01, "loft with a top scale of 1: the same tube");
      const tapered = meshStats(solidOf(await buildSolid(tube, "loft", { valueMm: 40, profileIds: ids, loftTopScale: 0.5 })));
      const taperedWall = frustum(10, 5, 40) - frustum(8, 4, 40);
      near(tapered.volume, taperedWall, taperedWall * 0.02, "a tapering loft is a tube with a tapering wall");
      assert(sweep.volume > 0 && loft.volume > 0, "all of them face outward");
      const slanted = meshStats(solidOf(await buildSolid(tube, "sweep", { valueMm: 50, profileIds: ids, sweepDirectionMm: [0.5, 0, 1] })));
      const rise = 50 / Math.hypot(0.5, 1);
      near(slanted.volume, Math.PI * 36 * rise, Math.PI * 36 * rise * 0.02, "an oblique sweep keeps the wall area times the rise along the normal, and the bore");
    }
  },
  {
    name: "P10 a sweep follows a chained path drawn in another sketch on another plane, with mitred corners, arcs and a tube section",
    run: async () => {
      const profile = [circ("p", 0, 0, 5)];
      const area = Math.PI * 25;
      // The path lives on the XZ plane: sketch (u, v) is world (u, 0, v).
      const straight = twoSketches({ plane: "datum:xy", entities: profile }, { plane: "datum:xz", entities: [line("up", [0, 0], [0, 60])] });
      const one = meshStats(solidOf(await build(solidFeature("sweep", straight.first, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:up"] } }), straight.first, straight.lookup)));
      near(one.volume, area * 60, area * 60 * 0.01, "a straight path: the profile swept 60 mm is a cylinder");
      near(one.hi[2], 60, 0.01, "it rises along the path, off the profile plane");
      near(one.lo[2], 0, 0.01, "starting at the profile");

      const elbow = twoSketches({ plane: "datum:xy", entities: profile }, { plane: "datum:xz", entities: [line("up", [0, 0], [0, 30]), line("across", [0, 30], [30, 30])] });
      const elbowFeature = solidFeature("sweep", elbow.first, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:up", "entity:across"] } });
      const bent = meshStats(solidOf(await build(elbowFeature, elbow.first, elbow.lookup)));
      near(bent.volume, area * 60, area * 60 * 0.012, "an elbow of two 30 mm runs: mitred, so the volume is the section times the path length");
      near(bent.hi[0], 30, 0.01, "it turns toward +X after the vertical run and ends at x = 30");
      assert(bent.hi[2] > 30 && bent.hi[2] < 36, "the outside of the corner stays within the tube radius of the path");
      const shuffled = meshStats(solidOf(await build(solidFeature("sweep", elbow.first, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:across", "entity:up"] } }), elbow.first, elbow.lookup)));
      near(shuffled.volume, bent.volume, bent.volume * 0.001, "curves picked in the wrong order are chained anyway");

      const broken = twoSketches({ plane: "datum:xy", entities: profile }, { plane: "datum:xz", entities: [line("a", [0, 0], [0, 30]), line("b", [5, 30], [30, 30])] });
      const gapResult = await build(solidFeature("sweep", broken.first, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:a", "entity:b"] } }), broken.first, broken.lookup);
      assert(!gapResult.ok && /5\.00 mm apart/u.test(gapResult.message), `a gap in the path is explained: ${gapResult.ok ? "" : gapResult.message}`);

      const arcSketch = twoSketches({ plane: "datum:xy", entities: profile }, { plane: "datum:xz", entities: [{ id: "entity:bend", kind: "arc", start: [0, 0], mid: [30 - 30 * Math.SQRT1_2, 30 * Math.SQRT1_2], end: [30, 30], construction: false }] });
      const quarter = meshStats(solidOf(await build(solidFeature("sweep", arcSketch.first, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:bend"] } }), arcSketch.first, arcSketch.lookup)));
      near(quarter.volume, area * 30 * Math.PI / 2, area * 30 * Math.PI / 2 * 0.015, "a quarter-circle path of radius 30: section times the arc length");

      const tubeElbow = twoSketches({ plane: "datum:xy", entities: [circ("o", 0, 0, 10), circ("i", 0, 0, 8)] }, { plane: "datum:xz", entities: [line("up", [0, 0], [0, 30]), line("across", [0, 30], [30, 30])] });
      const hollow = meshStats(solidOf(await build(solidFeature("sweep", tubeElbow.first, { profileIds: byArea(tubeElbow.first), sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:up", "entity:across"] } }), tubeElbow.first, tubeElbow.lookup)));
      near(hollow.volume, Math.PI * 36 * 60, Math.PI * 36 * 60 * 0.012, "a pipe elbow: wall area times path length");

      // The old single-sketch path form is a real sweep now, not a prism sheared 40 mm sideways while rising.
      const sameSketch = committedSketch("datum:xy", [rect("p", 0, 0, 10, 10), line("path", [20, 0], [60, 0])]).sketch;
      const along = meshStats(solidOf(await build(solidFeature("sweep", sameSketch, { sweepPathEntityId: "entity:path", profileIds: [byArea(sameSketch)[0]!] }), sameSketch)));
      near(along.volume, 10 * 10 * 40, 10 * 10 * 40 * 0.01, "a profile and its path in one sketch: the cross-section at the path start swept along it");
      near(along.lo[0], 20, 0.01, "starting at the path start, not at the profile's drawn position");
      near(along.hi[0], 60, 0.01, "and ending at the path end");
      near(along.hi[2], 5, 0.01, "the section stays 10 mm tall in Z");

      const lost = await build(solidFeature("sweep", elbow.first, { sweepPath: { sketchFeatureId: "feature:gone", entityIds: ["entity:up"] } }), elbow.first, elbow.lookup);
      assert(!lost.ok && /no longer in the timeline/u.test(lost.message), `a missing path sketch is explained: ${lost.ok ? "" : lost.message}`);

      equal(dependentsOf(designOf(elbow.project), "feature:s2").length, 0, "nothing depends on the path sketch before the sweep exists");
      const body = solidOf(await build(elbowFeature, elbow.first, elbow.lookup));
      const withSweep = pipelineRun(elbow.project, { kind: "add-design-solid", feature: elbowFeature, body });
      equal(dependentsOf(designOf(withSweep), "feature:s2").length, 1, "the sweep depends on the sketch that holds its path (so editing or deleting it reaches the sweep)");
    }
  },
  {
    name: "P10 a loft joins profiles on different planes, with holes, and a profile that is gone is reported",
    run: async () => {
      const stacked = twoSketches({ plane: "datum:xy", entities: [rect("a", 0, 0, 40, 40)] }, { plane: "datum:xy", offsetMm: 50, entities: [circ("b", 0, 0, 10)] });
      const feature = solidFeature("loft", stacked.first, { valueMm: 50, loftSecondaryProfileIds: [byArea(stacked.second)[0]!], loftSecondarySketchFeatureId: "feature:s2" });
      const loft = meshStats(solidOf(await build(feature, stacked.first, stacked.lookup)));
      assert(loft.volume > Math.PI * 100 * 50 && loft.volume < 40 * 40 * 50, `the loft lies between the cylinder and the box (${Math.round(loft.volume)})`);
      near(loft.hi[2], 50, 0.01, "it ends on the second sketch's plane");
      near(loft.lo[2], 0, 0.01, "and starts on the first");

      const tilted = twoSketches({ plane: "datum:xy", entities: [rect("a", 0, 0, 40, 40)] }, { plane: "datum:xy", offsetMm: 60, tilt: { axis: "x", angleDeg: 30 }, entities: [circ("b", 0, 0, 10)] });
      const slanted = meshStats(solidOf(await build(solidFeature("loft", tilted.first, { valueMm: 60, loftSecondaryProfileIds: [byArea(tilted.second)[0]!], loftSecondarySketchFeatureId: "feature:s2" }), tilted.first, tilted.lookup)));
      assert(slanted.volume > 5_000, `a loft to a tilted plane is a solid (${Math.round(slanted.volume)})`);
      assert(slanted.hi[2] > 50, "and reaches the tilted plane");

      const tubes = twoSketches({ plane: "datum:xy", entities: [circ("o1", 0, 0, 10), circ("i1", 0, 0, 8)] }, { plane: "datum:xy", offsetMm: 40, entities: [circ("o2", 0, 0, 6), circ("i2", 0, 0, 4)] });
      const hollow = meshStats(solidOf(await build(solidFeature("loft", tubes.first, { valueMm: 40, profileIds: byArea(tubes.first), loftSecondaryProfileIds: byArea(tubes.second), loftSecondarySketchFeatureId: "feature:s2" }), tubes.first, tubes.lookup)));
      const wall = frustum(10, 6, 40) - frustum(8, 4, 40);
      near(hollow.volume, wall, wall * 0.02, "a lofted tube keeps its bore");

      const mismatch = twoSketches({ plane: "datum:xy", entities: [circ("o1", 0, 0, 10), circ("i1", 0, 0, 8)] }, { plane: "datum:xy", offsetMm: 40, entities: [circ("o2", 0, 0, 6)] });
      const bad = await build(solidFeature("loft", mismatch.first, { valueMm: 40, profileIds: byArea(mismatch.first), loftSecondaryProfileIds: byArea(mismatch.second), loftSecondarySketchFeatureId: "feature:s2" }), mismatch.first, mismatch.lookup);
      assert(!bad.ok && /same number of holes/u.test(bad.message), `profiles with different hole counts are refused with the reason: ${bad.ok ? "" : bad.message}`);
      const gone = await build(solidFeature("loft", stacked.first, { valueMm: 50, loftSecondaryProfileIds: ["profile:vanished"], loftSecondarySketchFeatureId: "feature:s2" }), stacked.first, stacked.lookup);
      assert(!gone.ok && /no longer exists/u.test(gone.message), `a vanished second profile is reported: ${gone.ok ? "" : gone.message}`);
    }
  }
];
