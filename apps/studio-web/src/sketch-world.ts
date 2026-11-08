import type { DesignSketchFeature, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { placePoint } from "../../../packages/workbench-geometry/src/index.js";

export type V3 = readonly [number, number, number];

/** The outward normal of each datum plane, and how a sketch point (u, v) lands on it. xz sketches face -Y; yz sketches run Y up with X along -Z. */
export const DATUM_PLANE_NORMAL: Readonly<Record<"xy" | "xz" | "yz", V3>> = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] };

/**
 * How each datum plane's sketch axes sit in the world (the YZ plane is a Y-up plane in this Z-up world, which is why a profile drawn
 * upright on it keeps its vertical along world Y). Shown in the plane dialog and in revolve messages so the orientation is never a surprise.
 */
export const DATUM_PLANE_AXES: Readonly<Record<"xy" | "xz" | "yz", { readonly sketchX: string; readonly sketchY: string; readonly normal: string }>> = {
  xy: { sketchX: "world +X", sketchY: "world +Y", normal: "world +Z" },
  xz: { sketchX: "world +X", sketchY: "world +Z", normal: "world -Y" },
  yz: { sketchX: "world -Z", sketchY: "world +Y", normal: "world +X" }
};

export function datumKey(sketch: Pick<WorkbenchSketch, "plane">): "xy" | "xz" | "yz" {
  return sketch.plane === "datum:xz" ? "xz" : sketch.plane === "datum:yz" ? "yz" : "xy";
}

/** One sentence naming the world axes a sketch's X and Y run along, for tooltips and messages. */
export function describeSketchAxes(sketch: Pick<WorkbenchSketch, "plane">): string {
  const axes = DATUM_PLANE_AXES[datumKey(sketch)];
  return `The sketch X axis runs along ${axes.sketchX}, its Y axis along ${axes.sketchY}, and the sketch faces ${axes.normal}.`;
}

/** A point of the sketch (u, v in millimetres) in world space, with the sketch's plane offset, tilt or frame applied. */
export function sketchToWorld(sketch: WorkbenchSketch, u: number, v: number, w = 0): V3 {
  const key = datumKey(sketch);
  const base: V3 = key === "xz" ? [u, 0, v] : key === "yz" ? [0, v, -u] : [u, v, 0];
  const normal = DATUM_PLANE_NORMAL[key];
  const offset = (sketch.planeOffsetMm ?? 0) + w;
  return placePoint([base[0] + normal[0] * offset, base[1] + normal[1] * offset, base[2] + normal[2] * offset], sketch);
}

/** The sketch coordinates (u, v) of a world point, and how far it sits off the sketch plane along the plane's normal (w). */
export function worldToSketch(sketch: WorkbenchSketch, point: V3): { readonly u: number; readonly v: number; readonly w: number } {
  const key = datumKey(sketch);
  const datum = placePoint(point, sketch, true);
  const normal = DATUM_PLANE_NORMAL[key];
  const along = datum[0] * normal[0] + datum[1] * normal[1] + datum[2] * normal[2];
  const w = along - (sketch.planeOffsetMm ?? 0);
  const onPlane: V3 = [datum[0] - normal[0] * along, datum[1] - normal[1] * along, datum[2] - normal[2] * along];
  return key === "xz" ? { u: onPlane[0], v: onPlane[2], w } : key === "yz" ? { u: -onPlane[2], v: onPlane[1], w } : { u: onPlane[0], v: onPlane[1], w };
}

/** The world direction a sketch's normal points in. */
export function sketchWorldNormal(sketch: WorkbenchSketch): V3 {
  const origin = sketchToWorld(sketch, 0, 0, 0);
  const tip = sketchToWorld(sketch, 0, 0, 1);
  return [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]];
}

export function sketchFeaturePointToWorld(feature: DesignSketchFeature, u: number, v: number): V3 {
  return sketchToWorld(feature.sketch, u, v);
}
