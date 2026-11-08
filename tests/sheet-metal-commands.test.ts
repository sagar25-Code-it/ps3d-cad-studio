import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SheetBendTable, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { baseFeatureOf, designOf, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { sheetBendAllowanceMm } from "../packages/workbench-geometry/src/sheet-metal.js";
import { parseBendTableCsv } from "../packages/workbench-geometry/src/bend-table.js";
import { flatPatternForBody, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { bendTableUpdate, buildJogStep, buildLoftedBendStep, buildMiterFlangeStep, runSheetMetalCommand, type SheetCommandContext, type SheetMetalCommand } from "../apps/studio-web/src/sheet-metal-commands.js";
import { draftOf, tableFromDrafts } from "../apps/studio-web/src/bend-table-draft.js";
import { sheetFrameOf } from "../packages/workbench-geometry/src/sheet-edge-flange.js";
import { BODY, areaAndMoment, bodyOf, replay, run, sheetProject, step } from "./sheet-metal-timeline.test.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { assert, near, type TestCase } from "./test-kit.js";

type Vec3 = readonly [number, number, number];

interface Recorder {
  project: WorkbenchProject;
  readonly said: string[];
  readonly downloads: { text: string; fileName: string }[];
  readonly asked: string[];
  opened: string | undefined;
  committed: boolean;
}

/** A stand-in for the app: clicks come from `picks`, typed answers from `answers`, and committed steps are replayed like the app does. */
function fakeApp(initial: WorkbenchProject, picks: readonly Vec3[], answers: readonly string[], selectedId: string | null = BODY): { readonly recorder: Recorder; readonly run: (command: SheetMetalCommand) => Promise<void> } {
  const recorder: Recorder = { project: initial, said: [], downloads: [], asked: [], opened: undefined, committed: false };
  const pickQueue = [...picks];
  const answerQueue = [...answers];
  const run_ = async (command: SheetMetalCommand): Promise<void> => {
    const context: SheetCommandContext = {
      project: recorder.project,
      selectedId,
      ask: (label) => { recorder.asked.push(label); return answerQueue.shift() ?? null; },
      pick: async () => { const next = pickQueue.shift(); return next === undefined ? null : { pointMm: next }; },
      highlight: () => undefined,
      commit: async (feature: DesignSolidFeature, body: GeneralSolidBody) => {
        const added = run(recorder.project, { kind: "add-design-solid", feature, body });
        recorder.project = await replay(added);
        recorder.committed = true;
        return true;
      },
      say: (text) => { recorder.said.push(text); },
      download: (text, fileName) => { recorder.downloads.push({ text, fileName }); },
      openBendTable: (bodyId) => { recorder.opened = bodyId; }
    };
    await runSheetMetalCommand(command, context);
  };
  return { recorder, run: run_ };
}

const MITER_FIELDS = { operation: "direct-edit" as const, bodyId: BODY };

export const sheetMetalCommandTests: readonly TestCase[] = [
  {
    name: "Miter Flange: two clicks pick the first and last edge, the answers become the step, and the replayed body has the mitred corners",
    run: async () => {
      const { project } = await sheetProject();
      // Edges of the default plate: 0 left (x = -30), 1 bottom (y = -20), 2 right (x = 30), 3 top. The chain runs 0 -> 1 -> 2.
      const app = fakeApp(project, [[-30, 0, 2], [30, 0, 2]], ["2", "12", "90"]);
      await app.run("miter-flange");
      assert(app.recorder.committed, `the step was committed: ${app.recorder.said.join(" ")}`);
      const history = designOf(app.recorder.project);
      const miter = history.features.find((feature) => feature.kind === "sheet-edge-flange") as DesignSolidFeature;
      assert(miter.flangeEdgeIndex === 0 && miter.flangeMiterEdges?.join() === "1,2", "the chain is edges 0, 1, 2");
      assert(miter.name.startsWith("Edge flange 0 miter ×3"), `named for what it does: ${miter.name}`);
      const body = bodyOf(app.recorder.project);
      assert(isClosedAndOriented(body.indices), "closed");
      const { area, moment } = areaAndMoment(2, 2, 12, 90);
      near(solidMetrics(body.positionsMm, body.indices).volumeMm3, 60 * 40 * 2 + area * (40 + 60 + 40) + 4 * moment, 0.01, "sheet + three strips + two mitred corners");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(app.recorder.project))).ok, "saves and loads");
    }
  },
  {
    name: "Miter Flange: Esc during a pick, a single edge and bad numbers add nothing, and the replies say why",
    run: async () => {
      const { project } = await sheetProject();
      const escaped = fakeApp(project, [], []);
      await escaped.run("miter-flange");
      assert(!escaped.recorder.committed && escaped.recorder.asked.length === 0, "Esc on the first pick ends the command quietly");
      const single = fakeApp(project, [[-30, 0, 2], [-30, 1, 2]], ["2", "12", "90"]);
      await single.run("miter-flange");
      assert(!single.recorder.committed && single.recorder.said.some((line) => /at least two/u.test(line)), `one edge is explained: ${single.recorder.said.join(" ")}`);
      const bad = fakeApp(project, [[-30, 0, 2], [30, 0, 2]], ["2", "0", "90"]);
      await bad.run("miter-flange");
      assert(!bad.recorder.committed && bad.recorder.said.some((line) => /flange length above 0/u.test(line)), `a zero length is explained: ${bad.recorder.said.join(" ")}`);
      const around = fakeApp(project, [[30, 0, 2], [-30, 0, 2]], ["2", "12", "90"]);
      await around.run("miter-flange");
      const wrapped = designOf(around.recorder.project).features.find((feature) => feature.kind === "sheet-edge-flange") as DesignSolidFeature | undefined;
      assert(wrapped?.flangeEdgeIndex === 2 && wrapped.flangeMiterEdges?.join() === "3,0", "from the right edge forward the chain wraps through the top edge to the left edge");
    }
  },
  {
    name: "Miter Flange builder: refuses one edge, an unreachable last edge and bad numbers",
    run: async () => {
      const { project, base } = await sheetProject();
      const built = sheetFrameOf(bodyOf(project), [0, 0, 1])!;
      const request = { base, bodyId: BODY, frame: built, firstEdge: 0, lastEdge: 1, innerRadiusMm: 2, flangeLengthMm: 10, angleDeg: 90, reliefMm: 0, id: "feature:m" };
      assert(buildMiterFlangeStep(request).ok, "two connected edges build");
      const single = buildMiterFlangeStep({ ...request, lastEdge: 0 });
      assert(!single.ok && /at least two/u.test(single.message), "one edge is refused");
      assert(!buildMiterFlangeStep({ ...request, flangeLengthMm: 0 }).ok, "a zero length is refused");
      assert(!buildMiterFlangeStep({ ...request, angleDeg: 200 }).ok, "an angle above 180 is refused");
      assert(!buildMiterFlangeStep({ ...request, reliefMm: -1 }).ok, "a negative relief is refused");
      const whole = buildMiterFlangeStep({ ...request, firstEdge: 0, lastEdge: 3 });
      assert(whole.ok && whole.feature.flangeMiterEdges?.join() === "1,2,3", "the whole outline is edges 0 to 3");
    }
  },
  {
    name: "Jog: one click on the reference edge and four answers add a jog that steps the sheet and unfolds",
    run: async () => {
      const { project } = await sheetProject();
      const app = fakeApp(project, [[-30, 2, 2]], ["15", "8", "45", "2"]);
      await app.run("jog");
      assert(app.recorder.committed, `the jog was committed: ${app.recorder.said.join(" ")}`);
      const body = bodyOf(app.recorder.project);
      near(solidMetrics(body.positionsMm, body.indices).boundsMm.max[2], 10, 1e-6, "the far side is 8 mm up");
      const flat = await flatPatternForBody(app.recorder.project, BODY);
      assert(flat.ok && flat.bends.length === 2 && flat.layout.bendLinesMm.length === 2, "and it unfolds with two bend lines");
      const refused = fakeApp(project, [[-30, 2, 2]], ["15", "0.3", "45", "2"]);
      await refused.run("jog");
      assert(!refused.recorder.committed && refused.recorder.said.some((line) => /too small/u.test(line)), `a step smaller than its bends is refused with the reason: ${refused.recorder.said.join(" ")}`);
      const base = baseFeatureOf(designOf(project), BODY)!;
      const frame = sheetFrameOf(bodyOf(project), [0, 0, 1])!;
      assert(!buildJogStep({ base, bodyId: BODY, frame, edgeIndex: 9, positionMm: 5, offsetMm: 5, angleDeg: 45, innerRadiusMm: 1, id: "feature:j" }).ok, "an unknown edge is refused");
      assert(!buildJogStep({ base, bodyId: BODY, frame, edgeIndex: 0, positionMm: -5, offsetMm: 5, angleDeg: 45, innerRadiusMm: 1, id: "feature:j" }).ok, "a negative position is refused");
      assert(!buildJogStep({ base, bodyId: BODY, frame, edgeIndex: 0, positionMm: 5, offsetMm: 5, angleDeg: 90, innerRadiusMm: 1, id: "feature:j" }).ok, "a 90° jog is refused");
    }
  },
  {
    name: "Bend Table CSV lists the bends of the part with the K-factor each was developed with; Bend Table opens the editor for the body",
    run: async () => {
      const table: SheetBendTable = { defaultKFactor: 0.44, rows: [{ thicknessMm: 2, innerRadiusMm: 2, kFactor: 0.3 }] };
      const { project, sketch } = await sheetProject({ sheetBendTable: table });
      const withFlange = await replay(run(project, { kind: "add-design-solid", feature: step(sketch, "sheet-edge-flange", "f", { ...MITER_FIELDS, flangeEdgeIndex: 1, sheetBendRadiusMm: 2, flangeLengthMm: 15, flangeAngleDeg: 90 }), body: bodyOf(project) }));
      const app = fakeApp(withFlange, [], []);
      await app.run("bend-table-csv");
      assert(app.recorder.downloads.length === 1, `one CSV downloaded: ${app.recorder.said.join(" ")}`);
      const lines = app.recorder.downloads[0]!.text.trim().split("\r\n");
      assert(lines.length === 2, "header and one bend line");
      const cells = lines[1]!.split(",");
      assert(cells[3] === "1" && cells[4] === "0.3" && cells[5] === "table", `the line says K 0.3 from the table: ${lines[1]}`);
      near(Number(cells[6]), sheetBendAllowanceMm(90, 2, 2, 0.3), 1e-4, "with the table's bend allowance");
      assert(app.recorder.downloads[0]!.fileName.endsWith("bend-table.csv"), "named for the part");
      const opens = fakeApp(withFlange, [], []);
      await opens.run("bend-table");
      assert(opens.recorder.opened === BODY, "the editor opens for the selected sheet");
      const bare = await sheetProject();
      const nothing = fakeApp(bare.project, [], []);
      await nothing.run("bend-table-csv");
      assert(nothing.recorder.downloads.length === 0 && nothing.recorder.said.some((line) => /no bends/u.test(line)), "a flat sheet has no bends to list");
    }
  },
  {
    name: "the bend table editor: rows become a table, bad rows are explained, and storing it on the sheet's step changes the flat pattern",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const result = tableFromDrafts("0.44", [
        { thickness: "2", radius: "2", angle: "", mode: "k", value: "0.31" },
        { thickness: "3", radius: "3", angle: "90", mode: "allowance", value: "6.2" },
        { thickness: "3", radius: "6", angle: "", mode: "deduction", value: "9" }
      ]);
      assert(result.ok && result.table.rows.length === 3, `three rows: ${result.ok ? "" : result.message}`);
      if (!result.ok) return;
      assert(JSON.stringify(result.table.rows.map(draftOf).map((draft) => draft.mode)) === JSON.stringify(["k", "allowance", "deduction"]), "each row remembers how it was given");
      assert(!tableFromDrafts("0", []).ok, "a zero default K is refused");
      assert(!tableFromDrafts("0.44", [{ thickness: "", radius: "2", angle: "", mode: "k", value: "0.3" }]).ok, "an empty thickness is refused");
      assert(!tableFromDrafts("0.44", [{ thickness: "2", radius: "2", angle: "", mode: "k", value: "0.3" }, { thickness: "2", radius: "2", angle: "", mode: "k", value: "0.4" }]).ok, "duplicate rows are refused");
      const stored = bendTableUpdate(project, BODY, result.table);
      assert(stored.ok, `stored: ${stored.ok ? "" : stored.message}`);
      if (!stored.ok) return;
      const next = await replay(run(project, { kind: "update-design-solid", feature: stored.feature, body: stored.body }));
      assert(baseFeatureOf(designOf(next), BODY)?.sheetBendTable?.rows.length === 3, "the table is on the base step");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(next))).ok, "and survives a save");
      const flanged = await replay(run(next, { kind: "add-design-solid", feature: step(sketch, "sheet-edge-flange", "f", { ...MITER_FIELDS, flangeEdgeIndex: 1, sheetBendRadiusMm: 2, flangeLengthMm: 15, flangeAngleDeg: 90 }), body: bodyOf(next) }));
      const flat = await flatPatternForBody(flanged, BODY);
      assert(flat.ok && flat.bends[0]!.source === "table" && Math.abs(flat.bends[0]!.kFactor - 0.31) < 1e-12, "the flat pattern uses the stored row");
      const cleared = bendTableUpdate(flanged, BODY, undefined);
      assert(cleared.ok && cleared.feature.sheetBendTable === undefined, "clearing removes it");
      const unknown = bendTableUpdate(project, "general-body:nothing", result.table);
      assert(!unknown.ok, "a body that is not in the timeline cannot keep a table");
      assert(parseBendTableCsv("2,2,,0.31,,\n3,3,90,,6.2,\n").ok, "the exported CSV shape reads back");
    }
  },
  {
    name: "Lofted Bend: a selected Loft becomes a sheet-metal transition body of the chosen thickness next to it",
    run: async () => {
      const { project, sketch } = await sheetProject();
      const circle = detectSketchProfiles(sketch.sketch).find((profile) => profile.entityIds.includes("entity:centered-bore-profile"))!;
      const loft = step(sketch, "loft", "loft1", { profileIds: [circle.id], valueMm: 20, loftTopScale: 3, bodyId: "general-body:loft1" });
      const built = await rebuildSolidFeature(loft, sketch as DesignSketchFeature);
      assert(built.ok, "the loft builds");
      if (!built.ok) return;
      const withLoft = run(project, { kind: "add-design-solid", feature: loft, body: built.body });
      const app = fakeApp(withLoft, [], ["1.5"], "general-body:loft1");
      await app.run("lofted-bend");
      assert(app.recorder.committed, `committed: ${app.recorder.said.join(" ")}`);
      const bodies = app.recorder.project.part.generalBodies ?? [];
      assert(bodies.length === 3, "the loft, the sheet and the new transition");
      const bend = bodies.find((body) => body.name.startsWith("Lofted bend"))!;
      assert(isClosedAndOriented(bend.indices) && solidMetrics(bend.positionsMm, bend.indices).outward, "closed and outward");
      const refused = fakeApp(project, [], ["1.5"], BODY);
      await refused.run("lofted-bend");
      assert(!refused.recorder.committed && refused.recorder.said.some((line) => /select a lofted solid/u.test(line)), "a body that is not a loft is explained");
      assert(!buildLoftedBendStep(loft, 0, "feature:x", "general-body:x").ok, "zero thickness is refused");
      assert(!buildLoftedBendStep({ ...loft, loftTopScale: undefined } as unknown as DesignSolidFeature, 1, "feature:x", "general-body:x").ok, "a loft with no top is refused");
    }
  }
];
