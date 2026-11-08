import type { PartAnalyticBodyShape, PartPreviewBody, PartPrimitiveParams, Vec3 } from "./types.js";

/**
 * The five primitives added beside Box, Cylinder, Sphere, Cone and Torus. Their parameters ride in the same
 * `sizeMm` triple the older primitives use, plus an optional `primitiveParams` record for the count-like inputs
 * that are not a length:
 *
 *  - ellipsoid: [diameter X, diameter Y, diameter Z]
 *  - prism:     [circumscribed diameter, circumscribed diameter, height], `primitiveParams.sides` (3 to 64)
 *  - wedge:     [width X, depth Y, height Z]; the full height stands on the -Y edge and tapers to nothing at +Y
 *  - spiral:    [outer diameter, outer diameter, thickness], `primitiveParams.turns` (0.5 to 20): a flat Archimedean
 *               ribbon whose width equals the gap between turns
 *  - tube:      [outer diameter, inner diameter, height]
 *
 * `sizeMm` is always the true local bounding box (the prism and spiral use their circumscribed circle), so envelope,
 * interference and fit-to-view code that reads `sizeMm` stays correct for them.
 */
export const NEW_PRIMITIVE_SHAPES = ["ellipsoid", "prism", "wedge", "spiral", "tube"] as const;
export type NewPrimitiveShape = (typeof NEW_PRIMITIVE_SHAPES)[number];

export const PRISM_SIDES_RANGE = [3, 64] as const;
export const SPIRAL_TURNS_RANGE = [0.5, 20] as const;
export const DEFAULT_PRISM_SIDES = 6;
export const DEFAULT_SPIRAL_TURNS = 3;

export function isNewPrimitiveShape(shape: unknown): shape is NewPrimitiveShape {
  return (NEW_PRIMITIVE_SHAPES as readonly unknown[]).includes(shape);
}

/** Starting dimensions and parameters for a freshly created primitive. */
export function defaultPrimitive(shape: NewPrimitiveShape): { readonly sizeMm: Vec3; readonly primitiveParams?: PartPrimitiveParams } {
  if (shape === "ellipsoid") return { sizeMm: [40, 28, 22] };
  if (shape === "prism") return { sizeMm: [30, 30, 24], primitiveParams: { sides: DEFAULT_PRISM_SIDES } };
  if (shape === "wedge") return { sizeMm: [30, 24, 18] };
  if (shape === "spiral") return { sizeMm: [50, 50, 4], primitiveParams: { turns: DEFAULT_SPIRAL_TURNS } };
  return { sizeMm: [30, 22, 30] };
}

/** The size tuple a primitive actually keeps: round shapes force Y to follow X. Undefined when the tuple cannot be a valid body. */
export function normalizePrimitiveSize(shape: NewPrimitiveShape, size: readonly [number, number, number]): Vec3 | undefined {
  const [x, y, z] = size;
  if (!(x > 0) || !(z > 0) || y < 0) return undefined;
  if (shape === "prism" || shape === "spiral") return [x, x, z];
  if (shape === "tube") return y > 0 && y < x ? [x, y, z] : undefined;
  return y > 0 ? [x, y, z] : undefined;
}

/** True when the shape-specific parameters of a primitive body are coherent. Bodies of the older shapes must carry no `primitiveParams`. */
export function validPrimitiveBody(body: Pick<PartPreviewBody, "shape" | "sizeMm" | "primitiveParams">): boolean {
  const params = body.primitiveParams;
  if (!isNewPrimitiveShape(body.shape)) return params === undefined;
  const normalized = normalizePrimitiveSize(body.shape, body.sizeMm);
  if (normalized === undefined || normalized.some((value, index) => Math.abs(value - body.sizeMm[index]!) > 1e-9)) return false;
  if (body.shape === "prism") {
    return params !== undefined && Object.keys(params).every((key) => key === "sides") && Number.isInteger(params.sides)
      && params.sides! >= PRISM_SIDES_RANGE[0] && params.sides! <= PRISM_SIDES_RANGE[1];
  }
  if (body.shape === "spiral") {
    return params !== undefined && Object.keys(params).every((key) => key === "turns") && typeof params.turns === "number" && Number.isFinite(params.turns)
      && params.turns >= SPIRAL_TURNS_RANGE[0] && params.turns <= SPIRAL_TURNS_RANGE[1];
  }
  return params === undefined;
}

/** Shapes whose geometry is not preserved by a plain mirror copy (the copy would be a different handed or sloped body). */
export function primitiveMirrorSupported(body: Pick<PartPreviewBody, "shape" | "primitiveParams">, plane: "xy" | "xz" | "yz"): boolean {
  if (body.shape === "spiral") return false;
  if (body.shape === "wedge") return plane === "yz";
  // A prism has a vertex on +X, so only an even side count is also symmetric across the YZ plane.
  if (body.shape === "prism") return plane !== "yz" || (body.primitiveParams?.sides ?? 0) % 2 === 0;
  return true;
}

/** Whether the planar-face and trim direct edits make sense for a primitive. A wedge and an ellipsoid have no pair of parallel Z faces. */
export function primitiveHasParallelZFaces(shape: PartAnalyticBodyShape): boolean {
  return shape !== "ellipsoid" && shape !== "wedge";
}

/** Human labels for the inspector. */
export function primitiveSizeLabels(shape: NewPrimitiveShape): { readonly x: string; readonly y: string | undefined; readonly z: string | undefined } {
  if (shape === "ellipsoid") return { x: "Diameter X", y: "Diameter Y", z: "Diameter Z" };
  if (shape === "prism") return { x: "Circumscribed diameter", y: undefined, z: "Height" };
  if (shape === "wedge") return { x: "Width", y: "Depth", z: "Height" };
  if (shape === "spiral") return { x: "Outer diameter", y: undefined, z: "Thickness" };
  return { x: "Outer diameter", y: "Inner diameter", z: "Height" };
}
