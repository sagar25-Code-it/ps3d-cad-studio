import { lengthFieldText, lengthTextFromDisplay, lengthTextToDisplay } from "../packages/workbench-sketch/src/unit-defaults.js";
import { equal, type TestCase } from "./test-kit.js";

/** Review: a length field in an inch document keeps what is half typed ("0." and "2.5" can be typed key by key). */

/** Types `keys` one at a time the way the sketch palette's Height field does: draft text kept, stored text converted to millimetres. */
function typeInto(keys: readonly string[], unit: "mm" | "in"): { readonly shown: string[]; readonly storedMm: string } {
  let draft: string | undefined;
  let stored = unit === "in" ? "25.4" : "10";
  let typed = lengthFieldText(draft, stored, unit);
  const shown: string[] = [];
  for (const key of keys) {
    typed = key === "<" ? typed.slice(0, -1) : `${typed}${key}`;
    draft = typed;
    stored = lengthTextFromDisplay(typed, unit);
    typed = lengthFieldText(draft, stored, unit);
    shown.push(typed);
  }
  return { shown, storedMm: stored };
}

export const lengthFieldDraftTests: readonly TestCase[] = [
  {
    name: "Typing 0.5 and 2.25 key by key in an inch document keeps the decimal point; the stored text is millimetres",
    run: () => {
      // Select-all then type: the field starts empty after the first key replaces it.
      const half = typeInto(["<", "<", "<", "0", ".", "5"], "in");
      equal(half.shown.slice(-3).join(" | "), "0 | 0. | 0.5", "the dot stays on screen after 0");
      equal(half.storedMm, "12.7", "0.5 in is 12.7 mm");
      const wide = typeInto(["<", "<", "<", "2", ".", "2", "5"], "in");
      equal(wide.shown.at(-1), "2.25", "2.25 can be typed");
      equal(wide.shown.at(-3), "2.", "the dot of 2. stays");
      equal(wide.storedMm, "57.15", "2.25 in is 57.15 mm");
    }
  },
  {
    name: "A field whose stored value changed from elsewhere shows the new value converted, a formula is shown as typed, and millimetres are untouched",
    run: () => {
      equal(lengthFieldText("0.5", "12.7", "in"), "0.5", "the draft still means the stored text, so it is shown as typed");
      equal(lengthFieldText("0.5", "25.4", "in"), "1", "another command set 25.4 mm: the stale draft is dropped and the stored value is shown in inches");
      equal(lengthFieldText(undefined, "25.4", "in"), "1", "no draft: the converted stored value");
      equal(lengthFieldText("plate_h / 2", "plate_h / 2", "in"), "plate_h / 2", "an expression stays as typed");
      equal(lengthFieldText("0.", "0", "mm"), "0", "in millimetres the stored text is already what is shown");
      equal(lengthFieldText("1.5", "1.5", "mm"), "1.5", "and a draft equal to it is shown");
      equal(lengthTextToDisplay("0", "in"), "0", "the old behaviour that ate the point: 0. stored as 0 is shown as 0");
    }
  },
];
