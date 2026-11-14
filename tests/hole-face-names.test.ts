import type { DesignSketchFeature, DesignSolidFeature, EdgeBlendGroup, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { describePickedEdge, nearestPickableEdge, pickableEdges } from "../packages/workbench-geometry/src/index.js";
import { facesOfBody } from "../apps/studio-web/src/edge-blend-step.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";

/** HS-13: a hole is cut by the origin-tracking Boolean, so the body keeps its face names and a later fillet finds its edge by its faces. */

const BODY = "general-body:block";
const CORNER = 1 - Math.PI / 4;
let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-holenames-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const outline: SketchEntity = { id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false };
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const volumeOf = (body: GeneralSolidBody): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;

async function block(): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature }> {
  let project = createWorkbenchProject("project:test-hole-names");
  project = { ...project, sketch: { ...project.sketch, entities: [outline], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, "the block builds");
  if (!built.ok) throw new Error("unreachable");
  return { project: run(project, { kind: "add-design-solid", feature: extrude, body: built.body }), sketch };
}

const holeStep = (sketch: DesignSketchFeature): DesignSolidFeature => ({
  id: "feature:hole-1", name: "Hole Ø6", kind: "hole", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 6, bodyId: BODY,
  operation: "direct-edit", holeStyle: "simple", holePositionMm: [0, 0, 20], holeNormal: [0, 0, 1], holeDiameterMm: 6, holeDepthMm: 0
});

const filletStep = (sketch: DesignSketchFeature, groups: readonly EdgeBlendGroup[]): DesignSolidFeature =>
  ({ id: "feature:fillet-1", name: "Fillet R 3 mm", kind: "edge-blend", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 3, bodyId: BODY, operation: "direct-edit", blendType: "fillet", blendEdges: groups });

async function addAndReplay(project: WorkbenchProject, feature: DesignSolidFeature): Promise<WorkbenchProject> {
  const added = run(project, { kind: "add-design-solid", feature, body: bodyOf(project) });
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

const deeper = (project: WorkbenchProject): WorkbenchProject => {
  let next = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: 60 });
  return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
};

function pickFrontTopEdge(project: WorkbenchProject): EdgeBlendGroup {
  const body = bodyOf(project);
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices }, 5, {});
  assert(typeof edges !== "string", "edges can be picked");
  if (typeof edges === "string") throw new Error("unreachable");
  const near = nearestPickableEdge(edges, [0, -20, 20]);
  assert(near !== undefined, "the front-top edge is there");
  return describePickedEdge(near!.chain, facesOfBody(body)) as EdgeBlendGroup;
}

export const holeFaceNameTests: readonly TestCase[] = [
  {
    name: "After a hole step the body still has named faces, among them the hole's wall named after the step, and the solid is the block less the bore",
    run: async () => {
      const { project, sketch } = await block();
      const withHole = await addAndReplay(project, holeStep(sketch));
      const body = bodyOf(withHole);
      assert(body.brep !== undefined && body.brep.faces.length > 6, `the body keeps its named faces: ${body.brep?.faces.length}`);
      assert(body.brep!.faces.some((face) => face.role.includes("feature:hole-1.wall")), "the bore's wall is named after the hole step");
      assert(body.brep!.faceTriangles.length * 3 === body.indices.length, "every triangle names its face");
      near(volumeOf(body), 60 * 40 * 20 - Math.PI * 9 * 20, 60 * 40 * 20 * 0.01, "the 6 mm bore through 20 mm is cut");
      assert(designOf(withHole).features.every((feature) => feature.health === undefined), "no step is flagged");
    }
  },
  {
    name: "A fillet after a hole is found by its faces when the plate grows 20 mm deeper; the same fillet picked without face names is flagged",
    run: async () => {
      const { project, sketch } = await block();
      const withHole = await addAndReplay(project, holeStep(sketch));
      const group = pickFrontTopEdge(withHole);
      assert(group.faceKeys !== undefined && group.faceKeys[0] !== group.faceKeys[1], "the pick after the hole remembers the two faces beside the edge");
      const keyed = await addAndReplay(withHole, filletStep(sketch, [group]));
      const deepKeyed = deeper(keyed);
      const replayed = run(deepKeyed, { kind: "regenerate-design", results: await replayAllBodies(deepKeyed) });
      assert(designOf(replayed).features.every((feature) => feature.health === undefined), "keyed: nothing is flagged after the edge moved 20 mm");
      near(volumeOf(bodyOf(replayed)), 60 * 60 * 20 - Math.PI * 9 * 20 - 9 * CORNER * 60, 60 * 60 * 20 * 0.004, "keyed: the edge that moved is still the one rounded, and the bore is still there");
      const bare = await addAndReplay(withHole, filletStep(sketch, [{ segments: group.segments }]));
      const deepBare = deeper(bare);
      const flagged = run(deepBare, { kind: "regenerate-design", results: await replayAllBodies(deepBare) });
      const step = designOf(flagged).features.find((feature) => feature.kind === "edge-blend");
      assert(step?.health !== undefined, "bare: with no names to follow, the step is flagged with a reason");
    }
  },
  {
    name: "A hole that severs the body keeps the pieces, and a modelled thread still reshapes the bore (the names are dropped there, as before)",
    run: async () => {
      const { project, sketch } = await block();
      // A bore wider than the block's width severs it into two pieces.
      const wide: DesignSolidFeature = { ...holeStep(sketch), id: "feature:hole-wide", holeDiameterMm: 50, valueMm: 50 };
      const severed = await addAndReplay(project, wide);
      const pieces = (severed.part.generalBodies ?? []).filter((candidate) => candidate.id.startsWith(`${BODY}.piece-`));
      assert(pieces.length >= 1, `the pieces the hole cut off are kept as bodies: ${(severed.part.generalBodies ?? []).map((candidate) => candidate.id).join(", ")}`);
      const modelled: DesignSolidFeature = { ...holeStep(sketch), id: "feature:hole-thread", holeDiameterMm: 6.7, valueMm: 6.7, holeDepthMm: 12, holeThread: { mode: "modelled", pitchMm: 1, majorDiameterMm: 8, handedness: "right", lengthMm: 10 } };
      const threaded = await addAndReplay(project, modelled);
      assert(designOf(threaded).features.every((feature) => feature.health === undefined), "a modelled thread still builds");
      assert(bodyOf(threaded).brep === undefined, "and keeps its old behaviour of dropping the face names");
    }
  },
];
