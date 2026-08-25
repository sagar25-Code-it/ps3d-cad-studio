import { useMemo, useState } from "react";
import { CAD_COMMANDS, type CapabilityLevel, type WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { PS3D_BRAND } from "../brand.js";
import { BrandLogo } from "../ui/BrandLogo.js";
import { CommandIcon, inferCommandIcon } from "../ui/CommandIcon.js";

const WORKSPACES: readonly ("all" | WorkspaceId)[] = ["all", "sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];
const LEVELS: readonly ("all" | CapabilityLevel)[] = ["all", "qualified", "preview", "unavailable"];

export function CommandAuditPage(): React.JSX.Element {
  const search = new URLSearchParams(window.location.search);
  const requestedWorkspace = search.get("workspace");
  const requestedLevel = search.get("level");
  const [workspace, setWorkspace] = useState<"all" | WorkspaceId>(isWorkspace(requestedWorkspace) ? requestedWorkspace : "all");
  const [level, setLevel] = useState<"all" | CapabilityLevel>(isLevel(requestedLevel) ? requestedLevel : "all");
  const [query, setQuery] = useState("");
  const commands = useMemo(() => CAD_COMMANDS.filter((command) => {
    if (workspace !== "all" && command.workspace !== workspace) return false;
    if (level !== "all" && command.level !== level) return false;
    const needle = query.trim().toLowerCase();
    return needle.length === 0 || `${command.name} ${command.description} ${command.group} ${command.keywords.join(" ")}`.toLowerCase().includes(needle);
  }), [level, query, workspace]);
  const counts = LEVELS.slice(1).map((item) => ({ level: item, count: CAD_COMMANDS.filter((command) => command.level === item).length }));

  return <main className="command-audit-page">
    <header className="audit-hero"><div><a className="audit-brand-lockup" href="/about"><BrandLogo decorative /><span><strong>{PS3D_BRAND.name}</strong><small>{PS3D_BRAND.serviceLine}</small></span></a><span>PS3D LOCAL VERIFICATION ARTIFACT</span><h1>Professional CAD Command Audit</h1><p>Independent PS3D command design benchmarked against familiar professional CAD workflows. Every command is labeled by executed capability: qualified, preview, or unavailable.</p></div><nav><a href="/">Open Studio</a><a href="/learn">Learning Center</a><a href="/about">About PS3D</a></nav></header>
    <section className="audit-summary" aria-label="Command capability summary"><div><small>Total catalog</small><strong>{CAD_COMMANDS.length}</strong></div>{counts.map((item) => <div key={item.level}><small>{item.level}</small><strong>{item.count}</strong></div>)}</section>
    <section className="audit-method"><div><CommandIcon name="shield" /><span><strong>No copied product code or UI assets</strong><small>Command semantics were independently implemented or documented from public professional-CAD workflows.</small></span></div><div><CommandIcon name="cube-check" /><span><strong>Execution is never implied by a button name</strong><small>Unavailable commands remain searchable with their exact missing engine, data, and validation requirements.</small></span></div></section>
    <section className="audit-controls"><label><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Boolean, harness, sketch check, table…" /></label><div><span>Workspace</span>{WORKSPACES.map((item) => <button key={item} className={workspace === item ? "active" : ""} onClick={() => setWorkspace(item)}>{item}</button>)}</div><div><span>Capability</span>{LEVELS.map((item) => <button key={item} className={level === item ? "active" : ""} onClick={() => setLevel(item)}>{item}</button>)}</div></section>
    <section className="audit-results-title"><div><span>COMMAND TRIAL INDEX</span><h2>{workspace === "all" ? "All workspaces" : workspace} · {level === "all" ? "all capability states" : level}</h2></div><strong>{commands.length} commands</strong></section>
    <section className="audit-command-grid" aria-label="Audited command cards">
      {commands.map((command) => <article key={command.id} className={`audit-command ${command.level}`} data-workspace={command.workspace}>
        <header><span><CommandIcon name={inferCommandIcon(`${command.name} ${command.category}`, command.workspace)} /></span><div><small>{command.group}</small><h3>{command.name}</h3></div><b>{command.level}</b></header>
        <p>{command.description}</p>
        <dl><div><dt>Selection</dt><dd>{command.guide.selection}</dd></div><div><dt>Trial method</dt><dd>{command.guide.steps.join(" ")}</dd></div><div><dt>Expected result</dt><dd>{command.guide.result}</dd></div><div><dt>Verification boundary</dt><dd>{command.guide.boundary}</dd></div></dl>
        <footer><code>{command.id}</code><span>{command.shortcut ?? "No shortcut"}</span></footer>
      </article>)}
    </section>
    <footer className="audit-footer"><strong>{PS3D_BRAND.name} command audit</strong><span>{PS3D_BRAND.tagline} Generated from the same typed registry used by All Commands and MCP discovery.</span><a href="/">Return to Studio</a></footer>
  </main>;
}

function isWorkspace(value: string | null): value is "all" | WorkspaceId {
  return value !== null && WORKSPACES.includes(value as "all" | WorkspaceId);
}

function isLevel(value: string | null): value is "all" | CapabilityLevel {
  return value !== null && LEVELS.includes(value as "all" | CapabilityLevel);
}
