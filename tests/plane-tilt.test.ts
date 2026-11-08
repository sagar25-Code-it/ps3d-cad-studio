import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, describeFeature, designOf, validateWorkbenchProject, validSketchPlaneTilt } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { evaluateConstructionPlaneDefinition } from "../packages/workbench-geometry/src/construction-geometry.js";
import { tiltMatrix, tiltPoint, tiltPositions } from "../packages/workbench-geometry/src/plane-tilt.js";
import { sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { flatPatternForBody, replayAllBodies, rebuildSolidFeature, sketchNormal, throughAllOverride } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-tilt-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

/** A project whose committed sketch sits on `plane`, optionally offset and tilted. */
function tiltedSketch(tilt?: { axis: "x" | "y" | "z"; angleDeg: number }, plane: "datum:xy" | "datum:xz" | "datum:yz" = "datum:xy", offsetMm = 0): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  let project = run(createWorkbenchProject("project:test-tilt"), { kind: "set-sketch-plane", plane, ...(offsetMm === 0 ? {} : { offsetMm }), ...(tilt === undefined ? {} : { tilt }) });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  return { project, sketch: designOf(project).features[0] as DesignSketchFeature };
}

const step = (sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature =>
  ({ id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra });

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

export const planeTiltTests: readonly TestCase[] = [
  {
    name: "A tilt turns points the same way an angle construction plane turns its datum, and turning back undoes it",
    run: () => {
      for (const axis of ["x", "y", "z"] as const) {
        for (const base of ["datum:xy", "datum:xz", "datum:yz"] as const) {
          const frame = evaluateConstructionPlaneDefinition({ kind: "angle", basePlane: base, axis, angleDeg: 37 });
          assert(!("error" in frame), "angle plane evaluates");
          if ("error" in frame) return;
          const flat = evaluateConstructionPlaneDefinition({ kind: "offset", basePlane: base, offsetMm: 0 });
          if ("error" in flat) return;
          const turned = tiltPoint(flat.normal, { axis, angleDeg: 37 });
          for (let i = 0; i < 3; i += 1) near(turned[i]!, frame.normal[i]!, 1e-9, `${axis} tilt of ${base} normal, component ${i}`);
          const back = tiltPoint(turned, { axis, angleDeg: 37 }, true);
          for (let i = 0; i < 3; i += 1) near(back[i]!, flat.normal[i]!, 1e-9, "turning back restores the normal");
        }
      }
      const turned = tiltPositions([1, 0, 0, 0, 1, 0], { axis: "z", angleDeg: 90 });
      assert(Math.abs(turned[0]!) < 1e-12 && Math.abs(turned[1]! - 1) < 1e-12 && Math.abs(turned[3]! + 1) < 1e-12, "a quarter turn about Z sends +X to +Y and +Y to -X");
      assert(tiltMatrix({ axis: "x", angleDeg: 0 }).join() === "1,0,0,0,1,0,0,0,1", "no angle is the identity");
    }
  },
  {
    name: "A sketch tilt is stored, validated, described, survives committing and is replaced, not kept, by the next plane choice",
    run: () => {
      const { project, sketch } = tiltedSketch({ axis: "x", angleDeg: 30 });
      assert(project.sketch.planeTilt?.angleDeg === 30 && sketch.sketch.planeTilt?.axis === "x", "the tilt is on the sketch and on its committed step");
      assert(describeFeature(designOf(project), sketch).includes("tilted 30° about X"), `the step says it is tilted: ${describeFeature(designOf(project), sketch)}`);
      assert(validateWorkbenchProject(project).ok, "a tilted project validates");
      const level = run(project, { kind: "set-sketch-plane", plane: "datum:xy" });
      assert(level.sketch.planeTilt === undefined, "choosing the plane again without a tilt clears it");
      const fresh = run(project, { kind: "new-design-sketch", plane: "datum:yz" });
      assert(fresh.sketch.planeTilt === undefined, "a new sketch starts untilted");
      const again = run(project, { kind: "new-design-sketch", plane: "datum:xz", tilt: { axis: "y", angleDeg: -15 } });
      assert(again.sketch.planeTilt?.angleDeg === -15, "a new sketch can start tilted");
      assert(validSketchPlaneTilt({ axis: "z", angleDeg: 180 }) && validSketchPlaneTilt({ axis: "x", angleDeg: -45.5 }), "valid tilts");
      for (const bad of [{ axis: "w", angleDeg: 10 }, { axis: "x", angleDeg: 0 }, { axis: "x", angleDeg: 181 }, { axis: "x", angleDeg: Number.NaN }, { axis: "x" }, { axis: "x", angleDeg: 5, extra: 1 }, null, 5]) {
        assert(!validSketchPlaneTilt(bad), `rejected: ${JSON.stringify(bad)}`);
      }
      const result = applyWorkbenchOperation(project, { kind: "set-sketch-plane", plane: "datum:xy", tilt: { axis: "x", angleDeg: 0 }, operationId: "operation:test-tilt-bad", expectedRevision: project.revision } as WorkbenchOperation);
      assert(!result.ok, "an operation with a zero tilt is refused");
      const tampered = { ...project, sketch: { ...project.sketch, planeTilt: { axis: "q", angleDeg: 10 } } } as unknown as WorkbenchProject;
      assert(!validateWorkbenchProject(tampered).ok, "a saved project with a bad tilt is refused");
    }
  },
  {
    name: "A solid built on a tilted sketch is the same solid turned about the axis, with its face names, and it stays one closed body",
    run: async () => {
      const flatSetup = tiltedSketch();
      const tiltSetup = tiltedSketch({ axis: "x", angleDeg: 30 });
      const flat = await rebuildSolidFeature(step(flatSetup.sketch, "extrude", "slab", { valueMm: 8 }), flatSetup.sketch);
      const tilted = await rebuildSolidFeature(step(tiltSetup.sketch, "extrude", "slab", { valueMm: 8 }), tiltSetup.sketch);
      assert(flat.ok && tilted.ok, "both build");
      if (!flat.ok || !tilted.ok) return;
      near(solidMetrics(tilted.body.positionsMm, tilted.body.indices).volumeMm3, solidMetrics(flat.body.positionsMm, flat.body.indices).volumeMm3, 1e-6, "volume is unchanged by the turn");
      assert(solidMetrics(tilted.body.positionsMm, tilted.body.indices).outward, "winding points outward");
      assert(isClosedAndOriented(tilted.body.indices) === isClosedAndOriented(flat.body.indices), "the turn changes nothing about how the mesh is connected");
      const expected = tiltPositions(flat.body.positionsMm, { axis: "x", angleDeg: 30 });
      for (let i = 0; i < expected.length; i += 1) near(tilted.body.positionsMm[i]!, expected[i]!, 1e-9, `vertex coordinate ${i}`);
      assert(JSON.stringify(tilted.body.brep?.faces.map((face) => face.role)) === JSON.stringify(flat.body.brep?.faces.map((face) => face.role)), "the face names are kept");
      const normal = sketchNormal(tiltSetup.sketch);
      near(normal[1]!, -Math.sin(Math.PI / 6), 1e-9, "the tilted sketch normal leans by 30° about X");
      near(normal[2]!, Math.cos(Math.PI / 6), 1e-9, "and keeps its Z share");
      const heights = tilted.body.positionsMm.filter((_, i) => i % 3 === 2);
      assert(Math.max(...heights) - Math.min(...heights) > 8, "the tilted slab is taller than its 8 mm thickness");
      const offsetSetup = tiltedSketch({ axis: "y", angleDeg: 90 }, "datum:xy", 5);
      const offset = await rebuildSolidFeature(step(offsetSetup.sketch, "extrude", "off", { valueMm: 4 }), offsetSetup.sketch);
      assert(offset.ok, "an offset and tilted sketch builds");
      if (offset.ok) {
        const xs = offset.body.positionsMm.filter((_, i) => i % 3 === 0);
        near(Math.min(...xs), 5, 1e-6, "the offset is applied first, along the datum normal, and then turned (Z at 5 becomes X at 5)");
        near(Math.max(...xs), 9, 1e-6, "and the 4 mm extrusion rises along the turned normal");
      }
    }
  },
  {
    name: "Through-all, edge flanges and the flat pattern all work on a plate that sits on a tilted plane",
    run: async () => {
      const level = tiltedSketch();
      const slope = tiltedSketch({ axis: "y", angleDeg: 35 });
      const baseOf = (setup: ReturnType<typeof tiltedSketch>): DesignSolidFeature => step(setup.sketch, "sheet-base", "plate", { sheetThicknessMm: 2, valueMm: 2 });
      const projects: WorkbenchProject[] = [];
      for (const setup of [level, slope]) {
        const base = baseOf(setup);
        const built = await rebuildSolidFeature(base, setup.sketch);
        assert(built.ok, "plate builds");
        if (!built.ok) return;
        let current = run(setup.project, { kind: "add-design-solid", feature: base, body: built.body });
        const frame = sheetFrameOf(built.body, sketchNormal(setup.sketch));
        assert(frame !== undefined && frame.edges.length >= 4, "the plate's top face and edges are found along the tilted normal");
        if (frame === undefined) return;
        const edge = frame.edges.find((candidate) => candidate.lengthMm > 0)!;
        const flange = step(setup.sketch, "sheet-edge-flange", "lip", { bodyId: "general-body:plate", operation: "direct-edit", flangeEdgeIndex: edge.index, sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90 });
        const added = run(current, { kind: "add-design-solid", feature: flange, body: current.part.generalBodies!.find((body) => body.id === "general-body:plate")! });
        const results = await replayAllBodies(added);
        assert(results.every((result) => result.message === undefined), `the flange replays on the tilted plate: ${results.map((result) => result.message ?? "").join("; ")}`);
        current = run(added, { kind: "regenerate-design", results });
        const body = current.part.generalBodies!.find((candidate) => candidate.id === "general-body:plate")!;
        assert(isClosedAndOriented(body.indices), "the flanged tilted plate is closed");
        projects.push(current);
      }
      const [flatOutcome, tiltedOutcome] = [await flatPatternForBody(projects[0]!, "general-body:plate"), await flatPatternForBody(projects[1]!, "general-body:plate")];
      assert(flatOutcome.ok && tiltedOutcome.ok, `both unfold: ${flatOutcome.ok ? "" : flatOutcome.message} ${tiltedOutcome.ok ? "" : tiltedOutcome.message}`);
      if (flatOutcome.ok && tiltedOutcome.ok) assert(flatOutcome.summary === tiltedOutcome.summary, `a tilted plate unfolds to the same blank (${flatOutcome.summary} vs ${tiltedOutcome.summary})`);
      // Through-all measures along the tilted axis.
      const tiltedBody = projects[1]!.part.generalBodies!.find((candidate) => candidate.id === "general-body:plate")!;
      const cut = throughAllOverride(step(slope.sketch, "extrude", "cut", { extent: "through-all" }), slope.sketch, tiltedBody);
      const levelBody = projects[0]!.part.generalBodies!.find((candidate) => candidate.id === "general-body:plate")!;
      const levelCut = throughAllOverride(step(level.sketch, "extrude", "cut", { extent: "through-all" }), level.sketch, levelBody);
      near(cut.valueMm, levelCut.valueMm, 1e-6, "the same plate needs the same through-all reach on a tilted plane");
      assert(dot(sketchNormal(slope.sketch), [0, 0, 1]) < 0.9, "and that plane really is tilted");
    }
  }
];
