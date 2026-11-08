import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, flangeEdgesOf, validSolidFeaturePayload, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { bentStripSection, DEFAULT_K_FACTOR, sheetBendAllowanceMm } from "../packages/workbench-geometry/src/sheet-metal.js";
import { jogProfile } from "../packages/workbench-geometry/src/sheet-jog.js";
import { bendReportCsv, bendTableRowsCsv, developBend, kFactorOfRow, lookupBendK, parseBendTableCsv, type BendTable } from "../packages/workbench-geometry/src/bend-table.js";
import { circleOfOutline, coneDevelopment, tessellateLoftedBend } from "../packages/workbench-geometry/src/sheet-lofted-bend.js";
import { flatLayoutDxf, flatLayoutSvg } from "../packages/workbench-geometry/src/flat-pattern.js";
import { flatPatternForBody, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { parameterFieldsOf, applyParameterValues, parameterValuesOf } from "../apps/studio-web/src/feature-parameters.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { assert, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-smt-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const BODY = "general-body:sheet";

function step(sketch: DesignSketchFeature, kind: DesignSolidFeature["kind"], id: string, extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature {
  return { id: `feature:${id}`, name: id, kind, suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: `general-body:${id}`, ...extra };
}

/** A project holding one 60 x 40 mm, 2 mm sheet (the default plate outline, edges 0 to 3 around it). */
async function sheetProject(extra: Partial<DesignSolidFeature> = {}): Promise<{ readonly project: WorkbenchProject; readonly sketch: DesignSketchFeature; readonly base: DesignSolidFeature }> {
  const started = run(createWorkbenchProject("project:test-smt"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(started).features[0] as DesignSketchFeature;
  const base = step(sketch, "sheet-base", "sheet", { sheetThicknessMm: 2, valueMm: 2, bodyId: BODY, ...extra });
  const built = await rebuildSolidFeature(base, sketch);
  assert(built.ok, `the sheet builds: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  return { project: run(started, { kind: "add-design-solid", feature: base, body: built.body }), sketch, base };
}

function bodyOf(project: WorkbenchProject): NonNullable<WorkbenchProject["part"]["generalBodies"]>[number] {
  const found = project.part.generalBodies?.find((body) => body.id === BODY);
  assert(found !== undefined, "the sheet body exists");
  return found;
}

/** Adds a modifying step and replays the whole timeline, the way the app's commitWithReplay does. */
async function addAndReplay(project: WorkbenchProject, feature: DesignSolidFeature): Promise<{ readonly project: WorkbenchProject; readonly message: string | undefined }> {
  const added = run(project, { kind: "add-design-solid", feature, body: bodyOf(project) });
  return { project: await replay(added), message: (await replayAllBodies(added)).find((result) => result.featureId === feature.id)?.message };
}

async function replay(project: WorkbenchProject): Promise<WorkbenchProject> {
  return run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
}

function areaAndMoment(radius: number, thickness: number, length: number, angle: number): { readonly area: number; readonly moment: number } {
  const polygon = bentStripSection({ legMm: 0, flangeLengthMm: length, angleDeg: angle, innerRadiusMm: radius, thicknessMm: thickness, widthMm: 1 });
  let twice = 0;
  let momentSix = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    twice += cross;
    momentSix += (a[0] + b[0]) * cross;
  }
  return { area: Math.abs(twice) / 2, moment: (twice < 0 ? -1 : 1) * momentSix / 6 };
}

function polygonArea(loop: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

const MITER_ALL = { operation: "direct-edit" as const, bodyId: BODY, flangeEdgeIndex: 0, flangeMiterEdges: [1, 2, 3], sheetBendRadiusMm: 2, flangeLengthMm: 12, flangeAngleDeg: 90 };

export const sheetMetalTimelineTests: readonly TestCase[] = [
  {
    name: "a miter flange step replays through the timeline into a closed outward body, round-trips validation, and follows an edit of the sheet",
    run: async () => {
      const { project, sketch, base } = await sheetProject();
      const miter = step(sketch, "sheet-edge-flange", "miter", { ...MITER_ALL, valueMm: 12 });
      assert(validSolidFeaturePayload(miter), "the miter step is a valid payload");
      const made = await addAndReplay(project, miter);
      assert(made.message === undefined, `the miter step applies: ${made.message ?? ""}`);
      const body = bodyOf(made.project);
      assert(isClosedAndOriented(body.indices), "closed and consistently wound");
      const metrics = solidMetrics(body.positionsMm, body.indices);
      assert(metrics.outward, "outward");
      const { area, moment } = areaAndMoment(2, 2, 12, 90);
      near(metrics.volumeMm3, 60 * 40 * 2 + area * 200 + 8 * moment, metrics.volumeMm3 * 1e-6, "the volume is the sheet, four strips and eight mitre wedges");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(made.project))).ok, "the project with a miter step survives a save and load");
      assert(flangeEdgesOf(miter).join() === "0,1,2,3", "the step lists its whole chain");
      // Edit the sheet: 3 mm instead of 2. The miter flange is replayed on the new sheet.
      const thicker = run(made.project, { kind: "update-design-solid", feature: { ...base, sheetThicknessMm: 3, valueMm: 3 }, body: bodyOf(made.project) });
      const replayed = await replay(thicker);
      const thickBody = bodyOf(replayed);
      assert(isClosedAndOriented(thickBody.indices), "closed after the edit");
      const thick = areaAndMoment(2, 3, 12, 90);
      near(solidMetrics(thickBody.positionsMm, thickBody.indices).volumeMm3, 60 * 40 * 3 + thick.area * 200 + 8 * thick.moment, 0.01, "the rebuilt rim has the new thickness");
    }
  },
  {
    name: "miter step payloads: only an edge flange may list a chain, the chain cannot repeat the first edge or be empty, and every number is checked",
    run: async () => {
      const { sketch } = await sheetProject();
      const good = step(sketch, "sheet-edge-flange", "m", { ...MITER_ALL });
      assert(validSolidFeaturePayload(good), "accepted");
      for (const [label, patch] of [
        ["an empty chain", { flangeMiterEdges: [] }],
        ["the first edge repeated", { flangeMiterEdges: [0, 1] }],
        ["a repeated edge", { flangeMiterEdges: [1, 1] }],
        ["a fractional edge", { flangeMiterEdges: [1.5] }],
        ["a negative edge", { flangeMiterEdges: [-1] }],
        ["a text edge", { flangeMiterEdges: ["1"] }]
      ] as const) assert(!validSolidFeaturePayload({ ...good, ...patch }), `${label} is refused`);
      assert(!validSolidFeaturePayload({ ...step(sketch, "sheet-hem", "h", { sheetThicknessMm: 2, sheetBendRadiusMm: 1, flangeLengthMm: 5, hemStyle: "closed" }), flangeMiterEdges: [1] }), "a hem cannot carry a chain");
    }
  },
  {
    name: "an open miter flange next to a plain flange with a corner relief gives way at the shared corner and stays closed",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const chain = step(sketch, "sheet-edge-flange", "chain", { ...MITER_ALL, flangeMiterEdges: [1], flangeLengthMm: 10 });
      const afterChain = await addAndReplay(project, chain);
      assert(afterChain.message === undefined, `chain: ${afterChain.message ?? ""}`);
      const plain = step(sketch, "sheet-edge-flange", "plain", { operation: "direct-edit", bodyId: BODY, flangeEdgeIndex: 2, sheetBendRadiusMm: 2, flangeLengthMm: 10, flangeAngleDeg: 90, flangeReliefMm: 2 });
      const both = await addAndReplay(afterChain.project, plain);
      assert(both.message === undefined, `plain flange: ${both.message ?? ""}`);
      const body = bodyOf(both.project);
      assert(isClosedAndOriented(body.indices), "closed with the gap");
      const { area, moment } = areaAndMoment(2, 2, 10, 90);
      // Edge 0 (40) and edge 1 (60) mitre at their shared corner; edge 1's far end and edge 2 (40) each give up 1 mm at their corner.
      near(solidMetrics(body.positionsMm, body.indices).volumeMm3, 60 * 40 * 2 + area * (40 + 59 + 39) + 2 * moment, 0.02, "volume = sheet + three shortened strips + the one mitre");
    }
  },
  {
    name: "the flat pattern of a mitred rim is the sheet plus its flange blanks cut on the neutral fibre's mitre line, developed with the K-factor",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const made = await addAndReplay(project, step(sketch, "sheet-edge-flange", "miter", { ...MITER_ALL }));
      const flat = await flatPatternForBody(made.project, BODY);
      assert(flat.ok, `flat pattern: ${flat.ok ? "" : flat.message}`);
      if (!flat.ok) return;
      const rn = 2 + DEFAULT_K_FACTOR * 2;
      const allowance = sheetBendAllowanceMm(90, 2, 2);
      near(allowance, (Math.PI / 2) * rn, 1e-9, "the bend allowance is the neutral arc");
      const reach = allowance + 12;
      // Each mitred end adds the area between the plate edge and the cut: the integral of the neutral-fibre offset over the developed reach.
      const perEnd = rn * rn * (1 - Math.cos(Math.PI / 2)) + 12 * rn;
      const expected = 60 * 40 + reach * 200 + 8 * perEnd;
      near(polygonArea(flat.layout.outlinesMm[0]!), expected, expected * 0.002, "flat area = sheet + 4 flange rectangles + 8 mitre wedges");
      assert(flat.bends.length === 4 && flat.bends.every((bend) => bend.source === "default" && Math.abs(bend.kFactor - DEFAULT_K_FACTOR) < 1e-12), "four bends developed with the default K-factor");
      const lengths = flat.layout.bendLinesMm.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])).sort((x, y) => x - y);
      const midOffset = rn * Math.sin(Math.PI / 4);
      near(lengths[0]!, 40 + 2 * midOffset, 1e-6, "a short side's bend line runs on to the mitre cut at both ends");
      near(lengths[3]!, 60 + 2 * midOffset, 1e-6, "and so does a long side's");
      assert(flat.notes.every((note) => !note.includes("relief")), "mitred corners do not ask for a corner relief");
      const svg = flatLayoutSvg(flat.layout);
      const dxf = flatLayoutDxf(flat.layout);
      assert(svg.includes("bend-line") && dxf.includes("BEND"), "the pattern exports to SVG and DXF");
    }
  },
  {
    name: "jog payloads: all four numbers are needed, the angle stays under 90°, a zero step is refused, and only a jog may carry them",
    run: async () => {
      const { sketch } = await sheetProject();
      const good = step(sketch, "sheet-jog", "jog", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 15, jogOffsetMm: 8, jogAngleDeg: 45, sheetBendRadiusMm: 2 });
      assert(validSolidFeaturePayload(good), "accepted");
      for (const [label, patch] of [
        ["a 90° jog", { jogAngleDeg: 90 }], ["a 0.5° jog", { jogAngleDeg: 0.5 }], ["no step", { jogOffsetMm: 0 }],
        ["a negative position", { jogPositionMm: -1 }], ["a fractional edge", { jogEdgeIndex: 0.5 }], ["a new body", { operation: "new-body" as const }]
      ] as const) assert(!validSolidFeaturePayload({ ...good, ...patch }), `${label} is refused`);
      const { jogAngleDeg: _angle, ...missing } = good;
      void _angle;
      assert(!validSolidFeaturePayload(missing), "a jog without an angle is refused");
      assert(!validSolidFeaturePayload({ ...step(sketch, "sheet-edge-flange", "f", { operation: "direct-edit", flangeEdgeIndex: 0, sheetBendRadiusMm: 1, flangeLengthMm: 5, flangeAngleDeg: 90 }), jogOffsetMm: 5 }), "jog fields on a flange are refused");
    }
  },
  {
    name: "a jog step replays into a stepped, closed body of the same volume, and its flat pattern is the developed length with the K-factor",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const jog = step(sketch, "sheet-jog", "jog", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 15, jogOffsetMm: 8, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 8 });
      const made = await addAndReplay(project, jog);
      assert(made.message === undefined, `the jog applies: ${made.message ?? ""}`);
      const body = bodyOf(made.project);
      assert(isClosedAndOriented(body.indices), "closed");
      const metrics = solidMetrics(body.positionsMm, body.indices);
      assert(metrics.outward, "outward");
      near(metrics.volumeMm3, 60 * 40 * 2, 60 * 40 * 2 * 0.006, "the jog keeps the sheet's volume");
      near(metrics.boundsMm.max[2], 2 + 8, 1e-6, "the far side stands 8 mm higher");
      const made2 = jogProfile({ offsetMm: 8, angleDeg: 45, innerRadiusMm: 2 }, 2);
      assert(made2.ok, "the profile exists");
      if (!made2.ok) return;
      const profile = made2.profile;
      // Developed length measured from the formed mesh: near flat + far flat + web + two bends developed with K.
      const nearFlat = 15;
      const farFlat = metrics.boundsMm.max[0] - (-30 + 15 + profile.runMm);
      const allowance = sheetBendAllowanceMm(45, 2, 2);
      const developed = nearFlat + farFlat + profile.webMm + 2 * allowance;
      const flat = await flatPatternForBody(made.project, BODY);
      assert(flat.ok, `flat pattern: ${flat.ok ? "" : flat.message}`);
      if (!flat.ok) return;
      const xs = flat.layout.outlinesMm.flat().map((point) => point[0]);
      near(Math.max(...xs) - Math.min(...xs), developed, 1e-6, "the blank is as long as the developed length");
      near(Math.max(...xs) - Math.min(...xs), 60 + 2 * (Math.PI / 4) * 2 * (DEFAULT_K_FACTOR - 0.5), 1e-6, "which is the sheet plus 2·α·t·(K − ½)");
      assert(flat.layout.bendLinesMm.length === 2 && flat.bends.length === 2, "a jog unfolds with two bend lines");
      const lines = flat.layout.bendLinesMm.map(([a, b]) => ({ x: (a[0] + b[0]) / 2, length: Math.hypot(b[0] - a[0], b[1] - a[1]) })).sort((p, q) => p.x - q.x);
      near(lines[0]!.length, 40, 1e-6, "each bend line spans the sheet's width");
      near(lines[0]!.x, -30 + 15 + allowance / 2, 1e-6, "the first bend line is at the middle of the first bend");
      near(lines[1]!.x - lines[0]!.x, allowance + profile.webMm, 1e-6, "the second is a bend allowance plus the web further on");
      const outline = flat.layout.outlinesMm[0]!;
      near(polygonArea(outline), (60 + 2 * (Math.PI / 4) * 2 * (DEFAULT_K_FACTOR - 0.5)) * 40, 1e-6, "the blank is a plain rectangle");
    }
  },
  {
    name: "jogs follow the order rules: a second jog beyond the first unfolds with both, one inside the first or on another edge is reported and skipped",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const first = step(sketch, "sheet-jog", "jog1", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 10, jogOffsetMm: 8, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 8 });
      const one = await addAndReplay(project, first);
      assert(one.message === undefined, "first jog");
      const second = step(sketch, "sheet-jog", "jog2", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 30, jogOffsetMm: -8, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 8 });
      const two = await addAndReplay(one.project, second);
      assert(two.message === undefined, `second jog beyond the first: ${two.message ?? ""}`);
      const metrics = solidMetrics(bodyOf(two.project).positionsMm, bodyOf(two.project).indices);
      assert(isClosedAndOriented(bodyOf(two.project).indices), "closed after two jogs");
      near(metrics.boundsMm.max[2], 10, 1e-6, "the middle section stands 8 mm up");
      near(metrics.boundsMm.min[2], 0, 1e-6, "and the far end is back down");
      const flat = await flatPatternForBody(two.project, BODY);
      assert(flat.ok, `flat pattern: ${flat.ok ? "" : flat.message}`);
      if (flat.ok) {
        const xs = flat.layout.outlinesMm.flat().map((point) => point[0]);
        near(Math.max(...xs) - Math.min(...xs), 60 + 2 * (2 * (Math.PI / 4) * 2 * (DEFAULT_K_FACTOR - 0.5)), 1e-6, "both jogs shorten the blank by the same K correction");
        assert(flat.layout.bendLinesMm.length === 4 && flat.bends.length === 4, "four bend lines");
      }
      const inside = await addAndReplay(one.project, step(sketch, "sheet-jog", "jog3", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 12, jogOffsetMm: 5, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 5 }));
      assert(inside.message !== undefined && /inside the previous jog/u.test(inside.message), `a jog inside the first is refused: ${inside.message ?? "applied"}`);
      const elsewhere = await addAndReplay(one.project, step(sketch, "sheet-jog", "jog4", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 1, jogPositionMm: 30, jogOffsetMm: 5, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 5 }));
      assert(elsewhere.message !== undefined && /same edge/u.test(elsewhere.message), `a jog on another edge is refused: ${elsewhere.message ?? "applied"}`);
      const tooBig = await addAndReplay(project, step(sketch, "sheet-jog", "jog5", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 10, jogOffsetMm: 0.4, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 0.4 }));
      assert(tooBig.message !== undefined && /too small/u.test(tooBig.message), `a step smaller than its bends is refused: ${tooBig.message ?? "applied"}`);
    }
  },
  {
    name: "a jog whose position is edited in the inspector replays at the new place, and its fields validate",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const jog = step(sketch, "sheet-jog", "jog", { operation: "direct-edit", bodyId: BODY, jogEdgeIndex: 0, jogPositionMm: 10, jogOffsetMm: 8, jogAngleDeg: 45, sheetBendRadiusMm: 2, valueMm: 8, name: "Jog 0 (8 mm, 45°)" });
      const fields = parameterFieldsOf(jog);
      assert(fields !== undefined && fields.some((field) => field.id === "position") && fields.some((field) => field.id === "offset"), "the jog lists its position and offset");
      const edited = applyParameterValues(jog, { ...parameterValuesOf(jog), position: "20", offset: "-6" });
      assert(edited.ok, `edit accepted: ${edited.ok ? "" : edited.message}`);
      if (!edited.ok) return;
      assert(edited.feature.jogPositionMm === 20 && edited.feature.jogOffsetMm === -6, "values are applied");
      assert(!applyParameterValues(jog, { ...parameterValuesOf(jog), angle: "95" }).ok, "a 95° jog angle is refused");
      const made = await addAndReplay(project, edited.feature);
      assert(made.message === undefined, `edited jog applies: ${made.message ?? ""}`);
      near(solidMetrics(bodyOf(made.project).positionsMm, bodyOf(made.project).indices).boundsMm.min[2], -6, 1e-6, "it now steps down 6 mm");
    }
  },
  {
    name: "a bend row is a K-factor, a bend allowance or a bend deduction, and all three describe the same bend",
    run: () => {
      const k = 0.38;
      const allowance = sheetBendAllowanceMm(90, 3, 2, k);
      const deduction = 2 * Math.tan(Math.PI / 4) * (3 + 2) - allowance;
      near(kFactorOfRow({ thicknessMm: 2, innerRadiusMm: 3, kFactor: k }), k, 1e-12, "K row");
      near(kFactorOfRow({ thicknessMm: 2, innerRadiusMm: 3, bendAllowanceMm: allowance }), k, 1e-9, "an allowance for 90° gives back K");
      near(kFactorOfRow({ thicknessMm: 2, innerRadiusMm: 3, bendDeductionMm: deduction }), k, 1e-9, "a deduction for 90° gives back K");
      const sixty = sheetBendAllowanceMm(60, 3, 2, k);
      near(kFactorOfRow({ thicknessMm: 2, innerRadiusMm: 3, angleDeg: 60, bendAllowanceMm: sixty }), k, 1e-9, "an allowance stated for 60° gives back K at 60°");
      const table: BendTable = { defaultKFactor: 0.44, rows: [
        { thicknessMm: 2, innerRadiusMm: 2, kFactor: 0.3 },
        { thicknessMm: 2, innerRadiusMm: 6, kFactor: 0.5 },
        { thicknessMm: 2, innerRadiusMm: 2, angleDeg: 45, kFactor: 0.2 },
        { thicknessMm: 3, innerRadiusMm: 3, bendAllowanceMm: sheetBendAllowanceMm(90, 3, 3, 0.41) }
      ] };
      const exact = lookupBendK(table, 2, 2, 90);
      assert(exact.source === "table" && exact.kFactor === 0.3, "an exact thickness and radius uses its row");
      const angled = lookupBendK(table, 2, 2, 45);
      assert(angled.source === "table" && angled.kFactor === 0.2, "a row for the exact angle beats the any-angle row");
      const between = lookupBendK(table, 2, 4, 90);
      assert(between.source === "interpolated", "a radius between two rows is interpolated");
      near(between.kFactor, 0.4, 1e-12, "halfway in radius is halfway in K");
      const converted = lookupBendK(table, 3, 3, 90);
      near(converted.kFactor, 0.41, 1e-9, "an allowance row becomes its K");
      const outside = lookupBendK(table, 2, 9, 90);
      assert(outside.source === "default" && outside.kFactor === 0.44, "beyond the table the default K is used, not an extrapolation");
      assert(lookupBendK(table, 5, 2, 90).source === "default", "a thickness with no rows uses the default");
      assert(lookupBendK(undefined, 2, 2, 90).kFactor === DEFAULT_K_FACTOR, "no table means the default K-factor");
      const bend = developBend((t, r, a) => lookupBendK(table, t, r, a), 2, 2, 90);
      near(bend.bendAllowanceMm, (Math.PI / 2) * (2 + 0.3 * 2), 1e-9, "the developed allowance uses the table's K");
      near(bend.bendDeductionMm, 2 * bend.outsideSetbackMm - bend.bendAllowanceMm, 1e-9, "and the deduction follows");
    }
  },
  {
    name: "a bend table round-trips through CSV, rejects bad rows, and the bend report counts bends by size",
    run: () => {
      const table: BendTable = { defaultKFactor: 0.44, rows: [
        { thicknessMm: 1.5, innerRadiusMm: 1.5, kFactor: 0.33 },
        { thicknessMm: 2, innerRadiusMm: 2, angleDeg: 90, bendAllowanceMm: 4.2 },
        { thicknessMm: 3, innerRadiusMm: 3, bendDeductionMm: 5.1 }
      ] };
      const csv = bendTableRowsCsv(table);
      assert(csv.startsWith("thickness_mm,inner_radius_mm,angle_deg,k_factor,bend_allowance_mm,bend_deduction_mm"), "header");
      const parsed = parseBendTableCsv(csv);
      assert(parsed.ok && JSON.stringify(parsed.rows) === JSON.stringify(table.rows), `round trip keeps every row: ${parsed.ok ? JSON.stringify(parsed.rows) : parsed.message}`);
      assert(!parseBendTableCsv("2,2,,,,\n").ok, "a row with no K, allowance or deduction is refused");
      assert(!parseBendTableCsv("2,2,,0.3,4,\n").ok, "a row with two ways to develop is refused");
      assert(!parseBendTableCsv("0,2,,0.3,,\n").ok, "a zero thickness is refused");
      assert(!parseBendTableCsv("2,2,200,0.3,,\n").ok, "an angle above 180 is refused");
      assert(!parseBendTableCsv("2,2,0.3\n").ok, "a short line is refused");
      const resolve = (t: number, r: number, a: number) => lookupBendK(table, t, r, a);
      const report = bendReportCsv([developBend(resolve, 1.5, 1.5, 90), developBend(resolve, 1.5, 1.5, 90), developBend(resolve, 2, 5, 45)]);
      const lines = report.trim().split("\r\n");
      assert(lines.length === 3 && lines[0]!.startsWith("thickness_mm,inner_radius_mm,angle_deg,count"), "one line per distinct bend");
      assert(lines[1]!.split(",")[3] === "2" && lines[1]!.split(",")[5] === "table", "two identical bends are one line with count 2, from the table");
      assert(lines[2]!.split(",")[5] === "default", "a bend outside the table is marked default");
    }
  },
  {
    name: "a bend table on the sheet's step decides the flat pattern's K-factors, validates, and survives a save",
    run: async () => {
      const table: BendTable = { defaultKFactor: 0.44, rows: [{ thicknessMm: 2, innerRadiusMm: 2, kFactor: 0.3 }] };
      const { project, sketch, base } = await sheetProject({ sheetBendTable: table });
      assert(validSolidFeaturePayload(base), "a table on the base step is valid");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project))).ok, "and survives a save");
      for (const bad of [
        { ...table, defaultKFactor: 0 }, { ...table, rows: [{ thicknessMm: 2, innerRadiusMm: 2 }] },
        { ...table, rows: [{ thicknessMm: 2, innerRadiusMm: 2, kFactor: 0.3 }, { thicknessMm: 2, innerRadiusMm: 2, kFactor: 0.4 }] },
        { ...table, rows: [{ thicknessMm: -2, innerRadiusMm: 2, kFactor: 0.3 }] }, { rows: [] }
      ]) assert(!validSolidFeaturePayload({ ...base, sheetBendTable: bad }), `a bad table is refused: ${JSON.stringify(bad)}`);
      assert(!validSolidFeaturePayload({ ...step(sketch, "sheet-edge-flange", "f", { operation: "direct-edit", flangeEdgeIndex: 0, sheetBendRadiusMm: 1, flangeLengthMm: 5, flangeAngleDeg: 90 }), sheetBendTable: table }), "a table on a flange step is refused");
      const flange = step(sketch, "sheet-edge-flange", "f1", { operation: "direct-edit", bodyId: BODY, flangeEdgeIndex: 1, sheetBendRadiusMm: 2, flangeLengthMm: 15, flangeAngleDeg: 90 });
      const made = await addAndReplay(project, flange);
      assert(made.message === undefined, "flange applies");
      const withTable = await flatPatternForBody(made.project, BODY);
      assert(withTable.ok, "flat pattern with the table");
      if (!withTable.ok) return;
      const allowance = (Math.PI / 2) * (2 + 0.3 * 2);
      const ys = withTable.layout.outlinesMm.flat().map((point) => point[1]);
      near(Math.max(...ys) - Math.min(...ys), 40 + allowance + 15, 1e-6, "the flange blank is allowance(table K) + length beyond the sheet");
      assert(withTable.bends[0]!.source === "table" && withTable.bends[0]!.kFactor === 0.3, "the bend reports its source");
      assert(withTable.notes.some((note) => note.includes("1 of 1 bends developed from the bend table")), "the notes say the table was used");
      // The same part without a table develops with the default K and is longer or shorter accordingly.
      const without = run(made.project, { kind: "update-design-solid", feature: (({ sheetBendTable: _table, ...rest }) => (void _table, rest))(base as DesignSolidFeature & { sheetBendTable?: BendTable }) as DesignSolidFeature, body: bodyOf(made.project) });
      const defaultFlat = await flatPatternForBody(await replay(without), BODY);
      assert(defaultFlat.ok, "flat pattern without a table");
      if (!defaultFlat.ok) return;
      const defaultYs = defaultFlat.layout.outlinesMm.flat().map((point) => point[1]);
      near(Math.max(...defaultYs) - Math.min(...defaultYs), 40 + sheetBendAllowanceMm(90, 2, 2) + 15, 1e-6, "default K gives the default allowance");
      assert(defaultFlat.bends[0]!.source === "default", "and says so");
    }
  },
  {
    name: "a lofted bend is a closed outward ruled skin of constant wall: a cone's volume matches the analytic shell",
    run: () => {
      const ring = (radius: number, count: number): [number, number][] => Array.from({ length: count }, (_, i) => [radius * Math.cos(2 * Math.PI * i / count), radius * Math.sin(2 * Math.PI * i / count)]);
      const mesh = tessellateLoftedBend({ bottomMm: ring(20, 120), topMm: ring(10, 120), heightMm: 30, thicknessMm: 2 }, "xy");
      assert(mesh.positionsMm.length > 0, "built");
      assert(isClosedAndOriented(mesh.indices), "closed and consistently wound");
      const metrics = solidMetrics(mesh.positionsMm, mesh.indices);
      assert(metrics.outward, "outward");
      const slant = Math.hypot(30, 10);
      const horizontal = 2 / (30 / slant);
      const frustum = (r1: number, r2: number): number => Math.PI * 30 / 3 * (r1 * r1 + r1 * r2 + r2 * r2);
      const expected = frustum(20 + horizontal, 10 + horizontal) - frustum(20, 10);
      near(metrics.volumeMm3, expected, expected * 0.01, "volume = outer frustum − inner frustum, wall 2 mm square to the slope");
      near(metrics.boundsMm.min[2], 0, 1e-9, "starts on the bottom plane");
      near(metrics.boundsMm.max[2], 30, 1e-9, "ends on the top plane");
      near(metrics.boundsMm.max[0], 20 + horizontal, 0.01, "outer rim sits one wall thickness (along the normal) outside");
      // A rectangle-to-rectangle transition keeps a constant wall at the mitred corners and is closed too.
      const box = tessellateLoftedBend({ bottomMm: [[-20, -15], [20, -15], [20, 15], [-20, 15]], topMm: [[-10, -7.5], [10, -7.5], [10, 7.5], [-10, 7.5]], heightMm: 20, thicknessMm: 2 }, "xy");
      assert(isClosedAndOriented(box.indices), "rectangular transition closed");
      const boxMetrics = solidMetrics(box.positionsMm, box.indices);
      assert(boxMetrics.outward && boxMetrics.volumeMm3 > 0, "outward with volume");
      const slopeX = Math.hypot(20, 10);
      near(boxMetrics.boundsMm.max[0], 20 + 2 * slopeX / 20, 1e-6, "the long faces are pushed out by 2 mm along their normal");
      const placed = tessellateLoftedBend({ bottomMm: ring(20, 60), topMm: ring(10, 60), heightMm: 30, thicknessMm: 2 }, "xz");
      const placedMetrics = solidMetrics(placed.positionsMm, placed.indices);
      assert(isClosedAndOriented(placed.indices) && placedMetrics.outward, "placed on the XZ plane it is still outward");
      near(placedMetrics.boundsMm.min[1], -30, 1e-9, "XZ plane height runs along -Y");
      assert(tessellateLoftedBend({ bottomMm: ring(20, 60), topMm: ring(10, 60), heightMm: 30, thicknessMm: 0 }, "xy").positionsMm.length === 0, "a zero wall builds nothing");
    }
  },
  {
    name: "a cone unrolls to an annular sector whose area is the neutral cone's lateral area, a cylinder to a rectangle, and other pairs are refused",
    run: () => {
      const cone = coneDevelopment(20, 10, 30, 2, 0.44)!;
      const slant = Math.hypot(30, 10);
      const horizontal = 0.44 * 2 / (30 / slant);
      near(cone.bottomNeutralRadiusMm, 20 + horizontal, 1e-12, "neutral radius at the bottom");
      near(cone.slantMm, slant, 1e-12, "slant length");
      const lateral = Math.PI * (cone.bottomNeutralRadiusMm + cone.topNeutralRadiusMm) * cone.slantMm;
      near(polygonArea(cone.layout.outlinesMm[0]!), lateral, lateral * 5e-4, "flat area = π (R1 + R2) · slant");
      near(cone.outerRadiusMm * cone.sectorDeg * Math.PI / 180, 2 * Math.PI * cone.bottomNeutralRadiusMm, 1e-9, "the outer arc is the bottom's neutral circumference");
      near(cone.outerRadiusMm - cone.innerRadiusMm, cone.slantMm, 1e-9, "the sector is as deep as the slant");
      const cylinder = coneDevelopment(15, 15, 40, 2, 0.5)!;
      near(cylinder.outerArcMm, 2 * Math.PI * 16, 1e-9, "a cylinder unrolls to its neutral circumference");
      near(polygonArea(cylinder.layout.outlinesMm[0]!), 2 * Math.PI * 16 * 40, 1e-6, "as a rectangle");
      assert(coneDevelopment(0, 10, 30, 2, 0.44) === undefined && coneDevelopment(10, 10, 0, 2, 0.44) === undefined, "zero dimensions are refused");
      const circle = Array.from({ length: 72 }, (_, i): [number, number] => [5 * Math.cos(2 * Math.PI * i / 72), 5 * Math.sin(2 * Math.PI * i / 72)]);
      assert(circleOfOutline(circle)?.radiusMm !== undefined && Math.abs(circleOfOutline(circle)!.radiusMm - 5) < 1e-9, "a circle is recognised");
      assert(circleOfOutline([[0, 0], [4, 0], [4, 3], [0, 3]]) === undefined, "a rectangle is not");
    }
  },
  {
    name: "a lofted bend step builds from the sketch, replays closed, validates, and unfolds when it is a cone",
    run: async () => {
      const started = run(createWorkbenchProject("project:test-lofted"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketch = designOf(started).features[0] as DesignSketchFeature;
      const circle = detectSketchProfiles(sketch.sketch).find((profile) => profile.boundary.kind === "circle" && profile.id === "profile:centered-bore-profile")!;
      const lofted = step(sketch, "sheet-lofted-bend", "lofted", { profileIds: [circle.id], valueMm: 20, sheetThicknessMm: 1.5, loftTopScale: 3, bodyId: "general-body:lofted" });
      assert(validSolidFeaturePayload(lofted), "the step is valid");
      assert(!validSolidFeaturePayload({ ...lofted, sheetThicknessMm: undefined } as unknown as DesignSolidFeature), "a lofted bend needs its thickness");
      const { loftTopScale: _scale, ...noTop } = lofted;
      void _scale;
      assert(!validSolidFeaturePayload(noTop), "and a top scale or a second profile");
      const built = await rebuildSolidFeature(lofted, sketch);
      assert(built.ok, `builds: ${built.ok ? "" : built.message}`);
      if (!built.ok) return;
      assert(isClosedAndOriented(built.body.indices), "closed");
      const metrics = solidMetrics(built.body.positionsMm, built.body.indices);
      assert(metrics.outward, "outward");
      const slant = Math.hypot(20, 10);
      const horizontal = 1.5 / (20 / slant);
      const frustum = (r1: number, r2: number): number => Math.PI * 20 / 3 * (r1 * r1 + r1 * r2 + r2 * r2);
      const expected = frustum(5 + horizontal, 15 + horizontal) - frustum(5, 15);
      near(metrics.volumeMm3, expected, expected * 0.01, "an upward-widening cone from the bore circle");
      let project = run(started, { kind: "add-design-solid", feature: lofted, body: built.body });
      project = await replay(project);
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project))).ok, "the project survives a save and load");
      const flat = await flatPatternForBody(project, "general-body:lofted");
      assert(flat.ok, `cone unfolds: ${flat.ok ? "" : flat.message}`);
      if (flat.ok) {
        const horizontalK = DEFAULT_K_FACTOR * 1.5 / (20 / slant);
        const lateral = Math.PI * ((5 + horizontalK) + (15 + horizontalK)) * slant;
        near(polygonArea(flat.layout.outlinesMm[0]!), lateral, lateral * 5e-4, "the blank's area is the neutral cone's lateral area");
      }
      // A rectangle-to-rectangle skin builds but has no honest flat pattern.
      const rect = detectSketchProfiles(sketch.sketch).find((profile) => profile.boundary.kind === "rectangle")!;
      const boxed = step(sketch, "sheet-lofted-bend", "boxed", { profileIds: [rect.id], valueMm: 20, sheetThicknessMm: 1.5, loftTopScale: 0.5, bodyId: "general-body:boxed" });
      const boxBuilt = await rebuildSolidFeature(boxed, sketch);
      assert(boxBuilt.ok && isClosedAndOriented(boxBuilt.body.indices), "a rectangular transition builds closed");
      if (!boxBuilt.ok) return;
      const withBox = await replay(run(started, { kind: "add-design-solid", feature: boxed, body: boxBuilt.body }));
      const refused = await flatPatternForBody(withBox, "general-body:boxed");
      assert(!refused.ok && /cone or a cylinder/u.test(refused.message), `a non-circular transition is not unfolded: ${refused.ok ? "unfolded" : refused.message}`);
    }
  }
];
