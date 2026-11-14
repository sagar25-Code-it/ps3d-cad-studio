import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { browserOpenAction, contextStepId, timelineRowOpenId, timelineRowSelectionId } from "../apps/studio-web/src/sketch-plane-ui.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { designOf, resolveWorkbenchContextCommands, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { committedSketch, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * Double-click (and right-click, Edit) on a step in the browser opens THAT step. The rows of a body's steps all select the same
 * body, so the row has to hand over the step's own ID: with the body's ID the first step of the body opened for every row.
 */

const BODY = "general-body:plate";
const step = (id: string, name: string, kind: DesignSolidFeature["kind"], extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id, name, kind, suppressed: false, sketchFeatureId: "feature:s1", profileIds: [], valueMm: 6, bodyId: BODY, ...extra });

/** Job 1 as the timeline holds it: a plate, a hole cut and a corner fillet, three steps of one body. */
function plateHoleFillet(): WorkbenchProject {
  const { project } = committedSketch("datum:xy", [rect("plate", 0, 0, 80, 50)]);
  const history = designOf(project);
  const steps = [step("feature:extrude-1", "Extrude 1", "extrude"), step("feature:cut-1", "Cut 1", "extrude", { operation: "cut" }), step("feature:fillet-1", "Fillet 1", "edge-fillet", { valueMm: 4 })];
  return { ...project, activeWorkspace: "part", design: { ...history, features: [...history.features, ...steps], rollbackIndex: history.features.length + steps.length } };
}

const rowOf = (html: string, featureId: string): string => new RegExp(`<button[^>]*data-tree-feature-id="${featureId}"[^>]*>`, "u").exec(html)?.[0] ?? "";

export const browserStepOpenTests: readonly TestCase[] = [
  {
    name: "Browser double-click on a later step of a body (cut, fillet) opens that step, not the body's first step",
    run: () => {
      const project = plateHoleFillet();
      const features = designOf(project).features;
      for (const feature of features) {
        const action = browserOpenAction(timelineRowOpenId(feature), features, project.sketch.id);
        equal(JSON.stringify(action), JSON.stringify({ kind: "edit-feature", featureId: feature.id }), `the ${feature.name} row opens ${feature.name}`);
      }
      const solids = features.filter((feature) => feature.kind !== "sketch");
      equal(new Set(solids.map(timelineRowSelectionId)).size, 1, "the three solid rows still select the one body, so the viewport highlights it");
      equal(new Set(solids.map(timelineRowOpenId)).size, 3, "and each opens its own step");
      // The ID a row selects is not what it opens: the body's ID opens nothing by itself.
      equal(browserOpenAction(BODY, features, project.sketch.id).kind, "none", "a body ID is not a step");
      equal(browserOpenAction(project.sketch.id, features, project.sketch.id).kind, "open-working", "the working sketch row still opens the sketcher");
    }
  },
  {
    name: "The browser renders each timeline row with the step it opens: the fillet row carries the fillet's ID beside the body it selects",
    run: () => {
      const project = plateHoleFillet();
      const html = renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: () => undefined, onContextMenu: () => undefined, onOpenItem: () => undefined }));
      for (const id of ["feature:extrude-1", "feature:cut-1", "feature:fillet-1"]) {
        const row = rowOf(html, id);
        assert(row !== "", `the ${id} row is rendered with its step`);
        assert(row.includes(`data-tree-id="${BODY}"`), `it selects the body: ${row}`);
        assert(row.includes(`data-tree-open-id="${id}"`) && row.includes('data-opens="true"'), `it opens its own step on double-click: ${row}`);
        assert(row.includes("Double-click to edit this step"), "and says so");
      }
      const sketchRow = rowOf(html, "feature:s1");
      assert(sketchRow.includes('data-tree-id="feature:s1"') && sketchRow.includes('data-tree-open-id="feature:s1"'), "a sketch row selects and opens the sketch");
      const plane = /<button[^>]*data-tree-id="datum:xy"[^>]*>/u.exec(html)?.[0] ?? "";
      assert(plane !== "" && !plane.includes("data-tree-feature-id") && !plane.includes("data-tree-open-id"), "a row that is not a timeline step names no step");
    }
  },
  {
    name: "Right-click on a solid step's browser row: Edit acts on that step, and the body's own commands stay",
    run: () => {
      equal(contextStepId("feature:fillet-1", BODY), "feature:fillet-1", "the row's step wins over the body the row selects");
      equal(contextStepId(undefined, "feature:s1"), "feature:s1", "a selection that is a step is used as it is");
      equal(contextStepId(undefined, null), null, "nothing selected, nothing to edit");
      const onRow = resolveWorkbenchContextCommands({ workspace: "part", selectionId: BODY, selectionKind: "body", featureKind: "solid" });
      assert(onRow.some((entry) => entry.id === "feature.edit" && entry.enabled), "Edit Feature Parameters is offered on the step's row");
      assert(onRow.some((entry) => entry.id === "selection.toggle-visibility"), "with the body's Show / Hide");
      // PT-18: a body right-clicked in the view now offers Edit Feature; the app resolves the step that made the body when it runs.
      const inViewport = resolveWorkbenchContextCommands({ workspace: "part", selectionId: BODY, selectionKind: "body" });
      assert(inViewport.some((entry) => entry.id === "feature.edit" && entry.enabled), "a body right-clicked in the view offers Edit Feature (its owning step)");
    }
  },
];
