import { createWorkbenchProject, WORKBENCH_OPERATION_KINDS, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { PS3D_AI_COMMAND_RECIPES, PS3D_OPERATION_KINDS, handleWorkbenchMcpTool, WORKBENCH_MCP_TOOLS } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchMcpTests: readonly TestCase[] = [
  {
    name: "MCP capability surface has truthful safety annotations",
    run: async () => {
      equal(WORKBENCH_MCP_TOOLS.length, 12, "the bounded server should expose twelve truth-labeled tools");
      assert(WORKBENCH_MCP_TOOLS.every((tool) => tool.annotations.openWorldHint === false), "local tools must not imply open-world access");
      assert(WORKBENCH_MCP_TOOLS.every((tool) => tool.annotations.destructiveHint === false), "tools return data and never destroy external state");
      assert(WORKBENCH_MCP_TOOLS.every((tool) => tool.inputSchema["type"] === "object" && tool.outputSchema["type"] === "object"), "every tool should publish object input and output schemas");
      const inspectSchema = WORKBENCH_MCP_TOOLS.find((tool) => tool.name === "ps3d_inspect_project")?.inputSchema;
      equal(JSON.stringify(inspectSchema?.["required"]), JSON.stringify(["project"]), "read-only inspect schema should match its one-argument handler");
      const electromechanicalSchema = WORKBENCH_MCP_TOOLS.find((tool) => tool.name === "ps3d_preview_electromechanical")?.inputSchema;
      equal(JSON.stringify(electromechanicalSchema?.["required"]), JSON.stringify(["project", "guideAcknowledgement"]), "electromechanical preview schema should advertise its guide gate");
      const result = await handleWorkbenchMcpTool("ps3d_capabilities", {});
      assert(result.isError !== true, "capability query should succeed");
      equal(result.structuredContent["schema"], "ps3d-capabilities/1", "capability schema should be versioned");
      equal((result.structuredContent["operationKinds"] as readonly string[]).length, PS3D_OPERATION_KINDS.length, "capability response should enumerate canonical operation kinds");
      equal(PS3D_OPERATION_KINDS.length, 67, "all validated workbench operation kinds should be AI-visible");
      equal(JSON.stringify(PS3D_OPERATION_KINDS), JSON.stringify(WORKBENCH_OPERATION_KINDS), "MCP operation discovery must use the core canonical registry without drift");
      assert(PS3D_OPERATION_KINDS.includes("add-assembly-components"), "grouped Master Cart insertion must remain AI-visible");
    }
  },
  {
    name: "MCP collaboration guide is deterministic and honest about host boundaries",
    run: async () => {
      const first = await handleWorkbenchMcpTool("ps3d_guide", {});
      const second = await handleWorkbenchMcpTool("ps3d_guide", {});
      assert(first.isError !== true && second.isError !== true, "guide should be readable without arguments");
      equal(first.structuredContent["schema"], "ps3d-ai-collaboration/3", "guide schema should be versioned");
      equal(first.structuredContent["manifestSha256"], second.structuredContent["manifestSha256"], "guide digest should be deterministic");
      const state = first.structuredContent["state"] as Readonly<Record<string, unknown>>;
      equal(state["browserSessionConnected"], false, "guide must not claim live browser control");
      const protocol = first.structuredContent["protocol"] as Readonly<Record<string, unknown>>;
      equal(protocol["preferredRevision"], "2026-07-28", "guide should prefer the current modern revision");
      assert(first.content.some((entry) => entry.text.startsWith("{") && entry.text.endsWith("}")), "structured guide should also be serialized as text for compatibility");
    }
  },
  {
    name: "MCP collaboration agent adapts depth and corrects invalid host proposals without execution",
    run: async () => {
      const ready = await handleWorkbenchMcpTool("ps3d_agent_handshake", {
        request: "change motorcycle wheelbase",
        experienceLevel: "engineer",
        workspace: "vehicle",
        clientName: "test-host",
        projectRevision: 4,
        proposedTool: "ps3d_preview_operation",
        proposedRecipeId: "ai-command:vehicle-parameter"
      });
      assert(ready.isError !== true, "valid collaboration handshake should succeed");
      equal(ready.structuredContent["schema"], "ps3d-agent-handshake/1", "agent handshake schema should be versioned");
      equal(ready.structuredContent["status"], "ready-to-inspect", "matching stable IDs should be ready for inspection");
      const activation = ready.structuredContent["activation"] as Readonly<Record<string, unknown>>;
      equal(activation["persistentSession"], false, "modern MCP coordination must remain stateless");
      equal(activation["hiddenModel"], false, "the deterministic coordinator must not claim a hidden AI model");
      const audience = ready.structuredContent["audience"] as Readonly<Record<string, unknown>>;
      equal(audience["level"], "engineer", "experience-level guidance should be explicit");
      const proposal = ready.structuredContent["proposal"] as Readonly<Record<string, unknown>>;
      equal(proposal["executionPerformed"], false, "handshake must never execute a matched intent");

      const corrected = await handleWorkbenchMcpTool("ps3d_agent_handshake", {
        request: "change motorcycle wheelbase",
        experienceLevel: "phd",
        workspace: "vehicle",
        proposedTool: "ps3d_invent_mate",
        proposedRecipeId: "ai-command:missing"
      });
      equal(corrected.structuredContent["status"], "needs-correction", "unknown stable IDs should fail into a correction state");
      const feedback = corrected.structuredContent["feedback"] as readonly Readonly<Record<string, unknown>>[];
      assert(feedback.some((item) => item["code"] === "UNKNOWN_MCP_TOOL") && feedback.some((item) => item["code"] === "UNKNOWN_RECIPE_ID"), "invalid host proposals should receive typed correction feedback");
    }
  },
  {
    name: "MCP command finder matches bounded recipes without execution",
    run: async () => {
      const result = await handleWorkbenchMcpTool("ps3d_find_commands", { query: "change motorcycle wheelbase", workspace: "vehicle", limit: 5 });
      assert(result.isError !== true, "valid command search should succeed");
      equal(result.structuredContent["schema"], "ps3d-command-search/1", "command search schema should be versioned");
      equal(result.structuredContent["executionPerformed"], false, "command search must never execute text");
      const matches = result.structuredContent["matches"] as readonly Readonly<Record<string, unknown>>[];
      assert(matches.some((match) => match["id"] === "ai-command:vehicle-parameter"), "vehicle wheelbase phrase should resolve to the bounded vehicle recipe");
      assert(PS3D_AI_COMMAND_RECIPES.every((recipe) => recipe.id.startsWith("ai-command:")), "recipe IDs should use a separate namespace from MCP tools and UI commands");

      const invalid = await handleWorkbenchMcpTool("ps3d_find_commands", { query: "x" });
      assert(invalid.isError === true, "undersized natural-language input should fail closed");

      const dimension = await handleWorkbenchMcpTool("ps3d_find_commands", { query: "dimension selected sketch circle radius", workspace: "sketch" });
      assert((dimension.structuredContent["matches"] as readonly Readonly<Record<string, unknown>>[]).some((match) => match["id"] === "ai-command:sketch-dimension"), "direct sketch dimensions should have a bounded AI recipe");
      const mate = await handleWorkbenchMcpTool("ps3d_find_commands", { query: "mate two assembly components on z axis", workspace: "assembly" });
      assert((mate.structuredContent["matches"] as readonly Readonly<Record<string, unknown>>[]).some((match) => match["id"] === "ai-command:assembly-mate"), "assembly mates should have a bounded AI recipe");
      const cart = await handleWorkbenchMcpTool("ps3d_find_commands", { query: "insert master cart fastener group", workspace: "assembly" });
      assert((cart.structuredContent["matches"] as readonly Readonly<Record<string, unknown>>[]).some((match) => match["id"] === "ai-command:assembly-insert-group"), "grouped Master Cart insertion should have a bounded AI recipe");
    }
  },
  {
    name: "MCP inspection validates supplied data without mutating it",
    run: async () => {
      const project = createWorkbenchProject("project:test-mcp-inspect");
      const before = JSON.stringify(project);
      const result = await handleWorkbenchMcpTool("ps3d_inspect_project", { project });
      assert(result.isError !== true, "valid project inspection should succeed");
      equal(result.structuredContent["revision"], 0, "summary should report current revision");
      equal(JSON.stringify(project), before, "inspection must leave caller state unchanged");
    }
  },
  {
    name: "MCP design health exposes deterministic cross-workspace review without mutation",
    run: async () => {
      const project = createWorkbenchProject("project:test-mcp-health");
      const before = JSON.stringify(project);
      const result = await handleWorkbenchMcpTool("ps3d_design_health", { project });
      assert(result.isError !== true, "valid design-health review should succeed");
      equal(result.structuredContent["schema"], "ps3d-design-health/1", "design-health schema should be versioned");
      equal((result.structuredContent["workspaces"] as readonly unknown[]).length, 8, "health tool should analyze all workspaces");
      equal(JSON.stringify(project), before, "health analysis must leave caller state unchanged");

      const found = await handleWorkbenchMcpTool("ps3d_find_commands", { query: "rebuild all and check model health", limit: 4 });
      const matches = found.structuredContent["matches"] as readonly Readonly<Record<string, unknown>>[];
      assert(matches.some((match) => match["id"] === "ai-command:design-health"), "plain-language rebuild review should resolve to the health tool");
    }
  },
  {
    name: "MCP preview receipt gates a confirmed apply",
    run: async () => {
      const guideAcknowledgement = await currentGuideAcknowledgement();
      const project = createWorkbenchProject("project:test-mcp-preview");
      const operation: WorkbenchOperation = {
        kind: "set-surface-mode",
        operationId: "operation:test-mcp-surface",
        expectedRevision: 0,
        mode: "loft"
      };
      const missingGuide = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation });
      assert(missingGuide.isError === true, "preview without reading and acknowledging the guide should fail closed");
      equal(missingGuide.structuredContent["code"], "INSTRUCTION_ACKNOWLEDGEMENT_REQUIRED", "missing-guide failure should be typed");

      const staleGuide = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation, guideAcknowledgement: { manifestSha256: "0".repeat(64), understood: true } });
      assert(staleGuide.isError === true, "preview with a stale guide digest should fail closed");
      equal(staleGuide.structuredContent["code"], "STALE_INSTRUCTION_ACKNOWLEDGEMENT", "stale-guide failure should be typed");

      const preview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation, guideAcknowledgement });
      assert(preview.isError !== true, "valid operation should preview");
      const receipt = preview.structuredContent["receipt"];
      assert(typeof receipt === "string" && /^[a-f0-9]{64}$/u.test(receipt), "preview should return a SHA-256 receipt");
      equal(project.revision, 0, "preview must not mutate the supplied project");
      const candidate = preview.structuredContent["candidateProject"] as WorkbenchProject;
      equal(candidate.revision, 1, "preview should disclose the exact candidate revision");
      equal(candidate.surface.mode, "loft", "preview should disclose the exact candidate state");
      const receiptInfo = preview.structuredContent["receiptInfo"] as Readonly<Record<string, unknown>>;
      equal(receiptInfo["signed"], false, "receipt should not be mislabeled as a signature");
      equal(receiptInfo["approvalProof"], false, "receipt should not be mislabeled as approval evidence");

      const unconfirmed = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt, confirmed: false, guideAcknowledgement });
      assert(unconfirmed.isError === true, "apply without confirmation should fail");
      equal(unconfirmed.structuredContent["code"], "CONFIRMATION_REQUIRED", "confirmation failure should be typed");

      const mismatch = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt: "0".repeat(64), confirmed: true, guideAcknowledgement });
      assert(mismatch.isError === true, "wrong receipt should fail");
      equal(mismatch.structuredContent["code"], "PREVIEW_RECEIPT_MISMATCH", "receipt failure should be typed");

      const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt, confirmed: true, guideAcknowledgement });
      assert(applied.isError !== true, "matching confirmed receipt should apply");
      const next = applied.structuredContent["project"] as WorkbenchProject;
      equal(next.revision, 1, "confirmed apply should return the next revision");
      equal(next.surface.mode, "loft", "confirmed intent should be represented in the returned project");
      equal(project.revision, 0, "server should still not mutate caller state");

      const retry = await handleWorkbenchMcpTool("ps3d_preview_operation", { project: next, operation, guideAcknowledgement });
      assert(retry.isError !== true, "exact idempotent retry should preview");
      equal(retry.structuredContent["exactRetry"], true, "exact retry should be labeled");
      equal(retry.structuredContent["baseRevision"], 1, "exact retry should report the actual current base revision");
      equal(retry.structuredContent["nextRevision"], 1, "exact retry should not invent a new revision");
      const retryReceipt = retry.structuredContent["receiptInfo"] as Readonly<Record<string, unknown>>;
      equal(retryReceipt["disposition"], "exact-retry", "receipt metadata should identify exact retries");
    }
  },
  {
    name: "MCP previews direct sketch dimensions, mates, and grouped components with typed correction",
    run: async () => {
      const guideAcknowledgement = await currentGuideAcknowledgement();
      const project = createWorkbenchProject("project:test-mcp-cad-authoring");
      const dimension: WorkbenchOperation = {
        kind: "set-sketch-dimension",
        operationId: "operation:test-sketch-radius",
        expectedRevision: 0,
        entityId: "entity:centered-bore-profile",
        dimension: "radius",
        valueMm: 6
      };
      const dimensionPreview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: dimension, guideAcknowledgement });
      assert(dimensionPreview.isError !== true, "a compatible direct sketch dimension should preview");
      const dimensionCandidate = dimensionPreview.structuredContent["candidateProject"] as WorkbenchProject;
      const circle = dimensionCandidate.sketch.entities.find((entity) => entity.id === "entity:centered-bore-profile");
      assert(circle?.kind === "circle" && circle.radiusMm === 6, "dimension preview should disclose the resized selected circle");
      assert(dimensionCandidate.sketch.constraints.some((constraint) => constraint.entityIds.includes("entity:centered-bore-profile") && constraint.dimension === "radius" && constraint.valueMm === 6), "dimension preview should create or update the driving constraint record");

      const mate: WorkbenchOperation = {
        kind: "add-assembly-mate",
        operationId: "operation:test-new-mate",
        expectedRevision: 0,
        mate: { id: "mate:test-base-cap", name: "Base to cap test", kind: "aligned-axis", componentIds: ["component:base", "component:cap"], axis: "z", status: "satisfied" }
      };
      const matePreview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: mate, guideAcknowledgement });
      assert(matePreview.isError !== true, "a mate between inspected component IDs should preview");
      const mateCandidate = matePreview.structuredContent["candidateProject"] as WorkbenchProject;
      assert(mateCandidate.assembly.mates.some((entry) => entry.id === "mate:test-base-cap"), "mate preview should disclose the new direct-mate record");

      const badMate = { ...mate, operationId: "operation:test-bad-mate", mate: { ...mate.mate, id: "mate:test-missing", componentIds: ["component:base", "component:missing"] } };
      const rejected = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: badMate, guideAcknowledgement });
      assert(rejected.isError === true, "a mate that invents a component ID must fail closed");
      equal(rejected.structuredContent["code"], "INVALID_OPERATION", "missing mate references should return a typed correction response");

      const grouped: WorkbenchOperation = {
        kind: "add-assembly-components",
        operationId: "operation:test-grouped-components",
        expectedRevision: 0,
        components: [
          { id: "component:test-group-a", name: "Grouped A", shape: "cylinder", grounded: false, visible: true, color: "#b8bdc5", translationMm: [0, 0, 0], rotationDeg: [0, 0, 0], sizeMm: [8, 8, 20], explosionDirection: [1, 0, 0] },
          { id: "component:test-group-b", name: "Grouped B", shape: "ring", grounded: false, visible: true, color: "#9ea4ad", translationMm: [0, 0, 10], rotationDeg: [0, 0, 0], sizeMm: [14, 8, 3], explosionDirection: [1, 0, 0] }
        ]
      };
      const groupedPreview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation: grouped, guideAcknowledgement });
      assert(groupedPreview.isError !== true, "a valid grouped component insertion should preview atomically");
      const groupedCandidate = groupedPreview.structuredContent["candidateProject"] as WorkbenchProject;
      assert(groupedCandidate.assembly.components.some((component) => component.id === "component:test-group-a") && groupedCandidate.assembly.components.some((component) => component.id === "component:test-group-b"), "grouped preview should disclose every inserted component");
    }
  },
  {
    name: "MCP rejects unknown tools and oversized input",
    run: async () => {
      const unknown = await handleWorkbenchMcpTool("ps3d_delete_everything", {});
      assert(unknown.isError === true, "unknown methods should fail closed");
      equal(unknown.structuredContent["code"], "METHOD_NOT_FOUND", "unknown method should be typed");

      const oversized = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: { data: "x".repeat(1_100_000) } });
      assert(oversized.isError === true, "oversized tool payload should be rejected");
      equal(oversized.structuredContent["code"], "RESOURCE_LIMIT", "resource failure should be typed");

      const malformed = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: {} });
      assert(malformed.isError === true, "malformed project should fail");
      assert(Array.isArray(malformed.structuredContent["diagnostics"]), "errors should preserve complete structured diagnostics for self-correction");
    }
  }
];

async function currentGuideAcknowledgement(): Promise<Readonly<Record<string, unknown>>> {
  const guide = await handleWorkbenchMcpTool("ps3d_guide", {});
  const manifestSha256 = guide.structuredContent["manifestSha256"];
  assert(typeof manifestSha256 === "string", "guide should provide a manifest digest");
  return { manifestSha256, understood: true };
}
