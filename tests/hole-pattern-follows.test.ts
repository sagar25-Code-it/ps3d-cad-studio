import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, HolePlacement, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { holePlacementFor } from "../apps/studio-web/src/hole-placement.js";
import { addPattern } from "../apps/studio-web/src/pattern-commit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Review: the copies of a hole pattern are laid out from where the face-placed source hole sits now, not from the point it was first picked at. */

const BODY = "general-body:block";
const HOLE_AT: readonly [number, number, number] = [10, 5, 20];
let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-holepattern-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const outline: SketchEntity = { id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false };
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const volumeOf = (body: GeneralSolidBody): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;

async function plateWithHole(placed: boolean): Promise<WorkbenchProject> {
  let project = createWorkbenchProject("project:test-hole-pattern");
  project = { ...project, sketch: { ...project.sketch, entities: [outline], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, "the plate builds");
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  const placement: HolePlacement | undefined = placed ? holePlacementFor(bodyOf(project), HOLE_AT, [0, 0, 1]) : undefined;
  const hole: DesignSolidFeature = {
    id: "feature:hole-1", name: "Hole 6", kind: "hole", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 6, bodyId: BODY,
    operation: "direct-edit", holeStyle: "simple", holePositionMm: HOLE_AT, holeNormal: [0, 0, 1], holeDiameterMm: 6, holeDepthMm: 0,
    ...(placement === undefined ? {} : { holePlacement: placement })
  };
  const added = run(project, { kind: "add-design-solid", feature: hole, body: bodyOf(project) });
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

const resize = (project: WorkbenchProject, width: number, height: number): WorkbenchProject => {
  let next = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: width });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: height });
  return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
};

/** How many vertices of the body form a ring of radius 3 mm around (x, y) on the top face (z = 20): a 6 mm bore's rim is there. */
function rimVertices(body: GeneralSolidBody, x: number, y: number): number {
  let count = 0;
  for (let vertex = 0; vertex < body.positionsMm.length; vertex += 3) {
    if (Math.abs(body.positionsMm[vertex + 2]! - 20) > 0.05) continue;
    if (Math.abs(Math.hypot(body.positionsMm[vertex]! - x, body.positionsMm[vertex + 1]! - y) - 3) < 0.05) count += 1;
  }
  return count;
}

async function patterned(placed: boolean): Promise<WorkbenchProject> {
  const project = await plateWithHole(placed);
  // A 2 x 2 grid, 15 mm apart along -X and 12 mm along +Y from the source hole at (10, 5).
  const added = await addPattern(project, {
    shape: { type: "rectangular", countA: 2, spacingAMm: 15, directionA: [-1, 0, 0], countB: 2, spacingBMm: 12, directionB: [0, 1, 0], sizing: "spacing" },
    result: "join", sourceBodyId: BODY, featureIds: ["feature:hole-1"]
  });
  assert(added.ok, `the pattern is added: ${added.ok ? "" : added.message}`);
  if (!added.ok) throw new Error("unreachable");
  return added.project;
}

export const holePatternFollowTests: readonly TestCase[] = [
  {
    name: "A 2 x 2 pattern of a face-placed hole stays a regular grid around the source when the plate grows 30 x 20 mm",
    run: async () => {
      const start = await patterned(true);
      near(volumeOf(bodyOf(start)), 60 * 40 * 20 - 4 * Math.PI * 9 * 20, 60 * 40 * 20 * 0.01, "four bores at the start");
      for (const [x, y] of [[10, 5], [-5, 5], [10, 17], [-5, 17]] as const) assert(rimVertices(bodyOf(start), x, y) >= 8, `a bore at (${x}, ${y}) at the start`);
      // 90 x 60: the right face moves to x = 45 and the back face to y = 30, so the source follows to (25, 15) and the grid with it.
      const grown = resize(start, 90, 60);
      const replayed = run(grown, { kind: "regenerate-design", results: await replayAllBodies(grown) });
      assert(designOf(replayed).features.every((feature) => feature.health === undefined || !feature.health.message.includes("skipped")), "no position of the pattern was skipped");
      const body = bodyOf(replayed);
      for (const [x, y] of [[25, 15], [10, 15], [25, 27], [10, 27]] as const) assert(rimVertices(body, x, y) >= 8, `a bore at (${x}, ${y}) after the plate grew`);
      for (const [x, y] of [[10, 5], [-5, 5], [-5, 17]] as const) assert(rimVertices(body, x, y) === 0, `no bore is left behind at the old (${x}, ${y})`);
      near(volumeOf(body), 90 * 60 * 20 - 4 * Math.PI * 9 * 20, 90 * 60 * 20 * 0.005, "still exactly four bores in the bigger plate");
    }
  },
  {
    name: "A pattern of a hole picked as a bare point lays its copies out from that stored point, as before",
    run: async () => {
      const start = await patterned(false);
      const grown = resize(start, 90, 60);
      const replayed = run(grown, { kind: "regenerate-design", results: await replayAllBodies(grown) });
      const body = bodyOf(replayed);
      for (const [x, y] of [[10, 5], [-5, 5], [10, 17], [-5, 17]] as const) assert(rimVertices(body, x, y) >= 8, `a bore at the stored (${x}, ${y})`);
      equal(designOf(replayed).features.filter((feature) => feature.kind === "pattern").length, 1, "one pattern step");
    }
  },
];
