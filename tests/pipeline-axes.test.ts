import { DATUM_PLANE_AXES, DATUM_PLANE_NORMAL, describeSketchAxes, sketchToWorld, worldToSketch } from "../apps/studio-web/src/sketch-world.js";
import { adaptiveFacetCount } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, meshStats, rect, solidOf } from "./pipeline-kit.js";

const WORLD: Readonly<Record<string, readonly [number, number, number]>> = {
  "world +X": [1, 0, 0], "world -X": [-1, 0, 0], "world +Y": [0, 1, 0], "world -Y": [0, -1, 0], "world +Z": [0, 0, 1], "world -Z": [0, 0, -1]
};

export const pipelineAxesTests: readonly TestCase[] = [
  {
    name: "P22 the documented sketch axes of every datum plane match where a sketch point really lands, and a revolve on the YZ plane turns about world Y",
    run: async () => {
      for (const plane of ["datum:xy", "datum:xz", "datum:yz"] as const) {
        const sketch = committedSketch(plane, [rect("r", 0, 0, 10, 10)]).sketch.sketch;
        const key = plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
        const origin = sketchToWorld(sketch, 0, 0);
        const x = sketchToWorld(sketch, 1, 0);
        const y = sketchToWorld(sketch, 0, 1);
        const documented = DATUM_PLANE_AXES[key];
        assert(JSON.stringify([x[0] - origin[0], x[1] - origin[1], x[2] - origin[2]]) === JSON.stringify(WORLD[documented.sketchX]), `${plane}: sketch X is ${documented.sketchX}`);
        assert(JSON.stringify([y[0] - origin[0], y[1] - origin[1], y[2] - origin[2]]) === JSON.stringify(WORLD[documented.sketchY]), `${plane}: sketch Y is ${documented.sketchY}`);
        assert(JSON.stringify(DATUM_PLANE_NORMAL[key]) === JSON.stringify(WORLD[documented.normal]), `${plane}: the sketch faces ${documented.normal}`);
        const back = worldToSketch(sketch, sketchToWorld(sketch, 7, -3, 2));
        near(back.u, 7, 1e-9, `${plane}: world to sketch returns u`);
        near(back.v, -3, 1e-9, `${plane}: and v`);
        near(back.w, 2, 1e-9, `${plane}: and the distance off the plane`);
      }
      assert(/Y axis along world \+Y/u.test(describeSketchAxes({ plane: "datum:yz" })) && /X axis runs along world -Z/u.test(describeSketchAxes({ plane: "datum:yz" })), "the YZ plane is described in words the UI can show");
      // A profile drawn upright on the YZ plane revolves about the sketch Y axis, which is world Y: the solid stands along Y.
      const yz = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", [rect("r", 10, 10, 10, 20)]).sketch, "revolve", { valueMm: 360 })));
      near(yz.lo[1], 0, 0.01, "the YZ revolve starts at y = 0");
      near(yz.hi[1], 20, 0.01, "and rises 20 mm along world Y (the sketch Y)");
      near(yz.hi[0], 15, 0.01, "spreading in X");
      near(yz.hi[2], 15, 0.01, "and in Z");
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
