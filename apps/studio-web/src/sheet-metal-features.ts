import type { DesignSolidFeature, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { flangeEdgesOf } from "../../../packages/workbench-core/src/index.js";
import { profileOutlineMm, resolveProfileRegion, type SketchProfile } from "../../../packages/workbench-sketch/src/index.js";
import {
  bendResolverOf, circleOfOutline, coneDevelopment, developBend, miterChainOf, tessellateLoftedBend,
  type BendKResolver, type BendRecord, type FlatLayout, type PlateFlange, type PlateJog, type SheetFrame, type TessellatePlane
} from "../../../packages/workbench-geometry/src/index.js";

type Point2 = readonly [number, number];

/** The bend resolver for a body: its bend table when the step that made it carries one, else the default K-factor. */
export function bendResolverOfStep(base: Pick<DesignSolidFeature, "sheetBendTable"> | undefined): BendKResolver {
  return bendResolverOf(base?.sheetBendTable);
}

/**
 * The flanges of a plate as the flat pattern wants them. A miter flange step becomes one flange per edge of its chain, with the ends
 * that meet inside the chain marked as mitred. `live` says whether a step is currently active in the timeline.
 */
export function plateFlangesOf(frame: SheetFrame, steps: readonly DesignSolidFeature[], live: (step: DesignSolidFeature) => boolean): { readonly flanges: readonly PlateFlange[] } | { readonly error: string } {
  const flanges: PlateFlange[] = [];
  for (const step of steps) {
    if (step.kind !== "sheet-edge-flange" || !live(step)) continue;
    const common = { innerRadiusMm: step.sheetBendRadiusMm ?? 0, flangeLengthMm: step.flangeLengthMm ?? 0, angleDeg: step.flangeAngleDeg ?? 0, reliefMm: step.flangeReliefMm ?? 0 };
    if (step.flangeMiterEdges === undefined) { flanges.push({ edgeIndex: step.flangeEdgeIndex ?? 0, ...common, ...(step.flangeReliefShape === undefined ? {} : { reliefShape: step.flangeReliefShape }) }); continue; }
    const chain = miterChainOf(frame, flangeEdgesOf(step));
    if (!chain.ok) return { error: chain.message };
    chain.edges.forEach((edgeIndex, position) => {
      flanges.push({ edgeIndex, ...common, mitreStart: position > 0 || chain.closed, mitreEnd: position + 1 < chain.edges.length || chain.closed });
    });
  }
  return { flanges };
}

/** The live jogs of a body in the flat pattern's terms. */
export function plateJogsOf(steps: readonly DesignSolidFeature[], live: (step: DesignSolidFeature) => boolean): readonly PlateJog[] {
  return steps
    .filter((step) => step.kind === "sheet-jog" && live(step))
    .map((step) => ({ edgeIndex: step.jogEdgeIndex ?? 0, positionMm: step.jogPositionMm ?? 0, offsetMm: step.jogOffsetMm ?? 0, angleDeg: step.jogAngleDeg ?? 0, innerRadiusMm: step.sheetBendRadiusMm ?? 0 }));
}

function centroidOf(ring: readonly Point2[]): Point2 {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    area += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(area) < 1e-12) return [ring.reduce((sum, p) => sum + p[0], 0) / ring.length, ring.reduce((sum, p) => sum + p[1], 0) / ring.length];
  return [cx / (3 * area), cy / (3 * area)];
}

export type LoftedBendRings =
  | { readonly ok: true; readonly bottom: readonly Point2[]; readonly top: readonly Point2[] }
  | { readonly ok: false; readonly message: string };

/** The bottom outline (the step's profile) and the top outline (the profile scaled about its centroid, or a second profile) of a lofted bend. */
export function loftedBendRings(feature: DesignSolidFeature, profiles: readonly SketchProfile[], outer: SketchProfile): LoftedBendRings {
  const bottom = profileOutlineMm(outer.boundary).map((point): Point2 => [point[0], point[1]]);
  if (feature.loftSecondaryProfileIds !== undefined && feature.loftSecondaryProfileIds.length > 0) {
    const secondary = resolveProfileRegion(profiles, feature.loftSecondaryProfileIds, { includeIslands: false });
    if (!secondary.ok) return { ok: false, message: secondary.diagnostics[0]?.message ?? "The top profile of this lofted bend no longer exists in its sketch." };
    return { ok: true, bottom, top: profileOutlineMm(secondary.value.outer.boundary).map((point): Point2 => [point[0], point[1]]) };
  }
  const scale = feature.loftTopScale;
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return { ok: false, message: "A lofted bend needs a positive top scale or a second profile." };
  const centre = centroidOf(bottom);
  return { ok: true, bottom, top: bottom.map((point): Point2 => [centre[0] + (point[0] - centre[0]) * scale, centre[1] + (point[1] - centre[1]) * scale]) };
}

export type LoftedBendBuild =
  | { readonly ok: true; readonly body: GeneralSolidBody }
  | { readonly ok: false; readonly message: string };

/** Builds the lofted bend body of a step, in the sketch plane's own frame. */
export function loftedBendBody(feature: DesignSolidFeature, profiles: readonly SketchProfile[], outer: SketchProfile, plane: TessellatePlane, color: string): LoftedBendBuild {
  const rings = loftedBendRings(feature, profiles, outer);
  if (!rings.ok) return rings;
  const thickness = feature.sheetThicknessMm ?? 0;
  const mesh = tessellateLoftedBend({ bottomMm: rings.bottom, topMm: rings.top, heightMm: Math.abs(feature.valueMm), thicknessMm: thickness }, plane);
  if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) return { ok: false, message: "The lofted bend could not be built. Check the height and thickness are positive and the two outlines are clean closed shapes that do not pinch to a point." };
  return {
    ok: true,
    body: { id: feature.bodyId, name: feature.name, visible: true, color, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices), feature: { operation: "loft", plane, valueMm: feature.valueMm } }
  };
}

export type LoftedBendFlat =
  | { readonly ok: true; readonly layout: FlatLayout; readonly summary: string; readonly notes: readonly string[]; readonly bends: readonly BendRecord[] }
  | { readonly ok: false; readonly message: string };

/**
 * Unrolls a lofted bend, when that is real: a cone or cylinder between two concentric circles develops exactly (an annular sector or a
 * rectangle). Any other pair of outlines, or circles that are not on one axis, is a ruled skin that cannot be laid flat without
 * stretching, so it is refused rather than drawn wrong. The bend table is read with the mean inner radius as the bend radius.
 */
export function loftedBendFlat(feature: DesignSolidFeature, profiles: readonly SketchProfile[], outer: SketchProfile, resolve: BendKResolver): LoftedBendFlat {
  const rings = loftedBendRings(feature, profiles, outer);
  if (!rings.ok) return rings;
  const bottom = circleOfOutline(rings.bottom);
  const top = circleOfOutline(rings.top);
  if (bottom === undefined || top === undefined) return { ok: false, message: "A lofted bend unfolds only between two circles (a cone or a cylinder). Other transitions are ruled surfaces that cannot be laid flat without stretching." };
  if (Math.hypot(bottom.centre[0] - top.centre[0], bottom.centre[1] - top.centre[1]) > 1e-6 * Math.max(bottom.radiusMm, top.radiusMm)) return { ok: false, message: "The two circles are not on one axis, so the transition is an oblique cone, which this unfolds only as an approximation it does not attempt." };
  const thickness = feature.sheetThicknessMm ?? 0;
  const bend = developBend(resolve, thickness, (bottom.radiusMm + top.radiusMm) / 2, 90);
  const development = coneDevelopment(bottom.radiusMm, top.radiusMm, Math.abs(feature.valueMm), thickness, bend.kFactor);
  if (development === undefined) return { ok: false, message: "The lofted bend has a zero dimension, so it cannot be unfolded." };
  const summary = development.sectorDeg === 0
    ? `${development.outerArcMm.toFixed(2)} x ${Math.abs(feature.valueMm).toFixed(2)} mm rectangle (cylinder), K ${bend.kFactor.toFixed(3)}`
    : `annular sector of ${development.sectorDeg.toFixed(1)}°, radii ${development.innerRadiusMm.toFixed(2)} to ${development.outerRadiusMm.toFixed(2)} mm, K ${bend.kFactor.toFixed(3)}`;
  return { ok: true, layout: development.layout, summary, notes: ["The cone is rolled from this blank; its seam runs along the straight cut."], bends: [bend] };
}
