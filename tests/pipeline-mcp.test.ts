import { createWorkbenchProject, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { PS3D_AI_COMMAND_RECIPES, WORKBENCH_MCP_TOOLS, createPs3dCollaborationGuide, handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

type Json = Record<string, unknown>;

async function ack(): Promise<{ readonly manifestSha256: string; readonly understood: true }> {
  const guide = await createPs3dCollaborationGuide();
  return { manifestSha256: String(guide["manifestSha256"]), understood: true };
}

let serial = 0;

/** Previews an operation through the MCP tool, then applies it with its receipt, as a host would after the user confirms. */
async function step(project: WorkbenchProject, operation: Json): Promise<WorkbenchProject> {
  serial += 1;
  const full = { operationId: `operation:mcp-test-${serial}`, expectedRevision: project.revision, ...operation };
  const guideAcknowledgement = await ack();
  const preview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: full, guideAcknowledgement });
  assert(preview.isError !== true, `preview of ${String(operation["kind"])} works: ${JSON.stringify(preview.structuredContent).slice(0, 300)}`);
  const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation: full, receipt: preview.structuredContent["receipt"], confirmed: true, guideAcknowledgement });
  assert(applied.isError !== true, `apply of ${String(operation["kind"])} works`);
  return applied.structuredContent["project"] as WorkbenchProject;
}

async function prepareAndApply(project: WorkbenchProject, solid: Json): Promise<{ readonly project: WorkbenchProject; readonly solid: Json }> {
  const guideAcknowledgement = await ack();
  const prepared = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project, solid, guideAcknowledgement });
  assert(prepared.isError !== true, `the solid is prepared: ${JSON.stringify(prepared.structuredContent).slice(0, 300)}`);
  const operation = prepared.structuredContent["operation"] as Json;
  assert(operation["kind"] === "add-design-solid", "the tool returns the add-design-solid operation");
  const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt: prepared.structuredContent["receipt"], confirmed: true, guideAcknowledgement });
  assert(applied.isError !== true, `the prepared solid applies: ${JSON.stringify(applied.structuredContent).slice(0, 300)}`);
  return { project: applied.structuredContent["project"] as WorkbenchProject, solid: prepared.structuredContent["solid"] as Json };
}

const rectangle = (id: string, cx: number, cy: number, w: number, h: number): Json => ({ id: `entity:${id}`, kind: "rectangle", center: [cx, cy], widthMm: w, heightMm: h, rotationDeg: 0, construction: false });

export const pipelineMcpTests: readonly TestCase[] = [
  {
    name: "MCP an agent can make a sketch-to-solid model: plane choice, a batch sketch edit, commit, extrude, cut and a revolve about a drawn axis",
    run: async () => {
      let project = createWorkbenchProject("project:mcp-sketch");
      // The project schema now carries the timeline, so a project with a finished sketch can be sent at all.
      const previewTool = WORKBENCH_MCP_TOOLS.find((tool) => tool.name === "ps3d_preview_operation")!;
      const projectProperties = ((previewTool.inputSchema["properties"] as Json)["project"] as Json)["properties"] as Json;
      assert(Object.hasOwn(projectProperties, "design"), "the MCP project schema accepts the design timeline");

      project = await step(project, { kind: "new-design-sketch", plane: "datum:xz" });
      project = await step(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rectangle("base", 0, 0, 60, 40)], addConstraints: [], label: "Draw base" });
      project = await step(project, { kind: "commit-design-sketch", featureId: "feature:mcp-base", name: "Base profile" });

      const base = await prepareAndApply(project, { kind: "extrude", sketchFeatureId: "feature:mcp-base", valueMm: 20, name: "Base" });
      project = base.project;
      near(base.solid["volumeMm3"] as number, 60 * 40 * 20, 60 * 40 * 20 * 0.005, "the extrusion has the volume of the box");
      equal(project.part.generalBodies?.length, 1, "the solid is in the returned project");

      // A hole sketch on the same plane, cut through the base.
      project = await step(project, { kind: "new-design-sketch", plane: "datum:xz" });
      project = await step(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:bore", kind: "circle", center: [0, 0], radiusMm: 5, construction: false }], addConstraints: [], label: "Draw bore" });
      project = await step(project, { kind: "commit-design-sketch", featureId: "feature:mcp-bore", name: "Bore profile" });
      const bodyId = project.part.generalBodies![0]!.id;
      const cut = await prepareAndApply(project, { kind: "extrude", sketchFeatureId: "feature:mcp-bore", valueMm: 20, operation: "cut", targetBodyId: bodyId });
      project = cut.project;
      near(cut.solid["volumeMm3"] as number, 60 * 40 * 20 - Math.PI * 25 * 20, 60 * 40 * 20 * 0.02, "the cut removes the bore from the base");
      equal(project.part.generalBodies?.length, 1, "a cut changes the solid instead of adding one");

      // Revolve about a construction line drawn in the sketch.
      project = await step(project, { kind: "new-design-sketch", plane: "datum:xy" });
      project = await step(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rectangle("ring", 40, 10, 10, 20), { id: "entity:axis", kind: "line", start: [30, -10], end: [30, 40], construction: true }], addConstraints: [], label: "Draw ring section" });
      project = await step(project, { kind: "commit-design-sketch", featureId: "feature:mcp-ring", name: "Ring section" });
      const ring = await prepareAndApply(project, { kind: "revolve", sketchFeatureId: "feature:mcp-ring", valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: "entity:axis" } });
      near(ring.solid["volumeMm3"] as number, Math.PI * (225 - 25) * 20, Math.PI * 200 * 20 * 0.01, "the revolve turns about the drawn axis, not the sketch Y axis");
      equal(ring.project.part.generalBodies?.length, 2, "the revolve is a second solid");

      // Refusals say what to fix.
      const guideAcknowledgement = await ack();
      const unknown = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project, solid: { kind: "extrude", sketchFeatureId: "feature:nope", valueMm: 5 }, guideAcknowledgement });
      assert(unknown.isError === true && /Finished sketches: .*feature:mcp-base/u.test(JSON.stringify(unknown.structuredContent)), "an unknown sketch lists the finished ones");
      const extra = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project, solid: { kind: "extrude", sketchFeatureId: "feature:mcp-base", valueMm: 5, colour: "red" }, guideAcknowledgement });
      assert(extra.isError === true && /unsupported field/u.test(JSON.stringify(extra.structuredContent)), "an unsupported field is named");
      const noGuide = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project, solid: { kind: "extrude", sketchFeatureId: "feature:mcp-base", valueMm: 5 } });
      assert(noGuide.isError === true, "the guide acknowledgement is required like for every preview");
      const needsTarget = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project, solid: { kind: "extrude", sketchFeatureId: "feature:mcp-base", valueMm: 5, operation: "join" }, guideAcknowledgement });
      assert(needsTarget.isError === true && /targetBodyId/u.test(JSON.stringify(needsTarget.structuredContent)), "a join without a target says so");

      const recipeIds = PS3D_AI_COMMAND_RECIPES.map((recipe) => recipe.id);
      for (const id of ["sketch-new-plane", "sketch-edit-batch", "sketch-commit", "design-solid", "design-parameters", "design-timeline"]) assert(recipeIds.includes(`ai-command:${id}`), `the recipe ${id} is listed`);
    }
  }
];
