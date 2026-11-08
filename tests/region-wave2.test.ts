import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { triangulateLoops } from "../packages/occt-kernel-adapter/src/polygon.js";
import { detectSketchProfiles, resolveProfileRegion } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circ, rect, sketchFeatureOf, sketchOf, solidFeature, volumeOf } from "./region-wave2-kit.js";

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
  }
];
