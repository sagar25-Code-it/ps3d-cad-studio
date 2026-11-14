import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pickStep, resolveSelectedStep } from "../apps/studio-web/src/timeline-selection.js";
import { TimelineBar } from "../apps/studio-web/src/ui/TimelineBar.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { designOf } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { applyOp, PLATE_BODY, plateHoleFillet } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-01: selection in the timeline is per step, so Edit, Suppress and Delete act on the step the user picked. */

const pressed = (html: string): readonly string[] => [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>/gu)].map((match) => match[0]);

export const timelineSelectionTests: readonly TestCase[] = [
  {
    name: "Selecting the third step of a body means that step, not the body's first step",
    run: () => {
      const history = designOf(plateHoleFillet());
      const fillet = history.features.find((feature) => feature.id === "feature:join-1")!;
      const pick = pickStep(fillet);
      equal(pick.selectionId, PLATE_BODY, "the viewport keeps highlighting the body");
      equal(resolveSelectedStep(history, PLATE_BODY, pick)?.id, "feature:join-1", "the pick resolves to the boss");
      equal(resolveSelectedStep(history, PLATE_BODY, null)?.id, "feature:extrude-1", "a body picked in the view still means the step that made it");
      const sketch = history.features[0]!;
      equal(resolveSelectedStep(history, sketch.id, pickStep(sketch))?.id, sketch.id, "a sketch selects itself");
      equal(resolveSelectedStep(history, sketch.id, null)?.id, sketch.id, "also without a pick");
    }
  },
  {
    name: "A pick only counts while its selection is current, and a pick of a deleted step falls back",
    run: () => {
      const project = plateHoleFillet();
      const history = designOf(project);
      const pick = pickStep(history.features.find((feature) => feature.id === "feature:cut-1")!);
      equal(resolveSelectedStep(history, null, pick), undefined, "nothing selected, nothing resolved");
      equal(resolveSelectedStep(history, "datum:xy", pick), undefined, "another selection is not a step");
      equal(resolveSelectedStep(history, "feature:s1", pick)?.id, "feature:s1", "another step selected by its ID wins over an old pick");
      const without = applyOp(project, { kind: "delete-design-feature", featureId: "feature:cut-1" });
      equal(resolveSelectedStep(designOf(without), PLATE_BODY, pick)?.id, "feature:extrude-1", "the picked step is gone, so the body's own step is used");
    }
  },
  {
    name: "Delete on the picked boss removes only the boss; the base extrude and the cut stay",
    run: () => {
      const project = plateHoleFillet();
      const history = designOf(project);
      const picked = resolveSelectedStep(history, PLATE_BODY, pickStep(history.features.find((feature) => feature.id === "feature:join-1")!))!;
      const after = applyOp(project, { kind: "delete-design-feature", featureId: picked.id });
      equal(designOf(after).features.map((feature) => feature.id).join(","), "feature:s1,feature:extrude-1,feature:cut-1", "only the boss went");
      assert((after.part.generalBodies ?? []).some((body) => body.id === PLATE_BODY), "and the body is still there");
      const suppressed = applyOp(project, { kind: "set-design-feature-suppressed", featureId: picked.id, suppressed: true });
      equal(designOf(suppressed).features.filter((feature) => feature.suppressed).map((feature) => feature.id).join(","), "feature:join-1", "Suppress acts on the picked step alone");
    }
  },
  {
    name: "The timeline strip marks only the picked chip as selected, and the browser marks only that step's row",
    run: () => {
      const project = plateHoleFillet();
      const history = designOf(project);
      const bar = (selectedFeatureId: string | null): string => renderToStaticMarkup(createElement(TimelineBar, { history, selectedFeatureId, busy: false, onSelect: () => undefined, onEdit: () => undefined, onRollback: () => undefined, onSuppress: () => undefined, onDelete: () => undefined, onRename: () => undefined }));
      const fillet = pressed(bar("feature:join-1"));
      equal(fillet.length, 1, "one chip is selected");
      assert(fillet[0]!.includes("Join 1"), `and it is the boss: ${fillet[0]}`);
      equal(pressed(bar(null)).length, 0, "no chip when nothing is selected");
      const tree = (selectedStepId: string | null): string => renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: PLATE_BODY, selectedStepId, onSelectStep: () => undefined, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: () => undefined, onContextMenu: () => undefined, onOpenItem: () => undefined }));
      const rows = pressed(tree("feature:cut-1")).filter((row) => row.includes("data-tree-feature-id"));
      equal(rows.length, 1, "one timeline row is selected in the browser, not all three steps of the body");
      assert(rows[0]!.includes('data-tree-feature-id="feature:cut-1"'), `and it is the cut: ${rows[0]}`);
    }
  },
];
