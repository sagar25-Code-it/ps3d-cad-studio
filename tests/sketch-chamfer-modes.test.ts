import type { SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { chamferCorners, chamferCornersAngle, chamferCornersAsymmetric, type SketchEditContext } from "../packages/workbench-sketch/src/edit-tools.js";
import { assert, near, type TestCase } from "./test-kit.js";

function sketchWithLines(lines: readonly SketchEntity[]): WorkbenchSketch {
  const project = createWorkbenchProject("project:chamfer-modes");
  return { ...project.sketch, entities: lines };
}

function makeContext(sketch: WorkbenchSketch): SketchEditContext {
  let counter = 0;
  return { sketch, newId: () => `entity:test-${counter += 1}` };
}

/** Two perpendicular lines meeting at (0, 0): one along +X ending at (10, 0), one along +Y ending at (0, 10). */
function elbow(): readonly SketchEntity[] {
  return [
    { id: "entity:elbow-x", kind: "line", start: [10, 0], end: [0, 0], construction: false },
    { id: "entity:elbow-y", kind: "line", start: [0, 0], end: [0, 10], construction: false }
  ];
}

function addedChamferEdge(result: ReturnType<typeof chamferCorners>): { readonly start: readonly [number, number]; readonly end: readonly [number, number] } | undefined {
  if (!result.ok) return undefined;
  const line = result.value.addEntities.find((entity) => entity.kind === "line");
  if (line === undefined || line.kind !== "line") return undefined;
  return { start: line.start, end: line.end };
}

export const sketchChamferModeTests: readonly TestCase[] = [
  {
    name: "equal-distance chamfer cuts a symmetric 2 mm corner",
    run: () => {
      const context = makeContext(sketchWithLines(elbow()));
      const result = chamferCorners(context, ["entity:elbow-x", "entity:elbow-y"], 2);
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok) return;
      const edge = addedChamferEdge(result);
      assert(edge !== undefined, "the symmetric chamfer edge is present");
      if (edge === undefined) return;
      const length = Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]);
      near(length, Math.sqrt(8), 1e-6, "symmetric chamfer length is √(2² + 2²)");
    }
  },
  {
    name: "two-distance chamfer cuts 3 mm × 1 mm on the perpendicular elbow",
    run: () => {
      const context = makeContext(sketchWithLines(elbow()));
      const result = chamferCornersAsymmetric(context, ["entity:elbow-x", "entity:elbow-y"], 3, 1);
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok) return;
      // Chamfer edge should go from (3, 0) to (0, 1): length √10.
      const chamferLine = result.value.addEntities.find((entity) => entity.kind === "line");
      assert(chamferLine !== undefined, "a chamfer edge is added");
      if (chamferLine === undefined || chamferLine.kind !== "line") return;
      const length = Math.hypot(chamferLine.end[0] - chamferLine.start[0], chamferLine.end[1] - chamferLine.start[1]);
      near(length, Math.sqrt(10), 1e-6, "two-distance chamfer edge is √(3² + 1²)");
    }
  },
  {
    name: "two-distance chamfer refuses a distance longer than its line",
    run: () => {
      const context = makeContext(sketchWithLines(elbow()));
      const result = chamferCornersAsymmetric(context, ["entity:elbow-x", "entity:elbow-y"], 20, 1);
      assert(!result.ok, "a distance that overruns the first line is refused");
    }
  },
  {
    name: "distance-and-angle chamfer at 45° reproduces the symmetric 2 mm chamfer",
    run: () => {
      const context = makeContext(sketchWithLines(elbow()));
      const result = chamferCornersAngle(context, ["entity:elbow-x", "entity:elbow-y"], 2, 45);
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok) return;
      const chamferLine = result.value.addEntities.find((entity) => entity.kind === "line");
      assert(chamferLine !== undefined, "a chamfer edge is added");
      if (chamferLine === undefined || chamferLine.kind !== "line") return;
      const length = Math.hypot(chamferLine.end[0] - chamferLine.start[0], chamferLine.end[1] - chamferLine.start[1]);
      near(length, Math.sqrt(8), 1e-4, "at 45° the distance-angle chamfer matches the symmetric chamfer length");
    }
  },
  {
    name: "distance-and-angle chamfer at 60° (shallower angle) reaches further on the second line",
    run: () => {
      const context = makeContext(sketchWithLines(elbow()));
      const result = chamferCornersAngle(context, ["entity:elbow-x", "entity:elbow-y"], 2, 60);
      assert(result.ok, result.ok ? "" : result.diagnostics[0]!.message);
      if (!result.ok) return;
      // Point A is at (2, 0) along the first line. Chamfer runs at 60° into the corner and meets
      // the +Y axis at y = 2 × tan(60°) × ... geometric expectation.
      const chamferLine = result.value.addEntities.find((entity) => entity.kind === "line");
      if (chamferLine === undefined || chamferLine.kind !== "line") return;
      const otherEnd = Math.abs(chamferLine.start[0] - 2) < 1e-4 ? chamferLine.end : chamferLine.start;
      // The angle from the first line is 60°; the chamfer ray from A at (2,0) goes toward the +Y axis.
      // Intersection with x = 0 solves y = 2 / tan(90° − 60°) = 2 / tan(30°) ≈ 3.4641.
      near(otherEnd[0], 0, 1e-4, "chamfer edge meets the second line at x = 0");
      near(otherEnd[1], 2 / Math.tan(30 * Math.PI / 180), 1e-4, "second intersection distance = 2 / tan(30°)");
    }
  },
  {
    name: "distance-and-angle chamfer refuses an angle equal to the corner's own dihedral",
    run: () => {
      const context = makeContext(sketchWithLines(elbow()));
      // The perpendicular elbow has a 90° dihedral; a 90° chamfer edge is parallel to the second line.
      const result = chamferCornersAngle(context, ["entity:elbow-x", "entity:elbow-y"], 2, 90);
      assert(!result.ok, "a chamfer parallel to the second line is refused");
    }
  }
];
