import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOCK_GAP, dockBounds, dockClosesOnKey, dockStyle } from "../apps/studio-web/src/ui/docked-panel.js";
import { FeatureEditDialog } from "../apps/studio-web/src/ui/FeatureEditDialog.js";
import { createWorkbenchProject, type DesignSolidFeature } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Review: the docked Edit Feature panel is not a modal dialog, and it sits between the canvas edge and the timeline strip at every window size. */

const feature: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 20, bodyId: "general-body:block" };

export const dockedPanelTests: readonly TestCase[] = [
  {
    name: "The docked panel carries no dialog role, so the app's keyboard guards (Part hotkeys, Ctrl+Z, Ctrl+S, Ctrl+B, Delete) do not treat it as a modal",
    run: () => {
      const html = renderToStaticMarkup(createElement(FeatureEditDialog, { feature, project: createWorkbenchProject("project:test-dock-role"), busy: false, onApply: () => undefined, onClose: () => undefined }));
      assert(!html.includes('role="dialog"') && !html.includes("aria-modal"), "no dialog role and no modal marker: every App.tsx guard looks for [role=\"dialog\"]");
      assert(html.includes('role="region"') && html.includes('aria-labelledby="feature-edit-title"'), "it stays a named region for a screen reader");
      assert(html.includes("--dock-top") && html.includes("--dock-bottom"), "its frame takes the measured bounds");
    }
  },
  {
    name: "Esc closes the docked panel from anywhere, but not when another surface owns the key or the key was already handled",
    run: () => {
      assert(dockClosesOnKey({ key: "Escape", defaultPrevented: false, otherSurfaceOpen: false }), "Esc from the canvas cancels the command");
      assert(!dockClosesOnKey({ key: "Escape", defaultPrevented: true, otherSurfaceOpen: false }), "an Esc something else already used is left alone");
      assert(!dockClosesOnKey({ key: "Escape", defaultPrevented: false, otherSurfaceOpen: true }), "a dialog or menu on top takes its own Esc");
      for (const key of ["Tab", "F", "z", "Delete", "Enter"]) assert(!dockClosesOnKey({ key, defaultPrevented: false, otherSurfaceOpen: false }), `${key} never closes it, and Tab is never trapped`);
    }
  },
  {
    name: "The dock starts at the canvas row's edge and ends above the timeline strip at a wide window, a short one and a narrow one whose header wraps",
    run: () => {
      // Wide: header, menu, tabs and a ribbon put the canvas row at y 178; the strip starts at 720 of 800.
      const wide = dockBounds({ canvas: { top: 178, right: 1280, bottom: 766 }, timelineTop: 720, viewport: { width: 1280, height: 800 } });
      equal(`${wide.top},${wide.right},${wide.bottom},${wide.maxHeight}`, `${178 + DOCK_GAP},${DOCK_GAP},${800 - 720 + DOCK_GAP},${800 - 186 - 88}`, "wide window");
      // The chrome grows when the header wraps: the dock follows it down instead of covering the ribbon.
      const narrow = dockBounds({ canvas: { top: 330, right: 600, bottom: 760 }, timelineTop: 700, viewport: { width: 600, height: 800 } });
      assert(narrow.top === 338 && narrow.top > wide.top, "a taller header pushes the dock down");
      assert(narrow.bottom === 108, "the strip's real top sets the bottom, not a fixed 96 px");
      // Short window: the panel is bounded and scrolls inside, never negative.
      const short = dockBounds({ canvas: { top: 300, right: 700, bottom: 420 }, timelineTop: 400, viewport: { width: 700, height: 440 } });
      assert(short.maxHeight >= 0 && short.top + short.bottom + short.maxHeight === 440, "a very short window leaves a bounded, non-negative height");
      // No strip (Render Studio, other workspaces) or nothing measured yet.
      const noStrip = dockBounds({ canvas: { top: 150, right: 1000, bottom: 700 }, timelineTop: undefined, viewport: { width: 1000, height: 740 } });
      equal(noStrip.bottom, 740 - 700 + DOCK_GAP, "without a strip the canvas row's bottom is the limit");
      const unmeasured = dockBounds({ canvas: undefined, timelineTop: undefined, viewport: { width: 1000, height: 700 } });
      assert(unmeasured.top === DOCK_GAP && unmeasured.right === DOCK_GAP && unmeasured.bottom === DOCK_GAP, "with nothing measured it keeps a margin inside the window");
      const style = dockStyle(wide) as Record<string, string>;
      equal(style["--dock-top"], "186px", "the style carries the measured top");
    }
  },
];
