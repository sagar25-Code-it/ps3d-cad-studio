import type { SketchEntity, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { DynamicValues } from "./dynamic-input.js";
import type { SketchTool } from "./index.js";
import type { SketchShape } from "./shapes.js";
import type { ShapeSizeDimension } from "./regular-polygon.js";

/**
 * Design intent carried by typed dynamic input for the tools that place a whole shape. A size typed on the keyboard (a polygon's radius, apothem
 * or side, a slot's length and width, a midpoint line's half length) is a number the user chose, so it is recorded as the driving dimension that
 * holds it, exactly as typed-intent.ts does for a single curve. Without it the typed size was only where the pointer ended up.
 */
export interface TypedShapeIntentInput {
  readonly tool: SketchTool;
  readonly shape: SketchShape;
  readonly typed: DynamicValues;
  readonly newId: () => string;
}

const MIN_DIMENSION_MM = 0.01;
const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && Math.abs(value) >= MIN_DIMENSION_MM;

function radiusOfArc(entity: SketchEntity): number | undefined {
  if (entity.kind !== "arc") return undefined;
  const { start, mid, end } = entity;
  const d = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = start[0] ** 2 + start[1] ** 2;
  const b2 = mid[0] ** 2 + mid[1] ** 2;
  const c2 = end[0] ** 2 + end[1] ** 2;
  const x = (a2 * (mid[1] - end[1]) + b2 * (end[1] - start[1]) + c2 * (start[1] - mid[1])) / d;
  const y = (a2 * (end[0] - mid[0]) + b2 * (start[0] - end[0]) + c2 * (mid[0] - start[0])) / d;
  return Math.hypot(start[0] - x, start[1] - y);
}

/** The constraint form of the one dimension that sizes a regular polygon (the same one the dimension editor drives). */
export function sizeDimensionConstraint(size: ShapeSizeDimension, id: string): WorkbenchSketchConstraint {
  if (size.dimension === "radius") return { id, kind: "radius", entityIds: [size.entityId], valueMm: size.valueMm, dimension: "radius" };
  if (size.dimension === "length") return { id, kind: "distance", entityIds: [size.entityId], valueMm: size.valueMm, dimension: "length" };
  return { id, kind: "distance", entityIds: [size.entityId, size.secondEntityId ?? ""], valueMm: size.valueMm, dimension: "point-line", ...(size.points === undefined ? {} : { points: size.points }) };
}

export function typedShapeIntent(input: TypedShapeIntentInput): readonly WorkbenchSketchConstraint[] {
  const { tool, shape, typed } = input;
  const found: WorkbenchSketchConstraint[] = [];
  const length = (entity: SketchEntity, valueMm: number): void => { found.push({ id: input.newId(), kind: "distance", entityIds: [entity.id], valueMm, dimension: "length" }); };
  const radius = (entity: SketchEntity, valueMm: number): void => { found.push({ id: input.newId(), kind: "radius", entityIds: [entity.id], valueMm, dimension: "radius" }); };
  if (tool === "polygon") {
    const size = (shape as { readonly sizeDimension?: ShapeSizeDimension }).sizeDimension;
    if (size !== undefined && usable(typed.radius)) found.push(sizeDimensionConstraint(size, input.newId()));
    return found;
  }
  if (tool === "slot" || tool === "slot-straight") {
    const lines = shape.entities.filter((entity) => entity.kind === "line");
    const caps = shape.entities.filter((entity) => entity.kind === "arc");
    const top = lines[0];
    const cap = caps[0];
    // The typed width is the slot's diameter: the radius of its caps. The typed length is the centre distance (straight slot: the overall length, of which the caps take two radii).
    if (cap !== undefined && usable(typed.width)) radius(cap, Math.abs(typed.width) / 2);
    if (top !== undefined && usable(typed.length)) {
      const capRadius = cap === undefined ? undefined : radiusOfArc(cap);
      const straight = tool === "slot-straight" ? Math.abs(typed.length) - 2 * (capRadius ?? 0) : Math.abs(typed.length);
      if (straight >= MIN_DIMENSION_MM) length(top, Number(straight.toFixed(9)));
    }
    return found;
  }
  if (tool === "rectangle" || tool === "rectangle-center" || tool === "rectangle-three-point") {
    // The first side carries the width (a 3-point rectangle types its first edge as a length), the second side the height.
    const widthTyped = tool === "rectangle-three-point" ? typed.length : typed.width;
    const [widthSide, heightSide] = shape.entities;
    if (widthSide !== undefined && usable(widthTyped)) length(widthSide, Math.abs(widthTyped));
    if (heightSide !== undefined && usable(typed.height)) length(heightSide, Math.abs(typed.height));
    return found;
  }
  if (tool === "line-midpoint") {
    const line = shape.entities.find((entity) => entity.kind === "line");
    if (line !== undefined && usable(typed.length)) length(line, Math.abs(typed.length) * 2);
    return found;
  }
  return found;
}
