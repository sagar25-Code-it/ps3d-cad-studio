import { useEffect, useRef, useState } from "react";
import type { WorkspaceId, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { DesignHealthStatus } from "../../../../packages/workbench-health/src/index.js";
import { PS3D_BRAND } from "../brand.js";
import type { PsCadWorkspaceStatus, RecentProjectEntry } from "../file-workspace.js";
import { BrandLogo } from "./BrandLogo.js";
import { CommandIcon } from "./CommandIcon.js";
import { FileApplicationMenu } from "./FileApplicationMenu.js";
import type { WorkbenchMenu, WorkbenchMenuItem } from "./menu-model.js";

const WORKSPACES: readonly { id: WorkspaceId; label: string; icon: string }[] = [
  { id: "sketch", label: "Sketch", icon: "sketch" },
  { id: "part", label: "Part", icon: "part" },
  { id: "assembly", label: "Assembly", icon: "assembly" },
  { id: "surface", label: "Surface", icon: "surface" },
  { id: "drawing", label: "Drawing", icon: "drawing" },
  { id: "electrical", label: "Electrical", icon: "electrical" },
  { id: "vehicle", label: "Vehicle", icon: "vehicle" },
  { id: "automate", label: "Automate", icon: "automate" }
];

interface WorkbenchHeaderProps {
  readonly project: WorkbenchProject;
  /** The application menus, built by `buildWorkbenchMenus` from the live project state. */
  readonly menus: readonly WorkbenchMenu[];
  readonly masterCartOpen: boolean;
  readonly renderStudioOpen: boolean;
  readonly status: "starting" | "ready" | "working" | "error";
  readonly fileWorkspaceStatus: PsCadWorkspaceStatus;
  readonly recentProjects: readonly RecentProjectEntry[];
  readonly onWorkspace: (workspace: WorkspaceId) => void;
  readonly onMasterCart: () => void;
  readonly onRenderStudio: () => void;
  readonly onCommandPalette: () => void;
  readonly onDesignHealth: () => void;
  readonly onExchange: () => void;
  readonly onLearning: () => void;
  readonly onAccess: () => void;
  readonly onSave: () => void;
  readonly onSaveAs: () => void;
  readonly onSaveCopy: () => void;
  readonly onDownload: () => void;
  readonly onOpen: () => void;
  readonly onOpenRecent: (id: string) => void;
  readonly onOpenNative: () => void;
  readonly onNew: () => void;
  readonly onInitializeFileWorkspace: () => void;
  readonly onRecoverProject: () => void;
  readonly onClearFileCache: () => void;
  readonly onPrint: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onFit: () => void;
  readonly onHome: () => void;
  readonly onToggleGrid: () => void;
  readonly onMeasure: () => void;
  readonly gridVisible: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly designHealthStatus: DesignHealthStatus;
  readonly designHealthScore: number;
}

export function WorkbenchHeader(props: WorkbenchHeaderProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const menus = props.menus;
  const is3d = !props.masterCartOpen && !props.renderStudioOpen && (props.project.activeWorkspace === "part" || props.project.activeWorkspace === "assembly" || props.project.activeWorkspace === "surface" || props.project.activeWorkspace === "vehicle");

  useEffect(() => {
    if (openMenu === null || openMenu === "file") return;
    const closeOutside = (event: MouseEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target) !== true) setOpenMenu(null);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [openMenu]);

  // An opened dropdown moves focus to its first usable item, so arrows work at once.
  useEffect(() => {
    if (openMenu === null || openMenu === "file") return;
    popoverRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
  }, [openMenu]);

  const runMenuItem = (item: WorkbenchMenuItem): void => {
    setOpenMenu(null);
    triggerRefs.current.get(openMenu ?? "")?.focus();
    item.action();
  };

  /** Left and right arrows move across the dropdown menus (the File dialog stays on its own). */
  const stepMenu = (delta: number): void => {
    if (openMenu === null || openMenu === "file") return;
    const ids = menus.map((menu) => menu.id);
    const index = ids.indexOf(openMenu);
    if (index < 0) return;
    setOpenMenu(ids[(index + delta + ids.length) % ids.length]!);
  };

  const onPopoverKeyDown = (event: React.KeyboardEvent): void => {
    const nodes = [...(popoverRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (nodes.length === 0) return;
    const current = nodes.findIndex((node) => node === document.activeElement);
    if (event.key === "ArrowDown") { event.preventDefault(); nodes[(current + 1) % nodes.length]!.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); nodes[(current - 1 + nodes.length) % nodes.length]!.focus(); }
    else if (event.key === "Home") { event.preventDefault(); nodes[0]!.focus(); }
    else if (event.key === "End") { event.preventDefault(); nodes[nodes.length - 1]!.focus(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); stepMenu(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); stepMenu(-1); }
    else if (event.key === "Tab") { setOpenMenu(null); }
  };

  return <>
    <header className="app-header">
      <a className="brand-block" href="/about" aria-label={`About ${PS3D_BRAND.name}`}>
        <BrandLogo decorative />
        <div><strong>{PS3D_BRAND.productName}</strong><small>{PS3D_BRAND.name} engineering suite</small></div>
      </a>
      <button className="project-button" onClick={props.onCommandPalette} aria-label="Open command launcher">
        <span className="project-command-icon"><CommandIcon name="command" /></span>
        <span><strong>{props.project.name}</strong><small>Revision {props.project.revision} · local project</small></span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="header-actions" aria-label="Project actions">
        <button className="header-icon-button" onClick={props.onUndo} disabled={!props.canUndo || props.status === "working"} aria-label="Undo project change" title="Undo project change"><CommandIcon name="undo" /><span>Undo</span></button>
        <button className="header-icon-button" onClick={props.onRedo} disabled={!props.canRedo || props.status === "working"} aria-label="Redo project change" title="Redo project change"><CommandIcon name="redo" /><span>Redo</span></button>
        <button className="header-icon-button" onClick={props.onOpen} aria-label="Open local PS3D project" title="Open local PS3D project"><CommandIcon name="open" /><span>Open</span></button>
        <button className="header-icon-button" onClick={props.onDownload} aria-label="Download PS3D project" title="Download PS3D project"><CommandIcon name="download" /><span>Download</span></button>
        <button className="header-icon-button" onClick={props.onLearning} aria-label="Open PS3D Learning Center" title="Open PS3D Learning Center"><CommandIcon name="help" /><span>Learn</span></button>
        <button className="header-icon-button" onClick={props.onAccess} aria-label="Open MCP account and token access" title="Open MCP account and token access"><CommandIcon name="mcp" /><span>MCP Access</span></button>
        <button className={`header-icon-button design-health-action ${props.designHealthStatus}`} onClick={props.onDesignHealth} aria-label={`Open Design Health Center, score ${props.designHealthScore}`} title="Open Design Health Center"><CommandIcon name="inspect" /><span>Health {props.designHealthScore}</span></button>
        <button className="primary header-icon-button" onClick={props.onSave} aria-label="Save PS3D project locally" title="Save PS3D project locally"><CommandIcon name="save" /><span>Save local</span></button>
      </div>
    </header>
    <nav className="cad-menu-bar" aria-label="Application menus" ref={menuRef} onKeyDown={(event) => { if (event.key === "Escape" && openMenu !== null && openMenu !== "file") { event.stopPropagation(); const trigger = triggerRefs.current.get(openMenu); setOpenMenu(null); trigger?.focus(); } }}>
      <div className="cad-menu-groups">
        <div className="cad-menu">
          <button
            className={openMenu === "file" ? "active" : ""}
            aria-haspopup="dialog"
            aria-expanded={openMenu === "file"}
            onClick={() => setOpenMenu((current) => current === "file" ? null : "file")}
          ><CommandIcon name="file" />File<span aria-hidden="true">⌄</span></button>
        </div>
        {menus.map((menu) => <div className="cad-menu" key={menu.id}>
          <button
            ref={(node) => { if (node === null) triggerRefs.current.delete(menu.id); else triggerRefs.current.set(menu.id, node); }}
            className={openMenu === menu.id ? "active" : ""}
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.id}
            onClick={() => setOpenMenu((current) => current === menu.id ? null : menu.id)}
            onMouseEnter={() => { if (openMenu !== null && openMenu !== "file" && openMenu !== menu.id) setOpenMenu(menu.id); }}
            onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpenMenu(menu.id); } }}
          ><CommandIcon name={menu.icon} />{menu.label}<span aria-hidden="true">⌄</span></button>
          {openMenu === menu.id && <div className="cad-menu-popover" role="menu" aria-label={`${menu.label} menu`} ref={popoverRef} onKeyDown={onPopoverKeyDown}>
            {menu.items.map((item) => <button
              key={item.id}
              role="menuitem"
              className={item.divider === true ? "has-divider" : ""}
              disabled={item.disabled}
              {...(item.hint === undefined ? {} : { title: item.hint })}
              onClick={() => runMenuItem(item)}
            >
              <span className="menu-item-icon"><CommandIcon name={item.icon} /></span>
              <span>{item.label}</span>
              {item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
            </button>)}
          </div>}
        </div>)}
      </div>
      <div className="quick-command-strip" aria-label="Quick commands">
        <span className="color-wheel" title="PS3D workspace color wheel" aria-label="Workspace color wheel" />
        <button onClick={props.onFit} disabled={!is3d} aria-label="Fit active 3D view" title="Fit active 3D view"><CommandIcon name="fit" /><span>Fit</span><kbd>F</kbd></button>
        <button onClick={props.onMeasure} disabled={!is3d} aria-label="Measure active 3D view" title="Measure active 3D view"><CommandIcon name="measure" /><span>Measure</span><kbd>M</kbd></button>
        <button onClick={props.onExchange} aria-label="Open 3D Exchange Center" title="Open 3D Exchange Center"><CommandIcon name="exchange" /><span>Exchange</span></button>
        <button className={`design-health-quick ${props.designHealthStatus}`} onClick={props.onDesignHealth} aria-label="Open deterministic design health review" title="Open deterministic design health review"><CommandIcon name="inspect" /><span>Health</span><kbd>{props.designHealthScore}</kbd></button>
        <button className="command-search-button" onClick={props.onCommandPalette} aria-label="Open all CAD commands" title="Open all CAD commands"><CommandIcon name="command" /><span>All commands</span><kbd>Ctrl K</kbd></button>
      </div>
    </nav>
    <nav className="workspace-tabs" aria-label="CAD workspaces" role="tablist">
      {WORKSPACES.map((workspace) => <button
        key={workspace.id}
        className={!props.masterCartOpen && !props.renderStudioOpen && props.project.activeWorkspace === workspace.id ? "active" : ""}
        data-workspace={workspace.id}
        role="tab"
        aria-selected={!props.masterCartOpen && !props.renderStudioOpen && props.project.activeWorkspace === workspace.id}
        onClick={() => props.onWorkspace(workspace.id)}
      ><span aria-hidden="true"><CommandIcon name={workspace.icon} /></span>{workspace.label}</button>)}
      <button className={props.masterCartOpen ? "active master-cart-tab" : "master-cart-tab"} data-workspace="master-cart" role="tab" aria-selected={props.masterCartOpen} onClick={props.onMasterCart}><span aria-hidden="true"><CommandIcon name="master-cart" /></span>Master Cart</button>
      <button className={props.renderStudioOpen ? "active render-studio-tab" : "render-studio-tab"} data-workspace="render-studio" role="tab" aria-selected={props.renderStudioOpen} onClick={props.onRenderStudio}><span aria-hidden="true"><CommandIcon name="appearance" /></span>Render Studio</button>
      <div className="workspace-health"><button className={`design-health-status ${props.designHealthStatus}`} onClick={props.onDesignHealth} aria-label={`Design health ${props.designHealthStatus}, score ${props.designHealthScore}`}><span className={`health-dot ${props.designHealthStatus}`} />design {props.designHealthStatus} · {props.designHealthScore}</button></div>
    </nav>
    <FileApplicationMenu
      open={openMenu === "file"}
      project={props.project}
      status={props.status}
      workspaceStatus={props.fileWorkspaceStatus}
      recentProjects={props.recentProjects}
      onClose={() => setOpenMenu(null)}
      onNew={props.onNew}
      onOpen={props.onOpen}
      onOpenNative={props.onOpenNative}
      onOpenRecent={props.onOpenRecent}
      onSave={props.onSave}
      onSaveAs={props.onSaveAs}
      onSaveCopy={props.onSaveCopy}
      onDownload={props.onDownload}
      onInitializeWorkspace={props.onInitializeFileWorkspace}
      onRecover={props.onRecoverProject}
      onClearCache={props.onClearFileCache}
      onExchange={props.onExchange}
      onRenderStudio={props.onRenderStudio}
      onWorkspace={props.onWorkspace}
      onPrint={props.onPrint}
      onLearning={props.onLearning}
    />
  </>;
}
