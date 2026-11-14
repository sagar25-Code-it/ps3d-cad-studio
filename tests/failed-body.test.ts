import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STALE_BODY_OPACITY, withStaleBodies } from "../apps/studio-web/src/stale-bodies.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { buildPartPreview } from "../packages/workbench-geometry/src/index.js";
import { describeBodyFailure, designOf, failedBodies, type DesignFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { applyOp, PLATE_BODY, plateHoleFillet, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-21: a failed rebuild is visible on the canvas (the last good solid drawn out of date) and in the browser, with the reason. */

const REASON = "The hole is wider than the plate.";
const withHealth = (project: WorkbenchProject, featureId: string, message: string): WorkbenchProject => {
  const history = designOf(project);
  return { ...project, design: { ...history, features: history.features.map((feature): DesignFeature => feature.id === featureId ? { ...feature, health: { message } } : feature) } };
};

export const failedBodyTests: readonly TestCase[] = [
  {
    name: "failedBodies names the solid, the first failed live step and its reason; notes, suppressed steps and rolled-back steps do not count",
    run: () => {
      const clean = plateHoleFillet();
      equal(failedBodies(designOf(clean)).size, 0, "a healthy design has no failed solid");
      const failed = failedBodies(designOf(withHealth(clean, "feature:cut-1", REASON)));
      const entry = failed.get(PLATE_BODY);
      assert(entry !== undefined && entry.stepName === "Cut 1" && entry.message === REASON, "the plate is out of date because Cut 1 failed");
      equal(describeBodyFailure(entry), "out of date: Cut 1 could not be rebuilt (The hole is wider than the plate)", "one readable line");
      equal(failedBodies(designOf(withHealth(clean, "feature:cut-1", "Note: a hole was left out."))).size, 0, "a note on an applied step is not a failure");
      const suppressed = withHealth(clean, "feature:cut-1", REASON);
      const off = applyOp(suppressed, { kind: "set-design-feature-suppressed", featureId: "feature:cut-1", suppressed: true });
      equal(failedBodies(designOf(off)).size, 0, "a suppressed step is not part of the model, so it cannot make the solid stale");
      const back = applyOp(withHealth(clean, "feature:join-1", REASON), { kind: "set-design-rollback", index: 3 });
      equal(failedBodies(designOf(back)).size, 0, "a failed step after the rollback marker does not count");
      const two = withHealth(withHealth(clean, "feature:join-1", "second"), "feature:cut-1", "first");
      equal(failedBodies(designOf(two)).get(PLATE_BODY)!.stepName, "Cut 1", "the earliest failed step is the one reported");
    }
  },
  {
    name: "A failed rebuild keeps the last good mesh and marks the solid; the next good rebuild clears the mark",
    run: () => {
      const project = plateHoleFillet();
      const before = project.part.generalBodies!.find((body) => body.id === PLATE_BODY)!;
      const failed = applyOp(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1" }, { featureId: "feature:cut-1", message: REASON }] });
      equal(failed.part.generalBodies!.find((body) => body.id === PLATE_BODY)!.positionsMm.join(","), before.positionsMm.join(","), "the last good shape is still there (a failed rebuild never deletes work)");
      equal(failedBodies(designOf(failed)).get(PLATE_BODY)?.message, REASON, "and the solid is reported out of date, with the reason");
      const fixed = applyOp(failed, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: { ...tetra(PLATE_BODY) } }, { featureId: "feature:cut-1" }] });
      equal(failedBodies(designOf(fixed)).size, 0, "a good rebuild clears it");
    }
  },
  {
    name: "The canvas draws an out-of-date solid translucent and named so, and leaves healthy solids and an all-healthy scene untouched",
    run: () => {
      const project = plateHoleFillet();
      const scene = buildPartPreview(project.part);
      assert(withStaleBodies(scene, project) === scene, "a healthy design returns the very same scene");
      const failed = withHealth(project, "feature:cut-1", REASON);
      const staleScene = withStaleBodies(buildPartPreview(failed.part), failed);
      const body = staleScene.primitives.find((primitive) => primitive.id === PLATE_BODY)!;
      assert(body.opacity <= STALE_BODY_OPACITY && body.opacity < 1, `the stale solid is see-through (${body.opacity})`);
      assert(body.name.includes("out of date: Cut 1 could not be rebuilt"), `and the name carries the reason: ${body.name}`);
      const other = { ...failed, part: { ...failed.part, generalBodies: [...(failed.part.generalBodies ?? []), { ...tetra("general-body:other"), name: "Other" }] } };
      const mixed = withStaleBodies(buildPartPreview(other.part), other);
      equal(mixed.primitives.find((primitive) => primitive.id === "general-body:other")!.opacity, 1, "a healthy solid beside it is drawn normally");
    }
  },
  {
    name: "The browser marks the failed step's row and the solid's row as failed and gives the reason; healthy rows are plain",
    run: () => {
      const project = withHealth(plateHoleFillet(), "feature:cut-1", REASON);
      const html = renderToStaticMarkup(createElement(ProjectTree, { project, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(project), onSelect: () => undefined, onContextMenu: () => undefined }));
      const rows = [...html.matchAll(/<button[^>]*data-health="failed"[^>]*>[\s\S]*?<\/button>/gu)].map((match) => match[0]);
      equal(rows.length, 2, "two rows are marked failed: the Cut 1 step and the plate solid");
      assert(rows.some((row) => row.includes("Cut 1") && row.includes(REASON)), "the step row carries its reason");
      assert(rows.some((row) => row.includes(PLATE_BODY) && row.includes("out of date: Cut 1 could not be rebuilt")), "the solid row says it is out of date and which step failed");
      const healthy = renderToStaticMarkup(createElement(ProjectTree, { project: plateHoleFillet(), selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(plateHoleFillet()), onSelect: () => undefined, onContextMenu: () => undefined }));
      assert(!healthy.includes('data-health="failed"'), "a healthy design has no failed rows");
    }
  },
];
