import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { designOf, faceReferenceOf, planarFacesOfBody, resolveSketchFace } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { rebuildDependents, rebuildSolidFeature, replayAllBodies, type RebuildResult } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { committedSketch, message, meshStats, pipelineApply, pipelineRun, rect, solidFeature, solidOf } from "./pipeline-kit.js";

function applyResults(project: WorkbenchProject, results: readonly RebuildResult[]): WorkbenchProject {
  return pipelineRun(project, {
    kind: "regenerate-design",
    results: results.map((result) => ({
      featureId: result.featureId,
      ...(result.body === undefined ? {} : { body: result.body }),
      ...(result.pieces === undefined ? {} : { pieces: result.pieces }),
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.sketchPlaneOffsetMm === undefined ? {} : { sketchPlaneOffsetMm: result.sketchPlaneOffsetMm })
    }))
  });
}

const sketchOf = (project: WorkbenchProject, id: string): DesignSketchFeature => designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === id && feature.kind === "sketch")!;
const featureOf = (project: WorkbenchProject, id: string): DesignSolidFeature => designOf(project).features.find((feature): feature is DesignSolidFeature => feature.id === id && feature.kind !== "sketch")!;
const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => project.part.generalBodies!.find((body) => body.id === id)!;

/** A 40 x 40 base extruded `height` mm, with a 10 x 10 boss sketched on its top face and joined 15 mm up. */
async function baseWithBoss(height: number): Promise<WorkbenchProject> {
  const base = committedSketch("datum:xy", [rect("base", 0, 0, 40, 40)]);
  const e1 = solidFeature("extrude", base.sketch, { id: "feature:e1", valueMm: height, bodyId: "general-body:base" });
  const baseBody = solidOf(await rebuildSolidFeature(e1, base.sketch));
  let project = pipelineRun(base.project, { kind: "add-design-solid", feature: e1, body: baseBody });
  const top = planarFacesOfBody(baseBody).find((face) => face.axis === "z" && face.outwardPositive);
  assert(top !== undefined, "the extruded base has a named, flat top face");
  near(top.coordinateMm, height, 1e-6, "found at the height of the extrusion");
  project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy", offsetMm: top.coordinateMm, face: faceReferenceOf("general-body:base", top) });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("boss", 0, 0, 10, 10)], addConstraints: [], label: "Draw boss" });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Boss sketch" });
  const bossSketch = sketchOf(project, "feature:s2");
  const e2: DesignSolidFeature = { id: "feature:e2", name: "Boss", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s2", profileIds: [detectSketchProfiles(bossSketch.sketch)[0]!.id], valueMm: 15, bodyId: "general-body:base", operation: "join" };
  project = pipelineRun(project, { kind: "add-design-solid", feature: e2, body: baseBody });
  return applyResults(project, await replayAllBodies(project));
}

export const pipelineFaceTests: readonly TestCase[] = [
  {
    name: "P11 a sketch drawn on a face follows the face: editing the base moves the boss with it, and the sketch is stored where the face now is",
    run: async () => {
      let project = await baseWithBoss(10);
      equal(sketchOf(project, "feature:s2").sketch.planeFace?.faceRole.length! > 0, true, "the boss sketch remembers its face");
      near(meshStats(bodyOf(project, "general-body:base")).hi[2], 25, 0.01, "10 mm base plus a 15 mm boss stands 25 mm tall");

      // Edit the base: 10 mm -> 25 mm. The boss sketch used to stay at the old number, so the boss was buried (still 25 mm tall).
      const e1 = { ...featureOf(project, "feature:e1"), valueMm: 25 };
      const rebuiltBase = solidOf(await rebuildSolidFeature(e1, sketchOf(project, "feature:s1")));
      project = pipelineRun(project, { kind: "update-design-solid", feature: e1, body: rebuiltBase });
      const replayed = await replayAllBodies(project);
      assert(replayed.every((result) => result.message === undefined), `the replay reports nothing wrong: ${replayed.map((result) => result.message ?? "").join(" ")}`);
      project = applyResults(project, replayed);
      near(meshStats(bodyOf(project, "general-body:base")).hi[2], 40, 0.01, "the boss now stands on the raised top: 25 + 15 = 40 mm");
      near(sketchOf(project, "feature:s2").sketch.planeOffsetMm ?? 0, 25, 1e-9, "the boss sketch is stored on the face's new position, so reopening it shows it there");
      assert(featureOf(project, "feature:e2").health === undefined, "and no feature is flagged");

      // The same through the dependents path used after a sketch edit.
      const e1b = { ...featureOf(project, "feature:e1"), valueMm: 5 };
      const base5 = solidOf(await rebuildSolidFeature(e1b, sketchOf(project, "feature:s1")));
      project = pipelineRun(project, { kind: "update-design-solid", feature: e1b, body: base5 });
      project = applyResults(project, await rebuildDependents(project, "feature:s1"));
      near(meshStats(bodyOf(project, "general-body:base")).hi[2], 20, 0.01, "rebuilding the dependents of the base sketch moves the boss too (5 + 15)");
    }
  },
  {
    name: "P11 a face that cannot be found again is reported, and one found by position is flagged",
    run: async () => {
      let project = await baseWithBoss(10);
      const stored = sketchOf(project, "feature:s2");
      const body = bodyOf(project, "general-body:base");
      // Lost: a body with no named faces (or none facing that way) leaves the sketch where it was and says so.
      const lost = resolveSketchFace(stored.sketch.planeFace!, { positionsMm: body.positionsMm, indices: body.indices, name: "Base" });
      assert(!lost.ok && /no longer exists|no longer in the part/u.test(lost.message), `a lost face is explained: ${lost.ok ? "" : lost.message}`);
      const goneBody = resolveSketchFace(stored.sketch.planeFace!, undefined);
      assert(!goneBody.ok && /no longer in the part/u.test(goneBody.message), "a deleted solid is explained");
      // Found by position: the face key and role no longer exist but a flat face of the same direction does.
      const renamed = { ...stored.sketch.planeFace!, faceKey: "face:vanished", faceRole: "face.vanished" };
      const nearest = resolveSketchFace(renamed, body);
      assert(nearest.ok && nearest.how === "nearest", "an unnamed face is found by direction and size");
      // End to end: the sketch points at a renamed face, so the replay flags the boss instead of staying silent.
      const edited = { ...stored, sketch: { ...stored.sketch, planeFace: renamed } };
      const tampered: WorkbenchProject = { ...project, design: { ...designOf(project), features: designOf(project).features.map((feature) => feature.id === "feature:s2" ? edited : feature) } };
      const results = await replayAllBodies(tampered);
      assert(results.some((result) => result.featureId === "feature:e2" && /nearest Z\+ face/u.test(result.message ?? "")), `the boss is flagged: ${results.map((result) => result.message ?? "-").join(" | ")}`);
      project = tampered;
      // A face reference travels with the plane operations and is validated.
      const bad = pipelineApply(project, { kind: "new-design-sketch", plane: "datum:xy", offsetMm: 5, face: { bodyId: "general-body:base", faceKey: "k", faceRole: "r", axis: "q" as never, outwardPositive: true, coordinateMm: 5, areaMm2: 4 } });
      assert(!bad.ok, `a malformed face reference is refused: ${message(bad)}`);
      const withTilt = pipelineApply(project, { kind: "new-design-sketch", plane: "datum:xy", tilt: { axis: "x", angleDeg: 10 }, face: stored.sketch.planeFace! });
      assert(!withTilt.ok, "a face reference cannot be combined with a tilt");
    }
  }
];
