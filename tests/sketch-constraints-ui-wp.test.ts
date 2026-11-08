import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { ConstraintExtras, ExtraDimensionMarks, extraDimensionLayout, type ConstraintExtrasBridge } from "../apps/studio-web/src/workspaces/sketch/ConstraintExtras.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

type Vec = readonly [number, number];

const line = (id: string, start: Vec, end: Vec): SketchEntity => ({ id: `entity:${id}`, kind: "line", start, end, construction: false });
const arc: SketchEntity = { id: "entity:arc", kind: "arc", start: [10, 0], mid: [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], end: [0, 10], construction: false };
const spline: SketchEntity = { id: "entity:spline", kind: "spline", fitPoints: [[2, 3], [8, 12], [16, 14], [24, 10], [30, 2]], construction: false };

function sketchWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchSketch {
  const base = createWorkbenchProject("project:test-wp-ui").sketch;
  return { ...base, entities, constraints };
}

const bridge: ConstraintExtrasBridge = { revision: 1, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [{ constraintId: "constraint:p", message: "The construction axis this point pierces is no longer in the part." }] };

function panel(sketch: WorkbenchSketch, selected: readonly SketchEntity[]): string {
  return renderToStaticMarkup(createElement(ConstraintExtras, { sketch, selected, bridge, onSetDimension: () => undefined, onAddConstraint: () => undefined, onApplyEdit: () => undefined, onMessage: () => undefined }));
}

function marks(sketch: WorkbenchSketch, editable: boolean): string {
  return renderToStaticMarkup(createElement("svg", null, createElement(ExtraDimensionMarks, { sketch, px: 0.5, ...(editable ? { onEdit: () => undefined } : {}) })));
}

export const sketchConstraintsUiWpTests: readonly TestCase[] = [
  {
    name: "the sketch draws angle, arc-length and perimeter dimensions as curved dimension lines with their values, and brackets a reference one",
    run: () => {
      const entities = [line("a", [0, 0], [40, 0]), line("b", [0, 0], [20, 20]), arc, { id: "entity:circle", kind: "circle", center: [60, 0], radiusMm: 5, construction: false } as SketchEntity];
      const constraints: WorkbenchSketchConstraint[] = [
        { id: "constraint:angle", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 45 },
        { id: "constraint:arc", kind: "arc-length", entityIds: ["entity:arc"], valueMm: Math.PI * 5 },
        { id: "constraint:perimeter", kind: "perimeter", entityIds: ["entity:circle"], driven: true },
        { id: "constraint:radius", kind: "radius", entityIds: ["entity:circle"], driven: true }
      ];
      const html = marks(sketchWith(entities, constraints), true);
      assert(html.includes("45°"), "the angle value is drawn");
      assert(html.includes("⌒15.708"), "the arc length is drawn");
      assert(html.includes("(P 31.416)"), "the reference perimeter is drawn in brackets with its measured value (2 pi 5)");
      assert(html.includes("(Ø10)"), "a reference radius shows its measured diameter in brackets");
      assert((html.match(/<path /gu) ?? []).length >= 2, "the angle and the arc length are drawn as arcs (SVG paths)");
      assert(/ A [\d.]+ [\d.]+ 0 0 0 /u.test(html), "a counter-clockwise sweep under the flipped y axis is an SVG arc with sweep flag 0");
      equal((html.match(/driving-dimension-hit/gu) ?? []).length, 2, "only the two driving dimensions can be clicked to edit; the two references cannot");
      assert(html.includes("reference"), "references carry the reference class");
      const hidden = marks(sketchWith([line("a", [0, 0], [40, 0]), line("b", [0, 0], [20, 20])], [{ id: "constraint:angle", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 45 }]), false);
      equal((hidden.match(/driving-dimension-hit/gu) ?? []).length, 1, "the hit area is present for a driving angle");
      assert(hidden.includes("driving-dimension extra"), "an angle group renders");
    }
  },
  {
    name: "the dimension layout reads a driven dimension's value from the geometry, so it follows the sketch",
    run: () => {
      const before = sketchWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [0, 10])], [{ id: "constraint:ref", kind: "angle", entityIds: ["entity:a", "entity:b"], driven: true }]);
      const after = sketchWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 10])], before.constraints);
      equal(extraDimensionLayout(before, before.constraints[0]!, 0.5)!.layout.label, "(90°)", "a reference angle reads 90 degrees now");
      equal(extraDimensionLayout(after, after.constraints[0]!, 0.5)!.layout.label, "(45°)", "and 45 once the line has moved");
      const driving = sketchWith([line("a", [0, 0], [10, 0]), line("b", [0, 0], [10, 10])], [{ id: "constraint:drive", kind: "angle", entityIds: ["entity:a", "entity:b"], valueDeg: 30 }]);
      equal(extraDimensionLayout(driving, driving.constraints[0]!, 0.5)!.layout.label, "30°", "a driving angle reads its held value, not the measurement");
      near(extraDimensionLayout(driving, driving.constraints[0]!, 0.5)!.layout.arc!.sweepRad, Math.PI / 6, 1e-12, "and sweeps that angle");
      assert(extraDimensionLayout(sketchWith([spline], []), { id: "constraint:s", kind: "perimeter", entityIds: ["entity:spline"], driven: true }, 0.5) === undefined, "a perimeter of a spline has no layout (it is listed in the panel instead)");
    }
  },
  {
    name: "the inspector offers Angle for two lines, Arc length for an arc, Perimeter for a circle, and lists existing dimensions with their live values",
    run: () => {
      const a = line("a", [0, 0], [10, 0]);
      const b = line("b", [0, 0], [10, 10]);
      const angle = panel(sketchWith([a, b]), [a, b]);
      assert(angle.includes("Angle between the last two lines"), "two lines offer an angle");
      assert(angle.includes(">Drive<") && angle.includes(">Reference<"), "with Drive and Reference buttons");
      assert(angle.includes('value="45"'), "prefilled with the measured 45 degrees");
      assert(angle.includes("Now measures 45 °"), "and a live read-out");
      const arcPanel = panel(sketchWith([arc]), [arc]);
      assert(arcPanel.includes(">Arc length<") || arcPanel.includes("Arc length"), "an arc offers its length");
      assert(arcPanel.includes('value="15.708"'), "prefilled with pi times 5");
      const circle: SketchEntity = { id: "entity:c", kind: "circle", center: [0, 0], radiusMm: 5, construction: false };
      const perimeter = panel(sketchWith([circle]), [circle]);
      assert(perimeter.includes("Perimeter") && perimeter.includes('value="31.416"'), "a circle offers its perimeter");
      const none = panel(sketchWith([a]), [a]);
      assert(none.includes("Length (reference)"), "a single line offers a reference length");
      const existing = panel(sketchWith([a, b], [{ id: "constraint:ref", kind: "angle", entityIds: ["entity:a", "entity:b"], driven: true }, { id: "constraint:perimeter", kind: "perimeter", entityIds: ["entity:a", "entity:b"], driven: true }]), [a, b]);
      assert(existing.includes("reference 45°"), "an existing reference angle is listed with its live value");
      assert(existing.includes("Make driving"), "and can be made driving");
      const nothing = panel(sketchWith([a, b]), []);
      assert(nothing.includes("Select two lines for an angle"), "an empty selection explains what to select");
    }
  },
  {
    name: "the inspector offers Smooth (G2) for a spline with a line, arc or spline, spline helpers for a spline, and Pierce with its lost crossings",
    run: () => {
      const l = line("l", [-20, 0], [0, 0]);
      const smooth = panel(sketchWith([l, spline]), [l, spline]);
      assert(/Smooth the nearest ends \(\d/u.test(smooth), `the Smooth button names the gap: ${smooth.slice(smooth.indexOf("Smooth the"), smooth.indexOf("Smooth the") + 60)}`);
      const at = smooth.indexOf("Smooth the nearest ends");
      assert(!smooth.slice(smooth.lastIndexOf("<button", at), at).includes("disabled"), "and is enabled");
      const disabled = panel(sketchWith([l, line("m", [5, 5], [9, 9])]), [l, line("m", [5, 5], [9, 9])]);
      assert(/<button[^>]*disabled=""[^>]*>Smooth the nearest ends<\/button>/u.test(disabled), "two lines cannot be smoothed: the button is disabled");
      const incident = line("i", [-10, 10], [0, 0]);
      const refracted = line("r", [0, 0], [3, -14]);
      const interfaceLine = line("f", [-20, 0], [20, 0]);
      const bend = panel(sketchWith([incident, refracted, interfaceLine]), [incident, refracted, interfaceLine]);
      const bendAt = bend.indexOf("Add refraction");
      assert(bendAt > 0 && !bend.slice(bend.lastIndexOf("<button", bendAt), bendAt).includes("disabled"), "three lines enable Add refraction");
      const noBend = panel(sketchWith([incident, refracted]), [incident, refracted]);
      assert(noBend.slice(noBend.lastIndexOf("<button", noBend.indexOf("Add refraction")), noBend.indexOf("Add refraction")).includes("disabled"), "two lines leave Add refraction disabled");
      const listed = panel(sketchWith([incident, refracted, interfaceLine], [{ id: "constraint:snell", kind: "refraction", entityIds: ["entity:i", "entity:r", "entity:f"], ratio: 1.5 }]), [incident, refracted, interfaceLine]);
      assert(listed.includes("1 on this selection") && listed.includes("1.5"), "an existing refraction is listed with its ratio");
      const helpers = panel(sketchWith([spline]), [spline]);
      assert(helpers.includes("5 fit points"), "a spline shows its fit points");
      assert(helpers.includes("Point 1") && helpers.includes("Point 5"), "every fit point has a tangent handle");
      assert(helpers.includes("Minimum radius"), "the minimum-radius check is there");
      assert(/tightest \d/u.test(helpers) || helpers.includes("Every curve keeps a radius"), "with a read-out against the 5 mm default limit");
      assert(helpers.includes("Curvature at the start") && helpers.includes("Curvature at the end"), "and the end curvature controls");
      assert(helpers.includes("Find crossings"), "Pierce is offered");
      assert(helpers.includes("no longer in the part"), "a Pierce constraint that lost its axis is reported");
      assert(helpers.includes("0 placed"), "and the count of placed Pierce points shows");
    }
  }
];
