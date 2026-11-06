import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchDatumPlane, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles, resolveProfileRegion } from "../../../packages/workbench-sketch/src/index.js";
import { createGeneralSolidBody, type SketchPlane } from "./general-modeling.js";

/**
 * Rebuilds the solids of the parametric timeline. The kernel is asynchronous, so the work happens here and its results
 * are applied to the project afterwards with the synchronous `regenerate-design` operation.
 */
export type SolidRebuild =
  | { readonly ok: true; readonly body: GeneralSolidBody }
  | { readonly ok: false; readonly message: string };

export interface RebuildResult {
  readonly featureId: string;
  readonly body?: GeneralSolidBody;
  readonly message?: string;
}

const NORMALS: Readonly<Record<SketchPlane, readonly [number, number, number]>> = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] };

export function planeKeyOf(plane: SketchDatumPlane): SketchPlane {
  return plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
}

/** How far from the sketch plane an extrusion starts, along the plane's normal: symmetric straddles it, flipped goes the other way. */
export function extrudeStartOffsetMm(feature: Pick<DesignSolidFeature, "kind" | "valueMm" | "direction">): number {
  if (feature.kind !== "extrude") return 0;
  const height = Math.abs(feature.valueMm);
  return feature.direction === "symmetric" ? -height / 2 : feature.direction === "flipped" ? -height : 0;
}

function shifted(body: GeneralSolidBody, normal: readonly [number, number, number], offsetMm: number): GeneralSolidBody {
  if (offsetMm === 0) return body;
  const positionsMm = body.positionsMm.map((value, index) => value + normal[index % 3]! * offsetMm);
  return { ...body, positionsMm };
}

/** Builds the solid a feature describes from the sketch snapshot it is based on. */
export async function rebuildSolidFeature(feature: DesignSolidFeature, sketchFeature: DesignSketchFeature, color = "#b9c2c8"): Promise<SolidRebuild> {
  const sketch = sketchFeature.sketch;
  const profiles = detectSketchProfiles(sketch);
  const missing = feature.profileIds.find((id) => !profiles.some((profile) => profile.id === id));
  if (missing !== undefined) return { ok: false, message: "A profile this feature was built on no longer exists in its sketch. Edit the sketch to close it again, or delete the feature." };
  const region = resolveProfileRegion(profiles, feature.profileIds, { includeIslands: feature.kind === "extrude" && feature.edge === undefined });
  if (!region.ok) return { ok: false, message: region.diagnostics[0]?.message ?? "The sketch has no closed profile for this feature." };
  const plane = planeKeyOf(sketch.plane);
  const built = await createGeneralSolidBody({
    profile: region.value.outer,
    plane,
    operation: feature.kind,
    valueMm: Math.abs(feature.valueMm),
    ...(region.value.holes.length === 0 ? {} : { holes: region.value.holes }),
    bodyId: feature.bodyId,
    name: feature.name,
    color,
    ...(feature.edge === undefined ? {} : { edge: feature.edge })
  });
  if (!built.ok) return { ok: false, message: built.message };
  return { ok: true, body: shifted(built.body, NORMALS[plane], extrudeStartOffsetMm(feature)) };
}

/** Rebuilds every solid feature that depends on a sketch feature, in timeline order. */
export async function rebuildDependents(project: WorkbenchProject, sketchFeatureId: string): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  const sketchFeature = history.features.find((feature): feature is DesignSketchFeature => feature.id === sketchFeatureId && feature.kind === "sketch");
  if (sketchFeature === undefined) return [];
  const results: RebuildResult[] = [];
  for (const feature of history.features) {
    if (feature.kind === "sketch" || feature.sketchFeatureId !== sketchFeatureId) continue;
    const existing = project.part.generalBodies?.find((body) => body.id === feature.bodyId);
    const rebuilt = await rebuildSolidFeature(feature, sketchFeature, existing?.color);
    results.push(rebuilt.ok ? { featureId: feature.id, body: rebuilt.body } : { featureId: feature.id, message: rebuilt.message });
  }
  return results;
}
