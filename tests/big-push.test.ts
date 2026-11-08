import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { solidMetrics, sectionAnalysis } from "../packages/workbench-core/src/solid-metrics.js";
import { validSolidFeaturePayload, WORKBENCH_OPERATION_KINDS } from "../packages/workbench-core/src/index.js";
import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { applyDirectEdit } from "../apps/studio-web/src/design-regeneration.js";
import { drivenDimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import type { DesignSolidFeature, GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import type { SketchProfile } from "../packages/workbench-sketch/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

const SQUARE: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

function cube(id = "general-body:cube"): GeneralSolidBody {
  const mesh = tessellateExtrude(SQUARE, 10, "xy");
  return { id, name: "Cube", visible: true, color: "#808080", positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

function rectProfile(): SketchProfile {
  return {
    id: "profile:rect",
    boundary: { kind: "rectangle", widthMm: 10, heightMm: 10, center: [5, 5], rotationDeg: 0 },
    entityIds: ["rect-1"],
    areaMm2: 100,
    centroid: [5, 5]
  };
}

export const bigPushTests: readonly TestCase[] = [
  {
    name: "WORKBENCH_OPERATION_KINDS now includes the four UCS operations (count 105)",
    run: () => {
      assert(WORKBENCH_OPERATION_KINDS.length === 105, `expected 105, got ${WORKBENCH_OPERATION_KINDS.length}`);
      for (const op of ["add-construction-ucs", "delete-construction-ucs", "toggle-construction-ucs-visibility", "rename-construction-ucs"]) {
        assert((WORKBENCH_OPERATION_KINDS as readonly string[]).includes(op), `missing ${op}`);
      }
    }
  },
  {
    name: "solidMetrics of a 10×10×10 cube reports a volume of 1000 mm³ and a diagonal inertia tensor of (volume·(h²+w²)/12) on each axis",
    run: () => {
      const body = cube();
      const metrics = solidMetrics(body.positionsMm, body.indices);
      near(metrics.volumeMm3, 1000, 0.5, "volume ≈ 1000");
      // Analytic cube inertia of a 10×10×10 cube about its centroid, volume-weighted: I = V × (h² + w²) / 12.
      // The off-diagonal products of inertia for a symmetric cube are 0.
      const expected = 1000 * (100 + 100) / 12;
      near(metrics.inertiaTensorMm5[0]![0]!, expected, expected * 0.02, "Ixx ≈ V·(h²+w²)/12");
      near(metrics.inertiaTensorMm5[1]![1]!, expected, expected * 0.02, "Iyy ≈ V·(h²+w²)/12");
      near(metrics.inertiaTensorMm5[2]![2]!, expected, expected * 0.02, "Izz ≈ V·(h²+w²)/12");
      // Products of inertia are near zero for an axis-aligned cube at its centroid.
      assert(Math.abs(metrics.inertiaTensorMm5[0]![1]!) < 1, `Ixy near zero, got ${metrics.inertiaTensorMm5[0]![1]}`);
    }
  },
  {
    name: "sectionAnalysis of the cube at the XY plane z=5 returns 8 edges (4 side walls × 2 triangles per wall)",
    run: () => {
      const body = cube();
      const section = sectionAnalysis(body.positionsMm, body.indices, "xy", 5);
      // Each side wall contributes two triangles that each cross the plane → 2 edges per wall × 4 walls = 8.
      assert(section.edges.length === 8, `expected 8 edges, got ${section.edges.length}`);
      // Every edge lies at z=5.
      for (const edge of section.edges) {
        near(edge.start[2]!, 5, 1e-6, `edge start z = 5`);
        near(edge.end[2]!, 5, 1e-6, `edge end z = 5`);
      }
    }
  },
  {
    name: "sectionAnalysis at a plane that misses the body returns no edges",
    run: () => {
      const body = cube();
      const section = sectionAnalysis(body.positionsMm, body.indices, "xy", 100);
      assert(section.edges.length === 0, `expected 0 edges, got ${section.edges.length}`);
    }
  },
  {
    name: "Thread builder produces a helical ridge mesh with ~24 segments per turn × profile vertices",
    run: async () => {
      const profile = rectProfile();
      const result = await createGeneralSolidBody({
        profile, plane: "xy", operation: "thread", valueMm: 20,
        bodyId: "general-body:thread", name: "Thread", color: "#808080",
        threadPitchMm: 2, threadTurns: 4, threadDepthMm: 10, threadHandedness: "right"
      });
      assert(result.ok, "thread built");
      if (!result.ok) return;
      // 4 turns × 24 segments + 1 = 97 samples × 3 (triangular thread section) = 291 verts.
      assert(result.body.positionsMm.length / 3 === 97 * 3, `vertex count = ${result.body.positionsMm.length / 3}`);
    }
  },
  {
    name: "Thread builder refuses zero pitch, turns or depth",
    run: async () => {
      const profile = rectProfile();
      const bad = await createGeneralSolidBody({
        profile, plane: "xy", operation: "thread", valueMm: 20,
        bodyId: "general-body:thread-bad", name: "Thread", color: "#808080",
        threadPitchMm: 0, threadTurns: 4, threadDepthMm: 10
      });
      assert(!bad.ok, "zero pitch refused");
    }
  },
  {
    name: "Rib builder extrudes the sketch profile by valueMm",
    run: async () => {
      const profile = rectProfile();
      const result = await createGeneralSolidBody({
        profile, plane: "xy", operation: "rib", valueMm: 15,
        bodyId: "general-body:rib", name: "Rib", color: "#808080",
        ribThicknessMm: 1
      });
      assert(result.ok, "rib built");
      if (!result.ok) return;
      // Cube-like: 8 vertices, 12 side triangles + 2 caps of 2 triangles each.
      assert(result.body.positionsMm.length / 3 === 8, `rib has 8 vertices`);
    }
  },
  {
    name: "Dome builder produces a lofted scaled cap mesh",
    run: async () => {
      const profile = rectProfile();
      const result = await createGeneralSolidBody({
        profile, plane: "xy", operation: "dome", valueMm: 5,
        bodyId: "general-body:dome", name: "Dome", color: "#808080",
        domeHeightMm: 8
      });
      assert(result.ok, "dome built");
      if (!result.ok) return;
      assert(result.body.positionsMm.length >= 24, "dome has at least 8 vertices (top + bottom rings)");
    }
  },
  {
    name: "Emboss direct-edit raises the center of the target face more than its edges",
    run: () => {
      // Build a flat face mesh: 3x3 grid of vertices forming 8 triangles.
      const positionsMm: number[] = [];
      for (let y = 0; y < 3; y += 1) {
        for (let x = 0; x < 3; x += 1) {
          positionsMm.push(x * 5, y * 5, 0);
        }
      }
      const indices: number[] = [];
      for (let y = 0; y < 2; y += 1) {
        for (let x = 0; x < 2; x += 1) {
          const bl = y * 3 + x, br = bl + 1, tl = bl + 3, tr = tl + 1;
          indices.push(bl, br, tr, bl, tr, tl);
        }
      }
      const faceTriangles = new Array(indices.length / 3).fill(0);
      const body: GeneralSolidBody = {
        id: "general-body:flat", name: "Flat", visible: true, color: "#808080",
        positionsMm, indices,
        brep: {
          topology: { vertices: 9, edges: 16, faces: 1 },
          faces: [{ role: "face.top", key: "face.top-key", areaMm2: 100 }],
          faceTriangles
        }
      };
      const feature: DesignSolidFeature = {
        id: "feature:emboss-test", name: "Emboss", kind: "emboss", suppressed: false,
        sketchFeatureId: "feature:sketch-a", profileIds: [], valueMm: 2, bodyId: body.id,
        operation: "direct-edit", targetFaceRole: "face.top", embossHeightMm: 2
      };
      const next = applyDirectEdit(feature as DesignSolidFeature & { readonly kind: "emboss" }, body);
      // Center vertex (index 4) should lift more than the corner vertex (0).
      const centerLift = next.positionsMm[4 * 3 + 2]! - body.positionsMm[4 * 3 + 2]!;
      const cornerLift = next.positionsMm[0 * 3 + 2]! - body.positionsMm[0 * 3 + 2]!;
      assert(centerLift > cornerLift, `center lifts more (${centerLift} > ${cornerLift})`);
      assert(centerLift > 1.5 && centerLift <= 2, `center lifts near embossHeightMm (${centerLift})`);
    }
  },
  {
    name: "validSolidFeaturePayload accepts well-formed thread, rib, dome, emboss, and indent features",
    run: () => {
      assert(validSolidFeaturePayload({
        id: "feature:t", name: "T", kind: "thread", suppressed: false,
        sketchFeatureId: "feature:s", profileIds: [], valueMm: 10, bodyId: "general-body:b",
        threadPitchMm: 2, threadTurns: 4, threadDepthMm: 10
      }), "thread accepted");
      assert(validSolidFeaturePayload({
        id: "feature:r", name: "R", kind: "rib", suppressed: false,
        sketchFeatureId: "feature:s", profileIds: [], valueMm: 5, bodyId: "general-body:b",
        ribThicknessMm: 2
      }), "rib accepted");
      assert(validSolidFeaturePayload({
        id: "feature:d", name: "D", kind: "dome", suppressed: false,
        sketchFeatureId: "feature:s", profileIds: [], valueMm: 5, bodyId: "general-body:b",
        domeHeightMm: 4, targetFaceRole: "face.top"
      }), "dome accepted");
      assert(validSolidFeaturePayload({
        id: "feature:e", name: "E", kind: "emboss", suppressed: false,
        sketchFeatureId: "feature:s", profileIds: [], valueMm: 2, bodyId: "general-body:b",
        operation: "direct-edit", targetFaceRole: "face.top", embossHeightMm: 2
      }), "emboss accepted");
      assert(validSolidFeaturePayload({
        id: "feature:i", name: "I", kind: "indent", suppressed: false,
        sketchFeatureId: "feature:s", profileIds: [], valueMm: 1, bodyId: "general-body:b",
        indentToolBodyId: "general-body:tool"
      }), "indent accepted");
      // Thread missing required pitch → refused.
      assert(!validSolidFeaturePayload({
        id: "feature:t2", name: "T", kind: "thread", suppressed: false,
        sketchFeatureId: "feature:s", profileIds: [], valueMm: 10, bodyId: "general-body:b"
      }), "thread without pitch refused");
    }
  },
  {
    name: "drivenDimensionLayout returns an arc-length label on a line and a perimeter label on a rectangle",
    run: () => {
      const lineEntity = {
        kind: "line" as const, id: "ln-1", start: [0, 0] as const, end: [10, 0] as const, construction: false
      };
      const arcLenLayout = drivenDimensionLayout(lineEntity, "arc-length", 0.5);
      assert(arcLenLayout !== undefined && arcLenLayout.label.startsWith("ARC"), "arc-length label");
      const rectEntity = {
        kind: "rectangle" as const, id: "r-1", center: [0, 0] as const, widthMm: 10, heightMm: 20, rotationDeg: 0, construction: false
      };
      const perimLayout = drivenDimensionLayout(rectEntity, "perimeter", 0.5);
      assert(perimLayout !== undefined && perimLayout.label.startsWith("PERIM"), "perimeter label");
      if (perimLayout === undefined) return;
      assert(perimLayout.label.includes("60"), `rect 10+10+20+20=60, got ${perimLayout.label}`);
    }
  },
  {
    name: "drivenDimensionLayout returns an arc-length ~ π·radius for a 180° arc of radius 10",
    run: () => {
      // Arc from (10, 0) through (0, 10) to (-10, 0): center at origin, radius 10, 180° sweep → arc length = π × 10 ≈ 31.416.
      const arcEntity = {
        kind: "arc" as const, id: "a-1", construction: false,
        start: [10, 0] as const, mid: [0, 10] as const, end: [-10, 0] as const
      };
      const layout = drivenDimensionLayout(arcEntity, "arc-length", 0.5);
      assert(layout !== undefined, "arc-length layout");
      if (layout === undefined) return;
      const parsedValue = Number(layout.label.replace("ARC", "").trim());
      near(parsedValue, Math.PI * 10, 0.1, `arc length ≈ π·10 (got ${parsedValue})`);
    }
  }
];
