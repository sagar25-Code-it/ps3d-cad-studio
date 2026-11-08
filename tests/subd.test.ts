import { cageFaceNormal, cageIsClosed, cageProblem, deleteCageFaces, extrudeCageFaces, finishForm, insertEdgeLoop, moveCageVertices, subdBox, subdCylinder, subdPlane, subdivideCage, type SubdCage } from "../packages/workbench-geometry/src/subd.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const edgeUses = (indices: readonly number[]): Map<string, number> => {
  const uses = new Map<string, number>();
  for (let i = 0; i + 2 < indices.length; i += 3) for (let k = 0; k < 3; k += 1) { const a = indices[i + k]!; const b = indices[i + (k + 1) % 3]!; const key = a < b ? `${a},${b}` : `${b},${a}`; uses.set(key, (uses.get(key) ?? 0) + 1); }
  return uses;
};
const isClosedAndOriented = (indices: readonly number[]): boolean => {
  const directed = new Map<string, number>();
  for (let i = 0; i + 2 < indices.length; i += 3) for (let k = 0; k < 3; k += 1) { const key = `${indices[i + k]}>${indices[i + (k + 1) % 3]}`; directed.set(key, (directed.get(key) ?? 0) + 1); }
  for (const [key, count] of directed) { const [a, b] = key.split(">"); if (count !== 1 || directed.get(`${b}>${a}`) !== 1) return false; }
  return directed.size > 0;
};
const bounds = (positions: readonly number[]): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 1) { min[i % 3] = Math.min(min[i % 3]!, positions[i]!); max[i % 3] = Math.max(max[i % 3]!, positions[i]!); }
  return { min, max };
};
const cageOk = (edit: { readonly ok: boolean; readonly message?: string; readonly cage?: SubdCage }, label: string): SubdCage => { assert(edit.ok, `${label}: ${edit.message ?? ""}`); return edit.cage!; };

export const subdTests: readonly TestCase[] = [
  {
    name: "Catmull-Clark on a cube follows the textbook numbers: counts, the 5/9 corner, the 3/4 edge point, Euler characteristic 2 at every level, symmetric limit",
    run: () => {
      const cube = subdBox(2, 2, 2);
      assert(cageProblem(cube) === undefined && cageIsClosed(cube), "the box cage is a valid closed cage");
      const one = subdivideCage(cube, 1);
      assert(one.ok, "level 1");
      if (!one.ok) return;
      equal(one.mesh.positionsMm.length / 3, 8 + 12 + 6, "V' = V + E + F = 26");
      equal(one.mesh.quads.length, 24, "every cage quad became four");
      const find = (x: number, y: number, z: number): boolean => { for (let i = 0; i < one.mesh.positionsMm.length; i += 3) if (Math.hypot(one.mesh.positionsMm[i]! - x, one.mesh.positionsMm[i + 1]! - y, one.mesh.positionsMm[i + 2]! - z) < 1e-9) return true; return false; };
      assert(find(5 / 9, 5 / 9, 5 / 9), "a corner moves to (5/9, 5/9, 5/9)");
      assert(find(0.75, 0.75, 0), "an edge point is (3/4, 3/4, 0)");
      assert(find(1, 0, 0), "a face point stays at the face centre");
      for (let level = 0; level <= 4; level += 1) {
        const result = subdivideCage(cube, level);
        assert(result.ok, `level ${level}`);
        if (!result.ok) return;
        const vertices = result.mesh.positionsMm.length / 3;
        const edges = new Set<string>();
        for (const quad of result.mesh.quads) for (let k = 0; k < quad.length; k += 1) { const a = quad[k]!; const b = quad[(k + 1) % quad.length]!; edges.add(a < b ? `${a},${b}` : `${b},${a}`); }
        equal(vertices - edges.size + result.mesh.quads.length, 2, `level ${level}: Euler characteristic of a sphere`);
        assert(isClosedAndOriented(result.mesh.indices), `level ${level}: closed and consistently wound`);
        const extent = bounds(result.mesh.positionsMm);
        near(extent.max[0]! + extent.min[0]!, 0, 1e-9, `level ${level}: centred`);
        near(extent.max[0]!, extent.max[1]!, 1e-9, `level ${level}: symmetric in x and y`);
        near(extent.max[1]!, extent.max[2]!, 1e-9, `level ${level}: symmetric in y and z`);
        if (level >= 3) assert(extent.max[0]! < 0.95 && extent.max[0]! > 0.7, `level ${level}: the smooth limit sits inside the cage (${extent.max[0]!.toFixed(3)})`);
      }
      assert(!subdivideCage(cube, 6).ok && !subdivideCage(cube, -1).ok, "levels are limited to 0 to 5");
      assert(!subdivideCage({ verticesMm: cube.verticesMm, faces: [[0, 1, 2, 9]] }, 1).ok, "a face naming a missing vertex is refused");
    }
  },
  {
    name: "Finish Form turns a closed cage into an outward solid whose volume lies between the inscribed sphere and the cage, and refuses an open cage",
    run: () => {
      const cube = subdBox(2, 2, 2);
      const volumes: number[] = [];
      for (const level of [0, 1, 2, 3]) {
        const result = finishForm(cube, level);
        assert(result.ok, `level ${level}: ${result.ok ? "" : result.message}`);
        if (!result.ok) return;
        assert(isClosedAndOriented(result.indices), `level ${level}: closed and consistently wound`);
        volumes.push(result.volumeMm3);
      }
      near(volumes[0]!, 8, 1e-9, "level 0 is the cage itself");
      assert(volumes[1]! < volumes[0]! && volumes[2]! < volumes[1]! && volumes[3]! < volumes[2]!, "the form shrinks towards its limit as it is subdivided");
      assert(volumes[3]! > 1.44 && volumes[3]! < 4, `the limit (${volumes[3]!.toFixed(3)}) is a rounded form well inside the cage's 8 mm3 (a sphere of radius 0.7 is 1.44)`);
      near(volumes[3]!, volumes[2]!, 0.35, "and it has nearly converged by level 3");
      const flipped = { verticesMm: cube.verticesMm, faces: cube.faces.map((face) => [...face].reverse()) };
      const reversed = finishForm(flipped, 2);
      assert(reversed.ok && reversed.volumeMm3 > 0 && isClosedAndOriented(reversed.indices), "a cage wound inside-out still finishes outward");
      const plane = subdPlane(10, 10, 3, 3);
      assert(!cageIsClosed(plane), "a plane cage is open");
      const open = finishForm(plane, 2);
      assert(!open.ok && open.message.includes("open"), "an open cage cannot be finished into a solid");
      const surface = subdivideCage(plane, 2);
      assert(surface.ok && surface.mesh.positionsMm.filter((_, i) => i % 3 === 2).every((z) => Math.abs(z) < 1e-9), "but it still subdivides: a flat grid stays flat, boundary rules keep its edge");
      if (surface.ok) near(bounds(surface.mesh.positionsMm).max[0]!, 5, 1e-9, "and keeps its outline");
      const cylinder = finishForm(subdCylinder(5, 12, 12), 2);
      assert(cylinder.ok && cylinder.volumeMm3 > 0, "a cylinder cage finishes too");
    }
  },
  {
    name: "moving cage vertices reshapes the surface, and the cage keeps its topology",
    run: () => {
      const cube = subdBox(2, 2, 2);
      const before = finishForm(cube, 3);
      const lifted = cageOk(moveCageVertices(cube, [4, 5, 6, 7], [0, 0, 1.5]), "lift the top");
      equal(lifted.faces.length, cube.faces.length, "same faces");
      equal(lifted.verticesMm.length, cube.verticesMm.length, "same vertices");
      const after = finishForm(lifted, 3);
      assert(before.ok && after.ok, "both finish");
      if (!before.ok || !after.ok) return;
      const lift = bounds(after.positionsMm).max[2]! - bounds(before.positionsMm).max[2]!;
      assert(lift > 1.2 && lift < 1.5, `the smooth top follows the cage up, a little less than the cage moved (${lift.toFixed(3)} of 1.5)`);
      assert(after.volumeMm3 > before.volumeMm3 * 1.4 && after.volumeMm3 < before.volumeMm3 * 1.9, `a form with the top lifted holds more (${before.volumeMm3.toFixed(2)} -> ${after.volumeMm3.toFixed(2)})`);
      const one = cageOk(moveCageVertices(cube, [6], [1, 1, 1]), "pull one corner out");
      const pulled = finishForm(one, 3);
      assert(pulled.ok && Math.max(...pulled.positionsMm.filter((_, i) => i % 3 === 0)) > bounds(before.ok ? before.positionsMm : []).max[0]! + 0.1, "pulling a corner out pushes the surface that way");
      assert(!moveCageVertices(cube, [], [1, 0, 0]).ok && !moveCageVertices(cube, [99], [1, 0, 0]).ok && !moveCageVertices(cube, [0], [Number.NaN, 0, 0]).ok, "bad moves are refused");
    }
  },
  {
    name: "extruding faces adds side faces and keeps the cage closed; negative distances push in; an interior shared edge gets no side face",
    run: () => {
      const cube = subdBox(2, 2, 2);
      const top = cube.faces.findIndex((_, id) => cageFaceNormal(cube, id)[2] > 0.99);
      const taller = cageOk(extrudeCageFaces(cube, [top], 2), "extrude the top by 2");
      equal(taller.faces.length, 6 + 4, "four side quads were added");
      equal(taller.verticesMm.length / 3, 8 + 4, "four new vertices");
      assert(cageIsClosed(taller) && cageProblem(taller) === undefined, "still a closed, valid cage");
      const grown = finishForm(taller, 3);
      const plain = finishForm(cube, 3);
      assert(grown.ok && plain.ok, "finish");
      if (grown.ok && plain.ok) {
        near(bounds(grown.positionsMm).max[2]! - bounds(plain.positionsMm).max[2]!, 2, 0.1, "the form got taller by the extrusion");
        assert(grown.volumeMm3 > plain.volumeMm3 * 1.5, "and holds more");
      }
      assert(!extrudeCageFaces(cube, [top], -0.5).ok, "pushing a face in without an inset would give the pocket walls of no thickness, so it is refused");
      const pocket = cageOk(extrudeCageFaces(cube, [top], -0.5, 0.4), "a pocket: push the top in 0.5 and draw the cap in 0.4");
      assert(cageIsClosed(pocket) && cageProblem(pocket) === undefined, "a pocket is still a closed, valid cage");
      assert(pocket.verticesMm.filter((_, i) => i % 3 === 2).filter((z) => Math.abs(z - 0.5) < 1e-9).length === 4, "the pocket floor sits 0.5 mm below the old top (z = 0.5), inside the cage's rim at z = 1");
      const half = 1 - 0.4 / Math.SQRT2;
      const frustum = (0.5 / 3) * (4 + (2 * half) ** 2 + 4 * half);
      const cageVolume = finishForm(pocket, 0);
      assert(cageVolume.ok, "the pocket cage encloses a volume");
      if (cageVolume.ok) near(cageVolume.volumeMm3, 8 - frustum, 1e-6, "its volume is the box less the frustum-shaped pocket");
      assert(finishForm(pocket, 3).ok, "and its smooth form finishes");
      const boss = cageOk(extrudeCageFaces(cube, [top], 1, 0.3), "a tapered boss");
      assert(cageIsClosed(boss) && Math.max(...boss.verticesMm.filter((_, i) => i % 3 === 0)) <= 1 + 1e-9, "a boss drawn in stays inside the cage's outline");
      assert(!extrudeCageFaces(cube, [top], 1, -1).ok, "a negative inset is refused");
      // Two neighbouring faces together: the edge between them is interior to the selection and gets no side face.
      const side = cube.faces.findIndex((_, id) => cageFaceNormal(cube, id)[0] > 0.99);
      const both = cageOk(extrudeCageFaces(cube, [top, side], 1), "extrude two neighbouring faces");
      equal(both.faces.length, 6 + 6, "the two faces share an edge, so 8 - 2 = 6 side quads");
      assert(cageIsClosed(both) && cageProblem(both) === undefined, "and the cage is still closed");
      assert(!extrudeCageFaces(cube, [], 1).ok && !extrudeCageFaces(cube, [top], 0).ok && !extrudeCageFaces(cube, [77], 1).ok, "empty, zero and missing extrusions are refused");
      const everything = cageOk(extrudeCageFaces(cube, [0, 1, 2, 3, 4, 5], 1), "extrude every face");
      assert(cageProblem(everything) === undefined, "extruding the whole cage is a valid (larger) cage");
    }
  },
  {
    name: "an edge loop splits the quads round the cage, at the chosen ratio, and stops at anything that is not a quad",
    run: () => {
      const cube = subdBox(2, 2, 2);
      // The vertical edge 0-4 (bottom to top corner): its loop runs round the four sides.
      const looped = cageOk(insertEdgeLoop(cube, 0, 4, 0.25), "loop round the sides");
      equal(looped.faces.length, 6 + 4, "four side quads were cut in two");
      equal(looped.verticesMm.length / 3, 8 + 4, "four new ring vertices");
      assert(cageIsClosed(looped) && cageProblem(looped) === undefined, "closed and valid");
      const ring = looped.verticesMm.slice(8 * 3);
      for (let i = 0; i < ring.length; i += 3) near(ring[i + 2]!, -1 + 0.25 * 2, 1e-9, "every ring vertex is a quarter of the way up the edge");
      const smooth = finishForm(looped, 3);
      assert(smooth.ok, "the looped cage finishes");
      const wide = cageOk(insertEdgeLoop(subdPlane(10, 10, 3, 3), 0, 1, 0.5), "loop across a grid");
      equal(wide.faces.length, 9 + 3, "a loop across a 3 x 3 grid cuts three quads");
      assert(!insertEdgeLoop(cube, 0, 1, 0).ok && !insertEdgeLoop(cube, 0, 1, 1).ok, "a loop at 0 or 1 is refused");
      assert(!insertEdgeLoop(cube, 0, 6, 0.5).ok, "a diagonal is not an edge");
      const cylinder = subdCylinder(5, 10, 8);
      const capEdge = insertEdgeLoop(cylinder, 0, 1, 0.5);
      assert(!capEdge.ok && capEdge.message.includes("quads"), "a loop that runs into a cap polygon is refused with the reason");
      const aroundCylinder = cageOk(insertEdgeLoop(cylinder, 0, 8, 0.5), "loop round the cylinder's wall");
      equal(aroundCylinder.faces.length, 10 + 8, "a ring round the cylinder cuts all 8 wall quads");
      assert(cageIsClosed(aroundCylinder) && cageProblem(aroundCylinder) === undefined, "and keeps it closed");
    }
  },
  {
    name: "deleting faces opens the cage; a damaged cage is described, not subdivided",
    run: () => {
      const cube = subdBox(2, 2, 2);
      const open = cageOk(deleteCageFaces(cube, [1]), "remove the top");
      equal(open.faces.length, 5, "five faces left");
      assert(!cageIsClosed(open) && cageProblem(open) === undefined, "an open but valid cage");
      assert(subdivideCage(open, 2).ok, "it subdivides with boundary rules");
      assert(!finishForm(open, 2).ok, "but cannot be finished");
      assert(!deleteCageFaces(cube, []).ok && !deleteCageFaces(cube, [0, 1, 2, 3, 4, 5]).ok && !deleteCageFaces(cube, [9]).ok, "empty, total and missing deletions are refused");
      assert((cageProblem({ verticesMm: cube.verticesMm, faces: [[0, 3, 2, 1], [0, 3, 2, 1]] }) ?? "").includes("same way"), "two faces wound the same way along an edge are reported");
      assert((cageProblem({ verticesMm: cube.verticesMm, faces: [[0, 1, 2, 3], [1, 0, 4, 5], [0, 1, 6, 7]] }) ?? "").includes("shared by 3"), "an edge used by three faces is reported");
      assert((cageProblem({ verticesMm: cube.verticesMm, faces: [[0, 1, 1, 2]] }) ?? "").includes("twice"), "a face using a vertex twice is reported");
      assert(cageProblem({ verticesMm: [0, 0, 0], faces: [[0, 1, 2]] }) !== undefined, "too few vertices");
    }
  }
];
