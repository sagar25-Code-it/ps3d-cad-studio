import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { triangulateLoops } from "../packages/occt-kernel-adapter/src/polygon.js";
import { detectSketchProfiles, resolveProfileRegion } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circ, line, rect, sketchFeatureOf, sketchOf, solidFeature, volumeOf } from "./region-wave2-kit.js";
import type { DesignSolidFeature, SketchEntity } from "../packages/workbench-core/src/index.js";
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
  }
];
