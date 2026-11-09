import type { SketchEntity, WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { DynamicValues } from "./dynamic-input.js";
import type { SketchTool } from "./index.js";

/**
 * Design intent carried by typed dynamic input. A value typed into a field on the canvas is a number the user chose, not a
 * measurement of where the pointer happened to be, so it becomes a driving dimension; an angle typed as 0 or 90 (or any
 * multiple of 90, 180 and 270 included) means level or plumb, so it becomes Horizontal or Vertical. Before this the typed
 * entry produced plain geometry, and a line typed as 50 mm at 0 degrees drifted as soon as other geometry moved.
 */
export interface TypedIntentInput {
  readonly tool: SketchTool;
  /** The shape that was just built. */
  readonly entity: SketchEntity;
  /** Every field the user typed over the whole gesture (a 3-point rectangle types its edge first and its height later). */
  readonly typed: DynamicValues;
  readonly newId: () => string;
}

/** Smallest value that becomes a dimension, the same 0.01 mm floor as the sketch geometry limit. */
const MIN_DIMENSION_MM = 0.01;

/** An angle that is a multiple of 90 degrees, as the 0-3 quarter turns it is, or undefined. */
function quarterTurns(angleDeg: number): number | undefined {
  const turns = angleDeg / 90;
  return Number.isFinite(turns) && Math.abs(turns - Math.round(turns)) < 1e-9 ? ((Math.round(turns) % 4) + 4) % 4 : undefined;
}

const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && Math.abs(value) >= MIN_DIMENSION_MM;

/** The relations and driving dimensions a typed entry implies for the shape it produced. */
export function typedIntentConstraints(input: TypedIntentInput): readonly WorkbenchSketchConstraint[] {
  const { entity, typed, tool } = input;
  const found: WorkbenchSketchConstraint[] = [];
  const dimension = (name: "length" | "width" | "height", valueMm: number): void => {
    found.push({ id: input.newId(), kind: "distance", entityIds: [entity.id], valueMm: Math.abs(valueMm), dimension: name });
  };
  if (entity.kind === "line" && (tool === "line" || tool === "line-midpoint")) {
    if (typed.angle !== undefined) {
      const quarter = quarterTurns(typed.angle);
      if (quarter !== undefined) found.push({ id: input.newId(), kind: quarter % 2 === 0 ? "horizontal" : "vertical", entityIds: [entity.id] });
    }
    if (usable(typed.length)) dimension("length", typed.length);
  } else if (entity.kind === "rectangle") {
    // The width of a 3-point rectangle is its first edge, which the user types as a length.
    const widthTyped = tool === "rectangle-three-point" ? typed.length : typed.width;
    if (usable(widthTyped)) dimension("width", widthTyped);
    if (usable(typed.height)) dimension("height", typed.height);
  } else if (entity.kind === "circle") {
    if (tool === "circle" && usable(typed.radius)) found.push({ id: input.newId(), kind: "radius", entityIds: [entity.id], valueMm: Math.abs(typed.radius), dimension: "radius" });
    if (tool === "circle-two-point" && usable(typed.diameter)) found.push({ id: input.newId(), kind: "radius", entityIds: [entity.id], valueMm: Math.abs(typed.diameter) / 2, dimension: "radius" });
  } else if (entity.kind === "arc" && tool === "arc-center") {
    // A typed radius and a typed sweep are the arc's size: the radius and, with it, the arc length the sweep covers.
    if (usable(typed.radius)) found.push({ id: input.newId(), kind: "radius", entityIds: [entity.id], valueMm: Math.abs(typed.radius), dimension: "radius" });
    if (usable(typed.radius) && typed.sweep !== undefined && Number.isFinite(typed.sweep) && Math.abs(typed.sweep) > 1e-6 && Math.abs(typed.sweep) < 360) {
      const length = Math.abs(typed.radius) * (Math.abs(typed.sweep) * Math.PI) / 180;
      if (length >= MIN_DIMENSION_MM) found.push({ id: input.newId(), kind: "arc-length", entityIds: [entity.id], valueMm: Number(length.toFixed(9)) });
    }
  } else if (entity.kind === "ellipse") {
    // The major radius is typed along the first axis and the minor radius off it.
    if (usable(typed.major)) found.push({ id: input.newId(), kind: "radius", entityIds: [entity.id], valueMm: Math.abs(typed.major), dimension: "major-radius" });
    if (usable(typed.minor)) found.push({ id: input.newId(), kind: "radius", entityIds: [entity.id], valueMm: Math.abs(typed.minor), dimension: "minor-radius" });
  }
  return found;
}

/** Folds the fields typed at one click into those typed earlier in the same gesture. */
export function mergeTyped(earlier: DynamicValues, now: DynamicValues): DynamicValues {
  return { ...earlier, ...now };
}
