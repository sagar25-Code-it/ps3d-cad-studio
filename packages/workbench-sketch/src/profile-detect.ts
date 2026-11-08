import type { WorkbenchSketch } from "../../workbench-core/src/index.js";
import { buildArrangement, type Arrangement } from "./arrangement.js";
import type { SketchProfile } from "./index.js";
import { profileCurves, profileGapToleranceOf, profilesOfArrangement, type ProfileDetectionOptions } from "./profile-regions.js";
import { detectShapes } from "./profile-shapes.js";

const SHAPES = Symbol.for("ps3d.profileShapes");

/** The planar arrangement of the sketch's visible curves, for callers that want more than the regions (diagnostics, break at intersections). */
export function arrangeSketch(sketch: WorkbenchSketch, options: ProfileDetectionOptions = {}): Arrangement {
  return buildArrangement(profileCurves(sketch), { gapToleranceMm: profileGapToleranceOf(sketch, options) });
}

/**
 * The regions of a sketch. The returned list also remembers, out of sight, the closed outlines as drawn (see profile-shapes.ts),
 * which is what a bare profile id or an empty selection means to `resolveProfileRegion`. They are only worked out when asked for,
 * and only differ from the regions where curves cross.
 */
export function detectProfilesOf(sketch: WorkbenchSketch, options: ProfileDetectionOptions = {}): SketchProfile[] {
  const tolerance = profileGapToleranceOf(sketch, options);
  const curves = profileCurves(sketch);
  const arrangement = buildArrangement(curves, { gapToleranceMm: tolerance });
  const profiles = profilesOfArrangement(arrangement, curves);
  const interacting = arrangement.crossings.length > 0 || arrangement.overlaps.length > 0;
  let cache: readonly SketchProfile[] | undefined;
  Object.defineProperty(profiles, SHAPES, {
    value: (): readonly SketchProfile[] => (cache ??= interacting ? detectShapes(curves, tolerance) : profiles),
    enumerable: false
  });
  return profiles;
}

/** The closed outlines as drawn, when the list came from `detectSketchProfiles`; undefined for a list put together by hand. */
export function shapesOf(profiles: readonly SketchProfile[]): readonly SketchProfile[] | undefined {
  const lazy = (profiles as unknown as Record<symbol, unknown>)[SHAPES];
  return typeof lazy === "function" ? (lazy as () => readonly SketchProfile[])() : undefined;
}
