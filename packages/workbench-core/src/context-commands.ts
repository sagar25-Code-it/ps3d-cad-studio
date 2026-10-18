import type { WorkspaceId } from "./types.js";

export type WorkbenchSelectionKind = "empty" | "project" | "datum" | "sketch" | "profile" | "feature" | "body" | "component" | "mate" | "surface" | "drawing" | "electrical" | "vehicle" | "other";

export interface WorkbenchContextCommand {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly group: "create" | "select" | "edit" | "assembly" | "visibility" | "inspect" | "view" | "history";
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly danger?: boolean;
  readonly shortcut?: string;
  readonly children?: readonly WorkbenchContextCommand[];
}

export interface WorkbenchContextRequest {
  readonly workspace: WorkspaceId;
  readonly selectionId: string | null;
  readonly selectionKind?: WorkbenchSelectionKind;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
}

const TOPOLOGY_REASON = "Requires persistent general B-rep face/body topology and an overlap preview; the bounded analytic kernel cannot execute this safely.";
const ANALYTIC_BODY_REASON = "Select an independent analytic body. Qualified worker bodies remain immutable from this direct-modeling menu.";
const GENERAL_BODY_COMPONENT_REASON = "Assembly components are box, cylinder, or plate snapshots; a kernel-built body cannot be inserted yet, and inserting would add the wrong geometry.";
const PROPERTIES_REASON ="Property values for the current selection are shown in the inspector panel; there is no separate properties action in this preview.";

export function classifyWorkbenchSelection(selectionId: string | null): WorkbenchSelectionKind {
  if (selectionId === null) return "empty";
  const namespace = selectionId.split(":", 1)[0];
  if (namespace === "entity" || namespace === "sketch") return "sketch";
  if (namespace === "profile") return "profile";
  if (namespace === "feature") return "feature";
  if (namespace === "body" || namespace === "part-preview" || namespace === "part-body" || namespace === "general-body") return "body";
  if (namespace === "component" || namespace === "master-cart") return "component";
  if (namespace === "mate") return "mate";
  if (namespace === "datum") return "datum";
  if (namespace === "surface") return "surface";
  if (namespace === "drawing" || namespace === "drawing-view") return "drawing";
  if (namespace === "electrical" || namespace === "electromechanical" || namespace === "electrical-component" || namespace === "electrical-net") return "electrical";
  if (namespace === "vehicle" || namespace?.startsWith("vehicle-") === true) return "vehicle";
  if (namespace === "project") return "project";
  return "other";
}

export function resolveWorkbenchContextCommands(request: WorkbenchContextRequest): readonly WorkbenchContextCommand[] {
  const kind = request.selectionKind ?? classifyWorkbenchSelection(request.selectionId);
  const commands: WorkbenchContextCommand[] = [
    command("history.undo", "Undo", "undo", "history", request.canUndo ?? false, "No earlier revision is available.", false, "Ctrl+Z"),
    command("history.redo", "Redo", "redo", "history", request.canRedo ?? false, "No later revision is available.", false, "Ctrl+Shift+Z")
  ];

  if (kind === "empty") {
    if (request.workspace === "sketch") commands.push(
      command("sketch.look-at", "Look At sketch plane", "view", "view"),
      command("sketch.select-profile", "Selection: Profile", "profile", "select"),
      command("sketch.select-curve", "Selection: Sketch Curve", "sketch", "select"),
      command("sketch.select-connected", "Selection: Connected", "chain", "select"),
      command("sketch.select-tangent", "Selection: Tangent", "tangent", "select"),
      command("sketch.finish", "Finish Sketch", "finish", "edit")
    );
    else if (["part", "assembly", "surface", "vehicle"].includes(request.workspace)) commands.push(
      command("sketch.create", "Create Sketch", "sketch", "create"),
      command("inspect.measure", "Measure", "measure", "inspect"),
      command("clipboard.paste", "Paste", "copy", "edit", false, "Clipboard geometry import is not exposed in this preview.")
    );
  }

  if (kind === "sketch") {
    const sketchEntity = request.selectionId?.startsWith("entity:") === true;
    const sketchNodeReason = "Select an individual sketch entity; the sketch node itself only supports Edit Sketch and selection filters.";
    commands.push(
      command("sketch.edit", "Edit Sketch", "sketch", "edit"),
      command("sketch.select-connected", "Select Connected Curves", "chain", "select"),
      command("sketch.select-tangent", "Select Tangent Chain", "tangent", "select"),
      command("sketch.dimension", "Driving Dimension", "dimension", "edit"),
      command("sketch.toggle-construction", "Normal / Construction", "construction", "edit", sketchEntity, sketchEntity ? undefined : sketchNodeReason),
      command("selection.toggle-visibility", "Show / Hide Sketch Entity", "show", "visibility", sketchEntity, sketchEntity ? undefined : sketchNodeReason),
      command("selection.delete", "Delete Sketch Entity", "trash", "edit", sketchEntity, sketchEntity ? undefined : sketchNodeReason, true)
    );
  }

  if (kind === "profile") commands.push(
    command("feature.extrude", "Extrude Profile", "extrude", "create"),
    command("feature.revolve", "Revolve Profile", "revolve", "create", false, "Revolve remains a parameter study, not profile-driven solid topology."),
    command("sketch.select-loop", "Select Boundary Loop", "chain", "select", false, "Boundary-loop selection is not wired in this preview; use Select Connected Curves."),
    command("inspect.properties", "Profile Area & Properties", "inspect", "inspect", false, PROPERTIES_REASON)
  );

  if (kind === "feature") commands.push(
    command("feature.edit", "Edit Feature Parameters", "edit", "edit"),
    command("feature.reveal-inputs", "Show Parent Sketch", "sketch", "select"),
    command("feature.suppress", "Suppress Feature", "hide", "edit", false, "Feature suppression requires an ordered dependency graph."),
    command("inspect.properties", "Properties", "inspect", "inspect", false, PROPERTIES_REASON)
  );

  if (kind === "body") {
    const analyticBody = request.selectionId?.startsWith("part-body:") === true;
    const generalBody = request.selectionId?.startsWith("general-body:") === true;
    const directBody = analyticBody || generalBody;
    const MESH_BODY_REASON = "General mesh solids support visibility and delete here; face, blend, and Boolean editing needs the qualified B-rep kernel.";
    commands.push(
      command("selection.toggle-visibility", "Show / Hide Body", "show", "visibility", directBody, directBody ? undefined : ANALYTIC_BODY_REASON),
      command("selection.isolate", "Isolate Body", "isolate", "visibility", analyticBody, analyticBody ? undefined : (generalBody ? MESH_BODY_REASON : ANALYTIC_BODY_REASON)),
      command("body.appearance", "Appearance", "appearance", "edit"),
      command("body.move", "Move / Copy", "move", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
      submenu("body.direct-features", "Direct & Detail Features", "edge", "edit", [
        command("body.move-face", "Move Face", "move-face", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.offset-face", "Offset Face", "offset-face", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.replace-face", "Replace Face", "replace-face", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.delete-face", "Delete Face / Heal", "delete-face", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.edge-blend", "Edge Blend", "edge-blend", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.chamfer", "Chamfer", "chamfer", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.resize-blend", "Resize Blend", "resize-blend", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.shell", "Shell", "shell", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.draft", "Draft", "draft", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.trim", "Trim Body", "trim", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON)
      ]),
      submenu("body.copy-features", "Pattern & Mirror", "pattern", "edit", [
        command("body.pattern-feature", "Pattern Feature", "pattern", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
        command("body.mirror-feature", "Mirror Feature", "mirror", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON)
      ]),
      command("body.create-component", "Create Component from Body", "assembly", "assembly", !generalBody, generalBody ? GENERAL_BODY_COMPONENT_REASON : undefined),
      command("body.boolean-join", "Unite", "unite", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
      command("body.boolean-cut", "Subtract", "subtract", "edit", analyticBody, analyticBody ? undefined : ANALYTIC_BODY_REASON),
      command("body.boolean-intersect", "Intersect", "boolean", "edit", false, TOPOLOGY_REASON),
      command("body.update-model", "Update Model", "update-model", "history", true),
      command("inspect.properties", "Physical Properties", "inspect", "inspect", false, PROPERTIES_REASON),
      command("selection.delete", "Delete Body", "trash", "edit", directBody, directBody ? undefined : "The qualified base body is revision-controlled and cannot be deleted here.", true)
    );
  }

  if (kind === "component") commands.push(
    command("component.activate", "Activate Component", "assembly", "assembly", false, "Component-local activation needs the versioned document graph."),
    command("component.ground", "Ground / Unground", "fixed", "assembly"),
    command("selection.toggle-visibility", "Show / Hide Component", "show", "visibility"),
    command("selection.isolate", "Isolate Component", "isolate", "visibility", false, "Assembly isolate-all-except is not yet a persisted operation."),
    command("component.move", "Move Component", "move", "edit"),
    command("mate.create", "Joint / Mate", "mate", "assembly"),
    command("inspect.properties", "Component Properties", "inspect", "inspect", false, PROPERTIES_REASON),
    command("selection.delete", "Delete Component", "trash", "edit", true, undefined, true)
  );

  if (kind === "electrical") {
    const isComponent = request.selectionId?.startsWith("electrical-component:") === true;
    const isNet = request.selectionId?.startsWith("electrical-net:") === true;
    const deletable = isComponent || isNet;
    const selectReason = "Select a device or net on the schematic sheet first.";
    commands.push(
      command("electrical.edit", "Edit in Inspector", "edit", "edit", deletable, deletable ? undefined : selectReason),
      command("inspect.properties", isNet ? "Net Properties" : "Device Properties", "inspect", "inspect", false, PROPERTIES_REASON),
      command("selection.delete", isNet ? "Delete Net" : "Delete Device", "trash", "edit", deletable, deletable ? undefined : selectReason, true)
    );
  }

  if (kind === "mate") commands.push(
    command("mate.edit", "Edit Mate", "mate", "assembly", false, "Mate records are delete-and-recreate in this preview; delete the mate and create a new one."),
    command("mate.select-components", "Select Components", "select", "select"),
    command("mate.drive", "Drive / Animate", "play", "assembly", false, "Kinematic mate solving is not available in the direct-transform preview."),
    command("selection.delete", "Delete Mate", "trash", "edit", true, undefined, true)
  );

  if (kind === "datum") commands.push(
    command("sketch.create", "Create Sketch on Plane", "sketch", "create"),
    command("view.look-at", "Look At", "view", "view"),
    command("inspect.properties", "Datum Properties", "inspect", "inspect", false, PROPERTIES_REASON)
  );

  if (kind === "surface") commands.push(
    command("sketch.create", "Create Sketch", "sketch", "create"),
    command("inspect.measure", "Measure", "measure", "inspect")
  );

  if (kind === "vehicle") commands.push(
    command("inspect.measure", "Measure", "measure", "inspect"),
    command("view.look-at", "Look At", "view", "view"),
    command("inspect.properties", "Member / Hardpoint Properties", "inspect", "inspect", false, PROPERTIES_REASON)
  );

  if (["part", "assembly", "surface", "vehicle"].includes(request.workspace)) {
    commands.push(
      submenu("view.named-views", "Named Views & Projection", "view", "view", [
        command("view.orientation.front", "Front", "view", "view", true, undefined, false, "1"),
        command("view.orientation.top", "Top", "view", "view", true, undefined, false, "2"),
        command("view.orientation.right", "Right", "view", "view", true, undefined, false, "3"),
        command("view.orientation.isometric", "Isometric", "home", "view", true, undefined, false, "4"),
        command("view.projection.perspective", "Perspective", "view", "view"),
        command("view.projection.orthographic", "Orthographic", "view", "view")
      ]),
      command("view.fit", "Fit", "fit", "view", true, undefined, false, "F"),
      command("view.home", "Home / Isometric", "home", "view")
    );
  }
  return commands;
}

function command(id: string, label: string, icon: string, group: WorkbenchContextCommand["group"], enabled = true, disabledReason?: string, danger = false, shortcut?: string): WorkbenchContextCommand {
  return { id, label, icon, group, enabled, ...(disabledReason === undefined ? {} : { disabledReason }), ...(danger ? { danger: true } : {}), ...(shortcut === undefined ? {} : { shortcut }) };
}

function submenu(id: string, label: string, icon: string, group: WorkbenchContextCommand["group"], children: readonly WorkbenchContextCommand[]): WorkbenchContextCommand {
  return { id, label, icon, group, enabled: children.some((child) => child.enabled), children };
}
