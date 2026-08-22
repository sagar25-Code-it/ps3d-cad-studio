import { createWorkbenchProject, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { PS3D_AI_COMMAND_RECIPES, PS3D_OPERATION_KINDS, handleWorkbenchMcpTool, WORKBENCH_MCP_TOOLS } from "../packages/workbench-mcp/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const workbenchMcpTests: readonly TestCase[] = [
  {
    name: "MCP capability surface has truthful safety annotations",
    run: async () => {
      equal(WORKBENCH_MCP_TOOLS.length, 10, "the bounded server should expose ten truth-labeled tools");
      assert(WORKBENCH_MCP_TOOLS.every((tool) => tool.annotations.openWorldHint === false), "local tools must not imply open-world access");
      assert(WORKBENCH_MCP_TOOLS.every((tool) => tool.annotations.destructiveHint === false), "tools return data and never destroy external state");
      assert(WORKBENCH_MCP_TOOLS.every((tool) => tool.inputSchema["type"] === "object" && tool.outputSchema["type"] === "object"), "every tool should publish object input and output schemas");
      const result = await handleWorkbenchMcpTool("ps3d_capabilities", {});
      assert(result.isError !== true, "capability query should succeed");
      equal(result.structuredContent["schema"], "ps3d-capabilities/1", "capability schema should be versioned");
      equal((result.structuredContent["operationKinds"] as readonly string[]).length, PS3D_OPERATION_KINDS.length, "capability response should enumerate canonical operation kinds");
    }
  },
  {
    name: "MCP collaboration guide is deterministic and honest about host boundaries",
    run: async () => {
      const first = await handleWorkbenchMcpTool("ps3d_guide", {});
      const second = await handleWorkbenchMcpTool("ps3d_guide", {});
      assert(first.isError !== true && second.isError !== true, "guide should be readable without arguments");
      equal(first.structuredContent["schema"], "ps3d-ai-collaboration/1", "guide schema should be versioned");
      equal(first.structuredContent["manifestSha256"], second.structuredContent["manifestSha256"], "guide digest should be deterministic");
      const state = first.structuredContent["state"] as Readonly<Record<string, unknown>>;
      equal(state["browserSessionConnected"], false, "guide must not claim live browser control");
      const protocol = first.structuredContent["protocol"] as Readonly<Record<string, unknown>>;
      equal(protocol["preferredRevision"], "2026-07-28", "guide should prefer the current modern revision");
      assert(first.content.some((entry) => entry.text.startsWith("{") && entry.text.endsWith("}")), "structured guide should also be serialized as text for compatibility");
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
      const project = createWorkbenchProject("project:test-mcp-preview");
      const operation: WorkbenchOperation = {
        kind: "set-surface-mode",
        operationId: "operation:test-mcp-surface",
        expectedRevision: 0,
        mode: "loft"
      };
      const preview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation });
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

      const unconfirmed = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt, confirmed: false });
      assert(unconfirmed.isError === true, "apply without confirmation should fail");
      equal(unconfirmed.structuredContent["code"], "CONFIRMATION_REQUIRED", "confirmation failure should be typed");

      const mismatch = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt: "0".repeat(64), confirmed: true });
      assert(mismatch.isError === true, "wrong receipt should fail");
      equal(mismatch.structuredContent["code"], "PREVIEW_RECEIPT_MISMATCH", "receipt failure should be typed");

      const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt, confirmed: true });
      assert(applied.isError !== true, "matching confirmed receipt should apply");
      const next = applied.structuredContent["project"] as WorkbenchProject;
      equal(next.revision, 1, "confirmed apply should return the next revision");
      equal(next.surface.mode, "loft", "confirmed intent should be represented in the returned project");
      equal(project.revision, 0, "server should still not mutate caller state");

      const retry = await handleWorkbenchMcpTool("ps3d_preview_operation", { project: next, operation });
      assert(retry.isError !== true, "exact idempotent retry should preview");
      equal(retry.structuredContent["exactRetry"], true, "exact retry should be labeled");
      equal(retry.structuredContent["baseRevision"], 1, "exact retry should report the actual current base revision");
      equal(retry.structuredContent["nextRevision"], 1, "exact retry should not invent a new revision");
      const retryReceipt = retry.structuredContent["receiptInfo"] as Readonly<Record<string, unknown>>;
      equal(retryReceipt["disposition"], "exact-retry", "receipt metadata should identify exact retries");
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
