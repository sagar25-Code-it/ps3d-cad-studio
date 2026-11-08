import type { DesignSketchFeature, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { resolveSketchFace, sketchOnFace } from "../../../packages/workbench-core/src/index.js";

export interface FollowedSketch {
  /** The sketch feature as it must be built from now: moved onto its face when it lies on one. */
  readonly sketchFeature: DesignSketchFeature;
  /** Set when the face could not be found exactly: what was done instead, or that the sketch stayed where it was. Shown as the feature's health. */
  readonly warning?: string;
  /** The offset the sketch now has, when it moved. */
  readonly movedToOffsetMm?: number;
}

/**
 * Re-resolves the face a sketch lies on against the solid as it is now. A sketch on a datum plane, offset plane or construction plane is
 * returned unchanged. `bodyOf` returns the current shape of a body (the one being replayed, one rebuilt earlier in the same pass, or the stored one).
 */
export function followSketchFace(sketchFeature: DesignSketchFeature, bodyOf: (bodyId: string) => GeneralSolidBody | undefined): FollowedSketch {
  const face = sketchFeature.sketch.planeFace;
  if (face === undefined) return { sketchFeature };
  const resolved = resolveSketchFace(face, bodyOf(face.bodyId));
  if (!resolved.ok) return { sketchFeature, warning: resolved.message };
  const moved = sketchOnFace(sketchFeature.sketch, resolved.offsetMm);
  const followed = moved === sketchFeature.sketch ? sketchFeature : { ...sketchFeature, sketch: moved };
  const warning = resolved.how === "nearest"
    ? `The face ${sketchFeature.name} was drawn on changed shape, so the nearest ${face.axis.toUpperCase()}${face.outwardPositive ? "+" : "-"} face (at ${resolved.coordinateMm.toFixed(2)} mm) was used. Check the features built on it.`
    : undefined;
  return { sketchFeature: followed, ...(warning === undefined ? {} : { warning }), ...(moved === sketchFeature.sketch ? {} : { movedToOffsetMm: resolved.offsetMm }) };
}
