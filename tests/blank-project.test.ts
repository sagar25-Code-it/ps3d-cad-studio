import { createBlankWorkbenchProject, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildPartPreview } from "../packages/workbench-geometry/src/index.js";
import { workingSketchState } from "../apps/studio-web/src/sketch-session.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-04: File > New gives an empty design. The blank factory starts with no sketch curves, no committed sketch, no body
 * and no template plate, while the fixture project (the boot default and existing saved files) keeps the plate it was
 * built around, because `templateVisible` is absent there and absent means the old behaviour.
 */
export const blankProjectTests: readonly TestCase[] = [
  {
    name: "A blank design is empty: no sketch curves, no timeline, no template plate, and it validates and round-trips",
    run: () => {
      const blank = createBlankWorkbenchProject("project:test-blank", "My part");
      assert(blank.sketch.entities.length === 0 && blank.sketch.constraints.length === 0, "the working sketch starts empty");
      assert(blank.design === undefined || blank.design.features.length === 0, "the timeline starts empty");
      assert((blank.part.generalBodies ?? []).length === 0 && (blank.part.previewBodies ?? []).length === 0, "there is no body");
      assert(blank.part.templateVisible === false, "the template plate is not part of a blank design");
      assert(blank.name === "My part" && blank.part.name === "My part", "the design carries the typed name");
      const state = workingSketchState(blank);
      assert(state.kind === "clean", `the empty working sketch has nothing to commit, so New Sketch records no step: ${state.kind}`);
      const checked = validateWorkbenchProject(JSON.parse(JSON.stringify(blank)));
      assert(checked.ok, `a saved blank design loads again: ${checked.ok ? "" : checked.diagnostics[0]?.message ?? ""}`);
      if (checked.ok) assert(checked.value.part.templateVisible === false, "the reloaded design still has no plate");
    }
  },
  {
    name: "The part preview of a blank design has no primitives and does not reserve room for the plate, while the fixture project keeps the plate and its bounds",
    run: () => {
      const blank = createBlankWorkbenchProject("project:test-blank-preview");
      const scene = buildPartPreview(blank.part);
      assert(scene.primitives.length === 0, `an empty design draws nothing: ${scene.primitives.length} primitives`);
      assert(scene.boundsMm.min[0] === -50 && scene.boundsMm.max[2] === 50, "the empty scene falls back to the default envelope for the grid and Fit");

      const fixture = createWorkbenchProject("project:test-fixture-preview");
      assert(fixture.part.templateVisible === undefined, "the fixture does not carry the new field, so old saved projects are byte-for-byte unchanged in meaning");
      const fixtureScene = buildPartPreview(fixture.part);
      assert(fixtureScene.boundsMm.min[0] === -30 && fixtureScene.boundsMm.max[0] === 30, "the fixture's bounds still hold the 60 mm plate");
      const validated = validateWorkbenchProject(JSON.parse(JSON.stringify(fixture)));
      assert(validated.ok, "the fixture still validates");
      // The validator refuses a non-boolean templateVisible rather than silently keeping it.
      const bad = validateWorkbenchProject(JSON.parse(JSON.stringify({ ...fixture, part: { ...fixture.part, templateVisible: "no" } })));
      assert(!bad.ok, "a non-boolean templateVisible is refused");
    }
  }
];
