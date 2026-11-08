import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { attachEdgeFlange, flangeReliefs, reliefCorners, sheetFrameOf, type ReliefShape } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { cutReliefNotch, reliefNotchCutter } from "../packages/workbench-geometry/src/relief-notch.js";
import { flatLayoutDxf, flatPatternOfPlate, NOTCH_ARC_SEGMENTS } from "../packages/workbench-geometry/src/flat-pattern.js";
import { sheetBendAllowanceMm, DEFAULT_K_FACTOR } from "../packages/workbench-geometry/src/sheet-metal.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { applyParameterValues, parameterFieldsOf, parameterValuesOf } from "../apps/studio-web/src/feature-parameters.js";
import { flatPatternForBody, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-notch-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const THICKNESS = 2;
const RADIUS = 2;
const LENGTH = 15;
const slab = (outline: readonly (readonly [number, number])[]): { positionsMm: number[]; indices: number[] } => {
  const mesh = tessellateExtrude(outline, THICKNESS, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
};
const plate = (): { positionsMm: number[]; indices: number[] } => slab([[0, 0], [70, 0], [70, 40], [0, 40]]);
const volumeOf = (mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(mesh.positionsMm, mesh.indices).volumeMm3;
const area = (loop: readonly (readonly [number, number])[]): number => Math.abs(loop.reduce((sum, point, i) => { const next = loop[(i + 1) % loop.length]!; return sum + point[0] * next[1] - next[0] * point[1]; }, 0)) / 2;

/** The plate with a flange on its right and top edges, relieved with a notch of `size` in the given shape; returns the body before and after the notch. */
function flangedCorner(shape: ReliefShape, size: number): { readonly base: ReturnType<typeof plate>; readonly flanged: ReturnType<typeof plate>; readonly notched: ReturnType<typeof plate> | undefined; readonly frame: NonNullable<ReturnType<typeof sheetFrameOf>>; readonly flanges: readonly { edgeIndex: number; reliefMm: number; shape: ReliefShape }[] } {
  const base = plate();
  const frame = sheetFrameOf(base, [0, 0, 1])!;
  const right = frame.edges.find((edge) => edge.outward[0] > 0.99)!.index;
  const top = frame.edges.find((edge) => edge.outward[1] > 0.99)!.index;
  const flanges = [right, top].map((edgeIndex) => ({ edgeIndex, reliefMm: size, shape }));
  let current: { positionsMm: number[]; indices: number[] } = base;
  for (const flange of flanges) {
    const relief = flangeReliefs(frame, flange.edgeIndex, flanges);
    const attached = attachEdgeFlange(current, base, [0, 0, 1], { edgeIndex: flange.edgeIndex, innerRadiusMm: RADIUS, flangeLengthMm: LENGTH, angleDeg: 90, reliefStartMm: relief.startMm, reliefEndMm: relief.endMm });
    assert(attached.ok, `flange on edge ${flange.edgeIndex}: ${attached.ok ? "" : attached.message}`);
    if (!attached.ok) throw new Error("flange failed");
    current = { positionsMm: [...attached.positionsMm], indices: [...attached.indices] };
  }
  const corner = reliefCorners(frame, flanges)[0];
  let notched: ReturnType<typeof plate> | undefined;
  if (corner !== undefined) {
    const cut = cutReliefNotch(current, frame, corner);
    assert(cut.ok, `notch: ${cut.ok ? "" : cut.message}`);
    if (cut.ok) notched = { positionsMm: [...cut.positionsMm], indices: [...cut.indices] };
  }
  return { base, flanged: current, notched, frame, flanges };
}

export const reliefNotchTests: readonly TestCase[] = [
  {
    name: "a notch relief stops each flange its whole size short of the corner (a straight gap only half), and only convex corners with notch shapes are listed",
    run: () => {
      const base = plate();
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      const right = frame.edges.find((edge) => edge.outward[0] > 0.99)!.index;
      const top = frame.edges.find((edge) => edge.outward[1] > 0.99)!.index;
      const stopOf = (shape: ReliefShape): number => { const r = flangeReliefs(frame, right, [{ edgeIndex: right, reliefMm: 4, shape }, { edgeIndex: top, reliefMm: 4, shape }]); return r.startMm + r.endMm; };
      near(stopOf("straight"), 2, 1e-9, "straight: half the 4 mm gap from each flange");
      near(stopOf("square"), 4, 1e-9, "square notch: the flange stops 4 mm short");
      near(stopOf("round"), 4, 1e-9, "round notch: the flange stops 4 mm short");
      equal(reliefCorners(frame, [{ edgeIndex: right, reliefMm: 4 }, { edgeIndex: top, reliefMm: 4 }]).length, 0, "straight reliefs have no notch to cut");
      const corners = reliefCorners(frame, [{ edgeIndex: right, reliefMm: 4, shape: "square" }, { edgeIndex: top, reliefMm: 4, shape: "square" }]);
      equal(corners.length, 1, "one shared corner");
      assert(Math.abs(corners[0]!.pointMm[0] - 70) < 1e-9 && Math.abs(corners[0]!.pointMm[1] - 40) < 1e-9, "at the plate's top right corner");
      equal(reliefCorners(frame, [{ edgeIndex: right, reliefMm: 4, shape: "square" }]).length, 0, "a single flange has no corner");
      equal(reliefCorners(frame, [{ edgeIndex: right, reliefMm: 0, shape: "square" }, { edgeIndex: top, reliefMm: 0, shape: "square" }]).length, 0, "a zero relief cuts nothing");
      // The larger relief decides the shape at a corner whose flanges disagree.
      const mixed = reliefCorners(frame, [{ edgeIndex: right, reliefMm: 3, shape: "square" }, { edgeIndex: top, reliefMm: 5, shape: "round" }]);
      equal(mixed[0]?.shape, "round", "the flange with the larger relief sets the shape");
      near(mixed[0]!.sizeMm, 5, 1e-9, "and the size");
      // An L-shaped plate has a reflex corner: there is no plate to notch there.
      const lPlate = slab([[0, 0], [70, 0], [70, 20], [40, 20], [40, 40], [0, 40]]);
      const lFrame = sheetFrameOf(lPlate, [0, 0, 1])!;
      const near40 = (edge: { startMm: readonly number[]; endMm: readonly number[] }, x: number, y: number): boolean => (Math.abs(edge.startMm[0]! - x) < 1e-6 && Math.abs(edge.startMm[1]! - y) < 1e-6) || (Math.abs(edge.endMm[0]! - x) < 1e-6 && Math.abs(edge.endMm[1]! - y) < 1e-6);
      const atReflex = lFrame.edges.filter((edge) => near40(edge, 40, 20)).map((edge) => ({ edgeIndex: edge.index, reliefMm: 3, shape: "square" as const }));
      equal(atReflex.length, 2, "two edges meet at the reflex corner");
      equal(reliefCorners(lFrame, atReflex).length, 0, "a reflex corner is not notched");
    }
  },
  {
    name: "the notch cutter is a closed outward prism of exactly the footprint, square or a quarter disc",
    run: () => {
      for (const [shape, footprint] of [["square", 16], ["round", Math.PI * 16 / 4]] as const) {
        const { frame, flanges } = flangedCorner(shape, 4);
        const corner = reliefCorners(frame, flanges)[0]!;
        const cutter = reliefNotchCutter(frame, corner);
        assert(isClosedAndOriented(cutter.indices) && solidMetrics(cutter.positionsMm, cutter.indices).outward, `${shape} cutter is closed and points outward`);
        const height = THICKNESS + 1;
        near(volumeOf(cutter), footprint * height, footprint * height * 0.01, `${shape} cutter volume is its footprint times the plate and overshoot`);
      }
    }
  },
  {
    name: "cutting a square or round notch removes exactly the corner of the plate, leaves a closed outward solid, and the flanges still end at the notch",
    run: () => {
      for (const [shape, size, footprint] of [["square", 4, 16], ["square", 5.5, 30.25], ["round", 4, Math.PI * 16 / 4], ["round", 6, Math.PI * 36 / 4]] as const) {
        const { flanged, notched } = flangedCorner(shape, size);
        assert(notched !== undefined, `${shape} ${size}: the notch is cut`);
        if (notched === undefined) continue;
        assert(isClosedAndOriented(notched.indices), `${shape} ${size}: closed and consistently wound`);
        assert(solidMetrics(notched.positionsMm, notched.indices).outward, `${shape} ${size}: outward`);
        const removed = volumeOf(flanged) - volumeOf(notched);
        near(removed, footprint * THICKNESS, footprint * THICKNESS * 0.01, `${shape} ${size}: the notch took ${removed.toFixed(2)} mm3, its footprint times the 2 mm thickness`);
        const atCorner = (positions: readonly number[]): boolean => { for (let i = 0; i < positions.length; i += 3) if (Math.abs(positions[i]! - 70) < 1e-6 && Math.abs(positions[i + 1]! - 40) < 1e-6) return true; return false; };
        assert(atCorner(flanged.positionsMm) && !atCorner(notched.positionsMm), `${shape} ${size}: the plate's corner point is gone`);
        if (shape === "square") {
          let innerCorner = false;
          for (let i = 0; i < notched.positionsMm.length; i += 3) if (Math.abs(notched.positionsMm[i]! - (70 - size)) < 1e-6 && Math.abs(notched.positionsMm[i + 1]! - (40 - size)) < 1e-6) innerCorner = true;
          assert(innerCorner, "the notch has its inner corner");
        }
      }
    }
  },
  {
    name: "the flat pattern's blank has the notch outline at the corner: its area is the plate less the notch plus the shortened flange strips",
    run: () => {
      const base = plate();
      const frame = sheetFrameOf(base, [0, 0, 1])!;
      const right = frame.edges.find((edge) => edge.outward[0] > 0.99)!.index;
      const top = frame.edges.find((edge) => edge.outward[1] > 0.99)!.index;
      const allowance = sheetBendAllowanceMm(90, RADIUS, THICKNESS, DEFAULT_K_FACTOR);
      const reach = allowance + LENGTH;
      const sector = (n: number): number => 0.5 * n * n * NOTCH_ARC_SEGMENTS * Math.sin((Math.PI / 2) / NOTCH_ARC_SEGMENTS);
      for (const [shape, n, notchArea] of [["square", 4, 16], ["square", 6, 36], ["round", 5, sector(5)]] as const) {
        const flat = flatPatternOfPlate(frame, "xy", [right, top].map((edgeIndex) => ({ edgeIndex, innerRadiusMm: RADIUS, flangeLengthMm: LENGTH, angleDeg: 90, reliefMm: n, reliefShape: shape })));
        assert(!("error" in flat), `${shape} ${n}: unfolds`);
        if ("error" in flat) continue;
        const expected = 70 * 40 - notchArea + reach * (40 - n) + reach * (70 - n);
        near(area(flat.outlinesMm[0]!), expected, 1e-6, `${shape} ${n}: blank area`);
        equal(flat.notes.length, 0, "a notch relief clears the corner-relief warning");
        const corner = [70, 40] as const;
        const nearCorner = flat.outlinesMm[0]!.filter((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < n * 1.5 && Math.hypot(p[0] - corner[0], p[1] - corner[1]) > 0.1);
        assert(nearCorner.length >= (shape === "square" ? 3 : NOTCH_ARC_SEGMENTS), `${shape} ${n}: the outline runs round the notch (${nearCorner.length} points near the corner)`);
        assert(!flat.outlinesMm[0]!.some((p) => Math.abs(p[0] - 70) < 1e-9 && Math.abs(p[1] - 40) < 1e-9), `${shape} ${n}: the blank has no point at the plate's corner`);
        const dxf = flatLayoutDxf(flat);
        equal(dxf.split("\n").filter((text) => text === "LINE").length, flat.outlinesMm[0]!.length + flat.bendLinesMm.length, "the DXF draws every notch segment");
        // The straight gap of the same size, for comparison, leaves a different (larger-reaching) outline.
        const straight = flatPatternOfPlate(frame, "xy", [right, top].map((edgeIndex) => ({ edgeIndex, innerRadiusMm: RADIUS, flangeLengthMm: LENGTH, angleDeg: 90, reliefMm: n })));
        assert(!("error" in straight), "straight pattern");
        if (!("error" in straight)) assert(Math.abs(area(straight.outlinesMm[0]!) - area(flat.outlinesMm[0]!)) > 1, `${shape} ${n}: a notch is not the same blank as a straight gap`);
      }
    }
  },
  {
    name: "a notch relief round-trips through the real timeline: replay cuts it once both flanges are on, in either order, suppress removes it, the unfolded blank matches, bad values are refused",
    run: async () => {
      let project = run(createWorkbenchProject("project:test-notch"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketch = designOf(project).features[0] as DesignSketchFeature;
      const sheet: DesignSolidFeature = { id: "feature:sheet", name: "sheet", kind: "sheet-base", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: THICKNESS, bodyId: "general-body:sheet", sheetThicknessMm: THICKNESS };
      const built = await rebuildSolidFeature(sheet, sketch);
      assert(built.ok, "sheet builds");
      if (!built.ok) return;
      project = run(project, { kind: "add-design-solid", feature: sheet, body: built.body });
      const mesh = { positionsMm: Array.from(built.body.positionsMm), indices: Array.from(built.body.indices) };
      const frame = sheetFrameOf(mesh, [0, 0, 1])!;
      // The default plate's width and height: pick its right and top edges.
      const right = frame.edges.find((edge) => edge.outward[0] > 0.99 && edge.lengthMm > 20)!;
      const top = frame.edges.find((edge) => edge.outward[1] > 0.99 && edge.lengthMm > 20)!;
      const flange = (id: string, edge: number, shape: ReliefShape | undefined, relief: number): DesignSolidFeature => ({
        id: `feature:${id}`, name: id, kind: "sheet-edge-flange", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: LENGTH, bodyId: "general-body:sheet", operation: "direct-edit",
        flangeEdgeIndex: edge, sheetBendRadiusMm: RADIUS, flangeLengthMm: LENGTH, flangeAngleDeg: 90, flangeReliefMm: relief, ...(shape === undefined ? {} : { flangeReliefShape: shape })
      });
      const withFlanges = async (steps: readonly DesignSolidFeature[]): Promise<WorkbenchProject> => {
        let current = project;
        for (const step of steps) {
          const added = run(current, { kind: "add-design-solid", feature: step, body: current.part.generalBodies!.find((body) => body.id === "general-body:sheet")! });
          current = run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
        }
        return current;
      };
      const bodyOf = (candidate: WorkbenchProject) => candidate.part.generalBodies!.find((body) => body.id === "general-body:sheet")!;
      const straight = await withFlanges([flange("a", right.index, undefined, 4), flange("b", top.index, undefined, 4)]);
      const squareA = await withFlanges([flange("a", right.index, "square", 4), flange("b", top.index, "square", 4)]);
      const squareB = await withFlanges([flange("b", top.index, "square", 4), flange("a", right.index, "square", 4)]);
      assert(designOf(squareA).features.every((feature) => feature.health === undefined) && designOf(squareB).features.every((feature) => feature.health === undefined), "no step is flagged");
      for (const candidate of [straight, squareA, squareB]) assert(isClosedAndOriented(bodyOf(candidate).indices) && solidMetrics(bodyOf(candidate).positionsMm, bodyOf(candidate).indices).outward, "closed and outward");
      near(volumeOf(bodyOf(squareA)), volumeOf(bodyOf(squareB)), 1e-6 * volumeOf(bodyOf(squareA)) + 1e-3, "the order the flanges are added in does not change the result");
      // Square notch of 4: the flanges stop 4 short of the corner instead of 2, and 4 x 4 x 2 comes out of the plate corner.
      const flangeVolume = (LENGTH * THICKNESS + (Math.PI / 4) * ((RADIUS + THICKNESS) ** 2 - RADIUS ** 2));
      const expectedDifference = 16 * THICKNESS + flangeVolume * 2 * 2;
      near(volumeOf(bodyOf(straight)) - volumeOf(bodyOf(squareA)), expectedDifference, expectedDifference * 0.03, "a square notch has less material than a straight gap: 2 mm more flange off each strip plus the corner");
      // Suppressing one flange takes the notch away with it.
      const suppressed = run(squareA, { kind: "set-design-feature-suppressed", featureId: "feature:b", suppressed: true });
      const single = run(suppressed, { kind: "regenerate-design", results: await replayAllBodies(suppressed) });
      const singleBody = bodyOf(single);
      assert(isClosedAndOriented(singleBody.indices), "one flange alone is closed");
      let corner = false;
      for (let i = 0; i < singleBody.positionsMm.length; i += 3) if (Math.abs(singleBody.positionsMm[i]! - right.startMm[0]!) < 1e-6 && Math.abs(singleBody.positionsMm[i + 1]! - top.startMm[1]!) < 1e-6 && Math.abs(singleBody.positionsMm[i + 2]! - 2) < 1e-6) corner = true;
      assert(corner, "without the second flange the plate keeps its corner");
      // The unfolded blank follows the same shapes.
      const flat = await flatPatternForBody(squareA, "general-body:sheet");
      assert(flat.ok, `flat pattern: ${flat.ok ? "" : flat.message}`);
      if (flat.ok) equal(flat.notes.length, 0, "no corner-relief warning with a notch");
      const flatStraight = await flatPatternForBody(straight, "general-body:sheet");
      if (flat.ok && flatStraight.ok) assert(flat.layout.outlinesMm[0]!.length !== flatStraight.layout.outlinesMm[0]!.length || Math.abs(area(flat.layout.outlinesMm[0]!) - area(flatStraight.layout.outlinesMm[0]!)) > 1, "the blank differs from the straight-gap blank");
      // Payload and dialog.
      const good = flange("v", 2, "round", 3);
      assert(validSolidFeaturePayload(good), "a round relief shape is accepted");
      assert(!validSolidFeaturePayload({ ...good, flangeReliefShape: "triangle" as never }), "an unknown shape is refused");
      assert(!validSolidFeaturePayload({ ...good, kind: "sheet-flange", operation: "new-body", sheetThicknessMm: 2, flangeLengthMm: 5 } as never), "a relief shape on another kind is refused");
      const fields = parameterFieldsOf(good)!;
      assert(fields.some((field) => field.id === "reliefShape"), "the dialog offers the relief shape");
      const edited = applyParameterValues(good, { ...parameterValuesOf(good), reliefShape: "square" });
      assert(edited.ok && edited.feature.flangeReliefShape === "square", "the dialog changes the shape");
      const reset = applyParameterValues(good, { ...parameterValuesOf(good), reliefShape: "straight" });
      assert(reset.ok && reset.feature.flangeReliefShape === undefined, "straight is stored as no shape");
    }
  }
];
