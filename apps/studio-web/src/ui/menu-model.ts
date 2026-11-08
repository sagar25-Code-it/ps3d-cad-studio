import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";

/**
 * The application menubar, built as data so tests can hold it against the project state. Every item is a real,
 * wired command: an item that cannot run right now is disabled with a reason, never silently inert.
 */

export interface WorkbenchMenuItem {
  /** Stable for tests and keys. */
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** Why the item is disabled (shown as its tooltip), or a short hint for an enabled one. */
  readonly hint?: string | undefined;
  /** Draw a separator above this item. */
  readonly divider?: boolean;
  readonly action: () => void;
}

export interface WorkbenchMenu {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly items: readonly WorkbenchMenuItem[];
}

export interface WorkbenchMenuState {
  readonly workspace: WorkspaceId;
  readonly masterCartOpen: boolean;
  readonly renderStudioOpen: boolean;
  readonly working: boolean;
  readonly gridVisible: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Solid bodies made from sketches (join/cut/Combine targets). */
  readonly generalBodyCount: number;
  /** An analytic preview body (Block, Cylinder, …) is selected. */
  readonly previewBodySelected: boolean;
  /** A general solid body (built from a sketch extrude or revolve) is selected. */
  readonly generalBodySelected: boolean;
  /** The timeline feature the current selection resolves to, if any. */
  readonly selectedFeature?: { readonly name: string; readonly suppressed: boolean; readonly kind: "sketch" | "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "move-body" | "scale-body" | "move-face" | "offset-face" | "helix" | "thread" | "rib" | "dome" | "emboss" | "indent" | "sheet-base" | "sheet-flange" | "sheet-hem" | "sheet-edge-flange" | "hole" };
  /** Something deletable is selected: a timeline feature, a solid body, or a preview body. */
  readonly selectionDeletable: boolean;
  /** Solid bodies the Part analyses can look at (general solids and analytic bodies); defaults to the general solid count. */
  readonly analysisBodyCount?: number;
}

export interface WorkbenchMenuActions {
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onCommandPalette: () => void;
  readonly onNewSketch: () => void;
  readonly onCreateSolidFromSketch: () => void;
  readonly onCreatePrimitive: (shape: "block" | "cylinder" | "cone" | "sphere" | "torus") => void;
  readonly onCombine: () => void;
  readonly onInsertToAssembly: () => void;
  readonly onMasterCart: () => void;
  readonly onRenderStudio: () => void;
  readonly onEditSelectedFeature: () => void;
  readonly onToggleSuppressSelected: () => void;
  readonly onDeleteSelected: () => void;
  readonly onMoveSelectedBody: () => void;
  readonly onResizeSelectedBody: () => void;
  readonly onModifyGeneralBody: (modifier: "hole" | "fillet" | "chamfer" | "shell", scope?: "picked" | "all") => void;
  readonly onFit: () => void;
  readonly onHome: () => void;
  readonly onToggleGrid: () => void;
  readonly onWorkspace: (workspace: WorkspaceId) => void;
  readonly onDesignHealth: () => void;
  readonly onMeasure: () => void;
  readonly onExchange: () => void;
  readonly onAccess: () => void;
  readonly onConnectAi: () => void;
  readonly onExportStl: () => void;
  readonly onPlateJson: () => void;
  readonly onLearning: () => void;
  readonly onShortcuts: () => void;
  /** Opens a Part analysis (geometry check, interference, draft, wall thickness, curvature, section comb). Absent: the entries are not listed. */
  readonly onAnalysis?: (mode: "geometry-check" | "interference" | "draft" | "wall-thickness" | "gaussian-curvature" | "section-comb") => void;
}

/** Builds the menubar for the current state. Pure: same state and actions, same menus. */
export function buildWorkbenchMenus(state: WorkbenchMenuState, actions: WorkbenchMenuActions): readonly WorkbenchMenu[] {
  const overlayOpen = state.masterCartOpen || state.renderStudioOpen;
  const is3d = !overlayOpen && ["part", "assembly", "surface", "vehicle"].includes(state.workspace);
  const gridToggleEnabled = is3d || (!overlayOpen && state.workspace === "sketch");
  const feature = state.selectedFeature;

  const edit: WorkbenchMenu = { id: "edit", label: "Edit", icon: "command", items: [
    { id: "edit.undo", label: "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: !state.canUndo || state.working, hint: state.canUndo ? undefined : "Nothing to undo in this session", action: actions.onUndo },
    { id: "edit.redo", label: "Redo", icon: "redo", shortcut: "Ctrl+Shift+Z", disabled: !state.canRedo || state.working, hint: state.canRedo ? undefined : "Nothing to redo", action: actions.onRedo },
    { id: "edit.find", label: "Find command", icon: "command", shortcut: "S", divider: true, action: actions.onCommandPalette }
  ] };

  const create: WorkbenchMenu = { id: "create", label: "Create", icon: "insert", items: [
    { id: "create.sketch", label: "New sketch…", icon: "sketch", hint: "On a datum plane, an offset, or a face of a solid", action: actions.onNewSketch },
    { id: "create.solid", label: "Solid from sketch…", icon: "extrude", hint: "Extrude or revolve a closed profile; join or cut a solid", action: actions.onCreateSolidFromSketch },
    { id: "create.block", label: "Block", icon: "box", divider: true, hint: "Independent preview body", action: () => actions.onCreatePrimitive("block") },
    { id: "create.cylinder", label: "Cylinder", icon: "cylinder", hint: "Independent preview body", action: () => actions.onCreatePrimitive("cylinder") },
    { id: "create.cone", label: "Cone", icon: "cone", hint: "Independent preview body", action: () => actions.onCreatePrimitive("cone") },
    { id: "create.sphere", label: "Sphere", icon: "sphere", hint: "Independent preview body", action: () => actions.onCreatePrimitive("sphere") },
    { id: "create.torus", label: "Torus", icon: "torus", hint: "Ring body: sizeMm[0] = major diameter, sizeMm[2] = tube diameter", action: () => actions.onCreatePrimitive("torus") },
    { id: "create.insert-assembly", label: "Insert part into assembly", icon: "assemble", divider: true, action: actions.onInsertToAssembly },
    { id: "create.master-cart", label: "Master Cart component library", icon: "master-cart", action: actions.onMasterCart },
    { id: "create.render-studio", label: "Render Studio scene", icon: "appearance", action: actions.onRenderStudio }
  ] };

  const modify: WorkbenchMenu = { id: "modify", label: "Modify", icon: "edit", items: [
    { id: "modify.edit-feature", label: feature === undefined ? "Edit feature…" : `Edit ${feature.name}…`, icon: "edit", disabled: feature === undefined,
      hint: feature === undefined ? "Select a timeline feature or a solid first" : feature.kind === "sketch" ? "Reopens the sketch for editing" : "Distance, direction and extent; the solid rebuilds", action: actions.onEditSelectedFeature },
    { id: "modify.suppress", label: feature?.suppressed === true ? `Unsuppress ${feature.name}` : feature === undefined ? "Suppress feature" : `Suppress ${feature.name}`, icon: "eye-off", disabled: feature === undefined,
      hint: feature === undefined ? "Select a timeline feature or a solid first" : "Skips the step without deleting it", action: actions.onToggleSuppressSelected },
    { id: "modify.delete", label: "Delete selection", icon: "trash", shortcut: "Del", disabled: !state.selectionDeletable,
      hint: state.selectionDeletable ? "Features built on it go with it" : "Select a feature or a body first", action: actions.onDeleteSelected },
    { id: "modify.move", label: "Move body…", icon: "move", divider: true, disabled: !state.previewBodySelected,
      hint: state.previewBodySelected ? "Translate and rotate in the inspector" : "Select a preview body (Block, Cylinder, …) first", action: actions.onMoveSelectedBody },
    { id: "modify.resize", label: "Resize body…", icon: "scale", disabled: !state.previewBodySelected,
      hint: state.previewBodySelected ? "Edit its dimensions in the inspector" : "Select a preview body (Block, Cylinder, …) first", action: actions.onResizeSelectedBody },
    { id: "modify.combine", label: "Combine bodies…", icon: "unite", divider: true, disabled: state.generalBodyCount < 2,
      hint: state.generalBodyCount < 2 ? "Needs two solid bodies made from sketches" : "Join, cut or intersect two solids", action: actions.onCombine },
    { id: "modify.hole", label: "Hole…", icon: "hole", divider: true, disabled: !state.generalBodySelected,
      hint: state.generalBodySelected ? "Drill a through-hole along +Z into the selected solid" : "Select a solid body (from Extrude or Revolve) first", action: () => actions.onModifyGeneralBody("hole") },
    { id: "modify.fillet", label: "Fillet…", icon: "fillet", disabled: !state.generalBodySelected,
      hint: state.generalBodySelected ? "Click any sharp edge of the selected solid to round it" : "Select a solid body (from Extrude or Revolve) first", action: () => actions.onModifyGeneralBody("fillet") },
    { id: "modify.chamfer", label: "Chamfer…", icon: "chamfer", disabled: !state.generalBodySelected,
      hint: state.generalBodySelected ? "Click any sharp edge of the selected solid to bevel it" : "Select a solid body (from Extrude or Revolve) first", action: () => actions.onModifyGeneralBody("chamfer") },
    { id: "modify.fillet-all", label: "Fillet all edges…", icon: "fillet", disabled: !state.generalBodySelected,
      hint: state.generalBodySelected ? "Round every sharp convex edge on the selected solid" : "Select a solid body (from Extrude or Revolve) first", action: () => actions.onModifyGeneralBody("fillet", "all") },
    { id: "modify.chamfer-all", label: "Chamfer all edges…", icon: "chamfer", disabled: !state.generalBodySelected,
      hint: state.generalBodySelected ? "Bevel every sharp convex edge on the selected solid" : "Select a solid body (from Extrude or Revolve) first", action: () => actions.onModifyGeneralBody("chamfer", "all") },
    { id: "modify.shell", label: "Shell…", icon: "shell", disabled: !state.generalBodySelected,
      hint: state.generalBodySelected ? "Hollow the selected solid with the +Z face left open" : "Select a solid body (from Extrude or Revolve) first", action: () => actions.onModifyGeneralBody("shell") }
  ] };

  const view: WorkbenchMenu = { id: "view", label: "View", icon: "view", items: [
    { id: "view.fit", label: "Fit canvas", icon: "fit", shortcut: "F", disabled: !is3d, hint: is3d ? undefined : "Open a 3D workspace first", action: actions.onFit },
    { id: "view.home", label: "Home view", icon: "home", disabled: !is3d, hint: is3d ? undefined : "Open a 3D workspace first", action: actions.onHome },
    { id: "view.grid", label: state.gridVisible ? "Hide grid" : "Show grid", icon: "grid", disabled: !gridToggleEnabled, action: actions.onToggleGrid },
    { id: "view.render-studio", label: "Render Studio", icon: "appearance", divider: true, action: actions.onRenderStudio },
    { id: "view.drawing", label: "Drawing workspace", icon: "drawing", action: () => actions.onWorkspace("drawing") },
    { id: "view.electrical", label: "Electrical workspace", icon: "electrical", action: () => actions.onWorkspace("electrical") },
    { id: "view.vehicle", label: "Vehicle workspace", icon: "vehicle", action: () => actions.onWorkspace("vehicle") }
  ] };

  const inspect: WorkbenchMenu = { id: "inspect", label: "Inspect", icon: "inspect", items: [
    { id: "inspect.health", label: "Design Health Center", icon: "inspect", action: actions.onDesignHealth },
    { id: "inspect.measure", label: "Measure points", icon: "measure", shortcut: "M", disabled: !is3d, hint: is3d ? undefined : "Open a 3D workspace first", action: actions.onMeasure },
    { id: "inspect.fit", label: "Fit current model", icon: "fit", disabled: !is3d, action: actions.onFit },
    ...analysisItems(state, actions, overlayOpen),
    { id: "inspect.catalog", label: "Capability catalog", icon: "command", shortcut: "S", action: actions.onCommandPalette }
  ] };

  const tools: WorkbenchMenu = { id: "tools", label: "Tools", icon: "automate", items: [
    { id: "tools.connect-ai", label: "Connect an AI host…", icon: "mcp", hint: "Recipes for Claude, Cursor and VS Code, with a connection test", action: actions.onConnectAi },
    { id: "tools.exchange", label: "3D Exchange Center…", icon: "exchange", divider: true, hint: "Import and export mesh formats", action: actions.onExchange },
    { id: "tools.export-stl", label: "Export STL (all shown)", icon: "export", action: actions.onExportStl },
    { id: "tools.plate-json", label: "Plate JSON (plate only)", icon: "json", action: actions.onPlateJson },
    { id: "tools.mcp-workspace", label: "MCP workspace", icon: "mcp", divider: true, action: () => actions.onWorkspace("automate") },
    { id: "tools.mcp-access", label: "MCP account and tokens", icon: "mcp", action: actions.onAccess }
  ] };

  const help: WorkbenchMenu = { id: "help", label: "Help", icon: "help", items: [
    { id: "help.learning", label: "Learning Center and PDF manual", icon: "help", action: actions.onLearning },
    { id: "help.shortcuts", label: "Keyboard shortcuts", icon: "command", shortcut: "?", action: actions.onShortcuts },
    { id: "help.commands", label: "All commands and capabilities", icon: "command", shortcut: "S", action: actions.onCommandPalette },
    { id: "help.health", label: "Design readiness and dependencies", icon: "inspect", action: actions.onDesignHealth }
  ] };

  return [edit, create, modify, view, inspect, tools, help];
}

const ANALYSIS_ENTRIES = [
  { mode: "geometry-check", label: "Geometry check", icon: "inspect", hint: "Open edges, non-manifold edges, flipped faces, self-intersection" },
  { mode: "interference", label: "Interference", icon: "interference", hint: "Shared volume between every pair of solids" },
  { mode: "draft", label: "Draft analysis", icon: "draft", hint: "Colour faces by draft angle against a pull direction" },
  { mode: "wall-thickness", label: "Wall thickness", icon: "section", hint: "Thinnest wall, coloured by thickness" },
  { mode: "gaussian-curvature", label: "Curvature map", icon: "bezier", hint: "Gaussian and mean curvature, coloured" },
  { mode: "section-comb", label: "Section curvature comb", icon: "spline", hint: "Comb on the cut of a body" }
] as const;

function analysisItems(state: WorkbenchMenuState, actions: WorkbenchMenuActions, overlayOpen: boolean): readonly WorkbenchMenuItem[] {
  const open = actions.onAnalysis;
  if (open === undefined) return [];
  const bodies = state.analysisBodyCount ?? state.generalBodyCount;
  const reason = overlayOpen || state.workspace !== "part" ? "Open the Part workspace first" : bodies === 0 ? "Create a solid body first" : undefined;
  return ANALYSIS_ENTRIES.map((entry, index): WorkbenchMenuItem => ({
    id: `inspect.analysis.${entry.mode}`,
    label: entry.label,
    icon: entry.icon,
    disabled: reason !== undefined,
    hint: reason ?? entry.hint,
    ...(index === 0 ? { divider: true } : {}),
    action: () => open(entry.mode)
  }));
}
