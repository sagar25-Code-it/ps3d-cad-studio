import type { Vec2 } from "../../workbench-core/src/index.js";
import type { SketchTool } from "./index.js";

/**
 * Dynamic input: while a drawing tool has placed its first point, the canvas shows editable fields next to the cursor
 * (length and angle for a line, width and height for a rectangle, radius for a circle). Typing into a field locks that
 * value; the fields you have not typed in keep following the pointer. Enter places the shape with the typed values.
 *
 * The maths lives here, free of any UI, so it can be tested.
 */
export type DynamicFieldId = "length" | "angle" | "width" | "height" | "radius" | "diameter";

export interface DynamicField {
  readonly id: DynamicFieldId;
  readonly label: string;
  readonly unit: "mm" | "°";
}

export type DynamicValues = Partial<Record<DynamicFieldId, number>>;

const FIELD: Readonly<Record<DynamicFieldId, DynamicField>> = {
  length: { id: "length", label: "Length", unit: "mm" },
  angle: { id: "angle", label: "Angle", unit: "°" },
  width: { id: "width", label: "Width", unit: "mm" },
  height: { id: "height", label: "Height", unit: "mm" },
  radius: { id: "radius", label: "Radius", unit: "mm" },
  diameter: { id: "diameter", label: "Diameter", unit: "mm" }
};

/** The fields a tool offers for the point it is about to place, or none when typed input does not apply. */
export function dynamicFieldsFor(tool: SketchTool, placedPoints: number): readonly DynamicField[] {
  if (placedPoints < 1) return [];
  switch (tool) {
    case "line": return [FIELD.length, FIELD.angle];
    case "rectangle":
    case "rectangle-center": return [FIELD.width, FIELD.height];
    case "circle": return [FIELD.radius];
    case "circle-two-point": return [FIELD.diameter];
    // A 3-point rectangle takes its first edge like a line, then a height.
    case "rectangle-three-point": return placedPoints === 1 ? [FIELD.length, FIELD.angle] : placedPoints === 2 ? [FIELD.height] : [];
    default: return [];
  }
}

const toDegrees = (radians: number): number => {
  const degrees = (radians * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};

function unit(from: Vec2, to: Vec2): Vec2 {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return length < 1e-12 ? [1, 0] : [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
}

/** The field values the cursor currently implies; these are what the inputs display until the user types. */
export function measureFromCursor(tool: SketchTool, placed: readonly Vec2[], cursor: Vec2): DynamicValues {
  const first = placed[0];
  if (first === undefined) return {};
  const dx = cursor[0] - first[0];
  const dy = cursor[1] - first[1];
  switch (tool) {
    case "line": return { length: Math.hypot(dx, dy), angle: toDegrees(Math.atan2(dy, dx)) };
    case "rectangle": return { width: Math.abs(dx), height: Math.abs(dy) };
    case "rectangle-center": return { width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
    case "circle": return { radius: Math.hypot(dx, dy) };
    case "circle-two-point": return { diameter: Math.hypot(dx, dy) };
    case "rectangle-three-point": {
      if (placed.length === 1) return { length: Math.hypot(dx, dy), angle: toDegrees(Math.atan2(dy, dx)) };
      const second = placed[1]!;
      const edge = unit(first, second);
      const normal: Vec2 = [-edge[1], edge[0]];
      return { height: Math.abs((cursor[0] - second[0]) * normal[0] + (cursor[1] - second[1]) * normal[1]) };
    }
    default: return {};
  }
}

/**
 * The point to place for the active tool when some fields hold typed values: typed fields win, the others come from the
 * cursor. Returns undefined when the combination is not valid (for example a zero length).
 */
export function pointFromDynamicInput(tool: SketchTool, placed: readonly Vec2[], cursor: Vec2, typed: DynamicValues): Vec2 | undefined {
  const first = placed[0];
  if (first === undefined) return undefined;
  const live = measureFromCursor(tool, placed, cursor);
  const value = (id: DynamicFieldId): number => Math.abs(typed[id] ?? live[id] ?? 0);
  const directionSign = (a: number, b: number): number => (b - a) < 0 ? -1 : 1;
  switch (tool) {
    case "line":
    case "rectangle-three-point": {
      if (tool === "rectangle-three-point" && placed.length === 2) {
        const second = placed[1]!;
        const edge = unit(first, second);
        const normal: Vec2 = [-edge[1], edge[0]];
        const side = ((cursor[0] - second[0]) * normal[0] + (cursor[1] - second[1]) * normal[1]) < 0 ? -1 : 1;
        const height = value("height");
        return height < 0.01 ? undefined : [second[0] + normal[0] * height * side, second[1] + normal[1] * height * side];
      }
      const length = value("length");
      if (length < 0.01) return undefined;
      const angle = typed.angle !== undefined ? (typed.angle * Math.PI) / 180 : Math.atan2(cursor[1] - first[1], cursor[0] - first[0]);
      return [first[0] + length * Math.cos(angle), first[1] + length * Math.sin(angle)];
    }
    case "rectangle": {
      const width = value("width");
      const height = value("height");
      if (width < 0.01 || height < 0.01) return undefined;
      return [first[0] + width * directionSign(first[0], cursor[0]), first[1] + height * directionSign(first[1], cursor[1])];
    }
    case "rectangle-center": {
      const width = value("width");
      const height = value("height");
      if (width < 0.01 || height < 0.01) return undefined;
      return [first[0] + (width / 2) * directionSign(first[0], cursor[0]), first[1] + (height / 2) * directionSign(first[1], cursor[1])];
    }
    case "circle":
    case "circle-two-point": {
      const size = tool === "circle" ? value("radius") : value("diameter");
      if (size < 0.01) return undefined;
      const direction = unit(first, cursor);
      return [first[0] + direction[0] * size, first[1] + direction[1] * size];
    }
    default: return undefined;
  }
}

/** Parses what the user typed into a field: a finite number, with a comma accepted as the decimal separator. */
export function parseDynamicNumber(text: string): number | undefined {
  const cleaned = text.trim().replace(",", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}
