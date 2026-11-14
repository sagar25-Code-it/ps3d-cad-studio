import { designOf, isFeatureActive, withHistory, type DesignChange } from "./design.js";
import type { DesignFeature, DesignHistory, DesignSketchFeature, WorkbenchProject } from "./types.js";

/**
 * HS-24: which timeline sketches are drawn in the model. A sketch keeps an explicit `visible` once its eye has been clicked. Until then
 * it follows the default a designer expects: a finished sketch is shown while nothing is built on it, and is put away once a step
 * (an extrude, a revolve, a sweep path, a loft's second profile) uses it. A suppressed sketch, or one after the rollback marker, is
 * not part of the model and is not drawn whatever its eye says.
 */

/** The steps built on a sketch: its profile steps, and the steps that take a sweep path or a loft's second profile from it. */
export function stepsUsingSketch(history: DesignHistory, sketchId: string): readonly DesignFeature[] {
  return history.features.filter((feature) => feature.kind !== "sketch"
    && (feature.sketchFeatureId === sketchId || feature.sweepPath?.sketchFeatureId === sketchId || feature.loftSecondarySketchFeatureId === sketchId));
}

/** What the eye of the sketch shows: its own choice, or the default when it has made none. */
export function sketchEyeShown(history: DesignHistory, feature: DesignSketchFeature): boolean {
  return feature.visible ?? stepsUsingSketch(history, feature.id).length === 0;
}

/** Whether the sketch's curves are drawn in the model right now: its eye is on and it takes part in the model. */
export function isSketchShown(history: DesignHistory, feature: DesignSketchFeature): boolean {
  return sketchEyeShown(history, feature) && isFeatureActive(history, feature.id);
}

/** Records the choice of a sketch's eye. */
export function setDesignSketchVisible(project: WorkbenchProject, featureId: string, visible: boolean): DesignChange {
  const history = designOf(project);
  const feature = history.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) return { ok: false, diagnostics: [{ code: "BROKEN_REFERENCE", message: "The sketch is not in the timeline.", relatedIds: [featureId], recovery: "Refresh the project and pick an existing sketch." }] };
  if (feature.kind !== "sketch") return { ok: false, diagnostics: [{ code: "INVALID_OPERATION", message: `${feature.name} is a solid step, not a sketch. A solid is shown or hidden with the eye on its body.`, relatedIds: [featureId], recovery: "Pick a sketch in the timeline." }] };
  const next: DesignHistory = { ...history, features: history.features.map((candidate): DesignFeature => candidate.id === featureId ? { ...feature, visible } : candidate) };
  return { ok: true, value: { project: withHistory(project, next), changedIds: [featureId], summary: `${visible ? "Showed" : "Hid"} ${feature.name} in the model.` } };
}
