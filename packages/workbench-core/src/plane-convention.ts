import type { SketchDatumPlane, Vec3, WorkbenchSketch } from "./types.js";

/**
 * Versioned sketch-plane convention (re-audit P22).
 *
 * The Right (YZ) plane was first built Y-up in a Z-up world: sketch X ran along world -Z and sketch Y along world +Y, so a profile
 * drawn upright turned about world Y when revolved. Every sketch saved before the fix keeps exactly that mapping (the "legacy" one;
 * the sketch has no marker). A sketch started on the Right plane from now on carries `planeConvention: "z-up"`: sketch X runs along
 * world +Y, sketch Y along world +Z and the sketch faces world +X (right-handed, like Fusion and Onshape). The marker lives on the
 * sketch (and on the sketch snapshot of every feature built from it), so a saved project replays to the same geometry for good.
 */
export const SKETCH_PLANE_CONVENTIONS = ["z-up"] as const;
export type SketchPlaneConvention = (typeof SKETCH_PLANE_CONVENTIONS)[number];

/** What an operation may ask for: the Z-up mapping, or the legacy Y-up one (a restore of an older sketch). */
export type SketchPlaneConventionRequest = SketchPlaneConvention | "legacy";

export interface DatumAxes {
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
}

const LEGACY_AXES: Readonly<Record<SketchDatumPlane, DatumAxes>> = {
  "datum:xy": { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  "datum:xz": { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  "datum:yz": { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] }
};

const Z_UP_YZ: DatumAxes = { u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] };

type ConventionSource = Pick<WorkbenchSketch, "plane"> & { readonly planeConvention?: SketchPlaneConvention | undefined };

/** True for a Right-plane sketch that follows the Z-up mapping. Only the YZ plane has two mappings. */
export function usesZUpPlane(sketch: ConventionSource): boolean {
  return sketch.plane === "datum:yz" && sketch.planeConvention === "z-up";
}

/** The world directions of a sketch's X, Y and normal on its datum plane (before an offset is applied or a tilt turns it). */
export function datumAxesOf(sketch: ConventionSource): DatumAxes {
  return usesZUpPlane(sketch) ? Z_UP_YZ : LEGACY_AXES[sketch.plane];
}

/** The marker field a sketch on `plane` gets: only a YZ sketch has one, and only the Z-up mapping is marked. */
export function conventionFields(plane: SketchDatumPlane, request: SketchPlaneConventionRequest | undefined, hasFrame: boolean, previous: ConventionSource | undefined): { readonly planeConvention?: SketchPlaneConvention } {
  if (plane !== "datum:yz" || hasFrame) return {};
  if (request === "legacy") return {};
  if (request === "z-up") return { planeConvention: "z-up" };
  // No request: a sketch that stays on the Right plane keeps the mapping it already has; any other sketch starts with the new one.
  if (previous !== undefined && previous.plane === "datum:yz") return previous.planeConvention === "z-up" ? { planeConvention: "z-up" } : {};
  return { planeConvention: "z-up" };
}

/** How the Right plane is described for a person: the world axes the sketch X and Y run along. */
export function describeYzConvention(zUp: boolean): { readonly sketchX: string; readonly sketchY: string; readonly normal: string } {
  return zUp ? { sketchX: "world +Y", sketchY: "world +Z", normal: "world +X" } : { sketchX: "world -Z", sketchY: "world +Y", normal: "world +X" };
}

/** The point of the sketch plane at sketch coordinates (u, v), before the plane offset, tilt or frame: the datum plane's own mapping. */
export function datumPointOf(sketch: ConventionSource, u: number, v: number): Vec3 {
  if (sketch.plane === "datum:xz") return [u, 0, v];
  if (sketch.plane === "datum:yz") return usesZUpPlane(sketch) ? [0, u, v] : [0, v, -u];
  return [u, v, 0];
}

/** The sketch coordinates (u, v) of a point in the datum plane's own frame (the inverse of `datumPointOf`, ignoring the offset along the normal). */
export function datumCoordinatesOf(sketch: ConventionSource, point: Vec3): readonly [number, number] {
  if (sketch.plane === "datum:xz") return [point[0], point[2]];
  if (sketch.plane === "datum:yz") return usesZUpPlane(sketch) ? [point[1], point[2]] : [-point[2], point[1]];
  return [point[0], point[1]];
}
