import { bentStripSection, flatPatternOf, flatPatternSvg, sheetBendAllowanceMm, sheetBendDeductionMm, sheetOutsideSetbackMm, tessellateBentStrip } from "../packages/workbench-geometry/src/sheet-metal.js";
import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import type { SketchProfile } from "../packages/workbench-sketch/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

function legProfile(widthMm: number): SketchProfile {
  return {
    id: "profile:leg",
    boundary: { kind: "rectangle", widthMm, heightMm: 10, center: [widthMm / 2, 5], rotationDeg: 0 },
    entityIds: ["rect-leg"],
    areaMm2: widthMm * 10,
    centroid: [widthMm / 2, 5]
  };
}

export const sheetMetalTests: readonly TestCase[] = [
  {
    name: "bend allowance of a 90° bend, R2, T2 with K 0.44 is (π/2)·(2 + 0.88)",
    run: () => {
      near(sheetBendAllowanceMm(90, 2, 2), (Math.PI / 2) * 2.88, 1e-9, "allowance");
    }
  },
  {
    name: "outside setback of a 90° bend equals inner radius + thickness, and bend deduction = 2·setback − allowance",
    run: () => {
      near(sheetOutsideSetbackMm(90, 2, 2), 4, 1e-9, "setback = R + T at 90°");
      near(sheetBendDeductionMm(90, 2, 2), 8 - (Math.PI / 2) * 2.88, 1e-9, "deduction");
    }
  },
  {
    name: "flat pattern length is leg + bend allowance + flange, with a bend line at the middle of the bend",
    run: () => {
      const pattern = flatPatternOf({ legMm: 30, flangeLengthMm: 20, angleDeg: 90, innerRadiusMm: 2, thicknessMm: 2, widthMm: 40 });
      const allowance = (Math.PI / 2) * 2.88;
      near(pattern.flatLengthMm, 50 + allowance, 1e-9, "flat length");
      near(pattern.bendLinesMm[0]![0][0], 30 + allowance / 2, 1e-9, "bend line x");
      assert(pattern.outlineMm.length === 4, "rectangular blank");
      const svg = flatPatternSvg(pattern);
      assert(svg.includes("bend-line") && svg.includes("flat-outline"), "svg has outline and bend line");
    }
  },
  {
    name: "a 90° bent strip ends with its flange rising straight up from the bend",
    run: () => {
      const section = bentStripSection({ legMm: 30, flangeLengthMm: 20, angleDeg: 90, innerRadiusMm: 2, thicknessMm: 2, widthMm: 10 });
      // Outer flange end is the last outer point: x = legMm + R + T = 34, y = (T + R) + 20 = 24.
      const flangeOuterEnd = section[section.length / 2 - 1]!;
      near(flangeOuterEnd[0], 34, 1e-6, "flange outer x");
      near(flangeOuterEnd[1], 4 + 20, 1e-6, "flange outer top y");
    }
  },
  {
    name: "bent strip volume ≈ cross-section area × width and refuses invalid specs",
    run: () => {
      const mesh = tessellateBentStrip({ legMm: 30, flangeLengthMm: 20, angleDeg: 90, innerRadiusMm: 2, thicknessMm: 2, widthMm: 10 }, "xy");
      const metrics = solidMetrics(mesh.positionsMm, mesh.indices);
      // Straight legs: (30 + 20) × 2 plus the quarter-annulus π/4·((4)² − (2)²) = 3π.
      const expected = (50 * 2 + 3 * Math.PI) * 10;
      near(metrics.volumeMm3, expected, expected * 0.02, "volume");
      assert(tessellateBentStrip({ legMm: 0, flangeLengthMm: 20, angleDeg: 90, innerRadiusMm: 2, thicknessMm: 2, widthMm: 10 }, "xy").positionsMm.length === 0, "zero leg refused");
      assert(tessellateBentStrip({ legMm: 10, flangeLengthMm: 20, angleDeg: 200, innerRadiusMm: 2, thicknessMm: 2, widthMm: 10 }, "xy").positionsMm.length === 0, "angle over 180 refused");
    }
  },
  {
    name: "sheet-base builder extrudes the profile by the sheet thickness",
    run: async () => {
      const result = await createGeneralSolidBody({ profile: legProfile(20), plane: "xy", operation: "sheet-base", valueMm: 2, bodyId: "general-body:sb", name: "Base", color: "#808080", sheetThicknessMm: 2 });
      assert(result.ok, "built");
      if (!result.ok) return;
      near(solidMetrics(result.body.positionsMm, result.body.indices).volumeMm3, 20 * 10 * 2, 0.5, "plate volume");
    }
  },
  {
    name: "sheet-flange builder uses the profile X-extent as the flat leg and valueMm as the width",
    run: async () => {
      const result = await createGeneralSolidBody({ profile: legProfile(30), plane: "xy", operation: "sheet-flange", valueMm: 10, bodyId: "general-body:sf", name: "Flange", color: "#808080", sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 20, flangeAngleDeg: 90 });
      assert(result.ok, "built");
      if (!result.ok) return;
      const expected = (50 * 2 + 3 * Math.PI) * 10;
      near(solidMetrics(result.body.positionsMm, result.body.indices).volumeMm3, expected, expected * 0.02, "flange volume");
    }
  },
  {
    name: "sheet-hem folds the flange back 180° and refuses a missing thickness",
    run: async () => {
      const hem = await createGeneralSolidBody({ profile: legProfile(30), plane: "xy", operation: "sheet-hem", valueMm: 10, bodyId: "general-body:sh", name: "Hem", color: "#808080", sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 10, hemStyle: "closed" });
      assert(hem.ok, "hem built");
      if (hem.ok) {
        const xs = hem.body.positionsMm.filter((_, index) => index % 3 === 0);
        assert(Math.min(...xs) >= -1e-6 && Math.max(...xs) < 40, "a closed hem stays within the leg's footprint plus the bend");
      }
      const bad = await createGeneralSolidBody({ profile: legProfile(30), plane: "xy", operation: "sheet-flange", valueMm: 10, bodyId: "general-body:bad", name: "Bad", color: "#808080", sheetBendRadiusMm: 2, flangeLengthMm: 10, flangeAngleDeg: 90 });
      assert(!bad.ok, "missing thickness refused");
    }
  },
  {
    name: "validSolidFeaturePayload accepts sheet-base, sheet-flange and sheet-hem and rejects missing or misplaced fields",
    run: () => {
      const common = { suppressed: false, sketchFeatureId: "feature:s", profileIds: [], valueMm: 10, bodyId: "general-body:b" };
      assert(validSolidFeaturePayload({ ...common, id: "feature:sb", name: "SB", kind: "sheet-base", sheetThicknessMm: 2 }), "base accepted");
      assert(validSolidFeaturePayload({ ...common, id: "feature:sf", name: "SF", kind: "sheet-flange", sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 20, flangeAngleDeg: 90 }), "flange accepted");
      assert(validSolidFeaturePayload({ ...common, id: "feature:sh", name: "SH", kind: "sheet-hem", sheetThicknessMm: 2, sheetBendRadiusMm: 1, flangeLengthMm: 8, hemStyle: "open" }), "hem accepted");
      assert(!validSolidFeaturePayload({ ...common, id: "feature:x1", name: "X", kind: "sheet-base" }), "base without thickness refused");
      assert(!validSolidFeaturePayload({ ...common, id: "feature:x2", name: "X", kind: "sheet-flange", sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 20 }), "flange without angle refused");
      assert(!validSolidFeaturePayload({ ...common, id: "feature:x3", name: "X", kind: "extrude", sheetThicknessMm: 2 }), "thickness on an extrude refused");
      assert(!validSolidFeaturePayload({ ...common, id: "feature:x4", name: "X", kind: "sheet-flange", sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 20, flangeAngleDeg: 270 }), "angle over 180 refused");
    }
  }
];
