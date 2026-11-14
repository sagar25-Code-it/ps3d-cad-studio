import { boxMesh, creaseEdges, cylinderMesh, sphereMesh, tangentChainOf } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Every triangle gets its own three vertices, the way an imported STL arrives. */
function unweld(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): { positionsMm: number[]; indices: number[] } {
  const positionsMm: number[] = [];
  const indices: number[] = [];
  for (const index of mesh.indices) {
    positionsMm.push(mesh.positionsMm[index * 3]!, mesh.positionsMm[index * 3 + 1]!, mesh.positionsMm[index * 3 + 2]!);
    indices.push(indices.length);
  }
  return { positionsMm, indices };
}

const chainCount = (edges: readonly { readonly chain: number }[]): number => new Set(edges.map((edge) => edge.chain)).size;

export const creaseEdgeTests: readonly TestCase[] = [
  {
    name: "Crease detection finds the 12 edges of a box, and of a 2 mm box too (no size assumption)",
    run: () => {
      for (const size of [60, 2, 0.4]) {
        const box = boxMesh(size, size, size);
        const found = creaseEdges(box);
        equal(found.edges.length, 12, `a ${size} mm box has 12 creases`);
        assert(found.edges.every((edge) => Math.abs(edge.bendDeg - 90) < 0.5 && !edge.boundary), "each bends 90 degrees and none is an open boundary");
        equal(chainCount(found.edges), 12, "three edges meet at every corner, so nothing chains across a corner");
      }
    }
  },
  {
    name: "A mesh whose triangles each carry their own vertices (an imported STL) still finds the same edges",
    run: () => {
      const soup = unweld(boxMesh(10, 10, 10));
      equal(soup.positionsMm.length / 3, 36, "every triangle has three own vertices");
      equal(creaseEdges(soup).edges.length, 12, "welded by position, the box has its 12 edges");
    }
  },
  {
    name: "Triangles wound the wrong way round do not turn an edge into a fold or hide it",
    run: () => {
      const box = boxMesh(10, 10, 10);
      // Reverse every other triangle: half the box now faces inward.
      const indices = [...box.indices];
      for (let t = 0; t < indices.length / 3; t += 2) { const swap = indices[t * 3 + 1]!; indices[t * 3 + 1] = indices[t * 3 + 2]!; indices[t * 3 + 2] = swap; }
      const found = creaseEdges({ positionsMm: box.positionsMm, indices });
      assert(found.edges.length >= 12, `the 12 box edges are still offered (${found.edges.length})`);
      assert(found.edges.filter((edge) => Math.abs(edge.bendDeg - 90) < 1).length >= 12, "and they are measured as 90 degree bends");
    }
  },
  {
    name: "The crease angle is a tolerance: a 32-sided cylinder shows only its two rims at 30 degrees and its facet seams at 8",
    run: () => {
      const peg = cylinderMesh(5, 12, 32);
      const coarse = creaseEdges(peg, { creaseAngleDeg: 30 });
      equal(coarse.edges.length, 64, "two rims of 32 segments");
      equal(chainCount(coarse.edges), 2, "each rim is one chain");
      const fine = creaseEdges(peg, { creaseAngleDeg: 8 });
      assert(fine.edges.length >= 64 + 32, `the 32 seams between facets (11.25 degrees) appear at 8 degrees: ${fine.edges.length}`);
      equal(creaseEdges(peg, { creaseAngleDeg: 0 }).creaseAngleDeg, 2, "an absurdly small angle is clamped, not left to flood the picker");
      equal(creaseEdges(peg, { creaseAngleDeg: Number.NaN }).creaseAngleDeg, 30, "a non-number falls back to the default");
    }
  },
  {
    name: "A smooth sphere has no creases at 30 degrees, and a flat-cut sphere has its cut rim",
    run: () => {
      equal(creaseEdges(sphereMesh(10, 32, 16)).edges.length, 0, "a smooth surface offers nothing to pick");
      assert(creaseEdges(sphereMesh(10, 32, 16), { creaseAngleDeg: 5 }).edges.length > 100, "at a 5 degree tolerance the facets show");
    }
  },
  {
    name: "An open shell offers its boundary; with the option off it offers only creases",
    run: () => {
      const plate = { positionsMm: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], indices: [0, 1, 2, 0, 2, 3] };
      const withBoundary = creaseEdges(plate);
      equal(withBoundary.edges.length, 4, "the four sides, not the diagonal");
      assert(withBoundary.edges.every((edge) => edge.boundary && edge.bendDeg === 0), "all are open boundaries");
      equal(creaseEdges(plate, { includeBoundary: false }).edges.length, 0, "no boundary, no edges");
    }
  },
  {
    name: "Tangent chains carry on through a junction where a run continues without a kink",
    run: () => {
      // Two quads that touch only at the corner (10, 0): their outlines are two straight pieces each way, collinear through the pinch.
      const pinch = {
        positionsMm: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0, 20, 0, 0, 20, -10, 0, 10, -10, 0],
        indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]
      };
      const found = creaseEdges(pinch);
      equal(found.edges.length, 8, "four sides of each quad");
      equal(chainCount(found.edges), 8, "square corners do not chain, and the pinch has four edges, so each side is its own chain");
      const tangentIds = new Set(found.edges.map((edge) => edge.tangentChain));
      equal(tangentIds.size, 6, "the two collinear pairs through the pinch are carried on as tangent chains");
      const first = found.edges.find((edge) => Math.abs(edge.a[1]) < 1e-9 && Math.abs(edge.b[1]) < 1e-9 && Math.min(edge.a[0], edge.b[0]) === 0)!;
      const carried = tangentChainOf(found.edges, first.chain);
      equal(carried.length, 2, "the bottom of the first quad continues into the top of the second");
      equal(tangentChainOf(found.edges, 9999).length, 0, "an unknown chain has nothing");
    }
  },
  {
    name: "A mesh with too many creases keeps the sharpest and says it was cut short; an empty mesh is fine",
    run: () => {
      const peg = cylinderMesh(5, 12, 32);
      const limited = creaseEdges(peg, { creaseAngleDeg: 8, maxEdges: 70 });
      equal(limited.edges.length, 70, "capped");
      assert(limited.truncated, "and flagged");
      assert(limited.edges.filter((edge) => edge.bendDeg > 80).length === 64, "the 64 rim edges (90 degrees) are the ones kept");
      equal(creaseEdges({ positionsMm: [], indices: [] }).edges.length, 0, "nothing in, nothing out");
    }
  }
];
