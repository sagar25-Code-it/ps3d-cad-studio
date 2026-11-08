import type { Vec2 } from "../packages/workbench-core/src/index.js";
import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { dynamicFieldsFor, measureFromCursor, parseDynamicNumber, pointFromDynamicInput } from "../packages/workbench-sketch/src/dynamic-input.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const sketchDynamicInputTests: readonly TestCase[] = [
  {
    name: "each drawing tool offers the typed fields that fit its next point, and none before its first point",
    run: () => {
      equal(dynamicFieldsFor("line", 0).map((field) => field.id).join(","), "x,y", "before the first click the fields are the absolute X and Y of the first point");
      equal(dynamicFieldsFor("line", 1).map((field) => field.id).join(","), "length,angle", "a line takes length and angle");
      equal(dynamicFieldsFor("rectangle", 1).map((field) => field.id).join(","), "width,height", "a rectangle takes width and height");
      equal(dynamicFieldsFor("rectangle-center", 1).map((field) => field.id).join(","), "width,height", "so does a centre rectangle");
      equal(dynamicFieldsFor("circle", 1).map((field) => field.id).join(","), "radius", "a circle takes a radius");
      equal(dynamicFieldsFor("circle-two-point", 1).map((field) => field.id).join(","), "diameter", "a two-point circle takes a diameter");
      equal(dynamicFieldsFor("rectangle-three-point", 1).map((field) => field.id).join(","), "length,angle", "a 3-point rectangle starts with an edge");
      equal(dynamicFieldsFor("rectangle-three-point", 2).map((field) => field.id).join(","), "height", "then asks for the height");
      equal(dynamicFieldsFor("spline", 2).map((field) => field.id).join(","), "length,angle", "a spline point is typed relative to the previous one");
      equal(dynamicFieldsFor("select", 1).length, 0, "the select tool has none");
    }
  },
  {
    name: "the live values follow the cursor and the typed values win field by field",
    run: () => {
      const first: Vec2 = [10, 10];
      const live = measureFromCursor("line", [first], [13, 14]);
      near(live.length ?? 0, 5, 1e-12, "the cursor implies a 3-4-5 length");
      near(live.angle ?? 0, (Math.atan2(4, 3) * 180) / Math.PI, 1e-9, "and its angle");
      // Typing only the length keeps the cursor's direction.
      const lengthOnly = pointFromDynamicInput("line", [first], [13, 14], { length: 10 })!;
      near(lengthOnly[0], 10 + 6, 1e-9, "length 10 along the cursor direction (x)");
      near(lengthOnly[1], 10 + 8, 1e-9, "length 10 along the cursor direction (y)");
      // Typing only the angle keeps the cursor's distance.
      const angleOnly = pointFromDynamicInput("line", [first], [13, 14], { angle: 0 })!;
      near(angleOnly[0], 15, 1e-9, "angle 0 keeps the 5 mm distance and points along +X");
      near(angleOnly[1], 10, 1e-9, "and stays level");
      // Both typed: exact placement regardless of the cursor.
      const both = pointFromDynamicInput("line", [first], [-50, 70], { length: 20, angle: 90 })!;
      near(both[0], 10, 1e-9, "length 20 at 90 degrees (x)");
      near(both[1], 30, 1e-9, "length 20 at 90 degrees (y)");
      equal(pointFromDynamicInput("line", [first], [10, 10], { length: 0 }), undefined, "a zero length is refused");
    }
  },
  {
    name: "rectangles and circles honour typed sizes and keep the side the cursor is on",
    run: () => {
      const corner: Vec2 = [0, 0];
      const rect = pointFromDynamicInput("rectangle", [corner], [-3, 2], { width: 40, height: 25 })!;
      near(rect[0], -40, 1e-9, "the corner goes to the left because the cursor is on the left");
      near(rect[1], 25, 1e-9, "and up because the cursor is above");
      const built = buildSketchEntity("rectangle", [corner, rect], "e:r");
      assert(built.ok && built.value.kind === "rectangle" && Math.abs(built.value.widthMm - 40) < 1e-9 && Math.abs(built.value.heightMm - 25) < 1e-9, "the built rectangle is exactly 40 x 25");
      const centred = pointFromDynamicInput("rectangle-center", [[5, 5]], [9, 7], { width: 30, height: 10 })!;
      near(centred[0], 5 + 15, 1e-9, "a centre rectangle puts the corner half the width away");
      near(centred[1], 5 + 5, 1e-9, "and half the height away");
      const circle = pointFromDynamicInput("circle", [[0, 0]], [0, 8], { radius: 12.5 })!;
      near(circle[0], 0, 1e-9, "a circle radius is applied along the cursor direction (x)");
      near(circle[1], 12.5, 1e-9, "a circle radius is applied along the cursor direction (y)");
      const builtCircle = buildSketchEntity("circle", [[0, 0], circle], "e:c");
      assert(builtCircle.ok && builtCircle.value.kind === "circle" && Math.abs(builtCircle.value.radiusMm - 12.5) < 1e-9, "the built circle has the typed radius");
      const diameter = pointFromDynamicInput("circle-two-point", [[0, 0]], [30, 0], { diameter: 50 })!;
      const builtTwo = buildSketchEntity("circle-two-point", [[0, 0], diameter], "e:d");
      assert(builtTwo.ok && builtTwo.value.kind === "circle" && Math.abs(builtTwo.value.radiusMm - 25) < 1e-9, "a typed diameter of 50 gives a radius of 25");
    }
  },
  {
    name: "a 3-point rectangle takes a typed edge and then a typed height on the cursor's side",
    run: () => {
      const start: Vec2 = [0, 0];
      const second = pointFromDynamicInput("rectangle-three-point", [start], [30, 1], { length: 20, angle: 0 })!;
      near(second[0], 20, 1e-9, "first edge length 20 along +X");
      near(second[1], 0, 1e-9, "first edge is level");
      const third = pointFromDynamicInput("rectangle-three-point", [start, second], [10, -4], { height: 7 })!;
      near(third[0], 20, 1e-9, "the third point is straight out from the second (x)");
      near(third[1], -7, 1e-9, "on the side the cursor is on (below)");
      const built = buildSketchEntity("rectangle-three-point", [start, second, third], "e:t");
      assert(built.ok && built.value.kind === "rectangle" && Math.abs(built.value.widthMm - 20) < 1e-9 && Math.abs(built.value.heightMm - 7) < 1e-9, "the 3-point rectangle is 20 x 7");
    }
  },
  {
    name: "typed numbers accept a decimal comma and reject half-typed input",
    run: () => {
      equal(parseDynamicNumber("12.5"), 12.5, "a plain decimal");
      equal(parseDynamicNumber(" 7,25 "), 7.25, "a decimal comma and spaces");
      equal(parseDynamicNumber("-3"), -3, "a negative number parses (the tools honour the sign)");
      equal(parseDynamicNumber(""), undefined, "empty text is not a number");
      equal(parseDynamicNumber("-"), undefined, "a lone minus is not a number yet");
      equal(parseDynamicNumber("abc"), undefined, "words are not numbers");
    }
  }
];
