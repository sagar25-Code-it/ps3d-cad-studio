import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { analyzeFaces } from "../packages/workbench-geometry/src/face-analysis.js";
import { fitCylinder, type CylinderFit, type WrapProfile } from "../packages/workbench-geometry/src/wrap.js";
import { wrapProfile } from "../packages/workbench-geometry/src/wrap-apply.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { boxMesh, extrudeMesh, face, roundMesh, volumeOf, type Mesh } from "./body-edits.test.js";

const rectangle = (w: number, h: number): [number, number][] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
const circle = (r: number, n = 72): [number, number][] => Array.from({ length: n }, (_, k): [number, number] => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n)]);
const side = face([15, 0, 10], [1, 0, 0]);
const solid = (mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): Mesh => ({ positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) });

function fitOf(mesh: Mesh, ref = side): CylinderFit {
  const fit = fitCylinder(mesh, ref);
  assert(typeof fit !== "string", `the cylinder fits: ${typeof fit === "string" ? fit : ""}`);
  if (typeof fit === "string") throw new Error(fit);
  return fit;
}

export const bodyWrapTests: readonly TestCase[] = [
  {
    name: "Cylinder fitting finds the axis, radius and facet count of a round wall, on any axis, and refuses flat or non-round faces",
    run: () => {
      const fit = fitOf(roundMesh(15, 20, 72));
      near(fit.radiusMm, 15, 1e-3, "radius");
      near(Math.abs(fit.axisMm[2]), 1, 1e-6, "axis along Z");
      near(fit.axialRangeMm[0], 0, 1e-6, "starts at z = 0");
      near(fit.axialRangeMm[1], 20, 1e-6, "ends at z = 20");
      assert(fit.segments === 72 && fit.deviation < 1e-6, "72 flats and an exact circle");
      const sideways = extrudeMesh(circle(15), 20, "yz");
      const alongX = fitCylinder(sideways, face([10, 15, 0], [0, 1, 0]));
      assert(typeof alongX !== "string" && Math.abs(alongX.axisMm[0]) > 0.999999, "a cylinder lying along X is found with its axis along X");
      const flat = fitCylinder(roundMesh(15, 20), face([0, 0, 20], [0, 0, 1]));
      assert(typeof flat === "string" && flat.includes("flat"), "the cap is flat, not a cylinder wall");
      const box = fitCylinder(boxMesh(40, 30, 20), face([20, 15, 10], [1, 0, 0]));
      assert(typeof box === "string", "a box wall is not a cylinder");
      const faceted = fitCylinder(roundMesh(15, 20, 8), face([15, 0, 10], [1, 0, 0]));
      assert(typeof faceted === "string", "the wall of an 8-sided prism is a set of flats at 45 degrees, not a round face");
      const missing = fitCylinder(roundMesh(15, 20), face([300, 0, 0], [1, 0, 0]));
      assert(typeof missing === "string" && missing.includes("gone"), "a pick far from the body is reported");
    }
  },
  {
    name: "Emboss wraps a rectangle onto a cylinder by arc length: it adds area x height, stands out by the height, and sits where it was picked",
    run: () => {
      const body = roundMesh(15, 20);
      const fit = fitOf(body);
      const label: WrapProfile = { outer: rectangle(10, 8), holes: [] };
      const result = wrapProfile(body, label, fit, { pointMm: [15, 0, 10], normalMm: [1, 0, 0] }, { mode: "emboss", heightMm: 1 });
      assert(result.ok, `emboss: ${result.ok ? "" : result.message}`);
      if (!result.ok) return;
      assert(typeof analyzeFaces(solid(result)) !== "string", "the embossed body is a closed outward solid");
      near(volumeOf(solid(result)) - volumeOf(body), 80 * (1 + 1 / 30), 80 * 0.03, "the embossed slab adds the profile area times its height (a little more for the larger outer radius)");
      const metrics = solidMetrics(result.positionsMm, result.indices);
      near(metrics.boundsMm.max[0], 16, 0.02, "the label stands 1 mm proud of the 15 mm radius");
      near(metrics.boundsMm.min[0], -15, 0.02, "the far side is untouched");
      let yMax = 0; let zLow = Infinity; let zHigh = -Infinity;
      for (let i = 0; i < result.positionsMm.length; i += 3) {
        if (Math.hypot(result.positionsMm[i]!, result.positionsMm[i + 1]!) > 15.5) { yMax = Math.max(yMax, Math.abs(result.positionsMm[i + 1]!)); zLow = Math.min(zLow, result.positionsMm[i + 2]!); zHigh = Math.max(zHigh, result.positionsMm[i + 2]!); }
      }
      near(yMax, 16 * Math.sin(5 / 15), 0.1, "the label is 10 mm of ARC wide (an unwrapped copy would reach only y = 5)");
      near(zLow, 6, 0.01, "it starts 4 mm below the pick");
      near(zHigh, 14, 0.01, "and ends 4 mm above it");
    }
  },
  {
    name: "Deboss cuts the profile into the surface to the chosen depth; a round profile and a profile with a hole give the right volume",
    run: () => {
      const body = roundMesh(15, 20);
      const fit = fitOf(body);
      const pick = { pointMm: [15, 0, 10] as const, normalMm: [1, 0, 0] as const };
      const cutIn = wrapProfile(body, { outer: rectangle(10, 8), holes: [] }, fit, pick, { mode: "deboss", heightMm: 1 });
      assert(cutIn.ok, `deboss: ${cutIn.ok ? "" : cutIn.message}`);
      if (!cutIn.ok) return;
      assert(typeof analyzeFaces(solid(cutIn)) !== "string", "the debossed body is closed and outward");
      near(volumeOf(body) - volumeOf(solid(cutIn)), 80 * (1 - 1 / 30), 80 * 0.04, "the pocket removes the profile area times its depth (a little less on the smaller inner radius)");
      near(solidMetrics(cutIn.positionsMm, cutIn.indices).boundsMm.max[0], 15, 0.02, "the outside does not grow");
      const ring = wrapProfile(body, { outer: rectangle(10, 8), holes: [rectangle(4, 2)] }, fit, pick, { mode: "emboss", heightMm: 1 });
      assert(ring.ok, `profile with a hole: ${ring.ok ? "" : ring.message}`);
      if (ring.ok) near(volumeOf(solid(ring)) - volumeOf(body), 72 * (1 + 1 / 30), 72 * 0.04, "a frame: the area of the outline minus the hole");
      const disc = wrapProfile(body, { outer: circle(3), holes: [] }, fit, pick, { mode: "emboss", heightMm: 1.5 });
      assert(disc.ok, `a round profile: ${disc.ok ? "" : disc.message}`);
      if (disc.ok) near(volumeOf(solid(disc)) - volumeOf(body), Math.PI * 9 * (1.5 + (1.5 * 1.5) / 30), Math.PI * 9 * 1.5 * 0.05, "a round boss wrapped on the cylinder");
    }
  },
  {
    name: "Wrap works on a cylinder lying along X and refuses a profile that goes too far round, a bad height and a deboss as deep as the radius",
    run: () => {
      const body = extrudeMesh(circle(15), 20, "yz");
      const fit = fitCylinder(body, face([10, 15, 0], [0, 1, 0]));
      assert(typeof fit !== "string", "fit along X");
      if (typeof fit === "string") return;
      const pick = { pointMm: [10, 0, 15] as const, normalMm: [0, 0, 1] as const };
      const wrapped = wrapProfile(body, { outer: rectangle(6, 6), holes: [] }, fit, pick, { mode: "emboss", heightMm: 1 });
      assert(wrapped.ok, `emboss on the X cylinder: ${wrapped.ok ? "" : wrapped.message}`);
      if (wrapped.ok) {
        near(volumeOf(solid(wrapped)) - volumeOf(body), 36 * (1 + 1 / 30), 36 * 0.04, "the same volume rule holds on another axis");
        near(solidMetrics(wrapped.positionsMm, wrapped.indices).boundsMm.max[2], 16, 0.02, "and stands 1 mm proud at the picked side");
      }
      const wide = wrapProfile(body, { outer: rectangle(50, 4), holes: [] }, fit, pick, { mode: "emboss", heightMm: 1 });
      assert(!wide.ok && wide.message.includes("150"), "a 50 mm wide label on a 15 mm radius wraps 190 degrees, which is refused");
      assert(!wrapProfile(body, { outer: rectangle(6, 6), holes: [] }, fit, pick, { mode: "emboss", heightMm: 0 }).ok, "zero height");
      assert(!wrapProfile(body, { outer: rectangle(6, 6), holes: [] }, fit, pick, { mode: "deboss", heightMm: 15 }).ok, "a deboss as deep as the radius");
      assert(isClosedAndOriented(body.indices), "the source mesh was not disturbed");
    }
  }
];
