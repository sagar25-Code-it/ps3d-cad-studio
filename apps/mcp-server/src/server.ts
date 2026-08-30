import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import {
  PS3D_MCP_INSTRUCTIONS,
  PS3D_OPERATION_KINDS,
  PS3D_SUPPORTED_PROTOCOL_REVISIONS,
  createPs3dCollaborationGuide,
  handleWorkbenchMcpTool
} from "../../../packages/workbench-mcp/src/index.js";

const workspaceSchema = z.enum(["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"]);
const experienceLevelSchema = z.enum(["child", "beginner", "engineer", "advanced", "phd"]);
const engineeringTargetCadSchema = z.enum(["ps3d", "fusion-360", "solidworks", "nx", "creo", "catia-v5"]);
const projectSchema = z.object({
  format: z.string(), schemaVersion: z.literal(1), applicationVersion: z.string(), id: z.string(), name: z.string(),
  revision: z.number().int().nonnegative(), unit: z.literal("mm"), activeWorkspace: workspaceSchema,
  sketch: z.record(z.string(), z.unknown()), part: z.record(z.string(), z.unknown()), assembly: z.record(z.string(), z.unknown()),
  surface: z.record(z.string(), z.unknown()), drawing: z.record(z.string(), z.unknown()), electrical: z.record(z.string(), z.unknown()),
  vehicle: z.record(z.string(), z.unknown()), audit: z.array(z.record(z.string(), z.unknown())).max(500)
}).strict();
const operationSchema = z.object({
  operationId: z.string().regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u),
  expectedRevision: z.number().int().nonnegative(),
  kind: z.enum(PS3D_OPERATION_KINDS)
}).catchall(z.unknown());
const guideAcknowledgementSchema = z.object({
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  understood: z.literal(true)
}).strict();
const structuredOutputSchema = z.record(z.string(), z.unknown());

export function createPs3dMcpServer(): McpServer {
  const server = new McpServer({
    name: "ps3d-cad-studio",
    title: "PS3D CAD Studio",
    version: "0.2.0-preview.1",
    description: "Stateless, model-neutral tools for bounded PS3D workbench projects."
  }, {
    instructions: PS3D_MCP_INSTRUCTIONS,
    supportedProtocolVersions: [...PS3D_SUPPORTED_PROTOCOL_REVISIONS],
    cacheHints: {
      "server/discover": { ttlMs: 300_000, cacheScope: "private" },
      "tools/list": { ttlMs: 300_000, cacheScope: "private" },
      "prompts/list": { ttlMs: 300_000, cacheScope: "private" },
      "resources/list": { ttlMs: 300_000, cacheScope: "private" },
      "resources/read": { ttlMs: 300_000, cacheScope: "private" }
    }
  });

  server.registerTool("ps3d_guide", {
    title: "PS3D AI collaboration guide",
    description: "Return the model-neutral connection contract, safe workflow, limitations, and starter prompt.",
    inputSchema: z.object({}).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D AI collaboration guide", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toSdkResult(await handleWorkbenchMcpTool("ps3d_guide", {})));

  server.registerTool("ps3d_agent_handshake", {
    title: "PS3D collaboration agent handshake",
    description: "Configure a stateless host-AI/PS3D coordination pass, match bounded commands, and return correction feedback without executing CAD changes.",
    inputSchema: z.object({
      request: z.string().min(2).max(500),
      experienceLevel: experienceLevelSchema,
      workspace: workspaceSchema.optional(),
      clientName: z.string().min(1).max(80).optional(),
      projectRevision: z.number().int().nonnegative().optional(),
      proposedTool: z.string().min(1).max(80).optional(),
      proposedRecipeId: z.string().min(1).max(100).optional()
    }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D collaboration agent handshake", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args) => toSdkResult(await handleWorkbenchMcpTool("ps3d_agent_handshake", args)));

  server.registerTool("ps3d_plan_engineering_intent", {
    title: "PS3D engineering intent planner",
    description: "Decompose an ordinary part or assembly request into reusable definitions, ordered features, standards questions, interfaces, dependency packages, approval gates, and truthful execution routes without running CAD.",
    inputSchema: z.object({
      request: z.string().min(2).max(12_000),
      unit: z.enum(["mm", "in"]).optional(),
      workspace: workspaceSchema.optional(),
      experienceLevel: experienceLevelSchema.optional(),
      projectRevision: z.number().int().nonnegative().optional(),
      targetCad: z.array(engineeringTargetCadSchema).max(6).optional(),
      evidence: z.array(z.string().min(1).max(240)).max(40).optional()
    }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D engineering intent planner", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args) => toSdkResult(await handleWorkbenchMcpTool("ps3d_plan_engineering_intent", args)));

  server.registerTool("ps3d_find_commands", {
    title: "Find PS3D command recipes",
    description: "Match a plain-language engineering goal to bounded tool and operation templates without executing anything.",
    inputSchema: z.object({ query: z.string().min(2).max(160), workspace: workspaceSchema.optional(), limit: z.number().int().min(1).max(12).optional() }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "Find PS3D command recipes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query, workspace, limit }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_find_commands", { query, ...(workspace === undefined ? {} : { workspace }), ...(limit === undefined ? {} : { limit }) })));

  server.registerTool("ps3d_capabilities", {
    title: "PS3D capability matrix",
    description: "List qualified, preview, and unavailable PS3D CAD capabilities.",
    inputSchema: z.object({}).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D capability matrix", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toSdkResult(await handleWorkbenchMcpTool("ps3d_capabilities", {})));

  server.registerTool("ps3d_inspect_project", {
    title: "Inspect PS3D project",
    description: "Validate and summarize a supplied project without reading a file or modifying state.",
    inputSchema: z.object({ project: projectSchema }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "Inspect PS3D project", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_inspect_project", { project })));

  server.registerTool("ps3d_design_health", {
    title: "PS3D design health",
    description: "Analyze all CAD workspaces, actual dependency links, deterministic rebuild order, engineering findings, and release boundaries without modifying state.",
    inputSchema: z.object({ project: projectSchema }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D design health", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_design_health", { project })));

  server.registerTool("ps3d_analyze_vehicle", {
    title: "PS3D vehicle analysis",
    description: "Return deterministic topology, kinematic-invariant, brake, load, road-load, and operating-point screens for a supplied project. No regulatory, construction, roadworthiness, or safety approval is produced.",
    inputSchema: z.object({ project: projectSchema }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D vehicle analysis", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_analyze_vehicle", { project })));

  server.registerTool("ps3d_electromechanical_catalog", {
    title: "PS3D electromechanical catalog",
    description: "List the bounded local generic-envelope package catalog and terminal coordinates without network or asset discovery.",
    inputSchema: z.object({}).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "PS3D electromechanical catalog", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toSdkResult(await handleWorkbenchMcpTool("ps3d_electromechanical_catalog", {})));

  server.registerTool("ps3d_preview_electromechanical", {
    title: "Preview linked 3D realization",
    description: "Return a deterministic generic-envelope realization operation and receipt without applying it or controlling a live browser session.",
    inputSchema: z.object({ project: projectSchema, guideAcknowledgement: guideAcknowledgementSchema }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "Preview linked 3D realization", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project, guideAcknowledgement }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_preview_electromechanical", { project, guideAcknowledgement })));

  server.registerTool("ps3d_preview_operation", {
    title: "Preview PS3D operation",
    description: "Return a validated diff and receipt without mutating the supplied project.",
    inputSchema: z.object({ project: projectSchema, operation: operationSchema, guideAcknowledgement: guideAcknowledgementSchema }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "Preview PS3D operation", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project, operation, guideAcknowledgement }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_preview_operation", { project, operation, guideAcknowledgement })));

  server.registerTool("ps3d_apply_preview", {
    title: "Apply confirmed PS3D preview",
    description: "Return a new project only for a matching receipt and explicit confirmation; writes no external state.",
    inputSchema: z.object({
      project: projectSchema,
      operation: operationSchema,
      receipt: z.string().regex(/^[a-f0-9]{64}$/u),
      confirmed: z.literal(true),
      guideAcknowledgement: guideAcknowledgementSchema
    }).strict(),
    outputSchema: structuredOutputSchema,
    annotations: { title: "Apply confirmed PS3D preview", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ project, operation, receipt, confirmed, guideAcknowledgement }) => toSdkResult(await handleWorkbenchMcpTool("ps3d_apply_preview", { project, operation, receipt, confirmed, guideAcknowledgement })));

  server.registerResource("ps3d-ai-collaboration-guide", "ps3d://ai/collaboration-guide", {
    title: "PS3D AI collaboration guide",
    description: "Machine-readable protocol, command, safety, and workflow contract.",
    mimeType: "application/json",
    cacheHint: { ttlMs: 300_000, cacheScope: "private" }
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await createPs3dCollaborationGuide(), null, 2) }]
  }));

  server.registerPrompt("ps3d-guided-change", {
    title: "Plan a safe PS3D change",
    description: "Guide an AI host through bounded discovery, preview, exact review, confirmation, and returned-project handling.",
    argsSchema: z.object({ request: z.string().min(2).max(500), workspace: workspaceSchema.optional(), projectRevision: z.string().max(40).optional() }).strict()
  }, ({ request, workspace, projectRevision }) => ({
    description: "PS3D receipt-gated collaboration workflow",
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `${PS3D_MCP_INSTRUCTIONS}\n\nUser goal: ${request}\nWorkspace: ${workspace ?? "not specified"}\nProject revision: ${projectRevision ?? "not supplied"}\nAfter reading ps3d_guide, call ps3d_agent_handshake. For creation requests call ps3d_plan_engineering_intent, resolve its blockers, and then use ps3d_find_commands for exact bounded operations. Do not invent fields or claim a live-browser mutation.`
      }
    }]
  }));

  return server;
}

function toSdkResult(result: Awaited<ReturnType<typeof handleWorkbenchMcpTool>>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
} {
  const base = {
    content: result.content.map((entry) => ({ type: "text" as const, text: entry.text })),
    structuredContent: { ...result.structuredContent }
  };
  return result.isError === true ? { ...base, isError: true } : base;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void serveStdio(createPs3dMcpServer);
  console.error("PS3D MCP server listening on stdio; stdout is reserved for protocol messages.");
}
