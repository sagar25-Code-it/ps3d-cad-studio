import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { SketchExportPanel, SketchImportPanel, SketchUnderlayPanel } from "../apps/studio-web/src/workspaces/sketch/SketchExchangePanel.js";
import { SketchPatternPanel } from "../apps/studio-web/src/workspaces/sketch/SketchPatternPanel.js";
import { UnderlayLayer } from "../apps/studio-web/src/workspaces/sketch/UnderlayLayer.js";
import { DEFAULT_CURVE_OPTION_FIELDS, SketchCurveOptionsPanel, curveOptionsFromFields } from "../apps/studio-web/src/workspaces/SketchCurveOptions.js";
import { SKETCH_EDIT_TOOL_LABELS } from "../apps/studio-web/src/workspaces/SketchEditPanel.js";
import { planPattern } from "../packages/workbench-sketch/src/pattern-path.js";
import { buildCurveTool } from "../packages/workbench-sketch/src/curve-tools.js";
import { createUnderlay, imageIdOf } from "../packages/workbench-sketch/src/underlay.js";
import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

function sketchWith(entities: readonly SketchEntity[]): WorkbenchSketch {
  const base = createWorkbenchProject("project:test-exchange-ui").sketch;
  return { ...base, name: "Bracket sketch", entities, constraints: [] };
}

const noop = (): undefined => undefined;
const common = { onApply: noop, onMessage: noop, onClose: noop };

export const sketchExchangeUiTests: readonly TestCase[] = [
  {
    name: "sketch Insert panels render: import asks for a file and says DWG is unsupported, export shows what it will write, picture explains calibration",
    run: () => {
      const sketch = sketchWith([{ id: "entity:a", kind: "line", start: [0, 0], end: [10, 0], construction: false }, { id: "entity:b", kind: "line", start: [0, 0], end: [0, 10], construction: true, visible: false }]);
      const imported = renderToStaticMarkup(createElement(SketchImportPanel, { sketch, ...common }));
      assert(imported.includes("Import DXF / SVG") && imported.includes("type=\"file\"") && imported.includes("DWG is not supported"), "import: file picker and the DWG note");
      const exported = renderToStaticMarkup(createElement(SketchExportPanel, { sketch, ...common }));
      assert(exported.includes("1 visible curves") && exported.includes("Download DXF") && exported.includes("Include construction curves"), "export: counts only visible curves and offers the download");
      const empty = renderToStaticMarkup(createElement(SketchExportPanel, { sketch: sketchWith([]), ...common }));
      assert(empty.includes("disabled"), "export is disabled for an empty sketch");
      const none = renderToStaticMarkup(createElement(SketchUnderlayPanel, { sketch, pick: { active: false, points: [] }, onPickStart: noop, onPickCancel: noop, ...common }));
      assert(none.includes("Picture to trace") && none.includes("never uploaded") && !none.includes("Calibrate scale"), "picture: no calibration controls before a picture is loaded");
      const underlay = createUnderlay({ format: "png", widthPx: 800, heightPx: 600 }, imageIdOf(new Uint8Array(30)), "front.png");
      const loaded = renderToStaticMarkup(createElement(SketchUnderlayPanel, { sketch: { ...sketch, underlay }, pick: { active: true, points: [[1, 1]] }, onPickStart: noop, onPickCancel: noop, ...common }));
      assert(loaded.includes("Calibrate scale") && loaded.includes("Picking: 1 of 2") && loaded.includes("Picture opacity") && loaded.includes("Remove picture") && loaded.includes("800 x 600 pixels"), "picture: opacity, picking, calibration and remove once loaded");
      equal(renderToStaticMarkup(createElement("svg", null, createElement(UnderlayLayer, { underlay }))), "<svg></svg>", "the layer draws nothing until the pixels are loaded from the store");
    }
  },
  {
    name: "sketch Pattern panel: new patterns offer the associative layouts; selecting a copy opens the pattern for editing with its instances",
    run: () => {
      const sketch = sketchWith([{ id: "entity:hole", kind: "circle", center: [5, 5], radiusMm: 2, construction: false }]);
      const fresh = renderToStaticMarkup(createElement(SketchPatternPanel, { sketch, selectionIds: ["entity:hole"], ...common }));
      assert(fresh.includes("Associative pattern") && fresh.includes("Rectangular (any angle)") && fresh.includes("Along a path") && fresh.includes("Direction angle"), "new pattern: associative layouts including the path");
      const planned = planPattern({ sketch, newId: (prefix) => `${prefix}:user-ui` }, ["entity:hole"], { kind: "rectangular", countX: 3, countY: 1, dxMm: 10, dyMm: 0, angleDeg: 0, extent: false });
      assert(planned.ok, "the pattern plans");
      if (!planned.ok) return;
      const applied = applyWorkbenchOperation({ ...createWorkbenchProject("project:test-exchange-ui"), sketch }, { kind: "apply-sketch-edit", operationId: "operation:ui-pattern", expectedRevision: 0, ...planned.value });
      assert(applied.ok, "and applies");
      if (!applied.ok) return;
      const editing = renderToStaticMarkup(createElement(SketchPatternPanel, { sketch: applied.value.project.sketch, selectionIds: ["entity:hole"], ...common }));
      assert(editing.includes("Editing a pattern of 1 curve") && editing.includes("Update pattern") && editing.includes("Copy 1") && editing.includes("Copy 2") && editing.includes("Remove the copies"), "editing: update, per-copy suppression and the way out");
    }
  },
  {
    name: "sketch Text palette: width, spacing, alignment and the editing buttons are there, and the text layout reaches the builder",
    run: () => {
      const plain = renderToStaticMarkup(createElement(SketchCurveOptionsPanel, { tool: "text", fields: DEFAULT_CURVE_OPTION_FIELDS, onChange: noop, blockNames: [], selectedCount: 0, onSaveBlock: noop }));
      assert(plain.includes("Text width") && plain.includes("Letter spacing") && plain.includes("Align on the click") && !plain.includes("Apply to the text"), "layout fields and no editing buttons while placing");
      const editing = renderToStaticMarkup(createElement(SketchCurveOptionsPanel, { tool: "text", fields: DEFAULT_CURVE_OPTION_FIELDS, onChange: noop, blockNames: [], selectedCount: 0, onSaveBlock: noop, textEdit: { onApply: noop, onCancel: noop } }));
      assert(editing.includes("Apply to the text") && editing.includes("Cancel editing"), "while editing: apply and cancel");
      const options = curveOptionsFromFields({ ...DEFAULT_CURVE_OPTION_FIELDS, text: "Ab", textWidth: "2", textSpacing: "3", textAlign: "right" }, { entities: [], centerlineReachMm: 1000, pickReachMm: 3, block: undefined });
      const built = buildCurveTool("text", [[0, 0]], options, { entity: () => `entity:ui-${Math.random().toString(36).slice(2)}`, constraint: () => "constraint:ui" });
      assert(built.ok, "the text builds with the palette layout");
      if (built.ok) {
        const xs = built.value.entities.flatMap((entity) => entity.kind === "line" ? [entity.start[0], entity.end[0]] : entity.kind === "arc" ? [entity.start[0], entity.end[0]] : []);
        assert(Math.max(...xs) <= 1e-9 && Math.min(...xs) < -5, "right alignment puts the text to the left of the click");
      }
      assert(SKETCH_EDIT_TOOL_LABELS["import-drawing"] === "Import DXF / SVG" && SKETCH_EDIT_TOOL_LABELS["export-drawing"] === "Export DXF / SVG" && SKETCH_EDIT_TOOL_LABELS.underlay === "Picture to trace", "the Insert tools have labels for the ribbon and the status line");
    }
  }
];
