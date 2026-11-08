import { meshChamfer, meshFillet, meshHole, meshShell, nearestPickableEdge, pickableEdges, type ModifyMeshInput } from "../packages/workbench-geometry/src/index.js";
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


/** A closed prism with `sides` flat facets around a circle of `radiusMm`, standing on z = 0, with outward triangles. */
function prism(sides: number, radiusMm: number, heightMm: number): ModifyMeshInput {
  const positionsMm: number[] = [];
  for (const z of [0, heightMm]) for (let i = 0; i < sides; i += 1) positionsMm.push(radiusMm * Math.cos(2 * Math.PI * i / sides), radiusMm * Math.sin(2 * Math.PI * i / sides), z);
  positionsMm.push(0, 0, 0, 0, 0, heightMm);
  const bottomCentre = 2 * sides;
  const topCentre = 2 * sides + 1;
  const indices: number[] = [];
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    indices.push(i, j, sides + j, i, sides + j, sides + i, topCentre, sides + i, sides + j, bottomCentre, j, i);
  }
  return { positionsMm, indices };
}

const midpoint = (a: readonly number[], b: readonly number[]): readonly [number, number, number] => [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2];

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
  },
  {
    name: "Every sharp edge of a block can be picked on its own, and the closest one to a click is found",
    run: () => {
      const body = box([0, 0, 0], [20, 30, 10]);
      const edges = pickableEdges(body);
      assert(typeof edges !== "string", "the block has pickable edges");
      if (typeof edges === "string") return;
      assert(edges.length === 12 && new Set(edges.map((edge) => edge.chain)).size === 12, `a block has 12 edges that are each their own run: ${edges.length} edges, ${new Set(edges.map((edge) => edge.chain)).size} runs`);
      for (const edge of edges) {
        const found = nearestPickableEdge(edges, midpoint(edge.a, edge.b));
        assert(found !== undefined && found.distanceMm < 1e-6 && found.chain.length === 1, "a click on an edge picks that edge alone");
      }
      const near = nearestPickableEdge(edges, [10.2, 0.4, 0.3]);
      assert(near !== undefined && near.chain.length === 1 && Math.abs(near.edge.a[1]) < 1e-9 && Math.abs(near.edge.b[1]) < 1e-9 && Math.abs(near.edge.a[2]) < 1e-9, "a click a little off the bottom front edge still picks it");
      assert(nearestPickableEdge([], [0, 0, 0]) === undefined, "no edges, no pick");
    }
  },
  {
    name: "A chamfer or fillet of one picked edge changes only that edge, by the volume of that edge",
    run: () => {
      const body = box([0, 0, 0], [20, 20, 20]);
      const edges = pickableEdges(body);
      if (typeof edges === "string") { assert(false, edges); return; }
      const top = nearestPickableEdge(edges, [10, 0.2, 19.8])!;
      const only = [[top.edge.a, top.edge.b] as const];
      const chamfered = meshChamfer(body, { sizeMm: 2, onlyEdges: only });
      assert(chamfered.ok, chamfered.ok ? "" : chamfered.message);
      if (!chamfered.ok) return;
      const removed = 8000 - volumeOf(chamfered);
      assert(removed > 36 && removed < 44, `one 2 mm chamfer on a 20 mm edge removes a 2 mm² triangle along it (40 mm³): ${removed.toFixed(2)}`);
      const rounded = meshFillet(body, { sizeMm: 2, segments: 12, onlyEdges: only });
      assert(rounded.ok, rounded.ok ? "" : rounded.message);
      if (!rounded.ok) return;
      const shaved = 8000 - volumeOf(rounded);
      assert(shaved > 15 && shaved < 19, `one R2 fillet on a 20 mm edge removes (1 - π/4)·4·20 = 17.2 mm³: ${shaved.toFixed(2)}`);
      const all = meshChamfer(body, { sizeMm: 2 });
      assert(all.ok && 8000 - volumeOf(all) > removed * 8, "treating every edge removes far more than treating one");
      const missing = meshChamfer(body, { sizeMm: 2, onlyEdges: [[[1, 1, 1], [2, 2, 2]]] });
      assert(!missing.ok && missing.message.includes("picked edge"), "a segment that is not an edge of the body is refused");
    }
  },
  {
    name: "The facets of a round rim are one picked edge, the facet seams are not pickable, and treating the rim leaves the rest of the body alone",
    run: () => {
      const body = prism(24, 10, 8);
      const edges = pickableEdges(body);
      if (typeof edges === "string") { assert(false, edges); return; }
      assert(edges.length === 48 && new Set(edges.map((edge) => edge.chain)).size === 2, `two rims of 24 segments and no seams: ${edges.length} edges in ${new Set(edges.map((edge) => edge.chain)).size} runs`);
      const rim = nearestPickableEdge(edges, [10, 0.3, 7.9])!;
      assert(rim.chain.length === 24 && rim.chain.every((edge) => Math.abs(edge.a[2] - 8) < 1e-9 && Math.abs(edge.b[2] - 8) < 1e-9), "a click on the top rim picks the whole top rim and nothing of the bottom one");
      const result = meshChamfer(body, { sizeMm: 1, onlyEdges: rim.chain.map((edge) => [edge.a, edge.b] as const) });
      assert(result.ok, result.ok ? "" : result.message);
      if (!result.ok) return;
      const before = volumeOf(body);
      const removed = before - volumeOf(result);
      assert(removed > 20 && removed < 45, `a 1 mm chamfer round a 10 mm radius rim removes about π·r·1 = 31 mm³: ${removed.toFixed(2)}`);
      const bottomKept = result.positionsMm.some((value, index) => index % 3 === 2 && Math.abs(value) < 1e-9);
      assert(bottomKept, "the bottom of the body is still there");
      const topZs = result.positionsMm.filter((_, index) => index % 3 === 2);
      assert(Math.max(...topZs) <= 8 + 1e-9, "nothing grew above the top");
    }
  }
];
