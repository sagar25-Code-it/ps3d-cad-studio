import { solidMetrics } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** An axis-aligned box from (x0,y0,z0) to (x1,y1,z1) with outward counter-clockwise triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { readonly positions: number[]; readonly indices: number[] } {
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const indices = [
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    2, 3, 7, 2, 7, 6, // back (+y)
    1, 2, 6, 1, 6, 5, // right (+x)
    3, 0, 4, 3, 4, 7  // left (-x)
  ];
  return { positions, indices };
}

const close = (actual: number, expected: number, message: string): void => assert(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

export const solidMetricsTests: readonly TestCase[] = [
  {
    name: "a 10 x 20 x 30 box measures its exact volume, area, size and centre",
    run() {
      const { positions, indices } = box(0, 0, 0, 10, 20, 30);
      const metrics = solidMetrics(positions, indices);
      close(metrics.volumeMm3, 6000, "volume");
      close(metrics.surfaceAreaMm2, 2 * (200 + 300 + 600), "area");
      equal(metrics.triangleCount, 12, "triangle count");
      equal(metrics.sizeMm.join(","), "10,20,30", "size");
      equal(metrics.centroidMm.join(","), "5,10,15", "centre");
      equal(metrics.outward, true, "outward winding");
    }
  },
  {
    name: "the centre of a solid that sits away from the origin is the middle of the solid, not the origin",
    run() {
      const { positions, indices } = box(100, -40, 7, 110, -30, 17);
      const metrics = solidMetrics(positions, indices);
      close(metrics.volumeMm3, 1000, "volume");
      close(metrics.centroidMm[0], 105, "x");
      close(metrics.centroidMm[1], -35, "y");
      close(metrics.centroidMm[2], 12, "z");
    }
  },
  {
    name: "inside-out triangles still report a positive volume but are flagged as not outward",
    run() {
      const { positions, indices } = box(0, 0, 0, 2, 2, 2);
      const flipped: number[] = [];
      for (let corner = 0; corner < indices.length; corner += 3) flipped.push(indices[corner]!, indices[corner + 2]!, indices[corner + 1]!);
      const metrics = solidMetrics(positions, flipped);
      close(metrics.volumeMm3, 8, "volume");
      equal(metrics.outward, false, "inside-out winding is flagged");
      close(metrics.centroidMm[0], 1, "centre is still the middle");
    }
  },
  {
    name: "triangles that name a missing vertex are skipped instead of throwing",
    run() {
      const { positions, indices } = box(0, 0, 0, 1, 1, 1);
      const metrics = solidMetrics(positions, [...indices, 0, 1, 99, -1, 2, 3]);
      equal(metrics.triangleCount, 12, "only the valid triangles count");
      close(metrics.volumeMm3, 1, "volume");
    }
  },
  {
    name: "an empty mesh measures as zeros",
    run() {
      const metrics = solidMetrics([], []);
      equal(metrics.triangleCount, 0, "no triangles");
      equal(metrics.volumeMm3, 0, "no volume");
      equal(metrics.sizeMm.join(","), "0,0,0", "no size");
      equal(metrics.centroidMm.join(","), "0,0,0", "no centre");
    }
  }
];
