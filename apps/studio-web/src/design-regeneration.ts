import type { DesignFeature, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchDatumPlane, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { dependentsOf, designOf, isFeatureActive, modifiesBody } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles, resolveProfileRegion } from "../../../packages/workbench-sketch/src/index.js";
import { combineGeneralBodies, createGeneralSolidBody, type SketchPlane } from "./general-modeling.js";

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

/** Builds the solid a feature describes from the sketch snapshot it is based on. For a join or cut this is the tool solid. */
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

/** The steps that shape a body, in timeline order: the step that made it, then its joins and cuts. */
function stepsOfBody(history: ReturnType<typeof designOf>, bodyId: string): readonly DesignSolidFeature[] {
  return history.features.filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch" && feature.bodyId === bodyId);
}

/**
 * Replays one body: builds it from the step that made it, then applies each live join and cut in order. A step that
 * cannot be applied is reported and skipped, so the body shows what the other steps make. Steps that are suppressed, rolled
 * back or built on a suppressed sketch are left out, which is what makes suppress and rollback change the shape.
 *
 * A body with no joins or cuts is always rebuilt, even while it is off, so its stored shape never goes stale; a body with
 * joins or cuts is only replayed while its own step is live.
 */
export async function replayBody(project: WorkbenchProject, bodyId: string): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  const steps = stepsOfBody(history, bodyId);
  const base = steps.find((step) => !modifiesBody(step));
  if (base === undefined) return [];
  const chained = steps.some(modifiesBody);
  if (chained && !isFeatureActive(history, base.id)) return [];
  const existing = project.part.generalBodies?.find((body) => body.id === bodyId);
  const outcomes = new Map<string, RebuildResult>();
  let current: GeneralSolidBody | undefined;
  for (const step of steps) {
    // A lone body is rebuilt whatever its state; the steps of a chain only while they are live.
    if (chained && !isFeatureActive(history, step.id)) continue;
    const sketchFeature = history.features.find((candidate): candidate is DesignSketchFeature => candidate.id === step.sketchFeatureId && candidate.kind === "sketch");
    if (sketchFeature === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The sketch this feature was built on is no longer in the timeline." }); continue; }
    const modifies = modifiesBody(step);
    const built = await rebuildSolidFeature(modifies ? { ...step, bodyId: `${step.id}:tool` } : step, sketchFeature, existing?.color);
    if (!built.ok) { outcomes.set(step.id, { featureId: step.id, message: built.message }); continue; }
    if (!modifies) { current = built.body; outcomes.set(step.id, { featureId: step.id }); continue; }
    if (current === undefined) { outcomes.set(step.id, { featureId: step.id, message: "The solid this step changes could not be built, so there is nothing to modify." }); continue; }
    const combined = await combineGeneralBodies({ target: current, tool: built.body, mode: step.operation, bodyId, name: current.name });
    if (!combined.ok) { outcomes.set(step.id, { featureId: step.id, message: combined.message }); continue; }
    current = { ...combined.body, color: current.color };
    outcomes.set(step.id, { featureId: step.id });
  }
  // The final shape travels on the step that made the body; the other steps only report whether they applied.
  if (current !== undefined) outcomes.set(base.id, { ...(outcomes.get(base.id) ?? { featureId: base.id }), body: current });
  return steps.flatMap((step) => { const outcome = outcomes.get(step.id); return outcome === undefined ? [] : [outcome]; });
}

/** Replays every body of the timeline. */
export async function replayAllBodies(project: WorkbenchProject): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  const bodyIds = [...new Set(history.features.filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId))];
  const results: RebuildResult[] = [];
  for (const bodyId of bodyIds) results.push(...await replayBody(project, bodyId));
  return results;
}

/** Rebuilds the bodies that depend on a sketch feature, with their joins and cuts, in timeline order. */
export async function rebuildDependents(project: WorkbenchProject, sketchFeatureId: string): Promise<readonly RebuildResult[]> {
  const history = designOf(project);
  if (!history.features.some((feature) => feature.id === sketchFeatureId && feature.kind === "sketch")) return [];
  const affected = new Set(dependentsOf(history, sketchFeatureId).filter((feature): feature is DesignSolidFeature => feature.kind !== "sketch").map((feature) => feature.bodyId));
  const results: RebuildResult[] = [];
  for (const bodyId of affected) results.push(...await replayBody(project, bodyId));
  return results;
}

/** Whether any step of the design joins or cuts, which is when a change to the timeline has to be replayed rather than just shown or hidden. */
export function hasModifiers(project: WorkbenchProject): boolean {
  return designOf(project).features.some((feature: DesignFeature) => modifiesBody(feature));
}
