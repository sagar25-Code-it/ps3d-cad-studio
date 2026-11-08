import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { COARSE_PITCH_MM, cosmeticThreadCurves, cosmeticThreadOf, tapDrillDiameterMm, threadGroove, threadProblem, threadRadiusMm, type HoleThread } from "../packages/workbench-geometry/src/hole-thread.js";
import { threadBoreWall } from "../packages/workbench-geometry/src/hole-thread-cut.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { applyParameterValues, parameterFieldsOf, parameterValuesOf } from "../apps/studio-web/src/feature-parameters.js";
import { drillHole, holeSpecOf, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { holeThreadsOf, withCosmeticThreads } from "../apps/studio-web/src/hole-threads.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-thread-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const volumeOf = (mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(mesh.positionsMm, mesh.indices).volumeMm3;
const block = (): { positionsMm: number[]; indices: number[] } => {
  const mesh = tessellateExtrude([[-20, -15], [20, -15], [20, 15], [-20, 15]], 10, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
};

/** The volume of the threaded bore between two depths by integrating the defining radius function on a fine grid: independent of the mesh. */
function analyticBoreVolume(minorDiameter: number, thread: HoleThread, holeDepth: number, from: number, to: number): number {
  let total = 0;
  const nz = 3000;
  const nt = 240;
  const dz = (to - from) / nz;
  for (let i = 0; i < nz; i += 1) {
    const d = from + (i + 0.5) * dz;
    for (let j = 0; j < nt; j += 1) {
      const angle = ((j + 0.5) / nt) * Math.PI * 2;
      const r = threadRadiusMm(minorDiameter, thread, holeDepth, d, angle);
      total += 0.5 * r * r * ((Math.PI * 2) / nt) * dz;
    }
  }
  return total;
}

const holeStep = (sketch: DesignSketchFeature, extra: Partial<DesignSolidFeature>): DesignSolidFeature => ({
  id: "feature:tapped", name: "M6 tapped hole", kind: "hole", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 4.9175, bodyId: "general-body:plate", operation: "direct-edit",
  holeStyle: "simple", holePositionMm: [0, 0, 10], holeNormal: [0, 0, 1], holeDiameterMm: 4.9175, holeDepthMm: 0, ...extra
});
function tessellateBlock(x: number, y: number, z: number): { positionsMm: number[]; indices: number[] } {
  const mesh = tessellateExtrude([[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]], z, "xy");
  return { positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}
const sketchless = { id: "feature:sketch-1" } as DesignSketchFeature;
const thread = (mode: "cosmetic" | "modelled", extra: Partial<NonNullable<DesignSolidFeature["holeThread"]>> = {}): NonNullable<DesignSolidFeature["holeThread"]> => ({ mode, pitchMm: 1, majorDiameterMm: 6, handedness: "right", ...extra });

/** Mean angle (degrees, about +Z, counter-clockwise seen from above) of the cutter vertices on the crest of the groove at a given depth ring. */
function crestAngleDeg(positions: readonly number[], ringStart: number, segments: number, origin: readonly [number, number]): number {
  let max = 0;
  const radii: number[] = [];
  for (let j = 0; j < segments; j += 1) {
    const r = Math.hypot(positions[(ringStart + j) * 3]! - origin[0], positions[(ringStart + j) * 3 + 1]! - origin[1]);
    radii.push(r);
    if (r > max) max = r;
  }
  let x = 0;
  let y = 0;
  for (let j = 0; j < segments; j += 1) {
    if (radii[j]! < max - 1e-6) continue;
    const angle = Math.atan2(positions[(ringStart + j) * 3 + 1]! - origin[1], positions[(ringStart + j) * 3]! - origin[0]);
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export const holeThreadTests: readonly TestCase[] = [
  {
    name: "the thread groove is a trapezoid of period one with flats at root and crest, and tap-drill sizes follow ISO",
    run: () => {
      near(threadGroove(0), 1, 1e-12, "crest at phase 0");
      near(threadGroove(0.5), 0, 1e-12, "root at phase 1/2");
      near(threadGroove(1.03), threadGroove(0.03), 1e-12, "periodic");
      near(threadGroove(0.25), 0.5, 1e-9, "half way up the flank");
      near(tapDrillDiameterMm(6, 1), 4.9175, 1e-3, "M6x1 tap drill is 4.92 mm");
      near(tapDrillDiameterMm(8, COARSE_PITCH_MM[8]!), 6.647, 1e-3, "M8x1.25 tap drill is 6.65 mm");
      assert(threadProblem({ mode: "modelled", pitchMm: 1, majorDiameterMm: 6, handedness: "right" }, 6) !== undefined, "major must exceed minor");
      assert(threadProblem({ mode: "modelled", pitchMm: 0.3, majorDiameterMm: 6, handedness: "right" }, 4.9) !== undefined, "a groove deeper than the pitch is refused");
      equal(threadProblem({ mode: "modelled", pitchMm: 1, majorDiameterMm: 6, handedness: "right" }, 4.9175), undefined, "M6x1 on a 4.92 bore is fine");
    }
  },
  {
    name: "threadBoreWall rebuilds a drilled bore's wall into a helical groove: closed, outward, the analytic volume, major diameter at the groove and tap-drill diameter at the crests",
    run: () => {
      const part = block();
      const full = volumeOf(part);
      const step = holeStep(sketchless, { holeThread: thread("modelled") });
      const spec = holeSpecOf(step, part)!;
      const plain = drillHole(holeStep(sketchless, {}), part);
      assert(plain.ok, "the plain tap-drill bore drills");
      if (!plain.ok) return;
      const wall = threadBoreWall(plain, spec, spec.thread!);
      assert(wall.ok, `thread: ${wall.ok ? "" : wall.message}`);
      if (!wall.ok) return;
      assert(isClosedAndOriented(wall.indices), "the threaded block is a closed, consistently wound mesh");
      assert(solidMetrics(wall.positionsMm, wall.indices).outward, "and points outward");
      const bore = Math.PI * (4.9175 / 2) ** 2 * 10;
      const expected = analyticBoreVolume(4.9175, spec.thread!, spec.depthMm, 0, 10);
      const removed = full - volumeOf(wall);
      near(removed, expected, expected * 0.02, `material removed matches the analytic helical groove (${removed.toFixed(2)} vs ${expected.toFixed(2)})`);
      assert(removed > bore * 1.1, "the thread takes more than the plain bore");
      let outermost = 0;
      let innermost = Infinity;
      for (let i = 0; i < wall.positionsMm.length; i += 3) {
        const r = Math.hypot(wall.positionsMm[i]!, wall.positionsMm[i + 1]!);
        if (r < 4) { outermost = Math.max(outermost, r); innermost = Math.min(innermost, r); }
      }
      near(outermost, 3, 1e-3, "the groove reaches the 6 mm major diameter");
      near(innermost, 4.9175 / 2, 5e-3, "the crests of the thread are at the tap-drill diameter");

      // A thread shorter than the hole runs out into the plain bore.
      const shortStep = holeStep(sketchless, { holeThread: thread("modelled", { lengthMm: 4 }) });
      const shortSpec = holeSpecOf(shortStep, part)!;
      const shortWall = threadBoreWall(plain, shortSpec, shortSpec.thread!);
      assert(shortWall.ok, `short thread: ${shortWall.ok ? "" : shortWall.message}`);
      if (shortWall.ok) {
        assert(isClosedAndOriented(shortWall.indices), "short thread closed");
        const shortExpected = analyticBoreVolume(4.9175, shortSpec.thread!, shortSpec.depthMm, 0, 10);
        near(full - volumeOf(shortWall), shortExpected, shortExpected * 0.02, "the short thread matches its analytic volume");
        let deep = 0;
        for (let i = 0; i < shortWall.positionsMm.length; i += 3) if (shortWall.positionsMm[i + 2]! < 10 - 4.001 && Math.hypot(shortWall.positionsMm[i]!, shortWall.positionsMm[i + 1]!) < 4) deep = Math.max(deep, Math.hypot(shortWall.positionsMm[i]!, shortWall.positionsMm[i + 1]!));
        near(deep, 4.9175 / 2, 5e-3, "below the thread's 4 mm the bore is the plain tap-drill size");
        assert(removed > full - volumeOf(shortWall), "a shorter thread removes less than a full one");
      }

      // Things it must refuse, leaving the body as it was.
      assert(!threadBoreWall(plain, { ...spec, style: "counterbore" }, spec.thread!).ok, "counterbore holes cannot carry a modelled thread");
      assert(!threadBoreWall(plain, spec, thread("modelled", { majorDiameterMm: 4 })).ok, "a major diameter below the bore is refused");
      assert(!threadBoreWall(part, spec, spec.thread!).ok, "a body with no bore has no wall to thread");
      const nearEdge = holeStep(sketchless, { holeThread: thread("modelled"), holePositionMm: [-17.4, 0, 10] });
      const nearPlain = drillHole(holeStep(sketchless, { holePositionMm: [-17.4, 0, 10] }), part);
      assert(nearPlain.ok, "the plain hole fits 2.6 mm from the edge");
      if (nearPlain.ok) {
        const refused = threadBoreWall(nearPlain, holeSpecOf(nearEdge, part)!, thread("modelled"));
        assert(!refused.ok && refused.message.includes("edge"), "a thread that would break through the edge of the face is refused with a clear reason");
      }
    }
  },
  {
    name: "right- and left-handed threads are mirror helices: a right-hand groove crest turns clockwise (seen from the face) as it goes deeper",
    run: () => {
      const part = block();
      const plain = drillHole(holeStep(sketchless, {}), part);
      assert(plain.ok, "bore");
      if (!plain.ok) return;
      const crestAngle = (positions: readonly number[], z: number): number => {
        let max = 0;
        const hits: { r: number; angle: number }[] = [];
        for (let i = 0; i < positions.length; i += 3) {
          if (Math.abs(positions[i + 2]! - z) > 1e-6) continue;
          const r = Math.hypot(positions[i]!, positions[i + 1]!);
          if (r > 4) continue;
          hits.push({ r, angle: Math.atan2(positions[i + 1]!, positions[i]!) });
          if (r > max) max = r;
        }
        assert(hits.length >= 40, `the ring at z=${z} has its vertices (found ${hits.length})`);
        let x = 0;
        let y = 0;
        for (const hit of hits) if (hit.r > max - 1e-6) { x += Math.cos(hit.angle); y += Math.sin(hit.angle); }
        return (Math.atan2(y, x) * 180) / Math.PI;
      };
      for (const [handedness, expected] of [["right", -90], ["left", 90]] as const) {
        const spec = holeSpecOf(holeStep(sketchless, { holeThread: thread("modelled", { handedness }) }), part)!;
        const wall = threadBoreWall(plain, spec, spec.thread!);
        assert(wall.ok, `${handedness} thread builds`);
        if (!wall.ok) return;
        // Depth 3 mm and 3.25 mm: a quarter pitch apart.
        let delta = crestAngle(wall.positionsMm, 10 - 3.25) - crestAngle(wall.positionsMm, 10 - 3);
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        near(delta, expected, 9, `${handedness}-hand: a quarter pitch deeper the crest has turned ${expected} degrees`);
      }
    }
  },
  {
    name: "drillHole cuts a modelled tapped hole (including the M6 tap-drill size that used to break the Boolean's weld) and a cosmetic thread changes no geometry",
    run: () => {
      const part = block();
      const full = volumeOf(part);
      const modelled = drillHole(holeStep(sketchless, { holeThread: thread("modelled") }), part);
      assert(modelled.ok, `modelled: ${modelled.ok ? "" : modelled.message}`);
      if (modelled.ok) assert(isClosedAndOriented(modelled.indices) && full - volumeOf(modelled) > Math.PI * (4.9175 / 2) ** 2 * 10 * 1.1, "closed, and more material gone than the plain bore");
      const cosmetic = drillHole(holeStep(sketchless, { holeThread: thread("cosmetic") }), part);
      const plain = drillHole(holeStep(sketchless, {}), part);
      assert(cosmetic.ok && plain.ok, "cosmetic and plain holes drill (a 4.9175 mm hole at 60 degrees used to land on a weld rounding boundary and be refused)");
      if (cosmetic.ok && plain.ok) near(volumeOf(cosmetic), volumeOf(plain), 1e-6, "a cosmetic thread changes no geometry");
      const severing = drillHole(holeStep(sketchless, { holeThread: thread("modelled", { majorDiameterMm: 6 }), holeDiameterMm: 4.9175, holePositionMm: [0, 0, 10] }), tessellateBlock(40, 4, 10));
      assert(!severing.ok, "a modelled thread in a hole that severs the body is refused rather than mangled");
    }
  },
  {
    name: "a blind modelled thread through the real timeline replays, follows suppress and edits, and a cosmetic thread annotates without cutting",
    run: async () => {
      let project = run(createWorkbenchProject("project:test-thread"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketch = designOf(project).features[0] as DesignSketchFeature;
      const base: DesignSolidFeature = { id: "feature:plate", name: "plate", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 12, bodyId: "general-body:plate" };
      const built = await rebuildSolidFeature(base, sketch);
      assert(built.ok, "plate builds");
      if (!built.ok) return;
      project = run(project, { kind: "add-design-solid", feature: base, body: built.body });
      const plateVolume = volumeOf(built.body);
      const hole = holeStep(sketch, { holePositionMm: [15, 0, 12], holeDepthMm: 8, holeThread: thread("modelled", { lengthMm: 6 }) });
      assert(validSolidFeaturePayload(hole), "the threaded hole step passes the saved-project validator");
      const added = run(project, { kind: "add-design-solid", feature: hole, body: built.body });
      project = run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
      const tapped = project.part.generalBodies!.find((body) => body.id === "general-body:plate")!;
      assert(isClosedAndOriented(tapped.indices), "tapped plate is closed");
      const bore = Math.PI * (4.9175 / 2) ** 2 * 8;
      const threadedRemoval = plateVolume - volumeOf(tapped);
      const expectedRemoval = analyticBoreVolume(4.9175, hole.holeThread!, 8, 0, 8);
      near(threadedRemoval, expectedRemoval, expectedRemoval * 0.02, `the blind thread removed ${threadedRemoval.toFixed(1)} mm3; the analytic helical bore is ${expectedRemoval.toFixed(1)} (a plain 8 mm bore is ${bore.toFixed(1)})`);
      assert(threadedRemoval > bore * 1.05, "more than the plain bore");
      assert(validateWorkbenchProject(project).ok, "project with the threaded hole validates");
      equal(designOf(project).features.find((feature) => feature.id === "feature:tapped")?.health, undefined, "the step is healthy");

      const suppressed = run(project, { kind: "set-design-feature-suppressed", featureId: "feature:tapped", suppressed: true });
      const without = run(suppressed, { kind: "regenerate-design", results: await replayAllBodies(suppressed) });
      near(volumeOf(without.part.generalBodies![0]!), plateVolume, 1e-6, "suppressing the tapped hole restores the plate");

      // Switching the same step to a cosmetic thread keeps the hole but loses the groove.
      const asCosmetic = run(project, { kind: "update-design-solid", feature: { ...hole, holeThread: thread("cosmetic", { lengthMm: 6 }) }, body: tapped });
      const cosmeticProject = run(asCosmetic, { kind: "regenerate-design", results: await replayAllBodies(asCosmetic) });
      near(plateVolume - volumeOf(cosmeticProject.part.generalBodies![0]!), bore, bore * 0.03, "cosmetic: only the plain 8 mm bore is removed");
      const annotations = holeThreadsOf(cosmeticProject);
      equal(annotations.length, 1, "one thread annotation");
      equal(annotations[0]!.thread.designation, "M6x1", "annotated as M6x1");
      near(annotations[0]!.thread.lengthMm, 6, 1e-9, "annotated length");
      const curves = cosmeticThreadCurves(annotations[0]!.thread);
      near(Math.hypot(curves[0]![0]![0] - 15, curves[0]![0]![1]), 3, 1e-9, "the major circle is 6 mm across, at the face");
      near(curves[1]![0]![2], 12 - 6, 1e-9, "the minor circle sits at the thread's end, 6 mm below the face");
      const scene = withCosmeticThreads({ id: "part-scene:test", kind: "part", primitives: [], boundsMm: { min: [0, 0, 0], max: [1, 1, 1] } } as never, cosmeticProject);
      equal(scene.primitives.length, 3, "the part scene gets three cosmetic lines for the hole");
      equal(withCosmeticThreads(scene, suppressed).primitives.length, 3 + 0, "a suppressed hole adds none (the scene passed in is already extended)");
      equal(holeThreadsOf(suppressed).length, 0, "a suppressed hole has no annotation");
    }
  },
  {
    name: "hole thread payloads are validated, and the inspector switches a hole between plain, cosmetic and modelled",
    run: () => {
      const good = holeStep(sketchless, { holeThread: thread("modelled") });
      assert(validSolidFeaturePayload(good), "valid thread accepted");
      assert(!validSolidFeaturePayload(holeStep(sketchless, { holeThread: thread("modelled", { majorDiameterMm: 4 }) })), "major below the hole diameter refused");
      assert(!validSolidFeaturePayload(holeStep(sketchless, { holeThread: thread("modelled", { majorDiameterMm: 9 }) })), "a groove deeper than twice the pitch refused");
      assert(!validSolidFeaturePayload(holeStep(sketchless, { holeStyle: "counterbore", holeCounterDiameterMm: 9, holeCounterDepthMm: 3, holeThread: thread("cosmetic") })), "counterbore holes carry no thread");
      assert(!validSolidFeaturePayload(holeStep(sketchless, { holeThread: { ...thread("modelled"), handedness: "sideways" as never } })), "unknown handedness refused");
      assert(!validSolidFeaturePayload({ ...holeStep(sketchless, {}), kind: "extrude", holeThread: thread("cosmetic") } as never), "other kinds carry no hole thread");
      const plain = holeStep(sketchless, {});
      const fields = parameterFieldsOf(plain)!;
      assert(fields.some((field) => field.id === "thread") && fields.some((field) => field.id === "threadPitch"), "the inspector offers thread fields for a plain hole");
      const values = { ...parameterValuesOf(plain), thread: "modelled", threadPitch: "1.25", threadMajor: "6.4" };
      const applied = applyParameterValues(plain, values);
      assert(applied.ok, `switch to modelled: ${applied.ok ? "" : applied.message}`);
      if (applied.ok) {
        equal(applied.feature.holeThread?.mode, "modelled", "now modelled");
        equal(applied.feature.holeThread?.pitchMm, 1.25, "pitch typed in");
        equal(applied.feature.holeThread?.majorDiameterMm, 6.4, "major typed in");
        const back = applyParameterValues(applied.feature, { ...parameterValuesOf(applied.feature), thread: "none" });
        assert(back.ok && back.feature.holeThread === undefined, "back to a plain hole");
        const bad = applyParameterValues(applied.feature, { ...parameterValuesOf(applied.feature), threadMajor: "4" });
        assert(!bad.ok, "an impossible major diameter is refused by the validator");
      }
      const spec = holeSpecOf(good, { positionsMm: [0, 0, 0, 0, 0, -10] });
      equal(spec?.thread?.mode, "modelled", "the hole spec carries the thread");
      equal(cosmeticThreadOf(spec!, spec!.thread!).designation, "M6x1", "designation of the annotation");
      equal(cosmeticThreadOf({ ...spec!, thread: thread("cosmetic", { handedness: "left", pitchMm: 1.25 }) }, thread("cosmetic", { handedness: "left", pitchMm: 1.25 })).designation, "M6x1.25-LH", "left-hand designation");
    }
  }
];
