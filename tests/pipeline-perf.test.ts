import { assert, type TestCase } from "./test-kit.js";
import { fresh, line, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";

export const pipelinePerformanceTests: readonly TestCase[] = [
  {
    name: "Performance a sketch near its limits (470 curves, 939 relations) is applied and edited well inside a second",
    run: () => {
      const lines = Array.from({ length: 470 }, (_, index) => line(`l${index}`, [index * 3, index % 7], [index * 3 + 2, index % 7]));
      const relations = [
        ...Array.from({ length: 469 }, (_, index) => ({ id: `constraint:p${index}`, kind: "parallel" as const, entityIds: [`entity:l${index}`, `entity:l${index + 1}`] })),
        ...Array.from({ length: 470 }, (_, index) => ({ id: `constraint:h${index}`, kind: "horizontal" as const, entityIds: [`entity:l${index}`] }))
      ];
      const started = performance.now();
      const applied = pipelineApply(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: lines, addConstraints: relations, label: "Large sketch" });
      const applyMs = performance.now() - started;
      assert(applied.ok, `the large edit is accepted: ${message(applied)}`);
      assert(applyMs < 1_000, `applying 470 curves and 939 relations took ${Math.round(applyMs)} ms`);
      const next = performance.now();
      pipelineRun(applied.value.project, { kind: "toggle-sketch-construction", entityId: "entity:l3" });
      assert(performance.now() - next < 500, "a follow-up edit on the large sketch is quick");
    }
  }
];
