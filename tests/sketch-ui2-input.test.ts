import { readFileSync } from "node:fs";
import { dynamicFieldsFor } from "../packages/workbench-sketch/src/dynamic-input.js";
import { fieldErrorsFor, parseCoordinatePair, parseFieldEntry, plainEvaluator, resolveDynamicEntry } from "../packages/workbench-sketch/src/dynamic-entry.js";
import { DEFAULT_SKETCH_KEYMAP, SKETCH_KEYMAP_COMMANDS, rebindKey, resolveSketchHotkey, sketchHotkeyHelp, sketchToolHotkeyChip, type SketchHotkeyContext, type SketchHotkeyInput } from "../packages/workbench-sketch/src/hotkeys.js";
import { sampleSpline } from "../packages/workbench-sketch/src/curve-sampling.js";
import type { Vec2 } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Wave 2 (ui2): the re-audit findings on typed entry, the keymap and the spline sampling cost. */

const idle: SketchHotkeyContext = { tool: "line", pendingPoints: 1, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 2 };
const press = (key: string, extra: Partial<SketchHotkeyInput> = {}): SketchHotkeyInput => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...extra });
const lengthField = { id: "length", label: "Length", unit: "mm", kind: "length" } as const;
const angleField = { id: "angle", label: "Angle", unit: "°", kind: "angle" } as const;

function splineFit(count: number): Vec2[] {
  return Array.from({ length: count }, (_, index): Vec2 => [index * 3, Math.sin(index * 0.7) * 5 + (index % 3)]);
}
function timeSampling(count: number, repeats: number): number {
  const fit = splineFit(count);
  sampleSpline(fit, 8);
  const start = performance.now();
  for (let round = 0; round < repeats; round += 1) sampleSpline(splineFit(count), 8);
  return (performance.now() - start) / repeats;
}

export const sketchUi2InputTests: readonly TestCase[] = [
  {
    name: "Re-audit input N5: @, #, + and ( start typed entry from the canvas, like the digits do (AltGr too); the help sheet lists them",
    run: () => {
      for (const key of ["0", "5", ".", ",", "-", "@", "#", "+", "("]) {
        const action = resolveSketchHotkey(press(key), idle);
        assert(action?.kind === "type-value" && action.key === key, `${key} starts typing into the first field (got ${action?.kind})`);
      }
      // AltGr is Ctrl+Alt on Windows keyboards that type @ and # that way.
      const altGr = resolveSketchHotkey(press("@", { ctrl: true, alt: true }), idle);
      assert(altGr?.kind === "type-value" && altGr.key === "@", "AltGr+Q (@) starts typing");
      assert(resolveSketchHotkey(press("@"), { ...idle, dynamicFieldCount: 0 }) === undefined, "with no typed-input fields showing, @ does nothing");
      assert(resolveSketchHotkey(press("-", { ctrl: true }), idle)?.kind !== "type-value", "Ctrl+minus is not typing");
      const help = sketchHotkeyHelp().find((entry) => /start typing the first value/u.test(entry.action));
      assert(help !== undefined && help.keys.includes("@") && help.keys.includes("#"), `the help sheet lists @ and #: ${help?.keys}`);
    }
  },
  {
    name: "Re-audit input N6: extra commas in a coordinate pair are an error, not a decimal comma; a semicolon separates pairs written with decimal commas",
    run: () => {
      for (const text of ["#1,2,3", "@1.5,2,5", "#1,2,3,4"]) {
        const parsed = parseCoordinatePair(text);
        assert(parsed !== undefined && !parsed.ok, `${text} is refused`);
        if (parsed !== undefined && !parsed.ok) assert(/one comma/u.test(parsed.message), `with a message that says why: ${parsed.message}`);
      }
      const decimalCommas = parseCoordinatePair("#1,5;2,5");
      assert(decimalCommas?.ok === true && Math.abs(decimalCommas.x - 1.5) < 1e-12 && Math.abs(decimalCommas.y - 2.5) < 1e-12, "#1,5;2,5 is (1.5, 2.5)");
      const plain = parseCoordinatePair("@12,5");
      assert(plain?.ok === true && plain.x === 12 && plain.y === 5 && plain.relative, "a plain pair still works");
      const thousands = parseFieldEntry("1,000.5", { id: "x", label: "X", unit: "mm", kind: "coordinate" });
      assert(!thousands.ok && /thousands comma/u.test(thousands.message) && !/comma belongs/u.test(thousands.message), `1,000.5 gets a plain explanation: ${thousands.ok ? "" : thousands.message}`);
      assert(Object.keys(fieldErrorsFor(dynamicFieldsFor("line", 0), { x: "#1,2,3" })).length === 1, "the field is marked while the text is typed");
    }
  },
  {
    name: "Re-audit input N7: a bare number in a typed field is in the document's unit, a unit overrides it, and 45° is an angle",
    run: () => {
      const inches = parseFieldEntry("2", lengthField, plainEvaluator, "in");
      assert(inches.ok && Math.abs(inches.value - 50.8) < 1e-9, `2 in an inch document is 50.8 mm (got ${inches.ok ? inches.value : inches.message})`);
      const mixed = parseFieldEntry("12 mm", lengthField, plainEvaluator, "in");
      assert(mixed.ok && Math.abs(mixed.value - 12) < 1e-9, "12 mm stays 12 mm in an inch document");
      const explicit = parseFieldEntry("0.5 in", lengthField, plainEvaluator, "mm");
      assert(explicit.ok && Math.abs(explicit.value - 12.7) < 1e-9, "0.5 in is 12.7 mm in a millimetre document");
      const millimetres = parseFieldEntry("2", lengthField);
      assert(millimetres.ok && millimetres.value === 2, "the default is still millimetres");
      const turn = parseFieldEntry("45°", angleField, plainEvaluator, "in");
      assert(turn.ok && Math.abs(turn.value - 45) < 1e-9, `45° is accepted in the Angle field (${turn.ok ? turn.value : turn.message})`);
      const bareAngle = parseFieldEntry("30", angleField, plainEvaluator, "in");
      assert(bareAngle.ok && bareAngle.value === 30, "a bare angle is degrees whatever the unit");
      // Through the whole entry: a 2 typed for the second point's length in an inch document places it 50.8 mm away.
      const fields = dynamicFieldsFor("line", 1);
      const entry = resolveDynamicEntry({ tool: "line", placed: [[0, 0]], cursor: [10, 0], fields, texts: { length: "2", angle: "0" }, unit: "in" });
      assert(entry.ok, `the entry resolves: ${entry.ok ? "" : entry.message}`);
      if (entry.ok) near(entry.point[0], 50.8, 1e-9, "the point is 2 inches along");
      const absolute = resolveDynamicEntry({ tool: "line", placed: [], cursor: [0, 0], fields: dynamicFieldsFor("line", 0), texts: { x: "#1,2" }, unit: "in" });
      assert(absolute.ok && Math.abs(absolute.point[0] - 25.4) < 1e-9 && Math.abs(absolute.point[1] - 50.8) < 1e-9, "#1,2 in an inch document is the point (1 in, 2 in)");
    }
  },
  {
    name: "Re-audit input N8: sampling a fit-point spline is linear in its points (64 points cost about four times 16, not sixteen)",
    run: () => {
      const small = Math.max(timeSampling(16, 200), 1e-4);
      const large = timeSampling(64, 200);
      const ratio = large / small;
      assert(ratio < 9, `64 points cost ${ratio.toFixed(1)} times 16 points (linear is 4, quadratic 16)`);
      assert(large < 1.5, `a 64-point spline samples in ${large.toFixed(3)} ms (was 0.7 ms)`);
      // The curve itself is unchanged: it passes through every fit point and a closed spline stays closed.
      const fit = splineFit(12);
      const samples = sampleSpline(fit, 8);
      assert(fit.every((point) => samples.some((sample) => Math.hypot(sample[0] - point[0], sample[1] - point[1]) < 1e-9)), "every fit point is on the sampled curve");
      const closed: Vec2[] = [[0, 0], [10, 5], [20, 0], [10, -5], [0, 0]];
      const ring = sampleSpline(closed, 8);
      near(Math.hypot(ring[0]![0] - ring.at(-1)![0], ring[0]![1] - ring.at(-1)![1]), 0, 1e-9, "a closed spline ends where it began");
    }
  },
  {
    name: "Re-audit input N9: the elliptical-arc and tangent-circle tools can be bound in the keymap, and every drawing tool has a command",
    run: () => {
      for (const id of ["tool:ellipse-arc", "tool:circle-tangent-3", "tool:circle-tangent-2"] as const) {
        assert(SKETCH_KEYMAP_COMMANDS.some((command) => command.id === id), `${id} is a keymap command`);
        const bound = rebindKey(DEFAULT_SKETCH_KEYMAP, id, "Shift+K");
        assert(bound.ok, `${id} can be given Shift+K: ${bound.ok ? "" : bound.reason}`);
        if (bound.ok) {
          const tool = id.slice(5) as "ellipse-arc";
          assert(sketchToolHotkeyChip(tool, bound.keymap) !== undefined, `${id} shows its key chip once bound`);
          const action = resolveSketchHotkey(press("K", { shift: true }), { ...idle, tool: "select", pendingPoints: 0, dynamicFieldCount: 0 }, bound.keymap);
          assert(action?.kind === "tool" && action.tool === tool, `${id} activates when its key is pressed`);
        }
      }
      // Every member of the SketchTool union (except select) is a keymap command, so none can be left reachable only from the ribbon.
      const comments = /\/\*[\s\S]*?\*\//gu;
      const read = (file: string): string => readFileSync(new URL(`../../packages/workbench-sketch/src/${file}`, import.meta.url), "utf8").replace(comments, "");
      const names = (text: string, type: string): string[] => [...(new RegExp(`export type ${type} =([\\s\\S]*?);`, "u").exec(text)?.[1] ?? "").matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]!);
      const members = [...names(read("index.ts"), "SketchTool"), ...names(read("curve-tools.ts"), "FixedCurveToolId"), ...names(read("curve-tools.ts"), "OpenCurveToolId")].filter((name) => name !== "select");
      assert(members.length > 25, `parsed the tool union (${members.length} members)`);
      const missing = members.filter((name) => !SKETCH_KEYMAP_COMMANDS.some((command) => command.id === `tool:${name}`));
      equal(JSON.stringify(missing), "[]", "every SketchTool has a keymap command");
    }
  }
];
