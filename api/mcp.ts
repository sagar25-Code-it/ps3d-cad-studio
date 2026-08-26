import {
  PS3D_MCP_INSTRUCTIONS,
  PS3D_SUPPORTED_PROTOCOL_REVISIONS,
  WORKBENCH_MCP_TOOLS,
  createPs3dCollaborationGuide,
  handleWorkbenchMcpTool,
  type McpToolDefinition
} from "../packages/workbench-mcp/src/index.js";
import {
  authenticateMcpRequest,
  cloudConfigurationErrorResponse,
  consumeMcpQuota,
  hasMcpScope,
  loadCloudEnvironment,
  recordTokenUse,
  type McpPrincipal,
  type McpScope
} from "./_lib/cloud.js";
import { MAX_MCP_JSON_BYTES, apiError, isAllowedMcpOrigin, isRecord, methodNotAllowed, readJsonObject, requestBodyErrorResponse } from "./_lib/http.js";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

const GUIDE_URI = "ps3d://ai/collaboration-guide";

async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!isAllowedMcpOrigin(request)) return apiError(403, "ORIGIN_REJECTED", "This browser origin is not allowed to call the MCP endpoint.");
  try {
    const env = loadCloudEnvironment();
    const principal = await authenticateMcpRequest(request, env);
    if (principal instanceof Response) return principal;
    const quota = await consumeMcpQuota(principal, env);
    if (quota instanceof Response) return quota;
    if (!quota.allowed) {
      return apiError(429, "MCP_RATE_LIMIT", "This identity has reached the 60 requests per minute limit.", {
        "Retry-After": secondsUntil(quota.resetAt).toString(),
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": quota.resetAt
      });
    }
    const body = await readJsonObject(request, MAX_MCP_JSON_BYTES);
    const parsed = parseJsonRpcRequest(body);
    if (parsed instanceof Response) return parsed;
    const response = await dispatchMcp(parsed, principal, request);
    await recordTokenUse(principal, env);
    const protocolVersion = negotiatedProtocol(request, parsed);
    const wireResponse = response === undefined ? undefined : stampModernServerIdentity(response, protocolVersion);
    const headers: Readonly<Record<string, string>> = {
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": Math.max(0, quota.remaining).toString(),
      "X-RateLimit-Reset": quota.resetAt,
      "MCP-Protocol-Version": protocolVersion
    };
    if (wireResponse === undefined) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store", ...headers } });
    return new Response(JSON.stringify(wireResponse), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
    });
  } catch (error) {
    return requestBodyErrorResponse(error) ?? cloudConfigurationErrorResponse(error) ?? apiError(500, "MCP_INTERNAL_ERROR", "The MCP request could not be completed.");
  }
}

export default { fetch: handler };

function parseJsonRpcRequest(body: Readonly<Record<string, unknown>>): JsonRpcRequest | Response {
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || body.method.length === 0 || body.method.length > 120) {
    return jsonRpcError(null, -32600, "Invalid Request", "Expected one JSON-RPC 2.0 request object.");
  }
  if (body.id !== undefined && body.id !== null && typeof body.id !== "string" && typeof body.id !== "number") {
    return jsonRpcError(null, -32600, "Invalid Request", "The JSON-RPC id must be a string, number, or null.");
  }
  if (body.params !== undefined && !isRecord(body.params)) return jsonRpcError(body.id ?? null, -32602, "Invalid params", "params must be an object.");
  return {
    jsonrpc: "2.0",
    ...(body.id === undefined ? {} : { id: body.id as string | number | null }),
    method: body.method,
    ...(body.params === undefined ? {} : { params: body.params })
  };
}

async function dispatchMcp(message: JsonRpcRequest, principal: McpPrincipal, request: Request): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (message.method.startsWith("notifications/")) return undefined;
  const id = message.id ?? null;
  if (message.method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: negotiatedProtocol(request, message),
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false }
      },
      serverInfo: { name: "ps3d-cad-studio", title: "PS3D CAD Studio", version: "0.2.0-preview.1" },
      instructions: PS3D_MCP_INSTRUCTIONS
    });
  }
  if (message.method === "ping") return jsonRpcResult(id, {});
  if (message.method === "server/discover") {
    return jsonRpcResult(id, {
      supportedVersions: ["2026-07-28"],
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false }
      },
      instructions: PS3D_MCP_INSTRUCTIONS,
      ttlMs: 300_000,
      cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "ps3d-cad-studio", title: "PS3D CAD Studio", version: "0.2.0-preview.1" } }
    });
  }
  if (message.method === "tools/list") return jsonRpcResult(id, cacheableResult(request, message, { tools: accessibleTools(principal) }));
  if (message.method === "tools/call") return callTool(id, message.params, principal);
  if (message.method === "resources/list") {
    return jsonRpcResult(id, cacheableResult(request, message, { resources: [{ uri: GUIDE_URI, name: "ps3d-ai-collaboration-guide", title: "PS3D AI collaboration guide", description: "Machine-readable PS3D connection, safety, and workflow contract.", mimeType: "application/json" }] }));
  }
  if (message.method === "resources/read") return readResource(id, message.params, isModernRequest(request, message));
  if (message.method === "prompts/list") {
    return jsonRpcResult(id, cacheableResult(request, message, { prompts: [{ name: "ps3d-guided-change", title: "Plan a safe PS3D change", description: "Guide an AI host through discovery, collaboration-agent correction, preview, review, confirmation, and returned-project handling.", arguments: [{ name: "request", description: "The engineering goal", required: true }, { name: "workspace", description: "Optional PS3D workspace", required: false }] }] }));
  }
  if (message.method === "prompts/get") return getPrompt(id, message.params);
  return jsonRpcErrorObject(id, -32601, "Method not found", `Unsupported MCP method: ${message.method}`);
}

async function callTool(id: string | number | null, params: Readonly<Record<string, unknown>> | undefined, principal: McpPrincipal): Promise<Readonly<Record<string, unknown>>> {
  if (params === undefined || typeof params.name !== "string" || params.name.length > 120 || (params.arguments !== undefined && !isRecord(params.arguments))) {
    return jsonRpcErrorObject(id, -32602, "Invalid params", "tools/call requires a tool name and optional arguments object.");
  }
  const tool = WORKBENCH_MCP_TOOLS.find((candidate) => candidate.name === params.name);
  if (tool === undefined) return jsonRpcErrorObject(id, -32602, "Unknown tool", "The requested PS3D tool is not registered.");
  const requiredScope = scopeForTool(tool);
  if (!hasMcpScope(principal, requiredScope)) return jsonRpcErrorObject(id, -32003, "Insufficient scope", `This token requires ${requiredScope} for ${tool.name}.`);
  const result = await handleWorkbenchMcpTool(tool.name, params.arguments ?? {});
  return jsonRpcResult(id, {
    content: result.content,
    structuredContent: result.structuredContent,
    ...(result.isError === true ? { isError: true } : {})
  });
}

async function readResource(id: string | number | null, params: Readonly<Record<string, unknown>> | undefined, modern: boolean): Promise<Readonly<Record<string, unknown>>> {
  if (params?.uri !== GUIDE_URI) return jsonRpcErrorObject(id, -32602, "Unknown resource", "The requested PS3D resource is not registered.");
  const result = { contents: [{ uri: GUIDE_URI, mimeType: "application/json", text: JSON.stringify(await createPs3dCollaborationGuide(), null, 2) }] };
  return jsonRpcResult(id, modern ? { ...result, ttlMs: 300_000, cacheScope: "private" } : result);
}

function getPrompt(id: string | number | null, params: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> {
  if (params?.name !== "ps3d-guided-change" || !isRecord(params.arguments) || typeof params.arguments.request !== "string" || params.arguments.request.trim().length < 2 || params.arguments.request.length > 500) {
    return jsonRpcErrorObject(id, -32602, "Invalid prompt arguments", "ps3d-guided-change requires a request from 2 to 500 characters.");
  }
  const workspace = typeof params.arguments.workspace === "string" ? params.arguments.workspace : "not specified";
  return jsonRpcResult(id, {
    description: "PS3D receipt-gated collaboration workflow",
    messages: [{ role: "user", content: { type: "text", text: `${PS3D_MCP_INSTRUCTIONS}\n\nUser goal: ${params.arguments.request}\nWorkspace: ${workspace}\nAfter reading ps3d_guide, call ps3d_agent_handshake and then ps3d_find_commands. Do not invent fields or claim a live-browser mutation.` } }]
  });
}

function accessibleTools(principal: McpPrincipal): readonly McpToolDefinition[] {
  return WORKBENCH_MCP_TOOLS.filter((tool) => hasMcpScope(principal, scopeForTool(tool)));
}

function scopeForTool(tool: McpToolDefinition): McpScope {
  if (tool.name === "ps3d_apply_preview") return "mcp:apply";
  if (tool.name.startsWith("ps3d_preview_")) return "mcp:preview";
  return "mcp:read";
}

function negotiatedProtocol(request: Request, message: Pick<JsonRpcRequest, "params">): string {
  const meta = isRecord(message.params?._meta) ? message.params?._meta : undefined;
  const metaVersion = typeof meta?.["io.modelcontextprotocol/protocolVersion"] === "string" ? meta["io.modelcontextprotocol/protocolVersion"] : undefined;
  const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : metaVersion ?? request.headers.get("mcp-protocol-version");
  return requested !== null && requested !== undefined && (PS3D_SUPPORTED_PROTOCOL_REVISIONS as readonly string[]).includes(requested)
    ? requested
    : PS3D_SUPPORTED_PROTOCOL_REVISIONS[0];
}

function isModernRequest(request: Request, message: Pick<JsonRpcRequest, "params">): boolean {
  return negotiatedProtocol(request, message) === "2026-07-28" && (request.headers.get("mcp-protocol-version") === "2026-07-28" || isRecord(message.params?._meta));
}

function cacheableResult(request: Request, message: Pick<JsonRpcRequest, "params">, value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return isModernRequest(request, message) ? { ...value, ttlMs: 300_000, cacheScope: "private" } : value;
}

function stampModernServerIdentity(response: Readonly<Record<string, unknown>>, protocolVersion: string): Readonly<Record<string, unknown>> {
  if (protocolVersion !== "2026-07-28" || !isRecord(response.result)) return response;
  const existingMeta = isRecord(response.result._meta) ? response.result._meta : {};
  return {
    ...response,
    result: {
      ...response.result,
      _meta: { ...existingMeta, "io.modelcontextprotocol/serverInfo": { name: "ps3d-cad-studio", title: "PS3D CAD Studio", version: "0.2.0-preview.1" } }
    }
  };
}

function jsonRpcResult(id: string | number | null, result: unknown): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcErrorObject(id: string | number | null, code: number, message: string, detail: string): Readonly<Record<string, unknown>> {
  return { jsonrpc: "2.0", id, error: { code, message, data: { detail } } };
}

function jsonRpcError(id: string | number | null, code: number, message: string, detail: string): Response {
  return new Response(JSON.stringify(jsonRpcErrorObject(id, code, message, detail)), {
    status: 400,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function secondsUntil(value: string): number {
  const delta = Math.ceil((new Date(value).getTime() - Date.now()) / 1000);
  return Number.isFinite(delta) ? Math.max(1, delta) : 60;
}
