import type { DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createBlankWorkbenchProject, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { applyParameterValues, parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

/**
 * PT-15: Combine is a timeline step. Until now the Boolean replaced target and tool with an "ordinary body" and removed
 * the timeline steps of both; the "combine" step keeps every input step, replays the Boolean at its own position, and a
 * sketch edit on the target or the tool still drives the combined result.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-combine-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const PLATE = "general-body:plate";
const BOSS = "general-body:boss";
const volumeOf = (project: WorkbenchProject, bodyId: string): number => {
  const body = project.part.generalBodies!.find((candidate) => candidate.id === bodyId)!;
  return solidMetrics(body.positionsMm, body.indices).volumeMm3;
};
const replay = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });

function finishSketch(project: WorkbenchProject, featureId: string, name: string, entities: readonly SketchEntity[]): WorkbenchProject {
  let next: WorkbenchProject = { ...project, sketch: { ...project.sketch, entities: [...entities], constraints: [] } };
  next = run(next, { kind: "commit-design-sketch", featureId, name });
  return run(next, { kind: "new-design-sketch", plane: "datum:xy" });
}

/** A 40 x 30 x 10 plate and a Ø10 x 20 boss standing in it at (10, 0), each a timeline extrude of its own sketch. */
async function twoBodies(): Promise<WorkbenchProject> {
  let project = createBlankWorkbenchProject("project:test-combine-step");
  project = finishSketch(project, "feature:sketch-plate", "Plate sketch", [{ id: "entity:plate", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 30, rotationDeg: 0, construction: false }]);
  project = finishSketch(project, "feature:sketch-boss", "Boss sketch", [{ id: "entity:boss", kind: "circle", center: [10, 0], radiusMm: 5, construction: false }]);
  const features = designOf(project).features;
  const plateSketch = features.find((feature) => feature.id === "feature:sketch-plate");
  const bossSketch = features.find((feature) => feature.id === "feature:sketch-boss");
  if (plateSketch?.kind !== "sketch" || bossSketch?.kind !== "sketch") throw new Error("sketches missing");
  const plate: DesignSolidFeature = { id: "feature:extrude-plate", name: "Extrude plate", kind: "extrude", suppressed: false, sketchFeatureId: plateSketch.id, profileIds: [], valueMm: 10, bodyId: PLATE };
  const boss: DesignSolidFeature = { id: "feature:extrude-boss", name: "Extrude boss", kind: "extrude", suppressed: false, sketchFeatureId: bossSketch.id, profileIds: [], valueMm: 20, bodyId: BOSS };
  const builtPlate = await rebuildSolidFeature(plate, plateSketch);
  const builtBoss = await rebuildSolidFeature(boss, bossSketch);
  assert(builtPlate.ok && builtBoss.ok, "both bodies build");
  if (!builtPlate.ok || !builtBoss.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: plate, body: builtPlate.body });
  return run(project, { kind: "add-design-solid", feature: boss, body: builtBoss.body });
}

const combineFeature = (mode: "join" | "cut" | "intersect", extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature => ({
  id: "feature:combine-1", name: mode === "join" ? "Join Boss" : mode === "cut" ? "Cut Boss" : "Intersect Boss", kind: "combine", suppressed: false,
  sketchFeatureId: "feature:sketch-plate", profileIds: [], valueMm: 1, bodyId: PLATE, operation: "direct-edit",
  combineToolBodyIds: [BOSS], combineMode: mode, ...extra
});

export const combineStepTests: readonly TestCase[] = [
  {
    name: "Combine is one timeline step: the target and the tool keep their extrudes, a sketch edit on the tool still drives the result, and suppressing the step gives the plain plate back",
    run: async () => {
      let project = await twoBodies();
      const plateAlone = volumeOf(project, PLATE);
      const bossAlone = volumeOf(project, BOSS);
      near(plateAlone, 40 * 30 * 10, plateAlone * 0.001, "the plate is 40 x 30 x 10");
      const feature = combineFeature("join");
      assert(validSolidFeaturePayload(feature), "the combine step validates");
      project = run(project, { kind: "add-design-solid", feature, body: project.part.generalBodies!.find((body) => body.id === PLATE)! });
      project = await replay(project);
      const overlap = Math.PI * 25 * 10; // the boss inside the plate's thickness
      const joined = volumeOf(project, PLATE);
      near(joined, plateAlone + bossAlone - overlap, (plateAlone + bossAlone) * 0.01, `join adds the boss above the plate: ${joined.toFixed(0)} mm³`);
      assert(isClosedAndOriented(project.part.generalBodies!.find((body) => body.id === PLATE)!.indices), "the combined body is closed");
      // The regression PT-15 names: every input step is still on the timeline.
      const kinds = designOf(project).features.map((item) => `${item.kind}:${item.id}`);
      assert(kinds.some((item) => item === "extrude:feature:extrude-plate") && kinds.some((item) => item === "extrude:feature:extrude-boss"), `the extrudes of both bodies survive: ${kinds.join(", ")}`);
      assert(designOf(project).features.every((item) => item.health === undefined), "no step is flagged");

      // Editing the TOOL's sketch rebuilds the combined result: the boss grows and the joined volume follows.
      let edited = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-boss" });
      edited = run(edited, { kind: "set-sketch-dimension", entityId: "entity:boss", dimension: "radius", valueMm: 7 });
      edited = run(edited, { kind: "commit-design-sketch", featureId: "feature:sketch-boss", name: "Boss sketch" });
      edited = await replay(edited);
      const bigBoss = volumeOf(edited, BOSS);
      near(bigBoss, Math.PI * 49 * 20, bigBoss * 0.01, "the tool body grew with its sketch");
      near(volumeOf(edited, PLATE), plateAlone + bigBoss - Math.PI * 49 * 10, (plateAlone + bigBoss) * 0.01, "the combined body follows the tool's sketch edit");

      // Suppressing the combine gives the plain plate back; the tool body is untouched.
      const off = await replay(run(edited, { kind: "set-design-feature-suppressed", featureId: "feature:combine-1", suppressed: true }));
      near(volumeOf(off, PLATE), plateAlone, plateAlone * 0.001, "suppressing the combine restores the plain plate");
      near(volumeOf(off, BOSS), bigBoss, bigBoss * 0.001, "the tool body is still there");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(edited))).ok, "the design with a combine step saves and loads");
    }
  },
  {
    name: "The combine step's operation can be edited (Join to Cut) and replays as a cut; bad combine payloads are refused",
    run: async () => {
      let project = await twoBodies();
      const plateAlone = volumeOf(project, PLATE);
      project = run(project, { kind: "add-design-solid", feature: combineFeature("join"), body: project.part.generalBodies!.find((body) => body.id === PLATE)! });
      project = await replay(project);
      const step = designOf(project).features.find((item): item is DesignSolidFeature => item.id === "feature:combine-1")!;
      const fields = parameterFieldsOf(step);
      assert(fields !== undefined && fields.some((field) => field.id === "mode"), "the edit dialog offers the operation");
      const edited = applyParameterValues(step, { mode: "cut" });
      assert(edited.ok && edited.feature.combineMode === "cut", `the operation changes to cut: ${edited.ok ? "" : edited.message}`);
      if (!edited.ok) return;
      project = run(project, { kind: "update-design-solid", feature: edited.feature, body: project.part.generalBodies!.find((body) => body.id === PLATE)! });
      project = await replay(project);
      const overlap = Math.PI * 25 * 10;
      near(volumeOf(project, PLATE), plateAlone - overlap, plateAlone * 0.01, "the edited step replays as a cut through the plate");
      assert(isClosedAndOriented(project.part.generalBodies!.find((body) => body.id === PLATE)!.indices), "the cut body is closed");

      const good = combineFeature("join");
      assert(!validSolidFeaturePayload({ ...good, combineMode: undefined as never }), "a combine without a mode is refused");
      assert(!validSolidFeaturePayload({ ...good, combineToolBodyIds: [] }), "a combine without tools is refused");
      assert(!validSolidFeaturePayload({ ...good, combineToolBodyIds: [PLATE] }), "a combine whose tool is its own target is refused");
      assert(!validSolidFeaturePayload({ ...good, combineToolBodyIds: [BOSS, BOSS] }), "a repeated tool is refused");
      assert(!validSolidFeaturePayload({ ...good, operation: "join" }), "a combine must be a direct-edit step");
      assert(!validSolidFeaturePayload({ ...good, combineMode: "weld" as never }), "an unknown mode is refused");
      assert(!validSolidFeaturePayload({ ...good, kind: "extrude" }), "combine fields on another kind are refused");

      // A deleted tool body flags the step with a reason instead of combining something else.
      // Deleting the tool's extrude takes the tool body and, as a dependent, the combine step with it (the combine
      // consumes that body), so the plate goes back to its own shape and nothing is left flagged or dangling.
      const gone = await replay(run(project, { kind: "delete-design-feature", featureId: "feature:extrude-boss" }));
      assert(designOf(gone).features.every((item) => item.id !== "feature:combine-1"), "the combine goes with the tool it consumed");
      assert((gone.part.generalBodies ?? []).every((body) => body.id !== BOSS), "the tool body is gone");
      near(volumeOf(gone, PLATE), plateAlone, plateAlone * 0.001, "the plate is whole again");
      assert(designOf(gone).features.every((item) => item.health === undefined), "nothing is flagged after the cascade");
    }
  }
];
