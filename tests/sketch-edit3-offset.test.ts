import { applyWorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeLiveSketch } from "../packages/workbench-core/src/sketch-analysis.js";
import { offsetEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { assert, type TestCase } from "./test-kit.js";
import { applyOk, con, ctx, line, projectWith } from "./edit-test-kit.js";

/** Wave 3 regression test for the offset distance (re-audit 2: Edit tools E07, the offset half: "polygon width 60->100 leaves the offset at 70"). */

function setDimension(project: WorkbenchProject, entityId: string, dimension: string, valueMm: number): WorkbenchProject {
  const result = applyWorkbenchOperation(project, { kind: "set-sketch-dimension", operationId: `operation:e3o-${Math.random().toString(36).slice(2)}`, expectedRevision: project.revision, entityId, dimension, valueMm } as never);
  if (!result.ok) throw new Error(`set-sketch-dimension refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}

export const sketchEdit3OffsetTests: readonly TestCase[] = [
  {
    name: "Wave 3 edit E07: an offset of a polygon keeps its distance to the source, so editing the source width carries the offset along",
    run: () => {
      const corners: readonly (readonly [number, number])[] = [[0, 0], [60, 0], [60, 40], [0, 40]];
      const lines = corners.map((corner, index) => line(`l${index}`, corner, corners[(index + 1) % 4]!));
      const joints = corners.map((_, index) => con(`j${index}`, "coincident", [`l${index}`, `l${(index + 1) % 4}`], { points: ["end", "start"] }));
      const base = projectWith(lines, [...joints, con("h0", "horizontal", ["l0"]), con("h2", "horizontal", ["l2"]), con("v1", "vertical", ["l1"]), con("v3", "vertical", ["l3"]), con("d0", "distance", ["l0"], { valueMm: 60, dimension: "length" }), con("d1", "distance", ["l1"], { valueMm: 40, dimension: "length" })]);
      const offset = applyOk(base, offsetEntities(ctx(base), lines.map((entity) => entity.id), 5));
      assert(offset.sketch.constraints.filter((entry) => entry.kind === "distance" && entry.dimension === "line-line").length >= 4, "each offset line holds its distance to its source");
      assert(analyzeLiveSketch(offset.sketch).redundant.length === 0, "and nothing is over-defined");
      const widened = setDimension(offset, "entity:l0", "length", 100);
      const made = widened.sketch.entities.filter((entity) => !entity.id.startsWith("entity:l") || entity.id.length > 9);
      const xs = made.flatMap((entity) => (entity.kind === "line" ? [entity.start[0], entity.end[0]] : []));
      const width = Math.max(...xs) - Math.min(...xs);
      assert(Math.abs(width - 110) < 1e-3, `the offset follows: width ${width} instead of 110`);
    }
  }
];
