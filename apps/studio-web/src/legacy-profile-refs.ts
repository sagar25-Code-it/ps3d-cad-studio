import type { DesignSketchFeature, DesignSolidFeature, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, designOf } from "../../../packages/workbench-core/src/index.js";
import { closedShapesOf, detectSketchProfiles, matchProfileRef } from "../../../packages/workbench-sketch/src/index.js";

/**
 * Legacy profile ids.
 *
 * An id a feature stored before regions carried a signature is a bare loop name (`profile:p`): it says which curves bound the profile and
 * nothing about its size or place. While those curves exist it is found again; once a fillet, chamfer, split or trim replaces them there is
 * nothing to tell the regions apart by, and with two or more regions left the feature cannot be rebuilt without guessing.
 *
 * What is guaranteed:
 *  - A bare id is upgraded to a full reference (name, area, centroid, holes) from the sketch snapshot the timeline holds, at the moment that
 *    snapshot is about to be replaced: when the sketch is finished after an edit, before the edit is applied. From then on the feature
 *    survives the fillet, chamfer, split or trim like any other.
 *  - A bare id whose curves are already gone when the file is opened (saved after the edit, by an older build) cannot be recovered: the
 *    feature is reported by name with the reason and what to do, and nothing is guessed. With a single region left it is still used,
 *    with a note.
 */

let serial = 0;

/** Whether a stored profile id is a bare legacy loop name, which carries no size to find the region by. */
export function isLegacyProfileId(id: string): boolean {
  return !/_a-?\d+(?:\.\d+)?_x-?\d+(?:\.\d+)?_y-?\d+(?:\.\d+)?/u.test(id);
}

/**
 * Rewrites the bare ids of the solids built on a sketch into full references, using the sketch as the timeline holds it now. Features whose
 * ids are not legacy, or that cannot be matched, are left as they are. Returns the project (one step per upgraded feature) and the names.
 */
export function upgradeLegacyProfileRefs(project: WorkbenchProject, sketchFeatureId: string): { readonly project: WorkbenchProject; readonly upgraded: readonly string[] } {
  const history = designOf(project);
  const sketchFeature = history.features.find((feature): feature is DesignSketchFeature => feature.id === sketchFeatureId && feature.kind === "sketch");
  if (sketchFeature === undefined) return { project, upgraded: [] };
  const profiles = detectSketchProfiles(sketchFeature.sketch);
  if (profiles.length === 0) return { project, upgraded: [] };
  const shapes = closedShapesOf(profiles);
  let current = project;
  const upgraded: string[] = [];
  for (const feature of history.features) {
    if (feature.kind === "sketch" || feature.sketchFeatureId !== sketchFeatureId || !feature.profileIds.some(isLegacyProfileId)) continue;
    const body = current.part.generalBodies?.find((candidate) => candidate.id === feature.bodyId);
    if (body === undefined) continue;
    let changed = false;
    const profileIds = feature.profileIds.map((id) => {
      if (!isLegacyProfileId(id)) return id;
      const found = matchProfileRef(id, profiles, false) ?? (shapes === undefined ? undefined : matchProfileRef(id, shapes, false));
      if (found === undefined || found.how === "only") return id;
      changed = true;
      return found.profile.id;
    });
    if (!changed) continue;
    const updated: DesignSolidFeature = { ...feature, profileIds };
    serial += 1;
    const applied = applyWorkbenchOperation(current, { kind: "update-design-solid", feature: updated, body, operationId: `operation:ui-legacy-refs-${serial}-${Date.now().toString(36)}`, expectedRevision: current.revision });
    if (!applied.ok) continue;
    current = applied.value.project;
    upgraded.push(feature.name);
  }
  return { project: current, upgraded };
}
