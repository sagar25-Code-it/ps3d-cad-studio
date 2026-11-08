import { boundaryLoops, boundaryPatch, extendSurface, loftSurface, orderEdges, resampleCurve, ruledSurface, stitchSurfaces, surfaceArea, trimSurfaceByLoop, trimSurfaceByPlane, type Curve3, type SurfaceMesh } from "../packages/workbench-geometry/src/surface-build.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

type Vec3 = readonly [number, number, number];
const line = (a: Vec3, b: Vec3): Curve3 => [a, b];
const circle = (radius: number, z: number, segments: number, centre: readonly [number, number] = [0, 0]): Vec3[] =>
  Array.from({ length: segments + 1 }, (_, i) => [centre[0] + radius * Math.cos((i / segments) * Math.PI * 2), centre[1] + radius * Math.sin((i / segments) * Math.PI * 2), z] as const);
const squareEdges = (half: number, height: (x: number, y: number) => number = () => 0): Curve3[] => {
  const polyline = (from: readonly [number, number], to: readonly [number, number]): Curve3 => Array.from({ length: 41 }, (_, i) => {
    const x = from[0] + (to[0] - from[0]) * (i / 40);
    const y = from[1] + (to[1] - from[1]) * (i / 40);
    return [x, y, height(x, y)] as const;
  });
  return [polyline([-half, -half], [half, -half]), polyline([half, -half], [half, half]), polyline([half, half], [-half, half]), polyline([-half, half], [-half, -half])];
};
/** Signed volume of a closed mesh. */
function volume(mesh: SurfaceMesh): number {
  let total = 0;
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i]! * 3, mesh.indices[i + 1]! * 3, mesh.indices[i + 2]! * 3];
    const p = mesh.positionsMm;
    total += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
  }
  return total;
}
const bounds = (mesh: SurfaceMesh): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positionsMm.length; i += 1) { const axis = i % 3; min[axis] = Math.min(min[axis]!, mesh.positionsMm[i]!); max[axis] = Math.max(max[axis]!, mesh.positionsMm[i]!); }
  return { min, max };
};
const ok = (result: { readonly ok: boolean; readonly message?: string }, label: string): void => { assert(result.ok, `${label}: ${result.ok ? "" : result.message ?? ""}`); };
const meshOf = (result: { readonly ok: boolean; readonly mesh?: SurfaceMesh }): SurfaceMesh => result.mesh!;

export const surfaceBuildTests: readonly TestCase[] = [
  {
    name: "resampleCurve spaces points evenly by arc length and keeps both ends; ruled surfaces have the area of the strip between their curves",
    run: () => {
      const bent: Curve3 = [[0, 0, 0], [10, 0, 0], [10, 10, 0]];
      const points = resampleCurve(bent, 5);
      near(points[1]![0], 5, 1e-9, "a quarter of the 20 mm length is 5 mm along");
      near(points[2]![0], 10, 1e-9, "half way is the corner");
      assert(points[4]![0] === 10 && points[4]![1] === 10, "the end is kept exactly");
      const strip = ruledSurface(line([0, 0, 0], [20, 0, 0]), line([0, 8, 0], [20, 8, 0]));
      ok(strip, "ruled strip");
      near(surfaceArea(meshOf(strip)), 160, 1e-6, "a 20 x 8 strip");
      const side = ruledSurface(circle(10, 0, 72), circle(10, 25, 72), { samples: 73, rows: 5 });
      ok(side, "ruled cylinder wall");
      const expected = 72 * 2 * 10 * Math.sin(Math.PI / 72) * 25;
      near(surfaceArea(meshOf(side)), expected, expected * 1e-6, "the wall of a 72-sided prism, 25 mm tall");
      assert(!ruledSurface([[0, 0, 0]], line([0, 1, 0], [1, 1, 0])).ok, "one point is not a curve");
      assert(!ruledSurface(line([0, 0, 0], [0, 0, 0]), line([0, 1, 0], [1, 1, 0])).ok, "a curve with no length is refused");
      assert(!ruledSurface(line([0, 0, 0], [1, 0, 0]), line([0, 1, 0], [1, 1, 0]), { samples: 1 }).ok, "too few samples refused");
    }
  },
  {
    name: "a loft surface through three curves passes through the middle one, and a two-curve loft with an end direction leaves the first curve along it",
    run: () => {
      const a = line([0, 0, 0], [20, 0, 0]);
      const b = line([0, 10, 6], [20, 10, 6]);
      const c = line([0, 20, 0], [20, 20, 0]);
      const through = loftSurface([a, b, c], { samples: 5, rows: 4 });
      ok(through, "three-curve loft");
      const mesh = meshOf(through);
      // Rows: 0..4 for the first span, 5..8 for the second; the middle section is row 4.
      const row = (r: number): Vec3 => [mesh.positionsMm[(r * 5 + 2) * 3]!, mesh.positionsMm[(r * 5 + 2) * 3 + 1]!, mesh.positionsMm[(r * 5 + 2) * 3 + 2]!];
      near(row(4)[1], 10, 1e-9, "the middle row sits on the middle curve (y)");
      near(row(4)[2], 6, 1e-9, "the middle row sits on the middle curve (z)");
      assert(row(2)[2] > 2 && row(2)[2] < 6.5, "between the sections the loft is smooth, not stepped");
      // Two curves, leaving the first one straight up with a long tangent.
      const flat = loftSurface([line([0, 0, 0], [10, 0, 0]), line([0, 10, 0], [10, 10, 0])], { samples: 3, rows: 10, startTangent: [0, 0, 20], endTangent: [0, 0, 0] });
      ok(flat, "tangent loft");
      const m = meshOf(flat);
      const z = (r: number): number => m.positionsMm[(r * 3 + 1) * 3 + 2]!;
      assert(z(1) > 0.5 && z(0) === 0, "the surface lifts away from the first curve in the given direction");
      assert(z(5) > z(10) && z(10) === 0, "and comes back down to the last curve");
      const plain = loftSurface([line([0, 0, 0], [10, 0, 0]), line([0, 10, 0], [10, 10, 0])], { samples: 3, rows: 10 });
      ok(plain, "plain loft");
      near(surfaceArea(meshOf(plain)), 100, 1e-6, "with no direction it is the ruled surface");
      assert(!loftSurface([a]).ok, "one curve is not a loft");
    }
  },
  {
    name: "edges are ordered and reversed to close a loop, and a gap or an open loop is reported",
    run: () => {
      const edges = squareEdges(5);
      const scrambled = [edges[2]!, [...edges[0]!].reverse(), edges[3]!, edges[1]!];
      const ordered = orderEdges(scrambled);
      assert(typeof ordered !== "string", "scrambled square joins up");
      if (typeof ordered !== "string") equal(ordered.length, 4, "four edges");
      assert(typeof orderEdges([edges[0]!, edges[1]!, edges[2]!]) === "string", "three sides of a square do not close");
      assert(typeof orderEdges([edges[0]!, edges[2]!]) === "string", "disjoint edges do not join");
      assert(typeof orderEdges([]) === "string", "no edges");
    }
  },
  {
    name: "a boundary patch fills a flat loop exactly, reproduces a saddle and a harmonic quadric from the boundary alone, and handles a concave loop",
    run: () => {
      const flat = boundaryPatch(squareEdges(10));
      ok(flat, "flat square");
      const flatMesh = meshOf(flat);
      near(surfaceArea(flatMesh), 400, 1e-6, "the patch covers the 20 x 20 square");
      assert(flatMesh.positionsMm.filter((_, i) => i % 3 === 2).every((value) => Math.abs(value) < 1e-9), "and lies in the plane");
      equal(boundaryLoops(flatMesh).length, 1, "one open boundary");
      assert(boundaryLoops(flatMesh)[0]!.length >= 4 * 15, "the boundary keeps every edge sample");
      const up = (() => { let n = 0; for (let i = 0; i + 2 < flatMesh.indices.length; i += 3) { const [a, b, c] = [flatMesh.indices[i]! * 3, flatMesh.indices[i + 1]! * 3, flatMesh.indices[i + 2]! * 3]; const p = flatMesh.positionsMm; n += (p[b]! - p[a]!) * (p[c + 1]! - p[a + 1]!) - (p[b + 1]! - p[a + 1]!) * (p[c]! - p[a]!); } return n; })();
      assert(up > 0, "the patch faces the side the loop winds anticlockwise towards");

      const saddle = boundaryPatch(squareEdges(10, (x, y) => (x * y) / 10), { samplesPerEdge: 21 });
      ok(saddle, "saddle");
      let worst = 0;
      const sm = meshOf(saddle);
      for (let i = 0; i < sm.positionsMm.length; i += 3) worst = Math.max(worst, Math.abs(sm.positionsMm[i + 2]! - (sm.positionsMm[i]! * sm.positionsMm[i + 1]!) / 10));
      assert(worst < 0.05, `the interior follows z = x y / 10 to ${worst.toFixed(4)} mm`);
      assert(surfaceArea(sm) > 400, "the saddle has more area than its flat footprint");

      const rim = circle(10, 0, 96).map((p): Vec3 => [p[0], p[1], (p[0] * p[0] - p[1] * p[1]) / 20]);
      const dish = boundaryPatch([rim], { samplesPerEdge: 97 });
      ok(dish, "harmonic quadric on a circle");
      let worstDish = 0;
      const dm = meshOf(dish);
      for (let i = 0; i < dm.positionsMm.length; i += 3) worstDish = Math.max(worstDish, Math.abs(dm.positionsMm[i + 2]! - (dm.positionsMm[i]! ** 2 - dm.positionsMm[i + 1]! ** 2) / 20));
      assert(worstDish < 0.03, `the interior follows (x^2 - y^2)/20 to ${worstDish.toFixed(4)} mm`);

      const ell: Curve3[] = [line([0, 0, 0], [30, 0, 0]), line([30, 0, 0], [30, 10, 0]), line([30, 10, 0], [10, 10, 0]), line([10, 10, 0], [10, 30, 0]), line([10, 30, 0], [0, 30, 0]), line([0, 30, 0], [0, 0, 0])];
      const concave = boundaryPatch(ell, { samplesPerEdge: 12 });
      ok(concave, "L-shaped loop");
      near(surfaceArea(meshOf(concave)), 30 * 10 + 10 * 20, 1e-6, "the L covers its 500 mm2 exactly");
      assert(!boundaryPatch([line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [10, 10, 0])]).ok, "an open loop is refused");
      assert(!boundaryPatch([line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [0, 0, 0])]).ok, "a loop that encloses no area is refused");
      const bow: Curve3[] = [line([0, 0, 0], [10, 10, 0]), line([10, 10, 0], [10, 0, 0]), line([10, 0, 0], [0, 10, 0]), line([0, 10, 0], [0, 0, 0])];
      assert(!boundaryPatch(bow).ok, "a loop that crosses itself is refused");
    }
  },
  {
    name: "extending a surface continues it tangentially past a chosen open edge: flat stays flat, a curved surface follows its tangent, only the chosen part of the edge grows",
    run: () => {
      const plate = meshOf(ruledSurface(line([0, 0, 0], [10, 0, 0]), line([0, 10, 0], [10, 10, 0]), { samples: 11, rows: 10 }));
      const whole = extendSurface(plate, { distanceMm: 4 });
      ok(whole, "extend the whole edge");
      const grown = meshOf(whole);
      assert(grown.positionsMm.filter((_, i) => i % 3 === 2).every((value) => Math.abs(value) < 1e-9), "extending a flat plate keeps it flat");
      const wb = bounds(grown);
      assert(wb.max[1]! > 13.9 && wb.min[1]! < -3.9, "the plate grew 4 mm on both long sides");
      assert(surfaceArea(grown) > 100 + 4 * 10 * 2, "area increased by at least the two side strips");

      const partial = extendSurface(plate, { distanceMm: 4, nearPointMm: [10, 5, 0], windowMm: 2.4 });
      ok(partial, "extend part of one edge");
      const pb = bounds(meshOf(partial));
      near(pb.max[0]!, 14, 1e-6, "the chosen edge moved out 4 mm");
      near(pb.min[0]!, 0, 1e-9, "the other edges did not move");
      near(pb.max[1]!, 10, 1e-9, "nor did the long sides");
      near(surfaceArea(meshOf(partial)), 100 + 4 * 4, 1e-6, "and only the windowed run of the edge (y from 3 to 7) added area");

      // A curved surface: a quarter of a cylinder, extended past its straight edge, leaves along the surface's tangent.
      const arcA: Curve3 = Array.from({ length: 19 }, (_, i) => [10 * Math.cos((i / 18) * Math.PI / 2), 10 * Math.sin((i / 18) * Math.PI / 2), 0] as const);
      const arcB: Curve3 = arcA.map((p) => [p[0], p[1], 20] as const);
      const wall = meshOf(ruledSurface(arcA, arcB, { samples: 19, rows: 4 }));
      const loops = boundaryLoops(wall);
      equal(loops.length, 1, "the wall has one open boundary");
      const extendedWall = extendSurface(wall, { distanceMm: 6, nearPointMm: [10, 0, 10], windowMm: 8, rings: 3 });
      ok(extendedWall, "extend the straight edge");
      const ew = meshOf(extendedWall);
      const added = ew.positionsMm.length / 3 - wall.positionsMm.length / 3;
      assert(added > 0, "new vertices were added");
      // The added vertices at the first arc point lie on the tangent: straight out the +y direction (the wall leaves (10,0) along y).
      let tangentOk = false;
      for (let i = wall.positionsMm.length; i < ew.positionsMm.length; i += 3) if (Math.abs(ew.positionsMm[i]! - 10) < 0.2 && ew.positionsMm[i + 1]! < -1 && Math.abs(ew.positionsMm[i + 2]! - 10) < 4) tangentOk = true;
      assert(tangentOk, "the extension leaves the cylinder along its tangent, not along the circle");
      assert(!extendSurface(wall, { distanceMm: 0 }).ok, "a zero distance is refused");
      assert(!extendSurface(wall, { distanceMm: 5, loopIndex: 3 }).ok, "an edge that does not exist is refused");
    }
  },
  {
    name: "trimming by a plane cuts exactly along it; trimming by a closed curve keeps the inside or the outside, and the two parts add up to the whole",
    run: () => {
      const plate = meshOf(ruledSurface(line([0, 0, 0], [10, 0, 0]), line([0, 10, 0], [10, 10, 0]), { samples: 11, rows: 10 }));
      const kept = trimSurfaceByPlane(plate, [3, 0, 0], [1, 0, 0], "positive");
      ok(kept, "plane trim");
      near(surfaceArea(meshOf(kept)), 70, 1e-6, "7 x 10 is left of x >= 3");
      near(bounds(meshOf(kept)).min[0]!, 3, 1e-9, "the new edge is on the plane");
      const dropped = trimSurfaceByPlane(plate, [3, 0, 0], [1, 0, 0], "negative");
      ok(dropped, "other side");
      near(surfaceArea(meshOf(kept)) + surfaceArea(meshOf(dropped)), 100, 1e-6, "both sides add up");
      assert(!trimSurfaceByPlane(plate, [20, 0, 0], [1, 0, 0], "negative").ok, "a plane that does not touch the surface cuts nothing");
      assert(!trimSurfaceByPlane(plate, [20, 0, 0], [1, 0, 0], "positive").ok, "and keeping the far side leaves nothing");
      assert(!trimSurfaceByPlane(plate, [3, 0, 0], [0, 0, 0], "positive").ok, "a plane needs a direction");

      const ring = circle(3, 0, 48, [5, 5]);
      const inside = trimSurfaceByLoop(plate, ring, [0, 0, 1], "inside");
      ok(inside, "inside the curve");
      const polygonArea = 0.5 * 48 * 9 * Math.sin((Math.PI * 2) / 48);
      near(surfaceArea(meshOf(inside)), polygonArea, 1e-3, "the kept disc has the curve's area");
      const outside = trimSurfaceByLoop(plate, ring, [0, 0, 1], "outside");
      ok(outside, "outside the curve");
      near(surfaceArea(meshOf(outside)), 100 - polygonArea, 1e-3, "the rest of the plate is what is left");
      equal(boundaryLoops(meshOf(outside)).length, 2, "a plate with a hole has an outer and an inner edge");
      equal(boundaryLoops(meshOf(inside)).length, 1, "the disc has one edge");
      // Projecting along a slant gives the shadow of the curve.
      const slanted = trimSurfaceByLoop(plate, circle(3, 4, 48, [5, 5]), [0, 0, 1], "inside");
      ok(slanted, "a curve above the plate, projected straight down");
      near(surfaceArea(meshOf(slanted)), polygonArea, 1e-3, "keeps its shadow");
      assert(!trimSurfaceByLoop(plate, circle(2, 0, 24, [50, 50]), [0, 0, 1], "inside").ok, "a curve off the surface keeps nothing");
      assert(!trimSurfaceByLoop(plate, ring, [0, 0, 0], "inside").ok, "the projection needs a direction");
    }
  },
  {
    name: "stitching six patches makes a closed solid of the right volume, whatever winding or sampling the faces have; an open set is reported, not made",
    run: () => {
      const h = 5;
      const corner = (x: number, y: number, z: number): Vec3 => [x, y, z];
      const edge = (a: Vec3, b: Vec3): Curve3 => [a, b];
      const c = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]].map(([x, y, z]) => corner(x!, y!, z!));
      const faces: readonly (readonly [number, number, number, number])[] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
      const patches = faces.map(([a, b, cc, d]) => {
        const result = boundaryPatch([edge(c[a]!, c[b]!), edge(c[b]!, c[cc]!), edge(c[cc]!, c[d]!), edge(c[d]!, c[a]!)], { samplesPerEdge: 7, targetEdgeMm: 2.5 });
        ok(result, `face ${a}${b}${cc}${d}`);
        return meshOf(result);
      });
      const solid = stitchSurfaces(patches);
      assert(solid.ok, `cube: ${solid.ok ? "" : solid.message}`);
      if (solid.ok) {
        near(solid.volumeMm3, 1000, 1e-6, "a 10 mm cube is 1000 mm3");
        near(volume(solid.mesh), 1000, 1e-6, "and its mesh points outward");
        equal(boundaryLoops(solid.mesh).length, 0, "no open edge is left");
      }
      // Reverse the winding of two faces: stitching sorts it out.
      const flipped = patches.map((patch, i) => i % 3 === 0 ? { positionsMm: patch.positionsMm, indices: patch.indices.map((_, k, all) => all[k - (k % 3) + [0, 2, 1][k % 3]!]!) } : patch);
      const resorted = stitchSurfaces(flipped);
      assert(resorted.ok, `flipped faces: ${resorted.ok ? "" : resorted.message}`);
      if (resorted.ok) near(volume(resorted.mesh), 1000, 1e-6, "inconsistently wound faces are turned the same way");
      // Different sampling on neighbouring faces: the T-junctions are sewn.
      const mixed = faces.map(([a, b, cc, d], i) => meshOf(boundaryPatch([edge(c[a]!, c[b]!), edge(c[b]!, c[cc]!), edge(c[cc]!, c[d]!), edge(c[d]!, c[a]!)], { samplesPerEdge: i % 2 === 0 ? 5 : 8, targetEdgeMm: 3 })));
      const sewn = stitchSurfaces(mixed);
      assert(sewn.ok, `different sampling: ${sewn.ok ? "" : sewn.message}`);
      if (sewn.ok) near(sewn.volumeMm3, 1000, 1e-6, "faces sampled 5 and 8 times still close up");
      const open = stitchSurfaces(patches.slice(0, 5));
      assert(!open.ok && open.openEdges > 0, "five faces leave an open box, which is reported");
      assert(!open.ok && open.message.includes("do not close up"), "with a message that says why");
      assert(!stitchSurfaces([]).ok, "nothing to stitch");
      // A prism built from a ruled wall and two patches.
      const bottom = circle(8, 0, 36);
      const top = circle(8, 12, 36);
      const wall = meshOf(ruledSurface(bottom, top, { samples: 37, rows: 6 }));
      const capA = meshOf(boundaryPatch([bottom], { samplesPerEdge: 37, targetEdgeMm: 3 }));
      const capB = meshOf(boundaryPatch([top], { samplesPerEdge: 37, targetEdgeMm: 3 }));
      const prism = stitchSurfaces([wall, capA, capB]);
      assert(prism.ok, `prism: ${prism.ok ? "" : prism.message}`);
      if (prism.ok) near(prism.volumeMm3, 0.5 * 36 * 64 * Math.sin((Math.PI * 2) / 36) * 12, 0.5, "a 36-sided prism of radius 8 and height 12");
    }
  }
];
