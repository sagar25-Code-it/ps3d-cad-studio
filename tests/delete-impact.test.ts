import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteStepDialog } from "../apps/studio-web/src/ui/DeleteStepDialog.js";
import { deleteImpact, deleteImpactHeadline, designOf, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyOp, PLATE_BODY, plateHoleFillet, stepOf, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-02: Delete says what depends on the step first, names it, and the delete itself is one project change. */

const BOSS = "general-body:boss";

/** The plate project plus a second sketch and body, a copy of the plate made by a pattern, and a combine that takes the boss as a tool. */
function withBossAndCopies(): WorkbenchProject {
  const project = plateHoleFillet();
  const history = designOf(project);
  const sketch2 = { ...history.features[0]!, id: "feature:s2", name: "Sketch 2" };
  const boss = stepOf("feature:extrude-2", "Extrude 2", "extrude", { sketchFeatureId: "feature:s2", bodyId: BOSS });
  const copy = stepOf("feature:copy-1", "Pattern 1", "pattern", {
    bodyId: "general-body:copy", operation: "new-body",
    pattern: { type: "rectangular", result: "new-bodies", groupId: "pattern:g1", sourceBodyId: PLATE_BODY, copyIndex: 1, countA: 2, spacingAMm: 20, directionA: [1, 0, 0], countB: 1, spacingBMm: 0, directionB: [0, 1, 0], sizing: "spacing" }
  });
  const combine = stepOf("feature:combine-1", "Combine 1", "combine", { operation: "direct-edit", valueMm: 1, combineToolBodyIds: [BOSS], combineMode: "join" });
  const features = [...history.features, sketch2, boss, copy, combine];
  return { ...project, part: { ...project.part, generalBodies: [tetra(PLATE_BODY), tetra(BOSS), tetra("general-body:copy")] }, design: { ...history, features, rollbackIndex: features.length } };
}

const names = (items: readonly { readonly name: string }[]): string => items.map((item) => item.name).join(" | ");

export const deleteImpactTests: readonly TestCase[] = [
  {
    name: "Deleting a sketch lists every step built on it, with why, and the solid that goes",
    run: () => {
      const project = plateHoleFillet();
      const impact = deleteImpact(project, "feature:s1")!;
      equal(impact.featureName, designOf(project).features[0]!.name, "it names the step being deleted");
      equal(names(impact.dependents), "Extrude 1 | Cut 1 | Join 1", "the extrude, the cut and the join are named, in timeline order");
      assert(impact.dependents.every((item) => item.reason.startsWith("built on ")), `each says it is built on the sketch: ${impact.dependents.map((item) => item.reason).join("; ")}`);
      equal(impact.removedBodyNames.join(","), PLATE_BODY, "the plate solid is named as removed");
      equal(deleteImpactHeadline(impact), `Deleting ${impact.featureName} also deletes 3 other steps that depend on it.`, "the headline counts them");
    }
  },
  {
    name: "Deleting a base extrude names its cuts and joins, copies and combines; deleting a cut alone names nothing",
    run: () => {
      const project = withBossAndCopies();
      const impact = deleteImpact(project, "feature:extrude-1")!;
      const byName = new Map(impact.dependents.map((item) => [item.name, item.reason]));
      equal(byName.get("Cut 1"), "changes the body made by Extrude 1", "a cut of its body goes with it");
      equal(byName.get("Join 1"), "changes the body made by Extrude 1", "so does a join");
      equal(byName.get("Pattern 1"), "repeats the body made by Extrude 1", "a pattern copy of its body goes with it");
      assert(!byName.has("Extrude 2") && !byName.has("Sketch 2"), "an unrelated body and its sketch stay");
      const bossGoes = deleteImpact(project, "feature:extrude-2")!;
      equal(names(bossGoes.dependents), "Combine 1", "the combine that used the boss as a tool goes with the boss");
      equal(bossGoes.dependents[0]!.reason, "uses the body made by Extrude 2 as a tool", "and says why");
      equal(deleteImpact(project, "feature:cut-1")!.dependents.length, 0, "a cut nothing is built on stands alone");
      equal(deleteImpact(project, "feature:cut-1")!.removedBodyNames.length, 0, "and removes no solid");
      equal(deleteImpact(project, "feature:nope"), undefined, "a missing step has no impact");
      assert([...impact.removedBodyNames].sort().join(",") === [PLATE_BODY, "general-body:copy"].sort().join(","), `the plate and its copy are removed: ${impact.removedBodyNames.join(",")}`);
    }
  },
  {
    name: "The impact list is exactly what the delete operation removes, and the delete is one project revision",
    run: () => {
      const project = withBossAndCopies();
      for (const featureId of ["feature:s1", "feature:extrude-1", "feature:extrude-2", "feature:cut-1", "feature:s2"]) {
        const impact = deleteImpact(project, featureId)!;
        const after = applyOp(project, { kind: "delete-design-feature", featureId });
        const gone = designOf(project).features.filter((feature) => !designOf(after).features.some((kept) => kept.id === feature.id)).map((feature) => feature.id).sort();
        equal(gone.join(","), [featureId, ...impact.dependents.map((item) => item.id)].sort().join(","), `${featureId}: the steps listed are the steps removed`);
        const solidsGone = (project.part.generalBodies ?? []).filter((body) => !(after.part.generalBodies ?? []).some((kept) => kept.id === body.id)).map((body) => body.name).sort();
        equal(solidsGone.join(","), [...impact.removedBodyNames].sort().join(","), `${featureId}: the solids listed are the solids removed`);
        equal(after.revision, project.revision + 1, `${featureId}: one operation is one revision, so one Undo`);
      }
    }
  },
  {
    name: "The confirmation names each step with its reason and the removed solids once the cascade is chosen, defaults to Cancel, and counts the steps on its button",
    run: () => {
      const impact = deleteImpact(withBossAndCopies(), "feature:extrude-1")!;
      // Delete only this step is the default now (see delete-keep.test.ts); the list below is what the other choice removes.
      const html = renderToStaticMarkup(createElement(DeleteStepDialog, { impact, initialMode: "all", onConfirm: () => undefined, onCancel: () => undefined }));
      for (const item of impact.dependents) assert(html.includes(item.name) && html.includes(item.reason), `${item.name} and its reason are listed`);
      assert(html.includes('role="dialog"') && html.includes("Delete Extrude 1?"), "it is a dialog titled with the step");
      assert(html.includes("is removed from the model") || html.includes("are removed from the model"), "the removed solids are said");
      assert(html.includes("Ctrl+Z"), "and it says one Undo brings everything back");
      assert(/data-dialog-initial-focus[^>]*>Cancel</u.test(html), "focus starts on Cancel, not on the destructive button");
      assert(html.includes(`Delete ${impact.dependents.length + 1} steps`), "the destructive button counts what it deletes");
    }
  },
];
