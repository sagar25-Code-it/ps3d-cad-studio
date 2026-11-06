import type { SketchEntity, Vec2 } from "../packages/workbench-core/src/index.js";
import { DIMENSION_OFFSET_PX, arrowHead, dimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const px = 0.5; // half a millimetre per pixel
const length = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const sketchDimensionLayoutTests: readonly TestCase[] = [
  {
    name: "a length dimension stands off the line by a fixed number of screen pixels with extension lines and outward arrows",
    run: () => {
      const entity: SketchEntity = { id: "e:l", kind: "line", start: [0, 0], end: [40, 0], construction: false };
      const layout = dimensionLayout(entity, "length", 40, px)!;
      assert(layout !== undefined, "a line has a length dimension");
      equal(layout.label, "40", "the label is the value");
      near(layout.dimensionLine.from[1], DIMENSION_OFFSET_PX * px, 1e-9, "the dimension line stands off by 30 px (above a level line)");
      near(length(layout.dimensionLine.from, layout.dimensionLine.to), 40, 1e-9, "and is as long as the line");
      equal(layout.extensionLines.length, 2, "two extension lines");
      assert(layout.extensionLines[0]!.from[1] > 0 && layout.extensionLines[0]!.to[1] > layout.dimensionLine.from[1], "each extension line runs from near the curve past the dimension line");
      equal(layout.arrows.length, 2, "two arrows");
      near(layout.arrows[0]!.direction[0], -1, 1e-9, "the first arrow points away from the middle");
      near(layout.arrows[1]!.direction[0], 1, 1e-9, "the second arrow points away from the middle");
      assert(layout.textAt[1] > layout.dimensionLine.from[1], "the text sits above the dimension line");
    }
  },
  {
    name: "the dimension line stays the same screen distance from the curve at every zoom",
    run: () => {
      const entity: SketchEntity = { id: "e:l", kind: "line", start: [0, 0], end: [40, 0], construction: false };
      for (const pixel of [0.05, 0.5, 5]) {
        const layout = dimensionLayout(entity, "length", 40, pixel)!;
        near(layout.dimensionLine.from[1] / pixel, DIMENSION_OFFSET_PX, 1e-9, `30 px at ${pixel} mm/px`);
      }
    }
  },
  {
    name: "text goes above a slanted line and to the right of a vertical one, however the line was drawn",
    run: () => {
      const forwards = dimensionLayout({ id: "e:a", kind: "line", start: [0, 0], end: [30, 10], construction: false }, "length", 31.6, px)!;
      const backwards = dimensionLayout({ id: "e:b", kind: "line", start: [30, 10], end: [0, 0], construction: false }, "length", 31.6, px)!;
      assert(forwards.dimensionLine.from[1] > 0 || forwards.dimensionLine.to[1] > 10, "a slanted line's dimension stands off upward");
      near(forwards.textAt[0], backwards.textAt[0], 1e-9, "start and end order do not move the text (x)");
      near(forwards.textAt[1], backwards.textAt[1], 1e-9, "start and end order do not move the text (y)");
      const vertical = dimensionLayout({ id: "e:v", kind: "line", start: [0, 0], end: [0, 20], construction: false }, "length", 20, px)!;
      assert(vertical.dimensionLine.from[0] > 0, "a vertical line's dimension stands off to the right");
    }
  },
  {
    name: "rectangle width goes below and height to the right in the rectangle's own frame, also when it is rotated",
    run: () => {
      const rect: SketchEntity = { id: "e:r", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 20, rotationDeg: 0, construction: false };
      const width = dimensionLayout(rect, "width", 40, px)!;
      assert(width.dimensionLine.from[1] < -10, "the width dimension is below the bottom edge");
      near(length(width.dimensionLine.from, width.dimensionLine.to), 40, 1e-9, "as long as the width");
      const height = dimensionLayout(rect, "height", 20, px)!;
      assert(height.dimensionLine.from[0] > 20, "the height dimension is right of the right edge");
      near(length(height.dimensionLine.from, height.dimensionLine.to), 20, 1e-9, "as long as the height");
      const turned = dimensionLayout({ ...rect, rotationDeg: 90 }, "width", 40, px)!;
      near(Math.abs(turned.dimensionLine.from[0] - turned.dimensionLine.to[0]), 0, 1e-9, "a rectangle turned 90 degrees has a vertical width dimension");
      assert(dimensionLayout(rect, "length", 1, px) === undefined, "a rectangle has no length dimension");
    }
  },
  {
    name: "a circle's radius is shown as a diameter whose line passes through the centre and touches the curve",
    run: () => {
      const circle: SketchEntity = { id: "e:c", kind: "circle", center: [10, 20], radiusMm: 6, construction: false };
      const layout = dimensionLayout(circle, "radius", 6, px)!;
      equal(layout.label, "Ø12", "the stored radius 6 is displayed as Ø12");
      near(length(layout.dimensionLine.from, layout.dimensionLine.to), 12, 1e-9, "the line is a full diameter");
      near((layout.dimensionLine.from[0] + layout.dimensionLine.to[0]) / 2, 10, 1e-9, "centred on the circle (x)");
      near((layout.dimensionLine.from[1] + layout.dimensionLine.to[1]) / 2, 20, 1e-9, "centred on the circle (y)");
      equal(layout.extensionLines.length, 0, "a diameter has no extension lines");
      const head = arrowHead(layout.arrows[1]!, px);
      near(length(head[0], head[1]), Math.hypot(10 * px, 3.6 * px), 1e-9, "arrowheads have a fixed screen size");
    }
  }
];
