import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, parseWorkbenchProjectText, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { evaluateConstructionPlane } from "../packages/workbench-geometry/src/construction-geometry.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { rebuildSolidFeature, replayAllBodies, isRebuildFailure } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";

/*
 * These tests drive every solid kind through the same path the app uses: the real operation reducer (which validates the
 * feature AND the body it carries), the timeline replay, project validation and a save / load round trip. Unit tests of
 * the tessellators alone cannot catch a body or feature validator that does not know a kind, which is exactly what let
 * several kinds be refused in the live app.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-solid-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function withSketch(): { readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature } {
  const project = run(createWorkbenchProject("project:test-solid-integration"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0];
  assert(sketch?.kind === "sketch", "a sketch feature is in the timeline");
  return { project, sketch: sketch as DesignSketchFeature };
}

function feature(sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature {
  return { id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra };
}

async function addCreated(project: WorkbenchProject, sketch: DesignSketchFeature, step: DesignSolidFeature): Promise<WorkbenchProject> {
  const rebuilt = await rebuildSolidFeature(step, sketch);
  assert(rebuilt.ok, `${step.kind} builds: ${rebuilt.ok ? "" : rebuilt.message}`);
  if (!rebuilt.ok) return project;
  const next = run(project, { kind: "add-design-solid", feature: step, body: rebuilt.body });
  const valid = validateWorkbenchProject(next);
  assert(valid.ok, `${step.kind} leaves a valid project: ${valid.ok ? "" : valid.diagnostics[0]?.message ?? ""}`);
  const reloaded = parseWorkbenchProjectText(JSON.stringify(next));
  assert(reloaded.ok, `${step.kind} survives a save and load: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
  return next;
}

/** Adds a modifier step the way the app does (feature plus the current body), then replays the timeline and applies the result. */
async function addModifierAndReplay(project: WorkbenchProject, step: DesignSolidFeature): Promise<{ readonly project: WorkbenchProject; readonly messages: readonly string[] }> {
  const body = project.part.generalBodies?.find((candidate) => candidate.id === step.bodyId);
  assert(body !== undefined, "the body this step changes exists");
  const added = run(project, { kind: "add-design-solid", feature: step, body: body! });
  const results = await replayAllBodies(added);
  const applied = run(added, { kind: "regenerate-design", results });
  assert(validateWorkbenchProject(applied).ok, `${step.kind} leaves a valid project after replay`);
  return { project: applied, messages: results.flatMap((result) => !isRebuildFailure(result) ? [] : [result.message!]) };
}

const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => project.part.generalBodies!.find((body) => body.id === id)!;

const CREATED: readonly { readonly kind: DesignSolidFeature["kind"]; readonly extra: Partial<DesignSolidFeature> }[] = [
  { kind: "sweep", extra: { sweepDirectionMm: [0.2, 0, 1], sweepTwistDeg: 15 } },
  { kind: "loft", extra: { loftTopScale: 0.7 } },
  { kind: "edge-fillet", extra: { edge: { kind: "fillet", sizeMm: 1 } } },
  { kind: "edge-chamfer", extra: { edge: { kind: "chamfer", sizeMm: 1 } } },
  { kind: "shell", extra: { shellThicknessMm: 2, shellOpenFace: "top" } },
  { kind: "draft", extra: { draftAngleDeg: 5, draftNeutralFace: "bottom" } },
  { kind: "helix", extra: { helixRadiusMm: 20, helixPitchMm: 5, helixTurns: 3, helixHandedness: "right" } },
  { kind: "thread", extra: { threadPitchMm: 2, threadTurns: 4, threadDepthMm: 10, threadHandedness: "right" } },
  { kind: "rib", extra: { ribThicknessMm: 2 } },
  { kind: "dome", extra: { domeHeightMm: 8 } },
  { kind: "sheet-base", extra: { sheetThicknessMm: 2 } },
  { kind: "sheet-flange", extra: { sheetThicknessMm: 2, sheetBendRadiusMm: 2, flangeLengthMm: 10, flangeAngleDeg: 90 } },
  { kind: "sheet-hem", extra: { sheetThicknessMm: 2, sheetBendRadiusMm: 1, flangeLengthMm: 8, hemStyle: "closed" } }
];

export const solidOperationsIntegrationTests: readonly TestCase[] = [
  ...CREATED.map((entry): TestCase => ({
    name: `a ${entry.kind} solid is accepted by the real add-design-solid operation, validates, and survives save and load`,
    run: async () => {
      const { project, sketch } = withSketch();
      const next = await addCreated(project, sketch, feature(sketch, entry.kind, entry.kind, entry.extra));
      assert(designOf(next).features.some((candidate) => candidate.kind === entry.kind), "the step is in the timeline");
      // Fillet and chamfer are built by the extrude kernel with a corner treatment, so their body records an extrude.
      const recorded = entry.kind === "edge-fillet" || entry.kind === "edge-chamfer" ? "extrude" : entry.kind;
      assert(bodyOf(next, `general-body:${entry.kind}`).feature?.operation === recorded, "the body records how it was made");
    }
  })),
  {
    name: "direct-edit steps (move, scale, move face, offset face, emboss) replay on an extruded body without errors",
    run: async () => {
      const { project, sketch } = withSketch();
      let current = await addCreated(project, sketch, feature(sketch, "extrude", "plate"));
      const base = bodyOf(current, "general-body:plate");
      const role = base.brep!.faces.map((face) => face.role).find((name) => name.includes("top")) ?? base.brep!.faces[0]!.role;
      const before = solidMetrics(base.positionsMm, base.indices);
      const steps: DesignSolidFeature[] = [
        feature(sketch, "move-body", "move", { bodyId: "general-body:plate", operation: "direct-edit", moveDeltaMm: [5, 0, 0] }),
        feature(sketch, "scale-body", "scale", { bodyId: "general-body:plate", operation: "direct-edit", scaleFactor: 1.5 }),
        feature(sketch, "move-face", "moveface", { bodyId: "general-body:plate", operation: "direct-edit", targetFaceRole: role, moveFaceDeltaMm: [0, 0, 2] }),
        feature(sketch, "offset-face", "offsetface", { bodyId: "general-body:plate", operation: "direct-edit", targetFaceRole: role, offsetFaceMm: 1 }),
        feature(sketch, "emboss", "emboss", { bodyId: "general-body:plate", operation: "direct-edit", targetFaceRole: role, embossHeightMm: 1 })
      ];
      for (const step of steps) {
        const result = await addModifierAndReplay(current, step);
        assert(result.messages.length === 0, `${step.kind} replays cleanly: ${result.messages.join("; ")}`);
        current = result.project;
      }
      const after = solidMetrics(bodyOf(current, "general-body:plate").positionsMm, bodyOf(current, "general-body:plate").indices);
      assert(after.volumeMm3 > before.volumeMm3 * 3, `the scaled, pulled body is larger (${before.volumeMm3} to ${after.volumeMm3})`);
    }
  },
  {
    name: "sheet edge flanges replay in order on a sheet base, a second flange on the same edge reports a health message, and the project saves and loads",
    run: async () => {
      const { project, sketch } = withSketch();
      let current = await addCreated(project, sketch, feature(sketch, "sheet-base", "sheet", { sheetThicknessMm: 2, valueMm: 2 }));
      const bodyId = "general-body:sheet";
      const verticesBefore = bodyOf(current, bodyId).positionsMm.length / 3;
      const flange = (id: string, edge: number): DesignSolidFeature => feature(sketch, "sheet-edge-flange", id, { bodyId, operation: "direct-edit", flangeEdgeIndex: edge, sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90 });
      const first = await addModifierAndReplay(current, flange("flange-a", 0));
      assert(first.messages.length === 0, `the first flange replays: ${first.messages.join("; ")}`);
      const second = await addModifierAndReplay(first.project, flange("flange-b", 1));
      assert(second.messages.length === 0, `the second flange replays: ${second.messages.join("; ")}`);
      assert(bodyOf(second.project, bodyId).positionsMm.length / 3 > verticesBefore, "the flanges add geometry");
      const repeat = await addModifierAndReplay(second.project, flange("flange-c", 0));
      assert(repeat.messages.some((message) => message.includes("already carry a flange")), "a repeated edge is reported, not applied");
      current = second.project;
      assert(parseWorkbenchProjectText(JSON.stringify(current)).ok, "the flanged project saves and loads");
    }
  },
  {
    name: "an indent step cuts a tool body out of the target during replay",
    run: async () => {
      const { project, sketch } = withSketch();
      const current = await addCreated(project, sketch, feature(sketch, "extrude", "block"));
      const block = bodyOf(current, "general-body:block");
      const metrics = solidMetrics(block.positionsMm, block.indices);
      const x = metrics.boundsMm.min[0] + 8;
      const y = metrics.boundsMm.min[1] + 8;
      const top = metrics.boundsMm.max[2];
      const cube = tessellateExtrude([[x, y], [x + 6, y], [x + 6, y + 6], [x, y + 6]], 8, "xy");
      const tool: GeneralSolidBody = { id: "general-body:tool", name: "Tool", visible: false, color: "#b9c2c8", positionsMm: Array.from(cube.positionsMm, (value, index) => index % 3 === 2 ? value + top - 4 : value), indices: Array.from(cube.indices) };
      const withTool = run(current, { kind: "add-general-body", body: tool });
      const result = await addModifierAndReplay(withTool, feature(sketch, "indent", "indent", { bodyId: "general-body:block", indentToolBodyId: "general-body:tool", valueMm: 1 }));
      assert(result.messages.length === 0, `the indent replays: ${result.messages.join("; ")}`);
      const after = bodyOf(result.project, "general-body:block");
      assert(solidMetrics(after.positionsMm, after.indices).volumeMm3 < metrics.volumeMm3 - 100, "the indent removed material");
    }
  },
  {
    name: "a user coordinate system is accepted, validates, and survives save and load",
    run: () => {
      let project = createWorkbenchProject("project:test-ucs");
      project = run(project, { kind: "add-construction-ucs", ucs: { id: "construction-ucs:one", name: "UCS 1", visible: true, origin: [10, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] } });
      assert(project.part.constructionUcses?.length === 1, "stored on the part");
      assert(validateWorkbenchProject(project).ok, "the project validates");
      const reloaded = parseWorkbenchProjectText(JSON.stringify(project));
      assert(reloaded.ok && reloaded.value.part.constructionUcses?.[0]?.name === "UCS 1", "it round-trips");
      project = run(project, { kind: "rename-construction-ucs", ucsId: "construction-ucs:one", name: "Origin frame" });
      project = run(project, { kind: "toggle-construction-ucs-visibility", ucsId: "construction-ucs:one" });
      assert(project.part.constructionUcses?.[0]?.visible === false && project.part.constructionUcses?.[0]?.name === "Origin frame", "rename and hide work");
      project = run(project, { kind: "delete-construction-ucs", ucsId: "construction-ucs:one" });
      assert((project.part.constructionUcses ?? []).length === 0, "delete works");
      const bad = applyWorkbenchOperation(project, { kind: "add-construction-ucs", ucs: { id: "construction-ucs:flat", name: "Flat", visible: true, origin: [0, 0, 0], xAxis: [0, 0, 0], yAxis: [0, 1, 0] }, operationId: "operation:test-ucs-bad", expectedRevision: project.revision });
      assert(!bad.ok, "a zero axis is refused");
    }
  },
  {
    name: "a plane perpendicular to an axis is accepted, validates, and evaluates with the axis direction as its normal",
    run: () => {
      let project = createWorkbenchProject("project:test-perp-plane");
      project = run(project, { kind: "add-construction-axis", axis: { id: "construction-axis:a", name: "Axis A", visible: true, definition: { kind: "two-points", a: [0, 0, 0], b: [0, 0, 30] } } });
      project = run(project, { kind: "add-construction-plane", plane: { id: "construction-plane:p", name: "Perp", visible: true, definition: { kind: "perpendicular-to-axis", axisId: "construction-axis:a", point: [0, 0, 15] } } });
      assert(validateWorkbenchProject(project).ok, "the project validates");
      assert(parseWorkbenchProjectText(JSON.stringify(project)).ok, "it round-trips");
      const plane = project.part.construction![0]!;
      const frame = evaluateConstructionPlane(plane, [], project.part.constructionAxes ?? []);
      assert(!("error" in frame), "the plane evaluates");
      if ("error" in frame) return;
      near(Math.abs(frame.normal[2]), 1, 1e-9, "normal follows the axis");
      near(frame.origin[2], 15, 1e-9, "passes through the point");
      near(Math.abs(frame.uAxis[0] * frame.normal[0] + frame.uAxis[1] * frame.normal[1] + frame.uAxis[2] * frame.normal[2]), 0, 1e-9, "in-plane axis is perpendicular to the normal");
      assert("error" in evaluateConstructionPlane(plane, [], []), "a missing axis is reported");
    }
  }
];
