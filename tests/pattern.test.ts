import type { DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  applyWorkbenchOperation, baseFeatureOf, createWorkbenchProject, dependentsOf, describeFeature, designOf, isFeatureActive, modifiesBody,
  validateWorkbenchProject, validPatternDefinition, validSolidFeaturePayload
} from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import {
  invertAffine, patternTransforms, reflectionAffine, rotationAffine, summarizePattern, transformIndices, transformMesh, transformPoint
} from "../packages/workbench-geometry/src/index.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { replayAllBodies, replayBody, isRebuildFailure } from "../apps/studio-web/src/design-regeneration.js";
import { addPattern, editPattern, patternGroups, patternableFeatures, previewPattern, requestOfGroup, type PatternRequest } from "../apps/studio-web/src/pattern-commit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { formOfRequest, requestOfForm } from "../apps/studio-web/src/pattern-form.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-pattern-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

/** The default plate sketch is 60 x 40 mm with a 10 mm bore through its centre. */
const PLATE = "general-body:plate";
const PLATE_VOLUME = 60 * 40 * 10 - Math.PI * 5 ** 2 * 10;
const extrudeStep: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: PLATE };

async function plateProject(): Promise<WorkbenchProject> {
  let project = run(createWorkbenchProject("project:test-pattern"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const staged = { ...project, design: { ...designOf(project), features: [...designOf(project).features, extrudeStep], rollbackIndex: 2 } };
  const first = (await replayBody(staged, PLATE)).find((result) => result.body !== undefined);
  assert(first?.body !== undefined, "the plate builds");
  project = run(project, { kind: "add-design-solid", feature: extrudeStep, body: first.body });
  return project;
}

const moveStep = (id: string, delta: readonly [number, number, number]): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: `Move ${id}`, kind: "move-body", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: Math.max(0.01, Math.hypot(...delta)), bodyId: PLATE, operation: "direct-edit", moveDeltaMm: delta });

async function plateMoved(delta: readonly [number, number, number]): Promise<WorkbenchProject> {
  const project = await plateProject();
  const step = moveStep("shift", delta);
  const added = run(project, { kind: "add-design-solid", feature: step, body: project.part.generalBodies!.find((body) => body.id === PLATE)! });
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

/** Vertices that share a position are welded first, because extruded meshes keep a vertex per face; then every edge must be used once each way. */
function closed(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): boolean {
  const ids = new Map<string, number>();
  const welded = new Array<number>(mesh.positionsMm.length / 3);
  for (let vertex = 0; vertex < welded.length; vertex += 1) {
    const key = [0, 1, 2].map((axis) => Math.round(mesh.positionsMm[vertex * 3 + axis]! * 1e5)).join(",");
    if (!ids.has(key)) ids.set(key, ids.size);
    welded[vertex] = ids.get(key)!;
  }
  const indices = mesh.indices.map((index) => welded[index]!);
  // Drop triangles that collapsed in the weld, as the Boolean's own clean-up does.
  const kept: number[] = [];
  for (let corner = 0; corner + 2 < indices.length; corner += 3) if (indices[corner] !== indices[corner + 1] && indices[corner + 1] !== indices[corner + 2] && indices[corner] !== indices[corner + 2]) kept.push(indices[corner]!, indices[corner + 1]!, indices[corner + 2]!);
  return isClosedAndOriented(kept);
}

const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => {
  const body = project.part.generalBodies?.find((candidate) => candidate.id === id);
  assert(body !== undefined, `body ${id} exists`);
  return body;
};
const metricsOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }) => solidMetrics(body.positionsMm, body.indices);
const patternSteps = (project: WorkbenchProject): readonly DesignSolidFeature[] => designOf(project).features.filter((feature): feature is DesignSolidFeature => feature.kind === "pattern");

const rect = (extra: Partial<Extract<PatternRequest["shape"], { type: "rectangular" }>> = {}): PatternRequest["shape"] =>
  ({ type: "rectangular", countA: 3, spacingAMm: 80, directionA: [1, 0, 0], countB: 1, spacingBMm: 0, directionB: [0, 1, 0], sizing: "spacing", ...extra });

async function addOk(project: WorkbenchProject, request: PatternRequest): Promise<WorkbenchProject> {
  const added = await addPattern(project, request);
  assert(added.ok, `the pattern is added: ${added.ok ? "" : added.message}`);

  return added.project;
}

/** A second sketch holding one circle, in the same plane as the plate, for a cut to follow. */
function withCutSketch(project: WorkbenchProject, center: readonly [number, number]): WorkbenchProject {
  let next = run(project, { kind: "new-design-sketch", plane: "datum:xy" });
  const circle: SketchEntity = { id: "entity:pocket", kind: "circle", center: [center[0], center[1]], radiusMm: 4, construction: false };
  next = run(next, { kind: "add-sketch-entity", entity: circle });
  return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
}

export const patternTests: readonly TestCase[] = [
  {
    name: "pattern layouts: rectangular spacing and extent, circular full and partial, mirror, and refused layouts",
    run: () => {
      const linear = patternTransforms(rect({ countA: 4, spacingAMm: 25 }));
      assert(linear.ok, "linear layout");
      if (!linear.ok) return;
      equal(linear.transforms.length, 3, "four instances make three copies");
      equal(transformPoint(linear.transforms[2]!, [1, 2, 3]).join(","), "76,2,3", "the third copy sits 75 mm along X");
      const grid = patternTransforms(rect({ countA: 3, countB: 2, spacingAMm: 10, spacingBMm: 20, directionB: [0, 1, 0] }));
      assert(grid.ok, "grid layout");
      if (!grid.ok) return;
      equal(grid.transforms.length, 5, "3 x 2 makes five copies");
      equal(transformPoint(grid.transforms[4]!, [0, 0, 0]).join(","), "20,20,0", "the last copy is two steps along A and one along B");
      const extent = patternTransforms(rect({ countA: 5, spacingAMm: 100, sizing: "extent" }));
      assert(extent.ok, "extent layout");
      if (extent.ok) equal(transformPoint(extent.transforms[3]!, [0, 0, 0])[0], 100, "with an extent the last instance lands exactly 100 mm from the first");
      const oblique = patternTransforms(rect({ countA: 2, spacingAMm: 10, directionA: [3, 4, 0] }));
      assert(oblique.ok, "oblique layout");
      if (oblique.ok) equal(transformPoint(oblique.transforms[0]!, [0, 0, 0]).join(","), "6,8,0", "the direction is normalised before the spacing is applied");
      const full = patternTransforms({ type: "circular", count: 4, totalAngleDeg: 360, axis: { kind: "datum", axis: "z" } });
      assert(full.ok, "circular layout");
      if (full.ok) {
        equal(full.transforms.length, 3, "four around make three copies");
        equal(transformPoint(full.transforms[0]!, [10, 0, 0]).join(","), "0,10,0", "the first copy is a quarter turn round");
        equal(transformPoint(full.transforms[2]!, [10, 0, 0]).join(","), "0,-10,0", "the last copy is three quarter turns round");
      }
      const partial = patternTransforms({ type: "circular", count: 3, totalAngleDeg: 90, axis: { kind: "datum", axis: "z" } });
      if (partial.ok) {
        const end = transformPoint(partial.transforms[1]!, [10, 0, 0]);
        near(end[0], 0, 1e-9, "a partial circle puts the last instance at the total angle (x)");
        near(end[1], 10, 1e-9, "a partial circle puts the last instance at the total angle (y)");
      } else assert(false, "partial circular layout");
      const mirror = patternTransforms({ type: "mirror", plane: { kind: "datum", plane: "yz", offsetMm: 50 } });
      assert(mirror.ok && mirror.transforms.length === 1, "mirror layout");
      if (mirror.ok) equal(transformPoint(mirror.transforms[0]!, [70, 5, 6]).join(","), "30,5,6", "a point 20 mm past the plane x = 50 lands 20 mm before it");
      assert(!patternTransforms(rect({ countA: 2, countB: 2, directionB: [2, 0, 0] })).ok, "parallel directions are refused");
      assert(!patternTransforms({ type: "circular", count: 3, totalAngleDeg: 360, axis: { kind: "construction", axisId: "construction-axis:gone" } }).ok, "a missing construction axis is refused");
      assert(!patternTransforms({ type: "mirror", plane: { kind: "construction", planeId: "construction-plane:gone" } }).ok, "a missing construction plane is refused");
      const inverse = invertAffine(rotationAffine([5, 6, 7], [1, 1, 0], 0.7))!;
      const there = transformPoint(rotationAffine([5, 6, 7], [1, 1, 0], 0.7), [1, 2, 3]);
      const back = transformPoint(inverse, there);
      near(back[0], 1, 1e-6, "inverse x"); near(back[1], 2, 1e-6, "inverse y"); near(back[2], 3, 1e-6, "inverse z");
    }
  },
  {
    name: "mirroring reverses triangle winding: the mirrored block is closed and outward, and without the fix it would be inside out",
    run: () => {
      const mesh = tessellateExtrude([[0, 0], [40, 0], [40, 30], [0, 30]], 10, "xy");
      const block = { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
      assert(solidMetrics(block.positionsMm, block.indices).outward, "the source block winds outward");
      const reflection = reflectionAffine([0, 0, 0], [1, 0, 0]);
      const mirrored = transformMesh(block, reflection);
      assert(closed(mirrored), "the mirrored mesh is closed and consistently wound");
      const metrics = solidMetrics(mirrored.positionsMm, mirrored.indices);
      assert(metrics.outward, "the mirrored mesh winds outward");
      near(metrics.volumeMm3, 40 * 30 * 10, 1e-6, "the mirrored volume is unchanged");
      near(metrics.boundsMm.min[0], -40, 1e-9, "the mirror lands on the other side of the plane");
      near(metrics.centroidMm[0], -20, 1e-6, "its centroid is reflected");
      const unfixed = solidMetrics(mirrored.positionsMm, block.indices);
      assert(!unfixed.outward, "reflecting only the points leaves the faces pointing inward, which is what the winding fix prevents");
      assert(transformIndices(block.indices, rotationAffine([0, 0, 0], [0, 0, 1], 1)).join() === block.indices.join(), "a turn leaves the winding alone");
    }
  },
  {
    name: "a rectangular pattern as new bodies makes separate closed plates, each the source volume, laid out 80 mm apart",
    run: async () => {
      const project = await plateProject();
      const preview = previewPattern(project, { shape: rect(), result: "new-bodies", sourceBodyId: PLATE });
      assert(preview.ok && preview.copies === 2 && preview.instances === 3 && !preview.overlapping, `preview counts the copies: ${"text" in preview ? preview.text : preview.message}`);
      if (preview.ok) assert(preview.text.includes("3 instances") && preview.text.includes("220"), `the preview states the reach (160 + 60 = 220 mm): ${preview.text}`);
      const patterned = await addOk(project, { shape: rect(), result: "new-bodies", sourceBodyId: PLATE });
      const steps = patternSteps(patterned);
      equal(steps.length, 2, "two copy steps");
      assert(steps.every((step) => step.pattern?.result === "new-bodies" && step.operation === "new-body" && !modifiesBody(step)), "each copy step makes a body of its own");
      equal((patterned.part.generalBodies ?? []).length, 3, "the part now has three bodies");
      const bodies = steps.map((step) => bodyOf(patterned, step.bodyId));
      for (const [index, body] of bodies.entries()) {
        assert(closed(body), `copy ${index + 1} is closed and consistently wound`);
        const metrics = metricsOf(body);
        assert(metrics.outward, `copy ${index + 1} winds outward`);
        near(metrics.volumeMm3, PLATE_VOLUME, PLATE_VOLUME * 0.001, `copy ${index + 1} has the source volume`);
        near(metrics.centroidMm[0], 80 * (index + 1), 1e-6, `copy ${index + 1} sits ${80 * (index + 1)} mm along X`);
        assert(body.brep !== undefined && body.brep.faces.every((face) => face.key !== bodyOf(patterned, PLATE).brep?.faces.find((original) => original.role === face.role)?.key), `copy ${index + 1} has its own face keys`);
      }
      const all = [bodyOf(patterned, PLATE), ...bodies];
      near(all.reduce((sum, body) => sum + metricsOf(body).volumeMm3, 0), 3 * PLATE_VOLUME, PLATE_VOLUME * 0.003, "three copies of a block that do not overlap add up to three times its volume");
      near(Math.max(...all.map((body) => metricsOf(body).boundsMm.max[0])) - Math.min(...all.map((body) => metricsOf(body).boundsMm.min[0])), 220, 1e-6, "the pattern reaches 220 mm");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(patterned))).ok, "the patterned project passes validation after a save and load");
      assert(describeFeature(designOf(patterned), steps[0]!).includes("3 rectangular"), `the timeline describes it: ${describeFeature(designOf(patterned), steps[0]!)}`);
    }
  },
  {
    name: "a two-direction pattern with an overall extent lays out a grid of closed plates",
    run: async () => {
      const project = await plateProject();
      const grid = rect({ countA: 3, spacingAMm: 160, sizing: "extent", countB: 2, spacingBMm: 70, directionB: [0, 1, 0] });
      const patterned = await addOk(project, { shape: grid, result: "new-bodies", sourceBodyId: PLATE });
      const bodies = patternSteps(patterned).map((step) => bodyOf(patterned, step.bodyId));
      equal(bodies.length, 5, "3 x 2 makes five new bodies");
      const centroids = bodies.map((body) => metricsOf(body).centroidMm.slice(0, 2).map((value) => Math.round(value)).join(","));
      equal(centroids.join(" | "), "80,0 | 160,0 | 0,70 | 80,70 | 160,70", "extent 160 over three instances is 80 mm spacing; the second row is 70 mm up");
      assert(bodies.every((body) => closed(body) && metricsOf(body).outward), "every plate of the grid is closed and outward");
    }
  },
  {
    name: "a circular pattern keeps the layout symmetric: bounding box and centroid are balanced about the axis, and a partial angle stops short",
    run: async () => {
      const project = await plateMoved([100, 0, 0]);
      const moved = metricsOf(bodyOf(project, PLATE));
      near(moved.centroidMm[0], 100, 1e-6, "the plate was moved 100 mm out");
      const shape = { type: "circular", count: 4, totalAngleDeg: 360, axis: { kind: "datum", axis: "z" } } as const;
      const patterned = await addOk(project, { shape, result: "new-bodies", sourceBodyId: PLATE });
      const all = [bodyOf(patterned, PLATE), ...patternSteps(patterned).map((step) => bodyOf(patterned, step.bodyId))];
      equal(all.length, 4, "four plates in all");
      const total = all.map(metricsOf);
      const centroid = [0, 1, 2].map((axis) => total.reduce((sum, metrics) => sum + metrics.centroidMm[axis]!, 0) / 4);
      near(centroid[0]!, 0, 1e-6, "the mean centroid is on the axis (x)");
      near(centroid[1]!, 0, 1e-6, "the mean centroid is on the axis (y)");
      near(centroid[2]!, 5, 1e-6, "and stays at mid-thickness (z)");
      const min = [0, 1].map((axis) => Math.min(...total.map((metrics) => metrics.boundsMm.min[axis]!)));
      const max = [0, 1].map((axis) => Math.max(...total.map((metrics) => metrics.boundsMm.max[axis]!)));
      near(min[0]!, -max[0]!, 1e-6, "the bounding box is symmetric in x");
      near(min[1]!, -max[1]!, 1e-6, "the bounding box is symmetric in y");
      near(max[0]!, 130, 1e-6, "and reaches 130 mm (100 + half of 60)");
      assert(all.every((body) => closed(body) && metricsOf(body).outward), "every plate stays closed and outward");
      assert(all.slice(1).every((body) => Math.abs(metricsOf(body).volumeMm3 - PLATE_VOLUME) < PLATE_VOLUME * 0.001), "turning does not change volume");
      // A partial sweep: three instances over 90 degrees, 45 degrees apart.
      const partial = await addOk(project, { shape: { type: "circular", count: 3, totalAngleDeg: 90, axis: { kind: "datum", axis: "z" } }, result: "new-bodies", sourceBodyId: PLATE });
      const last = bodyOf(partial, patternSteps(partial).at(-1)!.bodyId);
      near(metricsOf(last).centroidMm[0], 0, 1e-6, "90 degrees from +X puts the last plate on the Y axis (x)");
      near(metricsOf(last).centroidMm[1], 100, 1e-6, "90 degrees from +X puts the last plate on the Y axis (y)");
    }
  },
  {
    name: "a circular pattern about a construction axis follows the axis",
    run: async () => {
      let project = await plateMoved([100, 0, 0]);
      project = run(project, { kind: "add-construction-axis", axis: { id: "construction-axis:spin", name: "Spin", visible: true, definition: { kind: "point-and-direction", origin: [50, 0, 0], direction: [0, 0, 1] } } });
      const shape = { type: "circular", count: 2, totalAngleDeg: 360, axis: { kind: "construction", axisId: "construction-axis:spin" } } as const;
      const patterned = await addOk(project, { shape, result: "new-bodies", sourceBodyId: PLATE });
      const copy = bodyOf(patterned, patternSteps(patterned)[0]!.bodyId);
      near(metricsOf(copy).centroidMm[0], 0, 1e-6, "a half turn about x = 50 sends x = 100 to x = 0");
      // Move the axis: the next replay follows it.
      const moved = { ...patterned, part: { ...patterned.part, constructionAxes: [{ id: "construction-axis:spin", name: "Spin", visible: true, definition: { kind: "point-and-direction" as const, origin: [60, 0, 0] as const, direction: [0, 0, 1] as const } }] } };
      const replayed = run(moved, { kind: "regenerate-design", results: await replayAllBodies(moved) });
      near(metricsOf(bodyOf(replayed, patternSteps(replayed)[0]!.bodyId)).centroidMm[0], 20, 1e-6, "editing the construction axis moves the copy on the next replay");
    }
  },
  {
    name: "a mirror as a new body is a closed, outward body reflected about a datum, an offset plane or a construction plane",
    run: async () => {
      const project = await plateMoved([100, 0, 0]);
      const about = async (plane: PatternRequest["shape"] & { type: "mirror" }, source: WorkbenchProject = project): Promise<GeneralSolidBody> => {
        const patterned = await addOk(source, { shape: plane, result: "new-bodies", sourceBodyId: PLATE });
        return bodyOf(patterned, patternSteps(patterned)[0]!.bodyId);
      };
      const yz = await about({ type: "mirror", plane: { kind: "datum", plane: "yz" } });
      assert(closed(yz) && metricsOf(yz).outward, "the YZ mirror is closed and outward");
      near(metricsOf(yz).volumeMm3, PLATE_VOLUME, PLATE_VOLUME * 0.001, "same volume");
      near(metricsOf(yz).centroidMm[0], -100, 1e-6, "reflected through x = 0");
      const offset = await about({ type: "mirror", plane: { kind: "datum", plane: "yz", offsetMm: 40 } });
      near(metricsOf(offset).centroidMm[0], -20, 1e-6, "reflected through the plane x = 40");
      const xy = await about({ type: "mirror", plane: { kind: "datum", plane: "xy", offsetMm: 5 } });
      near(metricsOf(xy).centroidMm[2], 5, 1e-6, "a mirror in the plate's mid-plane maps it onto itself in z");
      assert(metricsOf(xy).outward && closed(xy), "the XY mirror is closed and outward");
      const withPlane = run(project, { kind: "add-construction-plane", plane: { id: "construction-plane:mid", name: "Mid", visible: true, definition: { kind: "offset", basePlane: "datum:yz", offsetMm: 25 } } });
      const viaPlane = await about({ type: "mirror", plane: { kind: "construction", planeId: "construction-plane:mid" } }, withPlane);
      near(metricsOf(viaPlane).centroidMm[0], -50, 1e-6, "reflected through the construction plane x = 25");
      assert(metricsOf(viaPlane).outward, "the construction-plane mirror winds outward");
    }
  },
  {
    name: "joining overlapping copies into the body uses the Boolean: the union volume, one closed body, no extra bodies",
    run: async () => {
      const project = await plateProject();
      const shape = rect({ countA: 3, spacingAMm: 30, directionA: [0, 1, 0] });
      const patterned = await addOk(project, { shape, result: "join", sourceBodyId: PLATE });
      equal((patterned.part.generalBodies ?? []).length, 1, "joining adds no bodies");
      const step = patternSteps(patterned)[0]!;
      assert(modifiesBody(step) && step.bodyId === PLATE && step.operation === "direct-edit", "a joined pattern is a step on the source body");
      const joined = bodyOf(patterned, PLATE);
      assert(closed(joined), "the union is closed and consistently wound");
      assert(metricsOf(joined).outward, "and winds outward");
      const expected = (60 * 100 - 3 * Math.PI * 25) * 10;
      near(metricsOf(joined).volumeMm3, expected, expected * 0.01, "three plates 30 mm apart overlap by 10 mm each; the union is 60 x 100 mm less three bores");
      assert(joined.brep?.origin === "mesh-boolean", "the result is a Boolean mesh body");
      near(metricsOf(joined).sizeMm[1], 100, 1e-6, "it reaches 100 mm along Y");
    }
  },
  {
    name: "joining copies that do not touch keeps them as separate shells in the one body, and touching copies merge",
    run: async () => {
      const project = await plateProject();
      const apart = await addOk(project, { shape: rect({ countA: 2, spacingAMm: 90 }), result: "join", sourceBodyId: PLATE });
      const shells = bodyOf(apart, PLATE);
      near(metricsOf(shells).volumeMm3, 2 * PLATE_VOLUME, PLATE_VOLUME * 0.001, "two separate plates in one body");
      assert(closed(shells), "the two shells are each closed");
      const touching = await addPattern(project, { shape: rect({ countA: 2, spacingAMm: 60 }), result: "join", sourceBodyId: PLATE });
      assert(touching.ok, `plates that touch along a face can be joined: ${touching.ok ? "" : touching.message}`);
      if (touching.ok) {
        const merged = bodyOf(touching.project, PLATE);
        near(metricsOf(merged).volumeMm3, 2 * PLATE_VOLUME, PLATE_VOLUME * 0.003, "the touching plates make one block of twice the volume");
        assert(closed(merged), "the merged body is closed");
      }
    }
  },
  {
    name: "mirroring a half and joining it back makes one closed symmetric body",
    run: async () => {
      const project = await plateMoved([30, 0, 0]);
      const patterned = await addOk(project, { shape: { type: "mirror", plane: { kind: "datum", plane: "yz" } }, result: "join", sourceBodyId: PLATE });
      const whole = bodyOf(patterned, PLATE);
      assert(closed(whole) && metricsOf(whole).outward, "the joined mirror is closed and outward");
      near(metricsOf(whole).volumeMm3, 2 * PLATE_VOLUME, PLATE_VOLUME * 0.003, "the two halves make twice the volume");
      near(metricsOf(whole).centroidMm[0], 0, 1e-3, "and the result is centred on the mirror plane");
      near(metricsOf(whole).sizeMm[0], 120, 1e-6, "120 mm across");
    }
  },
  {
    name: "editing the source regenerates the pattern: a taller plate, a changed sketch and a moved plate all carry into the copies",
    run: async () => {
      const project = await addOk(await plateProject(), { shape: rect({ countA: 3, spacingAMm: 80 }), result: "new-bodies", sourceBodyId: PLATE });
      const before = patternSteps(project).map((step) => metricsOf(bodyOf(project, step.bodyId)).volumeMm3);
      // Make the plate taller: every copy follows.
      const taller = run(project, { kind: "update-design-solid", feature: { ...extrudeStep, valueMm: 25 }, body: bodyOf(project, PLATE) });
      const replayed = run(taller, { kind: "regenerate-design", results: await replayAllBodies(taller) });
      const after = patternSteps(replayed).map((step) => metricsOf(bodyOf(replayed, step.bodyId)));
      near(after[0]!.volumeMm3, PLATE_VOLUME * 2.5, PLATE_VOLUME * 0.0025, "the first copy is now 25 mm tall");
      near(after[1]!.sizeMm[2], 25, 1e-6, "the second copy is 25 mm tall too");
      assert(before.every((volume) => Math.abs(volume - PLATE_VOLUME) < PLATE_VOLUME * 0.001), "they were 10 mm tall before");
      // Suppressing the source's step switches the copies off and hides them; unsuppressing brings them back.
      const off = run(replayed, { kind: "set-design-feature-suppressed", featureId: extrudeStep.id, suppressed: true });
      assert(patternSteps(off).every((step) => !isFeatureActive(designOf(off), step.id)), "suppressing the source step switches its copies off");
      assert((off.part.generalBodies ?? []).every((body) => !body.visible), "and hides every body");
      const on = run(off, { kind: "set-design-feature-suppressed", featureId: extrudeStep.id, suppressed: false });
      assert(patternSteps(on).every((step) => isFeatureActive(designOf(on), step.id)) && (on.part.generalBodies ?? []).every((body) => body.visible), "unsuppressing brings them all back");
      // A step added to the source after the pattern changes the source but not the copies (they copy it as it was at the pattern).
      const moveLater = moveStep("later", [0, 0, 0.5]);
      const withLater = run(replayed, { kind: "add-design-solid", feature: moveLater, body: bodyOf(replayed, PLATE) });
      const rebuilt = run(withLater, { kind: "regenerate-design", results: await replayAllBodies(withLater) });
      near(metricsOf(bodyOf(rebuilt, PLATE)).boundsMm.min[2], 0.5, 1e-6, "the source moved up");
      near(metricsOf(bodyOf(rebuilt, patternSteps(rebuilt)[0]!.bodyId)).boundsMm.min[2], 0, 1e-6, "a copy made before that move stays where the pattern put it");
    }
  },
  {
    name: "deleting the source body's step removes the copies, and suppressing its sketch switches them off",
    run: async () => {
      const project = await addOk(await plateProject(), { shape: rect({ countA: 3 }), result: "new-bodies", sourceBodyId: PLATE });
      const history = designOf(project);
      const dependents = dependentsOf(history, extrudeStep.id).map((feature) => feature.id);
      const copies = patternSteps(project).map((step) => step.id);
      assert(copies.every((id) => dependents.includes(id)), "the copies depend on the step that made their source");
      const deleted = run(project, { kind: "delete-design-feature", featureId: extrudeStep.id });
      equal((deleted.part.generalBodies ?? []).length, 0, "deleting the source removes the copies' bodies too");
      equal(patternSteps(deleted).length, 0, "and their steps");
      const suppressed = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:sketch-1", suppressed: true });
      assert(patternSteps(suppressed).every((step) => !isFeatureActive(designOf(suppressed), step.id)), "suppressing the sketch turns the copies off");
      assert((suppressed.part.generalBodies ?? []).every((body) => !body.visible), "and hides every body");
    }
  },
  {
    name: "a pattern of features repeats a hole and an extrude cut on the same body, and follows when the original changes",
    run: async () => {
      let project = withCutSketch(await plateProject(), [-17.3, 11.1]);
      const hole: DesignSolidFeature = {
        id: "feature:drill", name: "Drill", kind: "hole", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 6, bodyId: PLATE, operation: "direct-edit",
        holeStyle: "simple", holePositionMm: [-20, -12, 10], holeNormal: [0, 0, 1], holeDiameterMm: 6, holeDepthMm: 0
      };
      const cut: DesignSolidFeature = { id: "feature:pocket", name: "Pocket", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-2", profileIds: [], valueMm: 30, direction: "symmetric", operation: "cut", bodyId: PLATE };
      for (const step of [hole, cut]) {
        project = run(project, { kind: "add-design-solid", feature: step, body: bodyOf(project, PLATE) });
        project = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      }
      const single = metricsOf(bodyOf(project, PLATE)).volumeMm3;
      near(single, PLATE_VOLUME - Math.PI * 9 * 10 - Math.PI * 16 * 10, PLATE_VOLUME * 0.01, "the plate has one hole and one pocket");
      equal(patternableFeatures(project, PLATE).map((feature) => feature.id).join(","), "feature:drill,feature:pocket", "the hole and the cut are offered for patterning");
      const patterned = await addOk(project, { shape: rect({ countA: 3, spacingAMm: 20 }), result: "join", sourceBodyId: PLATE, featureIds: ["feature:drill", "feature:pocket"] });
      const step = patternSteps(patterned)[0]!;
      assert(step.pattern?.featureIds?.length === 2 && step.bodyId === PLATE && modifiesBody(step), "one step on the same body repeats both features");
      equal((patterned.part.generalBodies ?? []).length, 1, "no new bodies");
      const result = bodyOf(patterned, PLATE);
      assert(closed(result) && metricsOf(result).outward, "the patterned plate is closed and outward");
      const removed = PLATE_VOLUME - metricsOf(result).volumeMm3;
      near(removed, 3 * (Math.PI * 9 * 10 + Math.PI * 16 * 10), 3 * (Math.PI * 25 * 10) * 0.02, "three holes and three pockets are cut (two extra of each)");
      // Resize the original hole: the copies follow because the pattern re-reads the recorded feature.
      const wider = run(patterned, { kind: "update-design-solid", feature: { ...hole, holeDiameterMm: 8 }, body: bodyOf(patterned, PLATE) });
      const rebuilt = run(wider, { kind: "regenerate-design", results: await replayAllBodies(wider) });
      const widerRemoved = PLATE_VOLUME - metricsOf(bodyOf(rebuilt, PLATE)).volumeMm3;
      near(widerRemoved - removed, 3 * Math.PI * (16 - 9) * 10, 3 * Math.PI * 7 * 10 * 0.03, "Ø8 instead of Ø6 holes in all three places");
      // Suppress the original pocket: its copies go with it.
      const noPocket = run(rebuilt, { kind: "set-design-feature-suppressed", featureId: cut.id, suppressed: true });
      const replayed = run(noPocket, { kind: "regenerate-design", results: await replayAllBodies(noPocket) });
      const holesOnly = PLATE_VOLUME - metricsOf(bodyOf(replayed, PLATE)).volumeMm3;
      near(holesOnly, 3 * Math.PI * 16 * 10, 3 * Math.PI * 16 * 10 * 0.03, "with the pocket suppressed only the holes remain");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(replayed))).ok, "the project round-trips through validation");
    }
  },
  {
    name: "a circular pattern of a hole drills it on a bolt circle, and a mirror pattern of a hole drills the reflected hole",
    run: async () => {
      let project = await plateProject();
      const hole: DesignSolidFeature = {
        id: "feature:bolt", name: "Bolt hole", kind: "hole", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 4, bodyId: PLATE, operation: "direct-edit",
        holeStyle: "simple", holePositionMm: [20, 0, 10], holeNormal: [0, 0, 1], holeDiameterMm: 4, holeDepthMm: 0
      };
      project = run(project, { kind: "add-design-solid", feature: hole, body: bodyOf(project, PLATE) });
      project = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      const before = metricsOf(bodyOf(project, PLATE)).volumeMm3;
      const around = await addOk(project, { shape: { type: "circular", count: 2, totalAngleDeg: 360, axis: { kind: "datum", axis: "z" } }, result: "join", sourceBodyId: PLATE, featureIds: [hole.id] });
      const twoHoles = bodyOf(around, PLATE);
      near(before - metricsOf(twoHoles).volumeMm3, Math.PI * 4 * 10, Math.PI * 4 * 10 * 0.03, "a half turn adds a second Ø4 hole");
      // The new hole sits at x = -20: a probe hole straight through that spot would remove nothing more from the plate.
      const xs = twoHoles.positionsMm.filter((_, index) => index % 3 === 0);
      assert(xs.some((x) => Math.abs(x + 22) < 1e-6) && xs.some((x) => Math.abs(x + 18) < 1e-6), "the mirrored hole's walls are at x = -22 and x = -18");
      const mirrored = await addOk(project, { shape: { type: "mirror", plane: { kind: "datum", plane: "yz" } }, result: "join", sourceBodyId: PLATE, featureIds: [hole.id] });
      near(before - metricsOf(bodyOf(mirrored, PLATE)).volumeMm3, Math.PI * 4 * 10, Math.PI * 4 * 10 * 0.03, "the mirror adds the reflected hole");
    }
  },
  {
    name: "a 4 x 2 grid of holes is cut in a few Boolean passes and removes exactly eight holes' volume",
    run: async () => {
      let project = await plateProject();
      const hole: DesignSolidFeature = {
        id: "feature:grid-hole", name: "Grid hole", kind: "hole", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 4, bodyId: PLATE, operation: "direct-edit",
        holeStyle: "simple", holePositionMm: [-24, -14, 10], holeNormal: [0, 0, 1], holeDiameterMm: 4, holeDepthMm: 0
      };
      project = run(project, { kind: "add-design-solid", feature: hole, body: bodyOf(project, PLATE) });
      project = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      const before = metricsOf(bodyOf(project, PLATE)).volumeMm3;
      const started = Date.now();
      const patterned = await addOk(project, { shape: rect({ countA: 4, spacingAMm: 16, countB: 2, spacingBMm: 28, directionB: [0, 1, 0] }), result: "join", sourceBodyId: PLATE, featureIds: [hole.id] });
      const result = bodyOf(patterned, PLATE);
      near(before - metricsOf(result).volumeMm3, 7 * Math.PI * 4 * 10, 7 * Math.PI * 4 * 10 * 0.03, "seven more Ø4 holes");
      assert(closed(result) && metricsOf(result).outward, "the plate with eight holes is closed and outward");
      assert(Date.now() - started < 20_000, "and it was built in reasonable time");
      assert(result.indices.length / 3 < 30_000, "staying well inside the Boolean's triangle budget");
    }
  },
  {
    name: "a pattern that cannot be placed is refused with a reason and leaves the project unchanged",
    run: async () => {
      const project = await plateProject();
      const parallel = await addPattern(project, { shape: rect({ countA: 2, countB: 2, directionB: [1, 0, 0] }), result: "new-bodies", sourceBodyId: PLATE });
      assert(!parallel.ok && parallel.message.includes("parallel"), "parallel directions are refused");
      const tooMany = await addPattern(project, { shape: rect({ countA: 80 }), result: "new-bodies", sourceBodyId: PLATE });
      assert(!tooMany.ok && tooMany.message.includes("limit"), `more bodies than the part allows are refused: ${tooMany.ok ? "" : tooMany.message}`);
      const noBody = await addPattern(project, { shape: rect(), result: "new-bodies", sourceBodyId: "general-body:missing" });
      assert(!noBody.ok, "a missing body is refused");
      const notFeature = await addPattern(project, { shape: rect(), result: "join", sourceBodyId: PLATE, featureIds: ["feature:extrude-1"] });
      assert(!notFeature.ok, "the step that made the body cannot be patterned as a feature");
      const cutsAir = await addPattern(withCutSketch(project, [-20, 12]), { shape: rect({ countA: 2, spacingAMm: 500 }), result: "join", sourceBodyId: PLATE, featureIds: ["feature:nothing"] });
      assert(!cutsAir.ok, "unknown features are refused");
      equal(designOf(project).features.length, 2, "the failed attempts did not touch the timeline");
      // A hole that lands off the plate is reported instead of silently ignored.
      let withHole = await plateProject();
      const hole: DesignSolidFeature = { id: "feature:edge-hole", name: "Edge hole", kind: "hole", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 4, bodyId: PLATE, operation: "direct-edit", holeStyle: "simple", holePositionMm: [20, 0, 10], holeNormal: [0, 0, 1], holeDiameterMm: 4, holeDepthMm: 0 };
      withHole = run(withHole, { kind: "add-design-solid", feature: hole, body: bodyOf(withHole, PLATE) });
      const offPlate = await addPattern(withHole, { shape: rect({ countA: 2, spacingAMm: 500 }), result: "join", sourceBodyId: PLATE, featureIds: [hole.id] });
      assert(!offPlate.ok && offPlate.message.startsWith("Not applied"), `a hole pattern that misses the body is refused: ${offPlate.ok ? "" : offPlate.message}`);
    }
  },
  {
    name: "patterns validate: bad layouts are rejected, and a saved timeline must put a pattern after the body it copies",
    run: async () => {
      const goodProject = await addOk(await plateProject(), { shape: rect({ countA: 2 }), result: "new-bodies", sourceBodyId: PLATE });
      const good = patternSteps(goodProject)[0]!;
      assert(validSolidFeaturePayload(good), "a real pattern step is accepted");
      const pattern = good.pattern!;
      const bad = (changes: Record<string, unknown>): boolean => validSolidFeaturePayload({ ...good, pattern: { ...pattern, ...changes } });
      assert(!bad({ countA: 1, countB: 1 }), "one instance is not a pattern");
      assert(!bad({ countA: 1000 }), "too many instances");
      assert(!bad({ spacingAMm: 0 }), "zero spacing");
      assert(!bad({ directionA: [0, 0, 0] }), "zero direction");
      assert(!bad({ sizing: "fit" }), "unknown sizing");
      const { copyIndex: _copy, ...withoutCopy } = pattern;
      void _copy;
      assert(!validSolidFeaturePayload({ ...good, pattern: withoutCopy }), "a new-bodies step needs its copy number");
      assert(!bad({ result: "join" }), "a joined pattern has no copy number");
      assert(!validSolidFeaturePayload({ ...good, operation: "direct-edit" }), "a new-bodies pattern is a new-body step");
      assert(!validSolidFeaturePayload({ ...good, bodyId: pattern.sourceBodyId }), "a new-bodies pattern cannot reuse the source's body ID");
      assert(!validSolidFeaturePayload({ ...good, kind: "extrude" }), "pattern data on another kind");
      assert(!validPatternDefinition({ ...pattern, type: "circular", count: 4, totalAngleDeg: 0, axis: { kind: "datum", axis: "z" } }), "a circular pattern needs an angle");
      assert(!validPatternDefinition({ type: "circular", result: "join", groupId: "pattern-group:a", sourceBodyId: PLATE, count: 4, totalAngleDeg: 360, axis: { kind: "datum", axis: "w" } }), "an unknown axis");
      assert(!validPatternDefinition({ type: "mirror", result: "join", groupId: "pattern-group:a", sourceBodyId: PLATE, plane: { kind: "datum", plane: "ab" } }), "an unknown plane");
      assert(validPatternDefinition({ type: "mirror", result: "join", groupId: "pattern-group:a", sourceBodyId: PLATE, plane: { kind: "datum", plane: "xy", offsetMm: -4 } }), "a valid mirror");
      assert(!validPatternDefinition({ type: "mirror", result: "join", groupId: "pattern-group:a", sourceBodyId: PLATE, plane: { kind: "datum", plane: "xy" }, featureIds: [] }), "an empty feature list");
      // A saved timeline that puts the pattern before the body it copies is refused.
      const project = await addOk(await plateProject(), { shape: rect({ countA: 2 }), result: "new-bodies", sourceBodyId: PLATE });
      const features = designOf(project).features;
      const swapped = { ...project, design: { ...designOf(project), features: [features[0]!, features[2]!, features[1]!] } };
      assert(!validateWorkbenchProject(JSON.parse(JSON.stringify(swapped))).ok, "a pattern before its source is refused");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project))).ok, "the right order passes");
      // The operation itself refuses a pattern whose source is not earlier in the timeline.
      const early = applyWorkbenchOperation(await plateProject(), { kind: "add-design-solid", feature: { ...good, pattern: { ...pattern, sourceBodyId: "general-body:nowhere" } }, body: bodyOf(goodProject, good.bodyId), operationId: "operation:test-pattern-early", expectedRevision: (await plateProject()).revision } as WorkbenchOperation);
      assert(!early.ok, "a pattern of a body that is not in the timeline is refused");
    }
  },
  {
    name: "editing a pattern keeps the steps and bodies it already made, adds or removes copies at the end, and replays",
    run: async () => {
      const project = await addOk(await plateProject(), { shape: rect({ countA: 3, spacingAMm: 80 }), result: "new-bodies", sourceBodyId: PLATE });
      const group = patternGroups(project)[0]!;
      equal(group.steps.length, 2, "two copy steps");
      const request = requestOfGroup(group.steps)!;
      equal(request.shape.type, "rectangular", "the group reads back as a request");
      const wider = await editPattern(project, group.groupId, { ...request, shape: rect({ countA: 3, spacingAMm: 100 }) });
      assert(wider.ok, `spacing edit: ${wider.ok ? "" : wider.message}`);
      if (!wider.ok) return;
      equal(patternSteps(wider.project).map((step) => step.id).join(), group.steps.map((step) => step.id).join(), "the same steps and bodies remain");
      near(metricsOf(bodyOf(wider.project, group.steps[1]!.bodyId)).centroidMm[0], 200, 1e-6, "the second copy moved to 200 mm");
      const more = await editPattern(wider.project, group.groupId, { ...request, shape: rect({ countA: 5, spacingAMm: 100 }) });
      assert(more.ok, `count edit up: ${more.ok ? "" : more.message}`);
      if (!more.ok) return;
      equal(patternSteps(more.project).length, 4, "five instances need four copies");
      equal(patternSteps(more.project).slice(0, 2).map((step) => step.id).join(), group.steps.map((step) => step.id).join(), "the first two steps are the ones that were already there");
      near(metricsOf(bodyOf(more.project, patternSteps(more.project)[3]!.bodyId)).centroidMm[0], 400, 1e-6, "the new last copy sits at 400 mm");
      assert(patternSteps(more.project).every((step) => (step.pattern as { countA?: number } | undefined)?.countA === 5), "every step carries the new count");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(more.project))).ok, "the edited project validates");
      const fewer = await editPattern(more.project, group.groupId, { ...request, shape: rect({ countA: 2, spacingAMm: 50 }) });
      assert(fewer.ok, `count edit down: ${fewer.ok ? "" : fewer.message}`);
      if (!fewer.ok) return;
      equal(patternSteps(fewer.project).length, 1, "two instances need one copy");
      equal((fewer.project.part.generalBodies ?? []).length, 2, "the extra bodies are gone");
      // A join pattern edits in place.
      const joined = await addOk(await plateProject(), { shape: rect({ countA: 2, spacingAMm: 90 }), result: "join", sourceBodyId: PLATE });
      const joinedGroup = patternGroups(joined)[0]!;
      const retuned = await editPattern(joined, joinedGroup.groupId, { ...requestOfGroup(joinedGroup.steps)!, shape: rect({ countA: 3, spacingAMm: 90 }) });
      assert(retuned.ok, "join edit");
      if (retuned.ok) near(metricsOf(bodyOf(retuned.project, PLATE)).volumeMm3, 3 * PLATE_VOLUME, PLATE_VOLUME * 0.003, "the joined body now holds three plates");
      assert(!(await editPattern(project, "pattern-group:gone", request)).ok, "an unknown pattern cannot be edited");
    }
  },
  {
    name: "a pattern of a copy, and a pattern built on an earlier pattern, replay in order",
    run: async () => {
      const first = await addOk(await plateProject(), { shape: rect({ countA: 2, spacingAMm: 80 }), result: "new-bodies", sourceBodyId: PLATE });
      const copy = patternSteps(first)[0]!;
      const second = await addOk(first, { shape: rect({ countA: 2, spacingAMm: 80, directionA: [0, 1, 0] }), result: "new-bodies", sourceBodyId: copy.bodyId });
      equal((second.part.generalBodies ?? []).length, 3, "the plate, its copy and the copy's copy");
      const copyOfCopy = bodyOf(second, patternSteps(second)[1]!.bodyId);
      near(metricsOf(copyOfCopy).centroidMm[0], 80, 1e-6, "the copy of the copy stays in the copy's column (x)");
      near(metricsOf(copyOfCopy).centroidMm[1], 80, 1e-6, "and steps 80 mm up (y)");
      const replayed = await replayAllBodies(second);
      assert(replayed.every((result) => !isRebuildFailure(result)), "the whole chain replays without a problem");
      const base = baseFeatureOf(designOf(second), patternSteps(second)[1]!.bodyId);
      assert(base?.kind === "pattern", "a copy's base step is its pattern step");
    }
  },
  {
    name: "the dialog's fields read into requests, refuse nonsense in plain words, and a typed pattern builds real bodies",
    run: async () => {
      const base = formOfRequest();
      const grid = requestOfForm("rectangular", { ...base, countA: "3", spacingA: "70", directionA: "-x", countB: "2", spacingB: "50", directionB: "y" }, PLATE);
      assert("request" in grid && grid.request.shape.type === "rectangular", "a grid reads into a rectangular request");
      if ("request" in grid && grid.request.shape.type === "rectangular") {
        equal(grid.request.shape.directionA.join(","), "-1,0,0", "the direction menu picks a unit vector");
        equal(grid.request.shape.countA * grid.request.shape.countB, 6, "3 x 2 instances");
        equal(grid.request.result, "new-bodies", "copies are new bodies by default");
      }
      const messageOf = (outcome: ReturnType<typeof requestOfForm>): string => ("message" in outcome ? outcome.message : "");
      assert(messageOf(requestOfForm("rectangular", { ...base, countA: "1", countB: "1" }, PLATE)).includes("two instances"), "one instance in total is refused");
      assert(messageOf(requestOfForm("rectangular", { ...base, countA: "2.5" }, PLATE)).includes("whole number"), "a fractional count is refused");
      assert(messageOf(requestOfForm("rectangular", { ...base, spacingA: "0" }, PLATE)).includes("spacing"), "zero spacing is refused");
      assert(messageOf(requestOfForm("rectangular", { ...base, sizing: "extent", spacingA: "-3" }, PLATE)).includes("extent"), "a negative extent is refused");
      assert(messageOf(requestOfForm("rectangular", { ...base, countA: "20", countB: "10" }, PLATE)).includes("100"), "more than 100 instances are refused");
      assert(messageOf(requestOfForm("circular", { ...base, count: "1" }, PLATE)).includes("2 to 100"), "a circular pattern needs two instances");
      assert(messageOf(requestOfForm("circular", { ...base, angle: "400" }, PLATE)).includes("360"), "more than a full turn is refused");
      assert(messageOf(requestOfForm("mirror", { ...base, offset: "far" }, PLATE)).includes("number"), "a non-numeric plane position is refused");
      assert(messageOf(requestOfForm("rectangular", { ...base, target: "features" }, PLATE)).includes("Tick"), "a pattern of features needs a feature ticked");
      // Round trip: a request read back into fields and out again is the same request.
      const typed = requestOfForm("circular", { ...base, count: "6", angle: "-180", axis: "construction-axis:spin", result: "join" }, PLATE);
      assert("request" in typed, "circular fields read");
      if (!("request" in typed)) return;
      const again = requestOfForm("circular", formOfRequest(typed.request), PLATE);
      assert("request" in again && JSON.stringify(again.request) === JSON.stringify(typed.request), "fields and request round-trip");
      // A typed pattern drives the real path.
      const project = await plateProject();
      const typedMirror = requestOfForm("mirror", { ...base, plane: "yz", offset: "45" }, PLATE);
      assert("request" in typedMirror, "mirror fields read");
      if (!("request" in typedMirror)) return;
      const preview = previewPattern(project, typedMirror.request);
      assert(preview.ok && preview.instances === 2 && preview.text.includes("2 instances"), `the preview counts the mirror: ${"text" in preview ? preview.text : preview.message}`);
      const done = await addOk(project, typedMirror.request);
      near(metricsOf(bodyOf(done, patternSteps(done)[0]!.bodyId)).centroidMm[0], 90, 1e-6, "the plate at x = 0 mirrored about x = 45 lands at x = 90");
      const lone = previewPattern(project, { shape: rect({ countA: 2, spacingAMm: 10 }), result: "new-bodies", sourceBodyId: PLATE });
      assert(lone.ok && lone.overlapping && lone.text.includes("overlap"), "the preview warns when copies overlap");
      assert(!previewPattern(project, { shape: rect(), result: "join", sourceBodyId: "general-body:missing" }).ok, "the preview needs a body");
    }
  },
  {
    name: "pattern summaries count instances, reach and overlap",
    run: () => {
      const mesh = tessellateExtrude([[0, 0], [20, 0], [20, 10], [0, 10]], 5, "xy");
      const layout = patternTransforms(rect({ countA: 3, spacingAMm: 15 }));
      assert(layout.ok, "layout");
      if (!layout.ok) return;
      const summary = summarizePattern(layout.transforms, Array.from(mesh.positionsMm))!;
      equal(summary.instances, 3, "three instances");
      near(summary.extentMm[0], 50, 1e-9, "reaches 20 + 2 * 15 mm");
      equal(summary.overlappingPairs, 2, "20 mm blocks 15 mm apart overlap with their neighbours (0-1 and 1-2) but not the far one");
      assert(summary.text.includes("overlap"), "the text warns about overlap");
      const spread = patternTransforms(rect({ countA: 3, spacingAMm: 40 }));
      assert(spread.ok, "wide layout");
      if (spread.ok) equal(summarizePattern(spread.transforms, Array.from(mesh.positionsMm))!.overlappingPairs, 0, "blocks 40 mm apart do not overlap");
    }
  }
];

export function patternTestSerial(): number {
  return serial;
}
