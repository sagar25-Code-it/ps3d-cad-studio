import { combineGeneralBodies } from "../apps/studio-web/src/general-modeling.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, line, meshStats, rect, solidOf } from "./pipeline-kit.js";

/** Washer volume: a rectangle w by h whose near edge is r1 from the axis, revolved fully. */
const washer = (r1: number, r2: number, height: number): number => Math.PI * (r2 * r2 - r1 * r1) * height;

export const pipelineGeometryTests: readonly TestCase[] = [
  {
    name: "P03 a profile on the negative-X side revolves into a solid facing outward, the mirror image of the same profile on the positive side",
    run: async () => {
      const expected = washer(5, 15, 20);
      const positive = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", 10, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 })));
      near(positive.volume, expected, expected * 0.01, "the positive-side rectangle keeps its volume (the classic path is unchanged)");
      const negative = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", -10, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 })));
      near(negative.volume, expected, expected * 0.01, "the same rectangle left of the axis has the same positive volume (it was -12546)");
      near(negative.lo[0], -15, 0.01, "and the same reach on the other side");
      // A torus (circle left of the axis) and a profile touching the axis from the left.
      const torus = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [circ("c", -20, 0, 5)]).sketch, "revolve", { valueMm: 360 })));
      near(torus.volume, 2 * Math.PI * Math.PI * 20 * 25, 2 * Math.PI * Math.PI * 20 * 25 * 0.01, "a torus on the negative side has positive volume");
      const touching = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", -5, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 })));
      near(touching.volume, Math.PI * 100 * 20, Math.PI * 100 * 20 * 0.01, "a rectangle touching the axis from the left is a solid cylinder, not a negative one");
      // The other datum planes and a partial sweep.
      for (const plane of ["datum:xz", "datum:yz"] as const) {
        const onPlane = meshStats(solidOf(await buildSolid(committedSketch(plane, [rect("r", -10, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 })));
        near(onPlane.volume, expected, expected * 0.01, `${plane}: positive volume on the negative side`);
      }
      const quarterLeft = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", -10, 10, 10, 20)]).sketch, "revolve", { valueMm: 90 })));
      const quarterRight = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", 10, 10, 10, 20)]).sketch, "revolve", { valueMm: 90 })));
      near(quarterLeft.volume, quarterRight.volume, quarterRight.volume * 0.01, "a quarter turn is the same size on either side");
      near(quarterLeft.hi[2], quarterRight.hi[2], 0.01, "and both sweep toward the sketch plane's normal side");
      // The old failure: the solid was refused as a cut or join tool ("no positive volume").
      const base = solidOf(await buildSolid(committedSketch("datum:xy", [rect("b", 0, 0, 100, 100)]).sketch, "extrude", { valueMm: 40 }));
      const tool = solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", -10, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 }));
      const cut = await combineGeneralBodies({ target: base, tool, mode: "cut", bodyId: base.id, name: base.name });
      assert(cut.ok, `the left-side revolve works as a Boolean tool: ${cut.ok ? "" : cut.message}`);
    }
  },
  {
    name: "P04 a revolve turns about the axis it is given: a sketch line, a construction line, the sketch X axis or a model edge",
    run: async () => {
      const ring = washer(5, 15, 20);
      // The audit repro: profile at x 35..45, construction line at x = 30.
      const withLine = committedSketch("datum:xy", [rect("r", 40, 10, 10, 20), line("cl", [30, -10], [30, 40], true)]).sketch;
      const about = meshStats(solidOf(await buildSolid(withLine, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } })));
      near(about.volume, ring, ring * 0.01, "revolved about the construction line: a ring of radii 5 to 15");
      near(about.lo[0], 15, 0.01, "centred on x = 30 (reaching x = 15)");
      near(about.hi[0], 45, 0.01, "and x = 45");
      near(about.lo[1], 0, 0.01, "along the profile's own height");
      const ignored = meshStats(solidOf(await buildSolid(withLine, "revolve", { valueMm: 360 })));
      assert(Math.abs(ignored.volume - ring) > ring, "without an axis choice it still turns about the sketch Y axis (a much larger solid)");
      // A line that is part of the profile's own outline, drawn left of the profile.
      const leftOfIt = committedSketch("datum:xy", [rect("r", 40, 10, 10, 20), line("cl", [20, 0], [20, 20], false)]).sketch;
      const second = meshStats(solidOf(await buildSolid(leftOfIt, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } })));
      near(second.volume, washer(15, 25, 20), washer(15, 25, 20) * 0.01, "a plain (non-construction) line works as the axis too");
      // The sketch X axis.
      const xAxis = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", 10, 10, 10, 10)]).sketch, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-axis", axis: "x" } })));
      near(xAxis.volume, washer(5, 15, 10), washer(5, 15, 10) * 0.01, "about the sketch X axis: a ring of radii 5 to 15, 10 long");
      near(xAxis.lo[1], -15, 0.01, "it spreads in Y, not in X");
      near(xAxis.lo[0], 5, 0.01, "and stays along the axis in X");
      // An inclined line.
      const slanted = committedSketch("datum:xy", [rect("r", 30, 0, 4, 4), line("cl", [0, 0], [10, 10], true)]).sketch;
      const incl = await buildSolid(slanted, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } });
      assert(incl.ok, `an inclined axis line is accepted: ${incl.ok ? "" : incl.message}`);
      // A model edge lying in the sketch plane (here the world X axis).
      const edge = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", 10, 10, 10, 10)]).sketch, "revolve", { valueMm: 360, revolveAxis: { kind: "model-edge", bodyId: "general-body:base", startMm: [0, 0, 0], endMm: [50, 0, 0] } })));
      near(edge.volume, washer(5, 15, 10), washer(5, 15, 10) * 0.01, "a model edge along world X gives the same ring");
      const upright = await buildSolid(committedSketch("datum:xy", [rect("r", 10, 10, 10, 10)]).sketch, "revolve", { valueMm: 360, revolveAxis: { kind: "model-edge", bodyId: "general-body:base", startMm: [0, 0, 5], endMm: [50, 0, 5] } });
      assert(!upright.ok && /does not lie in the sketch plane/u.test(upright.message), `an edge off the sketch plane is explained: ${upright.ok ? "" : upright.message}`);
      // Errors name the axis.
      const crossing = await buildSolid(committedSketch("datum:xy", [rect("r", 40, 10, 40, 20), line("cl", [40, -10], [40, 40], true)]).sketch, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } });
      assert(!crossing.ok && /crosses the revolve axis \(the construction line cl\)/u.test(crossing.message), `a profile across the chosen axis names it: ${crossing.ok ? "" : crossing.message}`);
      const gone = await buildSolid(withLine, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:missing" } });
      assert(!gone.ok && /no longer in its sketch/u.test(gone.message), `a deleted axis line is reported: ${gone.ok ? "" : gone.message}`);
      // Symmetric and thin variants follow the axis.
      const symmetric = meshStats(solidOf(await buildSolid(withLine, "revolve", { valueMm: 180, direction: "symmetric", revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } })));
      near(symmetric.volume, ring / 2, ring * 0.02, "a symmetric half turn about the chosen line is half the ring");
      const thin = meshStats(solidOf(await buildSolid(withLine, "revolve", { valueMm: 360, thinWallMm: 1, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } })));
      assert(thin.volume > 0 && thin.volume < ring * 0.5, "a thin-walled revolve about the chosen line is a hollow shell");
      equal(thin.lo[0] < 16, true, "centred on the chosen line");
    }
  }
];
