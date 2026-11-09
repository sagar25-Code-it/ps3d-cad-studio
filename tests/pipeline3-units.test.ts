import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWorkbenchProject, parseWorkbenchProjectText, resolveDisplayUnit, serializeWorkbenchProject, validateWorkbenchProject, withDisplayUnit } from "../packages/workbench-core/src/index.js";
import { gridSteps } from "../packages/workbench-sketch/src/camera.js";
import { DEFAULT_SNAP_ASSIST } from "../packages/workbench-sketch/src/snap-assist.js";
import { baseGridLabel, defaultLengthMm, defaultLengthText, gridStepsForUnit, labelLength, lengthTextFromDisplay, lengthTextToDisplay, planeOffsetText, readPlaneOffset, snapStepChoicesMm } from "../packages/workbench-sketch/src/unit-defaults.js";
import { createPs3dCollaborationGuide, handleWorkbenchMcpTool } from "../packages/workbench-mcp/src/index.js";
import { DEFAULT_REACH, validReach } from "../apps/studio-web/src/reach-settings.js";
import { rememberDisplayUnit, rememberedDisplayUnit, unitToShow } from "../apps/studio-web/src/display-unit-memory.js";
import { SketchInputPalette } from "../apps/studio-web/src/workspaces/sketch/SketchInputPalette.js";
import { SketchEditPanel } from "../apps/studio-web/src/workspaces/SketchEditPanel.js";
import { SketchCurveOptionsPanel, DEFAULT_CURVE_OPTION_FIELDS } from "../apps/studio-web/src/workspaces/SketchCurveOptions.js";
import { SketchPlaneDialog } from "../apps/studio-web/src/ui/SketchPlaneDialog.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { fresh, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";

/**
 * Wave 3, units: the display unit is saved with the project and remembered (N2-06), an inch document gets inch grid, snap steps and
 * starting values (R2-10, E18), and a remembered "to" extent no longer disables the height field in a project without a solid (R2-9).
 */

const noop = (): undefined => undefined;

export const pipeline3UnitTests: readonly TestCase[] = [
  {
    name: "Wave3 N2-06: the display unit is saved in the project, restored on open, validated, kept by every operation and reported by MCP; files without one open as before",
    run: async () => {
      const base = fresh();
      assert(base.displayUnit === undefined, "a new project records no unit");
      const inches = withDisplayUnit(base, "in");
      assert(validateWorkbenchProject(inches).ok, "a project with displayUnit in is valid");
      assert(!validateWorkbenchProject({ ...base, displayUnit: "cm" }).ok, "an unknown unit is refused");
      assert(/display unit/u.test(message(validateWorkbenchProject({ ...base, displayUnit: "furlong" }))), "and the message names the field");
      assert(validateWorkbenchProject({ ...base, unit: "in" }).ok === false, "the model unit itself must stay millimetres");
      const text = serializeWorkbenchProject(inches);
      assert(/"displayUnit": "in"/u.test(text), "the unit is written into the saved file");
      const reopened = parseWorkbenchProjectText(text);
      assert(reopened.ok && reopened.value.displayUnit === "in", "and comes back when the file is opened");
      // Every operation keeps it.
      const after = pipelineRun(inches, { kind: "new-design-sketch", plane: "datum:xz" });
      equal(after.displayUnit, "in", "an operation keeps the unit");
      equal(pipelineRun(after, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:c", kind: "circle", center: [0, 0], radiusMm: 5, construction: false }], addConstraints: [], label: "Draw" }).displayUnit, "in", "and so does an edit");
      // A file saved before the field existed.
      const legacy = parseWorkbenchProjectText(JSON.stringify(base));
      assert(legacy.ok && legacy.value.displayUnit === undefined, "a file without a unit opens with none recorded");
      // The decision.
      equal(resolveDisplayUnit("in", "mm", "mm"), "in", "the project's unit wins");
      equal(resolveDisplayUnit(undefined, "in", "mm"), "in", "otherwise the remembered unit");
      equal(resolveDisplayUnit(undefined, undefined, "mm"), "mm", "otherwise what the session shows");
      // Remembered across sessions, with storage that may be missing or throw.
      const store = new Map<string, string>();
      const holder = globalThis as unknown as { localStorage?: unknown };
      const saved = holder.localStorage;
      try {
        holder.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
        equal(rememberedDisplayUnit(), undefined, "nothing remembered at first");
        rememberDisplayUnit("in");
        equal(rememberedDisplayUnit(), "in", "the choice is remembered");
        equal(unitToShow(base, "mm"), "in", "a new project opens in the remembered unit");
        equal(unitToShow(withDisplayUnit(base, "mm"), "mm"), "mm", "but a project that says millimetres stays in them");
        store.set("ps3d.display-unit", "banana");
        equal(rememberedDisplayUnit(), undefined, "a damaged value is ignored");
        holder.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
        equal(rememberedDisplayUnit(), undefined, "blocked storage reads as nothing");
        rememberDisplayUnit("mm");
        equal(unitToShow(base, "mm"), "mm", "and the app still works");
      } finally {
        if (saved === undefined) delete holder.localStorage; else holder.localStorage = saved;
      }
      // MCP: the summary and a copy through preview/apply keep the unit.
      const summary = await handleWorkbenchMcpTool("ps3d_inspect_project", { project: inches });
      equal(summary.structuredContent["displayUnit"], "in", "ps3d_inspect_project reports the unit");
      const ack = { manifestSha256: String((await createPs3dCollaborationGuide())["manifestSha256"]), understood: true };
      const preview = await handleWorkbenchMcpTool("ps3d_preview_operation", { project: inches, operation: { operationId: "operation:du-1", expectedRevision: inches.revision, kind: "select-workspace", workspace: "part" }, guideAcknowledgement: ack });
      assert(preview.isError !== true && (preview.structuredContent["candidateProject"] as { displayUnit?: string }).displayUnit === "in", "a previewed copy keeps the unit");
      void pipelineApply;
    }
  },
  {
    name: "Wave3 R2-10, E18: an inch document gets an inch grid ladder, inch snap steps, round inch starting values and inch plane offsets; millimetres are unchanged",
    run: () => {
      // Grid: millimetres unchanged.
      for (const px of [0.02, 0.2, 1, 4]) {
        const metric = gridStepsForUnit(5, px, "mm");
        const old = gridSteps(5, px);
        equal(`${metric.minorMm}/${metric.majorMm}`, `${old.minorMm}/${old.majorMm}`, `millimetre grid at ${px} mm/px is as before`);
      }
      // Inches: the minor step is a decimal inch (0.01, 0.02, 0.05, 0.1, ...), never 0.1969 in.
      const inchLadder = new Set<string>();
      for (const px of [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 4, 10]) {
        const steps = gridStepsForUnit(5, px, "in");
        const minorIn = Number((steps.minorMm / 25.4).toPrecision(6));
        inchLadder.add(String(minorIn));
        assert(steps.minorMm >= 14 * px * (1 - 1e-9), `the inch grid keeps lines 14 px apart at ${px} mm/px`);
        assert([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].includes(minorIn), `an inch document's minor grid is a round inch value (${minorIn})`);
      }
      assert(!inchLadder.has("0.19685"), `the 5 mm base is not shown as 0.19685 in (${[...inchLadder].join(", ")})`);
      assert(inchLadder.has("0.1") || inchLadder.has("0.2"), "the ladder passes through tenths of an inch");
      equal(baseGridLabel(5, "in"), "0.1 in", "the base grid reads 0.1 in");
      equal(baseGridLabel(5, "mm"), "5 mm", "and 5 mm in millimetres");
      // A grid the person set themselves is kept.
      near(gridStepsForUnit(25.4, 1.5, "in").minorMm, 25.4, 1e-9, "a 1 inch grid stays a 1 inch grid");
      // Snap steps.
      const mmSteps = snapStepChoicesMm("mm");
      assert(mmSteps.includes(0.5) && mmSteps.includes(25), "millimetre snap steps are the old list");
      const inSteps = snapStepChoicesMm("in");
      assert(inSteps.some((step) => Math.abs(step - 1.5875) < 1e-9) && inSteps.some((step) => Math.abs(step - 25.4) < 1e-9), "inch snap steps include 1/16 in and 1 in");
      assert(!inSteps.includes(0.1) && !inSteps.includes(0.25), "and none of the metric values");
      equal(labelLength(1.5875, "in"), "0.0625 in", "a step is labelled in inches");
      // Starting values.
      equal(defaultLengthText(2, "in"), "0.0625", "2 mm starts as 1/16 in");
      equal(defaultLengthText(5, "in"), "0.25", "5 mm starts as 1/4 in");
      equal(defaultLengthText(10, "in"), "0.5", "10 mm starts as 1/2 in");
      equal(defaultLengthText(3, "in"), "0.125", "3 mm starts as 1/8 in");
      equal(defaultLengthText(5, "mm"), "5", "millimetres keep the metric default");
      near(defaultLengthMm(5, "in"), 6.35, 1e-9, "the stored value is exactly a quarter inch");
      // Option fields: kept in millimetres, shown and typed in the unit.
      equal(lengthTextToDisplay("25.4", "in"), "1", "25.4 mm shows as 1");
      equal(lengthTextFromDisplay("1", "in"), "25.4", "and 1 typed in an inch document is stored as 25.4 mm");
      equal(lengthTextToDisplay("7", "mm"), "7", "millimetres pass through");
      // Plane offset: the dialog read it with Number('0.5 in') and failed.
      const half = readPlaneOffset("0.5 in", "in");
      assert(half.ok && Math.abs(half.valueMm - 12.7) < 1e-9, "0.5 in is a plane offset in an inch document");
      const bare = readPlaneOffset("2", "in");
      assert(bare.ok && Math.abs(bare.valueMm - 50.8) < 1e-9, "a bare number is inches there");
      const mixed = readPlaneOffset("12 mm", "in");
      assert(mixed.ok && mixed.valueMm === 12, "a unit wins over the document's");
      const frac = readPlaneOffset("1-1/2", "in");
      assert(frac.ok && Math.abs(frac.valueMm - 38.1) < 1e-9, "1-1/2 is a plane offset too");
      const comma = readPlaneOffset("2,5", "mm");
      assert(comma.ok && comma.valueMm === 2.5, "a decimal comma is read");
      const bad = readPlaneOffset("far", "in");
      assert(!bad.ok && /offset/u.test(bad.message), `a bad offset says so: ${bad.ok ? "" : bad.message}`);
      assert(readPlaneOffset("", "in").ok, "an empty offset is zero");
      equal(planeOffsetText(12.7, "in"), "0.5", "the dialog starts at 0.5 for 12.7 mm in inches");

      // What the panels render.
      const palette = renderToStaticMarkup(createElement(SketchInputPalette, { settings: DEFAULT_SNAP_ASSIST, gridMm: 2.54, unit: "in", onChange: noop, onOpenShortcuts: noop }));
      assert(/Grid \(0\.1 in\)/u.test(palette) && /0\.0625 in/u.test(palette) && !/ mm</u.test(palette), `the inch palette lists inch snap steps and the inch grid: ${palette.slice(0, 300)}`);
      const metricPalette = renderToStaticMarkup(createElement(SketchInputPalette, { settings: DEFAULT_SNAP_ASSIST, gridMm: 5, onChange: noop, onOpenShortcuts: noop }));
      assert(/Grid \(5 mm\)/u.test(metricPalette) && />25 mm</u.test(metricPalette), "the millimetre palette is as before");
      const sketch = createWorkbenchProject("project:units3").sketch;
      const panel = (tool: "offset" | "fillet" | "move", unit: "mm" | "in") => renderToStaticMarkup(createElement(SketchEditPanel, { unit, tool, sketch, selectionIds: [], onApply: noop, onMessage: noop, onClose: noop } as never));
      assert(/value="0\.25"/u.test(panel("offset", "in")) && !/0\.1969/u.test(panel("offset", "in")), "the Offset panel opens on 1/4 in, not 0.1969 in");
      assert(/value="5"/u.test(panel("offset", "mm")), "and on 5 in millimetres");
      assert(/value="0\.5"/u.test(panel("move", "in")), "Move opens on 1/2 in");
      const options = (unit: "mm" | "in") => renderToStaticMarkup(createElement(SketchCurveOptionsPanel, { unit, tool: "rectangle-rounded", fields: { ...DEFAULT_CURVE_OPTION_FIELDS, cornerRadius: "6.35" }, onChange: noop, blockNames: [], selectedCount: 0, onSaveBlock: noop }));
      assert(/Corner radius \(in\)/u.test(options("in")) && /value="0\.25"/u.test(options("in")), `the corner radius field is labelled and shown in inches: ${options("in")}`);
      assert(/Corner radius \(mm\)/u.test(options("mm")) && /value="6\.35"/u.test(options("mm")), "and in millimetres as before");
      const dialog = (unit: "mm" | "in") => renderToStaticMarkup(createElement(SketchPlaneDialog, { open: true, unit, initialPlane: "xy", initialOffsetMm: 12.7, faces: [], onConfirm: noop, onClose: noop }));
      assert(/Offset from the plane in inches/u.test(dialog("in")) && /value="0\.5"/u.test(dialog("in")), "the plane dialog shows the offset in inches");
      assert(/Offset from the plane in millimetres/u.test(dialog("mm")) && /value="12\.7"/u.test(dialog("mm")), "and in millimetres");
    }
  },
  {
    name: "Wave3 R2-9: a remembered To-face or To-vertex extent reads as a distance in a project with no solid, and Through all outside a cut, so the height field stays usable",
    run: () => {
      const toFace = { ...DEFAULT_REACH, extent: "to-face" as const };
      equal(validReach(toFace, "extrude", 0, false).extent, "distance", "no solid to reach: a distance");
      equal(validReach(toFace, "extrude", 1, false).extent, "to-face", "with a solid it stays To face");
      equal(validReach({ ...DEFAULT_REACH, extent: "to-vertex" }, "extrude", 0, true).extent, "distance", "To vertex with no solid: a distance");
      equal(validReach({ ...DEFAULT_REACH, extent: "to-first" }, "revolve", 0, false).extent, "distance", "a revolve's To first face with no solid: an angle");
      equal(validReach({ ...DEFAULT_REACH, extent: "through-all" }, "extrude", 2, false).extent, "distance", "Through all outside a cut: a distance");
      equal(validReach({ ...DEFAULT_REACH, extent: "through-all" }, "extrude", 2, true).extent, "through-all", "Through all in a cut stays");
      equal(validReach({ ...DEFAULT_REACH, extent: "to-first" }, "extrude", 2, false).extent, "distance", "a revolve extent left on an extrude: a distance");
      const same = { ...DEFAULT_REACH, direction: "symmetric" as const };
      assert(validReach(same, "extrude", 0, false) === same, "valid settings come back as the same object");
      assert(validReach(toFace, "extrude", 0, false).direction === toFace.direction, "the other settings are kept");
    }
  }
];
