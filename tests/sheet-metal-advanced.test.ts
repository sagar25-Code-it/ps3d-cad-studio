import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { bentStripSection } from "../packages/workbench-geometry/src/sheet-metal.js";
import { attachMiterFlange, miterChainBetween, miterChainOf, mitreTangent } from "../packages/workbench-geometry/src/sheet-miter.js";
import { sheetFrameOf, type SheetFrame } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { jogProfile, jogSheetMesh } from "../packages/workbench-geometry/src/sheet-jog.js";
import { attachEdgeFlange } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { assert, near, type TestCase } from "./test-kit.js";

type Mesh = { positionsMm: number[]; indices: number[] };
type Pt = readonly [number, number];

function prism(polygon: readonly Pt[], thicknessMm: number): Mesh {
  const mesh = tessellateExtrude(polygon, thicknessMm, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

const rectangle = (width: number, height: number): readonly Pt[] => [[0, 0], [width, 0], [width, height], [0, height]];

/** Area and the first moment about the outward axis of a flange cross-section: what one unit of mitre shift adds to the volume. */
function sectionArea(radius: number, thickness: number, length: number, angle: number): { readonly area: number; readonly moment: number } {
  const polygon = bentStripSection({ legMm: 0, flangeLengthMm: length, angleDeg: angle, innerRadiusMm: radius, thicknessMm: thickness, widthMm: 1 });
  let twice = 0;
  let momentSix = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    twice += cross;
    momentSix += (a[0] + b[0]) * cross;
  }
  const sign = twice < 0 ? -1 : 1;
  return { area: Math.abs(twice) / 2, moment: sign * momentSix / 6 };
}

/** Every edge of the frame in running order from edge 0 around its own loop. */
function loopFrom(frame: SheetFrame, first: number): readonly number[] {
  const last = frame.edges.find((edge) => edge.index !== first && Math.hypot(edge.endMm[0] - frame.edges[first]!.startMm[0], edge.endMm[1] - frame.edges[first]!.startMm[1], edge.endMm[2] - frame.edges[first]!.startMm[2]) < 1e-6);
  const chain = miterChainBetween(frame, first, last!.index);
  assert(chain !== undefined, "the loop of the plate can be walked");
  return chain;
}

function expectSolid(mesh: { positionsMm: readonly number[]; indices: readonly number[] }, label: string): ReturnType<typeof solidMetrics> {
  assert(isClosedAndOriented(mesh.indices), `${label}: every edge is used once each way (closed, consistently wound)`);
  const metrics = solidMetrics(mesh.positionsMm, mesh.indices);
  assert(metrics.outward, `${label}: the triangles wind outward`);
  return metrics;
}

export const sheetMetalAdvancedTests: readonly TestCase[] = [
  {
    name: "a mitre joint between two edges is the corner's bisector: tan(turn / 2), positive on a convex corner",
    run: () => {
      const frame = sheetFrameOf(prism(rectangle(60, 40), 2), [0, 0, 1])!;
      const loop = loopFrom(frame, 0);
      assert(loop.length === 4, "a rectangle has four edges");
      for (let i = 0; i < 4; i += 1) near(mitreTangent(frame, loop[i]!, loop[(i + 1) % 4]!)!, 1, 1e-9, `corner ${i} turns 90° so tan(45°) = 1`);
      assert(mitreTangent(frame, loop[0]!, loop[2]!) === undefined, "edges that do not meet have no mitre");
      const chain = miterChainOf(frame, loop);
      assert(chain.ok && chain.closed && chain.tangents.length === 4, "the four edges in running order form a closed chain");
      const open = miterChainOf(frame, loop.slice(0, 3));
      assert(open.ok && !open.closed && open.tangents.length === 2, "three edges form an open chain with two mitred corners");
      assert(!miterChainOf(frame, [loop[0]!, loop[2]!]).ok, "edges that do not run into each other cannot be one flange");
      assert(!miterChainOf(frame, [loop[0]!, loop[0]!]).ok, "an edge cannot be listed twice");
    }
  },
  {
    name: "a closed miter flange round a rectangular plate is one closed outward solid whose volume is plate + 4 strips + 8 mitre wedges",
    run: () => {
      const plate = prism(rectangle(60, 40), 2);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const loop = loopFrom(frame, 0);
      const result = attachMiterFlange(plate, plate, [0, 0, 1], { edgeIndices: loop, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90 });
      assert(result.ok, `miter flange builds: ${result.ok ? "" : result.message}`);
      const metrics = expectSolid(result, "closed rim");
      const { area, moment } = sectionArea(2, 2, 15, 90);
      // Each of the 4 corners adds one wedge at the end of one flange and one at the start of the next: 2 × (tan 45° × moment).
      const expected = 60 * 40 * 2 + area * (2 * 60 + 2 * 40) + 8 * moment;
      near(metrics.volumeMm3, expected, expected * 1e-6, "volume = plate + strips + mitre wedges");
      // The rim rises 15 mm above the bend: the mitre must not leave a hole or spike at the corner.
      assert(metrics.boundsMm.max[2] > 2 + 2 + 15 - 1e-6, "the flange rises to its full height");
      near(metrics.boundsMm.min[0], -4, 1e-6, "the rim's outer face sits one bend radius + thickness outside the plate edge");
      near(metrics.boundsMm.max[0], 64, 1e-6, "the rim is symmetric on the far side");
    }
  },
  {
    name: "an open miter flange of two edges mitres the shared corner and ends square at the free ends",
    run: () => {
      const plate = prism(rectangle(60, 40), 2);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const loop = loopFrom(frame, 0);
      const result = attachMiterFlange(plate, plate, [0, 0, 1], { edgeIndices: loop.slice(0, 2), innerRadiusMm: 1, flangeLengthMm: 10, angleDeg: 90 });
      assert(result.ok, `builds: ${result.ok ? "" : result.message}`);
      const metrics = expectSolid(result, "two-edge chain");
      const { area, moment } = sectionArea(1, 2, 10, 90);
      const lengths = frame.edges[loop[0]!]!.lengthMm + frame.edges[loop[1]!]!.lengthMm;
      near(metrics.volumeMm3, 60 * 40 * 2 + area * lengths + 2 * moment, 1e-3, "volume = plate + 2 strips + one mitred corner");
    }
  },
  {
    name: "a miter flange round a regular hexagon uses 30° half-turns, and a bend other than 90° still closes",
    run: () => {
      const hexagon: Pt[] = Array.from({ length: 6 }, (_, i) => [30 * Math.cos(i * Math.PI / 3), 30 * Math.sin(i * Math.PI / 3)] as const);
      const plate = prism(hexagon, 3);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const loop = loopFrom(frame, 0);
      near(mitreTangent(frame, loop[0]!, loop[1]!)!, Math.tan(Math.PI / 6), 1e-9, "a 60° turn has tan(30°)");
      for (const angle of [90, 60, 120]) {
        const result = attachMiterFlange(plate, plate, [0, 0, 1], { edgeIndices: loop, innerRadiusMm: 3, flangeLengthMm: 8, angleDeg: angle });
        assert(result.ok, `${angle}° rim builds: ${result.ok ? "" : result.message}`);
        const metrics = expectSolid(result, `${angle}° hexagon rim`);
        const { area, moment } = sectionArea(3, 3, 8, angle);
        const perimeter = frame.edges.reduce((sum, edge) => sum + edge.lengthMm, 0);
        const plateVolume = solidMetrics(plate.positionsMm, plate.indices).volumeMm3;
        near(metrics.volumeMm3, plateVolume + area * perimeter + 2 * 6 * Math.tan(Math.PI / 6) * moment, metrics.volumeMm3 * 1e-6, `${angle}° rim volume`);
      }
    }
  },
  {
    name: "a miter flange across a concave corner shortens both flanges and still closes",
    run: () => {
      // An L-shaped plate: the notch corner at (30, 20) is the concave one.
      const plate = prism([[0, 0], [60, 0], [60, 20], [30, 20], [30, 40], [0, 40]], 2);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const loop = loopFrom(frame, 0);
      assert(loop.length === 6, "the L has six edges");
      const tangents = miterChainOf(frame, loop);
      assert(tangents.ok && tangents.closed, "the whole outline is a closed chain");
      if (!tangents.ok) return;
      assert(tangents.tangents.filter((value) => value < 0).length === 1, "exactly one corner is concave");
      const result = attachMiterFlange(plate, plate, [0, 0, 1], { edgeIndices: loop, innerRadiusMm: 1, flangeLengthMm: 6, angleDeg: 90 });
      assert(result.ok, `builds: ${result.ok ? "" : result.message}`);
      const metrics = expectSolid(result, "L-shaped rim");
      const { area, moment } = sectionArea(1, 2, 6, 90);
      const perimeter = frame.edges.reduce((sum, edge) => sum + edge.lengthMm, 0);
      const plateVolume = solidMetrics(plate.positionsMm, plate.indices).volumeMm3;
      const signed = tangents.tangents.reduce((sum, value) => sum + value, 0);
      near(metrics.volumeMm3, plateVolume + area * perimeter + 2 * signed * moment, metrics.volumeMm3 * 1e-6, "five convex corners add wedges, the concave one removes one");
    }
  },
  {
    name: "a mitre that would cut a short edge's flange away is refused",
    run: () => {
      const plate = prism(rectangle(60, 3), 2);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const loop = loopFrom(frame, 0);
      const result = attachMiterFlange(plate, plate, [0, 0, 1], { edgeIndices: loop, innerRadiusMm: 1, flangeLengthMm: 20, angleDeg: 90 });
      // The 3 mm ends run on past the corners but are shortened nowhere (convex), so the rim is fine; a notch is what shortens.
      assert(result.ok, "convex corners only lengthen the flanges");
      const notched = prism([[0, 0], [60, 0], [60, 40], [32, 40], [32, 4], [28, 4], [28, 40], [0, 40]], 2);
      const notchFrame = sheetFrameOf(notched, [0, 0, 1])!;
      const outline = loopFrom(notchFrame, 0);
      const refused = attachMiterFlange(notched, notched, [0, 0, 1], { edgeIndices: outline, innerRadiusMm: 1, flangeLengthMm: 30, angleDeg: 90 });
      assert(!refused.ok && /mitre|short|away/iu.test(refused.message), `a 4 mm wide slot cannot take a 30 mm mitred flange: ${refused.ok ? "built" : refused.message}`);
    }
  },
  {
    name: "a jog's centre line rises by the offset: two bends plus a sloping web, and a step too small for the bends is refused",
    run: () => {
      const made = jogProfile({ offsetMm: 10, angleDeg: 45, innerRadiusMm: 2 }, 2);
      assert(made.ok, "a 10 mm step at 45° with R2 in 2 mm sheet is possible");
      if (!made.ok) return;
      const p = made.profile;
      const rise = 2 * p.centreRadiusMm * (1 - Math.cos(p.alphaRad)) + p.webMm * Math.sin(p.alphaRad);
      near(rise, 10, 1e-9, "bends + web rise exactly the offset");
      near(p.zoneMm, 2 * 3 * (Math.PI / 4) + p.webMm, 1e-9, "zone = two centre-line arcs + web");
      assert(p.runMm < p.zoneMm, "the jog covers less ground than the sheet it uses");
      assert(!jogProfile({ offsetMm: 0.5, angleDeg: 45, innerRadiusMm: 2 }, 2).ok, "0.5 mm is less than the bends alone rise");
      assert(!jogProfile({ offsetMm: 10, angleDeg: 90, innerRadiusMm: 2 }, 2).ok, "a jog angle of 90° is refused");
      const down = jogProfile({ offsetMm: -10, angleDeg: 45, innerRadiusMm: 2 }, 2);
      assert(down.ok && down.profile.sign === -1, "a negative offset steps down");
    }
  },
  {
    name: "a jog in a plate is one closed outward solid, steps the far side up by the offset, and keeps the plate's volume",
    run: () => {
      const plate = prism(rectangle(100, 40), 2);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const edge = frame.edges.find((candidate) => candidate.outward[0] < -0.5)!;
      for (const offset of [10, -10]) {
        const result = jogSheetMesh(plate, plate, [0, 0, 1], { edgeIndex: edge.index, positionMm: 30, offsetMm: offset, angleDeg: 45, innerRadiusMm: 2 });
        assert(result.ok, `jog builds: ${result.ok ? "" : result.message}`);
        if (!result.ok) return;
        const metrics = expectSolid(result, `jog ${offset}`);
        near(metrics.volumeMm3, 100 * 40 * 2, 100 * 40 * 2 * 0.006, "the centre line keeps its length, so the volume is the plate's");
        const lowest = offset > 0 ? 0 : -10;
        near(metrics.boundsMm.min[2], lowest, 1e-6, "near side stays where it was or steps down");
        near(metrics.boundsMm.max[2], offset > 0 ? 12 : 2, 1e-6, "the far side is the offset higher or lower");
        near(metrics.boundsMm.max[0], 100 + result.profile.runMm - result.profile.zoneMm, 1e-6, "the far end comes in by the developed length minus the ground covered");
        near(metrics.boundsMm.min[0], 0, 1e-9, "the near edge does not move");
        near(metrics.sizeMm[1], 40, 1e-9, "the width is untouched");
      }
    }
  },
  {
    name: "a jog is refused when the sheet is too short for it or a flange stands in the way",
    run: () => {
      const plate = prism(rectangle(100, 40), 2);
      const frame = sheetFrameOf(plate, [0, 0, 1])!;
      const edge = frame.edges.find((candidate) => candidate.outward[0] < -0.5)!;
      const tooFar = jogSheetMesh(plate, plate, [0, 0, 1], { edgeIndex: edge.index, positionMm: 95, offsetMm: 10, angleDeg: 45, innerRadiusMm: 2 });
      assert(!tooFar.ok && /sheet only reaches/u.test(tooFar.message), `a jog past the end is refused: ${tooFar.ok ? "built" : tooFar.message}`);
      // A tall flange on one of the long sides runs across the strip the jog would bend.
      const side = frame.edges.find((candidate) => candidate.outward[1] < -0.5)!;
      const flanged = attachEdgeFlange(plate, plate, [0, 0, 1], { edgeIndex: side.index, innerRadiusMm: 2, flangeLengthMm: 20, angleDeg: 90 });
      assert(flanged.ok, "the flange builds");
      if (!flanged.ok) return;
      const blocked = jogSheetMesh(flanged, plate, [0, 0, 1], { edgeIndex: edge.index, positionMm: 30, offsetMm: 10, angleDeg: 45, innerRadiusMm: 2 });
      assert(!blocked.ok && /tall stands in the strip/u.test(blocked.message), `a flange across the jog is refused: ${blocked.ok ? "built" : blocked.message}`);
      // A flange on the far end moves with the far side instead.
      const far = frame.edges.find((candidate) => candidate.outward[0] > 0.5)!;
      const endFlange = attachEdgeFlange(plate, plate, [0, 0, 1], { edgeIndex: far.index, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90 });
      assert(endFlange.ok, "the end flange builds");
      if (!endFlange.ok) return;
      const carried = jogSheetMesh(endFlange, plate, [0, 0, 1], { edgeIndex: edge.index, positionMm: 30, offsetMm: 10, angleDeg: 45, innerRadiusMm: 2 });
      assert(carried.ok, `a flange beyond the jog rides along: ${carried.ok ? "" : carried.message}`);
      if (!carried.ok) return;
      const before = solidMetrics(endFlange.positionsMm, endFlange.indices);
      const after = expectSolid(carried, "jogged plate with end flange");
      near(after.boundsMm.max[2] - before.boundsMm.max[2], 10, 1e-6, "the end flange is carried up with the far side");
    }
  }
];
