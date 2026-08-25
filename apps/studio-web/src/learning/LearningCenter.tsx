import { useMemo, useState } from "react";
import { BrandFooter } from "../cloud/BrandFooter.js";
import { PublicPageHeader } from "../cloud/PublicPageHeader.js";
import { LEARNING_LEVELS, PS3D_LEARNING_MANUAL, type LearningLevel } from "./learning-content.js";
import { buildLearningManualPdf } from "./learning-pdf.js";

const PROGRESS_KEY = "ps3d.learning.progress.v1";

export function LearningCenter(): React.JSX.Element {
  const [level, setLevel] = useState<LearningLevel | "All">("All");
  const [query, setQuery] = useState("");
  const [completed, setCompleted] = useState<ReadonlySet<string>>(() => loadProgress());
  const modules = useMemo(() => PS3D_LEARNING_MANUAL.modules.filter((item) => {
    if (level !== "All" && item.level !== level) return false;
    const haystack = `${item.title} ${item.summary} ${item.workspace} ${item.outcomes.join(" ")} ${item.practice.join(" ")}`.toLowerCase();
    return query.trim().length === 0 || haystack.includes(query.trim().toLowerCase());
  }), [level, query]);
  const percent = Math.round(completed.size / PS3D_LEARNING_MANUAL.modules.length * 100);

  const toggleComplete = (id: string): void => {
    const next = new Set(completed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCompleted(next);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...next]));
  };

  const downloadManual = (): void => {
    const blob = buildLearningManualPdf(PS3D_LEARNING_MANUAL);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "ps3d-cad-studio-learning-and-safe-practice-manual.pdf";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const previewManual = (): void => {
    const blob = buildLearningManualPdf(PS3D_LEARNING_MANUAL);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
  };

  return <main className="public-page learning-page">
    <PublicPageHeader active="learn" />
    <section className="public-hero learning-hero"><div><span className="eyebrow">BEGINNER TO ADVANCED / RESEARCH PRACTICE</span><h1>Learn the system. Keep the evidence honest.</h1><p>{PS3D_LEARNING_MANUAL.introduction}</p><div className="hero-actions"><button className="primary" onClick={downloadManual}>Download 15-page PDF manual</button><button onClick={previewManual}>Preview PDF</button><a href="/access">Connect an AI tool</a></div></div><aside><span>Personal progress</span><strong>{percent}%</strong><div><i style={{ width: `${percent}%` }} /></div><small>{completed.size} of {PS3D_LEARNING_MANUAL.modules.length} verification modules completed in this browser</small></aside></section>

    <section className="learning-principles" aria-label="Learning principles"><div><strong>Qualified</strong><span>Bounded behavior with executed evidence gates</span></div><div><strong>Preview</strong><span>Useful deterministic assistance with explicit limitations</span></div><div><strong>Unavailable</strong><span>Professional-kernel or certification behavior not honestly implemented</span></div></section>

    <section className="learning-controls"><div role="tablist" aria-label="Learning level">{(["All", ...LEARNING_LEVELS] as const).map((item) => <button className={level === item ? "active" : ""} key={item} onClick={() => setLevel(item)}>{item}</button>)}</div><label><span>Search curriculum</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Sketch, GD&T, vehicle, MCP..." /></label></section>

    <section className="module-grid" aria-label="PS3D learning modules">{modules.map((item) => <article className={`learning-module level-${item.level.toLowerCase()} ${completed.has(item.id) ? "complete" : ""}`} id={item.id} key={item.id}>
      <header><span className="module-number">{item.number}</span><div><span>{item.level} / {item.workspace}</span><h2>{item.title}</h2></div><button className="completion-button" onClick={() => toggleComplete(item.id)} aria-pressed={completed.has(item.id)}>{completed.has(item.id) ? "Verified complete" : "Mark complete"}</button></header>
      <p>{item.summary}</p>
      <div className="module-columns"><section><h3>Learning outcomes</h3><ul>{item.outcomes.map((value) => <li key={value}>{value}</li>)}</ul></section><section><h3>Guided practice</h3><ol>{item.practice.map((value) => <li key={value}>{value}</li>)}</ol></section></div>
      <details><summary>Open verification gate and professional boundary</summary><div className="verification-panel"><section><h3>Verification gate</h3><ul>{item.verification.map((value) => <li key={value}>{value}</li>)}</ul></section><aside><strong>Professional boundary</strong><p>{item.boundary}</p></aside></div></details>
      {item.id === "mcp" && <McpQuickStart />}
    </article>)}</section>
    {modules.length === 0 && <div className="learning-empty">No module matches this search and level. Clear the filter to see the full curriculum.</div>}

    <section className="manual-callout"><div><span className="eyebrow">ONE REVIEWED SOURCE</span><h2>Web curriculum and PDF stay together</h2><p>The downloadable manual is generated from the same module data shown above. That prevents a stale PDF from silently teaching different commands, security rules, or capability claims.</p></div><button onClick={downloadManual}>Download current manual</button></section>
    <BrandFooter note={`${PS3D_LEARNING_MANUAL.edition}. Progress is local, non-sensitive, and never uploaded.`} />
  </main>;
}

function McpQuickStart(): React.JSX.Element {
  return <section className="mcp-quick-start"><header><span>SECURE MCP QUICK START</span><a href="/access">Open MCP Access</a></header><div><ol><li>Create or sign in to a verified PS3D account.</li><li>Prefer OAuth 2.1. If the AI host needs a custom header, create one expiring personal token for that host.</li><li>Set the MCP URL to <code>{location.origin}/api/mcp</code>.</li><li>Call <code>initialize</code>, <code>tools/list</code>, then <code>ps3d_guide</code>.</li><li>Inspect and preview before any receipt-gated returned project copy.</li></ol><aside><strong>Never configure the web password.</strong><span>Use only OAuth or the shown-once <code>ps3d_mcp_...</code> bearer token.</span></aside></div></section>;
}

function loadProgress(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "[]");
    const ids = new Set(PS3D_LEARNING_MANUAL.modules.map((item) => item.id));
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && ids.has(item)) : []);
  } catch { return new Set(); }
}
