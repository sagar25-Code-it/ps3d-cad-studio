import type { DesignSketchFeature, DesignSolidFeature, EdgeBlendGroup, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { describePickedEdge, nearestPickableEdge, pickableEdges } from "../packages/workbench-geometry/src/index.js";
import { applyParameterValues, parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { blendBodyEdges, facesOfBody, parseBlendSizes } from "../apps/studio-web/src/edge-blend-step.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-blend-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const BODY = "general-body:block";
const CORNER = 1 - Math.PI / 4;
const rectangle = (width: number, height: number): SketchEntity => ({ id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const lShape: readonly SketchEntity[] = [
  [[0, 0], [40, 0]], [[40, 0], [40, 10]], [[40, 10], [10, 10]], [[10, 10], [10, 30]], [[10, 30], [0, 30]], [[0, 30], [0, 0]]
].map(([start, end], index): SketchEntity => ({ id: `entity:l-${index}`, kind: "line", start: start as [number, number], end: end as [number, number], construction: false }));

const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;

/** A project whose first step is an extrusion of `entities` by `height`, built through the real operations. */
async function projectWith(entities: readonly SketchEntity[], height: number): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature; extrude: DesignSolidFeature }> {
  let project = createWorkbenchProject("project:test-edge-blend");
  project = { ...project, sketch: { ...project.sketch, entities: [...entities], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: height, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, `the block builds: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  return { project, sketch, extrude };
}

/** The edge run nearest a point on the body as it stands, remembered the way the Fillet command remembers it. */
function pickedGroup(project: WorkbenchProject, point: readonly [number, number, number], includeConcave = false): EdgeBlendGroup {
  const body = bodyOf(project);
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices }, 5, { includeConcave });
  assert(typeof edges !== "string", typeof edges === "string" ? edges : "");
  if (typeof edges === "string") throw new Error("unreachable");
  const near = nearestPickableEdge(edges, point);
  assert(near !== undefined, "an edge is there to pick");
  return describePickedEdge(near!.chain, facesOfBody(body)) as EdgeBlendGroup;
}

const blendStep = (sketch: DesignSketchFeature, id: string, groups: readonly EdgeBlendGroup[], extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: `Fillet R 3 mm`, kind: "edge-blend", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 3, bodyId: BODY, operation: "direct-edit", blendType: "fillet", blendEdges: groups, ...extra });

async function addAndReplay(project: WorkbenchProject, feature: DesignSolidFeature): Promise<WorkbenchProject> {
  const added = run(project, { kind: "add-design-solid", feature, body: bodyOf(project) });
  const results = await replayAllBodies(added);
  const failed = results.find((result) => result.featureId === feature.id && result.message !== undefined);
  assert(failed === undefined, `the ${feature.id} step replays: ${failed?.message ?? ""}`);
  return run(added, { kind: "regenerate-design", results });
}

const replay = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });

export const edgeBlendStepTests: readonly TestCase[] = [
  {
    name: "A fillet step made through the operations replays on the real block, removes the corner volume, keeps the block's faces and round-trips the project",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      near(solid, 60 * 40 * 20, 60 * 40 * 20 * 0.001, "the block is 60 × 40 × 20");
      const group = pickedGroup(base, [0, -20, 20]);
      assert(group.faceKeys !== undefined && group.faceKeys[0] !== group.faceKeys[1], "the pick remembers the two faces beside the edge");
      const step = blendStep(sketch, "fillet-1", [group]);
      const project = await addAndReplay(base, step);
      const body = bodyOf(project);
      assert(isClosedAndOriented(body.indices) && solidMetrics(body.positionsMm, body.indices).outward, "the filleted block is closed and outward");
      const expected = 9 * CORNER * 60;
      near(solid - volumeOf(body), expected, expected * 0.03, "R3 on the 60 mm edge removes (1 - π/4)·9·60");
      assert(body.brep !== undefined && body.brep.faces.length === bodyOf(base).brep!.faces.length + 1, "the block keeps its faces and gains the fillet face");
      assert(body.brep!.faceTriangles.length * 3 === body.indices.length, "every triangle still names its face");
      assert(designOf(project).features.every((feature) => feature.health === undefined), "no step is flagged");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project))).ok, "the project with the blend step validates after a save and load");
      const features = designOf(project).features;
      assert(features[features.length - 1]!.kind === "edge-blend", "the step is on the timeline");
    }
  },
  {
    name: "Editing the base sketch and replaying fillets the same physical edge: found by its faces after it moves, and by position only while it stays close",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const group = pickedGroup(base, [0, -20, 20]);
      const keyed = await addAndReplay(base, blendStep(sketch, "fillet-keyed", [group]));
      const unkeyed = await addAndReplay(base, blendStep(sketch, "fillet-bare", [{ segments: group.segments }]));
      near(volumeOf(bodyOf(unkeyed)), volumeOf(bodyOf(keyed)), 1e-6, "with or without face keys the same edge is filleted");

      // Widen the plate: the edge gets longer but stays where it was across.
      const widen = (project: WorkbenchProject, width: number, height: number): WorkbenchProject => {
        let next = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
        next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: width });
        next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: height });
        return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      };
      for (const [label, project] of [["keyed", keyed], ["bare", unkeyed]] as const) {
        const wide = await replay(widen(project, 90, 40));
        const body = bodyOf(wide);
        assert(designOf(wide).features.every((feature) => feature.health === undefined), `${label}: no step is flagged after the sketch edit`);
        near(volumeOf(body), 90 * 40 * 20 - 9 * CORNER * 90, (90 * 40 * 20) * 0.003, `${label}: the 90 mm edge is the one rounded`);
        assert(isClosedAndOriented(body.indices) && solidMetrics(body.positionsMm, body.indices).outward, `${label}: closed and outward after the edit`);
      }

      // Make the plate deeper: the front edge moves 10 mm away. The faces still meet along it; a bare position cannot follow it.
      const deep = widen(keyed, 60, 60);
      const deepBase = await replay(widen(base, 60, 60));
      const direct = await blendBodyEdges(blendStep(sketch, "fillet-direct", [group]), bodyOf(deepBase));
      assert(direct.ok && /by its faces/.test(direct.notes[0] ?? "") && /\(1\d\.\d\d mm from/.test(direct.notes[0] ?? ""), `the edge 10 mm away was found by its faces: ${direct.ok ? direct.notes[0] : direct.message}`);
      const keyedDeep = await replay(deep);
      near(volumeOf(bodyOf(keyedDeep)), 60 * 60 * 20 - 9 * CORNER * 60, 60 * 60 * 20 * 0.003, "keyed: the edge that moved 10 mm is still the one rounded");
      assert(designOf(keyedDeep).features.every((feature) => feature.health === undefined), "keyed: nothing is flagged");
      const bareDeep = await replay(widen(unkeyed, 60, 60));
      const flagged = designOf(bareDeep).features.find((feature) => feature.kind === "edge-blend");
      assert(flagged?.health !== undefined && /no longer exists/.test(flagged.health.message), `bare: the step is flagged with a reason: ${JSON.stringify(flagged?.health)}`);
      near(volumeOf(bodyOf(bareDeep)), 60 * 60 * 20, 60 * 60 * 20 * 0.001, "bare: nothing else is treated in its place");
    }
  },
  {
    name: "Suppress, roll back and delete take a blend step in and out of the shape, and a second blend step is found through the faces of the first",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      const first = blendStep(sketch, "fillet-a", [pickedGroup(base, [0, -20, 20])]);
      const afterFirst = await addAndReplay(base, first);
      const withFirst = volumeOf(bodyOf(afterFirst));
      assert(withFirst < solid - 100, "the first blend removed material");

      // The second blend is picked on the body as the first left it: an edge the first blend's face touches.
      const second = blendStep(sketch, "chamfer-b", [pickedGroup(afterFirst, [0, 20, 20])], { name: "Chamfer 4 mm", blendType: "chamfer", valueMm: 4 });
      const both = await addAndReplay(afterFirst, second);
      near(volumeOf(bodyOf(both)), withFirst - 8 * 60, 1.5, "the 4 mm chamfer on the back-top edge removes 8 mm² along 60 mm");

      const off = run(both, { kind: "set-design-feature-suppressed", featureId: first.id, suppressed: true });
      const withoutFirst = await replay(off);
      near(volumeOf(bodyOf(withoutFirst)), solid - 8 * 60, 1.5, "suppressing the first leaves only the chamfer");
      const none = await replay(run(off, { kind: "set-design-feature-suppressed", featureId: second.id, suppressed: true }));
      near(volumeOf(bodyOf(none)), solid, solid * 1e-6, "suppressing both leaves the block whole");
      const back = await replay(run(none, { kind: "set-design-feature-suppressed", featureId: first.id, suppressed: false }));
      near(volumeOf(bodyOf(back)), withFirst, withFirst * 1e-6, "unsuppressing the first brings back the same fillet");

      const rolled = await replay(run(both, { kind: "set-design-rollback", index: designOf(both).features.indexOf(designOf(both).features.find((feature) => feature.id === second.id)!) }));
      near(volumeOf(bodyOf(rolled)), withFirst, withFirst * 1e-6, "rolling back to before the second step shows only the first");

      const deleted = await replay(run(both, { kind: "delete-design-feature", featureId: first.id }));
      assert(designOf(deleted).features.every((feature) => feature.id !== first.id), "the deleted step is gone from the timeline");
      near(volumeOf(bodyOf(deleted)), solid - 8 * 60, 1.5, "deleting the first leaves the chamfer, still found on its edge");
      assert(designOf(deleted).features.every((feature) => feature.health === undefined), "nothing is flagged after the delete");
    }
  },
  {
    name: "Chamfer steps: two distances and distance + angle on the real block, and the first-face side can be flipped",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      const group = pickedGroup(base, [0, -20, 20]);
      const two = await addAndReplay(base, blendStep(sketch, "c-two", [group], { name: "Chamfer 5 × 2 mm", blendType: "chamfer", valueMm: 5, blendSecondSizeMm: 2 }));
      near(solid - volumeOf(bodyOf(two)), 5 * 2 / 2 * 60, 0.6, "5 × 2");
      const flipped = await addAndReplay(base, blendStep(sketch, "c-flip", [group], { name: "Chamfer 5 × 2 mm", blendType: "chamfer", valueMm: 5, blendSecondSizeMm: 2, blendFlip: true }));
      near(solid - volumeOf(bodyOf(flipped)), 5 * 60, 0.6, "flipped: 5 down the side and 2 along the top removes the same 5 mm² along 60 mm");
      const reaches = (project: WorkbenchProject): readonly [number, number] => {
        const body = bodyOf(project);
        let topReach = 0; let sideReach = 0;
        for (let i = 0; i < body.positionsMm.length; i += 3) {
          if (Math.abs(body.positionsMm[i + 2]! - 20) < 1e-6 && body.positionsMm[i + 1]! > -20 + 1e-6 && body.positionsMm[i + 1]! < 0) topReach = Math.max(topReach, body.positionsMm[i + 1]! + 20);
          if (Math.abs(body.positionsMm[i + 1]! + 20) < 1e-6 && body.positionsMm[i + 2]! < 20 - 1e-6 && body.positionsMm[i + 2]! > 5) sideReach = Math.max(sideReach, 20 - body.positionsMm[i + 2]!);
        }
        return [topReach, sideReach];
      };
      const [topA, sideA] = reaches(two);
      near(topA, 5, 1e-6, "5 mm along the top face"); near(sideA, 2, 1e-6, "2 mm down the front face");
      const [topB, sideB] = reaches(flipped);
      near(topB, 2, 1e-6, "flipped: 2 mm along the top"); near(sideB, 5, 1e-6, "flipped: 5 mm down the front");
      const angled = await addAndReplay(base, blendStep(sketch, "c-angle", [group], { name: "Chamfer 4 mm at 30°", blendType: "chamfer", valueMm: 4, blendAngleDeg: 30 }));
      near(solid - volumeOf(bodyOf(angled)), 4 * (4 * Math.tan(Math.PI / 6)) / 2 * 60, 0.6, "4 mm at 30°");
      assert(isClosedAndOriented(bodyOf(angled).indices), "the angled chamfer is closed");
    }
  },
  {
    name: "A variable-radius fillet step spreads its radius along the picked run, and a closed loop is refused for it with a reason",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const solid = volumeOf(bodyOf(base));
      const group = pickedGroup(base, [-30, 0, 20]); // the 40 mm edge along the top left, running in y
      const start = group.segments[0]![0];
      const variable = await addAndReplay(base, blendStep(sketch, "fillet-var", [group], { name: "Fillet R 1 → 4 mm", valueMm: 1, blendEndSizeMm: 4 }));
      const body = bodyOf(variable);
      assert(isClosedAndOriented(body.indices) && solidMetrics(body.positionsMm, body.indices).outward, "closed and outward");
      near(solid - volumeOf(body), CORNER * 40 * (1 + 4 + 16) / 3, CORNER * 40 * 7 * 0.03, "removed volume follows r0² + r0·r1 + r1²");
      // The radius is r0 at the end the run was picked from.
      let reachAtStart = Infinity;
      for (let i = 0; i < body.positionsMm.length; i += 3) if (Math.abs(body.positionsMm[i + 1]! - start[1]) < 1e-6 && Math.abs(body.positionsMm[i + 2]! - 20) < 1e-6) reachAtStart = Math.min(reachAtStart, Math.abs(body.positionsMm[i]! + 30));
      near(reachAtStart, 1, 0.02, "radius 1 at the end the run starts from");

      const rimProject = await projectWith([{ id: "entity:disc", kind: "circle", center: [0, 0], radiusMm: 15, construction: false }], 10);
      const rimGroup = pickedGroup(rimProject.project, [15, 0, 10]);
      const loop = blendStep(rimProject.sketch, "fillet-loop", [rimGroup], { name: "Fillet R 1 → 2 mm", valueMm: 1, blendEndSizeMm: 2 });
      const refused = await blendBodyEdges(loop, bodyOf(rimProject.project));
      assert(!refused.ok && /closed loop/.test(refused.message), `a closed loop cannot take a variable radius: ${refused.ok ? "" : refused.message}`);
      const constant = await blendBodyEdges({ ...loop, blendEndSizeMm: undefined as never }, bodyOf(rimProject.project));
      assert(constant.ok, `the same loop takes a constant fillet: ${constant.ok ? "" : constant.message}`);
    }
  },
  {
    name: "An inside corner is filled by a replayed fillet or chamfer step, and removing the step restores the sharp corner",
    run: async () => {
      const { project: base, sketch } = await projectWith(lShape, 20);
      const solid = volumeOf(bodyOf(base));
      near(solid, (40 * 10 + 10 * 20) * 20, solid * 0.001, "the bracket is an L, 20 mm tall");
      const inside = pickedGroup(base, [10, 10, 10], true);
      assert(inside.concave === true, "the picked edge is an inside corner");
      const filled = await addAndReplay(base, blendStep(sketch, "fill-inside", [inside], { name: "Fillet R 3 mm", valueMm: 3 }));
      const body = bodyOf(filled);
      assert(isClosedAndOriented(body.indices) && solidMetrics(body.positionsMm, body.indices).outward, "closed and outward");
      near(volumeOf(body) - solid, 9 * CORNER * 20, 9 * CORNER * 20 * 0.03, "the inside fillet adds (1 - π/4)·9·20");
      const chamfered = await addAndReplay(base, blendStep(sketch, "chamfer-inside", [inside], { name: "Chamfer 4 mm", blendType: "chamfer", valueMm: 4 }));
      near(volumeOf(bodyOf(chamfered)) - solid, 8 * 20, 0.6, "the inside chamfer adds 8 mm² along 20 mm");
      const removed = await replay(run(filled, { kind: "delete-design-feature", featureId: "feature:fill-inside" }));
      near(volumeOf(bodyOf(removed)), solid, solid * 1e-6, "deleting the step restores the sharp corner");
      // A convex fillet picked at an outside corner of the same bracket is not an inside one.
      const outside = pickedGroup(base, [40, 0, 10]);
      assert(outside.concave !== true, "an outside edge is not marked inside");
    }
  },
  {
    name: "The edge-blend step is validated like every other step: bad payloads are refused, the dialog edits it, and a replay with no edges reports why",
    run: async () => {
      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const group = pickedGroup(base, [0, -20, 20]);
      const step = blendStep(sketch, "fillet-v", [group]);
      assert(validSolidFeaturePayload(step), "a well-formed step is accepted");
      assert(!validSolidFeaturePayload({ ...step, blendEdges: [] }), "no edges is refused");
      assert(!validSolidFeaturePayload({ ...step, blendEdges: undefined as never }), "missing edges is refused");
      assert(!validSolidFeaturePayload({ ...step, operation: "cut" }), "a blend must be a direct edit");
      assert(!validSolidFeaturePayload({ ...step, blendType: "round" as never }), "an unknown blend type is refused");
      assert(!validSolidFeaturePayload({ ...step, blendSecondSizeMm: 2 }), "a second distance on a fillet is refused");
      assert(!validSolidFeaturePayload({ ...step, blendType: "chamfer", blendEndSizeMm: 2 }), "an end radius on a chamfer is refused");
      assert(!validSolidFeaturePayload({ ...step, blendType: "chamfer", blendSecondSizeMm: 2, blendAngleDeg: 30 }), "a second distance and an angle together are refused");
      assert(!validSolidFeaturePayload({ ...step, blendType: "chamfer", blendAngleDeg: 180 }), "a 180° chamfer angle is refused");
      assert(!validSolidFeaturePayload({ ...step, blendEdges: [{ segments: [[[0, 0, 0], [1, 1]]] }] as never }), "a segment with a short point is refused");
      assert(!validSolidFeaturePayload({ ...step, blendEdges: [{ ...group, faceKeys: ["only-one"] }] as never }), "a single face key is refused");
      assert(!validSolidFeaturePayload({ ...step, kind: "hole", holeStyle: "simple" }), "blend fields on another kind are refused");
      assert(!validSolidFeaturePayload({ ...step, valueMm: -3 }), "a negative radius is refused");

      const refused = applyWorkbenchOperation(base, { kind: "add-design-solid", feature: { ...step, blendEdges: [] }, body: bodyOf(base), operationId: "operation:test-blend-bad", expectedRevision: base.revision });
      assert(!refused.ok, "the operation layer refuses a blend with no edges");

      const fields = parameterFieldsOf(step)!;
      assert(fields.map((field) => field.id).join() === "size,endSize", `a fillet lists radius and end radius: ${fields.map((field) => field.id).join()}`);
      const edited = applyParameterValues(step, { size: "2", endSize: "0" });
      assert(edited.ok && edited.feature.valueMm === 2 && edited.feature.blendEndSizeMm === undefined && edited.feature.name === "Fillet R 2 mm", `dialog edit: ${edited.ok ? edited.feature.name : edited.message}`);
      const varied = applyParameterValues(step, { size: "2", endSize: "5" });
      assert(varied.ok && varied.feature.blendEndSizeMm === 5 && varied.feature.name === "Fillet R 2 → 5 mm", "an end radius is stored and named");
      assert(!applyParameterValues(step, { size: "0", endSize: "0" }).ok, "a zero radius is refused");
      const chamfer = { ...step, blendType: "chamfer" as const, name: "Chamfer 3 mm" };
      assert(parameterFieldsOf(chamfer)!.map((field) => field.id).join() === "size,second,angle,side", "a chamfer lists distances, angle and side");
      const angled = applyParameterValues(chamfer, { size: "4", second: "2", angle: "30", side: "flipped" });
      assert(angled.ok && angled.feature.blendAngleDeg === 30 && angled.feature.blendSecondSizeMm === undefined && angled.feature.blendFlip === true && angled.feature.name === "Chamfer 4 mm at 30°", `an angle replaces the second distance: ${angled.ok ? angled.feature.name : angled.message}`);

      // Edit the radius through the dialog and replay: the geometry follows.
      const added = await addAndReplay(base, step);
      const smaller = run(added, { kind: "update-design-solid", feature: edited.ok ? edited.feature : step, body: bodyOf(added) });
      const replayed = await replay(smaller);
      near(volumeOf(bodyOf(base)) - volumeOf(bodyOf(replayed)), 4 * CORNER * 60, 4 * CORNER * 60 * 0.04, "the edited R2 fillet replays at R2");

      // A step whose edges are not on the body at all is reported, never applied to something else.
      const lost = await blendBodyEdges({ ...step, blendEdges: [{ segments: [[[500, 500, 500], [510, 500, 500]]] }] }, bodyOf(base));
      assert(!lost.ok && /no longer exists/.test(lost.message), `a lost edge is reported: ${lost.ok ? "" : lost.message}`);
    }
  }
,
  {
    name: "The size typed into the Fillet and Chamfer prompts is read as a radius, a changing radius, two distances or a distance and an angle, and a size too big for the faces is reported by the replay",
    run: async () => {
      const read = (type: "fillet" | "chamfer", text: string): string => { const sizes = parseBlendSizes(type, text); return sizes.ok ? JSON.stringify(sizes) : "refused"; };
      assert(read("fillet", "2") === '{"ok":true,"valueMm":2}', "a plain radius");
      assert(read("fillet", " 2.5 mm ") === '{"ok":true,"valueMm":2.5}', "units and spaces are ignored");
      assert(read("fillet", "1-4") === '{"ok":true,"valueMm":1,"endSizeMm":4}', "a radius that changes along the edge");
      assert(read("fillet", "3 to 3") === '{"ok":true,"valueMm":3}', "the same radius at both ends is a constant fillet");
      assert(read("chamfer", "3") === '{"ok":true,"valueMm":3}', "a plain distance");
      assert(read("chamfer", "5x2") === '{"ok":true,"valueMm":5,"secondSizeMm":2}', "two distances");
      assert(read("chamfer", "4 @ 30°") === '{"ok":true,"valueMm":4,"angleDeg":30}', "a distance and an angle");
      for (const [type, text] of [["fillet", "0"], ["fillet", "-2"], ["fillet", "5x2"], ["fillet", "abc"], ["chamfer", "1-4"], ["chamfer", "4@0"], ["chamfer", "4@180"], ["chamfer", "0x3"], ["chamfer", ""]] as const) assert(read(type, text) === "refused", `${type} "${text}" is refused`);

      const { project: base, sketch } = await projectWith([rectangle(60, 40)], 20);
      const group = pickedGroup(base, [0, -20, 20]);
      const added = run(base, { kind: "add-design-solid", feature: blendStep(sketch, "fillet-huge", [group], { valueMm: 45, name: "Fillet R 45 mm" }), body: bodyOf(base) });
      const results = await replayAllBodies(added);
      const huge = results.find((result) => result.featureId === "feature:fillet-huge");
      assert(huge?.message !== undefined && /reaches past the face/.test(huge.message), `an R45 fillet on a 40 mm block is refused with a reason: ${huge?.message}`);
      const applied = run(added, { kind: "regenerate-design", results });
      near(volumeOf(bodyOf(applied)), 60 * 40 * 20, 60 * 40 * 20 * 1e-6, "the block is left whole, not cut about");
      assert(designOf(applied).features.find((feature) => feature.id === "feature:fillet-huge")?.health !== undefined, "the step is flagged");
    }
  }
];
