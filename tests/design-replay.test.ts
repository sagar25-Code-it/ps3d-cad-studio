import type { DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { replayAllBodies, replayBody, type RebuildResult } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-replay-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function volume(positions: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3; const b = indices[index + 1]! * 3; const c = indices[index + 2]! * 3;
    total += positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return Math.abs(total / 6);
}

const BODY = "general-body:plate";
const PLATE_MINUS_BORE = 60 * 40 * 10 - Math.PI * 5 ** 2 * 10;

const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: BODY };
const cutOf = (id: string, sketchFeatureId: string): DesignSolidFeature => ({ id, name: id, kind: "extrude", suppressed: false, sketchFeatureId, profileIds: [], valueMm: 30, direction: "symmetric", operation: "cut", bodyId: BODY });

/** The default plate sketch extruded 10 mm into a body, then a second sketch holding `entity`, ready to cut with. */
async function plateWithSecondSketch(entity: SketchEntity): Promise<WorkbenchProject> {
  let project = run(createWorkbenchProject("project:test-replay"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const first = (await replayBody({ ...project, design: { ...designOf(project), features: [...designOf(project).features, extrude], rollbackIndex: 2 } }, BODY)).find((result) => result.body !== undefined);
  assert(first?.body !== undefined, "the plate builds");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: first.body });
  project = run(project, { kind: "new-design-sketch", plane: "datum:xy" });
  project = run(project, { kind: "add-sketch-entity", entity });
  return run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
}

const bodyVolume = (project: WorkbenchProject): number => {
  const body = project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
  return volume(body.positionsMm, body.indices);
};

const withCut = (project: WorkbenchProject, id = "feature:cut-1"): WorkbenchProject => {
  const cut = cutOf(id, "feature:sketch-2");
  return { ...project, design: { ...designOf(project), features: [...designOf(project).features, cut], rollbackIndex: designOf(project).features.length + 1 } };
};

const apply = (project: WorkbenchProject, results: readonly RebuildResult[]): WorkbenchProject => run(project, { kind: "regenerate-design", results });

export const designReplayTests: readonly TestCase[] = [
  {
    name: "replaying a body applies its cut in order and takes the cut's volume out of it",
    run: async () => {
      const hole: SketchEntity = { id: "entity:hole", kind: "circle", center: [0, 12], radiusMm: 4, construction: false };
      const project = withCut(await plateWithSecondSketch(hole));
      near(bodyVolume(project), PLATE_MINUS_BORE, PLATE_MINUS_BORE * 0.03, "before the replay the body is the plate");
      const results = await replayBody(project, BODY);
      equal(results.length, 2, "one result per live step of the body");
      assert(results.every((result) => result.message === undefined), "nothing failed");
      const replayed = apply(project, results);
      const expected = PLATE_MINUS_BORE - Math.PI * 4 ** 2 * 10;
      near(bodyVolume(replayed), expected, expected * 0.03, "the plate lost the volume of the new hole");
      equal((replayed.part.generalBodies ?? []).length, 1, "still one body");
      assert(designOf(replayed).features.every((feature) => feature.health === undefined), "no step is flagged");
    }
  },
  {
    name: "suppressing the cut, or rolling back before it, shows the body without it; restoring shows it again",
    run: async () => {
      const hole: SketchEntity = { id: "entity:hole", kind: "circle", center: [0, 12], radiusMm: 4, construction: false };
      let project = withCut(await plateWithSecondSketch(hole));
      project = apply(project, await replayBody(project, BODY));
      const withHole = bodyVolume(project);
      const suppressed = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:cut-1", suppressed: true });
      const back = apply(suppressed, await replayBody(suppressed, BODY));
      near(bodyVolume(back), PLATE_MINUS_BORE, PLATE_MINUS_BORE * 0.03, "suppressed: the hole is gone");
      const restored = run(back, { kind: "set-design-feature-suppressed", featureId: "feature:cut-1", suppressed: false });
      const again = apply(restored, await replayBody(restored, BODY));
      near(bodyVolume(again), withHole, withHole * 0.001, "unsuppressed: the hole is back, the same as before");
      const rolled = run(again, { kind: "set-design-rollback", index: 2 });
      const early = apply(rolled, await replayAllBodies(rolled));
      near(bodyVolume(early), PLATE_MINUS_BORE, PLATE_MINUS_BORE * 0.03, "rolled back before the cut: the hole is gone");
    }
  },
  {
    name: "editing the cut's sketch and replaying moves the hole's size, and a cut that would split the solid is reported and skipped",
    run: async () => {
      const hole: SketchEntity = { id: "entity:hole", kind: "circle", center: [0, 12], radiusMm: 4, construction: false };
      let project = withCut(await plateWithSecondSketch(hole));
      project = apply(project, await replayBody(project, BODY));
      // Reopen the second sketch, make the hole bigger and finish it: the cut's snapshot changes.
      project = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-2" });
      project = run(project, { kind: "delete-sketch-entity", entityId: "entity:hole" });
      project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:hole", kind: "circle", center: [0, 12], radiusMm: 6, construction: false } });
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:ignored", name: "Sketch 2" });
      project = apply(project, await replayBody(project, BODY));
      const bigger = PLATE_MINUS_BORE - Math.PI * 6 ** 2 * 10;
      near(bodyVolume(project), bigger, bigger * 0.03, "the larger hole took more material");

      // A slot wider than the gap between the plate's edges would cut it in two: the step is flagged and left out.
      let split = await plateWithSecondSketch({ id: "entity:slot", kind: "rectangle", center: [0, 0], widthMm: 10, heightMm: 100, rotationDeg: 0, construction: false });
      split = withCut(split);
      const results = await replayBody(split, BODY);
      const failed = results.find((result) => result.featureId === "feature:cut-1");
      assert(failed?.message !== undefined, "the cut that splits the plate is reported");
      split = apply(split, results);
      near(bodyVolume(split), PLATE_MINUS_BORE, PLATE_MINUS_BORE * 0.03, "the plate is left as it was");
      assert(designOf(split).features.find((feature) => feature.id === "feature:cut-1")?.health !== undefined, "and the step is flagged in the timeline");
    }
  }
];
