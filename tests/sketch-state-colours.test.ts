import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createWorkbenchProject, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { SKETCH_STATE_COLOURS, fixedEntityIds } from "../packages/workbench-sketch/src/state-colours.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { line } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** A curve held by a Fix has its own colour on the canvas, and the Sketch palette has a key to every curve colour. */

const repoFile = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
const noop = (): void => undefined;

function workspaceMarkup(sketch: WorkbenchSketch): string {
  const base = {
    projectId: "project:colours", sketch, finishedSketches: [], workingTimelineId: null, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
    targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
    viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
  };
  const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
  return renderToStaticMarkup(createElement(SketchWorkspace, props as never));
}

const sketchWith = (constraints: readonly WorkbenchSketchConstraint[]): WorkbenchSketch => ({
  ...createWorkbenchProject("project:colours").sketch,
  entities: [line("held", [0, 0], [30, 0]), line("pinned", [0, 10], [30, 10]), line("free", [0, 20], [30, 20]), line("relaxed", [0, 30], [30, 30])],
  constraints
});

export const sketchStateColourTests: readonly TestCase[] = [
  {
    name: "Colour language: only a curve held by an active Fix on the whole curve counts as fixed",
    run: () => {
      const sketch = sketchWith([
        { id: "constraint:fix-held", kind: "fixed", entityIds: ["entity:held"] },
        { id: "constraint:fix-point", kind: "fixed", entityIds: ["entity:pinned"], points: ["start"] },
        { id: "constraint:fix-relaxed", kind: "fixed", entityIds: ["entity:relaxed"], suppressed: true },
        { id: "constraint:level", kind: "horizontal", entityIds: ["entity:free"] }
      ]);
      equal([...fixedEntityIds(sketch)].join(","), "entity:held", "the whole-curve Fix; not the pinned point, the relaxed Fix or another relation");
      equal(SKETCH_STATE_COLOURS.map((state) => state.key).join(" "), "free constrained fixed linked construction selected reference", "the key covers every curve colour");
      const css = repoFile("apps/studio-web/src/styles/sketch-canvas-ux.css");
      assert(css.includes(".sketch-entity.fixed") && css.includes(".sketch-entity.fixed.selected"), "the canvas has a colour for a fixed curve, and selection still wins over it");
      for (const state of SKETCH_STATE_COLOURS) assert(state.key === "free" || css.includes(`.colour-key-swatch.${state.key}`), `the key has a swatch for ${state.key}`);
    }
  },
  {
    name: "The Sketch workspace draws a fixed curve with the fixed class and shows the colour key in the palette",
    run: () => {
      const html = workspaceMarkup(sketchWith([{ id: "constraint:fix-held", kind: "fixed", entityIds: ["entity:held"] }]));
      const classesOf = (id: string): string => {
        const at = html.indexOf(`data-selection-id="${id}"`);
        assert(at >= 0, `${id} is drawn`);
        const slice = html.slice(at, at + 900);
        return /class="(sketch-entity [^"]*)"/u.exec(slice)?.[1] ?? "";
      };
      assert(/\bfixed\b/u.test(classesOf("entity:held")), `the held line is drawn as fixed (${classesOf("entity:held")})`);
      assert(!/\bfixed\b/u.test(classesOf("entity:free")), "a free line is not");
      assert(html.includes("What the colours mean"), "the palette has the colour key");
      for (const state of SKETCH_STATE_COLOURS) assert(html.includes(`>${state.label}<`), `the key lists "${state.label}"`);
    }
  },
];
