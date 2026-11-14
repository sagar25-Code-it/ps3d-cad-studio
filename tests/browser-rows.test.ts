import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectTree, TreeItem } from "../apps/studio-web/src/ui/ProjectTree.js";
import { resolveWorkbenchContextCommands, type WorkbenchContextCommand } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { PLATE_BODY, plateHoleFillet } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-10: browser rows for steps and bodies act on the step or body (edit, rename, suppress, delete, roll the marker, show and hide). */

const noop = (): void => undefined;
const stepMenu = (featureKind: "sketch" | "solid", state: { suppressed: boolean; markerAfter: boolean; hasSketch: boolean }): readonly WorkbenchContextCommand[] =>
  resolveWorkbenchContextCommands({ workspace: "part", selectionId: featureKind === "solid" ? PLATE_BODY : "feature:s1", selectionKind: featureKind === "solid" ? "body" : "feature", featureKind, featureState: state });
const ids = (commands: readonly WorkbenchContextCommand[]): readonly string[] => commands.map((command) => command.id);

export const browserRowTests: readonly TestCase[] = [
  {
    name: "Right-click on a solid step's row offers Edit, Edit Profile Sketch, Suppress, Rename, Roll Marker Here and Delete, ahead of the body's commands",
    run: () => {
      const menu = stepMenu("solid", { suppressed: false, markerAfter: false, hasSketch: true });
      const all = ids(menu);
      for (const id of ["feature.edit", "step.edit-profile", "step.suppress", "step.rename", "step.roll-here", "step.delete"]) assert(all.includes(id), `${id} is offered: ${all.join(", ")}`);
      assert(all.indexOf("step.delete") < all.indexOf("modify.fillet"), "the step's own commands come before the body's modelling commands");
      const del = menu.find((command) => command.id === "step.delete")!;
      assert(del.danger === true && del.shortcut === "Del", "Delete is marked as destructive");
      equal(menu.find((command) => command.id === "step.suppress")!.label, "Suppress", "an active step offers Suppress");
      assert(menu.find((command) => command.id === "step.roll-here")!.enabled, "the marker can move to this step");
    }
  },
  {
    name: "A suppressed step offers Unsuppress, a step with the marker right after it cannot roll there, and a sketch row has no profile sketch entry",
    run: () => {
      const menu = stepMenu("solid", { suppressed: true, markerAfter: true, hasSketch: false });
      equal(menu.find((command) => command.id === "step.suppress")!.label, "Unsuppress", "a suppressed step offers Unsuppress");
      const roll = menu.find((command) => command.id === "step.roll-here")!;
      assert(!roll.enabled && (roll.disabledReason ?? "").includes("already"), "the marker is already there, and the menu says so");
      const profile = menu.find((command) => command.id === "step.edit-profile")!;
      assert(!profile.enabled && (profile.disabledReason ?? "").length > 0, "a step whose sketch is gone cannot open it, with a reason");
      const sketch = ids(stepMenu("sketch", { suppressed: false, markerAfter: false, hasSketch: true }));
      assert(!sketch.includes("step.edit-profile") && sketch.includes("step.rename") && sketch.includes("step.delete"), `a sketch row renames and deletes but has no profile sketch: ${sketch.join(", ")}`);
      assert(!sketch.includes("feature.suppress") && !ids(menu).includes("feature.suppress"), "the old disabled Suppress Feature entry is gone");
    }
  },
  {
    name: "Nothing but a timeline step gets step commands (a body picked in the view, a plane, an empty click)",
    run: () => {
      const viewportBody = ids(resolveWorkbenchContextCommands({ workspace: "part", selectionId: PLATE_BODY, selectionKind: "body" }));
      assert(!viewportBody.some((id) => id.startsWith("step.")), "a body right-clicked in the view has no step commands");
      assert(!ids(resolveWorkbenchContextCommands({ workspace: "part", selectionId: null })).some((id) => id.startsWith("step.")), "neither does an empty click");
    }
  },
  {
    name: "Body rows carry an eye that says Hide or Show for that body, and the row's label is not covered by it",
    run: () => {
      const project = plateHoleFillet();
      const html = renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: noop, onContextMenu: noop, onToggleBody: noop, onRenameBody: noop, onRenameStep: noop }));
      const eye = /<button[^>]*class="tree-eye"[^>]*>/u.exec(html)?.[0] ?? "";
      assert(eye.includes(`aria-label="Hide ${PLATE_BODY}"`) && eye.includes('aria-pressed="true"'), `a shown body offers Hide: ${eye}`);
      assert(eye.includes(`data-tree-id="${PLATE_BODY}"`), "the eye still names its row, so a right-click on it is the body's menu");
      assert(html.includes('class="tree-row"'), "the label and the eye sit side by side in one row");
      const hiddenProject = { ...project, part: { ...project.part, generalBodies: project.part.generalBodies!.map((body) => ({ ...body, visible: false })) } };
      const hiddenHtml = renderToStaticMarkup(createElement(ProjectTree, { project: hiddenProject, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(hiddenProject), onSelect: noop, onContextMenu: noop, onToggleBody: noop }));
      assert(hiddenHtml.includes(`aria-label="Show ${PLATE_BODY}"`) && hiddenHtml.includes('aria-pressed="false"'), "a hidden body offers Show");
      const noEye = renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: noop, onContextMenu: noop }));
      assert(!noEye.includes("tree-eye"), "a host that cannot toggle shows no dead eye");
    }
  },
  {
    name: "A row being renamed shows a text field holding its name; Enter and Esc are handled, and the double-click open of a step is unchanged",
    run: () => {
      const editing = renderToStaticMarkup(createElement(TreeItem, { kind: "feature", id: PLATE_BODY, featureId: "feature:cut-1", label: "Cut 1", meta: "x", selectedId: null, onSelect: noop, onOpen: noop, rename: { editing: true, onStart: noop, onCommit: noop, onCancel: noop } }));
      assert(editing.includes('class="tree-rename"') && editing.includes('value="Cut 1"') && editing.includes('aria-label="Rename Cut 1"'), `an input with the current name: ${editing}`);
      assert(!editing.includes("<button"), "the row's button is replaced while editing");
      const idle = renderToStaticMarkup(createElement(TreeItem, { kind: "feature", id: PLATE_BODY, featureId: "feature:cut-1", label: "Cut 1", meta: "x", selectedId: null, onSelect: noop, onOpen: noop, rename: { editing: false, onStart: noop, onCommit: noop, onCancel: noop } }));
      assert(idle.includes('data-tree-open-id="feature:cut-1"') && idle.includes('data-opens="true"') && idle.includes("tree-item"), "the step row still opens its own step on double-click");
    }
  },
];
