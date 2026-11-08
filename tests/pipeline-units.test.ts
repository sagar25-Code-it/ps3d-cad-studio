import { formatLength, parseLengthInput } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { fresh, message, pipelineApply, pipelineRun, rect } from "./pipeline-kit.js";

function mm(text: string, unit: "mm" | "in" = "mm"): number {
  const parsed = parseLengthInput(text, unit);
  assert(parsed.ok, `"${text}" is a length: ${parsed.ok ? "" : parsed.message}`);
  return parsed.valueMm;
}

export const pipelineUnitTests: readonly TestCase[] = [
  {
    name: "P16 fractions, feet, inch marks, mils and decimal commas are lengths, in typed fields and in dimension expressions",
    run: () => {
      near(mm("1/2 in"), 12.7, 1e-9, "1/2 in is half an inch (it was 1 over 2 inches)");
      near(mm("(1/2) in"), 12.7, 1e-9, "(1/2) in");
      near(mm("1/16 in"), 1.5875, 1e-9, "1/16 in");
      near(mm("1 1/2 in"), 38.1, 1e-9, "a mixed number");
      near(mm("3/4\""), 19.05, 1e-9, "the inch mark");
      near(mm("1.5\""), 38.1, 1e-9, "decimal inches with the mark");
      near(mm("3 ft"), 914.4, 1e-9, "feet");
      near(mm("5' 3 1/2\""), 5 * 304.8 + 3.5 * 25.4, 1e-9, "feet and inches together");
      near(mm("5'3\""), 5 * 304.8 + 3 * 25.4, 1e-9, "feet and inches without a space");
      near(mm("25,4 mm"), 25.4, 1e-9, "a decimal comma");
      near(mm("10 mil"), 0.254, 1e-9, "mils");
      near(mm("2 cm + 5 mm"), 25, 1e-9, "sums of lengths");
      near(mm("12"), 12, 1e-9, "a bare number takes millimetres when that is the display unit");
      near(mm("12", "in"), 304.8, 1e-9, "and inches when that is");
      near(mm("1/2", "in"), 12.7, 1e-9, "a bare fraction takes the display unit");
      near(mm("12 mm", "in"), 12, 1e-9, "a number with a unit keeps it whatever the display unit");
      near(mm("2 * 1/2 in"), 25.4, 1e-9, "an expression with fractions still works");
      const area = parseLengthInput("1 in * 1 in");
      assert(!area.ok && /length/u.test(area.message), `an area is not a length: ${area.ok ? "" : area.message}`);
      const nonsense = parseLengthInput("abc");
      assert(!nonsense.ok, "an unknown name is refused");
      assert(!parseLengthInput("").ok, "an empty field is refused with a hint");
      const angle = parseLengthInput("30 deg");
      assert(!angle.ok, "an angle is not a length");
      equal(formatLength(25.4, "in"), "1 in", "inches are written without trailing zeros");
      equal(formatLength(38.1, "in", { fractions: true }), "1 1/2 in", "and as fractions on request");
      equal(formatLength(12.7, "mm"), "12.7 mm", "millimetres");
      equal(formatLength(6.35, "in", { fractions: true }), "1/4 in", "a fraction below one inch");
    }
  },
  {
    name: "P16 a sketch dimension bound to an inch fraction sets the geometry in millimetres",
    run: () => {
      let project = pipelineRun(fresh(), { kind: "add-sketch-entity", entity: rect("r", 0, 0, 40, 20) });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 10, expression: "1/2 in" });
      const half = project.sketch.entities.find((entity) => entity.id === "entity:r");
      assert(half !== undefined && half.kind === "rectangle", "the rectangle is still there");
      near(half.widthMm, 12.7, 1e-9, "'1/2 in' makes the width 12.7 mm");
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "height", valueMm: 10, expression: "(3/4) in" });
      const tall = project.sketch.entities.find((entity) => entity.id === "entity:r");
      near(tall !== undefined && tall.kind === "rectangle" ? tall.heightMm : 0, 19.05, 1e-9, "'(3/4) in' makes the height 19.05 mm");
      const feet = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 10, expression: "1 ft" });
      assert(feet.ok, `1 ft is accepted: ${message(feet)}`);
      const area = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:r", dimension: "width", valueMm: 10, expression: "1 in * 1 in" });
      assert(!area.ok && /length/u.test(message(area)), `an area is still refused: ${message(area)}`);
      // A fraction in front of a name keeps its meaning: w / 2 mm is w over two millimetres.
      const unit = parseLengthInput("ft");
      assert(!unit.ok && /unit/u.test(unit.message), `a unit on its own is explained: ${unit.ok ? "" : unit.message}`);
    }
  }
];
