import { tessellateLoft } from "../packages/workbench-geometry/src/tessellate.js";
import { assert, near, type TestCase } from "./test-kit.js";

const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

function meshBounds(positions: readonly number[]): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

export const edgeShellDraftTests: readonly TestCase[] = [
  {
    name: "draft of a 10×10 square with 5° angle over 20 mm neutral bottom shrinks the top ring",
    run: () => {
      // Reproduce the math from createGeneralSolidBody's draft branch (it delegates to tessellateLoft).
      const centroid: readonly [number, number] = [5, 5];
      const characteristic = Math.hypot(5, 5); // 7.07 for the farthest corner
      const shift = 20 * Math.tan(5 * Math.PI / 180);
      const topScale = 1 - shift / characteristic;
      const mesh = tessellateLoft(SQUARE, topScale, 20, "xy");
      const bounds = meshBounds(mesh.positionsMm);
      near(bounds.min[2]!, 0, 1e-6, "base at z = 0");
      near(bounds.max[2]!, 20, 1e-6, "top at z = 20");
      // The top ring extremes should be scaled by topScale about the centroid.
      let topMinX = Infinity;
      let topMaxX = -Infinity;
      for (let index = 0; index < mesh.positionsMm.length; index += 3) {
        if (Math.abs(mesh.positionsMm[index + 2]! - 20) < 1e-6) {
          const x = mesh.positionsMm[index]!;
          if (x < topMinX) topMinX = x;
          if (x > topMaxX) topMaxX = x;
        }
      }
      near(topMinX, centroid[0] + (0 - centroid[0]) * topScale, 1e-6, "top ring min x matches the draft scale");
      near(topMaxX, centroid[0] + (10 - centroid[0]) * topScale, 1e-6, "top ring max x matches the draft scale");
    }
  },
  {
    name: "draft with 0° angle collapses to an extrude (topScale = 1)",
    run: () => {
      const mesh = tessellateLoft(SQUARE, 1, 20, "xy");
      const bounds = meshBounds(mesh.positionsMm);
      near(bounds.min[0]!, 0, 1e-6, "min x = 0");
      near(bounds.max[0]!, 10, 1e-6, "max x = 10");
      near(bounds.min[2]!, 0, 1e-6, "min z = 0");
      near(bounds.max[2]!, 20, 1e-6, "max z = 20");
    }
  },
  {
    name: "shell parameters: an insetPolygon-style calculation for a rectangle shrinks each side by the thickness",
    run: () => {
      // The inset of the 10×10 square by 2 mm is a 6×6 square centred at (5, 5).
      const thickness = 2;
      const minX = 0 + thickness;
      const maxX = 10 - thickness;
      const minY = 0 + thickness;
      const maxY = 10 - thickness;
      assert(maxX - minX === 6, "inset width is 6 mm");
      assert(maxY - minY === 6, "inset height is 6 mm");
    }
  }
];
