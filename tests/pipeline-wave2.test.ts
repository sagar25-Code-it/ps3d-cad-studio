import { readFileSync } from "node:fs";
import type { DesignSketchFeature, SketchEntity, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  ENVELOPE_LIMITS, MAX_ARC_RADIUS_MM, MCP_CALL_MAX_BYTES, MODEL_ENVELOPE, PROJECT_FILE_MAX_BYTES, WORKBENCH_LIMITS, WORKBENCH_CAPABILITIES,
  applyWorkbenchOperation, createWorkbenchProject, designOf, parseWorkbenchProjectText, validateWorkbenchProject, fullCircleFacets
} from "../packages/workbench-core/src/index.js";
import { PS3D_AI_COMMAND_RECIPES, createPs3dCollaborationGuide, handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { detectSketchProfiles, profileOutlineMm, sampleSpline, sampleSplineToBound } from "../packages/workbench-sketch/src/index.js";
import { parseDxf, writeSketchDxf } from "../packages/workbench-sketch/src/dxf.js";
import { parseSvg, writeSketchSvg } from "../packages/workbench-sketch/src/svg.js";
import { DEFAULT_SKETCH_TEXT_SPEC, planSketchText } from "../packages/workbench-sketch/src/sketch-text.js";
import { planDrawingImport, type ParsedDrawing } from "../packages/workbench-sketch/src/sketch-exchange.js";
import type { SketchEditPlan } from "../packages/workbench-sketch/src/edit-tools.js";
import { MAX_PROJECT_BYTES, assertProjectFileSize } from "../apps/studio-web/src/file-workspace.js";
import { datumPlaneHint, describeSketchPlane, sketchAxesInWorld } from "../apps/studio-web/src/sketch-plane-ui.js";
import { rebuildSolidFeature, sketchLookupOf } from "../apps/studio-web/src/design-regeneration.js";
import { MAX_MCP_JSON_BYTES } from "../api/_lib/http.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, fresh, line, message, meshStats, pipelineApply, pipelineRun, rect, solidFeature, solidOf } from "./pipeline-kit.js";

/**
 * Wave 2 of the sketch-to-solid pipeline: what the re-audit of the merged build still found (P01, P10, P13, P19, P20, P21, P22) and
 * what the first fixes introduced (N-03 to N-08). Each case reproduces the re-audit's repro through the real code path.
 */

const ack = async (): Promise<{ readonly manifestSha256: string; readonly understood: true }> => ({ manifestSha256: String((await createPs3dCollaborationGuide())["manifestSha256"]), understood: true });

let counter = 0;
const newId = (prefix: string): string => `${prefix}:w2-${(counter += 1)}`;

function applyPlans(project: WorkbenchProject, plans: readonly SketchEditPlan[]): WorkbenchProject {
  let current = project;
  for (const plan of plans) {
    const applied = applyWorkbenchOperation(current, { kind: "apply-sketch-edit", operationId: `operation:w2-${(counter += 1)}`, expectedRevision: current.revision, ...plan } as never);
    if (!applied.ok) throw new Error(`the import edit was refused: ${applied.diagnostics[0]?.message ?? "no reason"}`);
    current = applied.value.project;
  }
  return current;
}

/** Imports a parsed drawing into an empty sketch through the real planner and operation path; returns the entities. */
function importDrawing(drawing: ParsedDrawing, extra: Partial<Parameters<typeof planDrawingImport>[2]> = {}): readonly SketchEntity[] {
  const base = fresh();
  const project = { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
  const planned = planDrawingImport(drawing, project.sketch, { mmPerUnit: 1, newId, ...extra });
  if (!planned.ok) throw new Error(`the import was refused: ${planned.diagnostics[0]?.message ?? "no reason"}`);
  return applyPlans(project, planned.value.plans).sketch.entities;
}

function sketchWith(entities: readonly SketchEntity[]) {
  const base = fresh();
  return { ...base.sketch, entities, constraints: [] };
}

const unreadable = (text: string): string => {
  const result = parseDxf(text);
  return result.ok ? "" : result.diagnostics[0]?.message ?? "";
};

function dxfOf(extra: readonly (string | number)[]): string {
  return ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", ...extra.map(String), "0", "ENDSEC", "0", "EOF"].join("\n");
}

const polygonArea = (points: readonly (readonly [number, number])[]): number => {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
};

export const pipelineWave2Tests: readonly TestCase[] = [
  {
    name: "Wave2 N-03 and P01: Save, Open, the validators, the MCP tools and the deployed transport share one set of size limits",
    run: async () => {
      equal(MAX_PROJECT_BYTES, PROJECT_FILE_MAX_BYTES, "the browser file workspace uses the shared project size");
      equal(WORKBENCH_LIMITS.maxJsonBytes, PROJECT_FILE_MAX_BYTES, "and so do the validators");
      equal(WORKBENCH_LIMITS.maxMcpInputBytes, MCP_CALL_MAX_BYTES, "one MCP call has one size on the local server");
      assert(MAX_MCP_JSON_BYTES >= MCP_CALL_MAX_BYTES && MAX_MCP_JSON_BYTES <= MCP_CALL_MAX_BYTES + 128 * 1024, "and the deployed transport allows that call plus its JSON-RPC envelope");
      assertProjectFileSize(PROJECT_FILE_MAX_BYTES);
      let threw = false;
      try { assertProjectFileSize(52_428_800); } catch { threw = true; }
      assert(threw, "a 52,428,800 byte file (what Save used to write and Open refused) is stopped before it is written");
      threw = false;
      try { assertProjectFileSize(PROJECT_FILE_MAX_BYTES + 1); } catch { threw = true; }
      assert(threw, "one byte over the limit is stopped");
      const tooBig = parseWorkbenchProjectText("x".repeat(PROJECT_FILE_MAX_BYTES + 1));
      assert(!tooBig.ok && /larger than the 50 MB limit/u.test(message(tooBig)), `Open names the same 50 MB: ${message(tooBig)}`);

      // ps3d_inspect_project with a 1.1 MB payload was refused as "exceeds the 1 MB limit".
      const inspected = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: { data: "x".repeat(1_100_000) } });
      assert(inspected.structuredContent["code"] !== "RESOURCE_LIMIT", `a 1.1 MB call is not refused for its size: ${JSON.stringify(inspected.structuredContent).slice(0, 200)}`);
      const oversized = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: { data: "x".repeat(MCP_CALL_MAX_BYTES + 100_000) } });
      assert(oversized.isError === true && oversized.structuredContent["code"] === "RESOURCE_LIMIT" && /4 MB/u.test(String(oversized.structuredContent["message"])), `the limit is named in the message: ${String(oversized.structuredContent["message"])}`);
    }
  },
  {
    name: "Wave2 P01: a torus revolve is prepared through ps3d_prepare_design_solid and applies with a project that already holds one (over 1 MB)",
    run: async () => {
      const torusSketch = committedSketch("datum:xy", [circ("t", 30, 0, 10)]);
      const guideAcknowledgement = await ack();
      const first = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project: torusSketch.project, solid: { kind: "revolve", sketchFeatureId: "feature:s1", valueMm: 360, name: "Torus" }, guideAcknowledgement });
      assert(first.isError !== true, `a torus revolve is prepared: ${JSON.stringify(first.structuredContent).slice(0, 300)}`);
      const operation = first.structuredContent["operation"] as Record<string, unknown>;
      const applied = await handleWorkbenchMcpTool("ps3d_apply_preview", { project: torusSketch.project, operation, receipt: first.structuredContent["receipt"], confirmed: true, guideAcknowledgement });
      assert(applied.isError !== true, `and applies: ${JSON.stringify(applied.structuredContent).slice(0, 300)}`);
      const withTorus = applied.structuredContent["project"] as WorkbenchProject;
      const projectBytes = JSON.stringify(withTorus).length;
      assert(projectBytes > 100_000, `the project carries a real mesh (${Math.round(projectBytes / 1000)} kB)`);
      // The same sketch revolved again: the project and the new solid together must still fit one call.
      const second = await handleWorkbenchMcpTool("ps3d_prepare_design_solid", { project: withTorus, solid: { kind: "revolve", sketchFeatureId: "feature:s1", valueMm: 360, name: "Torus 2" }, guideAcknowledgement });
      assert(second.isError !== true || /MB/u.test(String(second.structuredContent["message"])), `either prepared, or refused with the shared limit named: ${String(second.structuredContent["message"])}`);
      const recipe = PS3D_AI_COMMAND_RECIPES.find((candidate) => candidate.id.endsWith("design-solid"));
      assert(recipe !== undefined && /4 MB call/u.test(JSON.stringify(recipe)), "the recipe advertises the same limit");
    }
  },
  {
    name: "Wave2 P20: the arc radius limit is the envelope's, shared without a hard-coded copy, and every layer accepts a 100 m sketch",
    run: () => {
      equal(MAX_ARC_RADIUS_MM, MODEL_ENVELOPE.maxSketchRadiusMm, "the arc radius limit equals the circle radius limit");
      equal(MODEL_ENVELOPE.maxSketchRadiusMm, ENVELOPE_LIMITS.maxSketchRadiusMm, "and both come from the one list of limits");
      const source = readFileSync(new URL("../../packages/workbench-core/src/arc-geometry.ts", import.meta.url), "utf8");
      assert(!/MAX_ARC_RADIUS_MM[^=\n]*=\s*100[_0]*000/u.test(source), "arc-geometry.ts no longer carries its own copy of the number");
      assert(!/from "\.\/envelope\.js"/u.test(source), "and does not import envelope.ts, which imports it");
      // A line to 99 m, a 100 m circle and a 150 m rectangle side are all accepted by the one entity check.
      let project = fresh();
      project = pipelineRun(project, { kind: "add-sketch-entity", entity: line("far", [0, 0], [99_000, 0]) });
      project = pipelineRun(project, { kind: "add-sketch-entity", entity: circ("big", 0, 0, 100_000) });
      project = pipelineRun(project, { kind: "add-sketch-entity", entity: rect("wide", 0, 0, 150_000, 10) });
      const tooFar = pipelineApply(project, { kind: "add-sketch-entity", entity: line("beyond", [0, 0], [100_001, 0]) });
      assert(!tooFar.ok && /100,000/u.test(message(tooFar)), `beyond the limit the message names it: ${message(tooFar)}`);
      // A dimension bound to a parameter and one set directly agree on the cap.
      let edited = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("r", 0, 0, 10, 10)], addConstraints: [], label: "r" });
      edited = pipelineRun(edited, { kind: "set-design-parameters", parameters: [{ name: "w", expression: "50000 mm", unit: "mm", comment: "" }] });
      const bound = pipelineApply(edited, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 50_000, expression: "w" });
      assert(bound.ok, `a 50 m width bound to a parameter is accepted: ${message(bound)}`);
      const direct = pipelineApply(edited, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 150_000 });
      assert(direct.ok, `and a 150 m width set directly is too: ${message(direct)}`);
      // DXF and SVG import reach as far as a sketch can.
      const far = parseDxf(dxfOf([0, "LINE", 10, 0, 20, 0, 11, 80_000, 21, 0]));
      assert(far.ok, "a DXF line 80 m long parses");
      const entities = importDrawing(far.ok ? far.value : (undefined as never));
      equal(entities.length, 1, "and imports as a sketch line");
    }
  },
  {
    name: "Wave2 P21: a r=5 circle extrudes within 0.1 percent of its volume, big circles and ellipses follow the same chord-error rule, and splines stay near their points",
    run: async () => {
      for (const radius of [0.5, 5, 50, 1000]) {
        const solid = committedSketch("datum:xy", [circ("c", 0, 0, radius)]).sketch;
        const volume = meshStats(solidOf(await buildSolid(solid, "extrude", { valueMm: 10 }))).volume;
        const exact = Math.PI * radius * radius * 10;
        const error = Math.abs(volume - exact) / exact;
        assert(error < 0.0008, `r=${radius}: volume within 0.08 percent of the circle (was 0.127 percent at every size), got ${(error * 100).toFixed(4)} percent`);
      }
      const facets = (radius: number): number => fullCircleFacets(radius);
      assert(facets(5) > 72 && facets(1000) > facets(50) && facets(50) > facets(5), `the facet count follows the size: ${facets(5)}, ${facets(50)}, ${facets(1000)}`);
      // The outline used for the sketch's own regions is the same rule.
      const outline = profileOutlineMm({ kind: "circle", center: [0, 0], radiusMm: 5 });
      near(polygonArea(outline) / (Math.PI * 25), 1, 0.0008, "the outline sampled for an extrusion is round to the same bound");
      const ellipse = profileOutlineMm({ kind: "ellipse", center: [0, 0], majorRadiusMm: 40, minorRadiusMm: 10, rotationDeg: 30 });
      near(polygonArea(ellipse) / (Math.PI * 400), 1, 0.001, "an ellipse too");
      // Fit points that all lie between y 0 and 1: the curve may not swing far outside them (it went to y -3.66, then -2.57).
      const points: readonly (readonly [number, number])[] = [[0, 0], [2, 1], [4, 0], [60, 0], [62, 1], [64, 0]];
      for (const sampled of [sampleSpline(points), sampleSplineToBound(points)]) {
        const lowest = Math.min(...sampled.map((p) => p[1]));
        const highest = Math.max(...sampled.map((p) => p[1]));
        assert(lowest > -0.3 && highest < 1.3, `the spline stays within 0.3 mm of the band the points span: ${lowest.toFixed(3)} to ${highest.toFixed(3)}`);
        for (let index = 1; index < sampled.length; index += 1) assert(sampled[index]![0] >= sampled[index - 1]![0] - 1e-9, "and never runs backwards");
      }
      assert(sampleSplineToBound([[0, 0], [1000, 500], [2000, 0]]).length > 100, "a 2000 mm span is sampled by its chord error, not in 17 steps");
    }
  },
  {
    name: "Wave2 N-04: geometry at the 0.01 mm minimum the validators accept is a profile too, and a tiny hole is a hole",
    run: async () => {
      const cases: readonly (readonly [string, SketchEntity])[] = [
        ["rect 0.01 x 5", rect("a", 0, 0, 0.01, 5)], ["rect 0.01 x 0.01", rect("a", 0, 0, 0.01, 0.01)], ["rect 1 x 0.01", rect("a", 0, 0, 1, 0.01)],
        ["circle r 0.01", circ("a", 0, 0, 0.01)], ["circle r 0.0125", circ("a", 0, 0, 0.0125)], ["circle r 0.015", circ("a", 0, 0, 0.015)], ["rect 0.011 x 5", rect("a", 0, 0, 0.011, 5)]
      ];
      for (const [label, entity] of cases) {
        const { sketch } = committedSketch("datum:xy", [entity]);
        equal(detectSketchProfiles(sketch.sketch).length, 1, `${label} was accepted by the sketch and gives one profile`);
      }
      const plate = committedSketch("datum:xy", [rect("plate", 0, 0, 20, 20), circ("pin", 3, 3, 0.01)]).sketch;
      const profiles = detectSketchProfiles(plate.sketch);
      const holed = profiles.find((profile) => profile.holes !== undefined && profile.holes.length === 1);
      assert(holed !== undefined, `a r=0.01 circle inside a plate is a hole of the plate (${profiles.length} profiles)`);
      // The same minimum is what the entity check enforces, and its message says so.
      const tooSmall = pipelineApply(fresh(), { kind: "add-sketch-entity", entity: line("z", [0, 0], [0.005, 0]) });
      assert(!tooSmall.ok && /0\.01 mm/u.test(message(tooSmall)), `below it the message names the minimum: ${message(tooSmall)}`);
      const thin = committedSketch("datum:xy", [rect("thin", 0, 0, 0.01, 5)]).sketch;
      const volume = meshStats(solidOf(await buildSolid(thin, "extrude", { valueMm: 2 }))).volume;
      near(volume, 0.01 * 5 * 2, 0.0005, "and a 0.01 mm rectangle extrudes");
    }
  },
  {
    name: "Wave2 N-05: a truncated or corrupt DXF number is refused with its line instead of becoming 0",
    run: () => {
      const corrupt = unreadable(dxfOf([0, "LINE", 10, "NaN", 20, "abc", 11, 10, 21, 0]));
      assert(/unreadable number "NaN"/u.test(corrupt) && /line [0-9]+/u.test(corrupt), `NaN is refused with its line: ${corrupt}`);
      const word = unreadable(dxfOf([0, "CIRCLE", 10, 5, 20, 5, 40, "1e"]));
      assert(/unreadable number "1e"/u.test(word), `a half-written exponent is refused: ${word}`);
      const cut = unreadable(["0", "SECTION", "2", "ENTITIES", "0", "LINE", "10", "0", "20", "0", "11", "10", "21"].join("\n"));
      assert(/cut off|middle of a group/u.test(cut) && /line [0-9]+/u.test(cut), `a file that stops after a group code is refused: ${cut}`);
      const fine = parseDxf(dxfOf([0, "LINE", 10, "0", 20, "0.5", 11, "1e1", 21, "-2.5E-1"]));
      assert(fine.ok && fine.value.curves.length === 1, "ordinary and exponent numbers still read");
      const empty = parseDxf(dxfOf([0, "LINE", 10, 0, 20, 0, 11, 10, 21, 0, 8, ""]));
      assert(empty.ok, "an empty layer name is not a number problem");
      const huge = unreadable(dxfOf([0, "LINE", 10, 0, 20, 0, 11, "1e999", 21, 0]));
      assert(huge !== "", "a number too large to be a number is refused too");
    }
  },
  {
    name: "Wave2 N-06: a sketch written as DXF or SVG reads back as the same sketch: fit points, construction flags and position",
    run: () => {
      const entities: readonly SketchEntity[] = [
        { id: "entity:sp", kind: "spline", fitPoints: [[0, 0], [10, 8], [22, 3], [35, 12], [50, 0]], construction: false },
        { id: "entity:el", kind: "ellipse", center: [-50, 0], majorRadiusMm: 20, minorRadiusMm: 8, rotationDeg: 25, construction: false },
        { id: "entity:cl", kind: "line", start: [-60, -30], end: [60, -30], construction: true },
        { id: "entity:ci", kind: "circle", center: [5, 25], radiusMm: 6, construction: false },
        { id: "entity:ar", kind: "arc", start: [0, 40], mid: [10, 50], end: [20, 40], construction: true }
      ];
      for (const format of ["dxf", "svg"] as const) {
        const text = format === "dxf" ? writeSketchDxf(sketchWith(entities)) : writeSketchSvg(sketchWith(entities));
        const parsed = format === "dxf" ? parseDxf(text) : parseSvg(text);
        assert(parsed.ok, `${format} parses`);
        if (!parsed.ok) return;
        const back = importDrawing(parsed.value);
        const spline = back.find((entity) => entity.kind === "spline");
        assert(spline !== undefined && spline.kind === "spline", `${format}: the spline comes back as ONE spline`);
        if (spline !== undefined && spline.kind === "spline") {
          equal(spline.fitPoints.length, 5, `${format}: with its five fit points`);
          spline.fitPoints.forEach((point, index) => {
            near(point[0], (entities[0] as { fitPoints: readonly (readonly [number, number])[] }).fitPoints[index]![0], 1e-4, `${format}: fit point ${index} x`);
            near(point[1], (entities[0] as { fitPoints: readonly (readonly [number, number])[] }).fitPoints[index]![1], 1e-4, `${format}: fit point ${index} y`);
          });
        }
        equal(back.length, entities.length, `${format}: no entity is split or lost`);
        const ellipse = back.find((entity) => entity.kind === "ellipse");
        assert(ellipse !== undefined && ellipse.kind === "ellipse", `${format}: the ellipse comes back`);
        if (ellipse !== undefined && ellipse.kind === "ellipse") {
          near(ellipse.center[0], -50, 1e-3, `${format}: at x = -50 (it was moved to the drawing's own origin)`);
          near(ellipse.center[1], 0, 1e-3, `${format}: and y = 0`);
        }
        const flags = back.filter((entity) => entity.construction === true).map((entity) => entity.kind).sort();
        equal(flags.join(","), "arc,line", `${format}: the construction line and arc are construction again (layers CONSTRUCTION and 0 round trip)`);
      }
    }
  },
  {
    name: "Wave2 N-07: ps3d_capabilities describes the sketch workspace as it is, and the docs count the thirteen MCP tools",
    run: async () => {
      const result = await handleWorkbenchMcpTool("ps3d_capabilities", {});
      const records = result.structuredContent["capabilities"] as readonly { readonly id: string; readonly name: string; readonly summary: string }[];
      const sketch = records.filter((record) => record.id.startsWith("capability:sketch"));
      const text = sketch.map((record) => `${record.name} ${record.summary}`).join(" ");
      for (const stale of ["Line, rectangle, circle, arc", "A small analytic solver", "Results are independent geometry (not associative)"]) assert(!text.includes(stale), `the old wording "${stale}" is gone`);
      for (const word of ["DXF", "SVG", "ellipse", "spline", "text", "pattern", "underlay", "simultaneous", "associative"]) assert(text.toLowerCase().includes(word.toLowerCase()), `the sketch capabilities mention ${word}`);
      assert(WORKBENCH_CAPABILITIES.some((record) => record.id === "capability:sketch-exchange") && WORKBENCH_CAPABILITIES.some((record) => record.id === "capability:sketch-to-solid"), "import/export and the sketch-to-solid build have entries");
      const root = (name: string): string => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
      for (const file of ["docs/PHASE_1_LOCAL_EVIDENCE.md", "docs/PYTHON_LINKING.md", "docs/COMMAND_MCP_VERIFICATION.md", "docs/product/ELECTROMECHANICAL_REALIZATION.md", "docs/product/PRD_PHASE_1_WORKBENCH_PREVIEW.md"]) {
        const doc = root(file);
        assert(!/\ball twelve tools\b|\btwelve typed tool helpers\b|\bexposes twelve tools\b|\ball twelve PS3D tools\b/u.test(doc), `${file} no longer says twelve tools`);
      }
      assert(/ps3d_prepare_design_solid/u.test(root("docs/product/ELECTROMECHANICAL_REALIZATION.md")), "the electromechanical doc lists the thirteenth tool");
      assert(/def prepare_design_solid/u.test(root("sdk/python/ps3d_client/client.py")), "and the Python client has a helper for it");
    }
  },
  {
    name: "Wave2 N-08 (changed by wave 3 R2-2 and P22/N-08): Horizontal on an exactly vertical line turns it a quarter turn (length kept) instead of refusing it as a collapse; a Fixed line still says why not",
    run: () => {
      const base = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("cl", [30, -10], [30, 40])], addConstraints: [], label: "centerline" });
      const turned = pipelineApply(base, { kind: "add-sketch-constraint", constraint: { id: "constraint:h", kind: "horizontal", entityIds: ["entity:cl"] } });
      assert(turned.ok, `the relation is applied: ${message(turned)}`);
      const turnedLine = turned.ok ? turned.value.project.sketch.entities.find((entity) => entity.id === "entity:cl") : undefined;
      assert(turnedLine !== undefined && turnedLine.kind === "line" && turnedLine.start[0] === 30 && turnedLine.start[1] === -10 && Math.abs(turnedLine.end[0] - 80) < 1e-9 && Math.abs(turnedLine.end[1] + 10) < 1e-9, `the 50 mm line turned about its start: ${JSON.stringify(turnedLine)}`);
      const fixedLine = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("fx", [30, -10], [30, 40])], addConstraints: [{ id: "constraint:fx", kind: "fixed", entityIds: ["entity:fx"] }], label: "fixed" });
      const refused = pipelineApply(fixedLine, { kind: "add-sketch-constraint", constraint: { id: "constraint:h", kind: "horizontal", entityIds: ["entity:fx"] } });
      assert(!refused.ok && /Horizontal/u.test(message(refused)) && /Fix/u.test(message(refused)), `a Fixed line is not turned, and the conflict names both relations: ${message(refused)}`);
      const horizontal = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("h", [0, 0], [40, 0], true)], addConstraints: [], label: "h" });
      const vertical = pipelineApply(horizontal, { kind: "add-sketch-constraint", constraint: { id: "constraint:v", kind: "vertical", entityIds: ["entity:h"] } });
      assert(vertical.ok, `Vertical on an exactly horizontal construction line likewise turns it: ${message(vertical)}`);
      const slanted = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("d", [0, 0], [30, 30])], addConstraints: [], label: "d" });
      assert(pipelineApply(slanted, { kind: "add-sketch-constraint", constraint: { id: "constraint:h", kind: "horizontal", entityIds: ["entity:d"] } }).ok, "a 45 degree line still turns horizontal");
      const both = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("b", [0, 0], [30, 0])], addConstraints: [{ id: "constraint:hh", kind: "horizontal", entityIds: ["entity:b"] }], label: "b" });
      const clash = pipelineApply(both, { kind: "add-sketch-constraint", constraint: { id: "constraint:vv", kind: "vertical", entityIds: ["entity:b"] } });
      assert(!clash.ok && /Horizontal/u.test(message(clash)) && /Vertical/u.test(message(clash)), `Horizontal and Vertical on one line still name both relations: ${message(clash)}`);
    }
  },
  {
    name: "Wave2 P19: a rename to a name another timeline feature has is refused and offers a free name; its own name is fine",
    run: () => {
      let project = committedSketch("datum:xy", [rect("a", 0, 0, 10, 10)]).project;
      project = committedSketch("datum:xy", [circ("b", 0, 0, 3)], { project, featureId: "feature:s2" }).project;
      const names = designOf(project).features.map((feature) => feature.name);
      equal(new Set(names).size, 2, `two sketches with different names: ${names.join(", ")}`);
      const refused = pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s2", name: names[0]! });
      assert(!refused.ok, "the clash is refused");
      assert(message(refused).includes(`already called "${names[0]!}"`), `and says which feature has the name: ${message(refused)}`);
      assert(/for example/u.test(refused.ok ? "" : refused.diagnostics[0]?.recovery ?? ""), "and offers another name");
      assert(pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s2", name: names[1]! }).ok, "keeping its own name is not a clash");
      assert(pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s2", name: names[1]!.toUpperCase() }).ok, "changing only the case of its own name is allowed");
      const lower = pipelineApply(project, { kind: "rename-design-feature", featureId: "feature:s2", name: ` ${names[0]!.toLowerCase()} ` });
      assert(!lower.ok, "a clash that differs only in case or spaces is a clash");
    }
  },
  {
    name: "Wave2 P13: a refused sketch says which limit it hit: the 501st entity, the 1001st relation, and each wrong plane field",
    run: () => {
      const empty = fresh();
      let project = pipelineRun({ ...empty, sketch: { ...empty.sketch, entities: [], constraints: [] } }, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: Array.from({ length: 500 }, (_, index) => line(`e${index}`, [index, 0], [index, 1])), addConstraints: [], label: "full" });
      const entityResult = pipelineApply(project, { kind: "add-sketch-entity", entity: line("extra", [900, 0], [900, 1]) });
      assert(!entityResult.ok && !/invalid or exceeds its limits/u.test(message(entityResult)) && /500/u.test(message(entityResult)), `the 501st entity names the limit of 500: ${message(entityResult)}`);
      equal(entityResult.ok ? "" : entityResult.diagnostics[0]!.code, "RESOURCE_LIMIT", "as a resource limit, not an invalid project");
      const constraints = Array.from({ length: 499 }, (_, index) => ({ id: `constraint:v${index}`, kind: "vertical" as const, entityIds: [`entity:e${index}`] }));
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: constraints, label: "relations" });
      assert(project.sketch.constraints.length === 499, "relations were added");
      // A stored sketch over a limit names the limit when a project is opened.
      const stored = JSON.parse(JSON.stringify(project)) as { sketch: { entities: unknown[]; constraints: unknown[] } };
      for (let index = 0; index < 5; index += 1) stored.sketch.entities.push({ id: `entity:more${index}`, kind: "line", start: [0, 0], end: [1, 1], construction: false });
      const opened = validateWorkbenchProject(stored);
      assert(!opened.ok && /505 (entities|curves)/u.test(message(opened)) && /(at most|the limit is) 500/u.test(message(opened)), `Open names the count and the limit: ${message(opened)}`);
      // Each plane field has its own message.
      const place = (extra: Record<string, unknown>): string => message(pipelineApply(fresh(), { kind: "new-design-sketch", plane: "datum:xy", ...extra } as never));
      assert(/offset 1000000 mm is beyond the limit/u.test(place({ offsetMm: 1_000_000 })), `offset: ${place({ offsetMm: 1_000_000 })}`);
      assert(/tilt angle 400 degrees is beyond the limit of 180/u.test(place({ tilt: { axis: "x", angleDeg: 400 } })), `tilt angle: ${place({ tilt: { axis: "x", angleDeg: 400 } })}`);
      assert(/tilt axis "w"/u.test(place({ tilt: { axis: "w", angleDeg: 10 } })), `tilt axis: ${place({ tilt: { axis: "w", angleDeg: 10 } })}`);
      assert(/perpendicular/u.test(place({ frame: { originMm: [0, 0, 0], uAxis: [1, 0, 0], normal: [1, 0, 0] } })), `frame: ${place({ frame: { originMm: [0, 0, 0], uAxis: [1, 0, 0], normal: [1, 0, 0] } })}`);
      assert(/frame replaces the offset/u.test(place({ offsetMm: 5, frame: { originMm: [0, 0, 0], uAxis: [1, 0, 0], normal: [0, 0, 1] } })), "a frame with an offset is explained");
      assert(/"datum:ab"/u.test(message(pipelineApply(fresh(), { kind: "new-design-sketch", plane: "datum:ab" } as never))), "an unknown plane is named");
    }
  },
  {
    name: "Wave2 P22: the YZ plane keeps its stored convention and says what it is in world terms in the plane dialog, the status line and the revolve axis",
    run: async () => {
      const yz = sketchAxesInWorld("datum:yz", "legacy");
      equal(yz.x, "world -Z", "sketch X on a legacy Right (YZ) sketch is world -Z");
      equal(yz.y, "world +Y", "sketch Y is world +Y (not up: this world is Z up)");
      const zUp = sketchAxesInWorld("datum:yz");
      equal(zUp.x, "world +Y", "sketch X on a new Right (YZ) sketch is world +Y");
      equal(zUp.y, "world +Z", "and its sketch Y is world +Z, up");
      const hint = datumPlaneHint("datum:yz");
      assert(/Looking along \+X/u.test(hint) && /world \+Y/u.test(hint) && /world \+Z/u.test(hint) && !/Y is up/u.test(hint), `the dialog line gives the world axes of a new Right-plane sketch: ${hint}`);
      assert(/world \+Z/u.test(datumPlaneHint("datum:xz")) && /world \+X/u.test(datumPlaneHint("datum:xy")), "and so do the other two planes");
      const status = describeSketchPlane({ plane: "datum:yz", planeOffsetMm: 12 }).status;
      assert(/Right \(YZ\), offset 12 mm\./u.test(status) && /Sketch X runs along world -Z, sketch Y along world \+Y/u.test(status), `the status line says it too: ${status}`);
      // The solid really does follow the documented axes: an upright profile on YZ revolves about world Y.
      const yzSketch = committedSketch("datum:yz", [rect("r", 10, 10, 10, 20)], { convention: "legacy" }).sketch;
      const revolved = meshStats(solidOf(await buildSolid(yzSketch, "revolve", { valueMm: 360 })));
      near(revolved.lo[1], 0, 0.01, "the YZ revolve starts at y = 0");
      near(revolved.hi[1], 20, 0.01, "and rises along world Y, as the axis chip says");
      const dialog = readFileSync(new URL("../../apps/studio-web/src/ui/SketchPlaneDialog.tsx", import.meta.url), "utf8");
      assert(/datumPlaneHint\("datum:yz"\)/u.test(dialog) && !/Y is up/u.test(dialog), "the dialog builds its text from the shared description");
      const workspace = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(/Sketch Y axis \(\{sketchAxesInWorld\(props\.sketch\.plane, conventionOf\(props\.sketch\)\)\.y\}\)/u.test(workspace), "and the revolve axis choice names the world axes");
    }
  },
  {
    name: "Wave2 P10: a pipe along an L path in another sketch and a rectangle along an arc are within 0.03 percent of section area times path length, with square end caps",
    run: async () => {
      const profile = committedSketch("datum:xy", [circ("o", 0, 0, 10), circ("i", 0, 0, 8)], { featureId: "feature:s1" });
      const path = committedSketch("datum:xz", [line("p1", [0, 0], [0, 50]), line("p2", [0, 50], [50, 50])], { project: profile.project, featureId: "feature:s2" });
      const lookup = sketchLookupOf(designOf(path.project));
      const ids = detectSketchProfiles(profile.sketch.sketch).map((candidate) => candidate.id);
      const pipe = await rebuildSolidFeature(solidFeature("sweep", profile.sketch, { profileIds: ids, valueMm: 50, sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:p1", "entity:p2"] } }), profile.sketch, "#b9c2c8", lookup);
      const pipeStats = meshStats(solidOf(pipe));
      const exact = Math.PI * (100 - 64) * 100;
      assert(Math.abs(pipeStats.volume - exact) / exact < 0.0003, `the pipe volume ${pipeStats.volume.toFixed(1)} is within 0.03 percent of ${exact.toFixed(1)} (it was 11295 against 11310)`);
      near(pipeStats.hi[2], 60, 0.01, "it rises 50 mm and ends 10 mm above the horizontal run");
      near(pipeStats.hi[0], 50, 0.01, "and ends at x = 50");
      // The same pipe with the path picked in the wrong order is the same pipe.
      const shuffled = await rebuildSolidFeature(solidFeature("sweep", profile.sketch, { profileIds: ids, valueMm: 50, sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:p2", "entity:p1"] } }), profile.sketch, "#b9c2c8", lookup);
      near(meshStats(solidOf(shuffled)).volume, pipeStats.volume, 0.01, "picked in any order");

      // A 10 x 10 rectangle along a semicircle of radius 20 (path length 62.83 mm): volume = area x length, and the caps stand square to the path.
      const arcProfile = committedSketch("datum:xy", [rect("p", 0, 0, 10, 10)], { featureId: "feature:s1" });
      const arcPath = committedSketch("datum:xz", [{ id: "entity:a", kind: "arc", start: [0, 0], mid: [20, 20], end: [40, 0], construction: false }], { project: arcProfile.project, featureId: "feature:s2" });
      const arcLookup = sketchLookupOf(designOf(arcPath.project));
      const swept = meshStats(solidOf(await rebuildSolidFeature(solidFeature("sweep", arcProfile.sketch, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:a"] } }), arcProfile.sketch, "#b9c2c8", arcLookup)));
      const arcExact = 100 * Math.PI * 20;
      assert(Math.abs(swept.volume - arcExact) / arcExact < 0.0003, `the arc sweep volume ${swept.volume.toFixed(1)} is within 0.03 percent of ${arcExact.toFixed(1)} (it was 6279 against 6283)`);
      near(swept.lo[2], 0, 0.002, "the first cap is flat on the profile plane (it dipped to z = -0.157 when cut square to the first chord)");
      near(swept.hi[2], 25, 0.01, "and the arc rises to its top at 20 plus half the section");

      // A spline path (fit points in the XZ sketch) is accepted too: the pipe is the section times the length of the sampled spline.
      const fit: readonly (readonly [number, number])[] = [[0, 0], [0, 25], [20, 50], [50, 60]];
      const splinePath = committedSketch("datum:xz", [{ id: "entity:s", kind: "spline", fitPoints: fit, construction: false }], { project: arcProfile.project, featureId: "feature:s2" });
      const splineLookup = sketchLookupOf(designOf(splinePath.project));
      const along = meshStats(solidOf(await rebuildSolidFeature(solidFeature("sweep", arcProfile.sketch, { sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:s"] } }), arcProfile.sketch, "#b9c2c8", splineLookup)));
      const sampled = sampleSplineToBound(fit, { fine: true });
      let pathLength = 0;
      for (let index = 1; index < sampled.length; index += 1) pathLength += Math.hypot(sampled[index]![0] - sampled[index - 1]![0], sampled[index]![1] - sampled[index - 1]![1]);
      assert(Math.abs(along.volume - 100 * pathLength) / (100 * pathLength) < 0.003, `a spline path sweeps the section along its length: ${along.volume.toFixed(1)} against ${(100 * pathLength).toFixed(1)}`);
      near(along.lo[2], 0, 0.05, "starting on the profile plane");
    }
  },
  {
    name: "Wave2 P20: a text object far from the origin (50 m) is accepted like any other curve",
    run: () => {
      let serial = 0;
      const planned = planSketchText({ newId: (prefix: string) => `${prefix}:w2t-${(serial += 1)}` }, [50_000, 0], { ...DEFAULT_SKETCH_TEXT_SPEC, text: "Far", heightMm: 8 });
      assert(planned.ok, "the text is planned");
      if (!planned.ok) return;
      const empty = fresh();
      const applied = pipelineApply({ ...empty, sketch: { ...empty.sketch, entities: [], constraints: [] } }, { kind: "apply-sketch-edit", ...planned.value } as never);
      assert(applied.ok, `and applied (the object limit used to be 10 m): ${message(applied)}`);
    }
  }
];
