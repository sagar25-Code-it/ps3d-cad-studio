import { useEffect, useRef, useState } from "react";
import type { WorkspaceId, WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { DesignHealthStatus } from "../../../../packages/workbench-health/src/index.js";
import { PS3D_BRAND } from "../brand.js";
import { BrandLogo } from "./BrandLogo.js";
import { CommandIcon } from "./CommandIcon.js";

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
  readonly masterCartOpen: boolean;
  readonly status: "starting" | "ready" | "working" | "error";
  readonly onWorkspace: (workspace: WorkspaceId) => void;
  readonly onMasterCart: () => void;
  readonly onCommandPalette: () => void;
  readonly onDesignHealth: () => void;
  readonly onExchange: () => void;
  readonly onLearning: () => void;
  readonly onAccess: () => void;
  readonly onSave: () => void;
  readonly onDownload: () => void;
  readonly onOpen: () => void;
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

interface MenuItem {
  readonly label: string;
  readonly icon: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly action: () => void;
}

interface MenuDefinition {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly items: readonly MenuItem[];
}

export function WorkbenchHeader(props: WorkbenchHeaderProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLElement>(null);
  const is3d = !props.masterCartOpen && (props.project.activeWorkspace === "part" || props.project.activeWorkspace === "assembly" || props.project.activeWorkspace === "surface" || props.project.activeWorkspace === "vehicle");

  useEffect(() => {
    if (openMenu === null) return;
    const closeOutside = (event: MouseEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target) !== true) setOpenMenu(null);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [openMenu]);

  const menus: readonly MenuDefinition[] = [
    { id: "file", label: "File", icon: "file", items: [
      { label: "Open project", icon: "open", shortcut: "Ctrl+O", action: props.onOpen },
      { label: "Save local", icon: "save", shortcut: "Ctrl+S", action: props.onSave },
      { label: "Download copy", icon: "download", action: props.onDownload },
      { label: "3D Exchange Center", icon: "exchange", action: props.onExchange }
    ] },
    { id: "edit", label: "Edit", icon: "command", items: [
      { label: "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: !props.canUndo || props.status === "working", action: props.onUndo },
      { label: "Redo", icon: "redo", shortcut: "Ctrl+Shift+Z", disabled: !props.canRedo || props.status === "working", action: props.onRedo },
      { label: "Find command", icon: "command", shortcut: "Ctrl+K", action: props.onCommandPalette }
    ] },
    { id: "create", label: "Create", icon: "insert", items: [
      { label: "Sketch tools", icon: "sketch", action: () => props.onWorkspace("sketch") },
      { label: "Part features", icon: "extrude", action: () => props.onWorkspace("part") },
      { label: "Assembly components", icon: "assembly", action: () => props.onWorkspace("assembly") },
      { label: "Master Cart component library", icon: "master-cart", action: props.onMasterCart },
      { label: "Surface tools", icon: "surface", action: () => props.onWorkspace("surface") },
      { label: "Electrical schematic", icon: "electrical", action: () => props.onWorkspace("electrical") },
      { label: "Vehicle engineering", icon: "vehicle", action: () => props.onWorkspace("vehicle") }
    ] },
    { id: "view", label: "View", icon: "view", items: [
      { label: "Fit canvas", icon: "fit", shortcut: "F", disabled: !is3d, action: props.onFit },
      { label: "Home view", icon: "home", disabled: !is3d, action: props.onHome },
      { label: props.gridVisible ? "Hide grid" : "Show grid", icon: "grid", disabled: !is3d, action: props.onToggleGrid },
      { label: "Drawing workspace", icon: "drawing", action: () => props.onWorkspace("drawing") },
      { label: "Electrical workspace", icon: "electrical", action: () => props.onWorkspace("electrical") },
      { label: "Vehicle workspace", icon: "vehicle", action: () => props.onWorkspace("vehicle") }
    ] },
    { id: "inspect", label: "Inspect", icon: "inspect", items: [
      { label: "Design Health Center", icon: "inspect", action: props.onDesignHealth },
      { label: "Measure points", icon: "measure", shortcut: "M", disabled: !is3d, action: props.onMeasure },
      { label: "Fit current model", icon: "fit", disabled: !is3d, action: props.onFit },
      { label: "Capability catalog", icon: "command", shortcut: "Ctrl+K", action: props.onCommandPalette }
    ] },
    { id: "automate", label: "Automate", icon: "automate", items: [
      { label: "MCP workspace", icon: "mcp", action: () => props.onWorkspace("automate") },
      { label: "MCP account and tokens", icon: "mcp", action: props.onAccess },
      { label: "Python linking", icon: "python", action: () => props.onWorkspace("automate") },
      { label: "Search automation commands", icon: "command", action: props.onCommandPalette }
    ] },
    { id: "help", label: "Help", icon: "help", items: [
      { label: "Learning Center and PDF manual", icon: "help", action: props.onLearning },
      { label: "Design readiness and dependencies", icon: "inspect", action: props.onDesignHealth },
      { label: "Command and shortcut guide", icon: "command", shortcut: "Ctrl+K", action: props.onCommandPalette },
      { label: "Capability truth labels", icon: "inspect", action: props.onCommandPalette }
    ] }
  ];

  const runMenuItem = (item: MenuItem): void => {
    setOpenMenu(null);
    item.action();
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
    <nav className="cad-menu-bar" aria-label="Application menus" ref={menuRef} onKeyDown={(event) => { if (event.key === "Escape") setOpenMenu(null); }}>
      <div className="cad-menu-groups">
        {menus.map((menu) => <div className="cad-menu" key={menu.id}>
          <button
            className={openMenu === menu.id ? "active" : ""}
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.id}
            onClick={() => setOpenMenu((current) => current === menu.id ? null : menu.id)}
          ><CommandIcon name={menu.icon} />{menu.label}<span aria-hidden="true">⌄</span></button>
          {openMenu === menu.id && <div className="cad-menu-popover" role="menu" aria-label={`${menu.label} menu`}>
            {menu.items.map((item) => <button key={item.label} role="menuitem" disabled={item.disabled} onClick={() => runMenuItem(item)}>
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
        className={!props.masterCartOpen && props.project.activeWorkspace === workspace.id ? "active" : ""}
        data-workspace={workspace.id}
        role="tab"
        aria-selected={!props.masterCartOpen && props.project.activeWorkspace === workspace.id}
        onClick={() => props.onWorkspace(workspace.id)}
      ><span aria-hidden="true"><CommandIcon name={workspace.icon} /></span>{workspace.label}</button>)}
      <button className={props.masterCartOpen ? "active master-cart-tab" : "master-cart-tab"} data-workspace="master-cart" role="tab" aria-selected={props.masterCartOpen} onClick={props.onMasterCart}><span aria-hidden="true"><CommandIcon name="master-cart" /></span>Master Cart</button>
      <div className="workspace-health"><button className={`design-health-status ${props.designHealthStatus}`} onClick={props.onDesignHealth} aria-label={`Design health ${props.designHealthStatus}, score ${props.designHealthScore}`}><span className={`health-dot ${props.designHealthStatus}`} />design {props.designHealthStatus} · {props.designHealthScore}</button></div>
    </nav>
  </>;
}
