import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyWorkbenchOperation, createWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { DEFAULT_PATTERN_FIELDS, defaultPatternFields, type PatternFields } from "../packages/workbench-sketch/src/pattern-path.js";
import { patternPanelKey, planPatternPanel } from "../packages/workbench-sketch/src/pattern-panel-model.js";
import { convertLengthField, parseLengthField, parseNumberField } from "../packages/workbench-sketch/src/edit-fields.js";
import { SketchPatternPanel } from "../apps/studio-web/src/workspaces/sketch/SketchPatternPanel.js";
import { SketchEditPanel } from "../apps/studio-web/src/workspaces/SketchEditPanel.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Wave 2 (ui2): the re-audit findings on the sketch workspace UI, tested through the real planners, panels and component. */

const hole: SketchEntity = { id: "entity:hole", kind: "circle", center: [5, 5], radiusMm: 2, construction: false };
const bar: SketchEntity = { id: "entity:bar", kind: "line", start: [0, 0], end: [10, 0], construction: false };
const path: SketchEntity = { id: "entity:path", kind: "line", start: [0, 20], end: [100, 20], construction: false };

function sketchOf(entities: readonly SketchEntity[], constraints: WorkbenchSketch["constraints"] = []): WorkbenchSketch {
  const base = createWorkbenchProject("project:ui2-workspace").sketch;
  return { ...base, entities, constraints };
}
const ids = (): ((prefix: "entity" | "constraint") => string) => {
  let serial = 0;
  return (prefix) => `${prefix}:ui2-${(serial += 1)}`;
};
const fields = (patch: Partial<PatternFields>): PatternFields => ({ ...DEFAULT_PATTERN_FIELDS, ...patch });
const noop = (): undefined => undefined;

function commitPlan(sketch: WorkbenchSketch, plan: Parameters<typeof applyWorkbenchOperation>[1] extends infer O ? O : never): WorkbenchProject {
  const project = { ...createWorkbenchProject("project:ui2-commit"), sketch };
  const applied = applyWorkbenchOperation(project, plan);
  if (!applied.ok) throw new Error(`apply failed: ${applied.diagnostics[0]?.message}`);
  return applied.value.project;
}

export const sketchUi2WorkspaceTests: readonly TestCase[] = [
  {
    name: "Re-audit UX N4: one Pattern panel for rectangular, circular and path layouts, with a ghost that is exactly what Apply creates, Enter to apply and Esc to close",
    run: () => {
      const sketch = sketchOf([hole, bar, path]);
      // Rectangular: the ghost is the six copies of a 3 x 2 grid, and applying the same plan creates them.
      const rectangular = planPatternPanel({ sketch, selectionIds: ["entity:hole"], fields: fields({ kind: "rectangular", countX: "3", countY: "2", dx: "12", dy: "9" }), associative: true, unit: "mm" }, ids());
      assert(rectangular !== undefined && rectangular.ok, "rectangular plans");
      if (rectangular === undefined || !rectangular.ok) return;
      equal(rectangular.ghost.length, 5, "the ghost shows the five copies (the source is the first instance)");
      const applied = commitPlan(sketch, { kind: "apply-sketch-edit", operationId: "operation:ui2-rect", expectedRevision: 0, ...rectangular.plan });
      const made = applied.sketch.entities.filter((entity) => entity.id.includes("pattern") || entity.id.includes(":i"));
      assert(applied.sketch.entities.length === sketch.entities.length + rectangular.ghost.length, `Apply adds the same number of curves as the ghost (${applied.sketch.entities.length - sketch.entities.length} of ${rectangular.ghost.length}; ${made.length} named copies)`);
      for (const ghost of rectangular.ghost) {
        if (ghost.kind !== "circle") continue;
        assert(applied.sketch.entities.some((entity) => entity.kind === "circle" && Math.hypot(entity.center[0] - ghost.center[0], entity.center[1] - ghost.center[1]) < 1e-9), "every ghost circle lands where an applied copy is");
      }
      // Circular: six copies about the origin.
      const circular = planPatternPanel({ sketch, selectionIds: ["entity:hole"], fields: fields({ kind: "circular", count: "6", totalAngle: "360", centerX: "0", centerY: "0" }), associative: true, unit: "mm" }, ids());
      assert(circular !== undefined && circular.ok && circular.ghost.length === 5, "circular previews five copies");
      // Path: the last selected curve is the path.
      const along = planPatternPanel({ sketch, selectionIds: ["entity:hole", "entity:path"], fields: fields({ kind: "path", count: "4", fit: true }), associative: true, unit: "mm" }, ids());
      assert(along !== undefined && along.ok && along.ghost.length === 3, `a path pattern previews its three copies (${along === undefined ? "none" : along.ok ? along.ghost.length : along.message})`);
      // Static copies are the old edit tool's, through the same panel.
      const statics = planPatternPanel({ sketch, selectionIds: ["entity:bar"], fields: fields({ kind: "rectangular", countX: "2", countY: "1", dx: "20" }), associative: false, unit: "mm" }, ids());
      assert(statics !== undefined && statics.ok && statics.ghost.length === 1 && statics.plan.addEntities.length === 1, "static copies are real entities in the plan");
      const staticPath = planPatternPanel({ sketch, selectionIds: ["entity:hole", "entity:path"], fields: fields({ kind: "path" }), associative: false, unit: "mm" }, ids());
      assert(staticPath !== undefined && !staticPath.ok && /associative/u.test(staticPath.message), "a path pattern says it needs to be associative");
      assert(planPatternPanel({ sketch, selectionIds: [], fields: fields({}), associative: true, unit: "mm" }, ids()) === undefined, "nothing selected: nothing to preview");
      const broken = planPatternPanel({ sketch, selectionIds: ["entity:hole"], fields: fields({ countX: "abc" }), associative: true, unit: "mm" }, ids());
      assert(broken !== undefined && !broken.ok && /number/u.test(broken.message), "an unreadable count is named");
      // Keys.
      equal(patternPanelKey("Enter"), "apply", "Enter applies");
      equal(patternPanelKey("Escape"), "close", "Esc closes");
      equal(patternPanelKey("a"), undefined, "other keys do nothing");
      // The panel renders, once, with no second Pattern panel next to it.
      const markup = renderToStaticMarkup(createElement(SketchPatternPanel, { sketch, selectionIds: ["entity:hole"], onApply: noop, onMessage: noop, onClose: noop, onPreview: noop }));
      assert(markup.includes("Pattern options") && markup.includes("Along a path") && markup.includes("Circular") && markup.includes("Rectangular"), "all three layouts are offered");
      assert(markup.includes("copies"), "the summary line says how many copies");
      const editPanel = renderToStaticMarkup(createElement(SketchEditPanel, { tool: "pattern", sketch, selectionIds: ["entity:hole"], onApply: noop, onMessage: noop, onClose: noop }));
      assert(!editPanel.includes("Count X") && !editPanel.includes("Apply pattern"), "the edit-tools panel no longer carries a second, different Pattern form");
    }
  },
  {
    name: "Re-audit UX E18/E19: edit and pattern fields are typed in the document unit (bare numbers, '10mm', '1,000.5', '12,5'), labelled with it, and convert when it changes",
    run: () => {
      near(parseLengthField("2", "in"), 50.8, 1e-9, "2 in an inch document is 50.8 mm");
      near(parseLengthField("10mm", "in"), 10, 1e-9, "10mm is accepted and wins over the unit");
      near(parseLengthField("1,000.5", "mm"), 1000.5, 1e-9, "1,000.5 is a thousand and a half");
      near(parseLengthField("12,5", "mm"), 12.5, 1e-9, "12,5 is a decimal comma");
      near(parseLengthField("1/2", "in"), 12.7, 1e-9, "a fraction reads in the document unit");
      assert(Number.isNaN(parseLengthField("", "mm")) && Number.isNaN(parseLengthField("abc", "mm")), "empty and unreadable lengths are NaN, never 0");
      near(parseNumberField("45°"), 45, 1e-12, "an angle with a degree sign");
      near(parseNumberField("1,000.5"), 1000.5, 1e-9, "a plain number takes the thousands comma too");
      equal(convertLengthField("25.4", "mm", "in"), "1", "25.4 mm becomes 1 in");
      equal(convertLengthField("2", "in", "mm"), "50.8", "2 in becomes 50.8 mm");
      equal(convertLengthField("abc", "mm", "in"), "abc", "text that is not a length is left alone");
      // The pattern fields: spacing typed in inches.
      const sketch = sketchOf([hole, bar]);
      const inches = planPatternPanel({ sketch, selectionIds: ["entity:hole"], fields: fields({ countX: "3", countY: "1", dx: "1", dy: "0" }), associative: true, unit: "in" }, ids());
      assert(inches !== undefined && inches.ok, "a 1 inch spacing plans");
      if (inches !== undefined && inches.ok) {
        const spec = inches.plan.objects?.patterns?.[0]?.spec;
        assert(spec?.kind === "rectangular" && Math.abs(spec.dxMm - 25.4) < 1e-9, "the stored spacing is 25.4 mm");
      }
      const mixed = planPatternPanel({ sketch, selectionIds: ["entity:hole"], fields: fields({ countX: "3", countY: "1", dx: "10mm", dy: "0" }), associative: true, unit: "in" }, ids());
      assert(mixed !== undefined && mixed.ok, "'10mm' is accepted in the spacing field");
      const thousands = planPatternPanel({ sketch, selectionIds: ["entity:hole"], fields: fields({ countX: "2", countY: "1", dx: "1,000.5", dy: "0" }), associative: true, unit: "mm" }, ids());
      assert(thousands !== undefined && thousands.ok, "'1,000.5' is accepted in the spacing field");
      equal(defaultPatternFields("in").dx, "0.3937", "the default 10 mm spacing is 0.3937 in");
      // The rendered panels say the unit.
      const pattern = renderToStaticMarkup(createElement(SketchPatternPanel, { sketch, selectionIds: ["entity:hole"], onApply: noop, onMessage: noop, onClose: noop, unit: "in" }));
      assert(pattern.includes("Spacing, first direction (in)") && !pattern.includes("(mm)") && !pattern.includes(">mm<"), "the pattern spacing is labelled in inches");
      const offset = renderToStaticMarkup(createElement(SketchEditPanel, { tool: "offset", sketch, selectionIds: ["entity:bar"], onApply: noop, onMessage: noop, onClose: noop, unit: "in" }));
      assert(offset.includes("Distance (in)") && !offset.includes(">mm<"), "the offset distance is labelled in inches");
      const millimetres = renderToStaticMarkup(createElement(SketchEditPanel, { tool: "offset", sketch, selectionIds: ["entity:bar"], onApply: noop, onMessage: noop, onClose: noop }));
      assert(millimetres.includes("Distance (mm)") && millimetres.includes("value=\"5\""), "and in millimetres by default, starting at 5");
      // Wave 3 (R2-10): an inch document starts on the round inch size nearest to 5 mm, a quarter inch, instead of 0.1969 in.
      assert(offset.includes("value=\"0.25\""), `an inch document starts the offset at a quarter inch (${/value="[^"]*"/u.exec(offset)?.[0]})`);
      assert(offset.includes("Apply 1") || offset.includes("Apply 0") || offset.includes("adds"), "and its preview line is computed from the inch value");
    }
  },
  {
    name: "Re-audit UX (c): the Sketch workspace renders on the server for every tool, edit tool, unit and mode with no React warning (no duplicate keys, no hook errors), and its hooks are all unconditional",
    run: () => {
      const project = createWorkbenchProject("project:ui2-ssr");
      const base = {
        projectId: project.id, sketch: project.sketch, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
        targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
        viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
      };
      const variants: Record<string, unknown>[] = [{}, { displayUnit: "in", tool: "line" }, { editTool: "pattern" }, { editTool: "fillet", displayUnit: "in" }, { editTool: "offset" }, { editTool: "mirror" }, { editTool: "stretch" }, { editTool: "jog" }, { dimensionMode: true }, { checkOpen: true }, { tool: "spline" }, { tool: "polygon" }, { tool: "text" }, { showMovable: true }];
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]): void => { errors.push(args.map(String).join(" ").slice(0, 200)); };
      try {
        for (const variant of variants) {
          const props = new Proxy({ ...base, ...variant } as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
          const html = renderToStaticMarkup(createElement(SketchWorkspace, props as never));
          assert(html.includes("sketch-palette") && html.includes("Sketch inspector"), `${JSON.stringify(variant)} renders the palette and the inspector`);
        }
      } finally {
        console.error = original;
      }
      equal(JSON.stringify(errors), "[]", "React logged nothing while rendering the variants");
      // Hooks must run in the same order on every render: none after a conditional return, none inside a callback or a branch.
      const source = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8").split("\n");
      const start = source.findIndex((line) => line.startsWith("export function SketchWorkspace("));
      const end = source.findIndex((line, index) => index > start && line === "}");
      assert(start > 0 && end > start, "found the component");
      const body = source.slice(start + 1, end);
      const firstReturn = body.findIndex((line) => /^ {2}return[ (<]/u.test(line));
      const earlyReturns = body.filter((line) => /^ {2}return[ ;(<]/u.test(line));
      equal(earlyReturns.length, 1, "the component has exactly one top-level return, the JSX at the end");
      const hookLines = body.map((line, index) => ({ line, index })).filter(({ line }) => /\buse[A-Z][A-Za-z]*(<[^>]*>)?\(/u.test(line) && !/^\s*(\/\/|\*)/u.test(line));
      const misplaced = hookLines.filter(({ line, index }) => index > firstReturn || !/^ {2}(const|let|void)? ?[\[\]{}A-Za-z0-9_, :<>.]*=? ?use[A-Z]|^ {2}use[A-Z]/u.test(line));
      equal(JSON.stringify(misplaced.map(({ line }) => line.trim().slice(0, 80))), "[]", "every hook call is at the top level of the component, before its return");
    }
  }
];
