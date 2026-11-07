import { tessellateExtrude, tessellateLoft, tessellateSweep } from "../packages/workbench-geometry/src/tessellate.js";
import { assert, near, type TestCase } from "./test-kit.js";

// A 10×10 square centred at (5, 5): the simplest profile that demonstrates every triangle in a prism.
const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

function vertexCount(mesh: ReturnType<typeof tessellateSweep>): number {
  return mesh.positionsMm.length / 3;
}

function meshBounds(mesh: ReturnType<typeof tessellateSweep>): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positionsMm.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positionsMm[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

export const sweepAndLoftTests: readonly TestCase[] = [
  {
    name: "sweep along +Z 20 mm on the XY plane matches the equivalent extrude",
    run: () => {
      const extrude = tessellateExtrude(SQUARE, 20, "xy");
      const sweep = tessellateSweep(SQUARE, [0, 0, 1], 20, "xy");
      assert(vertexCount(sweep) === vertexCount(extrude), "a sweep along the plane normal has the same vertex count as the equivalent extrude");
      const extrudeBounds = meshBounds(extrude);
      const sweepBounds = meshBounds(sweep);
      for (let axis = 0; axis < 3; axis += 1) {
        near(sweepBounds.min[axis]!, extrudeBounds.min[axis]!, 1e-6, `sweep min[${axis}] matches extrude`);
        near(sweepBounds.max[axis]!, extrudeBounds.max[axis]!, 1e-6, `sweep max[${axis}] matches extrude`);
      }
    }
  },
  {
    name: "sweep along +X 15 mm (parallel to the sketch plane normal mixed with in-plane) shifts the top ring",
    run: () => {
      // On XY the normal is +Z. Mixed direction (1,0,1) should produce a sweep ending at top-of-prism shifted +15 in x.
      const sweep = tessellateSweep(SQUARE, [1, 0, 1], 15, "xy");
      assert(vertexCount(sweep) === 8, "8 vertices for a 4-sided profile swept once");
      const bounds = meshBounds(sweep);
      // The top ring (last four vertices) should be at z = 15/√2 and shifted in x by 15/√2.
      const shift = 15 / Math.SQRT2;
      // The full prism should span in x from 0 to 10 + shift and in z from 0 to shift.
      near(bounds.min[0]!, 0, 1e-6, "min x is 0 (base ring)");
      near(bounds.max[0]!, 10 + shift, 1e-6, "max x is base-width + shift (top ring)");
      near(bounds.min[2]!, 0, 1e-6, "min z is 0");
      near(bounds.max[2]!, shift, 1e-6, "max z is shift");
    }
  },
  {
    name: "sweep refuses a zero-magnitude direction",
    run: () => {
      const mesh = tessellateSweep(SQUARE, [0, 0, 0], 10, "xy");
      assert(mesh.positionsMm.length === 0 && mesh.indices.length === 0, "zero direction returns an empty mesh");
    }
  },
  {
    name: "loft with top scale 0.5 and height 20 mm gives a pyramid-like frustum centred at the base centroid",
    run: () => {
      // Centroid of the square is (5, 5). Top ring vertices should be at (5 + (vx-5)*0.5, 5 + (vy-5)*0.5, 20).
      const mesh = tessellateLoft(SQUARE, 0.5, 20, "xy");
      const bounds = meshBounds(mesh);
      near(bounds.min[0]!, 0, 1e-6, "base ring still spans x = 0 to 10");
      near(bounds.max[0]!, 10, 1e-6, "base ring still spans x = 0 to 10");
      near(bounds.min[2]!, 0, 1e-6, "base at z = 0");
      near(bounds.max[2]!, 20, 1e-6, "top at z = 20");
      // The top ring half-width is 2.5 (0.5 × 5), so the top edges should be between 2.5 and 7.5 at z = 20.
      let topMin = Infinity;
      let topMax = -Infinity;
      for (let index = 0; index < mesh.positionsMm.length; index += 3) {
        if (Math.abs(mesh.positionsMm[index + 2]! - 20) < 1e-6) {
          const x = mesh.positionsMm[index]!;
          if (x < topMin) topMin = x;
          if (x > topMax) topMax = x;
        }
      }
      near(topMin, 2.5, 1e-6, "top ring x goes down to 2.5");
      near(topMax, 7.5, 1e-6, "top ring x goes up to 7.5");
    }
  },
  {
    name: "loft with top scale 1 and height 10 mm is equivalent to an extrude of 10 mm",
    run: () => {
      const extrude = tessellateExtrude(SQUARE, 10, "xy");
      const loft = tessellateLoft(SQUARE, 1, 10, "xy");
      const eBounds = meshBounds(extrude);
      const lBounds = meshBounds(loft);
      for (let axis = 0; axis < 3; axis += 1) {
        near(lBounds.min[axis]!, eBounds.min[axis]!, 1e-6, `loft min[${axis}] matches extrude`);
        near(lBounds.max[axis]!, eBounds.max[axis]!, 1e-6, `loft max[${axis}] matches extrude`);
      }
    }
  },
  {
    name: "loft refuses a non-positive top scale",
    run: () => {
      const mesh = tessellateLoft(SQUARE, 0, 10, "xy");
      assert(mesh.positionsMm.length === 0 && mesh.indices.length === 0, "zero top scale returns an empty mesh");
    }
  }
];
