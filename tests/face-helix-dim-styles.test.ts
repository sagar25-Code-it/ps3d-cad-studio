import { tessellateExtrude, tessellateHelix } from "../packages/workbench-geometry/src/tessellate.js";
import { applyDirectEdit } from "../apps/studio-web/src/design-regeneration.js";
import { createAutomaticDrawingPlan } from "../packages/workbench-drawing/src/index.js";
import type { DesignSolidFeature, GeneralSolidBody, PartIntent, DrawingSettings } from "../packages/workbench-core/src/index.js";
import { validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

function bounds(positions: readonly number[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

function facedCube(id = "general-body:cube"): GeneralSolidBody {
  // A 10×10×10 cube built directly, with a two-face brep: "top" (the four top vertices) and "bottom" (the four bottom
  // vertices). We skip the sides so the test can focus on the face-vertex collection without pulling in the full kernel.
  const positionsMm = [
    0, 0, 0,  10, 0, 0,  10, 10, 0,  0, 10, 0,     // bottom (0..3)
    0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10     // top (4..7)
  ];
  const indices = [
    0, 2, 1, 0, 3, 2,       // bottom (reversed CCW)
    4, 5, 6, 4, 6, 7        // top
  ];
  const faceTriangles = [0, 0, 1, 1]; // triangles 0..1 → face 0 (bottom); 2..3 → face 1 (top)
  return {
    id, name: "Cube", visible: true, color: "#808080", positionsMm, indices,
    brep: {
      topology: { vertices: 8, edges: 12, faces: 2 },
      faces: [
        { role: "face.bottom", key: "face.bottom-key", areaMm2: 100 },
        { role: "face.top", key: "face.top-key", areaMm2: 100 }
      ],
      faceTriangles
    }
  };
}

const PART: PartIntent = {
  id: "part:mounting-plate",
  name: "Test Plate",
  widthMm: 80,
  heightMm: 50,
  thicknessMm: 6,
  holeDiameterMm: 8,
  edgeTreatmentMm: 0.5,
  patternCount: 1,
  revolveAngleDeg: 360
};

const DRAWING_BASE: DrawingSettings = {
  id: "drawing:main-sheet", title: "Test Plate", sheet: "A4", projection: "third-angle", scale: 1,
  showDimensions: true, notes: ""
};

export const faceHelixDimStylesTests: readonly TestCase[] = [
  {
    name: "offset-face along the +Z normal only moves the four top vertices of a cube",
    run: () => {
      const body = facedCube();
      const feature: DesignSolidFeature = {
        id: "feature:offset-face-top", name: "Offset top", kind: "offset-face", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 3, bodyId: body.id,
        operation: "direct-edit", targetFaceRole: "face.top", offsetFaceMm: 3
      };
      const next = applyDirectEdit(feature as DesignSolidFeature & { readonly kind: "offset-face" }, body);
      // Bottom (indices 0..3) unchanged.
      for (let v = 0; v < 4; v += 1) {
        near(next.positionsMm[v * 3 + 2]!, 0, 1e-9, `bottom vertex ${v} z unchanged`);
      }
      // Top (indices 4..7) lifted by +3 mm along +Z (normal of bottom-winding-reversed top).
      for (let v = 4; v < 8; v += 1) {
        near(next.positionsMm[v * 3 + 2]!, 13, 1e-9, `top vertex ${v} z lifted by 3`);
      }
    }
  },
  {
    name: "move-face translates the four top vertices by the stored delta, leaving the bottom alone",
    run: () => {
      const body = facedCube();
      const feature: DesignSolidFeature = {
        id: "feature:move-face-top", name: "Move top", kind: "move-face", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 5, bodyId: body.id,
        operation: "direct-edit", targetFaceRole: "face.top", moveFaceDeltaMm: [2, -3, 4]
      };
      const next = applyDirectEdit(feature as DesignSolidFeature & { readonly kind: "move-face" }, body);
      for (let v = 0; v < 4; v += 1) {
        near(next.positionsMm[v * 3]!, body.positionsMm[v * 3]!, 1e-9, `bottom vertex ${v} x unchanged`);
        near(next.positionsMm[v * 3 + 1]!, body.positionsMm[v * 3 + 1]!, 1e-9, `bottom vertex ${v} y unchanged`);
        near(next.positionsMm[v * 3 + 2]!, body.positionsMm[v * 3 + 2]!, 1e-9, `bottom vertex ${v} z unchanged`);
      }
      for (let v = 4; v < 8; v += 1) {
        near(next.positionsMm[v * 3]!, body.positionsMm[v * 3]! + 2, 1e-9, `top vertex ${v} x += 2`);
        near(next.positionsMm[v * 3 + 1]!, body.positionsMm[v * 3 + 1]! - 3, 1e-9, `top vertex ${v} y -= 3`);
        near(next.positionsMm[v * 3 + 2]!, body.positionsMm[v * 3 + 2]! + 4, 1e-9, `top vertex ${v} z += 4`);
      }
    }
  },
  {
    name: "offset-face with an unknown face role leaves the body unchanged",
    run: () => {
      const body = facedCube();
      const feature: DesignSolidFeature = {
        id: "feature:offset-face-bad", name: "Offset ghost", kind: "offset-face", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 3, bodyId: body.id,
        operation: "direct-edit", targetFaceRole: "face.ghost", offsetFaceMm: 10
      };
      const next = applyDirectEdit(feature as DesignSolidFeature & { readonly kind: "offset-face" }, body);
      for (let i = 0; i < body.positionsMm.length; i += 1) {
        near(next.positionsMm[i]!, body.positionsMm[i]!, 1e-12, `vertex ${i} unchanged`);
      }
    }
  },
  {
    name: "tessellateHelix winds a profile over 4 turns and 20 mm pitch to total height ≈ 80 mm",
    run: () => {
      const mesh = tessellateHelix(SQUARE, 30, 20, 4, "right", "xy");
      const b = bounds(mesh.positionsMm);
      // Max Z should be near total height 80 mm plus profile height (10 mm → centroid offset 5 mm) → top ≈ 85 mm.
      // The profile centroid at the top ring sits at z = 80, and profile Y spans [-5, 5] so max ≈ 85.
      assert(b.max[2]! > 80, `top near total height (got ${b.max[2]})`);
      assert(b.max[2]! < 90, `top not over-extended (got ${b.max[2]})`);
      // Min Z: starts at z = 0, profile Y -5 → min ≈ -5.
      near(b.min[2]!, -5, 1e-4, "bottom of first ring sits at profile y=-5");
      // Vertex count: 4 turns × 24 segments + 1 = 97 samples × 4 verts = 388.
      assert(mesh.positionsMm.length / 3 === 97 * 4, `vertex count = ${mesh.positionsMm.length / 3}`);
    }
  },
  {
    name: "tessellateHelix left-handed wind sits below the start, right-handed above",
    run: () => {
      const right = tessellateHelix(SQUARE, 15, 10, 2, "right", "xy");
      const left = tessellateHelix(SQUARE, 15, 10, 2, "left", "xy");
      const rightTop = right.positionsMm[right.positionsMm.length - 1]!; // last z (approx)
      const leftTop = left.positionsMm[left.positionsMm.length - 1]!;
      // right ends high, left ends low (just compare the signs of the full-range max/min).
      const rb = bounds(right.positionsMm);
      const lb = bounds(left.positionsMm);
      assert(rb.max[2]! > 15, `right-handed rises (max z = ${rb.max[2]})`);
      assert(lb.min[2]! < -15, `left-handed falls (min z = ${lb.min[2]})`);
      void rightTop; void leftTop;
    }
  },
  {
    name: "tessellateHelix refuses non-positive radius, pitch or turns",
    run: () => {
      assert(tessellateHelix(SQUARE, 0, 5, 2, "right", "xy").positionsMm.length === 0, "radius 0 refused");
      assert(tessellateHelix(SQUARE, 10, 0, 2, "right", "xy").positionsMm.length === 0, "pitch 0 refused");
      assert(tessellateHelix(SQUARE, 10, 5, 0, "right", "xy").positionsMm.length === 0, "turns 0 refused");
    }
  },
  {
    name: "validSolidFeaturePayload accepts well-formed helix, move-face and offset-face features",
    run: () => {
      assert(validSolidFeaturePayload({
        id: "feature:helix-v", name: "Coil", kind: "helix", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 40, bodyId: "general-body:a",
        helixRadiusMm: 20, helixPitchMm: 5, helixTurns: 4, helixHandedness: "right"
      }), "helix accepted");
      assert(validSolidFeaturePayload({
        id: "feature:move-face-v", name: "Move top", kind: "move-face", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 5, bodyId: "general-body:a",
        operation: "direct-edit", targetFaceRole: "face.top", moveFaceDeltaMm: [0, 0, 3]
      }), "move-face accepted");
      assert(validSolidFeaturePayload({
        id: "feature:offset-face-v", name: "Offset top", kind: "offset-face", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 3, bodyId: "general-body:a",
        operation: "direct-edit", targetFaceRole: "face.top", offsetFaceMm: 3
      }), "offset-face accepted");
      // Reject helix without radius.
      assert(!validSolidFeaturePayload({
        id: "feature:helix-bad", name: "Coil", kind: "helix", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 40, bodyId: "general-body:a"
      }), "helix without params refused");
      // Reject offset-face without target role.
      assert(!validSolidFeaturePayload({
        id: "feature:offset-face-bad", name: "Offset", kind: "offset-face", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 3, bodyId: "general-body:a",
        operation: "direct-edit", offsetFaceMm: 3
      }), "offset-face without role refused");
    }
  },
  {
    name: "drawing plan with dimensionStyle 'chain' splits overall width into two chained halves",
    run: () => {
      const plan = createAutomaticDrawingPlan(PART, { ...DRAWING_BASE, dimensionStyle: "chain" });
      const ids = plan.dimensions.map((d) => d.id);
      assert(ids.includes("dimension:width-left-half"), "has left-half");
      assert(ids.includes("dimension:width-right-half"), "has right-half");
      assert(!ids.includes("dimension:overall-width"), "no single overall-width in chain style");
      assert(plan.dimensions.find((d) => d.id === "dimension:width-left-half")?.kind === "linear-chain", "chain kind set");
    }
  },
  {
    name: "drawing plan with dimensionStyle 'baseline' emits a width-to-bore and overall-width from a common origin",
    run: () => {
      const plan = createAutomaticDrawingPlan(PART, { ...DRAWING_BASE, dimensionStyle: "baseline" });
      const ids = plan.dimensions.map((d) => d.id);
      assert(ids.includes("dimension:width-to-bore"), "baseline has width-to-bore");
      assert(ids.includes("dimension:overall-width"), "baseline has overall-width");
      assert(plan.dimensions.find((d) => d.id === "dimension:width-to-bore")?.kind === "linear-baseline", "baseline kind set");
    }
  },
  {
    name: "drawing plan with dimensionStyle 'ordinate' emits four coordinate readouts",
    run: () => {
      const plan = createAutomaticDrawingPlan(PART, { ...DRAWING_BASE, dimensionStyle: "ordinate" });
      const ids = plan.dimensions.map((d) => d.id);
      assert(ids.includes("dimension:ord-bore-x"), "ordinate has bore-x");
      assert(ids.includes("dimension:ord-bore-y"), "ordinate has bore-y");
      assert(ids.includes("dimension:ord-width"), "ordinate has width");
      assert(ids.includes("dimension:ord-height"), "ordinate has height");
      assert(plan.dimensions.find((d) => d.id === "dimension:ord-bore-x")?.kind === "ordinate", "ordinate kind set");
      assert(plan.dimensionStyle === "ordinate", "dimensionStyle recorded");
    }
  },
  {
    name: "drawing plan defaults to 'individual' dimensionStyle (unchanged legacy behaviour)",
    run: () => {
      const plan = createAutomaticDrawingPlan(PART, DRAWING_BASE);
      assert(plan.dimensionStyle === "individual", "default is individual");
      const widthRecord = plan.dimensions.find((d) => d.id === "dimension:overall-width");
      assert(widthRecord !== undefined && widthRecord.kind === "linear", "linear single-callout");
    }
  }
];
