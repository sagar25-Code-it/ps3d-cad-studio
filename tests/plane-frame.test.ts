import type { DesignSketchFeature, DesignSolidFeature, SketchPlaneFrame, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, describeFeature, designOf, validateWorkbenchProject, validSketchPlaneFrame } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { evaluateConstructionPlaneDefinition } from "../packages/workbench-geometry/src/construction-geometry.js";
import { frameThroughPoints, placeDirection, placePoint, placePositions } from "../packages/workbench-geometry/src/sketch-placement.js";
import { sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { flatPatternForBody, replayAllBodies, rebuildSolidFeature, sketchNormal, throughAllOverride } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-frame-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function refuses(project: WorkbenchProject, operation: Op): boolean {
  serial += 1;
  return !applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-frame-${serial}`, expectedRevision: project.revision } as WorkbenchOperation).ok;
}

type Points = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

function frameOf(points: Points): SketchPlaneFrame {
  const frame = frameThroughPoints(points);
  if ("error" in frame) throw new Error(frame.error);
  return frame;
}

/** A project whose committed sketch sits on the plane through `points` (or on the XY datum when none are given). */
function framedSketch(points?: Points): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  let project = run(createWorkbenchProject("project:test-frame"), { kind: "set-sketch-plane", plane: "datum:xy", ...(points === undefined ? {} : { frame: frameOf(points) }) });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  return { project, sketch: designOf(project).features[0] as DesignSketchFeature };
}

const step = (sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra });

/** Sketch X runs along world Y, sketch Y along world Z, and the plane rises along +X, one corner at (5, 5, 5). */
const UPRIGHT: Points = [[5, 5, 5], [5, 15, 5], [5, 5, 15]];
/** A slanted plane that is not turned about any single world axis from a datum plane. */
const SLANTED: Points = [[20, 10, 5], [30, 10, 10], [20, 20, 5]];

export const planeFrameTests: readonly TestCase[] = [
  {
    name: "Three points make a unit, perpendicular frame that starts at the first point and matches the construction plane, and placing then un-placing returns the point",
    run: () => {
      for (const points of [UPRIGHT, SLANTED, [[0, 0, 0], [3, 4, 0], [0, 0, 7]] as Points]) {
        const frame = frameOf(points);
        const reference = evaluateConstructionPlaneDefinition({ kind: "three-points", points });
        assert(!("error" in reference), "the construction plane evaluates");
        if ("error" in reference) return;
        for (let i = 0; i < 3; i += 1) {
          near(frame.originMm[i]!, points[0][i]!, 0, "the sketch origin is the first point");
          near(frame.uAxis[i]!, reference.uAxis[i]!, 1e-12, "X is the same as the construction plane's");
          near(frame.normal[i]!, reference.normal[i]!, 1e-12, "the normal is the same as the construction plane's");
        }
        assert(validSketchPlaneFrame(frame), "the computed frame is accepted");
        const placement = { planeFrame: frame };
        const flat: readonly [number, number, number] = [3.5, -2, 8];
        const placed = placePoint(flat, placement);
        const back = placePoint(placed, placement, true);
        for (let i = 0; i < 3; i += 1) near(back[i]!, flat[i]!, 1e-9, `placing then un-placing, component ${i}`);
        const direction = placeDirection([0, 0, 1], placement);
        for (let i = 0; i < 3; i += 1) near(direction[i]!, frame.normal[i]!, 1e-12, "the datum normal becomes the frame normal");
        const origin = placePoint([0, 0, 0], placement);
        for (let i = 0; i < 3; i += 1) near(origin[i]!, points[0][i]!, 1e-12, "the datum origin lands on the first point");
      }
      const upright = placePoint([2, 3, 4], { planeFrame: frameOf(UPRIGHT) });
      assert(upright[0] === 9 && upright[1] === 7 && upright[2] === 8, `sketch (2, 3) and 4 mm up lands on world (9, 7, 8): ${upright.join(", ")}`);
      assert(placePositions([1, 0, 0], {}).join() === "1,0,0", "no placement leaves positions alone");
      assert("error" in frameThroughPoints([[0, 0, 0], [0, 0, 0], [1, 2, 3]]), "two equal points are refused");
      assert("error" in frameThroughPoints([[0, 0, 0], [1, 1, 1], [3, 3, 3]]), "three points in a line are refused");
      assert("error" in frameThroughPoints([[0, 0, 0], [1000, 0, 0], [2000, 0.0001, 0]]), "three points that are almost in a line are refused");
    }
  },
  {
    name: "A sketch frame is stored, validated, described, and replaced by the next plane choice; it cannot be combined with an offset or tilt",
    run: () => {
      const frame = frameOf(SLANTED);
      const { project, sketch } = framedSketch(SLANTED);
      assert(JSON.stringify(project.sketch.planeFrame) === JSON.stringify(frame) && sketch.sketch.planeFrame !== undefined, "the frame is on the sketch and on its committed step");
      assert(describeFeature(designOf(project), sketch).includes("3 points"), `the step says it is on three points: ${describeFeature(designOf(project), sketch)}`);
      assert(validateWorkbenchProject(project).ok, "a project on a three-point plane validates");
      assert(run(project, { kind: "set-sketch-plane", plane: "datum:xy" }).sketch.planeFrame === undefined, "choosing a datum plane clears the frame");
      assert(run(project, { kind: "new-design-sketch", plane: "datum:xz" }).sketch.planeFrame === undefined, "a new sketch starts on its datum");
      const again = run(project, { kind: "new-design-sketch", plane: "datum:xy", frame: frameOf(UPRIGHT) });
      assert(again.sketch.planeFrame?.originMm[0] === 5, "a new sketch can start on three points");
      assert(refuses(project, { kind: "set-sketch-plane", plane: "datum:xz", frame }), "a frame needs the XY datum");
      assert(refuses(project, { kind: "set-sketch-plane", plane: "datum:xy", offsetMm: 3, frame }), "a frame cannot carry an offset");
      assert(refuses(project, { kind: "set-sketch-plane", plane: "datum:xy", tilt: { axis: "x", angleDeg: 10 }, frame }), "a frame cannot carry a tilt");
      assert(refuses(project, { kind: "new-design-sketch", plane: "datum:xy", frame: { ...frame, uAxis: [2, 0, 0] } }), "an axis that is not unit length is refused");
      assert(refuses(project, { kind: "new-design-sketch", plane: "datum:xy", frame: { ...frame, uAxis: frame.normal } }), "axes that are not perpendicular are refused");
      assert(refuses(project, { kind: "new-design-sketch", plane: "datum:xy", frame: { ...frame, originMm: [1e9, 0, 0] } }), "an origin out of reach is refused");
      for (const bad of [null, 4, { originMm: [0, 0, 0], uAxis: [1, 0, 0] }, { originMm: [0, 0, 0], uAxis: [1, 0, 0], normal: [0, 0, 1], extra: 1 }, { originMm: [0, 0, Number.NaN], uAxis: [1, 0, 0], normal: [0, 0, 1] }]) {
        assert(!validSketchPlaneFrame(bad), `rejected: ${JSON.stringify(bad)}`);
      }
      const tampered = { ...project, sketch: { ...project.sketch, planeOffsetMm: 4 } } as unknown as WorkbenchProject;
      assert(!validateWorkbenchProject(tampered).ok, "a saved project with a frame and an offset is refused");
      const wrongPlane = { ...project, sketch: { ...project.sketch, plane: "datum:yz" } } as unknown as WorkbenchProject;
      assert(!validateWorkbenchProject(wrongPlane).ok, "a saved project with a frame on another datum is refused");
    }
  },
  {
    name: "A solid built on a three-point sketch is the flat solid moved onto the plane, with its face names, and it rises along the plane's normal",
    run: async () => {
      const flatSetup = framedSketch();
      const upright = framedSketch(UPRIGHT);
      const slanted = framedSketch(SLANTED);
      const flat = await rebuildSolidFeature(step(flatSetup.sketch, "extrude", "slab", { valueMm: 8 }), flatSetup.sketch);
      assert(flat.ok, "the flat slab builds");
      if (!flat.ok) return;
      // The upright plane is exact: sketch X to world Y, sketch Y to world Z, height to world X, all from (5, 5, 5).
      const built = await rebuildSolidFeature(step(upright.sketch, "extrude", "slab", { valueMm: 8 }), upright.sketch);
      assert(built.ok, "the upright slab builds");
      if (!built.ok) return;
      for (let i = 0; i + 2 < flat.body.positionsMm.length; i += 3) {
        const [x, y, z] = [flat.body.positionsMm[i]!, flat.body.positionsMm[i + 1]!, flat.body.positionsMm[i + 2]!];
        near(built.body.positionsMm[i]!, 5 + z, 1e-9, `vertex ${i / 3}: height becomes X`);
        near(built.body.positionsMm[i + 1]!, 5 + x, 1e-9, `vertex ${i / 3}: sketch X becomes Y`);
        near(built.body.positionsMm[i + 2]!, 5 + y, 1e-9, `vertex ${i / 3}: sketch Y becomes Z`);
      }
      assert(JSON.stringify(built.body.brep?.faces.map((face) => face.role)) === JSON.stringify(flat.body.brep?.faces.map((face) => face.role)), "the face names are kept");
      const normal = sketchNormal(upright.sketch);
      assert(normal[0] === 1 && normal[1] === 0 && normal[2] === 0, `the upright plane rises along +X: ${normal.join(", ")}`);
      // A slanted plane keeps volume, stays outward-wound and rises along the plane's normal.
      const tilted = await rebuildSolidFeature(step(slanted.sketch, "extrude", "slab", { valueMm: 8 }), slanted.sketch);
      assert(tilted.ok, "the slanted slab builds");
      if (!tilted.ok) return;
      near(solidMetrics(tilted.body.positionsMm, tilted.body.indices).volumeMm3, solidMetrics(flat.body.positionsMm, flat.body.indices).volumeMm3, 1e-6, "moving a slab does not change its volume");
      assert(solidMetrics(tilted.body.positionsMm, tilted.body.indices).outward, "the winding still points outward");
      assert(isClosedAndOriented(tilted.body.indices) === isClosedAndOriented(flat.body.indices), "and the mesh is connected the same way");
      const slantNormal = sketchNormal(slanted.sketch);
      const frame = frameOf(SLANTED);
      for (let i = 0; i < 3; i += 1) near(slantNormal[i]!, frame.normal[i]!, 1e-12, "the slanted sketch rises along its frame's normal");
      // The first corner of the flat slab's bottom face is the sketch origin shifted: every vertex satisfies the frame's own mapping.
      for (let i = 0; i + 2 < flat.body.positionsMm.length; i += 3) {
        const expected = placePoint([flat.body.positionsMm[i]!, flat.body.positionsMm[i + 1]!, flat.body.positionsMm[i + 2]!], { planeFrame: frame });
        for (let k = 0; k < 3; k += 1) near(tilted.body.positionsMm[i + k]!, expected[k]!, 1e-9, `slanted vertex ${i / 3} component ${k}`);
      }
    }
  },
  {
    name: "Through-all, edge flanges and the flat pattern work on a plate that sits on a three-point plane",
    run: async () => {
      const level = framedSketch();
      const slanted = framedSketch(SLANTED);
      const projects: WorkbenchProject[] = [];
      for (const setup of [level, slanted]) {
        const base = step(setup.sketch, "sheet-base", "plate", { sheetThicknessMm: 2, valueMm: 2 });
        const built = await rebuildSolidFeature(base, setup.sketch);
        assert(built.ok, "plate builds");
        if (!built.ok) return;
        const current = run(setup.project, { kind: "add-design-solid", feature: base, body: built.body });
        const frame = sheetFrameOf(built.body, sketchNormal(setup.sketch));
        assert(frame !== undefined && frame.edges.length >= 4, "the plate's top face and edges are found along the plane's normal");
        if (frame === undefined) return;
        // The longest edge is the same physical edge on both plates, whatever the plane.
        const edge = [...frame.edges].sort((a, b) => b.lengthMm - a.lengthMm || a.index - b.index)[0]!;
        const flange = step(setup.sketch, "sheet-edge-flange", "lip", { bodyId: "general-body:plate", operation: "direct-edit", flangeEdgeIndex: edge.index, sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90 });
        const added = run(current, { kind: "add-design-solid", feature: flange, body: current.part.generalBodies!.find((body) => body.id === "general-body:plate")! });
        const results = await replayAllBodies(added);
        assert(results.every((result) => result.message === undefined), `the flange replays: ${results.map((result) => result.message ?? "").join("; ")}`);
        const regenerated = run(added, { kind: "regenerate-design", results });
        const body = regenerated.part.generalBodies!.find((candidate) => candidate.id === "general-body:plate")!;
        assert(isClosedAndOriented(body.indices), "the flanged plate is closed");
        projects.push(regenerated);
      }
      const [flatOutcome, framedOutcome] = [await flatPatternForBody(projects[0]!, "general-body:plate"), await flatPatternForBody(projects[1]!, "general-body:plate")];
      assert(flatOutcome.ok && framedOutcome.ok, `both unfold: ${flatOutcome.ok ? "" : flatOutcome.message} ${framedOutcome.ok ? "" : framedOutcome.message}`);
      if (flatOutcome.ok && framedOutcome.ok) assert(flatOutcome.summary === framedOutcome.summary, `a plate on three points unfolds to the same blank (${flatOutcome.summary} vs ${framedOutcome.summary})`);
      const framedBody = projects[1]!.part.generalBodies!.find((candidate) => candidate.id === "general-body:plate")!;
      const levelBody = projects[0]!.part.generalBodies!.find((candidate) => candidate.id === "general-body:plate")!;
      const cut = throughAllOverride(step(slanted.sketch, "extrude", "cut", { extent: "through-all" }), slanted.sketch, framedBody);
      const levelCut = throughAllOverride(step(level.sketch, "extrude", "cut", { extent: "through-all" }), level.sketch, levelBody);
      near(cut.valueMm, levelCut.valueMm, 1e-6, "the same plate needs the same through-all reach on a three-point plane");
    }
  }
];
