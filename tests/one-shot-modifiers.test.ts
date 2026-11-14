import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { allConvexEdgeGroups, blendAllFeature, centroidHoleFeature, centroidHolePoint } from "../apps/studio-web/src/one-shot-steps.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

/**
 * PT-01: the ribbon Hole, Fillet All and Chamfer All used to swap the body's mesh without a timeline step, so the next replay
 * silently removed them. They are now recorded as ordinary steps (a "hole" step at the point the one-shot drilled; one
 * "edge-blend" step holding every sharp convex run), and these tests prove the step survives a sketch edit and a reload.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-oneshot-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const BODY = "general-body:block";
const CORNER = 1 - Math.PI / 4;
const rectangle = (width: number, height: number): SketchEntity => ({ id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const bodyOf = (project: WorkbenchProject) => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;

async function projectWith(entities: readonly SketchEntity[], height: number): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature }> {
  let project = createWorkbenchProject("project:test-one-shot");
  project = { ...project, sketch: { ...project.sketch, entities: [...entities], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: height, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, `the block builds: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  return { project, sketch };
}

async function addAndReplay(project: WorkbenchProject, feature: DesignSolidFeature): Promise<WorkbenchProject> {
  const added = run(project, { kind: "add-design-solid", feature, body: bodyOf(project) });
  const results = await replayAllBodies(added);
  const failed = results.find((result) => result.featureId === feature.id && result.message !== undefined);
  assert(failed === undefined, `the ${feature.id} step replays: ${failed?.message ?? ""}`);
  return run(added, { kind: "regenerate-design", results });
}

const replay = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });

const widen = (project: WorkbenchProject, width: number, height: number): WorkbenchProject => {
  let next = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: width });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: height });
  return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
};

export const oneShotModifierTests: readonly TestCase[] = [
  {
    name: "Fillet All is one edge-blend timeline step holding every sharp convex run, and it survives a sketch edit and a save-and-load instead of vanishing at the next rebuild",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      near(solid, 60 * 40 * 20, solid * 0.001, "the block is 60 × 40 × 20");
      const groups = allConvexEdgeGroups(bodyOf(base));
      assert(typeof groups !== "string", typeof groups === "string" ? groups : "");
      if (typeof groups === "string") return;
      assert(groups.length === 12, `a box has 12 sharp convex runs: ${groups.length}`);
      const feature = blendAllFeature(bodyOf(base), "fillet", 1, sketch.id, "feature:fillet-all");
      assert(typeof feature !== "string", typeof feature === "string" ? feature : "");
      if (typeof feature === "string") return;
      assert(feature.kind === "edge-blend" && feature.blendType === "fillet" && feature.blendEdges!.length === 12, "the step records the blend and all 12 runs");
      assert(/Fillet R 1 mm/.test(feature.name), `the step is named for its size: ${feature.name}`);
      assert(validSolidFeaturePayload(feature), "the step passes the solid-feature validator");
      const project = await addAndReplay(base, feature);
      const body = bodyOf(project);
      assert(isClosedAndOriented(body.indices) && solidMetrics(body.positionsMm, body.indices).outward, "the filleted block is closed and outward");
      assert(volumeOf(body) < solid - 100, `every run removed material: ${(solid - volumeOf(body)).toFixed(1)} mm³ gone`);
      const features = designOf(project).features;
      assert(features[features.length - 1]!.kind === "edge-blend", "the step is on the timeline");

      // The regression PT-01 names: a rebuild (here a sketch edit) must keep the blend, not silently drop it.
      const wide = await replay(widen(project, 80, 40));
      const wideBody = bodyOf(wide);
      assert(designOf(wide).features.every((item) => item.health === undefined), "no step is flagged after the sketch edit");
      assert(volumeOf(wideBody) < 80 * 40 * 20 - 100, "the blends are still in the rebuilt, wider block");
      assert(isClosedAndOriented(wideBody.indices), "the rebuilt block is closed");

      // Save and load: the stored project round-trips with the step and its geometry.
      const saved = JSON.parse(JSON.stringify(wide));
      const loaded = validateWorkbenchProject(saved);
      assert(loaded.ok, `the saved project validates: ${loaded.ok ? "" : loaded.diagnostics[0]?.message ?? ""}`);
      if (loaded.ok) near(volumeOf(bodyOf(loaded.value)), volumeOf(wideBody), 1e-6, "the reloaded body keeps its filleted geometry");
    }
  },
  {
    name: "Chamfer All records one step whose removed volume matches a chamfer on every convex run of the box",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      const feature = blendAllFeature(bodyOf(base), "chamfer", 1, sketch.id, "feature:chamfer-all");
      assert(typeof feature !== "string", typeof feature === "string" ? feature : "");
      if (typeof feature === "string") return;
      const project = await addAndReplay(base, feature);
      const body = bodyOf(project);
      assert(isClosedAndOriented(body.indices), "the chamfered block is closed");
      // Twelve 1 × 1 chamfers: edges 4·60 + 4·40 + 4·20 = 480 mm, each removing 0.5 mm² minus the shared corners.
      const removed = solid - volumeOf(body);
      near(removed, 0.5 * 480, 0.5 * 480 * 0.15, `the chamfers remove about half a square millimetre along every edge: ${removed.toFixed(1)} mm³`);
      // Bad sizes are refused with a reason, not committed.
      assert(typeof blendAllFeature(bodyOf(base), "chamfer", 0, sketch.id) === "string", "a zero size is refused");
      assert(typeof blendAllFeature(bodyOf(base), "fillet", Number.NaN, sketch.id) === "string", "a NaN size is refused");
    }
  },
  {
    name: "The ribbon Hole is a hole timeline step drilled at the top-face centroid, it survives a sketch edit, and its diameter can still be read from the step",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      const point = centroidHolePoint(bodyOf(base).positionsMm);
      assert(point !== undefined && Math.abs(point[0]) < 1e-6 && Math.abs(point[1]) < 1e-6 && Math.abs(point[2] - 20) < 1e-6, `the drill point is the centre of the top face: ${JSON.stringify(point)}`);
      const feature = centroidHoleFeature(bodyOf(base), 6, sketch.id, "feature:hole-all");
      assert(typeof feature !== "string", typeof feature === "string" ? feature : "");
      if (typeof feature === "string") return;
      assert(feature.kind === "hole" && feature.holeStyle === "simple" && feature.holeDepthMm === 0 && feature.holeDiameterMm === 6, "a simple through hole Ø 6 is recorded");
      assert(validSolidFeaturePayload(feature), "the hole step passes the validator");
      const project = await addAndReplay(base, feature);
      const removed = solid - volumeOf(bodyOf(project));
      const bore = Math.PI * 9 * 20;
      near(removed, bore, bore * 0.05, `the through hole removes about π·3²·20: ${removed.toFixed(1)} mm³`);

      // A rebuild keeps the hole: the block grows, the hole is still there, drilled through the new thickness.
      const wide = await replay(widen(project, 80, 60));
      const wideRemoved = 80 * 60 * 20 - volumeOf(bodyOf(wide));
      near(wideRemoved, bore, bore * 0.05, `after the sketch edit the hole is still through the block: ${wideRemoved.toFixed(1)} mm³ removed`);
      assert(designOf(wide).features.every((item) => item.health === undefined), "no step is flagged after the edit");
      assert(typeof centroidHoleFeature(bodyOf(base), -1, sketch.id) === "string", "a negative diameter is refused");
    }
  }
];
