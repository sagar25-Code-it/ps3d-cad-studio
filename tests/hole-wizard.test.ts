import { meshCounterbore, meshCountersink, meshTappedHole, METRIC_FASTENERS, type ModifyMeshInput } from "../packages/workbench-geometry/src/index.js";
import { assert, type TestCase } from "./test-kit.js";

function box(min: readonly [number, number, number], max: readonly [number, number, number]): ModifyMeshInput {
  const [x0, y0, z0] = min; const [x1, y1, z1] = max;
  const positionsMm = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const quads: readonly (readonly [number, number, number, number])[] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const indices: number[] = [];
  quads.forEach(([a, b, c, d]) => { indices.push(a, b, c, a, c, d); });
  return { positionsMm, indices };
}

function volumeOf(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number {
  let total = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3; const b = mesh.indices[i + 1]! * 3; const c = mesh.indices[i + 2]! * 3; const p = mesh.positionsMm;
    total += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return total / 6;
}

export const holeWizardTests: readonly TestCase[] = [
  {
    name: "counterbore removes pilot + head volumes from a block",
    run: () => {
      const body = box([-30, -30, 0], [30, 30, 20]);
      const spec = METRIC_FASTENERS["M6"]!;
      const result = meshCounterbore(body, { pilotDiameterMm: spec.clearanceDiameterMm, pilotDepthMm: 20, headDiameterMm: spec.counterboreDiameterMm, headDepthMm: spec.counterboreDepthMm, axis: "z", originMm: [0, 0, 20] });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const original = 60 * 60 * 20;
      const actual = volumeOf(result);
      // Removed ≈ pilot (π r_p² × 20) + (head - pilot) × head depth ≈ π(3.3² × 20 + (5.5² − 3.3²) × 6.5) ≈ 1081 mm³.
      const expectedRemoval = Math.PI * spec.clearanceDiameterMm / 2 * spec.clearanceDiameterMm / 2 * 20
        + Math.PI * (spec.counterboreDiameterMm / 2 * spec.counterboreDiameterMm / 2 - spec.clearanceDiameterMm / 2 * spec.clearanceDiameterMm / 2) * spec.counterboreDepthMm;
      const removed = original - actual;
      assert(removed > expectedRemoval * 0.85 && removed < expectedRemoval * 1.1, `removed volume ≈ pilot + head: expected ≈ ${expectedRemoval.toFixed(1)}, got ${removed.toFixed(1)}`);
    }
  },
  {
    name: "countersink refuses a cone wider than it is tall",
    run: () => {
      const body = box([-30, -30, 0], [30, 30, 20]);
      // 179° included angle with head much bigger than pilot gives a tiny sink depth; still allowed.
      // Here we test the validation path with an impossible angle (180° or 0°).
      const invalid = meshCountersink(body, { pilotDiameterMm: 5, pilotDepthMm: 20, headDiameterMm: 10, headAngleDeg: 180, axis: "z", originMm: [0, 0, 20] });
      assert(!invalid.ok, "a 180° cone is refused");
    }
  },
  {
    name: "countersink produces a smaller volume than the original block",
    run: () => {
      const body = box([-30, -30, 0], [30, 30, 20]);
      const spec = METRIC_FASTENERS["M6"]!;
      const result = meshCountersink(body, { pilotDiameterMm: spec.clearanceDiameterMm, pilotDepthMm: 20, headDiameterMm: spec.countersinkDiameterMm, headAngleDeg: 90, axis: "z", originMm: [0, 0, 20] });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const original = 60 * 60 * 20;
      const actual = volumeOf(result);
      assert(actual > 0 && actual < original, `countersink leaves a positive, smaller volume: got ${actual.toFixed(1)}`);
    }
  },
  {
    name: "tapped hole drills the ISO tap-drill diameter (≈ 0.85 × nominal)",
    run: () => {
      const body = box([-20, -20, 0], [20, 20, 10]);
      const spec = METRIC_FASTENERS["M6"]!;
      const result = meshTappedHole(body, { nominalDiameterMm: spec.nominalDiameterMm, depthMm: 10, axis: "z", originMm: [0, 0, 10] });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const original = 40 * 40 * 10;
      const removed = original - volumeOf(result);
      // Expected removed volume: π × (6 × 0.85 / 2)² × 10 ≈ 81.7 mm³
      const expected = Math.PI * (spec.nominalDiameterMm * 0.85 / 2) ** 2 * 10;
      assert(removed > expected * 0.85 && removed < expected * 1.1, `tapped-hole removal near 0.85 d: expected ${expected.toFixed(1)}, got ${removed.toFixed(1)}`);
    }
  },
  {
    name: "METRIC_FASTENERS covers M3 through M10",
    run: () => {
      const sizes = ["M3", "M4", "M5", "M6", "M8", "M10"] as const;
      for (const size of sizes) {
        const spec = METRIC_FASTENERS[size];
        assert(spec !== undefined, `${size} is defined`);
        if (spec === undefined) continue;
        assert(spec.clearanceDiameterMm > spec.nominalDiameterMm, `${size}: clearance > nominal`);
        assert(spec.counterboreDiameterMm > spec.clearanceDiameterMm, `${size}: counterbore > clearance`);
        assert(spec.countersinkDiameterMm > spec.clearanceDiameterMm, `${size}: countersink > clearance`);
      }
    }
  }
];
