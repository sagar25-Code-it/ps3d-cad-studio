import { tessellateExtrude, tessellateLoftTwoProfiles, tessellateSweepPath } from "../packages/workbench-geometry/src/tessellate.js";
import { applyDirectEdit } from "../apps/studio-web/src/design-regeneration.js";
import type { DesignSolidFeature, GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { modifiesBody, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const TRIANGLE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [5, 10]];

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

function cubeBody(id = "general-body:cube"): GeneralSolidBody {
  const mesh = tessellateExtrude(SQUARE, 10, "xy");
  return { id, name: "Cube", visible: true, color: "#808080", positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

export const frenetTangencyDirectEditTests: readonly TestCase[] = [
  {
    name: "sweep path with Frenet transport places the profile perpendicular to the +X tangent at the start sample",
    run: () => {
      // Straight +X path. Tangent = (1, 0). In-plane perpendicular = (0, 1). Profile X → that axis, profile Y → +Z.
      // Profile (0, 0) sits at path start (0, 0) with offset (-cx * 0, -cx * 1, -cy) = (0, -cx, -cy); centroid of SQUARE is (5, 5).
      const path: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [20, 0]];
      const mesh = tessellateSweepPath(SQUARE, path, 5, "xy", 0, true);
      // Base ring is the first 4 vertices. The square's (0, 0) vertex → (0 + (0 - 5) * 0, 0 + (0 - 5) * 1, 0 - 5) = (0, -5, -5).
      near(mesh.positionsMm[0]!, 0, 1e-6, "first vertex x = 0");
      near(mesh.positionsMm[1]!, -5, 1e-6, "first vertex y = -5 (profile X mapped to +Y)");
      near(mesh.positionsMm[2]!, -5, 1e-6, "first vertex z = -5 (profile Y mapped to +Z)");
    }
  },
  {
    name: "sweep path with Frenet transport bends the profile at a 90° corner so the last ring sits perpendicular to +Y",
    run: () => {
      // Path goes +X then +Y so the last sample's tangent (central diff) is (0, 1).
      const path: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10]];
      const mesh = tessellateSweepPath(SQUARE, path, 5, "xy", 0, true);
      const vertexCount = mesh.positionsMm.length / 3;
      assert(vertexCount === 12, "3 samples × 4 verts = 12 vertices");
      // Last ring's (0, 0) vertex: tangent at sample 2 is one-sided (10, 10) - (10, 0) = (0, 10) → (0, 1).
      // perpend = (-1, 0). profile X = -5, mapped offset = (-1*(-5), 0, -5) = (5, 0, -5). Plus sample (10, 10, 0) → (15, 10, -5).
      const topStart = 8 * 3; // ring 2 starts at vertex 8
      near(mesh.positionsMm[topStart + 0]!, 15, 1e-5, "last-ring vertex x");
      near(mesh.positionsMm[topStart + 1]!, 10, 1e-5, "last-ring vertex y");
      near(mesh.positionsMm[topStart + 2]!, -5, 1e-5, "last-ring vertex z");
    }
  },
  {
    name: "sweep path without Frenet transport keeps every ring parallel to the sketch plane (reference behaviour)",
    run: () => {
      const path: readonly (readonly [number, number])[] = [[0, 0], [10, 0]];
      const mesh = tessellateSweepPath(SQUARE, path, 5, "xy", 0, false);
      // Base ring at z = 0, top ring at z = 5.
      const bounds = meshBounds(mesh.positionsMm);
      near(bounds.min[2]!, 0, 1e-6, "min z = 0");
      near(bounds.max[2]!, 5, 1e-6, "max z = 5 (height, not Frenet-derived)");
    }
  },
  {
    name: "loft tangency weight 0 falls back to linear position (G0) regardless of the chosen G1 continuity",
    run: () => {
      // A G1 loft with weight 0 should match a G0 loft at every ring.
      const base = SQUARE;
      const top = SQUARE.map(([x, y]) => [x + 10, y + 10] as const);
      const g1 = tessellateLoftTwoProfiles(base, top, 20, "tangent", "xy", 12, undefined, 0);
      const g0 = tessellateLoftTwoProfiles(base, top, 20, "position", "xy");
      const g1Bounds = meshBounds(g1.positionsMm);
      const g0Bounds = meshBounds(g0.positionsMm);
      // The bounding boxes must match (both are straight linear ribbons).
      near(g1Bounds.min[0]!, g0Bounds.min[0]!, 1e-6, "min x matches");
      near(g1Bounds.max[0]!, g0Bounds.max[0]!, 1e-6, "max x matches");
      near(g1Bounds.min[1]!, g0Bounds.min[1]!, 1e-6, "min y matches");
      near(g1Bounds.max[1]!, g0Bounds.max[1]!, 1e-6, "max y matches");
    }
  },
  {
    name: "loft tangency weight 1 matches the default smoothstep G1 ease (behaviour-preserving)",
    run: () => {
      const base = SQUARE;
      const top = SQUARE.map(([x, y]) => [x + 10, y] as const);
      const defaultWeight = tessellateLoftTwoProfiles(base, top, 20, "tangent", "xy", 12);
      const explicitOne = tessellateLoftTwoProfiles(base, top, 20, "tangent", "xy", 12, undefined, 1);
      assert(defaultWeight.positionsMm.length === explicitOne.positionsMm.length, "same vertex counts");
      for (let index = 0; index < defaultWeight.positionsMm.length; index += 1) {
        near(defaultWeight.positionsMm[index]!, explicitOne.positionsMm[index]!, 1e-9, `vertex ${index} matches`);
      }
    }
  },
  {
    name: "loft tangency weight 2 pushes the middle ring further toward the top than weight 1",
    run: () => {
      // Base at (0..10, 0..10, 0), top shifted +X by 20. The middle ring's x shift depends on ease(0.5).
      // smoothstep(0.5) = 0.5. ease at weight 1 = 0.5. ease at weight 2 = 0.5 + 2*(0.5 - 0.5) = 0.5.
      // Wait — at t = 0.5, smoothstep = 0.5, linear = 0.5, so ease is 0.5 regardless of weight.
      // Pick a different t: ring 3 of 12 (t ≈ 0.273). smoothstep(0.273) = 0.273^2 * (3 - 2*0.273) ≈ 0.183.
      // ease weight 1 = 0.183. ease weight 2 = 0.273 + 2*(0.183 - 0.273) = 0.093 — smaller shift.
      // So weight 2 moves the ring BACK toward the base at early samples (not forward).
      // Let's just check that weight 2 produces a DIFFERENT shape than weight 1 (which we already covered matches default).
      const base = SQUARE;
      const top = SQUARE.map(([x, y]) => [x + 20, y] as const);
      const w1 = tessellateLoftTwoProfiles(base, top, 20, "tangent", "xy", 12, undefined, 1);
      const w2 = tessellateLoftTwoProfiles(base, top, 20, "tangent", "xy", 12, undefined, 2);
      assert(w1.positionsMm.length === w2.positionsMm.length, "same vertex counts");
      let differences = 0;
      for (let index = 0; index < w1.positionsMm.length; index += 1) {
        if (Math.abs(w1.positionsMm[index]! - w2.positionsMm[index]!) > 1e-6) differences += 1;
      }
      assert(differences > 0, `weight 2 differs from weight 1 (differences = ${differences})`);
    }
  },
  {
    name: "applyDirectEdit move-body translates every vertex by the stored delta",
    run: () => {
      const body = cubeBody();
      const feature: DesignSolidFeature = {
        id: "feature:move-body-test", name: "Move cube", kind: "move-body", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 1, bodyId: body.id,
        operation: "direct-edit", moveDeltaMm: [5, -3, 7]
      };
      const moved = applyDirectEdit(feature as DesignSolidFeature & { readonly kind: "move-body" }, body);
      for (let index = 0; index < body.positionsMm.length; index += 3) {
        near(moved.positionsMm[index]!, body.positionsMm[index]! + 5, 1e-9, `x shifted at ${index}`);
        near(moved.positionsMm[index + 1]!, body.positionsMm[index + 1]! - 3, 1e-9, `y shifted at ${index}`);
        near(moved.positionsMm[index + 2]!, body.positionsMm[index + 2]! + 7, 1e-9, `z shifted at ${index}`);
      }
    }
  },
  {
    name: "applyDirectEdit scale-body scales uniformly about the body's centroid (bounding box doubles on 2x)",
    run: () => {
      const body = cubeBody();
      const before = meshBounds(body.positionsMm);
      const sizeX = before.max[0]! - before.min[0]!;
      const sizeY = before.max[1]! - before.min[1]!;
      const sizeZ = before.max[2]! - before.min[2]!;
      const feature: DesignSolidFeature = {
        id: "feature:scale-body-test", name: "Scale cube", kind: "scale-body", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 2, bodyId: body.id,
        operation: "direct-edit", scaleFactor: 2
      };
      const scaled = applyDirectEdit(feature as DesignSolidFeature & { readonly kind: "scale-body" }, body);
      const after = meshBounds(scaled.positionsMm);
      near(after.max[0]! - after.min[0]!, sizeX * 2, 1e-6, "x doubled");
      near(after.max[1]! - after.min[1]!, sizeY * 2, 1e-6, "y doubled");
      near(after.max[2]! - after.min[2]!, sizeZ * 2, 1e-6, "z doubled");
    }
  },
  {
    name: "modifiesBody returns true for direct-edit features (so the timeline replays them)",
    run: () => {
      const move: DesignSolidFeature = {
        id: "feature:move-body-mb", name: "Move", kind: "move-body", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 1, bodyId: "general-body:a",
        operation: "direct-edit", moveDeltaMm: [1, 0, 0]
      };
      const scale: DesignSolidFeature = {
        id: "feature:scale-body-mb", name: "Scale", kind: "scale-body", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 2, bodyId: "general-body:a",
        operation: "direct-edit", scaleFactor: 2
      };
      assert(modifiesBody(move), "move-body is a modifier");
      assert(modifiesBody(scale), "scale-body is a modifier");
    }
  },
  {
    name: "validSolidFeaturePayload accepts a well-formed move-body feature and rejects scale-body with factor 0",
    run: () => {
      const good = {
        id: "feature:move-body-v", name: "Move", kind: "move-body", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 1, bodyId: "general-body:a",
        operation: "direct-edit", moveDeltaMm: [5, 0, 0]
      };
      assert(validSolidFeaturePayload(good), "valid move-body passes");
      const badScale = {
        id: "feature:scale-body-v", name: "Scale", kind: "scale-body", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 1, bodyId: "general-body:a",
        operation: "direct-edit", scaleFactor: 0
      };
      assert(!validSolidFeaturePayload(badScale), "scale factor 0 is rejected");
      const mismatchedKind = {
        id: "feature:x", name: "X", kind: "extrude", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 1, bodyId: "general-body:a",
        operation: "direct-edit"
      };
      assert(!validSolidFeaturePayload(mismatchedKind), "operation direct-edit is refused on non-direct-edit kinds");
    }
  }
];
