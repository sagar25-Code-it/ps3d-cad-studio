import { applyEdgeBlend, booleanMeshes, classifyBlendRun, cylinderMesh, describePickedEdge, nearestPickableEdge, pickableEdges, sphereMesh, tessellateExtrude, type ModifyMeshInput } from "../packages/workbench-geometry/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { assert, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

type V3 = readonly [number, number, number];

const meshOf = (m: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): ModifyMeshInput => ({ positionsMm: Array.from(m.positionsMm), indices: Array.from(m.indices) });
const volumeOf = (m: ModifyMeshInput): number => solidMetrics(m.positionsMm, m.indices).volumeMm3;

function boolean(target: ModifyMeshInput, tool: ModifyMeshInput, mode: "cut" | "join"): ModifyMeshInput {
  const result = booleanMeshes(target, tool, mode);
  assert(result.ok, result.ok ? "" : result.message);
  if (!result.ok) throw new Error("unreachable");
  return { positionsMm: Array.from(result.value.positionsMm), indices: Array.from(result.value.indices) };
}

const circle = (radius: number, count: number, cx = 0, cy = 0): [number, number][] => Array.from({ length: count }, (_, i) => [cx + radius * Math.cos(2 * Math.PI * i / count), cy + radius * Math.sin(2 * Math.PI * i / count)]);
const prism = (polygon: [number, number][], height: number, z = 0): ModifyMeshInput => {
  const m = tessellateExtrude(polygon, height, "xy");
  return { positionsMm: Array.from(m.positionsMm, (v, i) => i % 3 === 2 ? v + z : v), indices: Array.from(m.indices) };
};

/** The blend of the edge nearest a point, as the picker would hand it over. */
function blendAt(mesh: ModifyMeshInput, point: V3, type: "fillet" | "chamfer", sizeMm: number): { readonly result: ReturnType<typeof applyEdgeBlend>; readonly run: readonly (readonly [V3, V3])[] } {
  const edges = pickableEdges(mesh, 5, { includeConcave: true });
  assert(typeof edges !== "string", typeof edges === "string" ? edges : "");
  const found = nearestPickableEdge(edges as Exclude<typeof edges, string>, point);
  assert(found !== undefined && found.distanceMm < 1, `an edge lies near ${point.join(", ")} (${found?.distanceMm})`);
  if (found === undefined) throw new Error("unreachable");
  const group = describePickedEdge(found.chain, undefined);
  return { result: applyEdgeBlend(mesh, undefined, [group], { type, sizeMm }), run: found.chain.map((edge) => [edge.a, edge.b] as const) };
}

function closedSolid(mesh: ModifyMeshInput): boolean {
  return isClosedAndOriented(mesh.indices) && solidMetrics(mesh.positionsMm, mesh.indices).outward;
}

export const curvedBlendTests: readonly TestCase[] = [
  {
    name: "Fillet and chamfer round the circular rim of a hole in a plate (flat face meets cylinder), as one run, with constant radius",
    run: () => {
      const plate = prism([[-20, -20], [20, -20], [20, 20], [-20, 20]], 8);
      const bore = prism(circle(6, 48), 12, -2);
      const part = boolean(plate, bore, "cut");
      const base = volumeOf(part);
      const rim = blendAt(part, [6, 0, 8], "fillet", 1.2);
      assert(rim.result.ok, rim.result.ok ? "" : rim.result.message);
      if (!rim.result.ok) return;
      const rounded = { positionsMm: Array.from(rim.result.positionsMm), indices: Array.from(rim.result.indices) };
      assert(closedSolid(rounded), "the rounded plate is still a closed, outward solid");
      const taken = base - volumeOf(rounded);
      // The corner a radius r takes from a right angle is r^2 (1 - pi/4), swept round a rim of radius ~6 + r.
      const expected = 1.2 * 1.2 * (1 - Math.PI / 4) * 2 * Math.PI * 6.6;
      assert(taken > expected * 0.7 && taken < expected * 1.3, `about the section swept round the rim: ${taken.toFixed(2)} vs ${expected.toFixed(2)} mm3`);
      const kind = classifyBlendRun(part, rim.run);
      assert(kind.ok && kind.rim && kind.sides[1] === "cylinder", `the run is named as a flat-to-cylinder rim: ${kind.ok ? kind.description : kind.message}`);
      const cut = blendAt(part, [6, 0, 8], "chamfer", 1);
      assert(cut.result.ok, cut.result.ok ? "" : cut.result.message);
      if (cut.result.ok) {
        const bevelled = { positionsMm: Array.from(cut.result.positionsMm), indices: Array.from(cut.result.indices) };
        assert(closedSolid(bevelled) && volumeOf(bevelled) < base, "a 1 mm chamfer of the same rim also builds and takes material");
      }
    }
  },
  {
    name: "The circular rim of a small boss (2 mm tall, 6 mm across) can be filleted",
    run: () => {
      const base = prism([[-15, -15], [15, -15], [15, 15], [-15, 15]], 4);
      const boss = prism(circle(3, 40), 5, 3);
      const part = boolean(base, boss, "join");
      const top = blendAt(part, [3, 0, 8], "fillet", 0.5);
      assert(top.result.ok, top.result.ok ? "" : top.result.message);
      const foot = blendAt(part, [3, 0, 4], "fillet", 0.5);
      assert(foot.result.ok, foot.result.ok ? "" : foot.result.message);
    }
  },
  {
    name: "A straight edge where a flat cut meets a cylinder wall can be filleted, and is named as such",
    run: () => {
      const peg = prism(circle(10, 64), 20);
      const cutter = prism([[6, -30], [30, -30], [30, 30], [6, 30]], 30, -5);
      const dcut = boolean(peg, cutter, "cut");
      const base = volumeOf(dcut);
      const y = Math.sqrt(100 - 36);
      const found = blendAt(dcut, [6, y, 10], "fillet", 1);
      assert(found.result.ok, found.result.ok ? "" : found.result.message);
      if (!found.result.ok) return;
      const rounded = { positionsMm: Array.from(found.result.positionsMm), indices: Array.from(found.result.indices) };
      assert(closedSolid(rounded), "closed and outward after the fillet");
      const taken = base - volumeOf(rounded);
      assert(taken > 0.1 && taken < 0.6 * 20, `a 1 mm fillet on a 20 mm edge removes a sliver (${taken.toFixed(2)} mm3), not nothing and not a chunk`);
      const kind = classifyBlendRun(dcut, found.run);
      assert(kind.ok && !kind.rim && kind.sides[1] === "cylinder", `named as an edge between a flat face and a cylinder, not a rim: ${kind.ok ? kind.description : kind.message}`);
    }
  },
  {
    name: "A flat cut across a sphere is refused with a message that names the case (flat face and a sphere)",
    run: () => {
      const ball = meshOf(sphereMesh(10, 48, 24));
      const cap = boolean(ball, prism([[-30, -30], [30, -30], [30, 30], [-30, 30]], 20, 4), "cut");
      const rimRadius = Math.sqrt(100 - 16);
      const found = blendAt(cap, [rimRadius, 0, 4], "fillet", 0.5);
      assert(!found.result.ok, "the sphere cap rim is not built");
      if (found.result.ok) return;
      assert(/flat face/.test(found.result.message) && /not a cylinder/.test(found.result.message) && /sphere/.test(found.result.message), `names the case: ${found.result.message}`);
      assert(/Pick an edge/.test(found.result.message), "and says what to do instead");
    }
  },
  {
    name: "Where two cylinders cross, the curve between them is refused as two curved faces",
    run: () => {
      const upright = prism(circle(8, 48), 30, -15);
      const pipe = meshOf(cylinderMesh(5, 40, 48));
      // Lay the second cylinder along X.
      const lying: ModifyMeshInput = { positionsMm: pipe.positionsMm.map((_, i, all) => i % 3 === 0 ? all[i + 2]! : i % 3 === 2 ? all[i - 2]! : all[i]!), indices: pipe.indices.map((_, i, all) => i % 3 === 1 ? all[i + 1]! : i % 3 === 2 ? all[i - 1]! : all[i]!) };
      const cross = boolean(upright, lying, "join");
      const edges = pickableEdges(cross, 5, { includeConcave: true });
      assert(typeof edges !== "string", "the crossing body has pickable edges");
      if (typeof edges === "string") return;
      const seam = edges.filter((edge) => Math.abs(edge.a[0]) > 1 && Math.abs(edge.a[0]) < 7.9 && Math.abs(edge.a[2]) < 6 && edge.concave === true);
      assert(seam.length > 0, "the intersection curve is among the pickable edges");
      const found = nearestPickableEdge(edges, seam[0]!.a)!;
      const blended = applyEdgeBlend(cross, undefined, [describePickedEdge(found.chain, undefined)], { type: "fillet", sizeMm: 0.5 });
      assert(!blended.ok, "the crossing is not filleted");
      if (!blended.ok) assert(/two cylindrical faces|curved/.test(blended.message) && /flat face/.test(blended.message), `names the case: ${blended.message}`);
    }
  },
  {
    name: "A plain box edge is still filleted exactly as before (flat to flat is not slowed or refused)",
    run: () => {
      const box = prism([[0, 0], [30, 0], [30, 20], [0, 20]], 10);
      const found = blendAt(box, [15, 0, 10], "fillet", 1.5);
      assert(found.result.ok, found.result.ok ? "" : found.result.message);
      const kind = classifyBlendRun(box, found.run);
      assert(kind.ok && kind.sides[0] === "plane" && kind.sides[1] === "plane", "flat to flat");
    }
  }
];
