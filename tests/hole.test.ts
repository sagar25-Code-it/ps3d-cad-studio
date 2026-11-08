import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { countersinkDepthMm, holeCutter, snapToAxis, type HoleSpec } from "../packages/workbench-geometry/src/hole.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { applyParameterValues, parameterFieldsOf } from "../apps/studio-web/src/feature-parameters.js";
import { attachEdgeFlange, sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { drillHole, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-hole-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function withSketch(): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  const project = run(createWorkbenchProject("project:test-hole"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  return { project, sketch: designOf(project).features[0] as DesignSketchFeature };
}

const step = (sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra });

const volumeOf = (mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(mesh.positionsMm, mesh.indices).volumeMm3;
const holeStep = (sketch: DesignSketchFeature, id: string, extra: Partial<DesignSolidFeature>): DesignSolidFeature =>
  step(sketch, "hole", id, { operation: "direct-edit", holeStyle: "simple", holePositionMm: [20, 15, 10], holeNormal: [0, 0, 1], holeDiameterMm: 6, holeDepthMm: 0, ...extra });

export const holeTests: readonly TestCase[] = [
  {
    name: "holeCutter is a closed, outward solid for each style, and snapToAxis squares up a near-axis normal",
    run: () => {
      const base: HoleSpec = { style: "simple", originMm: [1, 2, 3], normal: [0, 0, 1], diameterMm: 6, depthMm: 10 };
      const specs: HoleSpec[] = [
        base,
        { ...base, style: "counterbore", counterDiameterMm: 11, counterDepthMm: 4 },
        { ...base, style: "countersink", sinkDiameterMm: 12, sinkAngleDeg: 90 },
        { ...base, normal: [1, 1, 1] },
        { ...base, normal: [0, -1, 0] }
      ];
      for (const spec of specs) {
        const cutter = holeCutter(spec);
        assert(cutter.ok, `${spec.style} cutter built: ${cutter.ok ? "" : cutter.message}`);
        if (!cutter.ok) return;
        assert(isClosedAndOriented(cutter.indices), `${spec.style} cutter is closed and consistently wound`);
        assert(solidMetrics(cutter.positionsMm, cutter.indices).outward, `${spec.style} cutter winding points outward`);
      }
      const simple = holeCutter(base);
      if (simple.ok) near(volumeOf(simple), Math.PI * 9 * 10.5, Math.PI * 9 * 10.5 * 0.02, "a simple cutter is a 6 mm cylinder of depth plus overshoot");
      near(countersinkDepthMm(12, 6, 90), 3, 1e-9, "a 90° countersink from Ø12 to Ø6 is 3 mm deep");
      const tilted = snapToAxis([0.00001, -0.00002, -1]);
      assert(tilted[0] === 0 && tilted[1] === 0 && tilted[2] === -1, "a hair-off normal snaps to -Z");
      near(Math.hypot(...snapToAxis([1, 1, 0])), 1, 1e-9, "a real slant is only normalised");
      assert(!holeCutter({ ...base, normal: [0, 0, 0] }).ok, "no direction, no hole");
      assert(!holeCutter({ ...base, style: "counterbore", counterDiameterMm: 4, counterDepthMm: 4 }).ok, "a pocket narrower than the hole is refused");
      assert(!holeCutter({ ...base, style: "countersink", sinkDiameterMm: 12, sinkAngleDeg: 90, depthMm: 2 }).ok, "a cone deeper than the hole is refused");
    }
  },
  {
    name: "drillHole removes exactly the hole's volume from a block, from any face, through or blind, and keeps a closed solid",
    run: () => {
      const mesh = tessellateExtrude([[0, 0], [40, 0], [40, 30], [0, 30]], 10, "xy");
      const block = { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
      const full = volumeOf(block);
      const sketchless = { id: "feature:sketch-1" } as DesignSketchFeature;
      const through = drillHole(holeStep(sketchless, "t", {}), block);
      assert(through.ok, `through hole: ${through.ok ? "" : through.message}`);
      if (through.ok) {
        assert(isClosedAndOriented(through.indices), "through hole leaves a closed mesh");
        near(full - volumeOf(through), Math.PI * 9 * 10, Math.PI * 9 * 10 * 0.03, "through hole volume");
      }
      const blind = drillHole(holeStep(sketchless, "b", { holeDepthMm: 4 }), block);
      assert(blind.ok, "blind hole");
      if (blind.ok) {
        assert(isClosedAndOriented(blind.indices), "blind hole closed");
        near(full - volumeOf(blind), Math.PI * 9 * 4, Math.PI * 9 * 4 * 0.03, "blind hole volume");
      }
      const bore = drillHole(holeStep(sketchless, "cb", { holeStyle: "counterbore", holeCounterDiameterMm: 11, holeCounterDepthMm: 3 }), block);
      assert(bore.ok, `counterbore: ${bore.ok ? "" : bore.message}`);
      const boreVolume = Math.PI * 5.5 * 5.5 * 3 + Math.PI * 9 * 7;
      if (bore.ok) near(full - volumeOf(bore), boreVolume, boreVolume * 0.03, "counterbore volume");
      const sink = drillHole(holeStep(sketchless, "cs", { holeStyle: "countersink", holeSinkDiameterMm: 12, holeSinkAngleDeg: 90 }), block);
      assert(sink.ok, `countersink: ${sink.ok ? "" : sink.message}`);
      const coneVolume = (Math.PI * 3 / 3) * (6 * 6 + 6 * 3 + 3 * 3) + Math.PI * 9 * 7;
      if (sink.ok) near(full - volumeOf(sink), coneVolume, coneVolume * 0.03, "countersink volume");
      const fromBelow = drillHole(holeStep(sketchless, "bot", { holePositionMm: [20, 15, 0], holeNormal: [0, 0, -1], holeDepthMm: 3 }), block);
      assert(fromBelow.ok, "from the bottom face");
      if (fromBelow.ok) near(full - volumeOf(fromBelow), Math.PI * 9 * 3, Math.PI * 9 * 3 * 0.03, "bottom hole volume");
      const fromSide = drillHole(holeStep(sketchless, "side", { holePositionMm: [40, 15, 5], holeNormal: [1, 0, 0], holeDiameterMm: 4, holeDepthMm: 0 }), block);
      assert(fromSide.ok, "from a side face");
      if (fromSide.ok) {
        assert(isClosedAndOriented(fromSide.indices), "side hole closed");
        near(full - volumeOf(fromSide), Math.PI * 4 * 40, Math.PI * 4 * 40 * 0.03, "side hole goes the whole 40 mm");
      }
      assert(!drillHole(holeStep(sketchless, "miss", { holePositionMm: [200, 200, 10] }), block).ok, "a hole that misses the body is reported, not silently ignored");
      assert(!drillHole({ ...holeStep(sketchless, "bad", {}), holePositionMm: undefined as never }, block).ok, "a hole with no position is reported");
    }
  },
  {
    name: "A hole drilled through a bent flange removes just the wall it passes through",
    run: () => {
      const mesh = tessellateExtrude([[0, 0], [70, 0], [70, 40], [0, 40]], 2, "xy");
      const plate = { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
      const rightEdge = sheetFrameOf(plate, [0, 0, 1])!.edges.find((edge) => edge.outward[0] > 0.99)!.index;
      const flanged = attachEdgeFlange(plate, plate, [0, 0, 1], { edgeIndex: rightEdge, innerRadiusMm: 2, flangeLengthMm: 15, angleDeg: 90 });
      assert(flanged.ok, "flange builds");
      if (!flanged.ok) return;
      const sketchless = { id: "feature:sketch-1" } as DesignSketchFeature;
      const xs = flanged.positionsMm.filter((_, index) => index % 3 === 0);
      const wallX = Math.max(...xs);
      const drilled = drillHole(holeStep(sketchless, "fl", { holePositionMm: [wallX, 20, 12], holeNormal: [1, 0, 0], holeDiameterMm: 5.5, holeDepthMm: 0 }), flanged);
      assert(drilled.ok, `hole in the flange: ${drilled.ok ? "" : drilled.message}`);
      if (!drilled.ok) return;
      assert(isClosedAndOriented(drilled.indices), "the drilled flange stays closed");
      const removed = volumeOf(flanged) - volumeOf(drilled);
      near(removed, Math.PI * 2.75 * 2.75 * 2, Math.PI * 2.75 * 2.75 * 2 * 0.05, `the hole takes only the 2 mm wall (removed ${removed.toFixed(1)} mm³)`);
    }
  },
  {
    name: "A hole step round-trips through the real timeline: replay drills it, a suppressed hole is skipped, the dialog edits it and bad payloads are refused",
    run: async () => {
      const { project, sketch } = withSketch();
      const base = step(sketch, "sheet-base", "plate", { sheetThicknessMm: 6, valueMm: 6 });
      const built = await rebuildSolidFeature(base, sketch);
      assert(built.ok, "plate builds");
      if (!built.ok) return;
      const bodyId = "general-body:plate";
      const xs = built.body.positionsMm.filter((_, index) => index % 3 === 0);
      const ys = built.body.positionsMm.filter((_, index) => index % 3 === 1);
      const centre: [number, number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, 6];
      const solid = volumeOf(built.body);
      let current = run(project, { kind: "add-design-solid", feature: base, body: built.body });
      const hole = holeStep(sketch, "drill", { bodyId, holePositionMm: centre, holeNormal: [0, 0, 1], holeDiameterMm: 8 });
      const added = run(current, { kind: "add-design-solid", feature: hole, body: current.part.generalBodies!.find((body) => body.id === bodyId)! });
      current = run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
      const drilled = current.part.generalBodies!.find((body) => body.id === bodyId)!;
      assert(isClosedAndOriented(drilled.indices), "the replayed body stays closed");
      near(solid - volumeOf(drilled), Math.PI * 16 * 6, Math.PI * 16 * 6 * 0.03, "the replay removed the hole's volume");
      const off = run(current, { kind: "set-design-feature-suppressed", featureId: hole.id, suppressed: true });
      const replayed = run(off, { kind: "regenerate-design", results: await replayAllBodies(off) });
      const restored = replayed.part.generalBodies!.find((body) => body.id === bodyId)!;
      near(volumeOf(restored), solid, solid * 1e-6, "a suppressed hole leaves the plate whole");
      const fields = parameterFieldsOf(hole)!;
      assert(fields.some((field) => field.id === "diameter") && !fields.some((field) => field.id === "counterDiameter"), "a simple hole lists diameter but no pocket fields");
      const edited = applyParameterValues({ ...hole, name: "M8 simple hole Ø8.00" }, { position: centre.join(", "), diameter: "10", depth: "0" });
      assert(edited.ok && edited.feature.name === "M8 simple hole Ø10.00" && edited.feature.holeDiameterMm === 10, `dialog edit: ${edited.ok ? edited.feature.name : edited.message}`);
      assert(!applyParameterValues(hole, { position: centre.join(", "), diameter: "-2", depth: "0" }).ok, "a negative diameter is refused");
      const bore = holeStep(sketch, "bore", { holeStyle: "counterbore", holeCounterDiameterMm: 14, holeCounterDepthMm: 3 });
      assert(parameterFieldsOf(bore)!.some((field) => field.id === "counterDepth"), "a counterbore also lists its pocket");
      assert(validSolidFeaturePayload(bore), "a counterbore hole is accepted");
      assert(!validSolidFeaturePayload({ ...bore, holeCounterDiameterMm: 4 }), "a pocket narrower than the hole is rejected");
      const { holeCounterDiameterMm: _d, holeCounterDepthMm: _p, ...withoutPocket } = bore;
      void _d; void _p;
      assert(!validSolidFeaturePayload(withoutPocket), "a counterbore without its pocket is rejected");
      assert(!validSolidFeaturePayload({ ...hole, holeCounterDiameterMm: 12, holeCounterDepthMm: 3 }), "pocket numbers on a simple hole are rejected");
      assert(!validSolidFeaturePayload({ ...hole, holeNormal: [0, 0, 0] }), "a zero direction is rejected");
      assert(!validSolidFeaturePayload({ ...hole, operation: "cut" }), "a hole must be a direct edit");
      assert(!validSolidFeaturePayload({ ...hole, kind: "sheet-base", sheetThicknessMm: 2 }), "hole fields on another kind are rejected");
      const sink = holeStep(sketch, "sink", { holeStyle: "countersink", holeSinkDiameterMm: 16, holeSinkAngleDeg: 90 });
      assert(validSolidFeaturePayload(sink) && !validSolidFeaturePayload({ ...sink, holeSinkAngleDeg: 5 }), "a countersink needs a sensible angle");
    }
  }
];
