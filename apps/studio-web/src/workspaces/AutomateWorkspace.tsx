import { useEffect, useMemo, useState } from "react";
import type { WorkbenchOperation, WorkbenchProject, WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { WORKBENCH_MCP_TOOLS, handleWorkbenchMcpTool, type WorkbenchMcpResult } from "../../../../packages/workbench-mcp/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";

interface AutomateWorkspaceProps {
  readonly project: WorkbenchProject;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onApplyProject: (project: WorkbenchProject, message: string) => void;
  readonly onReviewElectromechanical: () => void;
  readonly onMessage: (message: string) => void;
}

interface PendingPreview {
  readonly operation: WorkbenchOperation;
  readonly receipt: string;
  readonly projectRevision: number;
}

type ConnectionStatus = "setup" | "testing" | "verified" | "error";
type DemoIntent = "part-thickness" | "surface-crown" | "drawing-tolerance" | "vehicle-state";

const SERVER_PATH = "apps/mcp-server/dist/apps/mcp-server/src/server.js";
const GENERIC_STDIO_CONFIG = JSON.stringify({
  name: "ps3d",
  transport: "stdio",
  prerequisite: { runOnce: ["pnpm", "mcp:build"] },
  command: "node",
  arguments: [SERVER_PATH],
  workingDirectory: "<path-to-ps3d-repository>"
}, null, 2);
const COMMON_HOST_ADAPTER = JSON.stringify({
  mcpServers: {
    ps3d: {
      command: "node",
      args: [SERVER_PATH],
      cwd: "<path-to-ps3d-repository>"
    }
  }
}, null, 2);
const STARTER_PROMPT = `Use the connected PS3D MCP server.
1. Call ps3d_guide first.
2. Inspect the complete project I provide.
3. Call ps3d_design_health to review dependencies, detached links, and engineering findings.
4. Use ps3d_find_commands to choose only a bounded recipe.
5. Preview every change and show the exact candidate project, changed IDs, warnings, base/candidate references, and receipt.
6. Wait for my approval before apply.
Never claim that PS3D modified a live browser session or wrote a file.`;
const PYTHON_EXAMPLE = `from pathlib import Path
from ps3d_client import Ps3dClient

# Build once in an approved environment: pnpm mcp:build
with Ps3dClient(
    ["node", "apps/mcp-server/dist/apps/mcp-server/src/server.js"],
    cwd=Path("<path-to-ps3d-repository>"),
    protocol="auto",
) as client:
    print(client.protocol_info())
    guide = client.guide()
    matches = client.find_commands("change motorcycle wheelbase", workspace="vehicle")
    print(guide["workflow"])
    print(matches["matches"])

    # project_mapping is a complete caller-owned project value.
    # summary = client.inspect(project_mapping)
    # health = client.design_health(project_mapping)
    # preview = client.preview(project_mapping, operation_mapping)
    # Show preview["candidateProject"], references, warnings, and receipt.
    # After exact user approval only:
    # returned = client.apply(
    #     project_mapping, operation_mapping, preview["receipt"], confirmed=True
    # )`;

const FRIENDLY_TOOL_LABELS: Readonly<Record<string, string>> = {
  ps3d_guide: "See what AI can do",
  ps3d_find_commands: "Find the right CAD command",
  ps3d_capabilities: "Check qualified capabilities",
  ps3d_inspect_project: "Understand current project",
  ps3d_design_health: "Review all-workspace design health",
  ps3d_analyze_vehicle: "Analyze vehicle study",
  ps3d_electromechanical_catalog: "Inspect panel component envelopes",
  ps3d_preview_electromechanical: "Preview circuit → mounted 3D",
  ps3d_preview_operation: "Preview an exact CAD change",
  ps3d_apply_preview: "Apply an approved preview"
};
const WORKSPACES: readonly WorkspaceId[] = ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];

export function AutomateWorkspace(props: AutomateWorkspaceProps): React.JSX.Element {
  const pythonSelected = props.selectedId === "automation:python-sdk";
  const selectedName = props.selectedId?.startsWith("mcp-tool:") === true ? props.selectedId.slice("mcp-tool:".length) : "ps3d_guide";
  const selected = WORKBENCH_MCP_TOOLS.find((tool) => tool.name === selectedName) ?? WORKBENCH_MCP_TOOLS[0]!;
  const [view, setView] = useState<"guided" | "advanced">("guided");
  const [result, setResult] = useState<WorkbenchMcpResult>();
  const [pending, setPending] = useState<PendingPreview>();
  const [busy, setBusy] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string>();
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("setup");
  const [goal, setGoal] = useState("connect AI and explain available commands");
  const [goalWorkspace, setGoalWorkspace] = useState<WorkspaceId>(props.project.activeWorkspace);
  const [demoIntent, setDemoIntent] = useState<DemoIntent>("surface-crown");
  const demoOperation = useMemo(() => createDemoOperation(props.project, demoIntent), [demoIntent, props.project]);
  const matches = Array.isArray(result?.structuredContent["matches"]) ? result.structuredContent["matches"] as readonly Readonly<Record<string, unknown>>[] : [];

  useEffect(() => {
    if (selected.name !== "ps3d_preview_operation" && selected.name !== "ps3d_apply_preview") setPending(undefined);
  }, [selected.name]);
  useEffect(() => {
    if (pending !== undefined && pending.projectRevision !== props.project.revision) setPending(undefined);
  }, [pending, props.project.revision]);

  const publishResult = (next: WorkbenchMcpResult): void => {
    setResult(next);
    setConnectionStatus(next.isError === true ? "error" : "verified");
    props.onMessage(next.content[0]?.text ?? "PS3D returned a structured result.");
  };

  const run = async (): Promise<void> => {
    setBusy(true);
    setConnectionStatus("testing");
    try {
      let next: WorkbenchMcpResult;
      if (selected.name === "ps3d_guide" || selected.name === "ps3d_capabilities" || selected.name === "ps3d_electromechanical_catalog") {
        next = await handleWorkbenchMcpTool(selected.name, {});
      } else if (selected.name === "ps3d_find_commands") {
        next = await handleWorkbenchMcpTool(selected.name, { query: goal, workspace: goalWorkspace, limit: 6 });
      } else if (selected.name === "ps3d_inspect_project" || selected.name === "ps3d_design_health" || selected.name === "ps3d_analyze_vehicle") {
        next = await handleWorkbenchMcpTool(selected.name, { project: props.project });
      } else if (selected.name === "ps3d_preview_electromechanical") {
        setPending(undefined);
        next = await handleWorkbenchMcpTool(selected.name, { project: props.project });
      } else if (selected.name === "ps3d_preview_operation") {
        next = await handleWorkbenchMcpTool(selected.name, { project: props.project, operation: demoOperation });
        const receipt = next.structuredContent["receipt"];
        if (typeof receipt === "string") setPending({ operation: demoOperation, receipt, projectRevision: props.project.revision });
      } else if (pending === undefined) {
        next = localError("PREVIEW_REQUIRED", "Run Preview an exact CAD change first for this project revision.");
      } else {
        next = await handleWorkbenchMcpTool(selected.name, { project: props.project, operation: pending.operation, receipt: pending.receipt, confirmed: true });
        const applied = next.structuredContent["project"];
        if (next.isError !== true && applied !== null && typeof applied === "object") {
          props.onApplyProject(applied as WorkbenchProject, "Applied the locally confirmed preview as one returned project revision.");
          setPending(undefined);
        }
      }
      publishResult(next);
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async (): Promise<void> => {
    props.onSelect("mcp-tool:ps3d_find_commands");
    setConnectionStatus("testing");
    const next = await handleWorkbenchMcpTool("ps3d_find_commands", { query: goal, workspace: goalWorkspace, limit: 6 });
    publishResult(next);
  };

  const runGuide = async (): Promise<void> => {
    props.onSelect("mcp-tool:ps3d_guide");
    setConnectionStatus("testing");
    publishResult(await handleWorkbenchMcpTool("ps3d_guide", {}));
  };

  const copyText = async (value: string, label: string): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopiedLabel(label);
    window.setTimeout(() => setCopiedLabel(undefined), 1600);
  };

  return <>
    <section className="workspace-canvas automate-stage" aria-label="Model-neutral AI collaboration workbench">
      <div className="automation-hero">
        <div>
          <span className="automation-kicker">MODEL-NEUTRAL MCP + PYTHON</span>
          <h2>Explain the CAD goal.<br />Review the exact result.</h2>
          <p>Local MCP-capable hosts can use PS3D through one vendor-neutral tool surface. The browser project is never exposed automatically: supply a project copy, preview the change, confirm its exact revision, then review and open or import the returned copy.</p>
          <div className="automation-view-switch" aria-label="Automation view">
            <button className={view === "guided" ? "selected" : ""} aria-pressed={view === "guided"} onClick={() => setView("guided")}>Guided</button>
            <button className={view === "advanced" ? "selected" : ""} aria-pressed={view === "advanced"} onClick={() => setView("advanced")}>Advanced MCP</button>
          </div>
        </div>
        <div className="connection-orbit" aria-hidden="true"><span className="orbit-core">P3</span><i>MCP</i><i>Python</i><i>AI host</i></div>
      </div>

      <div className="ai-readiness-grid" aria-label="AI integration readiness">
        <div><span className="ready-dot" /><small>Protocol</small><strong>2026 + legacy</strong></div>
        <div><span className="ready-dot" /><small>Local transport</small><strong>stdio available</strong></div>
        <div><span className="deferred-dot" /><small>Live browser bridge</small><strong>not connected</strong></div>
        <div><span className="deferred-dot" /><small>Public remote MCP</small><strong>security gate</strong></div>
      </div>

      <div className="automation-flow six-step" aria-label="Guided AI collaboration flow">
        {["Connect", "Discover", "Understand", "Preview", "Confirm", "Apply / import"].map((label, index) => <div key={label}><span>{String(index + 1).padStart(2, "0")}</span><strong>{label}</strong><small>{["explicit local server", "guide + command finder", "caller-owned project", "candidate + receipt", "exact revision approval", "returned project copy"][index]}</small></div>)}
      </div>

      {view === "guided" ? <>
        <section className="ai-command-center" aria-label="Smart CAD command finder">
          <header><div><span>PLAIN-LANGUAGE FINDER</span><h3>What should PS3D help with?</h3><p>Deterministic matching only—this finds bounded recipes and never executes your text.</p></div><button onClick={() => void runGuide()}>Read AI guide</button></header>
          <div className="ai-command-form">
            <label><span>Engineering goal</span><input value={goal} maxLength={160} onChange={(event) => setGoal(event.target.value)} placeholder="Example: set full-bump vehicle state" /></label>
            <label><span>Workspace</span><select value={goalWorkspace} onChange={(event) => setGoalWorkspace(event.target.value as WorkspaceId)}>{WORKSPACES.map((workspace) => <option key={workspace} value={workspace}>{workspace}</option>)}</select></label>
            <button className="primary" disabled={goal.trim().length < 2} onClick={() => void runSearch()}>Find bounded commands</button>
          </div>
          {matches.length > 0 && <div className="ai-recipe-results">{matches.map((match) => <article key={String(match["id"])}><header><strong>{String(match["title"])}</strong><span>{String(match["previewPolicy"])}</span></header><p>{String(match["intent"])}</p><dl><div><dt>Tool</dt><dd>{String(match["mcpTool"])}</dd></div><div><dt>Workspace</dt><dd>{String(match["workspace"])}</dd></div></dl><pre>{JSON.stringify(match["argumentTemplate"], null, 2)}</pre><small>{String(match["note"])}</small></article>)}</div>}
        </section>

        <section className="ai-connection-center" aria-label="AI host connection setup">
          <header><div><span>CONNECT AI</span><h3>Build once. Launch Node directly.</h3><p>The direct server command keeps stdout reserved for MCP JSON. Enter the repository path yourself; PS3D does not scan this computer.</p></div><span className={`connection-state ${connectionStatus}`} aria-live="polite">{statusLabel(connectionStatus)}</span></header>
          <div className="connection-config-grid">
            <article><h4>Generic stdio contract</h4><pre>{GENERIC_STDIO_CONFIG}</pre><button onClick={() => void copyText(GENERIC_STDIO_CONFIG, "generic")}>{copiedLabel === "generic" ? "Copied" : "Copy generic setup"}</button></article>
            <article><h4>Starter instruction</h4><pre>{STARTER_PROMPT}</pre><button onClick={() => void copyText(STARTER_PROMPT, "prompt")}>{copiedLabel === "prompt" ? "Copied" : "Copy starter prompt"}</button></article>
          </div>
        </section>
      </> : <>
        <div className="tool-grid">{WORKBENCH_MCP_TOOLS.map((tool) => <button key={tool.name} className={!pythonSelected && selected.name === tool.name ? "selected" : ""} onClick={() => props.onSelect(`mcp-tool:${tool.name}`)}><header><span className="access-label">{tool.annotations.readOnlyHint ? "Read-only" : "Approval required"}</span><CapabilityBadge level="preview" /></header><strong>{FRIENDLY_TOOL_LABELS[tool.name] ?? tool.title}</strong><small>{tool.name}</small><p>{tool.description}</p></button>)}<button className={pythonSelected ? "selected" : ""} onClick={() => props.onSelect("automation:python-sdk")}><header><span className="access-label">Adapter</span><CapabilityBadge level="preview" /></header><strong>Connect from Python</strong><small>sdk/python/ps3d_client/client.py</small><p>Dependency-free dual-era client with guide, command discovery, inspection, analysis, preview, and confirmed apply helpers.</p></button></div>
        <section className="advanced-adapter"><header><strong>Common host adapter shape</strong><span>Advanced · host wrappers differ</span></header><pre>{COMMON_HOST_ADAPTER}</pre><button onClick={() => void copyText(COMMON_HOST_ADAPTER, "adapter")}>{copiedLabel === "adapter" ? "Copied" : "Copy adapter JSON"}</button></section>
      </>}

      <section className="protocol-console" aria-live="polite"><header><span className={connectionStatus === "error" ? "error" : connectionStatus === "verified" ? "ready" : "setup"} /><strong>{pythonSelected ? "Python linking example" : "Built-in pure-handler result"}</strong><small>{pythonSelected ? "display only · run in approved environment" : "not an external-host handshake · no credentials"}</small></header><pre>{pythonSelected ? PYTHON_EXAMPLE : result === undefined ? "Run the AI guide, command finder, or selected advanced tool. External hosts use the prebuilt stdio server; this panel tests the same pure handlers in-browser." : JSON.stringify(result.structuredContent, null, 2)}</pre></section>
    </section>

    <aside className="inspector-panel" aria-label={pythonSelected ? "Python linking inspector" : "MCP inspector"}>
      <div className="inspector-title"><div><p>AI collaboration</p><h2>{pythonSelected ? "Connect from Python" : FRIENDLY_TOOL_LABELS[selected.name] ?? selected.title}</h2></div><CapabilityBadge level="preview" /></div>
      {pythonSelected ? <>
        <section className="tool-detail"><code>sdk/python/ps3d_client/client.py</code><p>A standard-library client with modern server discovery and legacy fallback. It launches only the caller-supplied argv, never a shell.</p><dl className="compact-facts"><div><dt>Dependencies</dt><dd>Python standard library</dd></div><div><dt>Transport</dt><dd>MCP stdio</dd></div><div><dt>Protocol</dt><dd>auto / modern / legacy</dd></div><div><dt>Network code</dt><dd>none</dd></div></dl></section>
        <section className="inspector-section"><header><strong>Connect from Python</strong><span>explicit argv</span></header><pre className="config-code python-code">{PYTHON_EXAMPLE}</pre><button onClick={() => void copyText(PYTHON_EXAMPLE, "python")}>{copiedLabel === "python" ? "Copied" : "Copy Python example"}</button></section>
        <section className="security-list"><header><strong>Client boundary</strong></header>{["Direct Node server command", "No shell interpolation", "No automatic file discovery", "No network code", "No secret lookup"].map((item) => <div key={item}><span aria-hidden="true">✓</span>{item}</div>)}</section>
        <div className="scope-note"><strong>Execution deferred on this system</strong><p>Build and run the subprocess only in a personal or IT-approved development environment.</p></div>
      </> : <>
        <section className="tool-detail"><details><summary>Protocol details</summary><code>{selected.name}</code></details><p>{selected.description}</p><dl className="compact-facts"><div><dt>Access</dt><dd>{selected.annotations.readOnlyHint ? "read-only" : "approval required"}</dd></div><div><dt>External write</dt><dd>none</dd></div><div><dt>Idempotent</dt><dd>{selected.annotations.idempotentHint ? "yes" : "no"}</dd></div><div><dt>Open world</dt><dd>no</dd></div></dl>
          {(selected.name === "ps3d_preview_operation" || selected.name === "ps3d_apply_preview") && <label className="demo-intent"><span>Visible built-in test intent</span><select value={demoIntent} onChange={(event) => setDemoIntent(event.target.value as DemoIntent)}><option value="part-thickness">Part thickness +1 mm</option><option value="surface-crown">Surface crown +2 mm</option><option value="drawing-tolerance">General linear tolerance +0.05 mm</option><option value="vehicle-state">Toggle design ride / full bump</option></select><pre>{JSON.stringify(demoOperation, null, 2)}</pre></label>}
          <button className="primary full" disabled={busy || (selected.name === "ps3d_apply_preview" && pending === undefined)} onClick={() => void run()}>{busy ? "Testing…" : selected.name === "ps3d_apply_preview" ? "Confirm exact visible preview and apply" : "Run built-in handler test"}</button>
          {selected.name === "ps3d_apply_preview" && <small className="consent-copy">{pending === undefined ? "A matching preview at this revision is required first." : `Receipt ready for revision ${pending.projectRevision}: ${pending.receipt.slice(0, 12)}…`}</small>}
          {selected.name === "ps3d_preview_electromechanical" && <><button className="primary full" onClick={props.onReviewElectromechanical}>Open full circuit → 3D review</button><small className="consent-copy">Apply stays inside the complete replacement dialog; this test cannot silently assert approval.</small></>}
        </section>
        <section className="inspector-section"><header><strong>Direct local setup</strong><span>stdio</span></header><pre className="config-code">{GENERIC_STDIO_CONFIG}</pre><button onClick={() => void copyText(GENERIC_STDIO_CONFIG, "inspector-config")}>{copiedLabel === "inspector-config" ? "Copied" : "Copy setup"}</button></section>
        <section className="security-list"><header><strong>Closed boundary</strong></header>{["No filesystem or browser access", "No network access", "No environment secrets", "1 MB input limit", "Exact candidate + revision receipt"].map((item) => <div key={item}><span aria-hidden="true">✓</span>{item}</div>)}</section>
        <div className="scope-note"><strong>Detached-project boundary</strong><p>External AI calls do not control the open browser project. The host must supply a complete project and the user must review and open or import the returned copy.</p></div>
      </>}
    </aside>
  </>;
}

function createDemoOperation(project: WorkbenchProject, intent: DemoIntent): WorkbenchOperation {
  const envelope = { operationId: `operation:guided-${intent}-r${project.revision}`, expectedRevision: project.revision } as const;
  if (intent === "part-thickness") return { ...envelope, kind: "set-part-parameter", parameter: "thicknessMm", value: Math.min(200, project.part.thicknessMm + 1) };
  if (intent === "drawing-tolerance") return { ...envelope, kind: "set-drawing-general-tolerance", linearMm: Math.min(10, (project.drawing.generalToleranceLinearMm ?? 0.2) + 0.05), angularDeg: project.drawing.generalToleranceAngularDeg ?? 0.5 };
  if (intent === "vehicle-state") return { ...envelope, kind: "set-vehicle-simulation-state", state: project.vehicle.state === "full-bump" ? "design-ride" : "full-bump" };
  return { ...envelope, kind: "set-surface-parameter", parameter: "crownMm", value: Math.min(80, project.surface.crownMm + 2) };
}

function statusLabel(status: ConnectionStatus): string {
  if (status === "testing") return "Testing built-in handler";
  if (status === "verified") return "Built-in handler verified";
  if (status === "error") return "Handler returned an error";
  return "Setup only · no host connected";
}

function localError(code: string, message: string): WorkbenchMcpResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: { code, message }, isError: true };
}
