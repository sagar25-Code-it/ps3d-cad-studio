import { resampleClosedPolygon, resamplePath, tessellateLoftTwoProfiles, tessellateSweep, tessellateSweepPath } from "../packages/workbench-geometry/src/tessellate.js";
import { assert, near, type TestCase } from "./test-kit.js";

const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const TRIANGLE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [5, 10]];
const FAR_SQUARE: readonly (readonly [number, number])[] = [[0, 0], [20, 0], [20, 20], [0, 20]];

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

export const loftResampleRailTwistTests: readonly TestCase[] = [
  {
    name: "resampleClosedPolygon on a 10×10 square at 8 points places evenly spaced samples around the perimeter",
    run: () => {
      const result = resampleClosedPolygon(SQUARE, 8);
      assert(result.length === 8, "returns 8 samples");
      // Perimeter = 40; each sample sits at a 5 mm step. Starting at (0, 0), the second sample is (5, 0), the third (10, 0), the fifth (10, 10), etc.
      near(result[0]![0], 0, 1e-6, "sample 0 x = 0");
      near(result[0]![1], 0, 1e-6, "sample 0 y = 0");
      near(result[1]![0], 5, 1e-6, "sample 1 x = 5 (halfway along bottom edge)");
      near(result[1]![1], 0, 1e-6, "sample 1 y = 0");
      near(result[2]![0], 10, 1e-6, "sample 2 x = 10 (corner)");
      near(result[2]![1], 0, 1e-6, "sample 2 y = 0");
    }
  },
  {
    name: "two-profile loft resamples mismatched vertex counts (triangle ↔ square) instead of refusing",
    run: () => {
      const mesh = tessellateLoftTwoProfiles(SQUARE, TRIANGLE, 20, "position", "xy");
      assert(mesh.positionsMm.length > 0, "a mismatched-count loft now returns a mesh");
      assert(mesh.indices.length > 0, "indices are present");
      const bounds = meshBounds(mesh.positionsMm);
      near(bounds.min[2]!, 0, 1e-6, "base at z = 0");
      near(bounds.max[2]!, 20, 1e-6, "top at z = 20");
    }
  },
  {
    name: "resamplePath on an open 2-point line produces equally spaced samples including both endpoints",
    run: () => {
      const result = resamplePath([[0, 0], [10, 0]], 5);
      assert(result.length === 5, "returns 5 samples");
      near(result[0]![0], 0, 1e-6, "endpoint 0");
      near(result[4]![0], 10, 1e-6, "endpoint 1");
      near(result[2]![0], 5, 1e-6, "middle sample at 5 mm");
    }
  },
  {
    name: "loft rail bends the ring centroids away from the straight interpolation",
    run: () => {
      // Base centroid at (5, 5), top centroid at (10, 10). The rail goes through (0, 0), (0, 20), (10, 10) —
      // an L shape — so the middle ring centroid should sit near the rail's midpoint, not on the straight line
      // between the two profile centroids.
      const rail: readonly (readonly [number, number])[] = [[5, 5], [5, 20], [10, 10]];
      const base = SQUARE; // centroid (5, 5)
      const top = FAR_SQUARE.map(([x, y]) => [x + 5, y + 5] as const); // centroid (15, 15)
      const straightMesh = tessellateLoftTwoProfiles(base, top, 20, "position", "xy", 12);
      const railedMesh = tessellateLoftTwoProfiles(base, top, 20, "position", "xy", 12, rail);
      assert(straightMesh.positionsMm.length > 0, "straight mesh is produced");
      assert(railedMesh.positionsMm.length > 0, "railed mesh is produced");
      // A railed mesh with a bent rail should have a larger max-Y than the straight one, because the rail's
      // middle sample lifts the ring centroids outside the straight interpolation line.
      const straightBounds = meshBounds(straightMesh.positionsMm);
      const railedBounds = meshBounds(railedMesh.positionsMm);
      assert(railedBounds.max[1]! > straightBounds.max[1]! + 0.5, `rail bend should raise max y (straight ${straightBounds.max[1]}, railed ${railedBounds.max[1]})`);
    }
  },
  {
    name: "sweep twist 180° about the plane normal flips the top ring left/right about the centroid",
    run: () => {
      // Untwisted sweep: the top ring sits at (0..10, 0..10, 5). With twist 180° about the profile centroid (5, 5),
      // the top ring ends up at the same bounding box (the square is symmetric). Pick an ASYMMETRIC profile instead.
      const asymmetric: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10]]; // centroid ≈ (6.67, 3.33)
      const untwisted = tessellateSweep(asymmetric, [0, 0, 1], 5, "xy", 0);
      const twisted = tessellateSweep(asymmetric, [0, 0, 1], 5, "xy", 180);
      // Base ring is the same for both (first 3 vertices). Top ring (last 3) should differ.
      const untwistedTop = untwisted.positionsMm.slice(9);
      const twistedTop = twisted.positionsMm.slice(9);
      let differences = 0;
      for (let i = 0; i < untwistedTop.length; i += 1) if (Math.abs(untwistedTop[i]! - twistedTop[i]!) > 1e-4) differences += 1;
      assert(differences > 0, `twist 180° must change the top-ring positions (differences = ${differences})`);
    }
  },
  {
    name: "path sweep twist 90° rotates each ring progressively; the final ring is at 90°",
    run: () => {
      // A 2-sample straight path along +X, 5 mm long; twist 90°. Top ring should be 90° rotated from base about centroid.
      const asymmetric: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10]];
      const path: readonly (readonly [number, number])[] = [[0, 0], [20, 0]];
      const twisted = tessellateSweepPath(asymmetric, path, 5, "xy", 90);
      // Base ring first, top ring LAST: a twisted sweep has stations between its ends (re-audit R2-05: two rings folded the sweep), so the top ring is no longer
      // the second one. Check the top vertex [0, 0] should move to approximately rotated-by-90° position.
      const rings = twisted.positionsMm.length / (3 * 3);
      assert(rings > 2, "the twisted sweep has stations between its ends");
      // centroid ≈ (6.67, 3.33). Vertex (0, 0) → relative (-6.67, -3.33). Rotate by +90°: (3.33, -6.67). Plus centroid: (10, -3.33). Plus path offset (20, 0): (30, -3.33).
      const topStart = (rings - 1) * 3 * 3;
      near(twisted.positionsMm[topStart + 0]!, 30, 0.01, "twisted vertex x");
      near(twisted.positionsMm[topStart + 1]!, -3.3333, 0.01, "twisted vertex y");
    }
  }
];
