import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { designOf } from "../packages/workbench-core/src/index.js";
import { flexBody, sliceMesh } from "../packages/workbench-geometry/src/flex.js";
import { analyzeFaces } from "../packages/workbench-geometry/src/face-analysis.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { boxMesh, volumeOf, type Mesh } from "./body-edits.test.js";
import { BODY, addAndReplay, blockProject, bodyOf, editStep, replayed, volumeOfBody } from "./body-edit-timeline.test.js";

const nearestVertex = (mesh: Mesh, target: readonly [number, number, number]): number => {
  let best = Infinity;
  for (let i = 0; i + 2 < mesh.positionsMm.length; i += 3) best = Math.min(best, Math.hypot(mesh.positionsMm[i]! - target[0], mesh.positionsMm[i + 1]! - target[1], mesh.positionsMm[i + 2]! - target[2]));
  return best;
};
const boundsOf = (mesh: Mesh): { readonly min: readonly number[]; readonly max: readonly number[] } => {
  const m = solidMetrics(mesh.positionsMm, mesh.indices);
  return { min: m.boundsMm.min, max: m.boundsMm.max };
};

export const bodyFlexTests: readonly TestCase[] = [
  {
    name: "Slicing a mesh along planes keeps it closed and the same volume while adding the vertices a bend needs",
    run: () => {
      const bar = boxMesh(100, 10, 10);
      const planes = Array.from({ length: 9 }, (_, k) => ({ normal: [1, 0, 0] as const, offset: 10 * (k + 1) + 0.37 }));
      const cut = sliceMesh(bar, planes);
      assert(typeof cut !== "string", "slices");
      if (typeof cut === "string") return;
      const flat = cut.positions.flatMap((p) => [p[0], p[1], p[2]]);
      const indices = cut.triangles.flat();
      assert(isClosedAndOriented(indices), "the sliced mesh is still closed and consistently wound");
      near(solidMetrics(flat, indices).volumeMm3, 10000, 1e-6, "the volume is unchanged");
      assert(cut.positions.length > 8 + 9 * 4 - 1, "each plane added a ring of vertices along the bar");
      const plain = sliceMesh(bar, [{ normal: [1, 0, 0], offset: 50 }]);
      assert(typeof plain !== "string" && isClosedAndOriented(plain.triangles.flat()), "a plane through existing vertices' neighbours splits cleanly");
      const onVertices = sliceMesh(bar, [{ normal: [1, 0, 0], offset: 0 }, { normal: [1, 0, 0], offset: 100 }]);
      assert(typeof onVertices !== "string" && onVertices.triangles.length === 12, "planes that only touch the faces change nothing");
    }
  },
  {
    name: "Bending a bar 90° puts its end on the arc: the corners land where the formula says, the volume follows, the solid stays closed",
    run: () => {
      const bar = boxMesh(100, 10, 10);
      const bent = flexBody(bar, { mode: "bend", angleDeg: 90, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1] });
      assert(bent.ok, `bend succeeds: ${bent.ok ? "" : bent.message}`);
      if (!bent.ok) return;
      assert(analyzeFaces(bent) !== undefined && typeof analyzeFaces(bent) !== "string", "the bent body is a closed outward solid");
      const rho = 100 / (Math.PI / 2);
      near(volumeOf(bent), 10 * (Math.PI / 2) * (10 * rho - 50), 10000 * 0.004, "volume of the curved bar: the inside of the bend is shorter");
      const bounds = boundsOf(bent);
      near(bounds.max[0]!, rho, 0.05, "the outer face of the bar's end reaches x = rho");
      near(bounds.max[1]!, rho, 0.05, "and the end has swung to y = rho");
      near(bounds.min[1]!, 0, 1e-9, "the root stays on y = 0");
      near(bounds.max[2]! - bounds.min[2]!, 10, 1e-9, "the height along the axis is unchanged");
      assert(nearestVertex(bent, [rho, rho, 0]) < 1e-6, "the corner (100, 0, 0) landed exactly at (rho, rho, 0)");
      assert(nearestVertex(bent, [rho - 10, rho, 10]) < 1e-6, "the corner (100, 10, 10) landed exactly at (rho - 10, rho, 10)");
      const reverse = flexBody(bar, { mode: "bend", angleDeg: -90, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1] });
      assert(reverse.ok, "a negative angle bends the other way");
      if (reverse.ok) near(boundsOf(reverse).min[1]!, -rho, 0.05, "the end swung to y = -rho");
    }
  },
  {
    name: "A bend over part of the bar keeps the rest rigid and turned by the full angle",
    run: () => {
      const bar = boxMesh(100, 10, 10);
      const phi = Math.PI / 3; const zone = 40; const rho = zone / phi;
      const bent = flexBody(bar, { mode: "bend", angleDeg: 60, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1], lengthDirectionMm: [1, 0, 0], zoneLengthMm: zone });
      assert(bent.ok, `partial bend: ${bent.ok ? "" : bent.message}`);
      if (!bent.ok) return;
      const tail = (s: number, h: number): [number, number] => {
        const r = rho - h;
        return [r * Math.sin(phi) + (s - zone) * Math.cos(phi), rho - r * Math.cos(phi) + (s - zone) * Math.sin(phi)];
      };
      const [x0, y0] = tail(100, 0); const [x1, y1] = tail(100, 10);
      assert(nearestVertex(bent, [x0, y0, 0]) < 1e-6, "the far corner on the neutral side sits where the rigid tail puts it");
      assert(nearestVertex(bent, [x1, y1, 10]) < 1e-6, "the far inner corner too");
      assert(nearestVertex(bent, [0, 0, 0]) < 1e-9 && nearestVertex(bent, [0, 10, 10]) < 1e-9, "the root end did not move");
      near(Math.hypot(x1 - x0, y1 - y0), 10, 1e-9, "the end face is still 10 mm across");
      const rigid = flexBody(bar, { mode: "bend", angleDeg: 0.5, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1], zoneLengthMm: 30 });
      assert(rigid.ok, "a tiny bend works");
    }
  },
  {
    name: "A bend is refused when the part is too thick to curve that tightly, or when the angle or axis is unusable",
    run: () => {
      const slab = boxMesh(100, 60, 10);
      const tight = flexBody(slab, { mode: "bend", angleDeg: 180, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1] });
      assert(!tight.ok && tight.message.includes("fold"), "a 60 mm thick slab cannot bend 180° over 100 mm");
      const bar = boxMesh(100, 10, 10);
      assert(!flexBody(bar, { mode: "bend", angleDeg: 0, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1] }).ok, "zero angle");
      assert(!flexBody(bar, { mode: "bend", angleDeg: 200, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1] }).ok, "over 180°");
      assert(!flexBody(bar, { mode: "bend", angleDeg: 30, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 0] }).ok, "no axis");
      assert(!flexBody(bar, { mode: "bend", angleDeg: 30, axisPointMm: [0, 0, 0], axisDirectionMm: [0, 0, 1], lengthDirectionMm: [0, 0, 1] }).ok, "bend direction along the axis");
      assert(!flexBody(bar, { mode: "bend", angleDeg: 30, axisPointMm: [500, 0, 0], axisDirectionMm: [0, 0, 1], lengthDirectionMm: [1, 0, 0] }).ok, "an axis point beyond the whole body leaves nothing to bend");
    }
  },
  {
    name: "Twisting a bar turns each cross-section by its share of the angle: the far end is turned the full amount and the volume is kept",
    run: () => {
      const bar = boxMesh(10, 10, 60);
      const twisted = flexBody(bar, { mode: "twist", angleDeg: 90, axisPointMm: [5, 5, 0], axisDirectionMm: [0, 0, 1] });
      assert(twisted.ok, `twist succeeds: ${twisted.ok ? "" : twisted.message}`);
      if (!twisted.ok) return;
      assert(typeof analyzeFaces(twisted) !== "string", "the twisted bar is a closed outward solid");
      assert(nearestVertex(twisted, [0, 10, 60]) < 1e-6, "the far corner (10, 10, 60) turned 90° about the axis to (0, 10, 60)");
      assert(nearestVertex(twisted, [10, 10, 0]) < 1e-9, "the root end did not turn");
      const half = 5 * Math.SQRT2;
      assert(nearestVertex(twisted, [5, 5 + half, 30]) < 1e-6, "halfway up the corner has turned 45°");
      near(volumeOf(twisted), 6000, 6000 * 0.03, "a twist keeps the volume (within the facet error of 30 cuts)");
      equal(Math.round(boundsOf(twisted).max[2]!), 60, "the length along the axis is unchanged");
    }
  },
  {
    name: "A flex step replays from the timeline, follows a change of the block under it, can be suppressed and is refused when it does not fit",
    run: async () => {
      const { project, base } = await blockProject();
      // The block is 40 x 30 x 20 from (-20, -15, 0); bend it about the Z axis at its left end.
      const step = editStep("flex-1", "flex", { kind: "flex", mode: "bend", angleDeg: 45, axisPointMm: [-20, -15, 0], axisDirectionMm: [0, 0, 1], lengthDirectionMm: [1, 0, 0] }, 45);
      const current = await addAndReplay(project, step);
      const flagged = designOf(current).features.find((feature) => feature.id === step.id);
      assert(flagged !== undefined && flagged.health === undefined, `the flex applied: ${flagged?.health?.message ?? ""}`);
      const rho = 40 / (Math.PI / 4);
      near(volumeOfBody(current), 20 * (Math.PI / 4) * (30 * rho - 450), 20 * (Math.PI / 4) * (30 * rho - 450) * 0.01, "the bent block has the volume of the curved block: the inside of the bend is shorter");
      assert(typeof analyzeFaces(bodyOf(current)) !== "string", "and is a closed outward solid");
      const off = designOf(current).features.map((feature) => feature.id === step.id ? { ...feature, suppressed: true } : feature);
      near(volumeOfBody(await replayed({ ...current, design: { ...designOf(current), features: off } })), 24000, 1e-3, "a suppressed flex leaves the block straight");
      const tooTight = editStep("flex-2", "flex", { kind: "flex", mode: "bend", angleDeg: 170, axisPointMm: [-20, -15, 0], axisDirectionMm: [0, 0, 1], lengthDirectionMm: [1, 0, 0], zoneLengthMm: 10 }, 170);
      const refused = await addAndReplay(project, tooTight);
      const health = designOf(refused).features.find((feature) => feature.id === tooTight.id);
      assert(health !== undefined && health.health !== undefined && health.health.message.includes("fold"), "a bend that would fold through itself is flagged on its step");
      near(volumeOfBody(refused), 24000, 1e-3, "and the block keeps its shape");
      void base; void BODY;
    }
  }
];
