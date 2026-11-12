import { insetsForOverlays, type OverlayBox } from "../apps/studio-web/src/workspaces/sketch/canvas-insets.js";
import { fitCameraToViewport, sketchToScreen } from "../packages/workbench-sketch/src/camera.js";
import { assert, near, type TestCase } from "./test-kit.js";

/** The floating panels measured on the live site at 1920 x 1080 (canvas 1178 x 756), where Fit pushed the sketch to the left edge. */
const WIDE_CANVAS = { width: 1178, height: 756 };
const WIDE_OVERLAYS: readonly OverlayBox[] = [
  { left: 12, top: 12, right: 1166, bottom: 53 },    // selection and view bar along the top
  { left: 440, top: 639, right: 942, bottom: 678 },  // navigation bar, bottom centre, 502 px wide (under half the canvas)
  { left: 1178, top: 58, right: 1382, bottom: 756 }, // palette docked beside the canvas, wholly outside it
  { left: 13, top: 706, right: 1166, bottom: 743 }   // status strip along the bottom
];

export const sketchFitInsetsTests: readonly TestCase[] = [
  {
    name: "Sketch Fit on a wide window: the bottom navigation bar is a bottom inset, not a right-hand panel, so the sketch is not pushed to the left",
    run: () => {
      const insets = insetsForOverlays(WIDE_CANVAS, WIDE_OVERLAYS);
      near(insets.right, 0, 1e-9, "nothing is reserved on the right (the old rule reserved 738 px there)");
      near(insets.left, 0, 1e-9, "nothing is reserved on the left");
      near(insets.top, 53, 1e-9, "the top bar reserves its own height");
      near(insets.bottom, 117, 1e-9, "the navigation bar and status strip reserve the bottom, down from the bar's top edge");
      // The fitted sketch sits in the middle of the free area, not at the left edge.
      const extents = { min: [-30, -20] as const, max: [30, 20] as const };
      const camera = fitCameraToViewport(extents, WIDE_CANVAS, insets);
      const centre = sketchToScreen([0, 0], { left: 0, top: 0, width: WIDE_CANVAS.width, height: WIDE_CANVAS.height }, camera);
      near(centre[0], WIDE_CANVAS.width / 2, 2, "the sketch is centred across the canvas width");
      near(centre[1], (insets.top + (WIDE_CANVAS.height - insets.bottom)) / 2, 2, "and centred between the top bar and the bottom bars");
      const leftEdge = sketchToScreen([-30, 0], { left: 0, top: 0, width: WIDE_CANVAS.width, height: WIDE_CANVAS.height }, camera)[0];
      const rightEdge = sketchToScreen([30, 0], { left: 0, top: 0, width: WIDE_CANVAS.width, height: WIDE_CANVAS.height }, camera)[0];
      near(leftEdge, WIDE_CANVAS.width - rightEdge, 2, "the gap at the left equals the gap at the right (it was 36 px against 774 px)");
    }
  },
  {
    name: "Sketch Fit gives the same insets on a narrow and a wide window for the same panels",
    run: () => {
      // The narrow in-app pane: the same 502 px navigation bar is over half of a 698 px canvas.
      const narrow = insetsForOverlays({ width: 698, height: 576 }, [
        { left: 12, top: 12, right: 686, bottom: 53 },
        { left: 98, top: 459, right: 600, bottom: 498 },
        { left: 13, top: 526, right: 686, bottom: 563 }
      ]);
      near(narrow.right, 0, 1e-9, "narrow: nothing reserved on the right");
      near(narrow.left, 0, 1e-9, "narrow: nothing reserved on the left");
      near(narrow.bottom, 576 - 459, 1e-9, "narrow: the bottom bars reserve the bottom");
      for (const width of [900, 1178, 1600, 2400, 3440]) {
        const barLeft = (width - 502) / 2;
        const insets = insetsForOverlays({ width, height: 756 }, [{ left: barLeft, top: 639, right: barLeft + 502, bottom: 678 }]);
        assert(insets.left === 0 && insets.right === 0 && insets.bottom === 117, `a centred bottom bar is a bottom inset at ${width} px wide: ${JSON.stringify(insets)}`);
      }
    }
  },
  {
    name: "Sketch Fit insets: side panels, panels outside the canvas, bad boxes and a crowded canvas",
    run: () => {
      const size = { width: 1200, height: 800 };
      const floatingRight = insetsForOverlays(size, [{ left: 980, top: 60, right: 1184, bottom: 700 }]);
      near(floatingRight.right, 220, 1e-9, "a tall palette floating at the right reserves the strip from its left edge");
      assert(floatingRight.left === 0 && floatingRight.top === 0 && floatingRight.bottom === 0, "and nothing else");
      const leftPanel = insetsForOverlays(size, [{ left: 0, top: 100, right: 200, bottom: 700 }]);
      near(leftPanel.left, 200, 1e-9, "a tall panel at the left reserves the left");
      const outside = insetsForOverlays(size, [{ left: 1200, top: 0, right: 1500, bottom: 800 }, { left: -300, top: 0, right: 0, bottom: 800 }, { left: 0, top: 800, right: 1200, bottom: 900 }]);
      assert(outside.left === 0 && outside.right === 0 && outside.top === 0 && outside.bottom === 0, "panels beside or below the canvas cost nothing");
      const broken = insetsForOverlays(size, [{ left: Number.NaN, top: 0, right: 100, bottom: 100 }, { left: 10, top: 10, right: 10, bottom: 300 }]);
      assert(broken.left === 0 && broken.right === 0 && broken.top === 0 && broken.bottom === 0, "a box with no area or a bad number is ignored");
      const empty = insetsForOverlays({ width: 0, height: 0 }, [{ left: 0, top: 0, right: 10, bottom: 10 }]);
      assert(empty.left === 0 && empty.right === 0 && empty.top === 0 && empty.bottom === 0, "an unmeasured canvas has no insets");
      // Two huge side panels cannot squeeze the sketch into a sliver: at least 40 % of the width stays free.
      const crowded = insetsForOverlays(size, [{ left: 0, top: 0, right: 500, bottom: 800 }, { left: 650, top: 0, right: 1200, bottom: 800 }]);
      assert(crowded.left + crowded.right <= size.width * 0.6 + 1e-9, `the side insets together leave 40 % free: ${JSON.stringify(crowded)}`);
      assert(crowded.left > 0 && crowded.right > 0, "and both sides are still respected in proportion");
    }
  }
];
