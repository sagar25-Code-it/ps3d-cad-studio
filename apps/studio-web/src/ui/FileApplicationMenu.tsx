import { useEffect, useRef, useState } from "react";
import type { WorkbenchProject, WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { formatStorageSize, type PsCadWorkspaceStatus, type RecentProjectEntry } from "../file-workspace.js";
import { CommandIcon } from "./CommandIcon.js";

interface FileApplicationMenuProps {
  readonly open: boolean;
  readonly project: WorkbenchProject;
  readonly status: "starting" | "ready" | "working" | "error";
  readonly workspaceStatus: PsCadWorkspaceStatus;
  readonly recentProjects: readonly RecentProjectEntry[];
  readonly onClose: () => void;
  readonly onNew: () => void;
  readonly onOpen: () => void;
  readonly onOpenNative: () => void;
  readonly onOpenRecent: (id: string) => void;
  readonly onSave: () => void;
  readonly onSaveAs: () => void;
  readonly onSaveCopy: () => void;
  readonly onDownload: () => void;
  readonly onInitializeWorkspace: () => void;
  readonly onRecover: () => void;
  readonly onClearCache: () => void;
  readonly onExchange: () => void;
  readonly onRenderStudio: () => void;
  readonly onWorkspace: (workspace: WorkspaceId) => void;
  readonly onPrint: () => void;
  readonly onLearning: () => void;
}

type SectionId = "home" | "open" | "save" | "export" | "utilities" | "properties";

export function FileApplicationMenu(props: FileApplicationMenuProps): React.JSX.Element | null {
  const [section, setSection] = useState<SectionId>("home");
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setSection("home");
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
    };
    document.addEventListener("keydown", keyboard, true);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", keyboard, true); };
  }, [props.open, props.onClose]);

  if (!props.open) return null;
  const run = (action: () => void): void => { props.onClose(); action(); };
  const busy = props.status === "working" || props.status === "starting";

  return <div className="file-menu-scrim" role="presentation" onMouseDown={props.onClose}>
    <section ref={panelRef} tabIndex={-1} className="file-application-menu" role="dialog" aria-modal="true" aria-label="PS3D File menu" onMouseDown={(event) => event.stopPropagation()}>
      <header className="file-menu-titlebar">
        <div><span className="file-menu-mark"><CommandIcon name="file" /></span><span><small>PS3D CAD STUDIO</small><strong>File &amp; session center</strong></span></div>
        <div className="file-menu-current"><span>{props.project.name}</span><small>Revision {props.project.revision} · {props.workspaceStatus.currentFileName ?? "unsaved project"}</small></div>
        <button onClick={props.onClose} aria-label="Close File menu">×</button>
      </header>

      <div className="file-menu-body">
        <nav className="file-command-rail" aria-label="File command groups">
          <RailButton icon="home" label="Home" active={section === "home"} onClick={() => setSection("home")} />
          <RailButton icon="insert" label="New" onClick={() => run(props.onNew)} shortcut="Ctrl+N" />
          <RailButton icon="open" label="Open" active={section === "open"} onClick={() => setSection("open")} shortcut="Ctrl+O" />
          <RailButton icon="save" label="Save" active={section === "save"} onClick={() => setSection("save")} shortcut="Ctrl+S" />
          <RailButton icon="export" label="Import / Export" active={section === "export"} onClick={() => setSection("export")} />
          <RailButton icon="display" label="Utilities" active={section === "utilities"} onClick={() => setSection("utilities")} />
          <RailButton icon="inspect" label="Properties" active={section === "properties"} onClick={() => setSection("properties")} />
          <div className="file-command-rail-spacer" />
          <RailButton icon="help" label="Help" onClick={() => run(props.onLearning)} />
          <RailButton icon="cancel" label="Exit" disabled title="A browser tab can only be closed by the user." />
        </nav>

        <div className="file-menu-content">
          {section === "home" && <HomeSection {...props} run={run} />}
          {section === "open" && <OpenSection {...props} run={run} />}
          {section === "save" && <SaveSection {...props} run={run} busy={busy} />}
          {section === "export" && <ExportSection {...props} run={run} />}
          {section === "utilities" && <UtilitiesSection {...props} run={run} />}
          {section === "properties" && <PropertiesSection project={props.project} workspaceStatus={props.workspaceStatus} onPrint={() => run(props.onPrint)} />}
        </div>
      </div>

      <footer className="file-menu-footer">
        <span className={`workspace-permission ${props.workspaceStatus.permission === "granted" ? "ready" : "attention"}`}><i />{workspaceLabel(props.workspaceStatus)}</span>
        <span>Fast cache {props.workspaceStatus.cacheReady ? "ready" : "initializing"}</span>
        <span>{formatStorageSize(props.workspaceStatus.usageBytes)} of {formatStorageSize(props.workspaceStatus.quotaBytes)} browser storage</span>
        <kbd>Esc</kbd><span>close</span>
      </footer>
    </section>
  </div>;
}

function HomeSection(props: FileApplicationMenuProps & { readonly run: (action: () => void) => void }): React.JSX.Element {
  return <div className="file-section home-section">
    <section className="file-start-panel">
      <div className="file-section-heading"><small>START</small><h2>Design session</h2><p>Create, open, recover, or continue without leaving the engineering shell.</p></div>
      <div className="file-start-grid">
        <ActionCard icon="insert" title="New design" detail="Start an original PS3D project with a validated default part." shortcut="Ctrl+N" onClick={() => props.run(props.onNew)} />
        <ActionCard icon="open" title="Open project" detail="Open a native PS3D workbench JSON project from this computer." shortcut="Ctrl+O" onClick={() => props.run(props.onOpen)} />
        <ActionCard icon="save" title="Save project" detail="Write to the bound workspace or approved file handle." shortcut="Ctrl+S" onClick={() => props.run(props.onSave)} />
        <ActionCard icon="appearance" title="Render Studio" detail="Create a linked material, lighting, camera, and image-output scene." onClick={() => props.run(props.onRenderStudio)} />
      </div>
      <WorkspaceCard status={props.workspaceStatus} onInitialize={() => props.run(props.onInitializeWorkspace)} />
    </section>
    <RecentPanel recent={props.recentProjects} onOpen={(id) => props.run(() => props.onOpenRecent(id))} onBrowse={() => props.run(props.onOpen)} />
  </div>;
}

function OpenSection(props: FileApplicationMenuProps & { readonly run: (action: () => void) => void }): React.JSX.Element {
  return <div className="file-section two-column-section">
    <section>
      <div className="file-section-heading"><small>OPEN</small><h2>Projects and model data</h2><p>PS3D validates project identity before replacing the current session.</p></div>
      <div className="file-action-list">
        <ListAction icon="open" title="Open PS3D project" detail=".ps3d.json, .workbench.json, or validated JSON" shortcut="Ctrl+O" onClick={() => props.run(props.onOpen)} />
        <ListAction icon="json" title="Open qualified solid revision" detail="Validated PS3D native solid and evidence artifact" onClick={() => props.run(props.onOpenNative)} />
        <ListAction icon="exchange" title="Import reference model" detail="Open the 3D Exchange Center for bounded local reference import" onClick={() => props.run(props.onExchange)} />
        <ListAction icon="return" title="Recover autosave" detail="Restore the last validated browser-private recovery snapshot" onClick={() => props.run(props.onRecover)} />
      </div>
    </section>
    <RecentPanel recent={props.recentProjects} onOpen={(id) => props.run(() => props.onOpenRecent(id))} onBrowse={() => props.run(props.onOpen)} />
  </div>;
}

function SaveSection(props: FileApplicationMenuProps & { readonly run: (action: () => void) => void; readonly busy: boolean }): React.JSX.Element {
  return <div className="file-section two-column-section">
    <section>
      <div className="file-section-heading"><small>SAVE</small><h2>Controlled project writes</h2><p>Every saved project is validated first; local recovery remains separate from user-visible files.</p></div>
      <div className="file-action-list">
        <ListAction icon="save" title="Save" detail="Update the current approved project file and recovery cache" shortcut="Ctrl+S" disabled={props.busy} onClick={() => props.run(props.onSave)} />
        <ListAction icon="save" title="Save As" detail="Choose a new PS3D project name and location" shortcut="Ctrl+Shift+S" disabled={props.busy} onClick={() => props.run(props.onSaveAs)} />
        <ListAction icon="copy" title="Save a Copy" detail="Write an independent copy without changing the active file binding" disabled={props.busy} onClick={() => props.run(props.onSaveCopy)} />
        <ListAction icon="download" title="Download project copy" detail="Browser download fallback for the complete broad project" onClick={() => props.run(props.onDownload)} />
      </div>
    </section>
    <WorkspaceCard status={props.workspaceStatus} onInitialize={() => props.run(props.onInitializeWorkspace)} expanded />
  </div>;
}

function ExportSection(props: FileApplicationMenuProps & { readonly run: (action: () => void) => void }): React.JSX.Element {
  return <div className="file-section">
    <div className="file-section-heading"><small>IMPORT / EXPORT</small><h2>Engineering delivery</h2><p>Use format-specific validation and truthful exact-versus-tessellated capability labels.</p></div>
    <div className="file-start-grid export-grid">
      <ActionCard icon="exchange" title="3D Exchange Center" detail="Reference import, tessellated export, GLB package, and 3D PDF boundaries." onClick={() => props.run(props.onExchange)} />
      <ActionCard icon="appearance" title="Render Studio" detail="Material, environment, camera, quality, JPEG and PNG output." onClick={() => props.run(props.onRenderStudio)} />
      <ActionCard icon="drawing" title="Drawing workspace" detail="Create views, dimensions, tolerances, GD&T, and sheet output." onClick={() => props.run(() => props.onWorkspace("drawing"))} />
      <ActionCard icon="download" title="Native project copy" detail="Download the entire broad project as validated JSON." onClick={() => props.run(props.onDownload)} />
    </div>
    <div className="file-truth-note"><CommandIcon name="shield" /><span><strong>Format boundary</strong> Proprietary native feature histories and exact STEP/IGES B-rep translation remain converter- or kernel-required. PS3D does not relabel tessellated output as exact CAD.</span></div>
  </div>;
}

function UtilitiesSection(props: FileApplicationMenuProps & { readonly run: (action: () => void) => void }): React.JSX.Element {
  return <div className="file-section two-column-section">
    <section>
      <div className="file-section-heading"><small>UTILITIES</small><h2>Session maintenance</h2><p>Manage the bounded browser workspace without touching unrelated system files.</p></div>
      <div className="file-action-list">
        <ListAction icon="open" title="Create / reconnect PS CAD Studio folder" detail="One-time browser-approved folder access; creates Projects, Exports, Renders, Recovery, and Cache." onClick={() => props.run(props.onInitializeWorkspace)} />
        <ListAction icon="return" title="Recover last autosave" detail="Validate and restore the latest private OPFS recovery copy" onClick={() => props.run(props.onRecover)} />
        <ListAction icon="trash" title="Clear fast cache" detail="Clear browser-private OPFS cache only; user-visible projects are preserved" onClick={() => props.run(props.onClearCache)} />
        <ListAction icon="help" title="Learning and shortcut guide" detail="Beginner-to-advanced manual, MCP guide, and capability boundaries" onClick={() => props.run(props.onLearning)} />
      </div>
    </section>
    <section className="session-architecture">
      <small>STORAGE ARCHITECTURE</small><h3>Fast, recoverable, permission-bound</h3>
      <StorageRow label="Current file" value={props.workspaceStatus.currentFileName ?? "Not yet named"} state={props.workspaceStatus.currentFileName === null ? "attention" : "ready"} />
      <StorageRow label="Visible workspace" value={workspaceLabel(props.workspaceStatus)} state={props.workspaceStatus.permission === "granted" ? "ready" : "attention"} />
      <StorageRow label="Private recovery" value={props.workspaceStatus.cacheReady ? "OPFS cache ready" : "Cache initializes on first save"} state={props.workspaceStatus.cacheReady ? "ready" : "attention"} />
      <StorageRow label="Persistent storage" value={props.workspaceStatus.persistentStorage ? "Browser persistence granted" : "Best-effort browser quota"} state={props.workspaceStatus.persistentStorage ? "ready" : "attention"} />
      <p>A public browser app cannot silently write to Downloads. PS3D asks once for a folder and never scans other folders.</p>
    </section>
  </div>;
}

function PropertiesSection({ project, workspaceStatus, onPrint }: { readonly project: WorkbenchProject; readonly workspaceStatus: PsCadWorkspaceStatus; readonly onPrint: () => void }): React.JSX.Element {
  return <div className="file-section two-column-section">
    <section>
      <div className="file-section-heading"><small>PROPERTIES</small><h2>{project.name}</h2><p>Stable project identity and current workbench state.</p></div>
      <dl className="project-property-grid">
        <div><dt>Project ID</dt><dd>{project.id}</dd></div><div><dt>Revision</dt><dd>{project.revision}</dd></div>
        <div><dt>Schema</dt><dd>{project.format} / {project.schemaVersion}</dd></div><div><dt>Application</dt><dd>{project.applicationVersion}</dd></div>
        <div><dt>Units</dt><dd>{project.unit}</dd></div><div><dt>Active workspace</dt><dd>{project.activeWorkspace}</dd></div>
        <div><dt>Sketch entities</dt><dd>{project.sketch.entities.length}</dd></div><div><dt>Assembly components</dt><dd>{project.assembly.components.length}</dd></div>
        <div><dt>Audit entries</dt><dd>{project.audit.length}</dd></div><div><dt>Current file</dt><dd>{workspaceStatus.currentFileName ?? "Unsaved"}</dd></div>
      </dl>
      <button className="file-primary-action" onClick={onPrint}><CommandIcon name="drawing" />Print current workspace<kbd>Ctrl+P</kbd></button>
    </section>
    <section className="session-architecture">
      <small>SESSION SUMMARY</small><h3>Dependency-aware project</h3>
      <StorageRow label="Sketch → Part" value="Associative bounded profile path" state="ready" />
      <StorageRow label="Part → Assembly" value="Revision-labeled snapshots" state="ready" />
      <StorageRow label="Model → Drawing" value="Current part drawing association" state="ready" />
      <StorageRow label="AI / MCP" value="Guide-first, preview-and-receipt workflow" state="ready" />
    </section>
  </div>;
}

function RecentPanel({ recent, onOpen, onBrowse }: { readonly recent: readonly RecentProjectEntry[]; readonly onOpen: (id: string) => void; readonly onBrowse: () => void }): React.JSX.Element {
  return <aside className="recent-project-panel">
    <header><div><small>RECENT</small><h3>Recent projects</h3></div><button onClick={onBrowse}>Browse…</button></header>
    <div className="recent-project-list">
      {recent.map((entry, index) => <button key={entry.id} disabled={!entry.canReopen} title={entry.canReopen ? `Open ${entry.fileName}` : "Select this downloaded file again with Open Project"} onClick={() => onOpen(entry.id)}>
        <span className="recent-file-icon"><CommandIcon name="file" /><b>{index + 1}</b></span>
        <span><strong>{entry.projectName}</strong><small>{entry.fileName}</small><em>Revision {entry.revision} · {formatStorageSize(entry.sizeBytes)} · {relativeTime(entry.updatedAt)}</em></span>
        <CommandIcon name={entry.canReopen ? "arrow-right" : "inspect"} />
      </button>)}
      {recent.length === 0 && <div className="empty-recent"><CommandIcon name="open" /><strong>No recent project files yet</strong><span>Save As or Open a PS3D project to create the local list.</span></div>}
    </div>
  </aside>;
}

function WorkspaceCard({ status, onInitialize, expanded = false }: { readonly status: PsCadWorkspaceStatus; readonly onInitialize: () => void; readonly expanded?: boolean }): React.JSX.Element {
  const ready = status.bound && status.permission === "granted";
  return <aside className={`workspace-setup-card ${ready ? "ready" : "attention"} ${expanded ? "expanded" : ""}`}>
    <header><span><CommandIcon name={ready ? "shield" : "open"} /></span><div><small>LOCAL WORKSPACE</small><h3>{ready ? status.folderName : "Connect PS CAD Studio"}</h3></div><b>{ready ? "READY" : status.apiSupported ? "SETUP" : "FALLBACK"}</b></header>
    <p>{ready
      ? "Projects save directly to the approved workspace; exports and renders use dedicated subfolders."
      : status.apiSupported
        ? "Choose Downloads once. PS3D creates its own folder and writes only inside it after permission."
        : "This browser uses validated private recovery plus normal downloads; visible folder binding is unavailable."}</p>
    <div className="workspace-folder-map"><span>Projects</span><span>Exports</span><span>Renders</span><span>Recovery</span><span>Cache</span></div>
    <button onClick={onInitialize} disabled={!status.apiSupported}><CommandIcon name="open" />{ready ? "Reconnect or change folder" : "Create PS CAD Studio folder"}</button>
  </aside>;
}

function RailButton({ icon, label, shortcut, active = false, disabled = false, title, onClick }: { readonly icon: string; readonly label: string; readonly shortcut?: string; readonly active?: boolean; readonly disabled?: boolean; readonly title?: string; readonly onClick?: () => void }): React.JSX.Element {
  return <button className={active ? "active" : ""} disabled={disabled} title={title} onClick={onClick}><CommandIcon name={icon} /><span>{label}</span>{shortcut !== undefined && <kbd>{shortcut}</kbd>}</button>;
}

function ActionCard({ icon, title, detail, shortcut, onClick }: { readonly icon: string; readonly title: string; readonly detail: string; readonly shortcut?: string; readonly onClick: () => void }): React.JSX.Element {
  return <button className="file-action-card" onClick={onClick}><span><CommandIcon name={icon} /></span><strong>{title}</strong><small>{detail}</small>{shortcut !== undefined && <kbd>{shortcut}</kbd>}<i><CommandIcon name="arrow-right" /></i></button>;
}

function ListAction({ icon, title, detail, shortcut, disabled = false, onClick }: { readonly icon: string; readonly title: string; readonly detail: string; readonly shortcut?: string; readonly disabled?: boolean; readonly onClick: () => void }): React.JSX.Element {
  return <button disabled={disabled} onClick={onClick}><span><CommandIcon name={icon} /></span><span><strong>{title}</strong><small>{detail}</small></span>{shortcut !== undefined && <kbd>{shortcut}</kbd>}<CommandIcon name="arrow-right" /></button>;
}

function StorageRow({ label, value, state }: { readonly label: string; readonly value: string; readonly state: "ready" | "attention" }): React.JSX.Element {
  return <div className="storage-row"><i className={state} /><span>{label}</span><strong>{value}</strong></div>;
}

function workspaceLabel(status: PsCadWorkspaceStatus): string {
  if (!status.apiSupported) return "Download fallback active";
  if (!status.bound) return "Workspace not connected";
  if (status.permission === "granted") return `${status.folderName} connected`;
  if (status.permission === "prompt") return `${status.folderName} needs permission`;
  return `${status.folderName} permission denied`;
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "saved previously";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
