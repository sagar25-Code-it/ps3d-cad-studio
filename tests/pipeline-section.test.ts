import { detectSketchProfiles, resolveProfileRegion } from "../packages/workbench-sketch/src/index.js";
import { sectionPropertiesOfLoops, sectionPropertiesOfRegion } from "../packages/workbench-sketch/src/section-properties.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { circ, committedSketch, rect } from "./pipeline-kit.js";

export const pipelineSectionTests: readonly TestCase[] = [
  {
    name: "Section properties of a sketch region: area, centroid and the second moments, exact for rectangles, circles, rings and an L",
    run: () => {
      const box = sectionPropertiesOfLoops([[10, 5], [40, 5], [40, 25], [10, 25]]);
      assert(box !== undefined, "a rectangle has properties");
      near(box.areaMm2, 600, 1e-9, "area");
      near(box.centroidMm[0], 25, 1e-9, "centroid x");
      near(box.centroidMm[1], 15, 1e-9, "centroid y");
      near(box.ixxMm4, 30 * 20 ** 3 / 12, 1e-6, "Ixx about the centroid is w h^3 / 12");
      near(box.iyyMm4, 20 * 30 ** 3 / 12, 1e-6, "Iyy about the centroid is h w^3 / 12");
      near(box.ixyMm4, 0, 1e-6, "a rectangle parallel to the axes has no product of inertia");
      near(box.polarMm4, box.ixxMm4 + box.iyyMm4, 1e-6, "polar moment");
      near(box.perimeterMm, 100, 1e-9, "perimeter");
      near(box.principalAngleDeg, 90, 1e-9, "the larger moment is about the vertical axis");
      near(box.gyrationMm.x, Math.sqrt(box.ixxMm4 / 600), 1e-9, "radius of gyration");

      // Orientation of the outline does not matter.
      const clockwise = sectionPropertiesOfLoops([[10, 25], [40, 25], [40, 5], [10, 5]]);
      near(clockwise?.areaMm2 ?? 0, 600, 1e-9, "a clockwise outline gives the same positive area");

      // A circle and a ring (a hole is subtracted) from real sketch regions.
      const tube = committedSketch("datum:xy", [circ("o", 5, 5, 10), circ("i", 5, 5, 8), rect("x", 100, 100, 4, 4)]).sketch;
      const profiles = detectSketchProfiles(tube.sketch);
      const ring = resolveProfileRegion(profiles, profiles.filter((profile) => profile.entityIds[0] === "entity:o" || profile.entityIds[0] === "entity:i").map((profile) => profile.id), { includeIslands: false });
      assert(ring.ok, "the ring region resolves");
      const ringProperties = sectionPropertiesOfRegion(ring.value.outer, ring.value.holes);
      assert(ringProperties !== undefined, "the ring has properties");
      near(ringProperties.areaMm2, Math.PI * (100 - 64), Math.PI * 36 * 1e-5, "ring area");
      near(ringProperties.ixxMm4, Math.PI * (10 ** 4 - 8 ** 4) / 4, Math.PI * (10 ** 4 - 8 ** 4) / 4 * 1e-5, "ring Ixx is pi (R^4 - r^4) / 4");
      near(ringProperties.polarMm4, Math.PI * (10 ** 4 - 8 ** 4) / 2, Math.PI * (10 ** 4 - 8 ** 4) / 2 * 1e-5, "ring polar moment is pi (R^4 - r^4) / 2");
      near(ringProperties.centroidMm[0], 5, 1e-6, "the centroid is the ring centre");

      // An L section: 40 x 10 flange and 10 x 30 web. Centroid and Ixx from the parallel axis theorem.
      const l = sectionPropertiesOfLoops([[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]]);
      assert(l !== undefined, "the L has properties");
      near(l.areaMm2, 400 + 300, 1e-9, "L area");
      near(l.centroidMm[0], (400 * 20 + 300 * 5) / 700, 1e-9, "L centroid x");
      near(l.centroidMm[1], (400 * 5 + 300 * 25) / 700, 1e-9, "L centroid y");
      const cy = (400 * 5 + 300 * 25) / 700;
      near(l.ixxMm4, 40 * 10 ** 3 / 12 + 400 * (5 - cy) ** 2 + 10 * 30 ** 3 / 12 + 300 * (25 - cy) ** 2, 1e-6, "L Ixx by the parallel axis theorem");
      assert(Math.abs(l.ixyMm4) > 1, "an L has a product of inertia");
      assert(l.principalMm4[0] >= l.principalMm4[1], "the principal moments are ordered");
      near(l.principalMm4[0] + l.principalMm4[1], l.polarMm4, 1e-6, "they add up to the polar moment");

      // A rotated square has equal moments and no preferred axis.
      const diamond = sectionPropertiesOfLoops([[0, -10], [10, 0], [0, 10], [-10, 0]]);
      near(diamond?.ixxMm4 ?? 0, diamond?.iyyMm4 ?? 1, 1e-6, "a square rotated 45 degrees has Ixx = Iyy");
      assert(sectionPropertiesOfLoops([[0, 0], [1, 1], [2, 2]]) === undefined, "a line has no area");
    }
  }
];
