import type { SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { resolveSketchHotkey, type SketchHotkeyContext, type SketchHotkeyInput } from "../packages/workbench-sketch/src/hotkeys.js";
import { entitiesInSelectionBox, selectionBoxMode, selectionRect } from "../packages/workbench-sketch/src/selection.js";
import { snapSketchPoint } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

const idle: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false };
const press = (key: string, extra: Partial<SketchHotkeyInput> = {}): SketchHotkeyInput => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...extra });

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-interaction").sketch, entities, constraints: [] };
}

const line = (id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: readonly [number, number], radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });

export const sketchInteractionTests: readonly TestCase[] = [
  {
    name: "sketch letter keys start the Fusion-style tools and ignore Shift, Alt and Ctrl combinations",
    run: () => {
      equal(JSON.stringify(resolveSketchHotkey(press("l"), idle)), JSON.stringify({ kind: "tool", tool: "line" }), "L starts the line tool");
      equal(JSON.stringify(resolveSketchHotkey(press("R"), idle)), JSON.stringify({ kind: "tool", tool: "rectangle" }), "an upper-case R still starts the rectangle");
      equal(JSON.stringify(resolveSketchHotkey(press("c"), idle)), JSON.stringify({ kind: "tool", tool: "circle" }), "C starts the circle");
      equal(JSON.stringify(resolveSketchHotkey(press("a"), idle)), JSON.stringify({ kind: "tool", tool: "arc" }), "A starts the arc");
      equal(resolveSketchHotkey(press("d"), idle)?.kind, "dimension", "D starts Sketch Dimension");
      equal(JSON.stringify(resolveSketchHotkey(press("t"), idle)), JSON.stringify({ kind: "edit-tool", tool: "trim" }), "T opens Trim");
      equal(JSON.stringify(resolveSketchHotkey(press("o"), idle)), JSON.stringify({ kind: "edit-tool", tool: "offset" }), "O opens Offset");
      equal(resolveSketchHotkey(press("f"), idle)?.kind, "fit", "F fits the view");
      equal(resolveSketchHotkey(press("x"), idle)?.kind, "toggle-construction", "X toggles construction");
      equal(resolveSketchHotkey(press("l", { shift: true }), idle), undefined, "Shift+L is not a tool shortcut");
      equal(resolveSketchHotkey(press("l", { alt: true }), idle), undefined, "Alt+L is left to the browser");
      equal(resolveSketchHotkey(press("z", { ctrl: true }), idle), undefined, "Ctrl+Z falls through to undo");
      equal(resolveSketchHotkey(press("s", { ctrl: true }), idle), undefined, "Ctrl+S falls through to save");
      equal(resolveSketchHotkey(press("a", { ctrl: true }), idle)?.kind, "select-all", "Ctrl+A selects every curve");
      equal(resolveSketchHotkey(press("q"), idle), undefined, "unbound keys fall through");
    }
  },
  {
    name: "Escape backs out one level at a time and Backspace and Delete never destroy work while points are being placed",
    run: () => {
      const drawing: SketchHotkeyContext = { ...idle, tool: "line", pendingPoints: 1, selectionCount: 2, curveSelectionCount: 2, dimensionMode: false, editToolActive: false };
      equal(resolveSketchHotkey(press("Escape"), drawing)?.kind, "cancel-points", "first Escape drops the pending point");
      equal(resolveSketchHotkey(press("Escape"), { ...drawing, pendingPoints: 0 })?.kind, "select-tool", "second Escape leaves the tool");
      equal(resolveSketchHotkey(press("Escape"), { ...idle, selectionCount: 2 })?.kind, "clear-selection", "third Escape clears the selection");
      equal(resolveSketchHotkey(press("Escape"), { ...idle, selectionCount: 1, curveSelectionCount: 0 })?.kind, "clear-selection", "Escape also clears a selected profile");
      equal(resolveSketchHotkey(press("Delete"), { ...idle, selectionCount: 1, curveSelectionCount: 0 }), undefined, "Delete never removes a profile, only curves");
      equal(resolveSketchHotkey(press("Escape"), idle), undefined, "Escape with nothing to cancel falls through");
      equal(resolveSketchHotkey(press("Escape"), { ...idle, dimensionMode: true })?.kind, "exit-dimension", "Escape ends Sketch Dimension");
      equal(resolveSketchHotkey(press("Escape"), { ...idle, editToolActive: true })?.kind, "exit-edit-tool", "Escape closes an edit tool");
      equal(resolveSketchHotkey(press("Backspace"), drawing)?.kind, "undo-point", "Backspace removes the last placed point first");
      equal(resolveSketchHotkey(press("Delete"), drawing)?.kind, "cancel-points", "Delete while placing points cancels them instead of deleting curves");
      equal(resolveSketchHotkey(press("Delete"), { ...idle, selectionCount: 3, curveSelectionCount: 3 })?.kind, "delete-selection", "Delete removes the selected curves");
      equal(resolveSketchHotkey(press("Delete"), idle), undefined, "Delete with no selection does nothing");
      equal(resolveSketchHotkey(press("Enter"), { ...idle, tool: "spline", pendingPoints: 3 })?.kind, "finish", "Enter finishes a spline with three points");
      equal(resolveSketchHotkey(press("Enter"), { ...idle, tool: "spline", pendingPoints: 2 }), undefined, "Enter waits for enough spline points");
      equal(resolveSketchHotkey(press("Enter"), idle), undefined, "Enter is otherwise left alone");
    }
  },
  {
    name: "dragging a selection box left to right picks only fully enclosed curves and right to left also picks curves it touches",
    run: () => {
      const entities: readonly SketchEntity[] = [
        line("e:inside", [2, 2], [8, 2]),
        line("e:crossing", [5, 5], [30, 5]),
        circle("e:ring", [20, 20], 4),
        line("e:far", [100, 100], [120, 100]),
        { ...line("e:hidden", [3, 3], [7, 3]), visible: false }
      ];
      const rect = selectionRect([0, 0], [12, 10]);
      equal(selectionBoxMode([0, 0], [12, 10]), "window", "left to right is a window");
      equal(selectionBoxMode([12, 10], [0, 0]), "crossing", "right to left is crossing");
      equal(entitiesInSelectionBox(entities, rect, "window").join(","), "e:inside", "window takes only what it fully encloses and skips hidden curves");
      equal(entitiesInSelectionBox(entities, rect, "crossing").join(","), "e:inside,e:crossing", "crossing also takes the curve that runs out of the box");
      // A circle is only touched where its outline passes: a box wholly inside the ring misses it, a box over the outline hits it.
      const inner = selectionRect([18, 18], [22, 22]);
      equal(entitiesInSelectionBox(entities, inner, "crossing").length, 0, "a box inside a circle does not touch its outline");
      const overOutline = selectionRect([23, 18], [26, 22]);
      equal(entitiesInSelectionBox(entities, overOutline, "crossing").join(","), "e:ring", "a box over the outline touches the circle");
      equal(entitiesInSelectionBox(entities, selectionRect([14, 14], [26, 26]), "window").join(","), "e:ring", "a box around the circle encloses it");
    }
  },
  {
    name: "snapping reach and grid come from the caller so the canvas can keep them constant in screen pixels",
    run: () => {
      const sketch = sketchOf([circle("e:c", [100, 100], 10)]);
      // Default behaviour is unchanged: 0.75 mm reach to the 5 mm grid.
      const near = snapSketchPoint([5.4, 10.3], sketch);
      equal(near.snapped, true, "default tolerance snaps to the 5 mm grid");
      const farDefault = snapSketchPoint([5.9, 10.9], sketch);
      equal(farDefault.snapped, false, "default tolerance does not snap 0.9 mm away from the grid");
      // Zoomed in: a small reach keeps the cursor free.
      const zoomedIn = snapSketchPoint([5.2, 10.1], sketch, { toleranceMm: 0.05, gridMm: 5 });
      equal(zoomedIn.snapped, false, "a tight tolerance leaves the point where it is");
      // Zoomed out: the visible grid step and a larger reach snap to the coarser grid.
      const zoomedOut = snapSketchPoint([48, 103], sketch, { toleranceMm: 4, gridMm: 50 });
      assert(zoomedOut.snapped && zoomedOut.point[0] === 50 && zoomedOut.point[1] === 100, "snaps to the 50 mm grid node when zoomed out");
      // Geometry snaps win over the grid and use the same reach.
      const toCentre = snapSketchPoint([101, 99], sketch, { toleranceMm: 3, gridMm: 50 });
      equal(toCentre.kind, "endpoint", "a nearby circle centre beats the grid");
      equal(toCentre.point[0], 100, "the snapped point is the centre");
    }
  }
];
