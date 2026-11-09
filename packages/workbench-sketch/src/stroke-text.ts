import { SKETCH_TEXT_MAX_ENTITIES, type SketchEntity, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import { badShape, dist, turn, type ShapeIds, type SketchShape } from "./curve-math.js";

/**
 * Sketch text in a small single-stroke font that lives in this file: no font files, no network. Each glyph is a few
 * strokes made of straight pieces and 3-point arcs on a grid 6 units tall (the cap height) and about 4 wide, so the
 * text comes out as ordinary line and arc entities. Because the font is one stroke per line (a skeleton, not an outline),
 * text is for engraving paths, labels and guides; only letters that happen to close on themselves (O, D, o, 0 ...) bound
 * a profile.
 *
 * The font has capitals, true lowercase (x-height 4, ascenders to 6, descenders to -2), digits, the punctuation of
 * drawings, the engineering symbols (diameter, degree, plus-minus, micro, #, %, &, @, brackets, comparison signs) and the
 * Greek letters used in drawings and formulas.
 *
 * Stroke syntax: `M x,y` starts a stroke, `L x,y` adds a straight piece, `A mx,my x,y` adds a 3-point arc through
 * (mx, my) to (x, y).
 */
export const GLYPH_CAP_HEIGHT = 6;
const GLYPH_GAP = 1.4;
const SPACE_ADVANCE = 3;

const ROUND_O = "M2,6 A4,3 2,0 A0,3 2,6";
const BOWL_P = "M0,0 L0,6 L2.4,6 A3.8,4.6 2.4,3.2 L0,3.2";
const SMALL_O = "M2,4 A4,2 2,0 A0,2 2,4";
const SMALL_BOWL_RIGHT = "M4,2 A2,4 0,2 A2,0 4,2";
const SMALL_BOWL_LEFT = "M0,2 A2,4 4,2 A2,0 0,2";

interface Glyph {
  readonly width: number;
  readonly strokes: string;
}

const GLYPHS: Readonly<Record<string, Glyph>> = {
  // ---- capitals
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
  // ---- lowercase
  a: { width: 4, strokes: `${SMALL_BOWL_RIGHT} M4,4 L4,0` },
  b: { width: 4, strokes: `${SMALL_BOWL_LEFT} M0,6 L0,0` },
  c: { width: 3.6, strokes: "M3.6,3.2 A1.8,4 0,2 A1.8,0 3.6,0.8" },
  d: { width: 4, strokes: `${SMALL_BOWL_RIGHT} M4,6 L4,0` },
  e: { width: 4, strokes: "M0,2 L4,2 A2,4 0,2 A2,0 3.8,0.6" },
  f: { width: 3.4, strokes: "M1,0 L1,5 A2.2,6 3.4,5.6 M0,4 L2.6,4" },
  g: { width: 4, strokes: `${SMALL_BOWL_RIGHT} M4,4 L4,-1 A2,-2 0.4,-1.2` },
  h: { width: 4, strokes: "M0,6 L0,0 M0,2.8 A2,4.2 4,2.8 L4,0" },
  i: { width: 1, strokes: "M0.5,0 L0.5,4 M0.2,5.4 L0.8,5.4 L0.8,6 L0.2,6 L0.2,5.4" },
  j: { width: 2.3, strokes: "M2,4 L2,-1 A0.9,-2 0,-1.2 M1.7,5.4 L2.3,5.4 L2.3,6 L1.7,6 L1.7,5.4" },
  k: { width: 4, strokes: "M0,6 L0,0 M3.6,4 L0,1.8 M1.2,2.6 L3.8,0" },
  l: { width: 1, strokes: "M0.5,6 L0.5,0" },
  m: { width: 5, strokes: "M0,4 L0,0 M0,2.8 A1.2,4.2 2.5,2.8 L2.5,0 M2.5,2.8 A3.7,4.2 5,2.8 L5,0" },
  n: { width: 4, strokes: "M0,4 L0,0 M0,2.8 A2,4.2 4,2.8 L4,0" },
  o: { width: 4, strokes: SMALL_O },
  p: { width: 4, strokes: `${SMALL_BOWL_LEFT} M0,4 L0,-2` },
  q: { width: 4, strokes: `${SMALL_BOWL_RIGHT} M4,4 L4,-2` },
  r: { width: 3, strokes: "M0,4 L0,0 M0,2.4 A1,3.8 2.8,3.8" },
  s: { width: 3.8, strokes: "M3.7,3.4 A1.9,4 0.2,3 L3.6,1.1 A1.9,0 0.1,0.7" },
  t: { width: 3.4, strokes: "M1.4,6 L1.4,0.8 A2.4,0 3.4,0.6 M0,4 L3,4" },
  u: { width: 4, strokes: "M0,4 L0,1.6 A2,0 4,1.6 M4,4 L4,0" },
  v: { width: 4, strokes: "M0,4 L2,0 L4,4" },
  w: { width: 5, strokes: "M0,4 L1,0 L2.5,3 L4,0 L5,4" },
  x: { width: 4, strokes: "M0,4 L4,0 M0,0 L4,4" },
  y: { width: 4, strokes: "M0,4 L2,0 M4,4 L1.6,-2" },
  z: { width: 4, strokes: "M0,4 L4,4 L0,0 L4,0" },
  // ---- digits
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
  // ---- punctuation and operators
  ".": { width: 0.6, strokes: "M0,0 L0.6,0 L0.6,0.6 L0,0.6 L0,0" },
  ",": { width: 1, strokes: "M0.6,0.6 L0.2,-1" },
  ":": { width: 0.6, strokes: "M0,0 L0.6,0 L0.6,0.6 L0,0.6 L0,0 M0,3 L0.6,3 L0.6,3.6 L0,3.6 L0,3" },
  ";": { width: 1, strokes: "M0.6,0.6 L0.2,-1 M0.2,3 L0.8,3 L0.8,3.6 L0.2,3.6 L0.2,3" },
  "-": { width: 3, strokes: "M0,3 L3,3" },
  "_": { width: 4, strokes: "M0,-0.6 L4,-0.6" },
  "+": { width: 3.4, strokes: "M0,3 L3.4,3 M1.7,1.3 L1.7,4.7" },
  "=": { width: 3.4, strokes: "M0,2 L3.4,2 M0,4 L3.4,4" },
  "/": { width: 4, strokes: "M0,0 L4,6" },
  "\\": { width: 4, strokes: "M0,6 L4,0" },
  "|": { width: 1, strokes: "M0.5,6.6 L0.5,-1.4" },
  "(": { width: 1.6, strokes: "M1.6,6.5 A0.2,3 1.6,-0.5" },
  ")": { width: 1.6, strokes: "M0,6.5 A1.4,3 0,-0.5" },
  "[": { width: 1.8, strokes: "M1.8,6.5 L0,6.5 L0,-0.5 L1.8,-0.5" },
  "]": { width: 1.8, strokes: "M0,6.5 L1.8,6.5 L1.8,-0.5 L0,-0.5" },
  "{": { width: 2.4, strokes: "M2.4,6.5 L1.8,6.5 L1.2,5.9 L1.2,3.8 L0.2,3 L1.2,2.2 L1.2,0.1 L1.8,-0.5 L2.4,-0.5" },
  "}": { width: 2.4, strokes: "M0,6.5 L0.6,6.5 L1.2,5.9 L1.2,3.8 L2.2,3 L1.2,2.2 L1.2,0.1 L0.6,-0.5 L0,-0.5" },
  "<": { width: 3.4, strokes: "M3.4,5 L0,3 L3.4,1" },
  ">": { width: 3.4, strokes: "M0,5 L3.4,3 L0,1" },
  "!": { width: 1, strokes: "M0.5,6 L0.5,2 M0.2,0 L0.8,0 L0.8,0.6 L0.2,0.6 L0.2,0" },
  "?": { width: 4, strokes: "M0.2,5 A2,6.2 3.6,4.2 A2.4,3 2,2.4 L2,1.6 M1.7,0 L2.3,0 L2.3,0.6 L1.7,0.6 L1.7,0" },
  "'": { width: 0.6, strokes: "M0.3,6 L0.3,4.4" },
  "\"": { width: 2, strokes: "M0.4,6 L0.4,4.4 M1.6,6 L1.6,4.4" },
  "*": { width: 3, strokes: "M1.5,5.4 L1.5,1.8 M0,4.5 L3,2.7 M0,2.7 L3,4.5" },
  "^": { width: 3.2, strokes: "M0,3.6 L1.6,6 L3.2,3.6" },
  "~": { width: 4, strokes: "M0,2.6 A1,3.6 2,3 A3,2.4 4,3.4" },
  "`": { width: 1, strokes: "M0.2,6 L0.8,4.8" },
  "$": { width: 4, strokes: "M3.9,4.9 A2,5.6 0.2,4.4 L3.8,1.6 A2,0.4 0.1,1.1 M2,-0.5 L2,6.5" },
  "#": { width: 4.4, strokes: "M1.2,0 L1.8,6 M3,0 L3.6,6 M0,2 L4.4,2 M0,4 L4.4,4" },
  "%": { width: 4, strokes: "M0,0 L4,6 M1.1,5.8 A1.8,5.1 1.1,4.4 A0.4,5.1 1.1,5.8 M2.9,1.6 A3.6,0.9 2.9,0.2 A2.2,0.9 2.9,1.6" },
  "&": { width: 4, strokes: "M3.8,0 L0.8,4 A1,5.6 2,6 A3.2,5.6 2.8,4.4 L0.6,1.6 A0.9,0.2 2,0 A3.2,0.9 3.8,2.2" },
  "@": { width: 5.2, strokes: "M3.6,2.6 A2.4,3.8 1.2,2.6 A2.4,1.4 3.6,2.6 M3.6,3.8 L3.6,1.6 A4.4,1.2 5,2.2 M5,2.2 A5.2,5 2.6,6.2 A0,3 2.6,-0.2" },
  // ---- engineering symbols
  "Ø": { width: 4, strokes: `${ROUND_O} M0.3,-0.3 L3.7,6.3` },
  "°": { width: 2, strokes: "M1,6 A2,5 1,4 A0,5 1,6" },
  "±": { width: 3.4, strokes: "M1.7,2.6 L1.7,5.6 M0.2,4.1 L3.2,4.1 M0.2,0.6 L3.2,0.6" },
  "µ": { width: 4, strokes: "M0,4 L0,-2 M0,1.6 A2,0 4,1.6 M4,4 L4,0.2" },
  "²": { width: 1.8, strokes: "M0,5.6 A0.9,6.6 1.8,5.6 L0,3.8 L1.8,3.8" },
  "³": { width: 1.8, strokes: "M0,6.2 L1.6,6.2 L0.7,5.2 A1.9,4.9 1.6,4.1 A0.9,3.5 0,3.8" },
  "×": { width: 3.6, strokes: "M0.4,4.6 L3.2,1.4 M0.4,1.4 L3.2,4.6" },
  "≤": { width: 3.4, strokes: "M3.4,5.6 L0,4 L3.4,2.4 M0,1 L3.4,1" },
  "≥": { width: 3.4, strokes: "M0,5.6 L3.4,4 L0,2.4 M0,1 L3.4,1" },
  // ---- Greek capitals
  "Γ": { width: 4, strokes: "M0,0 L0,6 L4,6" },
  "Δ": { width: 4, strokes: "M0,0 L2,6 L4,0 L0,0" },
  "Θ": { width: 4, strokes: `${ROUND_O} M1,3 L3,3` },
  "Λ": { width: 4, strokes: "M0,0 L2,6 L4,0" },
  "Π": { width: 4, strokes: "M0,0 L0,6 L4,6 L4,0" },
  "Σ": { width: 4, strokes: "M4,6 L0,6 L2,3 L0,0 L4,0" },
  "Φ": { width: 4, strokes: `${ROUND_O} M2,-0.5 L2,6.5` },
  "Ψ": { width: 4, strokes: "M2,0 L2,6 M0,6 L0,3.5 A2,1.5 4,3.5 L4,6" },
  "Ω": { width: 4, strokes: "M0.4,0 L1.6,0 A0,3 2,6 A4,3 2.4,0 L3.6,0" },
  // ---- Greek lowercase
  "α": { width: 4, strokes: "M3.8,3.6 A2,4.2 0.2,2 A2,-0.2 3.2,1.2 L4,0" },
  "β": { width: 4, strokes: "M0,-2 L0,4.4 A1.8,6.2 3.4,4.6 A3.4,3.2 1.2,3.2 M1.2,3.2 A4.2,2.4 3.4,0.8 A1.8,-0.2 0,0.8" },
  "γ": { width: 4, strokes: "M0,4 L2,0.4 L4,4 M2,0.4 L2,-2" },
  "δ": { width: 4, strokes: "M2,3.8 A4,1.9 2,0 A0,1.9 2,3.8 M2,3.8 A1.4,5.2 3.2,6" },
  "ε": { width: 3.6, strokes: "M3.6,3.6 A1.8,4 0.4,2 A1.8,0 3.6,0.4 M0.4,2 L2.6,2" },
  "η": { width: 4, strokes: "M0,4 L0,0 M0,2.4 A2,4.2 4,2.4 L4,-2" },
  "θ": { width: 4, strokes: `${ROUND_O} M1,3 L3,3` },
  "λ": { width: 4, strokes: "M0,6 L3.8,0 M2,3.6 L0.2,0" },
  "π": { width: 4, strokes: "M0,4 L4,4 M1,4 L1,0 M3,4 L3,0" },
  "ρ": { width: 4, strokes: "M0,-2 L0,2.2 A2,4 4,2 A2,0 0,2.2" },
  "σ": { width: 4.4, strokes: `${SMALL_O} M2,4 L4.4,4` },
  "τ": { width: 4, strokes: "M0,4 L4,4 M2,4 L2,1 A2.5,0.2 3.4,0.5" },
  "φ": { width: 4, strokes: `${SMALL_O} M2,-2 L2,6` },
  "ω": { width: 4, strokes: "M0,4 L0,1.6 A1,0 2,1.6 A3,0 4,1.6 L4,4 M2,1.6 L2,3.4" }
};

/** Other code points that draw the same as a glyph above. */
const ALIASES: Readonly<Record<string, string>> = {
  "ø": "Ø",
  "⌀": "Ø",
  "∅": "Ø",
  "μ": "µ",
  "Ω": "Ω",
  "∆": "Δ",
  "’": "'",
  "‘": "'",
  "–": "-",
  "—": "-",
  "−": "-",
  "“": "\"",
  "”": "\"",
  "·": ".",
  "•": "."
};

function glyphOf(character: string): Glyph | undefined {
  return GLYPHS[ALIASES[character] ?? character];
}

/** The characters the font can draw. */
export const STROKE_FONT_CHARACTERS: string = [...Object.keys(GLYPHS), ...Object.keys(ALIASES), " "].sort().join("");

export const TEXT_MAX_CHARACTERS = 40;
/** A text is limited to the curves one text object can record (400; a sketch holds 500 in all, and one edit may add as many), so one piece of text cannot crowd out the rest of the drawing. */
export const TEXT_MAX_ENTITIES = SKETCH_TEXT_MAX_ENTITIES;
export const TEXT_MIN_HEIGHT_MM = 0.5;
export const TEXT_MAX_HEIGHT_MM = 1_000;

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
  return glyphOf(character)?.width;
}

/** The raw strokes of a glyph (for tests and previews). */
export function glyphStrokes(character: string): string | undefined {
  return glyphOf(character)?.strokes;
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
  /** Stretches the letters sideways (1 is the normal proportion, 0.2 to 5). */
  readonly widthFactor?: number;
  /** Which end of the text sits on the origin (left by default). */
  readonly align?: "left" | "center" | "right";
  /** Draw the curves as construction geometry. */
  readonly construction?: boolean;
}

export const DEFAULT_TEXT_LAYOUT = { widthFactor: 1, spacing: 1, align: "left" as const, rotationDeg: 0 };

/** Why the layout options are unusable, or undefined when they are fine. Shared by the builder, the UI and the tests. */
export function textOptionProblem(options: SketchTextOptions): string | undefined {
  const { heightMm } = options;
  if (typeof heightMm !== "number" || !Number.isFinite(heightMm) || heightMm < TEXT_MIN_HEIGHT_MM || heightMm > TEXT_MAX_HEIGHT_MM) return `Text height must be a number between ${TEXT_MIN_HEIGHT_MM} mm and ${TEXT_MAX_HEIGHT_MM} mm.`;
  const rotation = options.rotationDeg ?? 0;
  if (typeof rotation !== "number" || !Number.isFinite(rotation) || Math.abs(rotation) > 360) return "Text rotation (its angle) must be a number between -360 and 360 degrees.";
  const spacing = options.spacing ?? 1;
  if (typeof spacing !== "number" || !Number.isFinite(spacing) || spacing < 0 || spacing > 10) return "Letter spacing must be a number between 0 and 10.";
  const width = options.widthFactor ?? 1;
  if (typeof width !== "number" || !Number.isFinite(width) || width < 0.2 || width > 5) return "Text width must be a number between 0.2 and 5 times the normal width.";
  const align = options.align ?? "left";
  if (align !== "left" && align !== "center" && align !== "right") return "Text alignment must be left, center or right.";
  return undefined;
}

/** How wide a text is, in millimetres, before rotation: the pen travel of the string without the trailing gap. */
export function textWidthMm(text: string, options: SketchTextOptions): number {
  const unit = options.heightMm / GLYPH_CAP_HEIGHT;
  const gap = GLYPH_GAP * Math.max(0, options.spacing ?? 1);
  let pen = 0;
  const characters = [...text.replace(/\s+$/u, "")];
  characters.forEach((character, index) => {
    pen += (glyphWidthUnits(character) ?? 0) + (index === characters.length - 1 ? 0 : gap);
  });
  return pen * unit * (options.widthFactor ?? 1);
}

/**
 * Lays `text` out from `origin` (the left end, the middle or the right end of the baseline, as `align` says) as line and arc
 * entities. `heightMm` is the height of a capital letter. Spaces advance the pen without drawing.
 */
export function buildSketchText(origin: Vec2, text: string, options: SketchTextOptions, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed === "") return badShape("Type some text first.", "Type the text in the Sketch palette, then click where it should start.");
  if ([...trimmed].length > TEXT_MAX_CHARACTERS) return badShape(`Sketch text takes at most ${TEXT_MAX_CHARACTERS} characters.`);
  if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) return badShape("The text position is not a number.", "Click a point in the sketch.");
  const missing = unsupportedTextCharacters(trimmed);
  if (missing.length > 0) return badShape(`The built-in font cannot draw ${missing.map((character) => `"${character}"`).join(", ")}. It has letters (with lowercase), digits, Greek letters, the symbols Ø ° ± µ # % & @ ( ) [ ] { } < > $ and common punctuation.`, "Remove those characters.");
  const problem = textOptionProblem(options);
  if (problem !== undefined) return badShape(problem, "Fix the value in the Sketch palette.");
  const unit = options.heightMm / GLYPH_CAP_HEIGHT;
  const stretch = options.widthFactor ?? 1;
  const radians = ((options.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const gap = GLYPH_GAP * Math.max(0, options.spacing ?? 1);
  const align = options.align ?? "left";
  const totalWidth = textWidthMm(trimmed, options);
  const shift = align === "center" ? -totalWidth / 2 : align === "right" ? -totalWidth : 0;
  const place = (point: Vec2, pen: number): Vec2 => {
    const x = (point[0] + pen) * unit * stretch + shift;
    const y = point[1] * unit;
    return [origin[0] + x * cos - y * sin, origin[1] + x * sin + y * cos];
  };
  const construction = options.construction === true;
  const entities: SketchEntity[] = [];
  let pen = 0;
  for (const character of trimmed) {
    const glyph = character === " " ? undefined : glyphOf(character);
    if (glyph !== undefined) {
      for (const stroke of parseStrokes(glyph.strokes)) {
        let current = stroke.from;
        for (const step of stroke.steps) {
          const start = place(current, pen);
          const end = place(step.to, pen);
          if (step.kind === "arc") {
            const mid = place(step.through, pen);
            if (Math.abs(turn(start, mid, end)) >= 1e-3) entities.push({ id: ids.entity(), kind: "arc", start, mid, end, construction });
            else if (dist(start, end) >= 0.01) entities.push({ id: ids.entity(), kind: "line", start, end, construction });
          } else if (dist(start, end) >= 0.01) {
            entities.push({ id: ids.entity(), kind: "line", start, end, construction });
          }
          current = step.to;
        }
      }
    }
    pen += (character === " " ? SPACE_ADVANCE : glyph!.width) + gap;
  }
  if (entities.length === 0) return badShape("Nothing to draw: the text is too small for its strokes to be at least 0.01 mm long.");
  if (entities.length > TEXT_MAX_ENTITIES) return badShape(`This text would need ${entities.length} curves; one piece of text takes at most ${TEXT_MAX_ENTITIES}. Use fewer characters, or place the text in two pieces.`);
  return { ok: true, value: { entities, constraints: [] } };
}
