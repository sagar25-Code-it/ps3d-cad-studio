import { evaluateConstructionPlane } from "../packages/workbench-geometry/src/construction-geometry.js";
import { tessellateExtrude, tessellateLoftTwoProfiles, tessellateSweepPath } from "../packages/workbench-geometry/src/tessellate.js";
import type { ConstructionPlane, GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const SHIFTED_SQUARE: readonly (readonly [number, number])[] = [[-2, -2], [2, -2], [2, 2], [-2, 2]];

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

// A revolved body on the XY plane: 36 vertices on a ring of radius 10 at z = 0.
function ringBody(): GeneralSolidBody {
  const positionsMm: number[] = [];
  const count = 36;
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * Math.PI * 2;
    positionsMm.push(10 * Math.cos(theta), 10 * Math.sin(theta), 0);
  }
  return {
    id: "general-body:ring",
    name: "Ring",
    visible: true,
    color: "#b9c2c8",
    positionsMm,
    indices: [0, 1, 2],
    feature: { operation: "revolve", plane: "xy", valueMm: 360 }
  };
}

export const tangentLoftSweepPathTests: readonly TestCase[] = [
  {
    name: "tangent-to-cylinder plane at 0° sits at (10, 0, 0) with +X normal",
    run: () => {
      const body = ringBody();
      const plane: ConstructionPlane = { id: "construction-plane:t", name: "Tangent", visible: true, definition: { kind: "tangent-to-cylinder", bodyId: body.id, angleDeg: 0 } };
      const frame = evaluateConstructionPlane(plane, [body]);
      assert(!("error" in frame), "the plane evaluates");
      if ("error" in frame) return;
      near(frame.origin[0], 10, 1e-4, "origin x on cylinder surface");
      near(frame.origin[1], 0, 1e-4, "origin y = 0 at 0°");
      near(frame.normal[0], 1, 1e-4, "outward normal is +X");
      near(frame.normal[1], 0, 1e-4, "outward normal y = 0");
    }
  },
  {
    name: "tangent-to-cylinder plane at 90° sits at (0, 10, 0) with +Y normal",
    run: () => {
      const body = ringBody();
      const plane: ConstructionPlane = { id: "construction-plane:t2", name: "Tangent 90°", visible: true, definition: { kind: "tangent-to-cylinder", bodyId: body.id, angleDeg: 90 } };
      const frame = evaluateConstructionPlane(plane, [body]);
      assert(!("error" in frame), "the plane evaluates");
      if ("error" in frame) return;
      near(frame.origin[0], 0, 1e-4, "origin x = 0 at 90°");
      near(frame.origin[1], 10, 1e-4, "origin y on cylinder surface");
      near(frame.normal[1], 1, 1e-4, "outward normal is +Y");
    }
  },
  {
    name: "tangent-to-cylinder refuses when the body is unknown",
    run: () => {
      const plane: ConstructionPlane = { id: "construction-plane:bad", name: "No body", visible: true, definition: { kind: "tangent-to-cylinder", bodyId: "general-body:missing", angleDeg: 0 } };
      const frame = evaluateConstructionPlane(plane, []);
      assert("error" in frame, "missing body is refused");
    }
  },
  {
    name: "two-profile loft G0: position-only ring between inner (2×2) and outer (10×10) is 2 rings (6 cap + 6 cap + 8 side) × 3 verts",
    run: () => {
      const mesh = tessellateLoftTwoProfiles(SQUARE, SHIFTED_SQUARE, 20, "position", "xy");
      const bounds = meshBounds(mesh.positionsMm);
      near(bounds.min[2]!, 0, 1e-6, "base at z = 0");
      near(bounds.max[2]!, 20, 1e-6, "top at z = 20");
      // Base ring has 4 verts, top ring has 4 verts. 2 rings total.
      const vertexCount = mesh.positionsMm.length / 3;
      assert(vertexCount === 8, "G0 loft uses 2 rings of 4 verts each");
    }
  },
  {
    name: "two-profile loft G1: tangent continuity bumps the ring count above 2 (smoothstep sampling)",
    run: () => {
      const mesh = tessellateLoftTwoProfiles(SQUARE, SHIFTED_SQUARE, 20, "tangent", "xy");
      const vertexCount = mesh.positionsMm.length / 3;
      assert(vertexCount > 8, `G1 loft samples the ribbon with more rings (got ${vertexCount} verts)`);
      // A G1 smoothstep ribbon at t = 0 should match bottom ring; at t = 1 should match top ring.
      // Verify an intermediate ring sits between them.
      const midRingStart = Math.floor(vertexCount / 2) * 3;
      const z = mesh.positionsMm[midRingStart + 2]!;
      assert(z > 0 && z < 20, "intermediate ring sits strictly between the caps");
    }
  },
  {
    name: "two-profile loft resamples when one profile has fewer vertices",
    run: () => {
      const triangle: readonly (readonly [number, number])[] = [[0, 0], [5, 0], [2.5, 5]];
      const mesh = tessellateLoftTwoProfiles(SQUARE, triangle, 10, "position", "xy");
      // After the resampling refresh (loft-resample-rail-twist push), mismatched profiles are resampled to a common
      // count instead of being refused. The resulting mesh must therefore be non-empty.
      assert(mesh.positionsMm.length > 0, "resampling yields a mesh");
      assert(mesh.indices.length > 0, "indices are present");
    }
  },
  {
    name: "sweep-along-path traces a two-sample line path identically to the start+end extrude pair",
    run: () => {
      const path: readonly (readonly [number, number])[] = [[0, 0], [20, 0]];
      const mesh = tessellateSweepPath(SQUARE, path, 5, "xy");
      const vertexCount = mesh.positionsMm.length / 3;
      assert(vertexCount === 8, "two samples × 4-vertex profile = 8 vertices");
      const bounds = meshBounds(mesh.positionsMm);
      near(bounds.min[0]!, 0, 1e-6, "min x");
      near(bounds.max[0]!, 30, 1e-6, "max x = 10 (profile) + 20 (path offset)");
      near(bounds.min[2]!, 0, 1e-6, "min z");
      near(bounds.max[2]!, 5, 1e-6, "max z = valueMm");
    }
  },
  {
    name: "sweep-along-path with 4 samples builds 4 rings × 4 verts = 16 vertices",
    run: () => {
      const path: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [20, 5], [30, 5]];
      const mesh = tessellateSweepPath(SQUARE, path, 10, "xy");
      assert(mesh.positionsMm.length / 3 === 16, "4 samples × 4-vertex profile = 16 vertices");
      // The top ring (last 4 verts) should sit at z = 10 and be shifted by 30 in x and 5 in y.
      const topStart = 12 * 3;
      const bounds = meshBounds(mesh.positionsMm.slice(topStart));
      near(bounds.min[0]!, 30, 1e-6, "top ring min x");
      near(bounds.max[0]!, 40, 1e-6, "top ring max x");
      near(bounds.min[1]!, 5, 1e-6, "top ring min y");
      near(bounds.max[1]!, 15, 1e-6, "top ring max y");
      near(bounds.min[2]!, 10, 1e-6, "top ring at z = 10");
    }
  },
  {
    name: "sweep-along-path collapses to an empty mesh with fewer than two samples",
    run: () => {
      const mesh = tessellateSweepPath(SQUARE, [[0, 0]], 5, "xy");
      assert(mesh.positionsMm.length === 0, "a single-sample path is refused");
    }
  }
];

void tessellateExtrude; // keep import stable for shape consistency in other tests
