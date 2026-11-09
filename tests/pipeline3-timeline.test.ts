import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { createPs3dCollaborationGuide, handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { analyzeDesignHealth } from "../packages/workbench-health/src/index.js";
import { rebuildDependents } from "../apps/studio-web/src/design-regeneration.js";
import { assert, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, line, message, pipelineApply, pipelineRun, rect, solidFeature, solidOf } from "./pipeline-kit.js";

/**
 * Wave 3, N2-07: ps3d_inspect_project and ps3d_design_health read the design timeline: the ids the recipes point to, the step that
 * failed and why, and a message that points an agent from a finished sketch's entity back to edit-design-sketch.
 */

async function brokenRevolve(): Promise<WorkbenchProject> {
  const { project: base, sketch } = committedSketch("datum:xy", [rect("r", 40, 10, 10, 20), line("cl", [30, -10], [30, 40], true)]);
  const built = solidOf(await buildSolid(sketch, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } }));
  const feature = { ...solidFeature("revolve", sketch, { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:cl" } }), id: "feature:rv", name: "Spindle", bodyId: "general-body:rv" };
  let project = pipelineRun(base, { kind: "add-design-solid", feature, body: { ...built, id: feature.bodyId, name: feature.name } });
  project = pipelineRun(project, { kind: "edit-design-sketch", featureId: "feature:s1" });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: ["entity:cl"], updateEntities: [], addEntities: [], addConstraints: [], label: "Delete the axis" });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Profile" });
  const results = await rebuildDependents(project, "feature:s1");
  return pipelineRun(project, { kind: "regenerate-design", results: results.map((result) => ({ featureId: result.featureId, ...(result.body === undefined ? {} : { body: result.body }), ...(result.message === undefined ? {} : { message: result.message }) })) });
}

export const pipeline3TimelineTests: readonly TestCase[] = [
  {
    name: "Wave3 N2-07: ps3d_inspect_project lists the timeline with its ids and ps3d_design_health reports a failed step",
    run: async () => {
      const project = await brokenRevolve();
      const failed = project.design?.features.find((feature) => feature.id === "feature:rv");
      assert(failed?.health !== undefined, `the fixture has a revolve whose rebuild failed: ${JSON.stringify(failed?.health)}`);

      const inspected = await handleWorkbenchMcpTool("ps3d_inspect_project", { project });
      assert(inspected.isError !== true, "the project is inspected");
      const timeline = inspected.structuredContent["timeline"] as { steps: number; failedFeatureIds: string[]; sketchFeatureIds: string[]; features: { id: string; kind: string; health?: { failed: boolean; message: string } }[]; bodies: { id: string }[] };
      assert(timeline !== undefined && timeline.steps === 2, `the summary has a timeline of two steps: ${JSON.stringify(inspected.structuredContent).slice(0, 200)}`);
      assert(timeline.sketchFeatureIds.includes("feature:s1"), "it lists the finished sketch's id");
      assert(timeline.failedFeatureIds.join() === "feature:rv", `and the failed step: ${timeline.failedFeatureIds.join()}`);
      const step = timeline.features.find((feature) => feature.id === "feature:rv");
      assert(step?.health?.failed === true && /no longer in its sketch/u.test(step.health.message), `with the reason: ${JSON.stringify(step?.health)}`);
      assert(timeline.bodies.length === 1, "and the solid bodies");

      const health = await handleWorkbenchMcpTool("ps3d_design_health", { project });
      assert(health.isError !== true, "design health runs");
      const findings = health.structuredContent["findings"] as { id: string; severity: string; relatedIds: string[]; message: string; recovery: string }[];
      const timelineFinding = findings.find((finding) => finding.id === "health:timeline-failed:feature:rv");
      assert(timelineFinding !== undefined && timelineFinding.severity === "error", `design health has a finding for the failed step: ${findings.map((finding) => finding.id).join(", ")}`);
      assert(timelineFinding !== undefined && /no longer in its sketch/u.test(timelineFinding.message) && timelineFinding.relatedIds.includes("feature:rv") && /edit-design-sketch/u.test(timelineFinding.recovery), "naming the reason, the step id and the way to repair it");
      assert(health.structuredContent["overallStatus"] === "blocked", "and the project is not reported healthy");

      // A project without trouble reports its steps and no timeline error.
      const { project: clean } = committedSketch("datum:xy", [rect("r", 0, 0, 20, 10)]);
      const cleanHealth = analyzeDesignHealth(clean);
      assert(cleanHealth.ok && !cleanHealth.value.findings.some((finding) => finding.id.startsWith("health:timeline-failed")), "a sound timeline raises no failure");
      const rolledBack = pipelineApply(clean, { kind: "set-design-rollback", index: 0 });
      assert(rolledBack.ok, `rolling the marker back works: ${message(rolledBack)}`);
      const rolledHealth = rolledBack.ok ? analyzeDesignHealth(rolledBack.value.project) : undefined;
      assert(rolledHealth?.ok === true && rolledHealth.value.findings.some((finding) => finding.id === "health:timeline-rollback"), "a rolled-back timeline is reported");
      void circ;
    }
  },
  {
    name: "Wave3 N2-07: addressing a finished sketch's curve in the working sketch says which sketch holds it and how to reopen it",
    run: async () => {
      const { project: finished } = committedSketch("datum:xy", [circ("hole", 0, 0, 5)]);
      // A new sketch replaces the working sketch; the circle now lives only in the finished sketch.
      const project = pipelineRun(finished, { kind: "new-design-sketch", plane: "datum:xz" });
      const result = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 6 });
      assert(!result.ok, "the working sketch no longer holds the circle");
      const text = result.ok ? "" : result.diagnostics.map((diagnostic) => `${diagnostic.message} ${diagnostic.recovery}`).join(" ");
      assert(/finished sketch/u.test(text) && /feature:s1/u.test(text) && /edit-design-sketch/u.test(text), `the refusal points at the finished sketch and edit-design-sketch: ${text}`);
      const other = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:nowhere", dimension: "radius", valueMm: 6 });
      assert(!other.ok && /entity:nowhere/u.test(message(other)), `an id that exists nowhere is named: ${message(other)}`);
      const ack = { manifestSha256: String((await createPs3dCollaborationGuide())["manifestSha256"]), understood: true };
      const viaMcp = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: { operationId: "operation:t-1", expectedRevision: project.revision, kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 6 }, guideAcknowledgement: ack });
      assert(viaMcp.isError === true && /edit-design-sketch/u.test(JSON.stringify(viaMcp.content)), "the MCP preview says the same");
    }
  }
];
