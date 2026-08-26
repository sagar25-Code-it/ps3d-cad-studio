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
}

export interface WorkbenchContextRequest {
  readonly workspace: WorkspaceId;
  readonly selectionId: string | null;
  readonly selectionKind?: WorkbenchSelectionKind;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
}

const TOPOLOGY_REASON = "Requires persistent B-rep face/body topology and an overlap preview; the bounded mesh kernel cannot execute this safely.";

export function classifyWorkbenchSelection(selectionId: string | null): WorkbenchSelectionKind {
  if (selectionId === null) return "empty";
  const namespace = selectionId.split(":", 1)[0];
  if (namespace === "entity" || namespace === "sketch") return "sketch";
  if (namespace === "profile") return "profile";
  if (namespace === "feature") return "feature";
  if (namespace === "body" || namespace === "part-preview" || namespace === "part-body") return "body";
  if (namespace === "component" || namespace === "master-cart") return "component";
  if (namespace === "mate") return "mate";
  if (namespace === "datum") return "datum";
  if (namespace === "surface") return "surface";
  if (namespace === "drawing" || namespace === "drawing-view") return "drawing";
  if (namespace === "electrical" || namespace === "electromechanical") return "electrical";
  if (namespace === "vehicle") return "vehicle";
  if (namespace === "project") return "project";
  return "other";
}

export function resolveWorkbenchContextCommands(request: WorkbenchContextRequest): readonly WorkbenchContextCommand[] {
  const kind = request.selectionKind ?? classifyWorkbenchSelection(request.selectionId);
  const commands: WorkbenchContextCommand[] = [
    command("history.undo", "Undo", "undo", "history", request.canUndo ?? false, "No earlier revision is available."),
    command("history.redo", "Redo", "redo", "history", request.canRedo ?? false, "No later revision is available.")
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

  if (kind === "sketch") commands.push(
    command("sketch.edit", "Edit Sketch", "sketch", "edit"),
    command("sketch.select-connected", "Select Connected Curves", "chain", "select"),
    command("sketch.select-tangent", "Select Tangent Chain", "tangent", "select"),
    command("sketch.dimension", "Driving Dimension", "dimension", "edit"),
    command("sketch.toggle-construction", "Normal / Construction", "construction", "edit"),
    command("selection.toggle-visibility", "Show / Hide Sketch Entity", "show", "visibility"),
    command("selection.delete", "Delete Sketch Entity", "trash", "edit", true, undefined, true)
  );

  if (kind === "profile") commands.push(
    command("feature.extrude", "Extrude Profile", "extrude", "create"),
    command("feature.revolve", "Revolve Profile", "revolve", "create", false, "Revolve remains a parameter study, not profile-driven solid topology."),
    command("sketch.select-loop", "Select Boundary Loop", "chain", "select"),
    command("inspect.properties", "Profile Area & Properties", "inspect", "inspect")
  );

  if (kind === "feature") commands.push(
    command("feature.edit", "Edit Feature Parameters", "edit", "edit"),
    command("feature.reveal-inputs", "Show Parent Sketch", "sketch", "select"),
    command("feature.suppress", "Suppress Feature", "hide", "edit", false, "Feature suppression requires an ordered dependency graph."),
    command("inspect.properties", "Properties", "inspect", "inspect")
  );

  if (kind === "body") commands.push(
    command("selection.toggle-visibility", "Show / Hide Body", "show", "visibility"),
    command("selection.isolate", "Isolate Body", "isolate", "visibility"),
    command("body.appearance", "Appearance", "appearance", "edit"),
    command("body.move", "Move / Copy", "move", "edit"),
    command("body.create-component", "Create Component from Body", "assembly", "assembly"),
    command("body.boolean-join", "Join", "unite", "edit", false, TOPOLOGY_REASON),
    command("body.boolean-cut", "Cut", "subtract", "edit", false, TOPOLOGY_REASON),
    command("body.boolean-intersect", "Intersect", "intersect", "edit", false, TOPOLOGY_REASON),
    command("inspect.properties", "Physical Properties", "inspect", "inspect"),
    command("selection.delete", "Delete Body", "trash", "edit", request.selectionId?.startsWith("part-body:") === true, request.selectionId?.startsWith("part-body:") === true ? undefined : "The qualified base body is revision-controlled and cannot be deleted here.", true)
  );

  if (kind === "component") commands.push(
    command("component.activate", "Activate Component", "assembly", "assembly", false, "Component-local activation needs the versioned document graph."),
    command("component.ground", "Ground / Unground", "fixed", "assembly"),
    command("selection.toggle-visibility", "Show / Hide Component", "show", "visibility"),
    command("selection.isolate", "Isolate Component", "isolate", "visibility", false, "Assembly isolate-all-except is not yet a persisted operation."),
    command("component.move", "Move Component", "move", "edit"),
    command("mate.create", "Joint / Mate", "mate", "assembly"),
    command("inspect.properties", "Component Properties", "inspect", "inspect"),
    command("selection.delete", "Delete Component", "trash", "edit", true, undefined, true)
  );

  if (kind === "mate") commands.push(
    command("mate.edit", "Edit Mate", "mate", "assembly"),
    command("mate.select-components", "Select Components", "select", "select"),
    command("mate.drive", "Drive / Animate", "play", "assembly", false, "Kinematic mate solving is not available in the direct-transform preview."),
    command("selection.delete", "Delete Mate", "trash", "edit", true, undefined, true)
  );

  if (kind === "datum") commands.push(
    command("sketch.create", "Create Sketch on Plane", "sketch", "create"),
    command("view.look-at", "Look At", "view", "view"),
    command("inspect.properties", "Datum Properties", "inspect", "inspect")
  );

  commands.push(
    command("view.fit", "Fit", "fit", "view"),
    command("view.home", "Home / Isometric", "home", "view")
  );
  return commands;
}

function command(id: string, label: string, icon: string, group: WorkbenchContextCommand["group"], enabled = true, disabledReason?: string, danger = false): WorkbenchContextCommand {
  return { id, label, icon, group, enabled, ...(disabledReason === undefined ? {} : { disabledReason }), ...(danger ? { danger: true } : {}) };
}
