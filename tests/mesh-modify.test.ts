import { meshChamfer, meshFillet, meshHole, meshShell, type ModifyMeshInput } from "../packages/workbench-geometry/src/index.js";
import { assert, type TestCase } from "./test-kit.js";

/** Axis-aligned box as 12 outward triangles, matching the mesh-boolean test fixture. */
function box(min: readonly [number, number, number], max: readonly [number, number, number]): ModifyMeshInput {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positionsMm = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const quads: readonly (readonly [number, number, number, number])[] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const indices: number[] = [];
  quads.forEach(([a, b, c, d]) => { indices.push(a, b, c, a, c, d); });
  return { positionsMm, indices };
}

function volumeOf(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number {
  let total = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3; const b = mesh.indices[i + 1]! * 3; const c = mesh.indices[i + 2]! * 3;
    const p = mesh.positionsMm;
    total += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return total / 6;
}

export const meshModifyTests: readonly TestCase[] = [
  {
    name: "Hole subtracts a vertical cylinder through a block",
    run: () => {
      const body = box([0, 0, 0], [40, 40, 20]);
      const result = meshHole(body, { diameterMm: 10, depthMm: 40, axis: "z", originMm: [20, 20, 20] });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      // Expected volume: 40 * 40 * 20 - pi * 5^2 * 20 = 32000 - 500 pi
      const expected = 40 * 40 * 20 - Math.PI * 25 * 20;
      const actual = volumeOf(result);
      // The cylinder is tessellated, so volume is slightly below the exact circle.
      assert(actual < 40 * 40 * 20, `the hole removed material: got ${actual.toFixed(1)}`);
      assert(Math.abs(actual - expected) / expected < 0.05, `the hole volume is close to pi r² h: expected ${expected.toFixed(1)}, got ${actual.toFixed(1)}`);
    }
  },
  {
    name: "Hole rejects zero or negative sizes",
    run: () => {
      const body = box([0, 0, 0], [20, 20, 20]);
      const bad1 = meshHole(body, { diameterMm: 0, depthMm: 10 });
      assert(!bad1.ok, "zero diameter is refused");
      const bad2 = meshHole(body, { diameterMm: 5, depthMm: -1 });
      assert(!bad2.ok, "negative depth is refused");
    }
  },
  {
    name: "Chamfer bevels every convex edge of a block, removing the expected corner volume",
    run: () => {
      const body = box([0, 0, 0], [20, 20, 20]);
      const result = meshChamfer(body, { sizeMm: 2, angleThresholdDeg: 5 });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const original = 20 * 20 * 20;
      const actual = volumeOf(result);
      assert(actual > 0 && actual < original, `chamfer leaves a positive but smaller volume: got ${actual.toFixed(1)} out of ${original}`);
      // A 2-mm chamfer removes 12 edge prisms (each roughly 2 mm triangular × 16 mm long) ≈ 384 mm³, minus corner overlap.
      const removed = original - actual;
      assert(removed > 100 && removed < 1500, `chamfer removal in a plausible envelope: ${removed.toFixed(1)}`);
    }
  },
  {
    name: "Fillet rounds every convex edge of a block",
    run: () => {
      const body = box([0, 0, 0], [20, 20, 20]);
      const result = meshFillet(body, { sizeMm: 2, segments: 6 });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const original = 20 * 20 * 20;
      const actual = volumeOf(result);
      assert(actual > 0 && actual < original, `fillet leaves a positive but smaller volume: got ${actual.toFixed(1)}`);
    }
  },
  {
    name: "Shell hollows a block and leaves the +Z face open",
    run: () => {
      const body = box([0, 0, 0], [30, 30, 30]);
      const result = meshShell(body, { thicknessMm: 2, openFace: "+z" });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const original = 30 * 30 * 30;
      const actual = volumeOf(result);
      assert(actual > 0 && actual < original, `shell leaves a positive but smaller volume: got ${actual.toFixed(1)}`);
      assert(actual < original / 2, `shell removes most of the interior: got ${actual.toFixed(1)}`);
    }
  },
  {
    name: "Chamfer refuses an impossibly large distance",
    run: () => {
      const body = box([0, 0, 0], [20, 20, 20]);
      const result = meshChamfer(body, { sizeMm: 100 });
      // Each cutter will fail, so the module returns ok:false.
      assert(!result.ok, "a chamfer much larger than the body is refused");
    }
  }
];
