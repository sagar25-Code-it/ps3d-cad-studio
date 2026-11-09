import { formatLength, parseLengthInput } from "../packages/workbench-core/src/index.js";
import type { SketchEntity } from "../packages/workbench-core/src/index.js";
import { parseDxf, writeSketchDxf } from "../packages/workbench-sketch/src/dxf.js";
import { parseSvg, writeSketchSvg } from "../packages/workbench-sketch/src/svg.js";
import { unhalvedExpression, halvedExpression } from "../apps/studio-web/src/dimension-expression.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, fresh, line, message, pipelineApply, pipelineRun, rect } from "./pipeline-kit.js";

/**
 * Wave 3, units, import and export: the inch notation of drawings (N2-03, P16), files cut off before their end (N2-05, N-05), the
 * wording of a dimension set through an expression (N2-10) and the small message and number items (N2-11).
 */

function mm(text: string, unit: "mm" | "in"): number {
  const parsed = parseLengthInput(text, unit);
  assert(parsed.ok, `"${text}" is a length in ${unit} mode: ${parsed.ok ? "" : parsed.message}`);
  return parsed.valueMm;
}

function polygonSketch(count: number) {
  const entities: SketchEntity[] = [];
  for (let index = 0; index < count; index += 1) {
    const a = (index / count) * Math.PI * 2;
    const b = ((index + 1) / count) * Math.PI * 2;
    entities.push({ id: `entity:l${index}`, kind: "line", start: [Math.cos(a) * 50, Math.sin(a) * 50], end: [Math.cos(b) * 50, Math.sin(b) * 50], construction: false });
  }
  const base = fresh();
  return { ...base.sketch, entities, constraints: [] };
}

export const pipeline3IoTests: readonly TestCase[] = [
  {
    name: "Wave3 N2-03: 1-1/2, 20-1/2 in, 5 + 1 in and the vulgar fractions are read as drawings write them, in both unit modes",
    run: () => {
      near(mm("1-1/2", "in"), 38.1, 1e-9, "1-1/2 in an inch document is one and a half inches (it read 0.5 in)");
      near(mm("20-1/2 in", "in"), 520.7, 1e-9, "20-1/2 in");
      near(mm("20-1/2 in", "mm"), 520.7, 1e-9, "20-1/2 in with an inch unit is a mixed number in a millimetre document as well");
      near(mm("2-3/8", "in"), 60.325, 1e-9, "2-3/8");
      near(mm("1-1/2\"", "mm"), 38.1, 1e-9, "1-1/2 with the inch mark");
      near(mm("1-1/2", "mm"), 0.5, 1e-9, "without an inch unit, in a millimetre document, it stays a subtraction");
      near(mm("5 + 1 in", "in"), 152.4, 1e-9, "a bare number beside an inch length in an inch document is inches: 6 in (it read 30.4 mm)");
      near(mm("5 + 1 in", "mm"), 30.4, 1e-9, "and millimetres in a millimetre document");
      near(mm("1 + 1/2 in", "in"), 38.1, 1e-9, "1 + 1/2 in");
      near(mm("12 - 1/2", "in"), 292.1, 1e-9, "spaces around the hyphen make it a subtraction");
      near(mm("3 - 1/8", "in"), 73.025, 1e-9, "3 - 1/8");
      near(mm("1 1/2", "in"), 38.1, 1e-9, "the space form still works");
      near(mm("1½ in", "mm"), 38.1, 1e-9, "a vulgar fraction after a whole number");
      near(mm("½", "in"), 12.7, 1e-9, "a vulgar fraction alone is a bare fraction in the display unit");
      near(mm("¾\"", "mm"), 19.05, 1e-9, "three quarters of an inch");
      near(mm("5'-3 1/2\"", "mm"), 5 * 304.8 + 3.5 * 25.4, 1e-9, "architectural feet-inches 5'-3 1/2\"");
      near(mm("2 * 5 in", "in"), 254, 1e-9, "a factor stays a factor");
      near(mm("(5 + 1) in", "mm"), 152.4, 1e-9, "brackets with a unit after them");
      assert(!parseLengthInput("1-1/2 deg", "in").ok, "an angle is still not a length");
      equal(formatLength(38.1, "in", { fractions: true }), "1 1/2 in", "the fraction writer reads back what the parser reads");
    }
  },
  {
    name: "Wave3 N2-05: a DXF or SVG cut at a group or element boundary says it was cut off and how much was read",
    run: () => {
      const text = writeSketchDxf(polygonSketch(40));
      const lines = text.split("\n");
      const whole = parseDxf(text);
      assert(whole.ok && whole.value.curves.length === 40, "the complete file reads 40 curves");
      assert(whole.ok && !whole.value.warnings.some((warning) => /cut off/u.test(warning)), "and says nothing about being cut off");
      const entitiesAt = lines.findIndex((value, index) => value.trim() === "ENTITIES" && lines[index - 1]?.trim() === "2");
      for (const fraction of [0.3, 0.6, 0.9]) {
        // Cut at a record boundary: right before a "0" group code of the entities.
        const target = Math.floor(entitiesAt + (lines.length - entitiesAt) * fraction);
        let cut = target;
        while (cut < lines.length && !(lines[cut]!.trim() === "0" && cut % 2 === 0 && lines[cut + 1]?.trim() === "LINE")) cut += 1;
        const partial = lines.slice(0, cut).join("\n");
        const parsed = parseDxf(partial);
        assert(parsed.ok, `a file cut at ${fraction * 100}% still imports what it has`);
        if (!parsed.ok) continue;
        const warning = parsed.value.warnings.find((value) => /cut off/u.test(value));
        assert(warning !== undefined, `cut at ${fraction * 100}%: a warning says the file is cut off (${parsed.value.warnings.join(" | ")})`);
        assert(warning !== undefined && warning.includes(`${parsed.value.curves.length} curve`), `the warning names how many curves were read: ${warning ?? ""}`);
        assert(parsed.value.curves.length < 40, "and fewer curves than the whole file");
      }
      const noEof = parseDxf(text.replace(/\n0\nEOF\s*$/u, "\n"));
      assert(noEof.ok && noEof.value.warnings.some((warning) => /EOF/u.test(warning)), "a file without the EOF marker is flagged");

      const svg = writeSketchSvg(polygonSketch(30));
      const full = parseSvg(svg);
      assert(full.ok && full.value.curves.length === 30 && !full.value.warnings.some((warning) => /cut off/u.test(warning)), "the complete SVG reads 30 curves without a warning");
      const closing = svg.lastIndexOf("</svg>");
      const noClose = parseSvg(svg.slice(0, closing));
      assert(noClose.ok && noClose.value.warnings.some((warning) => /cut off/u.test(warning) && /30 curves/u.test(warning)), `an SVG without </svg> is flagged: ${noClose.ok ? noClose.value.warnings.join(" | ") : "failed"}`);
      const half = svg.slice(0, svg.indexOf("/>", Math.floor(svg.length * 0.6)) + 2);
      const cutSvg = parseSvg(half);
      assert(cutSvg.ok, "an SVG cut after an element still imports what it has");
      if (cutSvg.ok) {
        assert(cutSvg.value.warnings.some((warning) => /cut off/u.test(warning)), "and says it was cut off");
        assert(cutSvg.value.curves.length < 30, "with fewer curves than the whole file");
      }
    }
  },
  {
    name: "Wave3 N2-10: set-sketch-dimension with an expression reports the evaluated value, not the typed placeholder",
    run: () => {
      let project = fresh();
      project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy" });
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:el", kind: "ellipse", center: [50, 0], majorRadiusMm: 20, minorRadiusMm: 8, rotationDeg: 0, construction: false }, circ("c", 0, 0, 5)], addConstraints: [], label: "Draw" });
      project = pipelineRun(project, { kind: "set-design-parameters", parameters: [{ name: "maj", expression: "25 mm", unit: "mm", comment: "" }] });
      const minor = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:el", dimension: "minor-radius", valueMm: 6, expression: "maj/4" });
      assert(minor.ok, `the dimension is accepted: ${message(minor)}`);
      if (minor.ok) {
        const el = minor.value.project.sketch.entities.find((entity) => entity.id === "entity:el");
        assert(el !== undefined && el.kind === "ellipse", "the ellipse is there");
        if (el !== undefined && el.kind === "ellipse") near(el.minorRadiusMm, 6.25, 1e-9, "the geometry follows the expression");
        assert(/6\.25 mm/u.test(minor.value.summary), `the summary names 6.25 mm: ${minor.value.summary}`);
        assert(!/to 6 mm/u.test(minor.value.summary), `and not the typed 6 mm: ${minor.value.summary}`);
      }
      const radius = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "radius", valueMm: 1, expression: "maj/4" });
      assert(radius.ok && /6\.25 mm/u.test(radius.value.summary) && !/to 1 mm/u.test(radius.value.summary), `the circle radius summary names 6.25 mm: ${radius.ok ? radius.value.summary : message(radius)}`);
      const plain = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "radius", valueMm: 3 });
      assert(plain.ok && /to 3 mm/u.test(plain.value.summary), `a plain value is still reported as typed: ${plain.ok ? plain.value.summary : message(plain)}`);
    }
  },
  {
    name: "Wave3 N2-11: a chamfer failure does not end with the hole note, a DXF ellipse reads back without number dust, a sum of halves is not unwrapped",
    run: async () => {
      const { sketch } = committedSketch("datum:xy", [rect("plate", 0, 0, 60, 40), circ("hole", 0, 0, 5)]);
      const built = await buildSolid(sketch, "extrude", { valueMm: 10, edge: { kind: "chamfer", sizeMm: 30 } }, 0);
      assert(!built.ok, "a 30 mm chamfer on a 60 x 40 plate cannot be built");
      if (!built.ok) assert(!/holes keep their sharp edges/u.test(built.message), `the failure does not carry the unrelated hole note: ${built.message}`);
      const entities: readonly SketchEntity[] = [{ id: "entity:el", kind: "ellipse", center: [0, 0], majorRadiusMm: 12, minorRadiusMm: 5, rotationDeg: 20, construction: false }];
      const base = fresh();
      const dxf = parseDxf(writeSketchDxf({ ...base.sketch, entities, constraints: [] }));
      assert(dxf.ok, "the ellipse DXF parses");
      if (dxf.ok) {
        const curve = dxf.value.curves[0]!;
        assert(curve.kind === "ellipse", "an ellipse");
        if (curve.kind === "ellipse") {
          equal(curve.major, 12, "major radius is exactly 12");
          equal(curve.minor, 5, "minor radius is exactly 5");
          equal(curve.rotationDeg, 20, "rotation is exactly 20");
        }
      }
      equal(unhalvedExpression("(a) / 2 + (b) / 2"), "((a) / 2 + (b) / 2) * 2", "a sum of two halves is not a wrapper");
      equal(unhalvedExpression("(w) / 2"), "w", "a real wrapper is removed");
      equal(unhalvedExpression(halvedExpression("w + 2")), "w + 2", "and what halvedExpression wrapped comes back");
      equal(unhalvedExpression(halvedExpression("(a + b) * 2")), "(a + b) * 2", "also with inner brackets");
      void line;
    }
  }
];
