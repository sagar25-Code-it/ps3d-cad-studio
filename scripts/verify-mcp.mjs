import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { createWorkbenchProject } from "../apps/mcp-server/dist/packages/workbench-core/src/index.js";

const serverPath = resolve("apps/mcp-server/dist/apps/mcp-server/src/server.js");
const expectedTools = "ps3d_guide,ps3d_find_commands,ps3d_capabilities,ps3d_inspect_project,ps3d_design_health,ps3d_analyze_vehicle,ps3d_electromechanical_catalog,ps3d_preview_electromechanical,ps3d_preview_operation,ps3d_apply_preview";

await verifyModernDiscovery();
await verifyLegacyLifecycle();
process.stdout.write("Verified direct-Node MCP stdio launch, modern discovery, legacy initialization, ten schemas, design health, guide/resource/prompt discovery, command matching, candidate disclosure, receipt rejection, exact retry, and confirmed apply.\n");

async function verifyModernDiscovery() {
  const session = createSession();
  const meta = modernMeta();
  try {
    const discovered = await session.request("server/discover", { _meta: meta });
    assert(discovered.result?.supportedVersions?.includes("2026-07-28"), "Modern discovery did not advertise 2026-07-28.");
    assert(discovered.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name === "ps3d-cad-studio", "Modern discovery omitted server identity metadata.");

    const listed = await session.request("tools/list", { _meta: meta });
    assertToolCatalog(listed.result?.tools);
    const guide = await session.callTool("ps3d_guide", {}, meta);
    assert(guide.structuredContent?.schema === "ps3d-ai-collaboration/1", "Modern guide returned the wrong schema.");
    assert(typeof guide.structuredContent?.manifestSha256 === "string", "Modern guide omitted its deterministic digest.");
    assert(hasJsonTextFallback(guide), "Modern guide omitted its serialized JSON text compatibility block.");

    const resources = await session.request("resources/list", { _meta: meta });
    assert(resources.result?.resources?.some((resource) => resource.uri === "ps3d://ai/collaboration-guide"), "Modern resource discovery omitted the AI guide.");
    const prompts = await session.request("prompts/list", { _meta: meta });
    assert(prompts.result?.prompts?.some((prompt) => prompt.name === "ps3d-guided-change"), "Modern prompt discovery omitted the guided-change prompt.");
  } finally {
    await session.close();
  }
}

async function verifyLegacyLifecycle() {
  const session = createSession();
  try {
    const initialized = await session.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ps3d-mcp-verifier", version: "1.0.0" }
    });
    assert(initialized.result?.protocolVersion === "2025-11-25", "MCP legacy protocol negotiation failed.");
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await session.request("tools/list", {});
    assertToolCatalog(listed.result?.tools);

    const guide = await session.callTool("ps3d_guide", {});
    assert(guide.structuredContent?.schema === "ps3d-ai-collaboration/1", "Guide tool returned the wrong schema.");
    assert(guide.structuredContent?.protocol?.preferredRevision === "2026-07-28", "Guide omitted the preferred modern revision.");
    assert(guide.structuredContent?.state?.browserSessionConnected === false, "Guide must preserve the detached-browser boundary.");

    const found = await session.callTool("ps3d_find_commands", { query: "change motorcycle wheelbase", workspace: "vehicle", limit: 4 });
    assert(found.structuredContent?.schema === "ps3d-command-search/1" && found.structuredContent?.executionPerformed === false, "Command finder must be deterministic and read-only.");
    assert(found.structuredContent?.matches?.some((match) => match.id === "ai-command:vehicle-parameter"), "Command finder did not resolve the vehicle parameter recipe.");

    const capabilities = await session.callTool("ps3d_capabilities", {});
    assert(capabilities.structuredContent?.schema === "ps3d-capabilities/1", "Capability tool returned the wrong schema.");

    const project = createWorkbenchProject("project:mcp-verification");
    const inspected = await session.callTool("ps3d_inspect_project", { project });
    assert(inspected.structuredContent?.revision === 0, "Inspect tool did not validate revision zero.");

    const health = await session.callTool("ps3d_design_health", { project });
    assert(health.structuredContent?.schema === "ps3d-design-health/1", "Design health returned the wrong schema.");
    assert(health.structuredContent?.workspaces?.length === 8, "Design health did not analyze every workspace.");

    const vehicle = await session.callTool("ps3d_analyze_vehicle", { project });
    assert(vehicle.structuredContent?.schema === "ps3d-vehicle-mcp-analysis/2", "Vehicle tool returned the wrong outer schema.");
    assert(vehicle.structuredContent?.analysis?.schema === "ps3d-vehicle-analysis/2", "Vehicle tool returned the wrong nested analysis schema.");
    assert(vehicle.structuredContent?.tireDataStatus === "unverified" && vehicle.structuredContent?.brakeDataStatus === "unverified", "Vehicle tool must expose supplier-evidence status.");
    assert(vehicle.structuredContent?.regulatoryResult === false && vehicle.structuredContent?.constructionReady === false && vehicle.structuredContent?.roadworthinessApproved === false, "Vehicle tool must preserve all approval boundaries.");
    assertJsonSafeNumbers(vehicle.structuredContent, "vehicle MCP response");

    const catalog = await session.callTool("ps3d_electromechanical_catalog", {});
    assert(catalog.structuredContent?.schema === "ps3d-electromechanical-catalog/1" && catalog.structuredContent?.constructionReady === false, "Electromechanical catalog returned the wrong safety contract.");

    const electromechanical = await session.callTool("ps3d_preview_electromechanical", { project });
    assert(electromechanical.structuredContent?.schema === "ps3d-electromechanical-preview/1", "Electromechanical preview returned the wrong schema.");
    assert(typeof electromechanical.structuredContent?.receipt === "string" && electromechanical.structuredContent?.operation?.kind === "generate-electromechanical-realization", "Electromechanical preview omitted its canonical operation and receipt.");

    const operation = { operationId: "operation:mcp-crown", expectedRevision: 0, kind: "set-surface-parameter", parameter: "crownMm", value: 28 };
    const preview = await session.callTool("ps3d_preview_operation", { project, operation });
    const receipt = preview.structuredContent?.receipt;
    assert(typeof receipt === "string" && /^[a-f0-9]{64}$/u.test(receipt), "Preview tool did not return a SHA-256 receipt.");
    assert(preview.structuredContent?.nextRevision === 1 && preview.structuredContent?.candidateProject?.surface?.crownMm === 28, "Preview omitted the exact candidate project.");
    assert(preview.structuredContent?.receiptInfo?.signed === false && preview.structuredContent?.receiptInfo?.approvalProof === false, "Receipt boundary is not explicit.");

    const rejected = await session.callTool("ps3d_apply_preview", { project, operation, receipt: "0".repeat(64), confirmed: true });
    assert(rejected.isError === true && rejected.structuredContent?.code === "PREVIEW_RECEIPT_MISMATCH", "Apply accepted a mismatched receipt.");

    const applied = await session.callTool("ps3d_apply_preview", { project, operation, receipt, confirmed: true });
    assert(applied.isError !== true && applied.structuredContent?.schema === "ps3d-applied-operation/1", "Confirmed apply failed.");
    const nextProject = applied.structuredContent?.project;
    assert(nextProject?.revision === 1 && nextProject?.surface?.crownMm === 28, "Confirmed apply returned the wrong project.");

    const retry = await session.callTool("ps3d_preview_operation", { project: nextProject, operation });
    assert(retry.structuredContent?.exactRetry === true, "Exact idempotent retry was not labeled.");
    assert(retry.structuredContent?.baseRevision === 1 && retry.structuredContent?.nextRevision === 1, "Exact retry reported a false base revision.");
    assert(retry.structuredContent?.receiptInfo?.disposition === "exact-retry", "Exact retry receipt omitted its disposition.");
  } finally {
    await session.close();
  }
}

function createSession() {
  const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const responses = new Map();
  const waiters = new Map();
  let stderr = "";
  let invalidStdout = "";
  let nextId = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message !== null && typeof message === "object" && Object.hasOwn(message, "id")) {
        const id = String(message.id);
        const waiter = waiters.get(id);
        if (waiter !== undefined) { waiters.delete(id); waiter.resolve(message); }
        else responses.set(id, message);
      }
    } catch { invalidStdout += `${line}\n`; }
  });

  const send = (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  const request = (method, params) => {
    const id = ++nextId;
    send({ jsonrpc: "2.0", id, method, params });
    const existing = responses.get(String(id));
    if (existing !== undefined) { responses.delete(String(id)); return Promise.resolve(existing); }
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => { waiters.delete(String(id)); rejectRequest(new Error(`Timed out waiting for ${method}. stderr=${stderr}`)); }, 8_000);
      waiters.set(String(id), { resolve: (value) => { clearTimeout(timer); resolveRequest(value); } });
    });
  };
  const callTool = async (name, args, meta) => {
    const response = await request("tools/call", { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
    if (response.error !== undefined) throw new Error(`MCP protocol error ${JSON.stringify(response.error)}`);
    return response.result;
  };
  const close = async () => {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000))]);
    assert(invalidStdout === "", `MCP stdout contained non-protocol text: ${invalidStdout}`);
  };
  return { send, request, callTool, close };
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "ps3d-modern-verifier", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

function assertToolCatalog(tools) {
  assert(Array.isArray(tools) && tools.length === 10, "MCP server must list exactly ten bounded tools.");
  assert(tools.map((tool) => tool.name).join(",") === expectedTools, "MCP tool ordering or names changed.");
  assert(tools.every((tool) => tool.inputSchema?.type === "object" && tool.outputSchema?.type === "object"), "Every MCP tool must advertise object input and output schemas.");
}

function hasJsonTextFallback(result) {
  return result.content?.some((entry) => entry.type === "text" && entry.text.startsWith("{") && entry.text.endsWith("}"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertJsonSafeNumbers(value, label, path = "$") {
  if (typeof value === "number") { assert(Number.isFinite(value), `${label} contains a non-finite number at ${path}.`); return; }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) value.forEach((entry, index) => assertJsonSafeNumbers(entry, label, `${path}[${index}]`));
  else Object.entries(value).forEach(([key, entry]) => assertJsonSafeNumbers(entry, label, `${path}.${key}`));
}
