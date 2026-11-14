import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { browserOpenAction, contextSketchAction } from "../apps/studio-web/src/sketch-plane-ui.js";
import { commitWorkingSketchAtomically } from "../apps/studio-web/src/sketch-session.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { designOf, parseWorkbenchProjectText, resolveWorkbenchContextCommands, serializeWorkbenchProject, type DesignSketchFeature } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { circ, committedSketch, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * The two ways into a sketch that were broken: Create Sketch from a right-click moved the last finished sketch to the new plane
 * instead of starting a new one, and the browser had no way to reopen a finished sketch.
 */

function sketchFeature(project: ReturnType<typeof committedSketch>["project"], id: string): DesignSketchFeature {
  const feature = designOf(project).features.find((candidate): candidate is DesignSketchFeature => candidate.id === id && candidate.kind === "sketch");
  assert(feature !== undefined, `${id} is a sketch in the timeline`);
  return feature;
}

export const sketchEntryPointTests: readonly TestCase[] = [
  {
    name: "Create Sketch from a right-click always means a new sketch: on the origin plane that was clicked, or after asking for a plane",
    run: () => {
      equal(JSON.stringify(contextSketchAction("sketch.create", "datum:xz")), JSON.stringify({ kind: "new-on-plane", plane: "datum:xz" }), "an origin plane starts a new sketch on it");
      equal(contextSketchAction("sketch.create", "datum:yz").kind, "new-on-plane", "the Right plane too");
      equal(contextSketchAction("sketch.create", null).kind, "ask-plane", "empty canvas asks for the plane (it used to reopen the last sketch)");
      equal(contextSketchAction("sketch.create", "general-body:b1").kind, "ask-plane", "a body or face asks for the plane or face");
      equal(contextSketchAction("sketch.create", "datum:origin").kind, "ask-plane", "the origin point names no plane");
      equal(contextSketchAction("sketch.edit", "entity:a").kind, "open-working", "Edit Sketch on a curve goes back into the working sketch");
      equal(JSON.stringify(contextSketchAction("sketch.edit", "feature:s1", ["feature:s1"])), JSON.stringify({ kind: "edit-feature", featureId: "feature:s1" }), "Edit Sketch on a timeline sketch reopens that sketch");
    }
  },
  {
    name: "Create Sketch on the XZ plane after a finished XY sketch leaves that sketch on XY with its curves, in one Undo step",
    run: async () => {
      const { project } = committedSketch("datum:xy", [rect("plate", 0, 0, 80, 50), circ("hole", 10, 10, 3)]);
      // After Finish the working sketch is still the finished one: this is the state the old command re-planed.
      equal(designOf(project).editingSketchId, "feature:s1", "the working sketch is the finished sketch");
      const action = contextSketchAction("sketch.create", "datum:xz");
      assert(action.kind === "new-on-plane", "the right-click resolves to a new sketch");
      const outcome = await commitWorkingSketchAtomically(project, { featureId: "feature:s2", name: "Sketch 2", then: [{ kind: "new-design-sketch", plane: action.plane }] });
      assert(outcome.ok, `the step is accepted: ${outcome.ok ? "" : outcome.message}`);
      if (!outcome.ok) return;
      const next = outcome.value.project;
      const first = sketchFeature(next, "feature:s1");
      equal(first.sketch.plane, "datum:xy", "the finished sketch stays on XY");
      equal(first.sketch.entities.length, 2, "and keeps both curves");
      equal(designOf(next).features.length, 1, "nothing was added to the timeline for a sketch that was already recorded");
      equal(next.sketch.plane, "datum:xz", "the working sketch is on XZ");
      equal(next.sketch.entities.length, 0, "and is empty");
      equal(designOf(next).editingSketchId, null, "it is a new sketch, not the timeline one reopened");
      equal(next.activeWorkspace, "sketch", "the sketcher is open");
      // Draw on the new sketch and finish: two sketches, each on its own plane.
      const drawn = pipelineRun(next, { kind: "add-sketch-entity", entity: circ("boss", 0, 0, 5) });
      const finished = await commitWorkingSketchAtomically(drawn, { featureId: "feature:s2", name: "Sketch 2" });
      assert(finished.ok, "the second sketch finishes");
      if (!finished.ok) return;
      equal(sketchFeature(finished.value.project, "feature:s1").sketch.plane, "datum:xy", "sketch 1 is still on XY after the second Finish");
      equal(sketchFeature(finished.value.project, "feature:s2").sketch.plane, "datum:xz", "sketch 2 is on XZ");
      // Save and reload keeps both.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(finished.value.project));
      assert(reloaded.ok, "the project reloads");
      if (!reloaded.ok) return;
      equal(sketchFeature(reloaded.value, "feature:s1").sketch.plane, "datum:xy", "after reload sketch 1 is on XY");
      equal(sketchFeature(reloaded.value, "feature:s1").sketch.entities.length, 2, "with its curves");
      equal(sketchFeature(reloaded.value, "feature:s2").sketch.plane, "datum:xz", "after reload sketch 2 is on XZ");
    }
  },
  {
    name: "Create Sketch on a plane while a sketch has unrecorded work keeps that work in the timeline first",
    run: async () => {
      const { project } = committedSketch("datum:xy", [rect("plate", 0, 0, 80, 50)]);
      const edited = pipelineRun(project, { kind: "add-sketch-entity", entity: circ("late", 5, 5, 2) });
      const outcome = await commitWorkingSketchAtomically(edited, { featureId: "feature:s2", name: "Sketch 2", then: [{ kind: "new-design-sketch", plane: "datum:yz" }] });
      assert(outcome.ok, "accepted");
      if (!outcome.ok) return;
      equal(sketchFeature(outcome.value.project, "feature:s1").sketch.entities.length, 2, "the late circle was recorded in sketch 1 before the new sketch started");
      equal(sketchFeature(outcome.value.project, "feature:s1").sketch.plane, "datum:xy", "sketch 1 did not move");
      equal(outcome.value.project.sketch.plane, "datum:yz", "the new sketch is on the Right plane");
      equal(outcome.value.project.sketch.entities.length, 0, "and empty");
    }
  },
  {
    name: "Right-click on a finished sketch in the browser offers Edit Sketch, not Edit Feature Parameters",
    run: () => {
      const sketchRow = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "feature:s1", featureKind: "sketch" });
      assert(sketchRow.some((entry) => entry.id === "sketch.edit" && entry.label === "Edit Sketch" && entry.enabled), "Edit Sketch is offered");
      assert(!sketchRow.some((entry) => entry.id === "feature.edit"), "Edit Feature Parameters is not");
      const legacy = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "feature:plate-extrusion" });
      assert(legacy.some((entry) => entry.id === "feature.edit"), "a feature that is not a timeline sketch keeps Edit Feature Parameters");
    }
  },
  {
    name: "Double-click in the browser: a timeline sketch or solid row opens that step, the working sketch row opens the sketcher, other rows do nothing",
    run: () => {
      const timeline = [{ id: "feature:s1" }, { id: "feature:extrude-1" }];
      equal(JSON.stringify(browserOpenAction("feature:s1", timeline, "sketch:main")), JSON.stringify({ kind: "edit-feature", featureId: "feature:s1" }), "the sketch row");
      equal(JSON.stringify(browserOpenAction("feature:extrude-1", timeline, "sketch:main")), JSON.stringify({ kind: "edit-feature", featureId: "feature:extrude-1" }), "a solid row hands over its own step");
      equal(browserOpenAction("sketch:main", timeline, "sketch:main").kind, "open-working", "the working sketch row");
      equal(browserOpenAction("datum:xy", timeline, "sketch:main").kind, "none", "a plane row only selects");
    }
  },
  {
    name: "The browser renders timeline rows as rows that open on double-click, and says so in their tooltip",
    run: () => {
      const { project } = committedSketch("datum:xy", [rect("plate", 0, 0, 80, 50)]);
      const inPart = { ...project, activeWorkspace: "part" as const };
      const opened: string[] = [];
      const html = renderToStaticMarkup(createElement(ProjectTree, { project: inPart, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(inPart), onSelect: () => undefined, onContextMenu: () => undefined, onOpenItem: (id: string) => { opened.push(id); } }));
      const row = /<button[^>]*data-tree-id="feature:s1"[^>]*>/.exec(html)?.[0] ?? "";
      assert(row.includes('data-opens="true"') && row.includes("Double-click to edit this sketch"), `the timeline sketch row opens on double-click: ${row}`);
      const plane = /<button[^>]*data-tree-id="datum:xy"[^>]*>/.exec(html)?.[0] ?? "";
      assert(plane !== "" && !plane.includes("data-opens"), "a plane row does not claim to open");
      const without = renderToStaticMarkup(createElement(ProjectTree, { project: inPart, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(inPart), onSelect: () => undefined, onContextMenu: () => undefined }));
      assert(!without.includes("data-opens"), "without a handler no row claims to open");
    }
  },
];
