import { MARKING_SLOTS, SKETCH_MARKING_TOOLS, buildMarkingMenu } from "../apps/studio-web/src/ui/marking-menu.js";
import { readFileSync } from "node:fs";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * Right-click while sketching: stop the running tool, repeat the last command, and start the daily tools (Line, Rectangle, Circle,
 * Trim, Dimension) without going to the ribbon.
 */

const base = { workspace: "sketch" as const, canUndo: true, canRedo: false, selectionId: null, selectionKind: "empty" as const };
const ids = (model: ReturnType<typeof buildMarkingMenu>): string => model.items.map((item) => item.id).join(" ");

export const sketchMarkingMenuTests: readonly TestCase[] = [
  {
    name: "Sketch marking menu on empty canvas: Dimension, Finish and the daily tools; Repeat appears once a command has been used",
    run: () => {
      const fresh = buildMarkingMenu(base);
      equal(fresh.items.length, MARKING_SLOTS, "eight slots are filled");
      for (const id of ["sketch.dimension", "sketch.finish", "sketch.tool.line", "sketch.tool.rectangle", "sketch.tool.circle", "sketch.edit.trim"]) assert(fresh.items.some((item) => item.id === id && item.enabled), `${id} is offered (${ids(fresh)})`);
      assert(!fresh.items.some((item) => item.id === "sketch.repeat-last"), "with nothing to repeat there is no Repeat slot");
      assert(!fresh.items.some((item) => item.id === "sketch.tool-stop"), "and nothing to stop");
      const after = buildMarkingMenu({ ...base, sketchActivity: { last: { id: "tool:circle", label: "Center-diameter circle" } } });
      equal(after.items[0]?.id, "sketch.repeat-last", "Repeat is the first slot");
      equal(after.items[0]?.label, "Repeat Center-diameter circle", "and names what it repeats");
      equal(Object.keys(SKETCH_MARKING_TOOLS).join(" "), "sketch.tool.line sketch.tool.rectangle sketch.tool.circle sketch.edit.trim", "the tool entries are Line, Rectangle, Circle and Trim");
    }
  },
  {
    name: "Sketch marking menu with a tool running: Stop is first and names the tool; on a curve the curve commands lead",
    run: () => {
      const running = buildMarkingMenu({ ...base, sketchActivity: { running: "Line", last: { id: "tool:line", label: "Line" } } });
      equal(running.items[0]?.id, "sketch.tool-stop", "the first slot stops the tool");
      equal(running.items[0]?.label, "Stop Line", "by name");
      equal(running.items[0]?.shortcut, "Esc", "and shows the key that does the same");
      assert(!running.items.some((item) => item.id === "sketch.repeat-last"), "Repeat is not offered while a tool is running");
      assert(running.items.some((item) => item.id === "sketch.tool.rectangle") && running.items.some((item) => item.id === "sketch.finish"), "the other tools and Finish stay one flick away");
      const onCurve = buildMarkingMenu({ ...base, selectionId: "entity:line-1", selectionKind: "sketch", sketchActivity: { last: { id: "edit:trim", label: "Trim" } } });
      equal(onCurve.items.length, MARKING_SLOTS, "eight slots");
      for (const id of ["sketch.repeat-last", "sketch.dimension", "sketch.toggle-construction", "selection.delete", "sketch.edit.trim", "sketch.finish"]) assert(onCurve.items.some((item) => item.id === id), `${id} is offered on a curve (${ids(onCurve)})`);
      // Outside the Sketch workspace the sketch tools are not offered.
      const inPart = buildMarkingMenu({ workspace: "part", canUndo: false, canRedo: false, selectionId: null, selectionKind: "empty", bodyCount: 1 });
      assert(!inPart.items.some((item) => item.id.startsWith("sketch.tool")), "the Part view's menu has no sketch tools");
    }
  },
  {
    name: "Sketch marking menu: every entry it can show is handled by the app",
    run: () => {
      const app = readFileSync(new URL("../../apps/studio-web/src/App.tsx", import.meta.url), "utf8");
      const handler = app.slice(app.indexOf("const runContextCommand"), app.indexOf("const runContextCommand") + 12000);
      assert(handler.includes('commandId === "sketch.tool-stop"') && handler.includes('commandId === "sketch.repeat-last" || commandId in SKETCH_MARKING_TOOLS'), "Stop, Repeat and the tool entries have a handler");
      assert(app.includes("lastSketchCommandRef.current = { id: `tool:${tool}`") && app.includes('lastSketchCommandRef.current = { id: "dimension"') && app.includes("lastSketchCommandRef.current = { id: `edit:${tool}`"), "drawing tools, edit tools and Sketch Dimension are remembered for Repeat");
      assert(app.includes("sketchActivity: sketchActivityOf(sketchTool, sketchEditTool, sketchDimensionMode, lastSketchCommandRef.current)"), "the menu is told what is running and what ran last");
    }
  },
];
