import { describeYzConvention } from "../packages/workbench-core/src/index.js";
import { DATUM_PLANE_AXES, DATUM_PLANE_NORMAL, describeSketchAxes, sketchToWorld, worldToSketch } from "../apps/studio-web/src/sketch-world.js";
import { adaptiveFacetCount } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, meshStats, rect, solidOf } from "./pipeline-kit.js";

const WORLD: Readonly<Record<string, readonly [number, number, number]>> = {
  "world +X": [1, 0, 0], "world -X": [-1, 0, 0], "world +Y": [0, 1, 0], "world -Y": [0, -1, 0], "world +Z": [0, 0, 1], "world -Z": [0, 0, -1]
};

export const pipelineAxesTests: readonly TestCase[] = [
  {
    name: "P22 the documented sketch axes of every datum plane (and of both Right-plane conventions) match where a sketch point really lands, and a legacy YZ revolve turns about world Y",
    run: async () => {
      const cases = [
        { plane: "datum:xy", convention: undefined, documented: DATUM_PLANE_AXES.xy, key: "xy" },
        { plane: "datum:xz", convention: undefined, documented: DATUM_PLANE_AXES.xz, key: "xz" },
        { plane: "datum:yz", convention: "legacy", documented: DATUM_PLANE_AXES.yz, key: "yz" },
        { plane: "datum:yz", convention: "z-up", documented: describeYzConvention(true), key: "yz" }
      ] as const;
      for (const { plane, convention, documented, key } of cases) {
        const sketch = committedSketch(plane, [rect("r", 0, 0, 10, 10)], convention === undefined ? {} : { convention }).sketch.sketch;
        const label = `${plane} ${convention ?? ""}`;
        const origin = sketchToWorld(sketch, 0, 0);
        const x = sketchToWorld(sketch, 1, 0);
        const y = sketchToWorld(sketch, 0, 1);
        assert(JSON.stringify([x[0] - origin[0], x[1] - origin[1], x[2] - origin[2]]) === JSON.stringify(WORLD[documented.sketchX]), `${label}: sketch X is ${documented.sketchX}`);
        assert(JSON.stringify([y[0] - origin[0], y[1] - origin[1], y[2] - origin[2]]) === JSON.stringify(WORLD[documented.sketchY]), `${label}: sketch Y is ${documented.sketchY}`);
        assert(JSON.stringify(DATUM_PLANE_NORMAL[key]) === JSON.stringify(WORLD[documented.normal]), `${label}: the sketch faces ${documented.normal}`);
        const back = worldToSketch(sketch, sketchToWorld(sketch, 7, -3, 2));
        near(back.u, 7, 1e-9, `${label}: world to sketch returns u`);
        near(back.v, -3, 1e-9, `${label}: and v`);
        near(back.w, 2, 1e-9, `${label}: and the distance off the plane`);
      }
      const legacyYz = committedSketch("datum:yz", [rect("r", 0, 0, 10, 10)], { convention: "legacy" }).sketch.sketch;
      const zupYz = committedSketch("datum:yz", [rect("r", 0, 0, 10, 10)]).sketch.sketch;
      assert(legacyYz.planeConvention === undefined && zupYz.planeConvention === "z-up", "a new Right-plane sketch is marked z-up; a legacy one carries no marker");
      assert(/Y axis along world \+Y/u.test(describeSketchAxes(legacyYz)) && /X axis runs along world -Z/u.test(describeSketchAxes(legacyYz)), "the legacy YZ plane is described in words the UI can show");
      assert(/Y axis along world \+Z/u.test(describeSketchAxes(zupYz)) && /X axis runs along world \+Y/u.test(describeSketchAxes(zupYz)), "and the Z-up one in its own words");
      // A profile drawn upright on a legacy YZ sketch revolves about the sketch Y axis, which is world Y: the solid stands along Y.
      const yz = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", [rect("r", 10, 10, 10, 20)], { convention: "legacy" }).sketch, "revolve", { valueMm: 360 })));
      near(yz.lo[1], 0, 0.01, "the legacy YZ revolve starts at y = 0");
      near(yz.hi[1], 20, 0.01, "and rises 20 mm along world Y (the sketch Y)");
      near(yz.hi[0], 15, 0.01, "spreading in X");
      near(yz.hi[2], 15, 0.01, "and in Z");
      // The same profile on a new (Z-up) Right-plane sketch stands along world Z: the revolve turns about the vertical.
      const up = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", [rect("r", 10, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 })));
      near(up.lo[2], 0, 0.01, "the Z-up YZ revolve starts at z = 0");
      near(up.hi[2], 20, 0.01, "and rises 20 mm along world Z (the sketch Y)");
      near(up.hi[0], 15, 0.01, "spreading in X");
      near(up.hi[1], 15, 0.01, "and in Y");
      near(up.volume, yz.volume, 1e-6 * yz.volume, "the two conventions build the same solid, turned");
    }
  },
  {
    name: "P21 circles and ellipses are faceted by size: small ones keep 72 facets, large ones get more, and the volume error stays small",
    run: async () => {
      equal(adaptiveFacetCount(0.5), 72, "a small circle keeps the classic 72 facets");
      equal(adaptiveFacetCount(50), 72, "and so does a 50 mm radius");
      assert(adaptiveFacetCount(100) > 72 && adaptiveFacetCount(1000) > adaptiveFacetCount(100) && adaptiveFacetCount(1000) % 4 === 0, "larger circles get more facets, always a multiple of four");
      assert(adaptiveFacetCount(1e9) <= 512, "the count is capped");
      for (const radius of [100, 1000, 5000]) {
        const cylinder = meshStats(solidOf(await buildSolid(committedSketch("datum:xy", [circ("c", 0, 0, radius)]).sketch, "extrude", { valueMm: 10 })));
        const exact = Math.PI * radius * radius * 10;
        const error = Math.abs(cylinder.volume - exact) / exact;
        assert(error < 0.001, `r ${radius}: the faceted cylinder is within 0.1 % of the exact volume (was ${(error * 100).toFixed(3)} %)`);
      }
      // The old fixed 72 facets were 0.127 % low at any size; a 1000 mm radius now sags far less than 0.95 mm per chord.
      const large = adaptiveFacetCount(1000);
      const sag = 1000 * (1 - Math.cos(Math.PI / large));
      assert(sag < 0.06, `the chord sag at r 1000 is ${sag.toFixed(3)} mm instead of 0.95 mm`);
      // A big revolve stays within the storable mesh size.
      const wheel = solidOf(await buildSolid(committedSketch("datum:xy", [rect("r", 1500, 200, 400, 300)]).sketch, "revolve", { valueMm: 360 }));
      assert(wheel.positionsMm.length / 3 <= 100_000, "a revolve of a large profile still fits the 100,000-vertex body limit");
      near(meshStats(wheel).volume, Math.PI * (1700 ** 2 - 1300 ** 2) * 300, Math.PI * (1700 ** 2 - 1300 ** 2) * 300 * 0.002, "and is accurate to 0.2 %");
    }
  }
];
