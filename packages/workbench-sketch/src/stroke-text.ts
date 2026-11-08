import { type SketchEntity, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import { badShape, dist, turn, type ShapeIds, type SketchShape } from "./curve-math.js";

/**
 * Sketch text in a small single-stroke font that lives in this file: no font files, no network. Each glyph is a few
 * strokes made of straight pieces and 3-point arcs on a grid 6 units tall (the cap height) and about 4 wide, so the
 * text comes out as ordinary line and arc entities. Because the font is one stroke per line (a skeleton, not an outline),
 * text is for engraving paths, labels and guides; only letters that happen to close on themselves (O, D, 0 ...) bound
 * a profile. Lowercase letters use the capital forms.
 *
 * Stroke syntax: `M x,y` starts a stroke, `L x,y` adds a straight piece, `A mx,my x,y` adds a 3-point arc through
 * (mx, my) to (x, y).
 */
export const GLYPH_CAP_HEIGHT = 6;
const GLYPH_GAP = 1.4;
const SPACE_ADVANCE = 3;

const ROUND_O = "M2,6 A4,3 2,0 A0,3 2,6";
const BOWL_P = "M0,0 L0,6 L2.4,6 A3.8,4.6 2.4,3.2 L0,3.2";

interface Glyph {
  readonly width: number;
  readonly strokes: string;
}

const GLYPHS: Readonly<Record<string, Glyph>> = {
  A: { width: 4, strokes: "M0,0 L2,6 L4,0 M0.7,2.2 L3.3,2.2" },
  B: { width: 4, strokes: "M0,0 L0,6 L2.4,6 A3.6,4.8 2.4,3.6 L0,3.6 M2.4,3.6 A3.9,1.8 2.4,0 L0,0" },
  C: { width: 4, strokes: "M4,4.8 A2,6 0,3 A2,0 4,1.2" },
  D: { width: 4, strokes: "M0,0 L0,6 L1.6,6 A4,3 1.6,0 L0,0" },
  E: { width: 4, strokes: "M4,6 L0,6 L0,0 L4,0 M0,3 L3,3" },
  F: { width: 4, strokes: "M4,6 L0,6 L0,0 M0,3 L3,3" },
  G: { width: 4, strokes: "M4,4.8 A2,6 0,3 A2,0 4,1.2 L4,3 L2.2,3" },
  H: { width: 4, strokes: "M0,0 L0,6 M4,0 L4,6 M0,3 L4,3" },
  I: { width: 2, strokes: "M1,0 L1,6 M0,0 L2,0 M0,6 L2,6" },
  J: { width: 4, strokes: "M4,6 L4,1.8 A2,0 0,1.8" },
  K: { width: 4, strokes: "M0,0 L0,6 M4,6 L0,2.5 M1.2,3.6 L4,0" },
  L: { width: 4, strokes: "M0,6 L0,0 L4,0" },
  M: { width: 4, strokes: "M0,0 L0,6 L2,2.5 L4,6 L4,0" },
  N: { width: 4, strokes: "M0,0 L0,6 L4,0 L4,6" },
  O: { width: 4, strokes: ROUND_O },
  P: { width: 4, strokes: BOWL_P },
  Q: { width: 4, strokes: `${ROUND_O} M2.4,1.6 L4,0` },
  R: { width: 4, strokes: `${BOWL_P} M1.8,3.2 L4,0` },
  S: { width: 4, strokes: "M3.9,4.9 A2,6 0.2,4.4 L3.8,1.6 A2,0 0.1,1.1" },
  T: { width: 4, strokes: "M0,6 L4,6 M2,6 L2,0" },
  U: { width: 4, strokes: "M0,6 L0,2 A2,0 4,2 L4,6" },
  V: { width: 4, strokes: "M0,6 L2,0 L4,6" },
  W: { width: 4, strokes: "M0,6 L1,0 L2,4 L3,0 L4,6" },
  X: { width: 4, strokes: "M0,0 L4,6 M0,6 L4,0" },
  Y: { width: 4, strokes: "M0,6 L2,3 L4,6 M2,3 L2,0" },
  Z: { width: 4, strokes: "M0,6 L4,6 L0,0 L4,0" },
  "0": { width: 4, strokes: "M2,6 A3.6,3 2,0 A0.4,3 2,6" },
  "1": { width: 3, strokes: "M0.6,4.8 L2,6 L2,0" },
  "2": { width: 4, strokes: "M0.2,4.6 A2,6 3.8,4.4 L0,0 L4,0" },
  "3": { width: 4, strokes: "M1.2,5.8 A3.3,4.6 1.9,3.2 A3.5,1.6 1.1,0.21" },
  "4": { width: 4, strokes: "M3,0 L3,6 L0,2 L4,2" },
  "5": { width: 4, strokes: "M3.8,6 L0.4,6 L0.2,3.4 A3.9,1.8 0.2,0.8" },
  "6": { width: 4, strokes: "M3.4,6 L0.4,1.6 A2,3.2 3.6,1.6 A2,0 0.4,1.6" },
  "7": { width: 4, strokes: "M0,6 L4,6 L1.5,0" },
  "8": { width: 4, strokes: "M0.6,4.6 A2,6 3.4,4.6 A2,3.2 0.6,4.6 M0.4,1.6 A2,3.2 3.6,1.6 A2,0 0.4,1.6" },
  "9": { width: 4, strokes: "M3.6,4.4 A2,6 0.4,4.4 A2,2.8 3.6,4.4 L0.6,0" },
  ".": { width: 0.6, strokes: "M0,0 L0.6,0 L0.6,0.6 L0,0.6 L0,0" },
  ",": { width: 1, strokes: "M0.6,0.6 L0.2,-1" },
  ":": { width: 0.6, strokes: "M0,0 L0.6,0 L0.6,0.6 L0,0.6 L0,0 M0,3 L0.6,3 L0.6,3.6 L0,3.6 L0,3" },
  "-": { width: 3, strokes: "M0,3 L3,3" },
  "_": { width: 4, strokes: "M0,-0.6 L4,-0.6" },
  "+": { width: 3.4, strokes: "M0,3 L3.4,3 M1.7,1.3 L1.7,4.7" },
  "=": { width: 3.4, strokes: "M0,2 L3.4,2 M0,4 L3.4,4" },
  "/": { width: 4, strokes: "M0,0 L4,6" },
  "(": { width: 1.6, strokes: "M1.6,6.5 A0.2,3 1.6,-0.5" },
  ")": { width: 1.6, strokes: "M0,6.5 A1.4,3 0,-0.5" },
  "!": { width: 1, strokes: "M0.5,6 L0.5,2 M0.2,0 L0.8,0 L0.8,0.6 L0.2,0.6 L0.2,0" },
  "?": { width: 4, strokes: "M0.2,5 A2,6.2 3.6,4.2 A2.4,3 2,2.4 L2,1.6 M1.7,0 L2.3,0 L2.3,0.6 L1.7,0.6 L1.7,0" },
  "'": { width: 0.6, strokes: "M0.3,6 L0.3,4.4" },
  // Engineering symbols. The degree sign is a small ring at cap height; the diameter sign is an O with a slash through it
  // (U+00D8 and U+2300 draw the same), so a label such as "Ø12" or "90°" can be engraved.
  "°": { width: 2, strokes: "M2,5 A1,6 0,5 A1,4 2,5" },
  "Ø": { width: 4, strokes: `${ROUND_O} M0.3,-0.3 L3.7,6.3` },
  "⌀": { width: 4, strokes: `${ROUND_O} M0.3,-0.3 L3.7,6.3` },
  "±": { width: 4, strokes: "M0.4,3.8 L3.6,3.8 M2,2.2 L2,5.4 M0.4,0.6 L3.6,0.6" },
  "×": { width: 4, strokes: "M0.4,1.4 L3.6,4.6 M0.4,4.6 L3.6,1.4" },
  "#": { width: 4, strokes: "M1.1,0 L1.7,6 M2.5,0 L3.1,6 M0,2 L4,2 M0,4 L4,4" },
  "%": { width: 4, strokes: "M0,0 L4,6 M1.6,5 A0.8,5.8 0,5 A0.8,4.2 1.6,5 M4,1 A3.2,1.8 2.4,1 A3.2,0.2 4,1" },
  "@": { width: 4, strokes: "M3,3 A2,4 1,3 A2,2 3,3 L3,2.2 L4,2.2 L4,3.6 A2,6 0,3 A2,0 3.6,0.4" },
  "*": { width: 4, strokes: "M2,1 L2,5 M0.3,2 L3.7,4 M0.3,4 L3.7,2" },
  "<": { width: 4, strokes: "M3.4,5 L0.6,3 L3.4,1" },
  ">": { width: 4, strokes: "M0.6,5 L3.4,3 L0.6,1" },
  "[": { width: 1.6, strokes: "M1.6,6.5 L0,6.5 L0,-0.5 L1.6,-0.5" },
  "]": { width: 1.6, strokes: "M0,6.5 L1.6,6.5 L1.6,-0.5 L0,-0.5" },
  "{": { width: 1.8, strokes: "M1.8,6.5 L1.2,6.5 L1.2,3.6 L0,3 L1.2,2.4 L1.2,-0.5 L1.8,-0.5" },
  "}": { width: 1.8, strokes: "M0,6.5 L0.6,6.5 L0.6,3.6 L1.8,3 L0.6,2.4 L0.6,-0.5 L0,-0.5" },
  "&": { width: 4, strokes: "M4,0 L1,4 A0.6,5.6 1.6,6 A2.6,5.6 2.2,4.6 L0.6,2.2 A0.2,0.8 1.6,0 A3.2,0.3 3.8,2.6" },
  "^": { width: 4, strokes: "M0.4,3.6 L2,6 L3.6,3.6" },
  "~": { width: 4, strokes: "M0,3 A1,4 2,3 A3,2 4,3" },
  "|": { width: 0.6, strokes: "M0.3,-0.5 L0.3,6.5" },
  "\\": { width: 4, strokes: "M0,6 L4,0" },
  "\"": { width: 1.8, strokes: "M0.3,6 L0.3,4.4 M1.5,6 L1.5,4.4" },
  "`": { width: 1, strokes: "M0.2,6 L0.8,4.8" },
  "$": { width: 4, strokes: "M3.9,4.9 A2,5.6 0.2,4.4 L3.8,1.6 A2,0.4 0.1,1.1 M2,-0.5 L2,6.5" },
  ";": { width: 1, strokes: "M0.6,0.6 L0.2,-1 M0.2,3 L0.8,3 L0.8,3.6 L0.2,3.6 L0.2,3" }
};

/** The punctuation and symbols the font draws, for the message that lists what is supported. */
const STROKE_FONT_SYMBOLS: string = Object.keys(GLYPHS).filter((character) => !/^[A-Z0-9]$/u.test(character)).join(" ");

/** The characters the font can draw (lowercase letters map to the capitals). */
export const STROKE_FONT_CHARACTERS: string = [...Object.keys(GLYPHS), " "].sort().join("");

export const TEXT_MAX_CHARACTERS = 40;
/** A sketch edit takes at most 200 new entities, so longer text could never be placed; the limit is that number. */
export const TEXT_MAX_ENTITIES = 200;

type Step = { readonly kind: "line"; readonly to: Vec2 } | { readonly kind: "arc"; readonly through: Vec2; readonly to: Vec2 };

/** Parses one glyph into strokes, each a start point and the steps that follow it. */
function parseStrokes(spec: string): readonly { readonly from: Vec2; readonly steps: readonly Step[] }[] {
  const strokes: { from: Vec2; steps: Step[] }[] = [];
  const pair = (token: string): Vec2 => {
    const [x, y] = token.split(",");
    return [Number(x), Number(y)];
  };
  const tokens = spec.split(/\s+/u).filter((token) => token !== "");
  for (let index = 0; index < tokens.length; index += 1) {
    const op = tokens[index]![0]!;
    const first = tokens[index]!.slice(1);
    if (op === "M") strokes.push({ from: pair(first), steps: [] });
    else if (op === "L") strokes[strokes.length - 1]!.steps.push({ kind: "line", to: pair(first) });
    else if (op === "A") {
      const to = pair(tokens[index + 1]!);
      strokes[strokes.length - 1]!.steps.push({ kind: "arc", through: pair(first), to });
      index += 1;
    }
  }
  return strokes;
}

/** Width of a character in font units, or undefined when the font has no such character. */
export function glyphWidthUnits(character: string): number | undefined {
  if (character === " ") return SPACE_ADVANCE;
  return GLYPHS[character.toUpperCase()]?.width;
}

/** Characters in `text` that the font cannot draw. */
export function unsupportedTextCharacters(text: string): readonly string[] {
  return [...new Set([...text].filter((character) => glyphWidthUnits(character) === undefined))];
}

export interface SketchTextOptions {
  readonly heightMm: number;
  /** Counter-clockwise rotation about the origin point. */
  readonly rotationDeg?: number;
  /** Multiplies the gap between letters (1 is the default). */
  readonly spacing?: number;
}

/**
 * Lays `text` out from `origin` (the left end of the baseline) as line and arc entities. `heightMm` is the height of a
 * capital letter. Spaces advance the pen without drawing.
 */
export function buildSketchText(origin: Vec2, text: string, options: SketchTextOptions, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed === "") return badShape("Type some text first.", "Type the text in the Sketch palette, then click where it should start.");
  if ([...trimmed].length > TEXT_MAX_CHARACTERS) return badShape(`Sketch text takes at most ${TEXT_MAX_CHARACTERS} characters.`);
  const missing = unsupportedTextCharacters(trimmed);
  if (missing.length > 0) return badShape(`The built-in font cannot draw ${missing.map((character) => `"${character}"`).join(", ")}. It has letters, digits and ${STROKE_FONT_SYMBOLS}`, "Remove those characters.");
  const { heightMm } = options;
  if (!Number.isFinite(heightMm) || heightMm < 0.5 || heightMm > 1_000) return badShape("Text height must be between 0.5 mm and 1000 mm.");
  if (options.rotationDeg !== undefined && !Number.isFinite(options.rotationDeg)) return badShape("Text rotation must be a number of degrees.", "Type the rotation as a number, for example 0 or 90.");
  if (options.spacing !== undefined && !Number.isFinite(options.spacing)) return badShape("Text letter spacing must be a number.", "Type the spacing as a number, for example 1.");
  if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) return badShape("The text start point is not a finite position.");
  const unit = heightMm / GLYPH_CAP_HEIGHT;
  const radians = ((options.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const gap = GLYPH_GAP * Math.max(0, options.spacing ?? 1);
  const place = (point: Vec2, pen: number): Vec2 => {
    const x = (point[0] + pen) * unit;
    const y = point[1] * unit;
    return [origin[0] + x * cos - y * sin, origin[1] + x * sin + y * cos];
  };
  const entities: SketchEntity[] = [];
  let pen = 0;
  for (const character of trimmed) {
    const glyph = character === " " ? undefined : GLYPHS[character.toUpperCase()];
    if (glyph !== undefined) {
      for (const stroke of parseStrokes(glyph.strokes)) {
        let current = stroke.from;
        for (const step of stroke.steps) {
          const start = place(current, pen);
          const end = place(step.to, pen);
          if (step.kind === "arc") {
            const mid = place(step.through, pen);
            if (Math.abs(turn(start, mid, end)) >= 1e-3) entities.push({ id: ids.entity(), kind: "arc", start, mid, end, construction: false });
            else if (dist(start, end) >= 0.01) entities.push({ id: ids.entity(), kind: "line", start, end, construction: false });
          } else if (dist(start, end) >= 0.01) {
            entities.push({ id: ids.entity(), kind: "line", start, end, construction: false });
          }
          current = step.to;
        }
      }
    }
    pen += (character === " " ? SPACE_ADVANCE : glyph!.width) + gap;
  }
  if (entities.length === 0) return badShape("Nothing to draw: the text is too small for its strokes to be at least 0.01 mm long.");
  if (entities.length > TEXT_MAX_ENTITIES) return badShape(`This text would need ${entities.length} curves; at most ${TEXT_MAX_ENTITIES} are allowed. Use fewer characters.`);
  return { ok: true, value: { entities, constraints: [] } };
}
