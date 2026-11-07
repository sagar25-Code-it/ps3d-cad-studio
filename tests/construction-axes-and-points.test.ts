import { evaluateConstructionAxis, evaluateConstructionPoint } from "../packages/workbench-geometry/src/construction-geometry.js";
import type { ConstructionAxis, ConstructionPoint, GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { assert, near, type TestCase } from "./test-kit.js";

const AXIS_TWO_POINTS: ConstructionAxis = {
  id: "construction-axis:test-1",
  name: "Two points",
  visible: true,
  definition: { kind: "two-points", a: [0, 0, 0], b: [10, 0, 0] }
};

const AXIS_INTERSECTION: ConstructionAxis = {
  id: "construction-axis:test-2",
  name: "XY ∩ XZ",
  visible: true,
  definition: { kind: "plane-intersection", planeA: "datum:xy", planeB: "datum:xz" }
};

const AXIS_PERP: ConstructionAxis = {
  id: "construction-axis:test-3",
  name: "⟂ XY at (5, 5, 0)",
  visible: true,
  definition: { kind: "perpendicular-to-plane", plane: "datum:xy", point: [5, 5, 0] }
};

const AXIS_CYLINDER: ConstructionAxis = {
  id: "construction-axis:test-4",
  name: "Revolve body axis",
  visible: true,
  definition: { kind: "cylinder-axis", bodyId: "general-body:rev-1" }
};

export const constructionAxesAndPointsTests: readonly TestCase[] = [
  {
    name: "two-points axis: direction is (1, 0, 0) and origin at the midpoint",
    run: () => {
      const frame = evaluateConstructionAxis(AXIS_TWO_POINTS);
      assert(!("error" in frame), "the axis evaluates");
      if ("error" in frame) return;
      near(frame.direction[0], 1, 1e-6, "direction x");
      near(frame.direction[1], 0, 1e-6, "direction y");
      near(frame.direction[2], 0, 1e-6, "direction z");
      near(frame.origin[0], 5, 1e-6, "origin x is midpoint");
    }
  },
  {
    name: "plane-intersection XY ∩ XZ is the X axis (normals Z and -Y → direction +X or -X)",
    run: () => {
      const frame = evaluateConstructionAxis(AXIS_INTERSECTION);
      assert(!("error" in frame), "the axis evaluates");
      if ("error" in frame) return;
      // The XY plane normal is +Z, the XZ plane normal is +Y (per the datum-frames table in construction-geometry.ts).
      // Cross product (+Z) × (+Y) = -X, normalized to (-1, 0, 0).
      near(Math.abs(frame.direction[0]), 1, 1e-6, "direction lies along ±X");
      near(frame.direction[1], 0, 1e-6, "direction y is 0");
      near(frame.direction[2], 0, 1e-6, "direction z is 0");
    }
  },
  {
    name: "parallel planes refuse (e.g., XY ∩ XY)",
    run: () => {
      const invalid: ConstructionAxis = { id: "construction-axis:bad", name: "self", visible: true, definition: { kind: "plane-intersection", planeA: "datum:xy", planeB: "datum:xy" } };
      const frame = evaluateConstructionAxis(invalid);
      assert("error" in frame, "parallel planes are refused");
    }
  },
  {
    name: "perpendicular-to-plane: direction matches the plane normal and origin matches the point",
    run: () => {
      const frame = evaluateConstructionAxis(AXIS_PERP);
      assert(!("error" in frame), "the axis evaluates");
      if ("error" in frame) return;
      near(frame.direction[0], 0, 1e-6, "direction x = 0 for XY normal");
      near(frame.direction[1], 0, 1e-6, "direction y = 0 for XY normal");
      near(frame.direction[2], 1, 1e-6, "direction z = 1 for XY normal");
      near(frame.origin[0], 5, 1e-6, "origin x = 5");
      near(frame.origin[1], 5, 1e-6, "origin y = 5");
    }
  },
  {
    name: "cylinder-axis donates a revolve body's plane normal as the axis direction",
    run: () => {
      const body: GeneralSolidBody = {
        id: "general-body:rev-1",
        name: "Revolved ring",
        visible: true,
        color: "#b9c2c8",
        positionsMm: [10, 0, 0, 10, 0, 2, 0, 0, 1],
        indices: [0, 1, 2],
        feature: { operation: "revolve", plane: "xy", valueMm: 360 }
      };
      const frame = evaluateConstructionAxis(AXIS_CYLINDER, [body]);
      assert(!("error" in frame), "the axis evaluates");
      if ("error" in frame) return;
      // XY plane normal is +Z.
      near(frame.direction[2], 1, 1e-6, "cylinder-axis direction matches XY normal (+Z)");
      // Origin is centroid of the three vertices.
      near(frame.origin[0], (10 + 10 + 0) / 3, 1e-6, "origin x is the centroid x");
    }
  },
  {
    name: "axis-plane-intersection point: the Z axis through (0, 0, 0) intersects the XY plane at the origin",
    run: () => {
      const zAxis: ConstructionAxis = { id: "construction-axis:z", name: "Z", visible: true, definition: { kind: "point-and-direction", origin: [0, 0, 5], direction: [0, 0, 1] } };
      const point: ConstructionPoint = { id: "construction-point:test", name: "Z ∩ XY", visible: true, definition: { kind: "axis-plane-intersection", axisId: zAxis.id, plane: "datum:xy" } };
      const frame = evaluateConstructionPoint(point, [zAxis]);
      assert(!("error" in frame), "the point evaluates");
      if ("error" in frame) return;
      near(frame.position[0], 0, 1e-6, "x = 0");
      near(frame.position[1], 0, 1e-6, "y = 0");
      near(frame.position[2], 0, 1e-6, "z = 0 (on XY plane)");
    }
  },
  {
    name: "axis-plane-intersection refuses an axis parallel to the plane",
    run: () => {
      const xAxis: ConstructionAxis = { id: "construction-axis:x", name: "X", visible: true, definition: { kind: "point-and-direction", origin: [0, 0, 5], direction: [1, 0, 0] } };
      const point: ConstructionPoint = { id: "construction-point:test2", name: "X ∩ XY", visible: true, definition: { kind: "axis-plane-intersection", axisId: xAxis.id, plane: "datum:xy" } };
      const frame = evaluateConstructionPoint(point, [xAxis]);
      assert("error" in frame, "an axis parallel to the plane has no intersection");
    }
  },
  {
    name: "midpoint construction point: (0,0,0) + (10,20,30) → (5, 10, 15)",
    run: () => {
      const point: ConstructionPoint = { id: "construction-point:test3", name: "midpoint", visible: true, definition: { kind: "midpoint", a: [0, 0, 0], b: [10, 20, 30] } };
      const frame = evaluateConstructionPoint(point);
      assert(!("error" in frame), "midpoint evaluates");
      if ("error" in frame) return;
      near(frame.position[0], 5, 1e-6, "x = 5");
      near(frame.position[1], 10, 1e-6, "y = 10");
      near(frame.position[2], 15, 1e-6, "z = 15");
    }
  }
];
