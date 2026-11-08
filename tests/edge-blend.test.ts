import { booleanMeshes, meshChamfer, meshFillet, pickableEdges, nearestPickableEdge, tessellateExtrude, type ModifyMeshInput, type PickableEdge } from "../packages/workbench-geometry/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

type V3 = readonly [number, number, number];

/** A box standing on z = 0 as an extruded rectangle (60 × 40 in plan, `height` tall). */
export function slab(width = 60, depth = 40, height = 20): ModifyMeshInput {
  const mesh = tessellateExtrude([[0, 0], [width, 0], [width, depth], [0, depth]], height, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

/** An L-shaped bracket: a 40 × 10 foot with a 10 × 30 upright, `height` tall. Its inside corner is the vertical edge at (10, 10). */
export function bracket(height = 20): ModifyMeshInput {
  const mesh = tessellateExtrude([[0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30]], height, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

export const volumeOf = (mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(mesh.positionsMm, mesh.indices).volumeMm3;

const boundsOf = (mesh: { readonly positionsMm: readonly number[] }): { readonly min: V3; readonly max: V3 } => {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positionsMm.length; index += 1) {
    const axis = index % 3;
    min[axis] = Math.min(min[axis]!, mesh.positionsMm[index]!);
    max[axis] = Math.max(max[axis]!, mesh.positionsMm[index]!);
  }
  return { min, max };
};

const segmentOf = (edge: PickableEdge): readonly [V3, V3] => [edge.a, edge.b];

function edgesOf(mesh: ModifyMeshInput, includeConcave = false): readonly PickableEdge[] {
  const edges = pickableEdges(mesh, 5, { includeConcave });
  assert(typeof edges !== "string", typeof edges === "string" ? edges : "");
  return edges as readonly PickableEdge[];
}

/** The pickable edge nearest a point, as one picked segment. */
function pick(mesh: ModifyMeshInput, point: V3, includeConcave = false): readonly (readonly [V3, V3])[] {
  const found = nearestPickableEdge(edgesOf(mesh, includeConcave), point);
  assert(found !== undefined, "an edge is there to pick");
  return found.chain.map(segmentOf);
}

function assertSolid(mesh: ModifyMeshInput, label: string): void {
  assert(isClosedAndOriented(mesh.indices), `${label}: closed and consistently wound`);
  assert(solidMetrics(mesh.positionsMm, mesh.indices).outward, `${label}: faces point outward`);
}

/** Area of the corner a fillet of radius r takes from a right angle: r² (1 − π/4). */
const CORNER = 1 - Math.PI / 4;

export const edgeBlendKernelTests: readonly TestCase[] = [
  {
    name: "A constant fillet removes the corner area times the edge length, and an inside-corner fillet adds exactly the same",
    run: () => {
      const block = slab();
      const full = volumeOf(block);
      const top = pick(block, [30, 0.2, 19.8]); // the 60 mm edge along the top front
      const outside = meshFillet(block, { sizeMm: 3, segments: 24, onlyEdges: top, strict: true });
      assert(outside.ok, outside.ok ? "" : outside.message);
      if (!outside.ok) return;
      assertSolid(outside, "outside fillet");
      const expected = 9 * CORNER * 60;
      near(full - volumeOf(outside), expected, expected * 0.012, "R3 on a 60 mm edge removes (1 - π/4)·9·60");

      const l = bracket();
      const inside = pick(l, [10, 10, 10], true);
      const filled = meshFillet(l, { sizeMm: 3, segments: 24, concave: true, onlyEdges: inside, strict: true });
      assert(filled.ok, filled.ok ? "" : filled.message);
      if (!filled.ok) return;
      assertSolid(filled, "inside fillet");
      const added = volumeOf(filled) - volumeOf(l);
      near(added, 9 * CORNER * 20, 9 * CORNER * 20 * 0.012, "R3 in the inside corner adds (1 - π/4)·9·20");
      const before = boundsOf(l);
      const after = boundsOf(filled);
      for (let axis = 0; axis < 3; axis += 1) {
        near(after.min[axis]!, before.min[axis]!, 1e-6, `nothing sticks out below on axis ${axis}`);
        near(after.max[axis]!, before.max[axis]!, 1e-6, `nothing sticks out above on axis ${axis}`);
      }
    }
  },
  {
    name: "A chamfer removes d1·d2/2 times the edge length: equal, unequal (the first face is the one pointing more upward) and flipped",
    run: () => {
      const block = slab();
      const full = volumeOf(block);
      const top = pick(block, [30, 0.2, 19.8]);
      const equal = meshChamfer(block, { sizeMm: 3, onlyEdges: top, strict: true });
      assert(equal.ok, equal.ok ? "" : equal.message);
      if (equal.ok) { assertSolid(equal, "equal chamfer"); near(full - volumeOf(equal), 4.5 * 60, 0.5, "3 × 3 chamfer"); }

      const unequal = meshChamfer(block, { sizeMm: 5, secondSizeMm: 2, onlyEdges: top, strict: true });
      assert(unequal.ok, unequal.ok ? "" : unequal.message);
      if (!unequal.ok) return;
      assertSolid(unequal, "two-distance chamfer");
      near(full - volumeOf(unequal), 5 * 2 / 2 * 60, 0.5, "5 × 2 chamfer");
      // The 5 mm lands on the top face (it points more toward +Z), so the cut reaches y = 5 on the top and z = 18 on the front.
      const has = (mesh: ModifyMeshInput, y: number, z: number): boolean => {
        for (let i = 0; i < mesh.positionsMm.length; i += 3) if (Math.abs(mesh.positionsMm[i + 1]! - y) < 1e-6 && Math.abs(mesh.positionsMm[i + 2]! - z) < 1e-6) return true;
        return false;
      };
      assert(has(unequal, 5, 20) && has(unequal, 0, 18), "5 mm along the top face and 2 mm down the front face");
      const flipped = meshChamfer(block, { sizeMm: 5, secondSizeMm: 2, flip: true, onlyEdges: top, strict: true });
      assert(flipped.ok, flipped.ok ? "" : flipped.message);
      if (!flipped.ok) return;
      near(full - volumeOf(flipped), 5 * 60, 0.5, "the volume does not depend on the side");
      assert(has(flipped, 2, 20) && has(flipped, 0, 15), "flipped: 2 mm along the top, 5 mm down the front");
      assert(!meshChamfer(block, { sizeMm: 3, secondSizeMm: 2, angleDeg: 30, onlyEdges: top }).ok, "a second distance and an angle together are refused");
    }
  },
  {
    name: "A distance + angle chamfer makes the stated angle with the first face on right-angle and on other corners",
    run: () => {
      const block = slab();
      const full = volumeOf(block);
      const top = pick(block, [30, 0.2, 19.8]);
      const angled = meshChamfer(block, { sizeMm: 4, angleDeg: 30, onlyEdges: top, strict: true });
      assert(angled.ok, angled.ok ? "" : angled.message);
      if (!angled.ok) return;
      assertSolid(angled, "distance + angle chamfer");
      const second = 4 * Math.tan(Math.PI / 6);
      near(full - volumeOf(angled), 4 * second / 2 * 60, 0.5, "4 mm at 30° removes 4·(4·tan 30°)/2 per mm of edge");
      let found = false;
      for (let i = 0; i < angled.positionsMm.length; i += 3) if (Math.abs(angled.positionsMm[i + 1]! - 0) < 1e-6 && Math.abs(angled.positionsMm[i + 2]! - (20 - second)) < 1e-4) found = true;
      assert(found, "the cut reaches 4·tan 30° = 2.31 mm down the front face");

      // The L's outside corner at (40, 10) is 90°, but its top-to-slope corner is not: chamfer a 135° edge made by a first chamfer.
      const bevelled = meshChamfer(block, { sizeMm: 6, onlyEdges: top, strict: true });
      assert(bevelled.ok, "a first 6 mm bevel");
      if (!bevelled.ok) return;
      const top2 = pickableEdges(bevelled, 5);
      assert(typeof top2 !== "string", "the bevelled block has edges");
      if (typeof top2 === "string") return;
      const obtuse = nearestPickableEdge(top2, [30, 6, 20]);
      assert(obtuse !== undefined && obtuse.distanceMm < 1e-6, "the bevel's top edge, a 135° corner, is pickable");
      if (obtuse === undefined) return;
      const total = obtuse.chain.reduce((sum, edge) => sum + Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], edge.b[2] - edge.a[2]), 0);
      near(total, 60, 1e-6, "its pieces make up the whole 60 mm edge");
      const again = meshChamfer(bevelled, { sizeMm: 2, angleDeg: 20, onlyEdges: obtuse.chain.map(segmentOf), strict: true });
      assert(again.ok, again.ok ? "" : again.message);
      if (again.ok) {
        assertSolid(again, "angled chamfer on a 135° corner");
        // Triangle with a 45° bevel between the legs: legs d1 along the top and d2 along the bevel, interior angle 135°, base angle 20° at the top face.
        const d2 = 2 * Math.sin(20 * Math.PI / 180) / Math.sin((135 + 20) * Math.PI / 180);
        near(volumeOf(bevelled) - volumeOf(again), 0.5 * 2 * d2 * Math.sin(135 * Math.PI / 180) * 60, 0.6, "removed area is d1·d2·sin(135°)/2");
      }
      assert(!meshChamfer(block, { sizeMm: 3, angleDeg: 100, onlyEdges: top }).ok, "an angle that cannot close on a right-angle corner is refused");
    }
  },
  {
    name: "A variable-radius fillet changes its radius evenly along the edge and removes k·L·(r0² + r0·r1 + r1²)/3",
    run: () => {
      const block = slab(60, 40, 20);
      const full = volumeOf(block);
      // The 40 mm edge along y at x = 0, z = 20, picked from y = 0 to y = 40.
      const run = [[[0, 0, 20], [0, 40, 20]] as const];
      const variable = meshFillet(block, { sizeMm: 1, endSizeMm: 4, segments: 24, onlyEdges: run, strict: true });
      assert(variable.ok, variable.ok ? "" : variable.message);
      if (!variable.ok) return;
      assertSolid(variable, "variable fillet");
      const expected = CORNER * 40 * (1 + 4 + 16) / 3;
      near(full - volumeOf(variable), expected, expected * 0.02, "removed volume follows the average of r²");
      // The fillet leaves the top face at x = r: 1 mm at y = 0 and 4 mm at y = 40.
      const topReach = (y: number): number => {
        let reach = Infinity;
        for (let i = 0; i < variable.positionsMm.length; i += 3) if (Math.abs(variable.positionsMm[i + 1]! - y) < 1e-6 && Math.abs(variable.positionsMm[i + 2]! - 20) < 1e-6) reach = Math.min(reach, variable.positionsMm[i]!);
        return reach;
      };
      near(topReach(0), 1, 1e-3, "radius 1 mm at the start of the edge");
      near(topReach(40), 4, 1e-3, "radius 4 mm at the end of the edge");
      // Reversing the run swaps the ends.
      const reverse = meshFillet(block, { sizeMm: 1, endSizeMm: 4, segments: 24, onlyEdges: [[[0, 40, 20], [0, 0, 20]]], strict: true });
      assert(reverse.ok, reverse.ok ? "" : reverse.message);
      if (reverse.ok) {
        let atZero = Infinity;
        for (let i = 0; i < reverse.positionsMm.length; i += 3) if (Math.abs(reverse.positionsMm[i + 1]!) < 1e-6 && Math.abs(reverse.positionsMm[i + 2]! - 20) < 1e-6) atZero = Math.min(atZero, reverse.positionsMm[i]!);
        near(atZero, 4, 1e-3, "starting from the other end puts the 1 mm radius there");
      }
      assert(!meshFillet(block, { sizeMm: 1, endSizeMm: 4 }).ok, "a variable radius with no picked run is refused");
      assert(!meshFillet(block, { sizeMm: 1, endSizeMm: -2, onlyEdges: run }).ok, "a negative end radius is refused");
    }
  },
  {
    name: "A variable radius is spread along a run of several edges by length, so the radius is continuous where they meet",
    run: () => {
      // Two edges in a row: the top-front edge of a block split in two by a notch-free chamfered corner is the simplest run, so use a rounded L.
      const l = bracket();
      // The foot's top edge along the 40 mm side and the upright's top edge are different faces; run along the vertical edges instead:
      // the run (40,0)-(40,10) is a top edge of the foot's end, 10 mm long; the next (40,10)-(10,10) is 30 mm. Both are on top (z = 20).
      const run = [[[40, 0, 20], [40, 10, 20]] as const, [[40, 10, 20], [10, 10, 20]] as const];
      const result = meshFillet(l, { sizeMm: 1, endSizeMm: 2, segments: 24, onlyEdges: run, strict: true });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      assertSolid(result, "variable fillet over two edges");
      // Radius is 1 + s/40 along the 40 mm run: 1 → 1.25 over the first 10 mm, then 1.25 → 2 over the next 30.
      const first = 10 * (1 + 1.25 + 1.5625) / 3;
      const second = 30 * (1.5625 + 2.5 + 4) / 3;
      near(volumeOf(l) - volumeOf(result), CORNER * (first + second), CORNER * (first + second) * 0.06, "removed volume is the sum over both edges, each at its own radii");
      let reach = Infinity;
      for (let i = 0; i < result.positionsMm.length; i += 3) if (Math.abs(result.positionsMm[i + 1]!) < 1e-6 && Math.abs(result.positionsMm[i + 2]! - 20) < 1e-6) reach = Math.min(reach, 40 - result.positionsMm[i]!);
      near(reach, 1, 0.01, "the run starts at radius 1: the top face ends 1 mm short of the end face");
    }
  },
  {
    name: "A chamfer on an inside corner adds the wedge d1·d2/2 times the edge length and sticks out nowhere",
    run: () => {
      const l = bracket();
      const inside = pick(l, [10, 10, 10], true);
      const filled = meshChamfer(l, { sizeMm: 4, concave: true, onlyEdges: inside, strict: true });
      assert(filled.ok, filled.ok ? "" : filled.message);
      if (!filled.ok) return;
      assertSolid(filled, "inside chamfer");
      near(volumeOf(filled) - volumeOf(l), 8 * 20, 0.5, "a 4 mm inside chamfer adds 8 mm² along the 20 mm edge");
      const unequal = meshChamfer(l, { sizeMm: 6, secondSizeMm: 2, concave: true, onlyEdges: inside, strict: true });
      assert(unequal.ok, unequal.ok ? "" : unequal.message);
      if (unequal.ok) { assertSolid(unequal, "inside two-distance chamfer"); near(volumeOf(unequal) - volumeOf(l), 6 * 20, 0.5, "6 × 2 adds 6 mm² along 20 mm"); }
      const before = boundsOf(l);
      const after = boundsOf(filled);
      for (let axis = 0; axis < 3; axis += 1) { near(after.min[axis]!, before.min[axis]!, 1e-6, "nothing sticks out"); near(after.max[axis]!, before.max[axis]!, 1e-6, "nothing sticks out"); }
      // A convex-only treatment does not see the inside corner, and an inside-only one does not see the outside ones.
      const convexAtInside = meshChamfer(l, { sizeMm: 2, onlyEdges: inside });
      assert(!convexAtInside.ok, "the inside corner is not a convex edge");
      const concaveAtOutside = meshFillet(l, { sizeMm: 2, concave: true, onlyEdges: pick(l, [40, 0, 10]) });
      assert(!concaveAtOutside.ok, "an outside corner is not an inside one");
    }
  },
  {
    name: "Inside corners are offered for picking only when asked for, and chain only with inside corners",
    run: () => {
      const l = bracket();
      const outside = edgesOf(l);
      assert(outside.length === 17 && outside.every((edge) => edge.concave !== true), `the bracket has 17 outside edges: ${outside.length}`);
      const both = edgesOf(l, true);
      const inside = both.filter((edge) => edge.concave === true);
      assert(both.length === 18 && inside.length === 1, `and one inside corner: ${both.length} edges, ${inside.length} inside`);
      const chain = nearestPickableEdge(both, [10, 10, 10])!;
      assert(chain.chain.length === 1 && chain.edge.concave === true, "a click at the inside corner picks it");
      assert(inside[0]!.triangles !== undefined, "an edge knows the two triangles beside it");
    }
  },
  {
    name: "Treatments keep a body's face indices, give their own surface one new index, and refuse a size the faces cannot hold when strict",
    run: () => {
      const block = slab();
      // Faces by direction: 0 bottom, 1 top, 2.. sides, as the box's own triangles say.
      const faceTriangles: number[] = [];
      for (let t = 0; t < block.indices.length / 3; t += 1) {
        const a = block.indices[t * 3]! * 3; const b = block.indices[t * 3 + 1]! * 3; const c = block.indices[t * 3 + 2]! * 3;
        const p = block.positionsMm;
        const nx = (p[b + 1]! - p[a + 1]!) * (p[c + 2]! - p[a + 2]!) - (p[b + 2]! - p[a + 2]!) * (p[c + 1]! - p[a + 1]!);
        const ny = (p[b + 2]! - p[a + 2]!) * (p[c]! - p[a]!) - (p[b]! - p[a]!) * (p[c + 2]! - p[a + 2]!);
        const nz = (p[b]! - p[a]!) * (p[c + 1]! - p[a + 1]!) - (p[b + 1]! - p[a + 1]!) * (p[c]! - p[a]!);
        faceTriangles.push(nz > 0.5 ? 1 : nz < -0.5 ? 0 : ny < -0.5 ? 2 : ny > 0.5 ? 3 : nx > 0.5 ? 4 : 5);
      }
      const top = pick(block, [30, 0.2, 19.8]);
      const result = meshFillet({ ...block, faceTriangles }, { sizeMm: 3, onlyEdges: top, strict: true });
      assert(result.ok && result.faceTriangles !== undefined && result.newFaceIndex === 6, "the fillet surface is face 6");
      if (!result.ok || result.faceTriangles === undefined) return;
      assert(result.faceTriangles.length === result.indices.length / 3, "one face index per triangle");
      const used = new Set(result.faceTriangles);
      assert([0, 1, 2, 3, 4, 5, 6].every((face) => used.has(face)), "every old face is still there, plus the fillet");
      // The new face lies between the top and the front: all its triangles are within 3 mm of the edge.
      for (let t = 0; t < result.faceTriangles.length; t += 1) {
        if (result.faceTriangles[t] !== 6) continue;
        for (let corner = 0; corner < 3; corner += 1) {
          const i = result.indices[t * 3 + corner]! * 3;
          assert(result.positionsMm[i + 1]! <= 3 + 1e-6 && result.positionsMm[i + 2]! >= 17 - 1e-6, "the fillet's triangles sit in the corner");
        }
      }
      // The flat faces keep their own index: every triangle lying in the top plane (z = 20) is still face 1, and none of the fillet's is.
      for (let t = 0; t < result.faceTriangles.length; t += 1) {
        const zs = [0, 1, 2].map((corner) => result.positionsMm[result.indices[t * 3 + corner]! * 3 + 2]!);
        if (zs.every((z) => Math.abs(z - 20) < 1e-9)) assert(result.faceTriangles[t] === 1, `triangle ${t} in the top plane keeps the top face index (got ${result.faceTriangles[t]})`);
      }
      const forced = meshFillet({ ...block, faceTriangles }, { sizeMm: 3, onlyEdges: top, strict: true, newFaceIndex: 9 });
      assert(forced.ok && forced.newFaceIndex === 9 && forced.faceTriangles?.includes(9) === true, "a caller can choose the surface's face index");
      const tooBig = meshFillet(block, { sizeMm: 45, onlyEdges: top, strict: true });
      assert(!tooBig.ok, "a radius bigger than the 40 mm block is refused");
    }
  }
];

/** A round boss of radius 8 and height 12 standing on a 40 × 40 × 6 plate: its top rim is an outside corner and its foot an inside one. */
function bossOnPlate(): ModifyMeshInput {
  const plate = tessellateExtrude([[-20, -20], [20, -20], [20, 20], [-20, 20]], 6, "xy");
  const ring: [number, number][] = [];
  for (let i = 0; i < 32; i += 1) ring.push([8 * Math.cos(2 * Math.PI * i / 32), 8 * Math.sin(2 * Math.PI * i / 32)]);
  const boss = tessellateExtrude(ring, 12, "xy");
  const joined = booleanMeshes({ positionsMm: plate.positionsMm, indices: plate.indices }, { positionsMm: boss.positionsMm.map((v, i) => i % 3 === 2 ? v + 3 : v), indices: boss.indices }, "join");
  assert(joined.ok, "the boss joins the plate");
  if (!joined.ok) throw new Error("unreachable");
  return { positionsMm: Array.from(joined.value.positionsMm), indices: Array.from(joined.value.indices) };
}

export const edgeBlendRimTests: readonly TestCase[] = [
  {
    name: "The round rim of a boss can be filleted on its top (removing material) and at its foot (adding it), each as one picked run",
    run: () => {
      const part = bossOnPlate();
      const base = volumeOf(part);
      const edges = edgesOf(part, true);
      const foot = nearestPickableEdge(edges, [8, 0, 6]);
      const rim = nearestPickableEdge(edges, [8, 0, 15]);
      assert(foot !== undefined && foot.edge.concave === true && foot.chain.length >= 32 && foot.chain.every((edge) => edge.concave === true), `the foot is one run of inside segments: ${foot?.chain.length}`);
      assert(rim !== undefined && rim.edge.concave !== true && rim.chain.length >= 32 && rim.chain.every((edge) => edge.concave !== true), `the top rim is one run of outside segments: ${rim?.chain.length}`);
      if (foot === undefined || rim === undefined) return;
      // Cross-section area is r²(1 − π/4) swept round a circle of the radius the section's centroid sits at; use Pappus on the corner shape.
      const outside = meshFillet(part, { sizeMm: 1.5, segments: 16, onlyEdges: rim.chain.map(segmentOf), strict: true });
      assert(outside.ok, outside.ok ? "" : outside.message);
      if (!outside.ok) return;
      assertSolid(outside, "rounded boss rim");
      const takenOut = base - volumeOf(outside);
      // The corner's centroid lies 0.2234 r from the corner's two sides' meeting point toward the boss axis side... bound it by the rim radius instead.
      const area = 1.5 * 1.5 * CORNER;
      assert(takenOut > area * 2 * Math.PI * 6.5 * 0.9 && takenOut < area * 2 * Math.PI * 8 * 1.05, `about the section area swept round the rim: ${takenOut.toFixed(2)} mm³`);
      const filled = meshFillet(part, { sizeMm: 2, segments: 16, concave: true, onlyEdges: foot.chain.map(segmentOf), strict: true });
      assert(filled.ok, filled.ok ? "" : filled.message);
      if (!filled.ok) return;
      assertSolid(filled, "filleted boss foot");
      const added = volumeOf(filled) - base;
      const section = 4 * CORNER;
      assert(added > section * 2 * Math.PI * 8 * 1.0 && added < section * 2 * Math.PI * 10.5, `about the section area swept round the foot: ${added.toFixed(2)} mm³`);
      const chamfered = meshChamfer(part, { sizeMm: 2, concave: true, onlyEdges: foot.chain.map(segmentOf), strict: true });
      assert(chamfered.ok, chamfered.ok ? "" : chamfered.message);
      if (chamfered.ok) { assertSolid(chamfered, "chamfered boss foot"); near(volumeOf(chamfered) - base, 2 * 2 / 2 * 2 * Math.PI * (8 + 2 / 3), 6, "a 2 mm inside chamfer round the foot adds the wedge swept round it"); }
    }
  }
];
