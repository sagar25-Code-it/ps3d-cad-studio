import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nearestSlot, placeMenu } from "../apps/studio-web/src/ui/menu-placement.js";
import { TimelineBar, TimelineMenu } from "../apps/studio-web/src/ui/TimelineBar.js";
import { designOf, type DesignHistory } from "../packages/workbench-core/src/index.js";
import { plateHoleFillet } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-18: the timeline step menu (Edit profile sketch, Roll marker here, Find in browser) and the draggable rollback marker. */

const noop = (): void => undefined;
const menuHtml = (history: DesignHistory, featureId: string, withReveal = true): string => renderToStaticMarkup(createElement(TimelineMenu, {
  menuRef: { current: null }, feature: history.features.find((feature) => feature.id === featureId)!, history, placement: { left: 10, top: 10, maxHeight: 300 },
  onClose: noop, onEdit: noop, onSuppress: noop, onRename: noop, onRollback: noop, onDelete: noop, ...(withReveal ? { onReveal: noop } : {})
}));
const items = (html: string): readonly string[] => [...html.matchAll(/<button[^>]*role="menuitem"[^>]*>([^<]*)<\/button>/gu)].map((match) => match[1]!);

export const timelineMenuTests: readonly TestCase[] = [
  {
    name: "A solid step's menu offers Edit profile sketch, Roll marker here and Find in browser; a sketch's menu has no profile sketch entry",
    run: () => {
      const history = designOf(plateHoleFillet());
      const solid = items(menuHtml(history, "feature:cut-1"));
      equal(solid.join(" | "), "Edit feature | Edit profile sketch | Suppress | Rename | Roll marker here | Find in browser | Delete", "the full menu of a cut step");
      const sketch = items(menuHtml(history, "feature:s1"));
      assert(!sketch.includes("Edit profile sketch") && sketch.includes("Edit sketch"), `a sketch edits itself: ${sketch.join(" | ")}`);
      assert(!items(menuHtml(history, "feature:cut-1", false)).includes("Find in browser"), "no Find in browser entry unless the host can reveal the row");
    }
  },
  {
    name: "Roll marker here is off when the marker already sits right after the step, and on for an earlier step",
    run: () => {
      const history = designOf(plateHoleFillet());
      const last = menuHtml(history, "feature:join-1");
      assert(/<button[^>]*disabled=""[^>]*>Roll marker here/u.test(last), "the last step already has the marker after it");
      const earlier = menuHtml(history, "feature:extrude-1");
      assert(!/<button[^>]*disabled=""[^>]*>Roll marker here/u.test(earlier), "an earlier step can take the marker");
      const suppressed: DesignHistory = { ...history, features: history.features.map((feature) => feature.id === "feature:cut-1" ? { ...feature, suppressed: true } : feature) };
      assert(items(menuHtml(suppressed, "feature:cut-1")).includes("Unsuppress"), "a suppressed step offers Unsuppress");
    }
  },
  {
    name: "The strip renders one drop slot per gap and the current marker as a draggable control with keyboard arrows described",
    run: () => {
      const history = designOf(plateHoleFillet());
      const html = renderToStaticMarkup(createElement(TimelineBar, { history: { ...history, rollbackIndex: 2 }, selectedFeatureId: null, busy: false, onSelect: noop, onEdit: noop, onRollback: noop, onSuppress: noop, onDelete: noop, onRename: noop }));
      const slots = [...html.matchAll(/data-marker-index="(\d+)"/gu)].map((match) => Number(match[1]));
      equal(slots.join(","), "0,1,2,3,4", "five slots for four steps");
      const current = /<span[^>]*timeline-marker current[^>]*>/u.exec(html)?.[0] ?? "";
      assert(current.includes('data-marker-index="2"') && current.includes("Drag it"), `the current marker is at slot 2 and says it can be dragged: ${current}`);
    }
  },
  {
    name: "placeMenu keeps a menu whole inside the window: below, above, flipped at the edges, and bounded in height with a scroll when neither side fits",
    run: () => {
      const view = { width: 800, height: 600 };
      const size = { width: 190, height: 220 };
      const below = placeMenu({ x: 100, y: 100 }, size, view);
      equal(`${below.left},${below.top}`, "100,100", "it opens at the click when it fits below");
      const above = placeMenu({ x: 100, y: 560 }, size, view);
      equal(above.top, 560 - 220, "near the bottom edge it opens upwards (the timeline strip sits there)");
      const rightEdge = placeMenu({ x: 790, y: 100 }, size, view);
      equal(rightEdge.left, 800 - 190 - 8, "it is pulled back inside the right edge");
      const tinyWindow = placeMenu({ x: 100, y: 120 }, { width: 190, height: 400 }, { width: 800, height: 300 });
      assert(tinyWindow.maxHeight <= 300 - 16 && tinyWindow.top >= 8, `a window shorter than the menu bounds its height: ${JSON.stringify(tinyWindow)}`);
      assert(tinyWindow.top + tinyWindow.maxHeight <= 300, "and the bounded menu ends inside the window");
      const narrow = placeMenu({ x: 5, y: 50 }, { width: 400, height: 50 }, { width: 200, height: 600 });
      assert(narrow.left >= 8, "a menu wider than the window still starts inside it");
    }
  },
  {
    name: "nearestSlot picks the marker slot nearest the pointer",
    run: () => {
      const centers = [20, 120, 220, 320];
      equal(nearestSlot(centers, 5), 0, "left of everything is the first slot");
      equal(nearestSlot(centers, 160), 1, "closer to the second");
      equal(nearestSlot(centers, 171), 2, "past the midpoint is the next slot");
      equal(nearestSlot(centers, 999), 3, "right of everything is the last slot");
      equal(nearestSlot([], 10), -1, "no slots, no answer");
    }
  },
];
