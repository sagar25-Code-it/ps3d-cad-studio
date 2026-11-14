import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, HolePlacement, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, bindableFieldsOf, bindFeatureExpressions, createWorkbenchProject, designOf, isHealthNote, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { holeSpecOf, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { holePlacementFor, planarFacesOf, resolveHolePlacement } from "../apps/studio-web/src/hole-placement.js";
import { openCommandPanelForEdit, panelDraft } from "../apps/studio-web/src/command-panel.js";
import { parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** HS-15: a hole is placed by the faces beside it (a start face and two distances) and moves with them. */

const BODY = "general-body:block";
let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-holeplace-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const outline: SketchEntity = { id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false };
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const volumeOf = (body: GeneralSolidBody): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const stepOf = (project: WorkbenchProject): DesignSolidFeature => designOf(project).features.find((feature): feature is DesignSolidFeature => feature.id === "feature:hole-1")!;

/** A 60 x 40 x 20 block with the top face at z = 20, built through the real kernel so it has named faces. */
async function block(): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature }> {
  let project = createWorkbenchProject("project:test-hole-placement");
  project = { ...project, sketch: { ...project.sketch, entities: [outline], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, "the block builds");
  if (!built.ok) throw new Error("unreachable");
  return { project: run(project, { kind: "add-design-solid", feature: extrude, body: built.body }), sketch };
}

const HOLE_AT: readonly [number, number, number] = [10, 5, 20];

const holeStep = (sketch: DesignSketchFeature, placement: HolePlacement | undefined): DesignSolidFeature => ({
  id: "feature:hole-1", name: "Hole Ø6", kind: "hole", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 6, bodyId: BODY,
  operation: "direct-edit", holeStyle: "simple", holePositionMm: HOLE_AT, holeNormal: [0, 0, 1], holeDiameterMm: 6, holeDepthMm: 0,
  ...(placement === undefined ? {} : { holePlacement: placement })
});

async function withHole(project: WorkbenchProject, step: DesignSolidFeature): Promise<WorkbenchProject> {
  const added = run(project, { kind: "add-design-solid", feature: step, body: bodyOf(project) });
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

const resize = (project: WorkbenchProject, width: number, height: number): WorkbenchProject => {
  let next = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: width });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: height });
  return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
};

const replayed = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });

/** Where the hole's wall is: the middle of the vertices of the faces the hole step named. */
function wallCentre(body: GeneralSolidBody): readonly [number, number] {
  const brep = body.brep!;
  const wall = new Set(brep.faces.map((face, index) => face.role.includes("feature:hole-1.wall") ? index : -1).filter((index) => index >= 0));
  let x = 0; let y = 0; let count = 0;
  brep.faceTriangles.forEach((face, triangle) => {
    if (!wall.has(face)) return;
    for (let corner = 0; corner < 3; corner += 1) { const base = body.indices[triangle * 3 + corner]! * 3; x += body.positionsMm[base]!; y += body.positionsMm[base + 1]!; count += 1; }
  });
  assert(count > 0, "the hole's wall is in the body");
  return [x / count, y / count];
}

export const holePlacementTests: readonly TestCase[] = [
  {
    name: "A hole picked on the top face is placed from that face and the two nearest faces at right angles to it, with the distances to them",
    run: async () => {
      const { project } = await block();
      const body = bodyOf(project);
      const planes = planarFacesOf(body);
      equal(planes.length, 6, "all six faces of the block are flat and named");
      const placement = holePlacementFor(body, HOLE_AT, [0, 0, 1])!;
      assert(placement !== undefined, "a placement is found");
      const byKey = new Map(planes.map((plane) => [plane.key, plane] as const));
      const start = byKey.get(placement.face.faceKey)!;
      equal(start.normal.map((value) => Math.round(value)).join(","), "0,0,1", "it starts on the top face");
      const sides = placement.from.map((entry) => ({ normal: byKey.get(entry.faceKey)!.normal.map((value) => Math.round(value)).join(","), distance: entry.distanceMm }));
      equal(sides[0]!.normal, "0,1,0", "the nearest side is the back face (y = 20)");
      near(sides[0]!.distance, 15, 1e-6, "the hole is 15 mm inside it");
      equal(sides[1]!.normal, "1,0,0", "the next, not parallel to the first, is the right face (x = 30)");
      near(sides[1]!.distance, 20, 1e-6, "20 mm inside it");
      assert(holePlacementFor(body, [10, 5, 7], [0, 0, 1]) === undefined, "a point that is not on a face is not placed");
      assert(holePlacementFor({ positionsMm: body.positionsMm, indices: body.indices }, HOLE_AT, [0, 0, 1]) === undefined, "a body with no named faces keeps the plain point");
      const resolved = resolveHolePlacement(placement, body);
      assert(resolved.ok, "it resolves on the same body");
      if (resolved.ok) { near(resolved.pointMm[0], 10, 1e-6, "x"); near(resolved.pointMm[1], 5, 1e-6, "y"); near(resolved.pointMm[2], 20, 1e-6, "z"); }
    }
  },
  {
    name: "A placed hole moves with its faces: the plate grows to 90 x 60 and the bore is still 20 mm from the right face and 15 mm from the back face",
    run: async () => {
      const { project, sketch } = await block();
      const placement = holePlacementFor(bodyOf(project), HOLE_AT, [0, 0, 1])!;
      const holed = await withHole(project, holeStep(sketch, placement));
      assert(designOf(holed).features.every((feature) => feature.health === undefined), "no step is flagged");
      near(volumeOf(bodyOf(holed)), 60 * 40 * 20 - Math.PI * 9 * 20, 60 * 40 * 20 * 0.01, "the bore is cut");
      const before = wallCentre(bodyOf(holed));
      near(before[0], 10, 0.5, "the bore is at x = 10"); near(before[1], 5, 0.5, "and y = 5");
      const grown = await replayed(resize(holed, 90, 60));
      assert(designOf(grown).features.every((feature) => feature.health === undefined), "nothing is flagged after the edit");
      const after = wallCentre(bodyOf(grown));
      near(after[0], 45 - 20, 0.5, "the bore followed the right face to x = 25");
      near(after[1], 30 - 15, 0.5, "and the back face to y = 15");
      near(volumeOf(bodyOf(grown)), 90 * 60 * 20 - Math.PI * 9 * 20, 90 * 60 * 20 * 0.005, "still a 6 mm bore through the bigger plate");
      // A hole picked as a bare point stays where it was put.
      const bare = await replayed(resize(await withHole(project, holeStep(sketch, undefined)), 90, 60));
      const stays = wallCentre(bodyOf(bare));
      near(stays[0], 10, 0.5, "without a placement the hole stays at x = 10"); near(stays[1], 5, 0.5, "and y = 5");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(grown))).ok, "a project with a placed hole saves and loads");
    }
  },
  {
    name: "The two distances are numbers of the step: a parameter drives one of them, and the edit fields show them instead of coordinates",
    run: async () => {
      const { project, sketch } = await block();
      const placement = holePlacementFor(bodyOf(project), HOLE_AT, [0, 0, 1])!;
      let holed = await withHole(project, holeStep(sketch, placement));
      const step = stepOf(holed);
      assert(bindableFieldsOf(step).some((field) => field.id === "offsetA") && bindableFieldsOf(step).some((field) => field.id === "offsetB"), "both distances can be driven by expressions");
      assert(!bindableFieldsOf({ ...step, holePlacement: undefined as never }).some((field) => field.id === "offsetA"), "a hole with no placement has no such numbers");
      const ids = (parameterFieldsOf(step) ?? []).map((field) => field.id);
      assert(ids.includes("offsetA") && ids.includes("offsetB") && !ids.includes("position"), `the edit fields: ${ids.join(", ")}`);
      assert((parameterFieldsOf(holeStep(sketch, undefined)) ?? []).some((field) => field.id === "position"), "a bare hole keeps its coordinates");
      holed = run(holed, { kind: "set-design-parameters", parameters: [{ name: "inset", expression: "15", unit: "mm", comment: "" }] });
      const bound = bindFeatureExpressions(holed, stepOf(holed), { offsetA: "inset" });
      assert(bound.ok, `the distance binds: ${bound.ok ? "" : bound.message}`);
      if (!bound.ok) return;
      holed = run(holed, { kind: "update-design-solid", feature: bound.feature, body: bodyOf(holed) });
      holed = await replayed(holed);
      near(wallCentre(bodyOf(holed))[1], 20 - 15, 0.5, "the hole is 15 mm from the back face");
      holed = run(holed, { kind: "set-design-parameters", parameters: [{ name: "inset", expression: "8", unit: "mm", comment: "" }] });
      equal(stepOf(holed).holePlacement!.from[0].distanceMm, 8, "one parameter change moves the stored distance");
      holed = await replayed(holed);
      near(wallCentre(bodyOf(holed))[1], 20 - 8, 0.5, "and the rebuilt hole is 8 mm from the back face");
    }
  },
  {
    name: "When the faces a hole was placed from are gone it stays at its last place and the step says so in a note; the saved shape of a placement is checked",
    run: async () => {
      const { project, sketch } = await block();
      const placement = holePlacementFor(bodyOf(project), HOLE_AT, [0, 0, 1])!;
      const lost: HolePlacement = { ...placement, from: [{ faceKey: "face:gone", faceRole: "role.gone", distanceMm: 15 }, placement.from[1]] };
      const holed = await withHole(project, holeStep(sketch, lost));
      const hole = stepOf(holed);
      assert(hole.health !== undefined && isHealthNote(hole.health.message) && hole.health.message.includes("gone"), `a note says the faces are gone: ${hole.health?.message}`);
      const centre = wallCentre(bodyOf(holed));
      near(centre[0], 10, 0.5, "the hole is still cut at its last x"); near(centre[1], 5, 0.5, "and y");
      near(volumeOf(bodyOf(holed)), 60 * 40 * 20 - Math.PI * 9 * 20, 60 * 40 * 20 * 0.01, "the solid is as if it were a plain point");
      const spec = holeSpecOf(hole, bodyOf(holed));
      assert(spec !== undefined && spec.originMm[0] === 10, "the stored point is the fallback");
      // The payload checks.
      const good = holeStep(sketch, placement);
      assert(validSolidFeaturePayload(good), "a placement of three different faces validates");
      assert(!validSolidFeaturePayload(holeStep(sketch, { ...placement, from: [placement.from[0], { ...placement.from[0] }] })), "the same face twice is refused");
      assert(!validSolidFeaturePayload(holeStep(sketch, { ...placement, from: [{ ...placement.from[0], distanceMm: -1 }, placement.from[1]] })), "a negative distance is refused");
      assert(!validSolidFeaturePayload({ ...good, kind: "extrude", holeStyle: undefined } as never), "a placement on a step that is not a hole is refused");
    }
  },
  {
    name: "Edit Feature keeps the faces of a hole left where it is and drops them when a new point is picked, so a new pick is never put back",
    run: async () => {
      const { project, sketch } = await block();
      const placement = holePlacementFor(bodyOf(project), HOLE_AT, [0, 0, 1])!;
      const step = holeStep(sketch, placement);
      const state = openCommandPanelForEdit(step, "Body 1")!;
      const kept = panelDraft(state, { sketchFeatureId: sketch.id, existing: step });
      assert(kept.ok && kept.feature.holePlacement !== undefined, "an edit that leaves the point alone keeps its faces");
      const moved = panelDraft({ ...state, holePoint: { pointMm: [-10, -5, 20], normal: [0, 0, 1] } }, { sketchFeatureId: sketch.id, existing: step });
      assert(moved.ok && moved.feature.holePlacement === undefined && moved.feature.holePositionMm?.[0] === -10, "a new point drops the old faces");
      assert(state.values["offsetA"] === "15" && state.values["offsetB"] === "20", `the panel opens filled with the two distances: ${JSON.stringify(state.values)}`);
    }
  },
];
