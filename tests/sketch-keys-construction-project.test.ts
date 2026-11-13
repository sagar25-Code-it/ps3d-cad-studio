import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { DEFAULT_SKETCH_KEYMAP, keymapConflicts, keymapFromOverrides, resolveSketchHotkey, sketchHotkeyHelp, type SketchHotkeyContext, type SketchHotkeyInput } from "../packages/workbench-sketch/src/hotkeys.js";
import { WorkbenchRibbon } from "../apps/studio-web/src/ui/WorkbenchRibbon.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * Sketch keys X and P. X is the construction key: it toggles the selected curves, and with nothing selected (or while drawing) it
 * switches what is drawn next. P is Project. Pan has no key by default (middle button and Space-drag pan). E is left as it was.
 */

const key = (text: string, shift = false): SketchHotkeyInput => ({ key: text, ctrl: false, meta: false, alt: false, shift });
const idle: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
const noop = (): undefined => undefined;

export const sketchKeysConstructionProjectTests: readonly TestCase[] = [
  {
    name: "Sketch key X: toggles construction on the selected curves, and with nothing selected or while drawing switches what is drawn next",
    run: () => {
      equal(resolveSketchHotkey(key("x"), { ...idle, selectionCount: 2, curveSelectionCount: 2 })?.kind, "toggle-construction", "with curves selected: the selection");
      equal(resolveSketchHotkey(key("x"), idle)?.kind, "toggle-draw-construction", "with nothing selected: what is drawn next");
      equal(resolveSketchHotkey(key("X"), { ...idle, selectionCount: 1, curveSelectionCount: 0 })?.kind, "toggle-draw-construction", "a selected profile is not a curve: what is drawn next");
      equal(resolveSketchHotkey(key("x"), { ...idle, tool: "line", pendingPoints: 1, selectionCount: 1, curveSelectionCount: 1 })?.kind, "toggle-draw-construction", "in the middle of a line: the next segments, not an old selection");
      equal(resolveSketchHotkey(key("q"), idle)?.kind, "toggle-draw-construction", "Q still switches what is drawn next");
      equal(resolveSketchHotkey(key("q"), { ...idle, selectionCount: 2, curveSelectionCount: 2 })?.kind, "toggle-draw-construction", "Q never touches the selection");
      // A user who moved the construction key keeps the same two meanings on the new key.
      const moved = keymapFromOverrides({ "toggle-construction": "J" });
      equal(resolveSketchHotkey(key("j"), idle, moved)?.kind, "toggle-draw-construction", "the rebound key follows the same rule");
      equal(resolveSketchHotkey(key("j"), { ...idle, selectionCount: 1, curveSelectionCount: 1 }, moved)?.kind, "toggle-construction", "with a selection it toggles it");
      equal(resolveSketchHotkey(key("x"), idle, moved), undefined, "and X is free");
    }
  },
  {
    name: "Sketch key P: Project by default; Pan has no key; a saved choice of P for something else is kept",
    run: () => {
      equal(resolveSketchHotkey(key("p"), idle)?.kind, "project", "P is Project");
      equal(resolveSketchHotkey(key("p"), { ...idle, tool: "line" })?.kind, "project", "also from a drawing tool");
      equal(DEFAULT_SKETCH_KEYMAP.keys["project"], "P", "the keymap names it");
      equal(DEFAULT_SKETCH_KEYMAP.keys["pan-mode"], undefined, "Pan ships without a key");
      equal(resolveSketchHotkey(key("p", true), idle)?.kind, "tool", "Shift+P is still the Point tool");
      equal(JSON.stringify(resolveSketchHotkey(key("e"), idle)), JSON.stringify({ kind: "tool", tool: "ellipse" }), "E is unchanged");
      equal(keymapConflicts(DEFAULT_SKETCH_KEYMAP.keys).length, 0, "no key is claimed twice");
      const keptPan = keymapFromOverrides({ "pan-mode": "P" });
      equal(resolveSketchHotkey(key("p"), idle, keptPan)?.kind, "pan-mode", "someone who sets Pan back to P gets Pan");
      equal(keptPan.keys["project"], undefined, "and Project then has no key");
      const other = keymapFromOverrides({ "tool:polygon": "P" });
      equal(JSON.stringify(resolveSketchHotkey(key("p"), idle, other)), JSON.stringify({ kind: "tool", tool: "polygon" }), "a saved P for another tool is kept");
      const help = sketchHotkeyHelp();
      assert(help.some((row) => row.keys === "P" && /^Project/u.test(row.action)), "the help sheet lists P as Project");
      assert(help.some((row) => row.keys === "X" && /what is drawn next/u.test(row.action)), "and says what X does with nothing selected");
      assert(!help.some((row) => row.action === "Pan navigation"), "Pan is not listed with a key it does not have");
      assert(help.some((row) => /Pan/u.test(row.action) && /Middle drag/u.test(row.keys)), "panning by middle drag or Space drag is still listed");
    }
  },
  {
    name: "Sketch key P: the ribbon's Project button shows the key, and the canvas runs the same command",
    run: () => {
      const project = { ...createWorkbenchProject("project:keys-ribbon"), activeWorkspace: "sketch" as const };
      const base = { project, masterCartOpen: false, displayUnit: "mm", sketchTool: "select", sketchDimensionMode: false, sketchEditTool: null, sketchShowMovable: false, sketchCheckOpen: false, sketchProjectReference: false, selectedId: null, assemblyExplodeMaxMm: 0 };
      const props = new Proxy(base as Record<string, unknown>, { get: (target, name) => (name in target ? target[name as string] : typeof name === "string" && name.startsWith("on") ? noop : undefined), has: () => true });
      const html = renderToStaticMarkup(createElement(WorkbenchRibbon, props as never));
      assert(html.includes('title="Project · body edges · P"'), "the Project button names its key");
      const workspace = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(workspace.includes('case "project":') && workspace.includes("props.onProjectBody()"), "the canvas passes the key on");
      const app = readFileSync(new URL("../../apps/studio-web/src/App.tsx", import.meta.url), "utf8");
      assert(app.includes('onProjectBody={() => runSketchCommand("project-body", "with the Project key")}'), "to the same command the ribbon button runs");
    }
  },
];
