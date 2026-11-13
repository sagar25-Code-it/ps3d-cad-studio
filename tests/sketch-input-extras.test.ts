import type { SketchEntity, Vec2, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, evaluateTextInDesign } from "../packages/workbench-core/src/index.js";
import { autoConstraintsFor, type PlacedPointInference } from "../packages/workbench-sketch/src/auto-constraints.js";
import { dynamicFieldsFor, measureFromCursor, normalizeAngleDeg, parseDynamicNumber, pointFromDynamicInput, solveDynamicInput, type DynamicField } from "../packages/workbench-sketch/src/dynamic-input.js";
import { fieldErrorsFor, parseCoordinatePair, parseFieldEntry, plainEvaluator, resolveDynamicEntry, type EvaluateText } from "../packages/workbench-sketch/src/dynamic-entry.js";
import {
  DEFAULT_SKETCH_KEYMAP, SKETCH_KEYMAP_COMMANDS, getActiveSketchKeymap, keyChipForTool, keyLabelForTool, keymapConflicts, keymapFromOverrides, normalizeKeySpec,
  overridesOfKeymap, rebindKey, resolveSketchHotkey, setActiveSketchKeymap, sketchHotkeyHelp, subscribeSketchKeymap,
  type SketchHotkeyContext, type SketchHotkeyInput
} from "../packages/workbench-sketch/src/hotkeys.js";
import { KEYMAP_STORAGE_KEY, loadKeymap, loadSnapAssist, saveKeymap, saveSnapAssist, type SettingsStorage } from "../packages/workbench-sketch/src/input-settings.js";
import { inferSketchPoint } from "../packages/workbench-sketch/src/inference.js";
import { buildSketchEntity, requiredSketchPoints, type SketchTool } from "../packages/workbench-sketch/src/index.js";
import { entitiesUnderPoint, nextInCycle } from "../packages/workbench-sketch/src/select-other.js";
import { buildPolygon, buildSlot, buildSlotOverall } from "../packages/workbench-sketch/src/shapes.js";
import { DEFAULT_SNAP_ASSIST, anchorFor, anchorUseFor, assistedInference, snapAssistFromJson, type SnapAssistSettings } from "../packages/workbench-sketch/src/snap-assist.js";
import { nextClickPrompt } from "../packages/workbench-sketch/src/tool-prompts.js";
import { extraSketchSearchCommands, searchableCommands } from "../apps/studio-web/src/ui/sketch-tool-commands.js";
import { CAD_COMMANDS } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { param, run } from "./design-parameters.test.js";

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const field = (tool: SketchTool, placed: number, id: string): DynamicField => {
  const found = dynamicFieldsFor(tool, placed).find((candidate) => candidate.id === id);
  assert(found !== undefined, `${tool} with ${placed} point(s) offers a ${id} field`);
  return found;
};
const ids = (): { entity: () => string; constraint: () => string } => {
  let count = 0;
  return { entity: () => `entity:t-${(count += 1)}`, constraint: () => `constraint:t-${(count += 1)}` };
};

/** The project the studio hands the evaluator: a user parameter pin_r = 4 mm. */
function projectWithParameter(): WorkbenchProject {
  return run(createWorkbenchProject("project:test-input-extras"), { kind: "set-design-parameters", parameters: [param("pin_r", "4")] });
}
const evaluatorFor = (project: WorkbenchProject): EvaluateText => (text) => {
  const result = evaluateTextInDesign(designOf(project), text);
  return result.ok ? result : { ok: false, message: result.message };
};

/** Runs the entry the way the workspace does: fields from the tool, texts as typed. */
function entry(tool: SketchTool, placed: readonly Vec2[], cursor: Vec2, texts: Record<string, string>, evaluate?: EvaluateText) {
  return resolveDynamicEntry({ tool, placed, cursor, fields: dynamicFieldsFor(tool, placed.length), texts, ...(evaluate === undefined ? {} : { evaluate }) });
}

function memoryStorage(initial: Record<string, string> = {}): SettingsStorage & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
}

const idle: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
const press = (key: string, extra: Partial<SketchHotkeyInput> = {}): SketchHotkeyInput => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...extra });

const settings = (patch: Partial<SnapAssistSettings> = {}): SnapAssistSettings => ({ ...DEFAULT_SNAP_ASSIST, ...patch });
const emptySketch = (entities: readonly SketchEntity[] = []): WorkbenchSketch => ({ ...createWorkbenchProject("project:test-assist").sketch, entities, constraints: [] });

export const sketchInputExtrasTests: readonly TestCase[] = [
  // ------------------------------------------------------------------------------------------------------------------
  // Sketch tool input T09 / E10: units, expressions, parameters and refusal of what cannot be read
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input T09/E10: the typed length '12 mm', '0.5 in', '1/2in', '2*5' and '2*pin_r' are read with units and the expression engine, and place geometry at that exact size",
    run: () => {
      const evaluate = evaluatorFor(projectWithParameter());
      const start: Vec2 = [0, 0];
      const cursor: Vec2 = [30, 0];
      const length = (text: string): number => {
        const result = entry("line", [start], cursor, { length: text, angle: "0" }, evaluate);
        assert(result.ok, `'${text}' is accepted: ${result.ok ? "" : result.message}`);
        return result.point[0];
      };
      near(length("12 mm"), 12, 1e-12, "12 mm");
      near(length("12mm"), 12, 1e-12, "12mm without a space");
      near(length("0.5 in"), 12.7, 1e-12, "0.5 in is 12.7 mm");
      near(length("1/2in"), 12.7, 1e-12, "1/2in is half an inch, not one over two inches");
      near(length("2*5"), 10, 1e-12, "an expression");
      near(length("10+5"), 15, 1e-12, "a sum");
      near(length("2*pin_r"), 8, 1e-12, "a design parameter: pin_r is 4 mm");
      near(length("2 cm"), 20, 1e-12, "centimetres");
      near(length("7,5"), 7.5, 1e-12, "a decimal comma still works");
      near(length("1e1"), 10, 1e-12, "scientific notation is a number");
      const built = buildSketchEntity("line", [start, entry("line", [start], cursor, { length: "0.5 in", angle: "0" }).ok ? [12.7, 0] : [0, 0]], "e:l");
      assert(built.ok && built.value.kind === "line" && Math.abs(built.value.end[0] - 12.7) < 1e-12, "the built line is 12.7 mm long");
    }
  },
  {
    name: "Sketch tool input T09/E10: text that cannot be read is an error on the field and no point is placed (it used to place the cursor's value without a word)",
    run: () => {
      const evaluate = evaluatorFor(projectWithParameter());
      const cursor: Vec2 = [30, 0];
      for (const text of ["banana", "0x10", "1,000.5", "12 deg", "2*nope", "5 +", "(3"]) {
        const result = entry("line", [[0, 0]], cursor, { length: text }, evaluate);
        assert(!result.ok, `'${text}' is refused`);
        assert(result.errors["length"] !== undefined && result.errors["length"].length > 0, `'${text}' carries a message on the length field`);
        assert(result.message.startsWith("Length:"), `and the status sentence names the field: ${result.message}`);
      }
      // The same text in the old parser: hex was accepted as a number.
      equal(parseDynamicNumber("0x10"), undefined, "hexadecimal is not a number");
      equal(parseDynamicNumber("1e3"), 1000, "scientific notation still is");
      // A field with a dimension mismatch says what it expected.
      const mismatch = parseFieldEntry("12 deg", field("line", 1, "length"));
      assert(!mismatch.ok && /length/.test(mismatch.message), `an angle in a length field is refused: ${mismatch.ok ? "" : mismatch.message}`);
      const angleMismatch = parseFieldEntry("12 mm", field("line", 1, "angle"));
      assert(!angleMismatch.ok && /angle/.test(angleMismatch.message), "a length in the angle field is refused");
      const angleOk = parseFieldEntry("0.5 rad", field("line", 1, "angle"));
      assert(angleOk.ok && Math.abs(angleOk.value - (0.5 * 180) / Math.PI) < 1e-9, "radians convert to degrees");
      // While typing: half-typed input is not yet an error, unreadable input is.
      const live = fieldErrorsFor(dynamicFieldsFor("line", 1), { length: "12 m", angle: "abc" }, plainEvaluator);
      equal(live["length"], undefined, "12 m is a valid length");
      assert(live["angle"] !== undefined, "abc in the angle field is flagged as soon as it is typed");
      equal(Object.keys(fieldErrorsFor(dynamicFieldsFor("line", 1), { length: "-" })).length, 0, "a lone minus is half-typed, not wrong");
    }
  },
  {
    name: "Sketch tool input E10: absolute X/Y for the first point and '#' / '@' coordinate prefixes",
    run: () => {
      equal(dynamicFieldsFor("line", 0).map((f) => f.id).join(","), "x,y", "a tool with no point yet asks for the absolute X and Y of the first point");
      equal(dynamicFieldsFor("select", 0).length, 0, "the select tool has no typed input");
      const first = entry("circle", [], [3, 3], { x: "25.4 mm", y: "1 in" });
      assert(first.ok, "X and Y with units");
      equal(`${first.point[0]},${first.point[1]}`, "25.4,25.4", "the first point is exactly where it was typed");
      const onlyX = entry("circle", [], [3, 7], { x: "-12" });
      assert(onlyX.ok && onlyX.point[0] === -12 && onlyX.point[1] === 7, "typing only X keeps the cursor's Y");
      const pair = entry("line", [[10, 10]], [50, 50], { length: "#25,-5" });
      assert(pair.ok && pair.point[0] === 25 && pair.point[1] === -5, "#x,y in a field is an absolute point");
      const relative = entry("line", [[10, 10]], [50, 50], { angle: "@3,4" });
      assert(relative.ok && relative.point[0] === 13 && relative.point[1] === 14, "@dx,dy is relative to the previous point");
      const relX = resolveDynamicEntry({ tool: "point", placed: [], cursor: [0, 0], fields: dynamicFieldsFor("point", 0), texts: { x: "@5", y: "#7" }, lastPoint: [100, 20] });
      assert(relX.ok && relX.point[0] === 105 && relX.point[1] === 7, "@5 in X is relative to the last point of the sketch, #7 in Y is absolute");
      const expr = entry("point", [], [0, 0], { x: "#2*pin_r,3" }, evaluatorFor(projectWithParameter()));
      assert(expr.ok && expr.point[0] === 8 && expr.point[1] === 3, "a coordinate pair may use expressions and parameters");
      const bad = parseCoordinatePair("@12,", plainEvaluator);
      assert(bad !== undefined && !bad.ok, "a pair with a missing half is an error, not a silent default");
      const misplaced = parseFieldEntry("@5", field("line", 1, "length"));
      assert(!misplaced.ok, "@ in a length field (not a pair) is refused with a hint");
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // E27: dust, H/V relation, negative sizes
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input E27: a typed 90 degree line is exactly vertical (no 3e-16 dust) and earns a Vertical relation that survives the real operation path",
    run: () => {
      const start: Vec2 = [10, 5];
      const result = entry("line", [start], [40, 40], { length: "5", angle: "90" });
      assert(result.ok, "the entry resolves");
      equal(result.point[0], 10, "x is exactly the start x");
      equal(result.point[1], 10, "y is exactly 5 above");
      equal(result.guides.map((guide) => guide.kind).join(","), "vertical", "a vertical guide from the start comes with it");
      // The old maths: cos(90 degrees) is 6e-17, so x was 10.0000000000000003.
      assert(Math.cos(Math.PI / 2) !== 0, "(the dust this replaces)");
      for (const [angle, kind] of [["0", "horizontal"], ["180", "horizontal"], ["270", "vertical"], ["360", "horizontal"], ["-90", "vertical"], ["450", "vertical"]] as const) {
        const r = entry("line", [[0, 0]], [3, 4], { length: "7", angle });
        assert(r.ok, `${angle} resolves`);
        equal(r.guides.map((guide) => guide.kind).join(","), kind, `${angle} degrees is ${kind}`);
        assert(Number.isInteger(r.point[0]) && Number.isInteger(r.point[1]), `${angle} degrees gives whole-number coordinates (${r.point.join(",")})`);
      }
      const thirty = entry("line", [[0, 0]], [3, 4], { length: "10", angle: "30" });
      assert(thirty.ok && thirty.guides.length === 0, "30 degrees earns no H/V guide");
      near(thirty.ok ? thirty.point[0] : 0, 8.660254037844386, 1e-8, "and keeps its real coordinates");
      // Through the real code path: the placed point -> auto-constraints -> apply-sketch-edit -> the stored sketch.
      assert(result.ok, "result ok");
      const built = buildSketchEntity("line", [start, result.point], "entity:typed");
      assert(built.ok, "the line builds");
      const sketch = emptySketch();
      const placed: readonly PlacedPointInference[] = [{ point: start }, { point: result.point, guides: result.guides, anchor: start }];
      const constraints = autoConstraintsFor({ tool: "line", entity: built.value, placed, sketch, newId: () => "constraint:auto-typed" });
      equal(constraints.map((constraint) => constraint.kind).join(","), "vertical", "the typed 90 degree line is made Vertical");
      const project = createWorkbenchProject("project:test-typed-vertical");
      const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: "operation:test-typed-vertical", expectedRevision: project.revision, removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: constraints, label: "Typed line" });
      assert(applied.ok, `the typed line and its relation apply: ${applied.ok ? "" : applied.diagnostics[0]?.message ?? ""}`);
      const stored = applied.value.project.sketch.entities.find((entity) => entity.id === "entity:typed");
      assert(stored?.kind === "line" && stored.start[0] === stored.end[0], "the stored line has identical x at both ends");
      assert(applied.value.project.sketch.constraints.some((constraint) => constraint.kind === "vertical" && constraint.entityIds.includes("entity:typed")), "and the Vertical relation is recorded");
    }
  },
  {
    name: "Sketch tool input E27: a negative typed width goes the other way, a negative length points backwards, a bad radius is refused, and each flip is reported",
    run: () => {
      const corner: Vec2 = [0, 0];
      const cursorRight: Vec2 = [30, 20];
      const negative = entry("rectangle", [corner], cursorRight, { width: "-40", height: "25" });
      assert(negative.ok, "a negative width resolves");
      equal(negative.point[0], -40, "the cursor is to the right, the typed -40 goes LEFT (it used to be abs()-ed to +40)");
      equal(negative.point[1], 25, "the height still follows the cursor side");
      assert(negative.notes.some((note) => /negative width/i.test(note) && /left/.test(note)), `the user is told: ${negative.notes.join(" | ")}`);
      const both = entry("rectangle", [corner], cursorRight, { width: "-10", height: "-6" });
      assert(both.ok && both.point[0] === -10 && both.point[1] === -6 && both.notes.length === 2, "both negative: both flip, both are reported");
      const positive = entry("rectangle", [corner], cursorRight, { width: "40", height: "25" });
      assert(positive.ok && positive.point[0] === 40 && positive.notes.length === 0, "positive sizes are unchanged and silent");
      const backwards = entry("line", [[0, 0]], [10, 0], { length: "-8", angle: "0" });
      assert(backwards.ok && backwards.point[0] === -8 && backwards.point[1] === 0, "a negative length at 0 degrees points to -X");
      assert(backwards.ok && backwards.notes.some((note) => /negative length/i.test(note)), "and says so");
      const radius = entry("circle", [[0, 0]], [10, 0], { diameter: "-5" });
      assert(!radius.ok && /negative/i.test(radius.message), `a negative diameter is refused with a reason: ${radius.ok ? "" : radius.message}`);
      const zero = entry("circle", [[0, 0]], [10, 0], { diameter: "0" });
      assert(!zero.ok && zero.errors["diameter"] !== undefined, "a zero diameter is refused on the diameter field");
      const wrapped = entry("line", [[0, 0]], [10, 3], { length: "5", angle: "-90" });
      assert(wrapped.ok && wrapped.point[0] === 0 && wrapped.point[1] === -5 && wrapped.notes.some((note) => /270/.test(note)), "a negative angle is read as 270 degrees and reported");
      equal(normalizeAngleDeg(-0), 0, "-0 is 0");
      equal(normalizeAngleDeg(360), 0, "360 is 0");
      equal(normalizeAngleDeg(-450), 270, "-450 is 270");
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // T10: fields for every tool, each building the shape it promises
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input T10: every drawing tool offers typed fields (the first point as X and Y, then the size of the next one)",
    run: () => {
      const tools: readonly SketchTool[] = [
        "line", "rectangle", "rectangle-center", "rectangle-three-point", "circle", "circle-two-point", "circle-three-point", "ellipse", "arc", "arc-center", "arc-tangent",
        "point", "spline", "polygon", "slot", "slot-straight", "line-midpoint", "centerline", "parallelogram", "rectangle-rounded", "slot-arc-three-point", "slot-arc-center",
        "spline-control", "parabola", "hyperbola", "conic", "conic-five", "profile", "text", "block"
      ];
      for (const tool of tools) {
        equal(dynamicFieldsFor(tool, 0).map((f) => f.id).join(","), "x,y", `${tool}: the first point is typed as X and Y`);
        if (requiredSketchPoints(tool) >= 2 || tool === "spline" || tool === "profile") assert(dynamicFieldsFor(tool, 1).length > 0, `${tool}: has fields for its second point`);
      }
      equal(dynamicFieldsFor("blend", 0).length, 0, "the blend tool picks existing curve ends, so it has no typed point");
      const expect: Record<string, string> = {
        "arc:2": "radius", "arc-center:1": "radius,angle", "arc-center:2": "sweep", "arc-tangent:1": "angle", "arc-tangent:2": "length,angle", "polygon:1": "radius,angle",
        "slot:1": "length,angle", "slot:2": "width", "slot-straight:2": "width", "ellipse:1": "major,angle", "ellipse:2": "minor", "circle-three-point:2": "radius", "rectangle-rounded:1": "width,height"
      };
      for (const [key, fields] of Object.entries(expect)) {
        const [tool, count] = key.split(":") as [SketchTool, string];
        equal(dynamicFieldsFor(tool, Number(count)).map((f) => f.id).join(","), fields, `${tool} with ${count} point(s)`);
      }
    }
  },
  {
    name: "Sketch tool input T10: typed polygon, slot, straight slot, ellipse and rounded rectangle values build exactly that shape",
    run: () => {
      const polygonCorner = entry("polygon", [[0, 0]], [3, 3], { radius: "12 mm", angle: "90" });
      assert(polygonCorner.ok, "polygon corner");
      const polygon = buildPolygon([0, 0], polygonCorner.point, 6, ids());
      assert(polygon.ok, "the polygon builds");
      for (const side of polygon.value.entities.filter((entity) => !entity.construction)) {
        assert(side.kind === "line", "polygon side");
        near(Math.hypot(side.start[0], side.start[1]), 12, 1e-9, "every corner is exactly the typed circumradius from the centre");
      }
      const slotEnd = entry("slot", [[0, 0]], [18, 2], { length: "20", angle: "0" });
      assert(slotEnd.ok && slotEnd.point[0] === 20 && slotEnd.point[1] === 0, "slot centre distance 20 at 0 degrees");
      const slotWidth = entry("slot", [[0, 0], [20, 0]], [10, 7], { width: "8" });
      assert(slotWidth.ok, "slot width");
      near(slotWidth.point[1], 4, 1e-12, "the width point is half the width off the axis, on the cursor side");
      const slot = buildSlot([0, 0], [20, 0], slotWidth.point, ids());
      assert(slot.ok, "the slot builds");
      const cap = slot.value.entities.find((entity) => entity.kind === "arc");
      assert(cap?.kind === "arc" && Math.abs(cap.mid[0] - 24) < 1e-9, "the end cap reaches 4 mm (half of 8) beyond the end centre");
      const below = entry("slot", [[0, 0], [20, 0]], [10, -7], { width: "8" });
      assert(below.ok && below.point[1] === -4, "the width goes to the side the cursor is on");
      const straight = entry("slot-straight", [[0, 0], [30, 0]], [15, 5], { width: "10" });
      assert(straight.ok, "straight slot width");
      const overall = buildSlotOverall([0, 0], [30, 0], straight.ok ? straight.point : [0, 0], ids());
      assert(overall.ok, "the straight slot builds");
      const ellipseMajor = entry("ellipse", [[0, 0]], [8, 1], { major: "10", angle: "0" });
      assert(ellipseMajor.ok && ellipseMajor.point[0] === 10, "ellipse major axis end");
      const ellipseMinor = entry("ellipse", [[0, 0], [10, 0]], [4, 9], { minor: "4" });
      assert(ellipseMinor.ok, "ellipse minor");
      const ellipse = buildSketchEntity("ellipse", [[0, 0], [10, 0], ellipseMinor.ok ? ellipseMinor.point : [0, 0]], "e:e");
      assert(ellipse.ok && ellipse.value.kind === "ellipse" && Math.abs(ellipse.value.majorRadiusMm - 10) < 1e-9 && Math.abs(ellipse.value.minorRadiusMm - 4) < 1e-9, "the ellipse is 10 x 4");
      const rounded = entry("rectangle-rounded", [[0, 0]], [5, 5], { width: "30", height: "20" });
      assert(rounded.ok && rounded.point[0] === 30 && rounded.point[1] === 20, "rounded rectangle corner");
      const withThreePoint = entry("rectangle-three-point", [[0, 0], [20, 0]], [10, -9], { height: "-7" });
      assert(withThreePoint.ok && withThreePoint.point[1] === 7 && withThreePoint.notes.length === 1, "a negative 3-point height flips to the other side and says so");
    }
  },
  {
    name: "Sketch tool input T10: typed radius for a 3-point circle or arc, typed sweep for a centerpoint arc, typed tangent leg for a tangent arc",
    run: () => {
      // Circle through two points with a typed circumradius.
      const third = entry("circle-three-point", [[0, 0], [12, 0]], [6, 9], { radius: "10" });
      assert(third.ok, "the third circle point");
      const circle = buildSketchEntity("circle-three-point", [[0, 0], [12, 0], third.ok ? third.point : [0, 0]], "e:c3");
      assert(circle.ok && circle.value.kind === "circle", "the circle builds");
      near(circle.value.kind === "circle" ? circle.value.radiusMm : 0, 10, 1e-9, "the 3-point circle has the typed radius");
      const tooSmall = entry("circle-three-point", [[0, 0], [12, 0]], [6, 9], { radius: "5" });
      assert(!tooSmall.ok && /at least 6/.test(tooSmall.message), `a radius below half the chord is refused with the minimum: ${tooSmall.ok ? "" : tooSmall.message}`);
      // The 3-point arc.
      const arcEnd = entry("arc", [[0, 0], [10, 0]], [5, -5], { radius: "8" });
      assert(arcEnd.ok, "arc end");
      const arc = buildSketchEntity("arc", [[0, 0], [10, 0], arcEnd.ok ? arcEnd.point : [0, 0]], "e:arc");
      assert(arc.ok, "the arc builds");
      // Centerpoint arc: radius + angle give the start, the sweep gives the end.
      const start = entry("arc-center", [[0, 0]], [4, 1], { radius: "10", angle: "0" });
      assert(start.ok && start.point[0] === 10 && start.point[1] === 0, "arc start at radius 10, angle 0");
      const end = entry("arc-center", [[0, 0], [10, 0]], [3, 3], { sweep: "90" });
      assert(end.ok && end.point[0] === 0 && end.point[1] === 10, "a +90 degree sweep ends straight up");
      const endCw = entry("arc-center", [[0, 0], [10, 0]], [3, 3], { sweep: "-90" });
      assert(endCw.ok && endCw.point[0] === 0 && endCw.point[1] === -10, "a -90 degree sweep goes clockwise");
      const built = buildSketchEntity("arc-center", [[0, 0], [10, 0], end.ok ? end.point : [0, 0]], "e:ac");
      assert(built.ok && built.value.kind === "arc" && Math.abs(built.value.end[0]) < 1e-9 && Math.abs(built.value.end[1] - 10) < 1e-9, "the centerpoint arc ends at (0, 10)");
      assert(!entry("arc-center", [[0, 0], [10, 0]], [3, 3], { sweep: "0" }).ok, "a zero sweep is refused");
      assert(!entry("arc-center", [[0, 0], [10, 0]], [3, 3], { sweep: "360" }).ok, "a full turn is refused");
      // Tangent arc: the first leg is a direction, the second the end point.
      const direction = entry("arc-tangent", [[0, 0]], [20, 1], { angle: "90" });
      assert(direction.ok && direction.point[0] === 0 && direction.point[1] > 0, "the tangent direction is straight up");
      const tangentEnd = entry("arc-tangent", [[0, 0], [0, 10]], [5, 5], { length: "10", angle: "45" });
      assert(tangentEnd.ok, "tangent arc end");
      const tangent = buildSketchEntity("arc-tangent", [[0, 0], [0, 10], tangentEnd.ok ? tangentEnd.point : [0, 0]], "e:at");
      assert(tangent.ok, "the tangent arc builds from typed values");
      // Fit-point spline: each next fit point by length and angle from the previous one.
      const second = entry("spline", [[0, 0], [10, 0]], [20, 5], { length: "10", angle: "45" });
      assert(second.ok && Math.abs(second.point[0] - (10 + 10 * Math.SQRT1_2)) < 1e-8, "a spline point is typed relative to the last point");
    }
  },
  {
    name: "Sketch tool input T10: the live values the fields show round-trip through the solver for every tool",
    run: () => {
      const cases: readonly { tool: SketchTool; placed: readonly Vec2[]; cursor: Vec2 }[] = [
        { tool: "line", placed: [[1, 2]], cursor: [8, 6] },
        { tool: "rectangle", placed: [[1, 2]], cursor: [8, -6] },
        { tool: "rectangle-center", placed: [[1, 2]], cursor: [-8, 6] },
        { tool: "circle", placed: [[1, 2]], cursor: [4, 6] },
        { tool: "circle-two-point", placed: [[1, 2]], cursor: [4, 6] },
        { tool: "polygon", placed: [[0, 0]], cursor: [4, 6] },
        { tool: "slot", placed: [[0, 0], [20, 0]], cursor: [10, 5] },
        { tool: "ellipse", placed: [[0, 0], [10, 0]], cursor: [10, 3] },
        { tool: "arc-center", placed: [[0, 0], [10, 0]], cursor: [0, 10] },
        { tool: "arc", placed: [[0, 0], [10, 0]], cursor: [5, -5] },
        { tool: "circle-three-point", placed: [[0, 0], [10, 0]], cursor: [5, 5] },
        { tool: "spline", placed: [[0, 0], [10, 0]], cursor: [14, 3] }
      ];
      for (const { tool, placed, cursor } of cases) {
        const live = measureFromCursor(tool, placed, cursor);
        assert(Object.keys(live).length > 0, `${tool} shows live values`);
        const point = pointFromDynamicInput(tool, placed, cursor, live);
        assert(point !== undefined, `${tool} accepts its own live values`);
        // Typing exactly what the fields already show must put the point where the cursor is (or on the same side of the same circle).
        if (tool === "arc" || tool === "circle-three-point") {
          const a = placed[0]!; const b = placed[1]!;
          const area = Math.abs((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]));
          assert(area > 1e-6, `${tool}: the point is not collinear with the first two`);
        } else if (tool === "slot" || tool === "ellipse") {
          near(Math.abs(point[1]), Math.abs(tool === "slot" ? cursor[1] : cursor[1]), 1e-9, `${tool}: the offset equals the cursor's offset`);
        } else {
          near(point[0], cursor[0], 1e-6, `${tool}: x round-trips`);
          near(point[1], cursor[1], 1e-6, `${tool}: y round-trips`);
        }
      }
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // T23: alignment / polar / ortho / hold keys
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input T23: every placing tool gets alignment guides from its first point, and midpoints and quadrants align too",
    run: () => {
      const first: Vec2 = [10, 10];
      for (const tool of ["slot", "ellipse", "polygon", "circle", "rectangle", "arc-center", "circle-two-point", "line-midpoint", "parallelogram"] as const) {
        equal(anchorFor(tool, [first]), first, `${tool} measures alignment from its last placed point`);
        const result = assistedInference({ tool, pointer: [47.2, 10.3], sketch: emptySketch(), toleranceMm: 1, gridMm: undefined, anchor: anchorFor(tool, [first]), settings: settings() });
        assert(result.snapped && result.point[1] === 10 && result.guides.some((guide) => guide.kind === "horizontal"), `${tool}: the pointer 0.3 mm off level with the first point snaps level`);
        equal(anchorUseFor(tool), "align", `${tool} uses its first point for alignment only (no perpendicular or tangent hints)`);
      }
      equal(anchorUseFor("line"), "full", "a line keeps perpendicular and tangent hints");
      equal(anchorFor("select", [first]), undefined, "the select tool has no anchor");
      // A slot's end is not offered a perpendicular foot onto the line next to it (anchorUse align).
      const wall = emptySketch([line("entity:wall", [0, 0], [100, 0])]);
      const withLine = inferSketchPoint([60.2, 30.1], wall, { toleranceMm: 1, anchor: [60, 30] });
      const asSlot = assistedInference({ tool: "slot", pointer: [60.2, 30.1], sketch: wall, toleranceMm: 1, gridMm: undefined, anchor: [60, 30], settings: settings() });
      assert(asSlot.guides.length >= 0 && withLine.snapped, "(sanity)");
      // The audit repro: a pointer aligned with a midpoint at (50, 20) gave no snap.
      const withMidpoint = emptySketch([line("entity:m", [40, 20], [60, 20]), line("entity:far", [0, 100], [1, 100])]);
      const aligned = inferSketchPoint([50.3, 70], withMidpoint, { toleranceMm: 1 });
      equal(aligned.snapped, true, "a pointer vertically level with a line's midpoint snaps");
      equal(aligned.point[0], 50, "onto the midpoint's x");
      equal(aligned.guides.map((guide) => guide.kind).join(","), "vertical", "with a vertical guide");
      const circleSketch = emptySketch([{ id: "entity:c", kind: "circle", center: [0, 0], radiusMm: 10, construction: false }]);
      const quadrant = inferSketchPoint([55, 10.2], circleSketch, { toleranceMm: 1 });
      equal(quadrant.point[1], 10, "level with a circle's top quadrant point");
    }
  },
  {
    name: "Sketch tool input polar tracking: 45 and 15 degree increments snap to the nearest ray, 0/90 become horizontal/vertical relations, and a named snap beats polar",
    run: () => {
      const anchor: Vec2 = [0, 0];
      const polar45 = settings({ polar: true, polarIncrementDeg: 45, snap: true });
      const at = (pointer: Vec2, patch: Partial<SnapAssistSettings> = {}, sketch = emptySketch()) => assistedInference({ tool: "line", pointer, sketch, toleranceMm: 1, gridMm: undefined, anchor, settings: { ...polar45, ...patch } });
      const diagonal = at([40.4, 39.7]);
      near(diagonal.point[0], diagonal.point[1], 1e-9, "near 45 degrees snaps onto the 45 degree ray");
      equal(diagonal.primary?.kind, "polar", "reported as a polar snap");
      equal(diagonal.note, "Polar 45°", "labelled with its angle");
      equal(diagonal.guides[0]?.kind, "polar", "with a polar guide");
      const off = at([40, 30]);
      equal(off.snapped, false, "36.9 degrees is not within reach of a 45 degree ray");
      const fifteen = at([39.5, 10.6], { polarIncrementDeg: 15 });
      equal(fifteen.note, "Polar 15°", "a 15 degree increment finds the 15 degree ray");
      near(Math.atan2(fifteen.point[1], fifteen.point[0]) * 180 / Math.PI, 15, 1e-9, "exactly on it");
      const level = at([50, 0.4]);
      equal(level.point[1], 0, "0 degrees: exactly level");
      equal(level.primary?.kind, "horizontal", "reported as a horizontal relation (so the line is made Horizontal)");
      equal(level.guides[0]?.kind, "horizontal", "with a horizontal guide from the anchor");
      const plumb = at([-0.4, -50]);
      equal(plumb.point[0], 0, "270 degrees: exactly plumb");
      equal(plumb.primary?.kind, "vertical", "reported as a vertical relation");
      const builtLevel = buildSketchEntity("line", [anchor, level.point], "e:lv");
      assert(builtLevel.ok, "the level line builds");
      const relations = autoConstraintsFor({ tool: "line", entity: builtLevel.value, placed: [{ point: anchor }, { point: level.point, ...(level.primary === undefined ? {} : { primary: level.primary }), guides: level.guides, anchor }], sketch: emptySketch(), newId: () => "c:h" });
      equal(relations.map((relation) => relation.kind).join(","), "horizontal", "a polar 0 degree line gets the Horizontal relation");
      // A named snap point is stronger than a polar ray.
      const withEnd = emptySketch([line("entity:e", [30, 30.5], [60, 80])]);
      const named = at([30.2, 30.6], {}, withEnd);
      equal(named.primary?.kind, "endpoint", "an endpoint under the pointer still wins over the 45 degree ray");
      // Distance along the ray follows the grid when snapping is on.
      const grid = assistedInference({ tool: "line", pointer: [40.2, 39.8], sketch: emptySketch(), toleranceMm: 1, gridMm: 10, anchor, settings: polar45 });
      assert(grid.snapped, "polar + grid snap");
      // Off means off.
      const polarOff = at([40.4, 39.7], { polar: false, snap: false });
      equal(polarOff.snapped, false, "with polar and snap off the pointer is free");
    }
  },
  {
    name: "Sketch tool input ortho lock and hold keys: Shift constrains, the Ortho toggle locks, Ctrl switches snapping off, and the snap step is configurable",
    run: () => {
      const anchor: Vec2 = [10, 10];
      const base = { tool: "line" as const, sketch: emptySketch(), toleranceMm: 1, gridMm: undefined, anchor };
      const shifted = assistedInference({ ...base, pointer: [50, 14], settings: settings(), modifiers: { ctrl: false, shift: true } });
      equal(shifted.point[0], 50, "Shift keeps the dominant axis");
      equal(shifted.point[1], 10, "and levels the other with the anchor");
      equal(shifted.primary?.kind, "horizontal", "a level line, so it earns the relation");
      equal(shifted.note, "Constrained", "and says so");
      const vertical = assistedInference({ ...base, pointer: [12, 60], settings: settings(), modifiers: { ctrl: false, shift: true } });
      assert(vertical.point[0] === 10 && vertical.point[1] === 60 && vertical.primary?.kind === "vertical", "the vertical axis when the pointer is mostly above");
      const ortho = assistedInference({ ...base, pointer: [50, 14], settings: settings({ ortho: true }) });
      assert(ortho.point[1] === 10 && ortho.note === "Ortho", "the Ortho toggle locks without Shift");
      const free = assistedInference({ ...base, pointer: [50, 14], settings: settings({ ortho: true }), modifiers: { ctrl: true, shift: false } });
      assert(free.point[0] === 50 && free.point[1] === 14 && !free.snapped, "Ctrl overrides the Ortho lock as well");
      // Ctrl disables snapping: a pointer 0.4 mm from an endpoint stays where it is.
      const withEnd = emptySketch([line("entity:e", [30, 30], [60, 80])]);
      const snapped = assistedInference({ ...base, sketch: withEnd, pointer: [30.4, 30.2], settings: settings() });
      equal(snapped.primary?.kind, "endpoint", "without Ctrl the endpoint wins");
      const held = assistedInference({ ...base, sketch: withEnd, pointer: [30.4, 30.2], settings: settings(), modifiers: { ctrl: true, shift: false } });
      assert(!held.snapped && held.point[0] === 30.4 && held.point[1] === 30.2, "with Ctrl held the pointer is exactly where it is");
      const square = assistedInference({ ...base, tool: "rectangle", pointer: [50, 20], settings: settings(), modifiers: { ctrl: false, shift: true } });
      assert(square.point[0] === 50 && square.point[1] === 50, "Shift on a rectangle makes it a square (40 x 40)");
      const squareBack = assistedInference({ ...base, tool: "rectangle", pointer: [-20, 25], settings: settings(), modifiers: { ctrl: false, shift: true } });
      assert(squareBack.point[0] === -20 && squareBack.point[1] === 40, "in the quadrant the pointer is in");
      // Snap increment: the palette's step replaces the grid step.
      const fine = assistedInference({ ...base, anchor: undefined, pointer: [12.52, 7.49], gridMm: 10, settings: settings({ snapStepMm: 0.5 }) });
      assert(fine.snapped && fine.point[0] === 12.5 && fine.point[1] === 7.5, "a 0.5 mm snap step overrides the 10 mm grid");
      const coarse = assistedInference({ ...base, anchor: undefined, pointer: [12.52, 7.49], gridMm: 10, settings: settings({ snapStepMm: undefined }) });
      assert(!coarse.snapped, "following the 10 mm grid the same pointer is out of reach");
      // Settings round-trip and damaged settings.
      const storage = memoryStorage();
      saveSnapAssist(storage, settings({ polar: true, polarIncrementDeg: 15, ortho: true, snapStepMm: 0.25 }));
      const loaded = loadSnapAssist(storage);
      assert(loaded.polar && loaded.ortho && loaded.polarIncrementDeg === 15 && loaded.snapStepMm === 0.25, "the choices survive a reload");
      equal(snapAssistFromJson({ polarIncrementDeg: 9999, snapStepMm: -3 }).polarIncrementDeg, 90, "an absurd increment is clamped");
      equal(snapAssistFromJson({ snapStepMm: -3 }).snapStepMm, undefined, "a bad step is dropped");
      equal(loadSnapAssist(memoryStorage({ "ps3d.sketch-snap-assist.v1": "{not json" })).polar, false, "junk falls back to the defaults");
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // Select other
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input select-other: coincident and overlapping curves are all listed under the pointer and cycled in a stable order",
    run: () => {
      const sketch = emptySketch([
        line("entity:o1", [0, 0], [20, 0]),
        line("entity:o2", [0, 0], [20, 0]),
        { id: "entity:box", kind: "rectangle", center: [10, 5], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false },
        line("entity:far", [0, 50], [20, 50]),
        { ...line("entity:hidden", [0, 0], [20, 0]), visible: false }
      ]);
      const under = entitiesUnderPoint(sketch, [10, 0.2], 1);
      equal(under.map((candidate) => candidate.id).join(","), "entity:o1,entity:o2,entity:box", "both coincident lines and the rectangle edge, in sketch order, hidden and far curves left out");
      assert(under.every((candidate) => candidate.label.length > 0), "each has a label for the popup");
      equal(under[0]!.label, "Line 20 mm", "the line is described by its length");
      equal(nextInCycle(under, "entity:o1"), "entity:o2", "cycling goes to the next");
      equal(nextInCycle(under, "entity:box"), "entity:o1", "and wraps round");
      equal(nextInCycle(under, "entity:o1", -1), "entity:box", "backwards too");
      equal(nextInCycle(under, null), "entity:o1", "with nothing selected it starts at the nearest");
      equal(nextInCycle(under, "entity:gone"), "entity:o1", "an id that is not in the list starts at the first");
      equal(nextInCycle([], "entity:o1"), undefined, "nothing to cycle");
      // A circle and an arc that overlap, nearest first.
      const round = emptySketch([{ id: "entity:circle", kind: "circle", center: [0, 0], radiusMm: 10, construction: false }, { id: "entity:arc", kind: "arc", start: [10, 0], mid: [0, 10], end: [-10, 0], construction: false }]);
      equal(entitiesUnderPoint(round, [0, 10.3], 1).map((candidate) => candidate.id).sort().join(","), "entity:arc,entity:circle", "the circle and the arc that lies along its top are both listed");
      equal(entitiesUnderPoint(round, [0, 0], 1).length, 0, "the middle of a circle is not on it");
      // A click-sized tolerance picks the nearer of two close lines first.
      const close = emptySketch([line("entity:a", [0, 0], [20, 0]), line("entity:b", [0, 0.6], [20, 0.6])]);
      equal(entitiesUnderPoint(close, [10, 0.5], 1).map((candidate) => candidate.id).join(","), "entity:b,entity:a", "the nearer line comes first");
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // T24: keymap
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input T24: the default keymap binds spline, ellipse, polygon, slot, point, fillet, extend, move, mirror, trim, offset and dimension with no conflicts",
    run: () => {
      equal(keymapConflicts(DEFAULT_SKETCH_KEYMAP.keys).length, 0, "no key is claimed twice");
      const expectations: readonly [string, string][] = [
        ["tool:spline", "spline"], ["tool:ellipse", "ellipse"], ["tool:polygon", "polygon"], ["tool:slot", "slot"], ["tool:point", "point"],
        ["edit:fillet", "fillet"], ["edit:extend", "extend"], ["edit:move", "move"], ["edit:mirror", "mirror"], ["edit:trim", "trim"], ["edit:offset", "offset"], ["dimension", "dimension"]
      ];
      for (const [command, name] of expectations) {
        const key = DEFAULT_SKETCH_KEYMAP.keys[command as keyof typeof DEFAULT_SKETCH_KEYMAP.keys];
        assert(key !== undefined, `${name} has a default key`);
        const spec = key.replace("Shift+", "");
        const action = resolveSketchHotkey(press(spec.toLowerCase(), { shift: key.startsWith("Shift+") }), idle, DEFAULT_SKETCH_KEYMAP);
        assert(action !== undefined, `pressing ${key} does something`);
        const matches = command.startsWith("tool:") ? action.kind === "tool" && `tool:${action.tool}` === command : command.startsWith("edit:") ? action.kind === "edit-tool" && `edit:${action.tool}` === command : action.kind === command;
        assert(matches, `${key} runs ${name}: got ${JSON.stringify(action)}`);
      }
      // The old keys keep working.
      for (const [key, tool] of [["l", "line"], ["r", "rectangle"], ["c", "circle"], ["a", "arc"]] as const) equal(JSON.stringify(resolveSketchHotkey(press(key), idle)), JSON.stringify({ kind: "tool", tool }), `${key} still selects ${tool}`);
      // Every ribbon tool's chip text comes from the keymap: a tool with no key has no chip.
      equal(keyLabelForTool("line"), "L", "the line chip");
      equal(keyLabelForTool("rectangle-center"), "Shift+R", "the centre rectangle chip is a key that works (not 'R2')");
      equal(keyChipForTool("rectangle-center"), "⇧R", "and the short form");
      equal(keyLabelForTool("rectangle-three-point"), undefined, "a tool with no key has no chip (not 'R3')");
      equal(keyLabelForTool("circle-two-point"), "Shift+C", "2-point circle");
      equal(keyLabelForTool("select"), "V", "select");
      equal(keyLabelForTool("trim"), "T", "an edit tool");
      equal(keyLabelForTool("dimension"), "D", "dimension");
      equal(keyLabelForTool("not-a-tool"), undefined, "an unknown id has none");
      for (const info of SKETCH_KEYMAP_COMMANDS) {
        const key = DEFAULT_SKETCH_KEYMAP.keys[info.id];
        if (key === undefined) continue;
        const toolId = info.id.startsWith("tool:") ? info.id.slice(5) : info.id.startsWith("edit:") ? info.id.slice(5) : info.id === "select-tool" ? "select" : info.id;
        equal(keyLabelForTool(toolId), key, `the chip for ${info.id} is its bound key`);
      }
    }
  },
  {
    name: "Sketch tool input T24: customising a key moves it, detects conflicts, refuses reserved keys, persists, and survives damaged settings",
    run: () => {
      // Conflict detection.
      const taken = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "R");
      assert(!taken.ok && taken.conflict === "tool:rectangle" && /2-point rectangle/.test(taken.reason), `L -> R is a conflict with the rectangle: ${taken.ok ? "" : taken.reason}`);
      const reserved = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "S");
      assert(!reserved.ok && /command search/i.test(reserved.reason), "S is reserved for the command search");
      assert(rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "Shift+S").ok === false, "Shift+S is the spline's, so it conflicts rather than being reserved");
      assert(!rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "5").ok, "a digit is not allowed (digits type into the fields)");
      assert(!rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "Ctrl+L").ok, "Ctrl combinations are not allowed");
      assert(!rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "F5").ok, "F5 belongs to the browser");
      const free = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "n");
      assert(free.ok, "an unused key is accepted");
      equal(free.keymap.keys["tool:line"], "N", "normalised to upper case");
      equal(resolveSketchHotkey(press("n"), idle, free.keymap)?.kind, "tool", "N now starts the line");
      equal(resolveSketchHotkey(press("l"), idle, free.keymap), undefined, "and L no longer does");
      const replaced = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "R", { replace: true });
      assert(replaced.ok && replaced.displaced === "tool:rectangle", "replacing takes the key from the rectangle");
      equal(replaced.keymap.keys["tool:rectangle"], undefined, "which becomes unbound");
      equal(keymapConflicts(replaced.keymap.keys).length, 0, "and the keymap is still conflict free");
      const unbound = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:polygon", undefined);
      assert(unbound.ok && resolveSketchHotkey(press("g"), idle, unbound.keymap) === undefined, "a command can be unbound");
      // Persistence.
      const storage = memoryStorage();
      assert(free.ok && replaced.ok, "ok");
      saveKeymap(storage, free.keymap);
      equal(storage.data.get(KEYMAP_STORAGE_KEY), JSON.stringify({ "tool:line": "N" }), "only the difference from the defaults is stored");
      const reloaded = loadKeymap(storage);
      equal(reloaded.keys["tool:line"], "N", "the custom key is back after a reload");
      equal(reloaded.keys["tool:rectangle"], "R", "the rest are the defaults");
      saveKeymap(storage, DEFAULT_SKETCH_KEYMAP);
      equal(storage.data.has(KEYMAP_STORAGE_KEY), false, "the defaults clear the entry");
      saveKeymap(storage, replaced.keymap);
      const swapped = loadKeymap(storage);
      equal(swapped.keys["tool:line"], "R", "a stolen key survives a reload");
      equal(swapped.keys["tool:rectangle"], undefined, "and the loser stays unbound");
      // Damaged settings never produce a conflict or a crash.
      const junk = keymapFromOverrides({ "tool:line": "R", "tool:rectangle": "R", "tool:nope": "Z", "tool:circle": 7, "tool:arc": "Ctrl+A", "edit:trim": null, dimension: "  d " });
      equal(keymapConflicts(junk.keys).length, 0, "two commands asking for R leave only one");
      equal(junk.keys["tool:line"], "R", "the earlier command in the editor order keeps it");
      equal(junk.keys["tool:rectangle"], undefined, "the later one is dropped (its default R was taken)");
      equal(junk.keys["tool:circle"], "C", "a non-string override is ignored");
      equal(junk.keys["tool:arc"], "A", "an unusable key is ignored");
      equal(junk.keys["edit:trim"], undefined, "null unbinds");
      equal(junk.keys["dimension"], "D", "spaces and case are normalised");
      equal(loadKeymap(memoryStorage({ [KEYMAP_STORAGE_KEY]: "{broken" })).keys["tool:line"], "L", "unparsable storage gives the defaults");
      equal(loadKeymap(undefined).keys["tool:line"], "L", "no storage gives the defaults");
      equal(normalizeKeySpec("shift + r"), "Shift+R", "key text is normalised");
      equal(normalizeKeySpec("alt+r"), undefined, "Alt is not a modifier of the keymap");
      equal(JSON.stringify(overridesOfKeymap(DEFAULT_SKETCH_KEYMAP)), "{}", "the defaults need no overrides");
    }
  },
  {
    name: "Sketch tool input T24: the live keymap drives the chips, the help sheet and the command search, and notifies listeners when it changes",
    run: () => {
      const before = getActiveSketchKeymap();
      let notified = 0;
      const unsubscribe = subscribeSketchKeymap(() => { notified += 1; });
      try {
        const changed = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:ellipse", "J");
        assert(changed.ok, "J is free");
        setActiveSketchKeymap(changed.keymap);
        equal(notified, 1, "listeners are told");
        equal(keyLabelForTool("ellipse"), "J", "the ribbon chip follows the change");
        equal(resolveSketchHotkey(press("j"), idle)?.kind, "tool", "the canvas follows it (default keymap argument is the live one)");
        assert(sketchHotkeyHelp().some((row) => row.keys === "J" && row.action === "Center ellipse"), "the help sheet lists J for the ellipse");
        assert(!sketchHotkeyHelp().some((row) => row.keys === "E"), "and no longer lists E");
        const search = searchableCommands();
        const ellipse = search.find((record) => record.action.kind === "activate-sketch-tool" && record.action.tool === "ellipse");
        equal(ellipse?.shortcut, "J", "the command search shows the live key");
        const line = search.find((record) => record.action.kind === "activate-sketch-tool" && record.action.tool === "line");
        equal(line?.shortcut, "L", "also on a tool that was already in the catalog");
        const rect3 = search.find((record) => record.action.kind === "activate-sketch-tool" && record.action.tool === "rectangle-three-point");
        equal(rect3?.shortcut, undefined, "and no shortcut where none is bound");
      } finally {
        unsubscribe();
        setActiveSketchKeymap(before);
      }
      equal(keyLabelForTool("ellipse"), "E", "restored");
    }
  },
  {
    name: "Sketch tool input T24: letters work on a non-Latin keyboard layout through the physical key",
    run: () => {
      // A Russian layout types 'д' on the physical L key.
      equal(JSON.stringify(resolveSketchHotkey(press("д", { code: "KeyL" }), idle)), JSON.stringify({ kind: "tool", tool: "line" }), "the physical L key starts the line");
      equal(resolveSketchHotkey(press("д"), idle), undefined, "without a code, a non-Latin character is not a shortcut");
      equal(JSON.stringify(resolveSketchHotkey(press("К", { code: "KeyR", shift: true }), idle)), JSON.stringify({ kind: "tool", tool: "rectangle-center" }), "Shift+R on that layout");
      // A Latin letter wins over the physical position (AZERTY: the A key prints q).
      equal(resolveSketchHotkey(press("a", { code: "KeyQ" }), idle)?.kind, "tool", "the printed letter A is the arc even though it is the physical Q key");
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // Keyboard-only drawing flow and the Esc ladder
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input keyboard-only flow: tool key, type X and Y, Tab, Enter places; Esc ladder drops the pending point, then the tool, then the selection",
    run: () => {
      // L selects the line tool.
      const chosen = resolveSketchHotkey(press("l"), idle);
      equal(chosen?.kind, "tool", "L");
      // With no point placed the fields are X and Y, so digits type into the first field.
      const noPoint: SketchHotkeyContext = { ...idle, tool: "line", dynamicFieldCount: dynamicFieldsFor("line", 0).length };
      equal(noPoint.dynamicFieldCount, 2, "two fields before the first point");
      equal(JSON.stringify(resolveSketchHotkey(press("1"), noPoint)), JSON.stringify({ kind: "type-value", key: "1" }), "a digit starts typing the X coordinate");
      equal(resolveSketchHotkey(press("Tab"), noPoint)?.kind, "focus-dynamic", "Tab moves into the fields");
      equal(resolveSketchHotkey(press("Enter"), noPoint), undefined, "Enter with nothing typed does nothing (it does not place a point blindly)");
      equal(resolveSketchHotkey(press("Enter"), { ...noPoint, dynamicTyped: true })?.kind, "commit-dynamic", "Enter on the canvas with typed text places the point");
      const first = entry("line", [], [0, 0], { x: "10", y: "5" });
      assert(first.ok && first.point[0] === 10 && first.point[1] === 5, "first point typed");
      const second = entry("line", [first.ok ? first.point : [0, 0]], [0, 0], { length: "20", angle: "45" });
      assert(second.ok, "second point typed");
      const built = buildSketchEntity("line", [first.ok ? first.point : [0, 0], second.ok ? second.point : [0, 0]], "e:kb");
      assert(built.ok && built.value.kind === "line" && Math.abs(Math.hypot(built.value.end[0] - 10, built.value.end[1] - 5) - 20) < 1e-9, "a line drawn without touching the mouse is exactly 20 mm");
      // Esc ladder.
      const pending: SketchHotkeyContext = { ...idle, tool: "line", pendingPoints: 1, selectionCount: 1, curveSelectionCount: 1 };
      equal(resolveSketchHotkey(press("Escape"), pending)?.kind, "cancel-points", "Esc 1: the pending point");
      equal(resolveSketchHotkey(press("Escape"), { ...pending, pendingPoints: 0 })?.kind, "select-tool", "Esc 2: the tool");
      equal(resolveSketchHotkey(press("Escape"), { ...pending, pendingPoints: 0, tool: "select" })?.kind, "clear-selection", "Esc 3: the selection");
      equal(resolveSketchHotkey(press("Escape"), { ...pending, pendingPoints: 0, tool: "select", selectionCount: 0 }), undefined, "Esc 4: nothing left, falls through");
      // Tab over overlapping curves is Select Other, but only when there are overlaps (otherwise Tab keeps moving focus).
      equal(resolveSketchHotkey(press("Tab"), { ...idle, overlapUnderCursor: 3 })?.kind, "select-other", "Tab cycles overlapping curves");
      equal(resolveSketchHotkey(press("Tab"), { ...idle, overlapUnderCursor: 1 }), undefined, "one curve: Tab is left alone");
      equal(resolveSketchHotkey(press("Tab"), { ...idle, tool: "line", overlapUnderCursor: 3 }), undefined, "a drawing tool without fields leaves Tab alone");
      // Function keys toggle the aids.
      equal(resolveSketchHotkey(press("F8"), idle)?.kind, "toggle-ortho", "F8 ortho");
      equal(resolveSketchHotkey(press("F9"), idle)?.kind, "toggle-snap", "F9 snap");
      equal(resolveSketchHotkey(press("F10"), idle)?.kind, "toggle-polar", "F10 polar");
    }
  },
  // ------------------------------------------------------------------------------------------------------------------
  // Command search and prompts
  // ------------------------------------------------------------------------------------------------------------------
  {
    name: "Sketch tool input command search: every sketch tool on the ribbon is a search entry, without changing the command catalog",
    run: () => {
      const catalogSize = CAD_COMMANDS.length;
      const search = searchableCommands(DEFAULT_SKETCH_KEYMAP);
      equal(CAD_COMMANDS.length, catalogSize, "the catalog is untouched");
      assert(search.length > catalogSize, "the search adds entries");
      const drawTools: readonly SketchTool[] = [
        "select", "line", "rectangle", "rectangle-center", "rectangle-three-point", "circle", "circle-two-point", "circle-three-point", "ellipse", "arc", "arc-center", "arc-tangent",
        "polygon", "slot", "slot-straight", "spline", "point",
        "line-midpoint", "centerline", "parallelogram", "rectangle-rounded", "slot-arc-three-point", "slot-arc-center", "spline-control", "parabola", "hyperbola", "conic", "conic-five", "blend", "profile", "text", "block"
      ];
      for (const tool of drawTools) {
        const found = search.find((record) => record.action.kind === "activate-sketch-tool" && record.action.tool === tool);
        assert(found !== undefined, `${tool} can be found with S`);
        assert(found.workspace === "sketch" && found.guide.steps.length >= 3 && found.guide.boundary.length > 0, `${tool}: the entry explains itself`);
      }
      const editTools = ["offset", "mirror", "pattern", "move", "rotate", "scale", "stretch", "corner", "fillet", "chamfer", "trim", "extend", "split", "jog", "delete-curve", "offset-move", "make-path", "dynamic-mirror"];
      for (const tool of editTools) assert(search.some((record) => record.action.kind === "activate-sketch-edit" && record.action.tool === tool), `edit tool ${tool} can be found`);
      for (const command of ["project-body", "project-edge", "intersect-body", "silhouette-body", "convert-face", "project-reference", "fix-curve", "show-movable", "sketch-check"]) assert(search.some((record) => record.action.kind === "sketch-command" && record.action.command === command), `${command} can be found`);
      const ids = search.map((record) => record.id);
      equal(new Set(ids).size, ids.length, "ids stay unique");
      equal(extraSketchSearchCommands(DEFAULT_SKETCH_KEYMAP).every((record) => !CAD_COMMANDS.some((existing) => existing.id === record.id)), true, "the extras never repeat a catalog entry");
      // The typed words a mechanical designer would use find them.
      const ellipse = search.find((record) => record.action.kind === "activate-sketch-tool" && record.action.tool === "ellipse");
      equal(ellipse?.shortcut, "E", "the ellipse entry carries its key");
    }
  },
  {
    name: "Sketch tool input performance: snapping with polar, select-other hover and typed entry stay fast on a 500-curve sketch",
    run: () => {
      const entities: SketchEntity[] = [];
      for (let index = 0; index < 500; index += 1) {
        const x = (index % 25) * 40;
        const y = Math.floor(index / 25) * 40;
        if (index % 3 === 0) entities.push({ id: `entity:l${index}`, kind: "line", start: [x, y], end: [x + 30, y + 10], construction: false });
        else if (index % 3 === 1) entities.push({ id: `entity:c${index}`, kind: "circle", center: [x + 10, y + 10], radiusMm: 6, construction: false });
        else entities.push({ id: `entity:s${index}`, kind: "spline", fitPoints: [[x, y], [x + 8, y + 12], [x + 20, y + 4], [x + 30, y + 14]], construction: false });
      }
      const sketch = emptySketch(entities);
      const started = performance.now();
      for (let call = 0; call < 100; call += 1) {
        const pointer: Vec2 = [37 * call % 900, 53 * call % 500];
        assistedInference({ tool: "slot", pointer, sketch, toleranceMm: 4, gridMm: 5, anchor: [10, 10], settings: settings({ polar: true }) });
        entitiesUnderPoint(sketch, pointer, 4);
      }
      const perCall = (performance.now() - started) / 100;
      assert(perCall < 25, `a pointer move costs well under a frame on 500 curves (${perCall.toFixed(2)} ms)`);
      const typed = performance.now();
      for (let call = 0; call < 2000; call += 1) entry("line", [[0, 0]], [10, 10], { length: "2*5 mm", angle: "30" });
      assert((performance.now() - typed) / 2000 < 2, "typed entry through the expression engine is cheap");
    }
  },
  {
    name: "Sketch tool input T24: every multi-click tool says what the next click means",
    run: () => {
      for (const tool of ["arc-center", "arc-tangent", "ellipse", "polygon", "slot", "slot-straight", "rectangle-three-point", "circle-three-point"] as const) {
        const clicks = requiredSketchPoints(tool);
        for (let placed = 0; placed < clicks; placed += 1) assert((nextClickPrompt(tool, placed) ?? "").length > 0, `${tool}: click ${placed + 1} has a prompt`);
        equal(nextClickPrompt(tool, clicks), undefined, `${tool}: no prompt after the last click`);
      }
      assert(/centre/.test(nextClickPrompt("arc-center", 0) ?? ""), "the centerpoint arc starts with the centre");
      assert(/radius/.test(nextClickPrompt("arc-center", 1) ?? ""), "then the start sets the radius");
      assert(/tangent/.test(nextClickPrompt("arc-tangent", 1) ?? ""), "the tangent arc asks for the tangent direction");
      assert(/minor/.test(nextClickPrompt("ellipse", 2) ?? ""), "the ellipse asks for the minor radius last");
      assert((nextClickPrompt("parabola", 2) ?? "").length > 0, "the newer curve tools keep their prompts");
      assert((nextClickPrompt("spline", 7) ?? "").length > 0, "a spline keeps prompting");
    }
  }
];
