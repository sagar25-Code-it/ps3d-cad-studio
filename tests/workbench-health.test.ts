import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeDesignHealth, buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchHealthTests: readonly TestCase[] = [
  {
    name: "design health analyzes all workspaces and truthful dependencies deterministically",
    run: () => {
      const project = createWorkbenchProject("project:health-default");
      const first = buildDesignHealthReport(project);
      const second = buildDesignHealthReport(project);
      equal(first.schema, "ps3d-design-health/1", "health report should expose a versioned schema");
      equal(first.workspaces.length, 8, "every broad CAD workspace should be analyzed");
      equal(first.rebuildOrder.join(","), "sketch,part,surface,electrical,assembly,vehicle,drawing,automate", "rebuild review order should remain deterministic");
      equal(JSON.stringify(first), JSON.stringify(second), "the same project must produce byte-equivalent structured health output");
      equal(first.dependencies.find((dependency) => dependency.id === "dependency:part-drawing")?.status, "current", "part-to-drawing should expose the real associative link");
      equal(first.dependencies.find((dependency) => dependency.id === "dependency:sketch-part")?.status, "detached", "sketch-to-part must not be misrepresented as associative");
      assert(first.releaseBoundary.includes("not a solver certificate"), "health assistance must retain the release boundary");
    }
  },
  {
    name: "design health converts sketch conflicts into blocking repair findings",
    run: () => {
      const project = createWorkbenchProject("project:health-conflict");
      const conflicted = {
        ...project,
        sketch: {
          ...project.sketch,
          entities: [{ id: "entity:health-axis", kind: "line", start: [0, 0], end: [20, 0], construction: false }] as const,
          constraints: [
            { id: "constraint:health-horizontal", kind: "horizontal", entityIds: ["entity:health-axis"] },
            { id: "constraint:health-vertical", kind: "vertical", entityIds: ["entity:health-axis"] }
          ] as const
        }
      };
      const report = buildDesignHealthReport(conflicted);
      equal(report.workspaces.find((workspace) => workspace.workspace === "sketch")?.status, "blocked", "conflicting sketch intent should block sketch health");
      assert(report.findings.some((finding) => finding.id === "health:sketch-conflict" && finding.severity === "error"), "the repair queue should explain the sketch conflict");
      equal(report.overallStatus, "blocked", "a blocked workspace should block overall health");
    }
  },
  {
    name: "design health rejects malformed caller projects before analysis",
    run: () => {
      const result = analyzeDesignHealth({ format: "not-a-ps3d-project" });
      assert(!result.ok, "malformed caller state must fail closed");
      assert(result.diagnostics.length > 0, "malformed state should return structured diagnostics");
    }
  }
];
