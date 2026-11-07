import { applyWorkbenchOperation, createWorkbenchProject, type SketchEntity, type WorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch, buildSketchEntity, detectSketchProfiles, entityExtents } from "../packages/workbench-sketch/src/index.js";
import { selectionMetrics } from "../apps/studio-web/src/selection-metrics.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const sketchEllipseTests: readonly TestCase[] = [
  {
    name: "ellipse tool takes centre, major-axis end and minor-axis distance",
    run: () => {
      const result = buildSketchEntity("ellipse", [[0, 0], [30, 0], [0, 10]], "entity:e1");
      assert(result.ok, result.ok ? "" : "ellipse build must succeed");
      if (!result.ok) return;
      const ellipse = result.value;
      assert(ellipse.kind === "ellipse", "the tool builds an ellipse entity");
      if (ellipse.kind !== "ellipse") return;
      equal(ellipse.center[0], 0, "centre x");
      equal(ellipse.center[1], 0, "centre y");
      near(ellipse.majorRadiusMm, 30, 1e-9, "major radius is the first-axis length");
      near(ellipse.minorRadiusMm, 10, 1e-9, "minor radius is the perpendicular distance of the third point");
      near(ellipse.rotationDeg, 0, 1e-9, "the major axis along +X has zero rotation");
    }
  },
  {
    name: "ellipse tool swaps axes when the minor point lies further than the major point",
    run: () => {
      const result = buildSketchEntity("ellipse", [[0, 0], [5, 0], [0, 40]], "entity:e2");
      assert(result.ok, result.ok ? "" : "ellipse build must succeed");
      if (!result.ok || result.value.kind !== "ellipse") return;
      near(result.value.majorRadiusMm, 40, 1e-9, "major becomes the longer radius");
      near(result.value.minorRadiusMm, 5, 1e-9, "minor becomes the shorter radius");
      near(result.value.rotationDeg, 90, 1e-9, "orientation rotates 90° so the major axis points at the longer point");
    }
  },
  {
    name: "ellipse tool refuses a degenerate minor axis",
    run: () => {
      // Third point ON the major axis: minor radius is zero.
      const result = buildSketchEntity("ellipse", [[0, 0], [20, 0], [10, 0]], "entity:e3");
      assert(!result.ok, "the degenerate case is refused");
    }
  },
  {
    name: "rotated ellipse extents track the rotated bounding box, not the axis-aligned one",
    run: () => {
      const ellipse: SketchEntity = { id: "entity:er", kind: "ellipse", center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 5, rotationDeg: 45, construction: false };
      const { min, max } = entityExtents(ellipse);
      const span = Math.hypot(20 * Math.cos(Math.PI / 4), 5 * Math.sin(Math.PI / 4));
      near(max[0] - min[0], span * 2, 1e-6, "rotated horizontal extent follows sqrt((a cos r)² + (b sin r)²) × 2");
      near(max[1] - min[1], span * 2, 1e-6, "same for the vertical extent");
    }
  },
  {
    name: "ellipse becomes a closed profile whose area is π × a × b",
    run: () => {
      let project = createWorkbenchProject("project:ellipse-profile");
      const ellipse: SketchEntity = { id: "entity:ep", kind: "ellipse", center: [0, 0], majorRadiusMm: 30, minorRadiusMm: 10, rotationDeg: 0, construction: false };
      const operation = { kind: "add-sketch-entity" as const, entity: ellipse, operationId: "operation:ellipse", expectedRevision: project.revision };
      const applied = applyWorkbenchOperation(project, operation as WorkbenchOperation);
      assert(applied.ok, "add-sketch-entity for an ellipse is accepted");
      if (!applied.ok) return;
      project = applied.value.project;
      const profiles = detectSketchProfiles(project.sketch);
      const profile = profiles.find((candidate) => candidate.entityIds.includes("entity:ep"));
      assert(profile !== undefined, "the ellipse becomes a profile");
      if (profile === undefined) return;
      near(profile.areaMm2, Math.PI * 30 * 10, 1e-9, "the profile area is π × a × b");
      assert(profile.boundary.kind === "ellipse", "the boundary is tagged as an ellipse");
    }
  },
  {
    name: "sketch analysis reports 5 degrees of freedom for a free ellipse",
    run: () => {
      let project = createWorkbenchProject("project:ellipse-dof");
      const ellipse: SketchEntity = { id: "entity:ed", kind: "ellipse", center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 10, rotationDeg: 30, construction: false };
      const operation = { kind: "add-sketch-entity" as const, entity: ellipse, operationId: "operation:ellipse-dof", expectedRevision: project.revision };
      const applied = applyWorkbenchOperation(project, operation as WorkbenchOperation);
      assert(applied.ok, "add-sketch-entity for an ellipse is accepted");
      if (!applied.ok) return;
      project = applied.value.project;
      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(analysis.degreesOfFreedom, 5, "an unconstrained ellipse has 5 degrees of freedom");
    }
  },
  {
    name: "selection metrics for an ellipse report its axes and area",
    run: () => {
      let project = createWorkbenchProject("project:ellipse-metric");
      const ellipse: SketchEntity = { id: "entity:em", kind: "ellipse", center: [0, 0], majorRadiusMm: 25, minorRadiusMm: 8, rotationDeg: 0, construction: false };
      const operation = { kind: "add-sketch-entity" as const, entity: ellipse, operationId: "operation:ellipse-metric", expectedRevision: project.revision };
      const applied = applyWorkbenchOperation(project, operation as WorkbenchOperation);
      assert(applied.ok, "add-sketch-entity for an ellipse is accepted");
      if (!applied.ok) return;
      project = applied.value.project;
      const reading = selectionMetrics(project, "entity:em");
      assert(reading !== undefined, "an ellipse has metrics");
      if (reading === undefined) return;
      equal(reading.title, "Ellipse", "named 'Ellipse'");
      assert(reading.metrics[0]!.includes("25") && reading.metrics[0]!.includes("8"), `axes appear in the first line: got "${reading.metrics[0]}"`);
      assert(reading.metrics[1]!.startsWith("Area: 628"), `area ≈ π × 25 × 8 = 628.3: got "${reading.metrics[1]}"`);
    }
  }
];
