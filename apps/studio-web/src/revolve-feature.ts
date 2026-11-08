import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import type { ProfileRegion } from "../../../packages/workbench-sketch/src/index.js";
import { profileOutlineMm } from "../../../packages/workbench-sketch/src/index.js";
import { revolveAxisRelation } from "../../../packages/workbench-geometry/src/index.js";
import type { SketchPlane } from "./general-modeling.js";
import { buildAxisRevolve, prepareRevolve, resolveRevolveAxis } from "./revolve-axis.js";

export type AxisRevolveOutcome =
  | { readonly ok: true; readonly body: GeneralSolidBody; readonly warning?: string }
  | { readonly ok: false; readonly message: string };

/**
 * Builds a revolve about the axis its feature names, or about a sketch Y axis profile that lies on the negative side. Returns undefined when the
 * classic path applies (the sketch Y axis and a profile on its positive side), so every existing revolve builds exactly as before.
 */
export async function revolveAboutChosenAxis(
  feature: DesignSolidFeature,
  sketchFeature: DesignSketchFeature,
  region: ProfileRegion,
  plane: SketchPlane,
  span: { readonly totalDeg: number; readonly startDeg: number },
  color: string,
  bodies?: readonly GeneralSolidBody[]
): Promise<AxisRevolveOutcome | undefined> {
  const resolved = resolveRevolveAxis(feature.revolveAxis, sketchFeature, bodies);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const outline = profileOutlineMm(region.outer.boundary);
  // The classic path: the sketch Y axis with the profile on its positive side (touching it is fine).
  if (resolved.isDefault && revolveAxisRelation(outline) !== "crosses" && outline.every(([x]) => x >= -1e-6)) return undefined;
  if (region.holes.length > 0) return { ok: false, message: "Revolve does not support profiles with holes. Select the outer profile alone." };
  const prepared = prepareRevolve(resolved.axis, region.outer);
  if (!prepared.ok) return prepared;
  const built = await buildAxisRevolve({ feature, prepared: prepared.prepared, plane, totalDeg: span.totalDeg, startDeg: span.startDeg, color });
  if (!built.ok) return built;
  return { ok: true, body: built.body, ...(resolved.note === undefined ? {} : { warning: resolved.note }) };
}
