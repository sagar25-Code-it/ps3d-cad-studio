import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { analyzeFaces, resolveFace, type FaceRefLike } from "../packages/workbench-geometry/src/face-analysis.js";
import { draftFaces, offsetRegion, replaceFaces, shellBody, type FaceEditResult } from "../packages/workbench-geometry/src/face-edits.js";
import { booleanMeshes } from "../packages/workbench-geometry/src/mesh-boolean.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

export interface Mesh { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }
type Point = readonly [number, number];

export const extrudeMesh = (polygon: readonly Point[], height: number, plane: "xy" | "xz" | "yz" = "xy"): Mesh => {
  const mesh = tessellateExtrude(polygon, height, plane);
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
};
export const boxMesh = (w: number, d: number, h: number): Mesh => extrudeMesh([[0, 0], [w, 0], [w, d], [0, d]], h);
export const roundMesh = (radius: number, height: number, segments = 72): Mesh =>
  extrudeMesh(Array.from({ length: segments }, (_, index): Point => [radius * Math.cos((2 * Math.PI * index) / segments), radius * Math.sin((2 * Math.PI * index) / segments)]), height);

export const volumeOf = (mesh: Mesh): number => solidMetrics(mesh.positionsMm, mesh.indices).volumeMm3;
export const face = (point: readonly [number, number, number], normal: readonly [number, number, number]): FaceRefLike => ({ pointMm: point, normalMm: normal });

export function okMesh(result: FaceEditResult, what: string): Mesh & { readonly notes: readonly string[] } {
  assert(result.ok, `${what} succeeds: ${result.ok ? "" : result.message}`);
  assert(isClosedAndOriented(result.indices), `${what} leaves a closed, consistently wound mesh`);
  assert(solidMetrics(result.positionsMm, result.indices).outward, `${what} winds outward`);
  return result;
}

const polygonArea = (polygon: readonly Point[]): number => {
  let sum = 0;
  for (let index = 0; index < polygon.length; index += 1) { const a = polygon[index]!; const b = polygon[(index + 1) % polygon.length]!; sum += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(sum) / 2;
};
/** Area of a regular polygon with the given circumradius. */
const regularArea = (circumradius: number, sides: number): number => (sides / 2) * circumradius * circumradius * Math.sin((2 * Math.PI) / sides);

const planesOf = (mesh: Mesh): { readonly normal: readonly number[]; readonly offset: number; readonly area: number }[] => {
  const analysis = analyzeFaces(mesh);
  assert(typeof analysis !== "string", "analysable");
  if (typeof analysis === "string") return [];
  return analysis.regions.map((region) => ({ normal: region.normal, offset: region.offset, area: region.areaMm2 }));
};
const hasPlane = (planes: ReturnType<typeof planesOf>, normal: readonly number[], offset: number): boolean =>
  planes.some((plane) => Math.abs(plane.normal[0]! - normal[0]!) + Math.abs(plane.normal[1]! - normal[1]!) + Math.abs(plane.normal[2]! - normal[2]!) < 1e-6 && Math.abs(plane.offset - offset) < 1e-5);

export const bodyEditGeometryTests: readonly TestCase[] = [
  {
    name: "Face analysis finds six flat regions on a box and tells a cylinder's wall facets from its flat caps",
    run: () => {
      const box = analyzeFaces(boxMesh(40, 30, 20));
      assert(typeof box !== "string", "a box is analysable");
      if (typeof box === "string") return;
      equal(box.regions.length, 6, "a box has six faces");
      assert(box.regions.every((region) => !region.curved), "no face of a box is curved");
      near(box.regions.reduce((sum, region) => sum + region.areaMm2, 0), 2 * (40 * 30 + 40 * 20 + 30 * 20), 1e-6, "the regions cover the whole surface");
      const round = analyzeFaces(roundMesh(15, 20));
      assert(typeof round !== "string", "a cylinder is analysable");
      if (typeof round === "string") return;
      equal(round.regions.filter((region) => region.curved).length, 72, "every wall facet of a 72-sided cylinder is curved");
      equal(round.regions.filter((region) => !region.curved).length, 2, "the two caps are flat");
      assert(typeof analyzeFaces({ positionsMm: boxMesh(1, 1, 1).positionsMm, indices: boxMesh(1, 1, 1).indices.slice(3) }) === "string", "an open mesh is refused");
    }
  },
  {
    name: "A picked face is found again by where it was and which way it looked, even after the body was resized",
    run: () => {
      const ref = face([40, 15, 10], [1, 0, 0]);
      for (const width of [40, 55]) {
        const mesh = boxMesh(width, 30, 20);
        const analysis = analyzeFaces(mesh);
        assert(typeof analysis !== "string", "analysable");
        if (typeof analysis === "string") return;
        const found = resolveFace(mesh, analysis, ref);
        assert(found.ok, `+X wall found on a ${width} mm wide box`);
        if (found.ok) near(found.region.offset, width, 1e-9, "the +X face is at the box's right end");
      }
      const mesh = boxMesh(40, 30, 20);
      const analysis = analyzeFaces(mesh);
      if (typeof analysis === "string") return;
      const gone = resolveFace(mesh, analysis, face([500, 500, 500], [1, 0, 0]));
      assert(!gone.ok, "a face hundreds of mm from the body is reported gone, not guessed");
    }
  },
  {
    name: "Shell of a box with the top, a side or two faces open hollows it to the exact wall volume",
    run: () => {
      const box = boxMesh(40, 30, 20);
      const t = 2;
      const top = okMesh(shellBody(box, { thicknessMm: t, side: "inside", openFaces: [face([20, 15, 20], [0, 0, 1])] }), "shell, top open");
      near(volumeOf(top), 40 * 30 * 20 - 36 * 26 * 18, 1e-3, "open-top volume is outside minus inside");
      const bounds = solidMetrics(top.positionsMm, top.indices).sizeMm;
      near(bounds[0], 40, 1e-6, "the outside stays 40 wide"); near(bounds[2], 20, 1e-6, "and 20 tall");
      const side = okMesh(shellBody(box, { thicknessMm: t, side: "inside", openFaces: [face([40, 15, 10], [1, 0, 0])] }), "shell, +X open");
      near(volumeOf(side), 40 * 30 * 20 - 38 * 26 * 16, 1e-3, "an open side wall (not +Z) is shelled just as exactly");
      const bottom = okMesh(shellBody(box, { thicknessMm: t, side: "inside", openFaces: [face([20, 15, 0], [0, 0, -1])] }), "shell, bottom open");
      near(volumeOf(bottom), 40 * 30 * 20 - 36 * 26 * 18, 1e-3, "an open bottom gives the same volume as an open top");
      const tube = okMesh(shellBody(box, { thicknessMm: t, side: "inside", openFaces: [face([20, 15, 20], [0, 0, 1]), face([20, 15, 0], [0, 0, -1])] }), "shell, top and bottom open");
      near(volumeOf(tube), 40 * 30 * 20 - 36 * 26 * 20, 1e-3, "two open faces leave a rectangular tube");
      const outside = okMesh(shellBody(box, { thicknessMm: t, side: "outside", openFaces: [face([20, 15, 20], [0, 0, 1])] }), "shell, outside");
      near(volumeOf(outside), 44 * 34 * 22 - 40 * 30 * 20, 1e-3, "the outside shell grows the walls out and keeps the 40 x 30 x 20 cavity");
      const bothSides = okMesh(shellBody(box, { thicknessMm: t, side: "both", openFaces: [face([20, 15, 20], [0, 0, 1])] }), "shell, both directions");
      near(volumeOf(bothSides), 42 * 32 * 21 - 38 * 28 * 19, 1e-3, "half the wall each way");
    }
  },
  {
    name: "Shell of a cylinder and of an L-shaped body with a chosen open face matches the volume computed from the outline",
    run: () => {
      const radius = 15; const sides = 72; const height = 20; const t = 2;
      const cylinder = roundMesh(radius, height, sides);
      const cap = okMesh(shellBody(cylinder, { thicknessMm: t, side: "inside", openFaces: [face([0, 0, height], [0, 0, 1])] }), "cylinder shell");
      const inner = (radius * Math.cos(Math.PI / sides) - t) / Math.cos(Math.PI / sides);
      near(volumeOf(cap), regularArea(radius, sides) * height - regularArea(inner, sides) * (height - t), 0.5, "cylinder shell volume is outside minus inside");
      const sizes = solidMetrics(cap.positionsMm, cap.indices).sizeMm;
      near(sizes[0], 2 * radius, 0.1, "the cup is as wide as the cylinder");
      const outline: Point[] = [[0, 0], [40, 0], [40, 15], [20, 15], [20, 30], [0, 30]];
      const l = extrudeMesh(outline, 12);
      const cup = okMesh(shellBody(l, { thicknessMm: t, side: "inside", openFaces: [face([10, 20, 12], [0, 0, 1])] }), "L shell");
      const perimeter = 40 + 15 + 20 + 15 + 20 + 30;
      const areaIn = polygonArea(outline) - perimeter * t + 4 * t * t;
      near(volumeOf(cup), polygonArea(outline) * 12 - areaIn * (12 - t), 1e-3, "an L-shaped cup: outside minus inside");
    }
  },
  {
    name: "Shell refuses a wall too thick for the body, a curved face as the opening, and a missing face",
    run: () => {
      const box = boxMesh(40, 30, 20);
      const thick = shellBody(box, { thicknessMm: 16, side: "inside", openFaces: [face([20, 15, 20], [0, 0, 1])] });
      assert(!thick.ok, "a 16 mm wall in a 30 mm wide box leaves no cavity");
      const round = roundMesh(15, 20);
      const curved = shellBody(round, { thicknessMm: 2, side: "inside", openFaces: [face([15, 0, 10], [1, 0, 0])] });
      assert(!curved.ok && curved.message.includes("curved"), "a cylinder wall facet cannot be the opening");
      const missing = shellBody(box, { thicknessMm: 2, side: "inside", openFaces: [face([300, 300, 300], [0, 0, 1])] });
      assert(!missing.ok, "a face that is not on the body is reported");
      assert(!shellBody(box, { thicknessMm: 0, side: "inside", openFaces: [] }).ok, "zero thickness is refused");
    }
  },
  {
    name: "Draft tilts every picked wall about the neutral plane: the measured lean is the angle and the volume follows the taper",
    run: () => {
      const box = boxMesh(40, 30, 20);
      const alpha = 5; const k = Math.tan((alpha * Math.PI) / 180);
      const walls = [face([40, 15, 10], [1, 0, 0]), face([0, 15, 10], [-1, 0, 0]), face([20, 30, 10], [0, 1, 0]), face([20, 0, 10], [0, -1, 0])];
      const drafted = okMesh(draftFaces(box, { angleDeg: alpha, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: walls }), "four-wall draft");
      near(volumeOf(drafted), 40 * 30 * 20 - (40 + 30) * k * 400 + (4 / 3) * k * k * 8000, 1e-3, "volume of the tapered box");
      const analysis = analyzeFaces(drafted);
      assert(typeof analysis !== "string", "the drafted body is analysable");
      if (typeof analysis === "string") return;
      const leaning = analysis.regions.filter((region) => Math.abs(region.normal[2]) > 1e-6 && Math.abs(region.normal[2]) < 0.99);
      equal(leaning.length, 4, "four walls now lean");
      for (const region of leaning) near(Math.asin(region.normal[2]) * 180 / Math.PI, alpha, 1e-6, "each wall leans exactly 5 degrees from the pull direction");
      const sizes = solidMetrics(drafted.positionsMm, drafted.indices).sizeMm;
      near(sizes[0], 40, 1e-6, "the base on the neutral plane keeps its 40 mm width");
      const planes = planesOf(drafted);
      assert(hasPlane(planes, [0, 0, 1], 20) && hasPlane(planes, [0, 0, -1], 0), "the top and bottom did not move or turn");
      const topRegion = analysis.regions.find((region) => region.normal[2] > 0.999)!;
      near(topRegion.areaMm2, (40 - 40 * k) * (30 - 40 * k), 1e-3, "the top face shrank by the taper on every side");
    }
  },
  {
    name: "Draft of a single picked wall moves only that wall; a negative angle leans it the other way; a neutral plane in the middle pivots it",
    run: () => {
      const box = boxMesh(40, 30, 20);
      const k = Math.tan((5 * Math.PI) / 180);
      const one = okMesh(draftFaces(box, { angleDeg: 5, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([40, 15, 10], [1, 0, 0])] }), "one-wall draft");
      near(volumeOf(one), 40 * 30 * 20 - 0.5 * 20 * 20 * k * 30, 1e-3, "one wall tapered");
      const planes = planesOf(one);
      for (const [normal, offset] of [[[-1, 0, 0], 0], [[0, 1, 0], 30], [[0, -1, 0], 0], [[0, 0, 1], 20], [[0, 0, -1], 0]] as const) assert(hasPlane(planes, normal, offset), `the ${normal.join(",")} face is untouched`);
      const outward = okMesh(draftFaces(box, { angleDeg: -5, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([40, 15, 10], [1, 0, 0])] }), "negative draft");
      near(volumeOf(outward), 40 * 30 * 20 + 0.5 * 20 * 20 * k * 30, 1e-3, "a negative angle widens the body toward the top");
      const middle = okMesh(draftFaces(box, { angleDeg: 5, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 10], faces: [face([40, 15, 10], [1, 0, 0])] }), "pivot at mid height");
      near(volumeOf(middle), 40 * 30 * 20, 1e-3, "pivoting at mid height adds as much below as it removes above");
      const down = okMesh(draftFaces(box, { angleDeg: 5, pullDirection: [0, 0, -1], neutralPointMm: [0, 0, 20], faces: [face([40, 15, 10], [1, 0, 0])] }), "pull downward");
      near(volumeOf(down), 40 * 30 * 20 - 0.5 * 20 * 20 * k * 30, 1e-3, "pulling the other way narrows the body toward the bottom");
    }
  },
  {
    name: "Draft reports the picked faces it cannot lean (a cap, a curved facet, a missing face) and still drafts the rest",
    run: () => {
      const box = boxMesh(40, 30, 20);
      const mixed = draftFaces(box, { angleDeg: 4, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([40, 15, 10], [1, 0, 0]), face([20, 15, 20], [0, 0, 1]), face([900, 0, 0], [1, 0, 0])] });
      const result = okMesh(mixed, "draft with an unusable cap");
      assert(mixed.ok && mixed.skipped.length === 2, "two of the three picks were reported");
      if (mixed.ok) {
        assert(mixed.skipped.some((skip) => skip.reason.includes("square to the pull")), "the cap is named as square to the pull direction");
        assert(mixed.skipped.some((skip) => skip.reason.includes("gone")), "the missing face is named");
      }
      assert(volumeOf(result) < 40 * 30 * 20, "the usable wall was still drafted");
      const round = draftFaces(roundMesh(15, 20), { angleDeg: 4, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([15, 0, 10], [1, 0, 0])] });
      assert(!round.ok && round.message.includes("curved"), "a cylinder wall alone cannot be drafted and the reason is given");
      assert(!draftFaces(box, { angleDeg: 0, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([40, 15, 10], [1, 0, 0])] }).ok, "a zero angle is refused");
      const tall = draftFaces(boxMesh(4, 4, 200), { angleDeg: 40, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([4, 2, 100], [1, 0, 0]), face([0, 2, 100], [-1, 0, 0])] });
      assert(!tall.ok, "a draft that would run the walls through each other is refused");
    }
  },
  {
    name: "Draft works on a slanted wall of an L-shaped body and keeps the closed manifold",
    run: () => {
      const outline: Point[] = [[0, 0], [40, 0], [40, 15], [20, 15], [20, 30], [0, 30]];
      const l = extrudeMesh(outline, 12);
      const result = okMesh(draftFaces(l, { angleDeg: 3, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [face([20, 22, 6], [1, 0, 0]), face([30, 15, 6], [0, 1, 0])] }), "L draft");
      const analysis = analyzeFaces(result);
      assert(typeof analysis !== "string", "analysable");
      if (typeof analysis === "string") return;
      equal(analysis.regions.filter((region) => Math.abs(region.normal[2]) > 1e-6 && Math.abs(region.normal[2]) < 0.99).length, 2, "exactly the two picked walls lean");
      assert(volumeOf(result) < volumeOf(l), "material was removed");
    }
  },
  {
    name: "Offset region moves only the chosen faces: a wall of an L-shaped body and the top of a box",
    run: () => {
      const outline: Point[] = [[0, 0], [40, 0], [40, 15], [20, 15], [20, 30], [0, 30]];
      const l = extrudeMesh(outline, 12);
      const before = planesOf(l);
      const wallArea = 15 * 12;
      const moved = okMesh(offsetRegion(l, { distanceMm: 3, faces: [face([20, 22, 6], [1, 0, 0])] }), "offset notch wall");
      near(volumeOf(moved), volumeOf(l) + wallArea * 3, 1e-3, "pushing the wall out 3 mm adds the wall's area times 3");
      const after = planesOf(moved);
      assert(hasPlane(after, [1, 0, 0], 23), "the chosen wall is now at x = 23");
      assert(!hasPlane(after, [1, 0, 0], 20), "and no longer at x = 20");
      let unchanged = 0;
      for (const plane of before) if (!(Math.abs(plane.normal[0]! - 1) < 1e-9 && Math.abs(plane.offset - 20) < 1e-9) && hasPlane(after, plane.normal, plane.offset)) unchanged += 1;
      equal(unchanged, before.length - 1, "every other face is on exactly the plane it was on");
      const inward = okMesh(offsetRegion(l, { distanceMm: -4, faces: [face([20, 22, 6], [1, 0, 0])] }), "offset notch wall inward");
      near(volumeOf(inward), volumeOf(l) - wallArea * 4, 1e-3, "pulling it in 4 mm takes the same slab away");
      const box = boxMesh(40, 30, 20);
      const taller = okMesh(offsetRegion(box, { distanceMm: 5, faces: [face([20, 15, 20], [0, 0, 1])] }), "raise the top");
      near(volumeOf(taller), 40 * 30 * 25, 1e-3, "the top face offset 5 mm makes the box 25 tall");
      const two = okMesh(offsetRegion(box, { distanceMm: 2, faces: [face([20, 15, 20], [0, 0, 1]), face([40, 15, 10], [1, 0, 0])] }), "offset two faces");
      near(volumeOf(two), 42 * 30 * 22, 1e-3, "two faces offset together");
    }
  },
  {
    name: "Offset region refuses a curved facet, a face pushed through the body and a zero distance",
    run: () => {
      const box = boxMesh(40, 30, 20);
      const curved = offsetRegion(roundMesh(15, 20), { distanceMm: 2, faces: [face([15, 0, 10], [1, 0, 0])] });
      assert(!curved.ok && curved.message.includes("curved"), "one facet of a cylinder wall cannot be offset alone");
      const through = offsetRegion(box, { distanceMm: -25, faces: [face([20, 15, 20], [0, 0, 1])] });
      assert(!through.ok, "a top pulled 25 mm down through a 20 mm body is refused");
      assert(!offsetRegion(box, { distanceMm: 0, faces: [face([20, 15, 20], [0, 0, 1])] }).ok, "zero distance changes nothing and is refused");
    }
  },
  {
    name: "Replace face puts the face on the plane: a tilted plane, the plane of another face, and refusals",
    run: () => {
      const box = boxMesh(40, 30, 10);
      const slope = 0.1; const normal = [slope, 0, 1] as const; const length = Math.hypot(...normal);
      const tilted = okMesh(replaceFaces(box, { faces: [face([20, 15, 10], [0, 0, 1])], toPlane: face([0, 0, 10], [normal[0] / length, normal[1] / length, normal[2] / length]) }), "replace top by a tilted plane");
      near(volumeOf(tilted), 40 * 30 * (10 - slope * 20), 1e-3, "the sloped top has the average height 8");
      for (let vertex = 0; vertex < tilted.positionsMm.length; vertex += 3) {
        const z = tilted.positionsMm[vertex + 2]!;
        if (z > 1) near(slope * tilted.positionsMm[vertex]! + z, 10, 1e-6, "every top vertex lies on the plane x*0.1 + z = 10");
      }
      const planes = planesOf(tilted);
      assert(hasPlane(planes, [0, 0, -1], 0) && hasPlane(planes, [1, 0, 0], 40) && hasPlane(planes, [0, -1, 0], 0), "the other faces keep their planes");
      // A wedge whose flat top is replaced by the plane of its slope.
      const wedge = extrudeMesh([[0, 0], [40, 0], [40, 20], [20, 20], [0, 10]], 30, "xz");
      const wedgeAnalysis = analyzeFaces(wedge);
      assert(typeof wedgeAnalysis !== "string", "the wedge is analysable");
      if (typeof wedgeAnalysis === "string") return;
      const slopeRegion = wedgeAnalysis.regions.find((region) => Math.abs(region.normal[2]) > 0.1 && Math.abs(region.normal[2]) < 0.99)!;
      const flatTop = wedgeAnalysis.regions.find((region) => region.normal[2] > 0.999 && region.offset > 19)!;
      const joined = okMesh(replaceFaces(wedge, { faces: [face(flatTop.centroidMm, flatTop.normal)], toFace: face(slopeRegion.centroidMm, slopeRegion.normal) }), "replace the flat top by the slope's plane");
      near(volumeOf(joined), 30 * (400 + 400), 1e-3, "the whole top is now one slope from z 10 to z 30");
      assert(!replaceFaces(box, { faces: [face([20, 15, 10], [0, 0, 1])], toPlane: face([0, 0, 10], [0, 0, 1]) }).ok, "a face already on the plane is reported");
      assert(!replaceFaces(box, { faces: [face([20, 15, 10], [0, 0, 1])], toPlane: face([0, 0, 10], [1, 0, 0]) }).ok, "a plane square to the face is refused");
      const stepped = booleanMeshes({ positionsMm: box.positionsMm, indices: box.indices }, { positionsMm: boxMesh(20, 30, 15).positionsMm.map((value, index) => index % 3 === 2 ? value + 5 : value), indices: boxMesh(20, 30, 15).indices }, "join");
      assert(stepped.ok, "a stepped body can be built");
      if (!stepped.ok) return;
      const vanishing = replaceFaces({ positionsMm: stepped.value.positionsMm, indices: stepped.value.indices }, { faces: [face([10, 15, 20], [0, 0, 1])], toPlane: face([0, 0, 10], [0, 0, 1]) });
      assert(!vanishing.ok, "pressing the high step down to the low one would delete the wall between them, which the mesh cannot represent, so it is refused");
    }
  }
];
