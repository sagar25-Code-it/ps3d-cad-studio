import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { detectSketchProfiles, type SketchProfile } from "../packages/workbench-sketch/src/index.js";
import type { SketchEntity } from "../packages/workbench-core/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { circ, line, rect, sketchFeatureOf, sketchOf, solidFeature } from "./region-wave2-kit.js";
import { meshReport } from "./region-wave3-kit.js";

/**
 * Region engine, wave 3, stored references: what a feature keeps when the sketch under it changes (a hole that gets an outline drawn
 * around it or is redrawn, a region divided by a new line), and how a selection that touches itself at a corner is handled.
 */

const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => meshReport(body.positionsMm, body.indices).signedVolume;

export const regionWave3SelectTests: readonly TestCase[] = [
  {
    name: "region R2-03: a stored plate-with-hole reference keeps its hole when an outline is drawn around it or the hole is redrawn (was a solid plate, no message)",
    run: async () => {
      const base = [rect("plate", [0, 0], 80, 40), circ("c", [-18, 0], 3)];
      const plate = detectSketchProfiles(sketchOf(base)).find((profile) => (profile.holes?.length ?? 0) === 1 && profile.areaMm2 > 3000)!;
      const ref = plate.ref!;
      const expected = (3200 - Math.PI * 9) * 10;
      const build = async (entities: readonly SketchEntity[]) => {
        const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf(entities)));
        assert(built.ok, `the feature rebuilds: ${built.ok ? "" : built.message}`);
        if (!built.ok) throw new Error("unreachable");
        return { volume: volumeOf(built.body), warnings: built.warnings ?? [] };
      };
      near((await build(base)).volume, expected, expected * 0.002, "the original plate");
      const variants: readonly (readonly [string, readonly SketchEntity[]])[] = [
        ["a concentric circle r8", [circ("big", [-18, 0], 8)]],
        ["a concentric circle r3.5", [circ("ring", [-18, 0], 3.5)]],
        ["an inner rectangle 74 x 34", [rect("inner", [0, 0], 74, 34)]],
        ["a counterbore circle r8 and an inner rectangle", [circ("big", [-18, 0], 8), rect("inner", [0, 0], 74, 34)]]
      ];
      for (const [name, extra] of variants) {
        const result = await build([...base, ...extra]);
        near(result.volume, expected, expected * 0.002, `${name} drawn around the hole: the through hole stays`);
      }
      const hexagon = Array.from({ length: 6 }, (_, index) => line(`x${index}`, [-18 + 3 * Math.cos((index * Math.PI) / 3), 3 * Math.sin((index * Math.PI) / 3)], [-18 + 3 * Math.cos(((index + 1) * Math.PI) / 3), 3 * Math.sin(((index + 1) * Math.PI) / 3)]));
      const redrawn = await build([rect("plate", [0, 0], 80, 40), ...hexagon]);
      near(redrawn.volume, (3200 - ((3 * Math.sqrt(3)) / 2) * 9) * 10, 40, "the hole redrawn as a hexagon is still a hole (the new shape)");
      assert(redrawn.warnings.some((note) => /drawn again/u.test(note)), `and the replacement is announced: ${redrawn.warnings.join(" | ")}`);
    }
  },
  {
    name: "region R2-04: after the outline is replaced by new lines and an inner loop is added, a reference to the plate does not turn into the 3 mm frame (was 6840)",
    run: async () => {
      const plateSketch = sketchOf([rect("plate", [0, 0], 80, 40), circ("c", [-18, 0], 3)]);
      const ref = detectSketchProfiles(plateSketch).find((profile) => (profile.holes?.length ?? 0) === 1 && profile.areaMm2 > 3000)!.ref!;
      const outline = [line("a", [-40, -20], [40, -20]), line("b", [40, -20], [40, 20]), line("c2", [40, 20], [-40, 20]), line("d", [-40, 20], [-40, -20])];
      const inner = [line("ia", [-37, -17], [37, -17]), line("ib", [37, -17], [37, 17]), line("ic", [37, 17], [-37, 17]), line("id", [-37, 17], [-37, -17])];
      const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([...outline, ...inner, circ("c", [-18, 0], 3)])));
      const expected = (3200 - Math.PI * 9) * 10;
      if (built.ok) near(volumeOf(built.body), expected, expected * 0.002, "the plate keeps its full area and its hole");
      else assert(/region|plate/iu.test(built.message), `or the feature refuses by naming the region: ${built.message}`);
      assert(!built.ok || volumeOf(built.body) > 30000, "never the 3 mm frame");
    }
  },
  {
    name: "region R2-09: regions whose union touches itself at a corner are refused with the corner named, and pieces that only meet at a corner are warned about",
    run: async () => {
      const grid: SketchEntity[] = [];
      for (let index = 0; index <= 3; index += 1) { grid.push(line(`h${index}`, [0, index * 10], [30, index * 10])); grid.push(line(`v${index}`, [index * 10, 0], [index * 10, 30])); }
      const sketch = sketchOf(grid);
      const faces = detectSketchProfiles(sketch);
      const cell = (i: number, j: number): SketchProfile => faces.find((face) => Math.abs(face.centroid[0] - (i * 10 + 5)) < 1 && Math.abs(face.centroid[1] - (j * 10 + 5)) < 1)!;
      const all = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [i, j] as const));
      const pick = (skip: readonly (readonly [number, number])[]): string[] => all.filter(([i, j]) => !skip.some(([a, b]) => a === i && b === j)).map(([i, j]) => cell(i, j).ref!);
      const pinched = await rebuildSolidFeature(solidFeature("extrude", { profileIds: pick([[0, 0], [1, 1]]) }), sketchFeatureOf(sketch));
      assert(!pinched.ok && /corner \(10, 10\)/u.test(pinched.message) && !/crosses itself/u.test(pinched.message), `the pinch names the corner: ${pinched.ok ? "accepted" : pinched.message}`);
      const diagonal = await rebuildSolidFeature(solidFeature("extrude", { profileIds: pick([[1, 0], [0, 1]]) }), sketchFeatureOf(sketch));
      assert(diagonal.ok && (diagonal.warnings ?? []).some((note) => /meet only at a corner/u.test(note)), `separate pieces that meet at a corner are warned about: ${diagonal.ok ? (diagonal.warnings ?? []).join(" | ") : diagonal.message}`);
      const ring = await rebuildSolidFeature(solidFeature("extrude", { profileIds: pick([[1, 1]]) }), sketchFeatureOf(sketch));
      assert(ring.ok, "a ring of eight cells with the middle one left out still builds");
    }
  },
  {
    name: "region R2-10: a hole that touches the outline is named by its curves, not by an internal region hash",
    run: async () => {
      const sketch = sketchOf([rect("plate", [0, 0], 40, 40), circ("a", [14.995, 0], 5)]);
      const ref = [...detectSketchProfiles(sketch)].sort((left, right) => right.areaMm2 - left.areaMm2)[0]!.ref!;
      const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketch));
      const text = built.ok ? (built.warnings ?? []).join(" ") : built.message;
      assert(/hole a touches the outline of/u.test(text), `the message names the hole: ${text}`);
      assert(!/rg-[0-9a-f]{6}|region-[0-9a-f]{6}|profile:[a-z]/u.test(text), `and no internal id: ${text}`);
    }
  },
  {
    name: "region N-04: a reference whose region a new line or circle divided says so by name, with the part the feature no longer covers (1 mm from the edge and a circle across the edge were silent)",
    run: async () => {
      const sketch = sketchOf([rect("plate", [0, 0], 80, 10)]);
      const ref = detectSketchProfiles(sketch)[0]!.ref!;
      const cases: readonly (readonly [string, readonly SketchEntity[]])[] = [
        ["a line 1 mm from the edge", [line("cut", [39, -5], [39, 5])]],
        ["a line 0.2 mm from the edge", [line("cut", [39.8, -5], [39.8, 5])]],
        ["a circle across the edge", [circ("x", [40, 0], 3)]]
      ];
      for (const [name, extra] of cases) {
        const built = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([rect("plate", [0, 0], 80, 10), ...extra])));
        assert(built.ok, `${name}: still builds on the best-matching part`);
        if (!built.ok) continue;
        assert((built.warnings ?? []).some((note) => /divided by new geometry/u.test(note) && /no longer in this feature/u.test(note)), `${name}: the division is reported: ${(built.warnings ?? []).join(" | ") || "silent"}`);
      }
      const quiet = await rebuildSolidFeature(solidFeature("extrude", { profileIds: [ref] }), sketchFeatureOf(sketchOf([rect("plate", [0, 0], 80, 10)])));
      assert(quiet.ok && (quiet.warnings ?? []).length === 0, "an unchanged sketch says nothing");
    }
  }
];
