import type { SketchEntity, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, type WorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { selectionMetrics } from "../apps/studio-web/src/selection-metrics.js";
import { assert, equal, type TestCase } from "./test-kit.js";

const add = (project: WorkbenchProject, entity: SketchEntity, serial: number): WorkbenchProject => {
  const operation = { kind: "add-sketch-entity" as const, entity, operationId: `operation:test-metric-${serial}`, expectedRevision: project.revision };
  const result = applyWorkbenchOperation(project, operation as WorkbenchOperation);
  assert(result.ok, "add-sketch-entity is accepted");
  return result.value.project;
};

const line: SketchEntity = { id: "entity:line", kind: "line", start: [0, 0], end: [30, 40], construction: false };
const rect: SketchEntity = { id: "entity:rect", kind: "rectangle", center: [0, 0], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false };
const circle: SketchEntity = { id: "entity:circle", kind: "circle", center: [0, 0], radiusMm: 5, construction: false };

export const selectionMetricTests: readonly TestCase[] = [
  {
    name: "a line reports its Euclidean length in mm",
    run: () => {
      let project = createWorkbenchProject("project:measure-line");
      project = add(project, line, 1);
      const reading = selectionMetrics(project, "entity:line");
      assert(reading !== undefined, "a line has metrics");
      equal(reading!.title, "Line", "named 'Line'");
      equal(reading!.metrics[0], "Length: 50.00 mm", "3-4-5 gives 50 mm");
    }
  },
  {
    name: "a rectangle reports its size and area",
    run: () => {
      let project = createWorkbenchProject("project:measure-rect");
      project = add(project, rect, 2);
      const reading = selectionMetrics(project, "entity:rect");
      assert(reading !== undefined, "a rectangle has metrics");
      equal(reading!.metrics[0], "Size: 20.00 × 10.00 mm", "20 by 10");
      equal(reading!.metrics[1], "Area: 200.0 mm²", "area 200");
    }
  },
  {
    name: "a circle reports its radius, diameter and area",
    run: () => {
      let project = createWorkbenchProject("project:measure-circle");
      project = add(project, circle, 3);
      const reading = selectionMetrics(project, "entity:circle");
      assert(reading !== undefined, "a circle has metrics");
      assert(reading!.metrics[0]!.startsWith("Radius: 5.000 mm"), `radius and diameter: got "${reading!.metrics[0]}"`);
      assert(reading!.metrics[1]!.startsWith("Area: 78."), `area ~ pi r^2: got "${reading!.metrics[1]}"`);
    }
  },
  {
    name: "no selection returns no reading",
    run: () => {
      const project = createWorkbenchProject("project:measure-null");
      equal(selectionMetrics(project, null), undefined, "no selection, no reading");
      equal(selectionMetrics(project, "entity:does-not-exist"), undefined, "a missing id, no reading");
    }
  }
];
