import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeLiveSketch } from "../packages/workbench-core/src/sketch-analysis.js";
import { buildRoundedRectangle } from "../packages/workbench-sketch/src/basic-curve-shapes.js";
import { mirrorEntities, offsetEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { splitAt } from "../packages/workbench-sketch/src/split-jog.js";
import { analyzeSketch } from "../packages/workbench-sketch/src/sketch-repair.js";
import { equal, type TestCase } from "./test-kit.js";
import { applyOk, con, ctx, ids, line, projectWith } from "./edit-test-kit.js";

/** Wave 3 regression test for the redundant relations that a slot and a rounded rectangle showed after split, offset and mirror (re-audit 2: Edit tools N3). */

let serial = 0;
const sid = { entity: (): string => `entity:n3-${(serial += 1)}`, constraint: (): string => `constraint:n3-${(serial += 1)}` };

function overDefined(project: WorkbenchProject): string[] {
  const live = analyzeLiveSketch(project.sketch).redundant.map((set) => set.labels.join(" / "));
  const shown = analyzeSketch(ctx(project)).issues.filter((issue) => /over-defined|redundant/iu.test(`${issue.title} ${issue.detail}`)).map((issue) => issue.title);
  return [...live, ...shown];
}

export const sketchEdit3RedundancyTests: readonly TestCase[] = [
  {
    name: "Wave 3 edit N3: a slot and a rounded rectangle show no Over-defined relation after split, offset (out and in) and mirror",
    run: () => {
      const shapes = [
        ["slot", buildSlot([0, 0], [60, 0], [0, 10], sid)],
        ["rounded rectangle", buildRoundedRectangle([0, 0], [80, 50], 8, sid)]
      ] as const;
      for (const [name, built] of shapes) {
        if (!built.ok) throw new Error(`${name}: ${built.diagnostics[0]?.message}`);
        const base = projectWith(built.value.entities, built.value.constraints);
        equal(overDefined(base).join("; "), "", `${name}: the fresh shape is clean`);
        const firstLine = base.sketch.entities.find((entity) => entity.kind === "line")!;
        if (firstLine.kind !== "line") throw new Error("no line");
        const middle: readonly [number, number] = [(firstLine.start[0] + firstLine.end[0]) / 2, (firstLine.start[1] + firstLine.end[1]) / 2];
        const split = applyOk(base, splitAt(ctx(base), firstLine.id, middle));
        equal(overDefined(split).join("; "), "", `${name}: after a split`);
        const out = applyOk(base, offsetEntities(ctx(base), base.sketch.entities.map((entity) => entity.id), 3));
        equal(overDefined(out).join("; "), "", `${name}: after an offset outwards`);
        const inward = applyOk(base, offsetEntities(ctx(base), base.sketch.entities.map((entity) => entity.id), -2));
        equal(overDefined(inward).join("; "), "", `${name}: after an offset inwards`);
        const axis = line("axm", [-200, -200], [-200, 200]);
        const withAxis = projectWith([...base.sketch.entities, axis], [...base.sketch.constraints, con("fxa", "fixed", ["axm"])]);
        const mirrored = applyOk(withAxis, mirrorEntities(ctx(withAxis), [...base.sketch.entities.map((entity) => entity.id), ...ids("axm")]));
        equal(overDefined(mirrored).join("; "), "", `${name}: after a mirror`);
      }
    }
  }
];
