import type { Vec2 } from "../../workbench-core/src/index.js";
import type { ArcSweepTrack } from "./arc-sweep.js";
import type { InferenceGuide } from "./inference.js";
import type { SketchTool } from "./index.js";

/**
 * Dynamic input: while a drawing tool is active the canvas shows editable fields next to the cursor. Before the first point
 * they are the X and Y of that point; after it they are what the next point needs (length and angle for a line, width and
 * height for a rectangle, a radius for a circle, a sweep for a centerpoint arc ...). Typing into a field locks that value;
 * the fields you have not typed in keep following the pointer. Enter places the point with the typed values.
 *
 * The maths lives here, free of any UI, so it can be tested. Parsing what was typed (units, expressions, @ and # prefixes)
 * is in dynamic-entry.ts.
 */
export type DynamicFieldId = "x" | "y" | "length" | "angle" | "width" | "height" | "radius" | "diameter" | "major" | "minor" | "sweep";

export interface DynamicField {
  readonly id: DynamicFieldId;
  readonly label: string;
  readonly unit: "mm" | "°";
  /** What the number means: a size or distance, an angle in degrees, or a coordinate (which may be negative). */
  readonly kind: "length" | "angle" | "coordinate";
}

export type DynamicValues = Partial<Record<DynamicFieldId, number>>;

const field = (id: DynamicFieldId, label: string, kind: DynamicField["kind"]): DynamicField => ({ id, label, unit: kind === "angle" ? "°" : "mm", kind });

const FIELD = {
  x: field("x", "X", "coordinate"),
  y: field("y", "Y", "coordinate"),
  length: field("length", "Length", "length"),
  angle: field("angle", "Angle", "angle"),
  width: field("width", "Width", "length"),
  height: field("height", "Height", "length"),
  radius: field("radius", "Radius", "length"),
  diameter: field("diameter", "Diameter", "length"),
  major: field("major", "Major radius", "length"),
  minor: field("minor", "Minor radius", "length"),
  sweep: field("sweep", "Sweep", "angle"),
  circumradius: field("radius", "Circumradius", "length"),
  halfLength: field("length", "Half length", "length"),
  overall: field("length", "Overall length", "length")
} as const;

/** How a tool reads its typed fields for the point it is about to place. */
type Mode =
  | { readonly kind: "absolute" }
  /** A distance and a direction from an already placed point (`baseIndex`). Either field may be missing: a circle has no angle field, a tangent direction has no length. */
  | { readonly kind: "polar"; readonly baseIndex: number; readonly length: DynamicField | undefined; readonly angle: boolean }
  | { readonly kind: "box"; readonly centred: boolean }
  /** A signed sweep about placed[0], starting at placed[1]. */
  | { readonly kind: "sweep" }
  /** The third point of a circle or arc through the first two, found from a radius. */
  | { readonly kind: "circumradius" }
  /** A point off the axis placed[0]-placed[1], out of placed[1], at `factor` times the typed distance. */
  | { readonly kind: "offset"; readonly field: DynamicField; readonly factor: number };

/** `length` of null means "no length field" (a direction only); the default is the plain Length field. */
const polar = (baseIndex: number, length: DynamicField | null = FIELD.length, angle = true): Mode => ({ kind: "polar", baseIndex, length: length ?? undefined, angle });

/** Tools that have no typed absolute first point (their first click picks existing geometry). */
const NO_ABSOLUTE_FIRST: ReadonlySet<SketchTool> = new Set<SketchTool>(["blend"]);

function modeFor(tool: SketchTool, placedPoints: number): Mode | undefined {
  if (tool === "select") return undefined;
  if (placedPoints < 1) return NO_ABSOLUTE_FIRST.has(tool) ? undefined : { kind: "absolute" };
  const last = placedPoints - 1;
  switch (tool) {
    case "line":
    case "centerline":
    case "spline":
    case "spline-control":
    case "profile":
    case "parabola":
    case "hyperbola":
    case "conic":
    case "conic-five":
    case "slot-arc-three-point":
    case "slot-arc-center":
    case "parallelogram": return placedPoints <= 24 ? polar(last) : undefined;
    case "line-midpoint": return placedPoints === 1 ? polar(0, FIELD.halfLength) : undefined;
    case "rectangle":
    case "rectangle-rounded": return placedPoints === 1 ? { kind: "box", centred: false } : undefined;
    case "rectangle-center": return placedPoints === 1 ? { kind: "box", centred: true } : undefined;
    // A 3-point rectangle takes its first edge like a line, then a height.
    case "rectangle-three-point": return placedPoints === 1 ? polar(0) : placedPoints === 2 ? { kind: "offset", field: FIELD.height, factor: 1 } : undefined;
    case "circle": return placedPoints === 1 ? polar(0, FIELD.radius, false) : undefined;
    case "circle-two-point": return placedPoints === 1 ? polar(0, FIELD.diameter, false) : undefined;
    case "circle-three-point":
    case "arc": return placedPoints === 1 ? polar(0) : placedPoints === 2 ? { kind: "circumradius" } : undefined;
    case "ellipse": return placedPoints === 1 ? polar(0, FIELD.major) : placedPoints === 2 ? { kind: "offset", field: FIELD.minor, factor: 1 } : undefined;
    case "arc-center": return placedPoints === 1 ? polar(0, FIELD.radius) : placedPoints === 2 ? { kind: "sweep" } : undefined;
    case "arc-tangent": return placedPoints === 1 ? polar(0, null) : placedPoints === 2 ? polar(0) : undefined;
    case "polygon": return placedPoints === 1 ? polar(0, FIELD.circumradius) : undefined;
    case "slot": return placedPoints === 1 ? polar(0) : placedPoints === 2 ? { kind: "offset", field: FIELD.width, factor: 0.5 } : undefined;
    case "slot-straight": return placedPoints === 1 ? polar(0, FIELD.overall) : placedPoints === 2 ? { kind: "offset", field: FIELD.width, factor: 0.5 } : undefined;
    default: return undefined;
  }
}

function fieldsOfMode(mode: Mode | undefined): readonly DynamicField[] {
  if (mode === undefined) return [];
  switch (mode.kind) {
    case "absolute": return [FIELD.x, FIELD.y];
    case "polar": return [...(mode.length === undefined ? [] : [mode.length]), ...(mode.angle ? [FIELD.angle] : [])];
    case "box": return [FIELD.width, FIELD.height];
    case "sweep": return [FIELD.sweep];
    case "circumradius": return [FIELD.circumradius];
    case "offset": return [mode.field];
  }
}

/**
 * The fields a tool offers for the point it is about to place, or none when typed input does not apply. With no point placed
 * yet the fields are the absolute X and Y of the first point.
 */
export function dynamicFieldsFor(tool: SketchTool, placedPoints: number): readonly DynamicField[] {
  return fieldsOfMode(modeFor(tool, placedPoints));
}

const toDegrees = (radians: number): number => {
  const degrees = (radians * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};

/** Removes the floating-point dust a typed number picks up on its way through trigonometry (3e-16 becomes 0). */
export function cleanNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1e6) return value;
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

/** An angle in degrees brought into [0, 360), with the exact multiples of 90 kept exact. */
export function normalizeAngleDeg(angleDeg: number): number {
  const wrapped = ((angleDeg % 360) + 360) % 360;
  const cleaned = cleanNumber(wrapped);
  return cleaned >= 360 ? 0 : cleaned;
}

function polarPoint(base: Vec2, length: number, angleDeg: number): Vec2 {
  const angle = normalizeAngleDeg(angleDeg);
  let cos: number;
  let sin: number;
  if (angle === 0) { cos = 1; sin = 0; }
  else if (angle === 90) { cos = 0; sin = 1; }
  else if (angle === 180) { cos = -1; sin = 0; }
  else if (angle === 270) { cos = 0; sin = -1; }
  else { cos = Math.cos((angle * Math.PI) / 180); sin = Math.sin((angle * Math.PI) / 180); }
  return [cleanNumber(base[0] + length * cos), cleanNumber(base[1] + length * sin)];
}

function unit(from: Vec2, to: Vec2): Vec2 {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return length < 1e-12 ? [1, 0] : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

function circumcircleOf(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radius: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  ];
  return { center, radius: Math.hypot(center[0] - a[0], center[1] - a[1]) };
}

/** Signed angle in (-180, 180] from direction `from` to direction `to`, both about `center`. */
function signedSweepDeg(center: Vec2, from: Vec2, to: Vec2): number {
  let sweep = Math.atan2(to[1] - center[1], to[0] - center[0]) - Math.atan2(from[1] - center[1], from[0] - center[0]);
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  return (sweep * 180) / Math.PI;
}

/**
 * The field values the cursor currently implies; these are what the inputs display until the user types.
 * A centerpoint arc's sweep follows the pointer's path when its `sweepTrack` is given (the canvas keeps one), so the field reads 270 while the
 * preview arc runs 270 degrees instead of the short way round (-90); without a track it is the shortest signed sweep.
 */
export function measureFromCursor(tool: SketchTool, placed: readonly Vec2[], cursor: Vec2, sweepTrack?: ArcSweepTrack): DynamicValues {
  const mode = modeFor(tool, placed.length);
  if (mode === undefined) return {};
  switch (mode.kind) {
    case "absolute": return { x: cursor[0], y: cursor[1] };
    case "polar": {
      const base = placed[mode.baseIndex];
      if (base === undefined) return {};
      const dx = cursor[0] - base[0];
      const dy = cursor[1] - base[1];
      const values: DynamicValues = {};
      if (mode.length !== undefined) values[mode.length.id] = Math.hypot(dx, dy);
      if (mode.angle) values.angle = toDegrees(Math.atan2(dy, dx));
      return values;
    }
    case "box": {
      const first = placed[0]!;
      const scale = mode.centred ? 2 : 1;
      return { width: Math.abs(cursor[0] - first[0]) * scale, height: Math.abs(cursor[1] - first[1]) * scale };
    }
    case "sweep": {
      if (sweepTrack !== undefined && Math.abs(sweepTrack.sweepRad) > 1e-9) return { sweep: cleanNumber((sweepTrack.sweepRad * 180) / Math.PI) };
      return { sweep: signedSweepDeg(placed[0]!, placed[1]!, cursor) };
    }
    case "circumradius": {
      const circle = circumcircleOf(placed[0]!, placed[1]!, cursor);
      return circle === undefined ? {} : { radius: circle.radius };
    }
    case "offset": {
      const edge = unit(placed[0]!, placed[1]!);
      const second = placed[1]!;
      const normal: Vec2 = [-edge[1], edge[0]];
      return { [mode.field.id]: Math.abs((cursor[0] - second[0]) * normal[0] + (cursor[1] - second[1]) * normal[1]) / mode.factor };
    }
  }
}

export interface DynamicSolve {
  /** The point to place; undefined when `error` says why not. */
  readonly point?: Vec2;
  /** What the input did that the user may not have expected (a negative size flipped, an angle wrapped). */
  readonly notes: readonly string[];
  readonly error?: string;
  /** Horizontal or vertical guides from the base point, so a typed 0 / 90 / 180 / 270 degree angle earns the same relation a snapped one does. */
  readonly guides: readonly InferenceGuide[];
  /** The fields the error belongs to, when it belongs to particular ones. */
  readonly errorFields?: readonly DynamicFieldId[];
}

const MIN_SIZE_MM = 0.01;
const MAX_COORDINATE_MM = 1_000_000;

const sideWord = (axis: 0 | 1, sign: number): string => axis === 0 ? (sign < 0 ? "left" : "right") : (sign < 0 ? "below" : "above");

/**
 * The point to place for the active tool when some fields hold typed values: typed fields win, the others come from the
 * cursor. A negative width, height or length is honoured (it flips the side or reverses the direction) and reported in
 * `notes`; a size that is zero, too small or an impossible radius is refused with an `error`. Angles are wrapped into
 * [0, 360) and exact multiples of 90 stay exact.
 */
export function solveDynamicInput(tool: SketchTool, placed: readonly Vec2[], cursor: Vec2, typed: DynamicValues): DynamicSolve {
  const mode = modeFor(tool, placed.length);
  const notes: string[] = [];
  const guides: InferenceGuide[] = [];
  const fail = (error: string, errorFields: readonly DynamicFieldId[] = []): DynamicSolve => ({ notes, guides: [], error, errorFields });
  if (mode === undefined) return fail("This tool has no typed input.");
  const live = measureFromCursor(tool, placed, cursor);
  const done = (point: Vec2): DynamicSolve => Number.isFinite(point[0]) && Number.isFinite(point[1]) ? { point, notes, guides } : fail("That input does not give a usable point.");
  switch (mode.kind) {
    case "absolute": {
      const x = typed.x ?? cursor[0];
      const y = typed.y ?? cursor[1];
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORDINATE_MM || Math.abs(y) > MAX_COORDINATE_MM) return fail(`Coordinates must be within ±${MAX_COORDINATE_MM.toLocaleString("en-US")} mm.`, ["x", "y"]);
      return done([cleanNumber(x), cleanNumber(y)]);
    }
    case "polar": {
      const base = placed[mode.baseIndex]!;
      const lengthField = mode.length;
      let length: number;
      if (lengthField === undefined) {
        // A direction only (a tangent arc's first leg): the distance is the cursor's.
        length = Math.hypot(cursor[0] - base[0], cursor[1] - base[1]);
        if (length < MIN_SIZE_MM) length = 10;
      } else {
        length = typed[lengthField.id] ?? live[lengthField.id] ?? 0;
      }
      let angle = mode.angle ? typed.angle ?? live.angle ?? 0 : toDegrees(Math.atan2(cursor[1] - base[1], cursor[0] - base[0]));
      if (lengthField !== undefined && typed[lengthField.id] !== undefined && length < 0) {
        // Only a length along a free direction can run backwards: a radius or a diameter is a size.
        if (lengthField.id !== "length") return fail(`${lengthField.label} cannot be negative.`, [lengthField.id]);
        length = -length;
        angle += 180;
        notes.push(`A negative length points the other way, so the point is placed at ${normalizeAngleDeg(angle)}°.`);
      }
      if (length < MIN_SIZE_MM) return fail(`${lengthField?.label ?? "Length"} must be at least ${MIN_SIZE_MM} mm.`, lengthField === undefined ? [] : [lengthField.id]);
      if (mode.angle && typed.angle !== undefined) {
        const wrapped = normalizeAngleDeg(typed.angle);
        if (wrapped !== cleanNumber(typed.angle)) notes.push(`Angle ${cleanNumber(typed.angle)}° is read as ${wrapped}°.`);
      }
      const point = polarPoint(base, length, angle);
      if (mode.angle && typed.angle !== undefined) {
        const exact = normalizeAngleDeg(angle);
        if (exact === 0 || exact === 180) guides.push({ kind: "horizontal", from: base, to: point });
        else if (exact === 90 || exact === 270) guides.push({ kind: "vertical", from: base, to: point });
      }
      return done(point);
    }
    case "box": {
      const first = placed[0]!;
      let width = typed.width ?? live.width ?? 0;
      let height = typed.height ?? live.height ?? 0;
      let signX = cursor[0] - first[0] < 0 ? -1 : 1;
      let signY = cursor[1] - first[1] < 0 ? -1 : 1;
      if (width < 0) { width = -width; signX = -signX; }
      if (height < 0) { height = -height; signY = -signY; }
      if (width < MIN_SIZE_MM || height < MIN_SIZE_MM) return fail(`Width and height must each be at least ${MIN_SIZE_MM} mm.`, [...(width < MIN_SIZE_MM ? ["width" as const] : []), ...(height < MIN_SIZE_MM ? ["height" as const] : [])]);
      const half = mode.centred ? 0.5 : 1;
      const corner = mode.centred ? "corner" : "second corner";
      if ((typed.width ?? 0) < 0) notes.push(`A negative width puts the ${corner} to the ${sideWord(0, signX)} of the start point.`);
      if ((typed.height ?? 0) < 0) notes.push(`A negative height puts the ${corner} ${sideWord(1, signY)} the start point.`);
      return done([cleanNumber(first[0] + width * half * signX), cleanNumber(first[1] + height * half * signY)]);
    }
    case "sweep": {
      const center = placed[0]!;
      const start = placed[1]!;
      const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
      const sweep = typed.sweep ?? live.sweep ?? 0;
      if (Math.abs(sweep) < 1e-6) return fail("The sweep must not be zero.", ["sweep"]);
      if (Math.abs(sweep) >= 360) return fail("The sweep must be less than a full turn (360°).", ["sweep"]);
      const startAngle = toDegrees(Math.atan2(start[1] - center[1], start[0] - center[0]));
      return done(polarPoint(center, radius, startAngle + sweep));
    }
    case "circumradius": {
      const a = placed[0]!;
      const b = placed[1]!;
      const radius = typed.radius ?? live.radius;
      if (radius === undefined) return fail("Type a radius: the cursor is in line with the first two points.", ["radius"]);
      if (radius < 0) return fail("A radius cannot be negative.", ["radius"]);
      if (radius < MIN_SIZE_MM) return fail(`Radius must be at least ${MIN_SIZE_MM} mm.`, ["radius"]);
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (radius < chord / 2 - 1e-9) return fail(`A circle through the first two points needs a radius of at least ${cleanNumber(chord / 2)} mm (half the distance between them).`, ["radius"]);
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const edge = unit(a, b);
      const normal: Vec2 = [-edge[1], edge[0]];
      const lift = Math.sqrt(Math.max(radius * radius - (chord / 2) ** 2, 0));
      const liveCircle = circumcircleOf(a, b, cursor);
      const reference = liveCircle?.center ?? cursor;
      const side = (reference[0] - mid[0]) * normal[0] + (reference[1] - mid[1]) * normal[1] < 0 ? -1 : 1;
      const center: Vec2 = [mid[0] + normal[0] * lift * side, mid[1] + normal[1] * lift * side];
      const direction: Vec2 = Math.hypot(cursor[0] - center[0], cursor[1] - center[1]) < 1e-9 ? [normal[0] * side, normal[1] * side] : unit(center, cursor);
      const third: Vec2 = [cleanNumber(center[0] + direction[0] * radius), cleanNumber(center[1] + direction[1] * radius)];
      if (Math.hypot(third[0] - a[0], third[1] - a[1]) < MIN_SIZE_MM || Math.hypot(third[0] - b[0], third[1] - b[1]) < MIN_SIZE_MM) return fail("The third point would land on one of the first two: move the cursor to another side first.", ["radius"]);
      return done(third);
    }
    case "offset": {
      const second = placed[1]!;
      const edge = unit(placed[0]!, second);
      const normal: Vec2 = [-edge[1], edge[0]];
      let side = ((cursor[0] - second[0]) * normal[0] + (cursor[1] - second[1]) * normal[1]) < 0 ? -1 : 1;
      let amount = typed[mode.field.id] ?? live[mode.field.id] ?? 0;
      if (amount < 0) {
        amount = -amount;
        side = -side;
        notes.push(`A negative ${mode.field.label.toLowerCase()} puts the point on the other side of the first edge from the cursor.`);
      }
      if (amount < MIN_SIZE_MM) return fail(`${mode.field.label} must be at least ${MIN_SIZE_MM} mm.`, [mode.field.id]);
      const reach = amount * mode.factor;
      return done([cleanNumber(second[0] + normal[0] * reach * side), cleanNumber(second[1] + normal[1] * reach * side)]);
    }
  }
}

/**
 * The unit direction of a typed angle in degrees. A right-angle multiple gives exact components: cos(90 degrees) in floating
 * point is 6e-17, which made a typed 90 degree line a hair off plumb and so impossible to hold Vertical.
 */
export function directionOfAngle(angleDeg: number): Vec2 {
  const turns = angleDeg / 90;
  if (Number.isInteger(turns)) {
    const quarter = ((turns % 4) + 4) % 4;
    return quarter === 0 ? [1, 0] : quarter === 1 ? [0, 1] : quarter === 2 ? [-1, 0] : [0, -1];
  }
  const radians = (angleDeg * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/** The point alone (undefined when the combination is not valid, for example a zero length). */
export function pointFromDynamicInput(tool: SketchTool, placed: readonly Vec2[], cursor: Vec2, typed: DynamicValues): Vec2 | undefined {
  return solveDynamicInput(tool, placed, cursor, typed).point;
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Parses a plain typed number: a finite decimal, with a comma accepted as the decimal separator. Hexadecimal, units and
 * expressions are NOT numbers here: use parseFieldEntry (dynamic-entry.ts) for those.
 */
export function parseDynamicNumber(text: string): number | undefined {
  const cleaned = text.trim().replace(",", ".");
  if (!PLAIN_NUMBER.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}
