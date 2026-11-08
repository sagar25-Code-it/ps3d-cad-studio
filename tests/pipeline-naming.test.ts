import { designOf, nextFeatureName } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { fresh, line, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";
import type { WorkbenchProject } from "../packages/workbench-core/src/index.js";

function finishSketch(project: WorkbenchProject, id: string, name: string): WorkbenchProject {
  let next = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy" });
  next = pipelineRun(next, { kind: "add-sketch-entity", entity: line(`${id.replace("feature:", "")}-line`, [0, 0], [10, 0]) });
  return pipelineRun(next, { kind: "commit-design-sketch", featureId: id, name });
}

const namesOf = (project: WorkbenchProject): string[] => designOf(project).features.map((feature) => feature.name);

export const pipelineNamingTests: readonly TestCase[] = [
  {
    name: "P19 default timeline names stay unique after a delete, a duplicate commit name is numbered, and a blank or taken rename says why",
    run: () => {
      let project = fresh();
      for (const ordinal of [1, 2, 3]) project = finishSketch(project, `feature:s${ordinal}`, nextFeatureName(designOf(project), "Sketch"));
      assert(namesOf(project).join(",") === "Sketch 1,Sketch 2,Sketch 3", `three sketches are numbered 1 to 3: ${namesOf(project).join(",")}`);
      project = pipelineRun(project, { kind: "delete-design-feature", featureId: "feature:s2" });
      equal(nextFeatureName(designOf(project), "Sketch"), "Sketch 4", "after deleting Sketch 2 the next default is Sketch 4, not a second Sketch 3");
      // Even a caller that sends a taken name gets a distinct one.
      project = finishSketch(project, "feature:s4", "Sketch 3");
      assert(namesOf(project).includes("Sketch 3 (2)"), `a duplicate name is numbered: ${namesOf(project).join(",")}`);
      assert(new Set(namesOf(project).map((name) => name.toLowerCase())).size === namesOf(project).length, "every name in the timeline is different");

      const blank = pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s1", name: "   " });
      assert(!blank.ok && /cannot be blank/u.test(message(blank)), `a whitespace name says it is blank: ${message(blank)}`);
      assert(!/design timeline is invalid/u.test(message(blank)), "and no longer blames the whole timeline");
      const taken = pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s1", name: "sketch 3" });
      assert(taken.ok && /already called "Sketch 3"/u.test(taken.value.summary), `renaming to a taken name is allowed but warned about: ${taken.ok ? taken.value.summary : message(taken)}`);
      const fine = pipelineRun(project, { kind: "rename-design-feature", featureId: "feature:s1", name: "  Base profile  " });
      assert(namesOf(fine).includes("Base profile"), "a good name is trimmed and kept");
      const same = pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s1", name: "Sketch 1" });
      assert(same.ok, "keeping its own name is not a clash");
    }
  }
];
