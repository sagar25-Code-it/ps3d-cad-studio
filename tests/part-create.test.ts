import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createBlankWorkbenchProject, designOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { matchingSketches, profilesByAnswer, sketchByAnswer } from "../apps/studio-web/src/explicit-pick.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";

/**
 * PT-05: Extrude and Revolve start in the Part environment on a FINISHED sketch (E, ribbon, right-click), instead of
 * only inside the sketch palette on the working sketch. These tests drive the same resolution and feature records the
 * Part command uses: the sketch comes from the timeline, the profiles from the answer, and the step replays like any
 * palette-built one. The prompt flow itself runs in the browser and is listed as not verified here.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-part-create-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const volumeOf = (project: WorkbenchProject, bodyId: string): number => {
  const body = project.part.generalBodies!.find((candidate) => candidate.id === bodyId)!;
  return solidMetrics(body.positionsMm, body.indices).volumeMm3;
};

/** Finishes a sketch into the timeline of a blank design, the way Finish Sketch does. */
function finishSketch(project: WorkbenchProject, featureId: string, name: string, entities: readonly SketchEntity[]): WorkbenchProject {
  let next: WorkbenchProject = { ...project, sketch: { ...project.sketch, entities: [...entities], constraints: [] } };
  next = run(next, { kind: "commit-design-sketch", featureId, name });
  return run(next, { kind: "new-design-sketch", plane: "datum:xy" });
}

export const partCreateTests: readonly TestCase[] = [
  {
    name: "profilesByAnswer: all (or Enter) means every profile, numbers pick profiles in order, and anything else is refused rather than guessing",
    run: () => {
      const profiles = [{ id: "profile:a" }, { id: "profile:b" }, { id: "profile:c" }];
      assert(JSON.stringify(profilesByAnswer(profiles, "all")) === "[]", "all is stored as the empty list (the existing every-profile meaning)");
      assert(JSON.stringify(profilesByAnswer(profiles, "  ")) === "[]", "an empty answer keeps every profile");
      assert(JSON.stringify(profilesByAnswer(profiles, "1 3")) === '["profile:a","profile:c"]', "numbers pick profiles in the detector's order");
      assert(JSON.stringify(profilesByAnswer(profiles, "P2")) === '["profile:b"]', "P2 works like 2");
      assert(JSON.stringify(profilesByAnswer(profiles, "2, 2")) === '["profile:b"]', "a repeated number counts once");
      assert(profilesByAnswer(profiles, "4") === undefined, "a number past the end is refused");
      assert(profilesByAnswer(profiles, "first") === undefined, "words are refused, never a silent first profile");
      assert(profilesByAnswer(profiles, "0") === undefined, "profiles count from 1");
    }
  },
  {
    name: "In a blank design, E extrudes a finished timeline sketch into one timeline step whose body follows a later sketch edit, and Revolve turns the chosen profile",
    run: async () => {
      // A blank design with two finished sketches: a 40 x 30 plate outline and a 10 mm disc.
      let project = createBlankWorkbenchProject("project:test-part-create");
      project = finishSketch(project, "feature:sketch-plate", "Plate sketch", [{ id: "entity:plate", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 30, rotationDeg: 0, construction: false }]);
      project = finishSketch(project, "feature:sketch-disc", "Disc sketch", [{ id: "entity:disc", kind: "circle", center: [15, 0], radiusMm: 5, construction: false }]);
      const history = designOf(project);
      assert(history.features.filter((feature) => feature.kind === "sketch").length === 2, "two finished sketches are on the timeline");

      // The Part command's sketch resolution: candidates newest first, the answer picks by name.
      const candidates = matchingSketches(history, (candidate) => detectSketchProfiles(candidate.sketch).length > 0);
      assert(candidates.length === 2 && candidates[0]!.name === "Disc sketch", "candidates are the finished sketches, newest first");
      const plateSketch = sketchByAnswer(candidates, "Plate sketch")!;
      assert(plateSketch.id === "feature:sketch-plate", "the typed name picks the plate sketch");

      // E, 6, Enter: the same feature record the palette stores, built from the finished sketch, not the working one.
      const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: plateSketch.id, profileIds: [], valueMm: 6, bodyId: "general-body:plate" };
      const builtPlate = await rebuildSolidFeature(extrude, plateSketch);
      assert(builtPlate.ok, `the plate builds from the finished sketch: ${builtPlate.ok ? "" : builtPlate.message}`);
      if (!builtPlate.ok) return;
      project = run(project, { kind: "add-design-solid", feature: extrude, body: builtPlate.body });
      near(volumeOf(project, "general-body:plate"), 40 * 30 * 6, 40 * 30 * 6 * 0.001, "E on the finished plate sketch gives the 40 x 30 x 6 plate");

      // Revolve the disc sketch 360 degrees about the sketch Y axis through the same record kind.
      const disc = sketchByAnswer(candidates, "Disc sketch")!;
      const revolve: DesignSolidFeature = { id: "feature:revolve-1", name: "Revolve 1", kind: "revolve", suppressed: false, sketchFeatureId: disc.id, profileIds: profilesByAnswer(detectSketchProfiles(disc.sketch), "1") as string[], valueMm: 360, bodyId: "general-body:ring" };
      const builtRing = await rebuildSolidFeature(revolve, disc);
      assert(builtRing.ok, `the revolve builds from the finished disc sketch: ${builtRing.ok ? "" : builtRing.message}`);
      if (!builtRing.ok) return;
      project = run(project, { kind: "add-design-solid", feature: revolve, body: builtRing.body });
      assert(volumeOf(project, "general-body:ring") > 0, "the revolved body has volume");

      // Edit the plate sketch and replay: the Part-made extrude follows, like any palette-made step.
      let edited = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-plate" });
      edited = run(edited, { kind: "set-sketch-dimension", entityId: "entity:plate", dimension: "width", valueMm: 60 });
      edited = run(edited, { kind: "commit-design-sketch", featureId: "feature:sketch-plate", name: "Plate sketch" });
      const results = await replayAllBodies(edited);
      const replayed = run(edited, { kind: "regenerate-design", results });
      near(volumeOf(replayed, "general-body:plate"), 60 * 30 * 6, 60 * 30 * 6 * 0.001, "widening the sketch rebuilds the Part-made extrude");
      assert(designOf(replayed).features.every((feature) => feature.health === undefined), "no step is flagged");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(replayed))).ok, "the design with Part-made steps saves and loads");
    }
  }
];
