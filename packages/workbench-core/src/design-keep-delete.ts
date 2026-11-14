import { dependentsOf, designOf, isSplitPieceOf, modifiesBody, withHistory, type DesignChange } from "./design.js";
import { canRepairSketch, isMarkedBroken, usesSketchGeometry } from "./design-references.js";
import type { DesignFeature, DesignHistory, DesignSketchFeature, DesignSolidFeature, WorkbenchProject } from "./types.js";

/**
 * Delete that keeps what is built on the step (the way a person expects a timeline to behave): the steps stay, turn red with the reason
 * ("Sketch 2 was deleted, so Extrude 1 has no profile to build from") and can be repaired or deleted one by one. The other delete
 * (`deleteDesignFeature`) still removes the step together with everything built on it, and is what an operation without
 * `keepDependents` does. This module holds the rules as pure functions: what breaks, what the message says, what a repair fixes.
 */

/** One step that stays but can no longer be rebuilt once the deleted step is gone. */
export interface BrokenMark {
  readonly id: string;
  readonly name: string;
  readonly kind: DesignFeature["kind"];
  /** True when the step names the deleted step itself; false when it only follows a step that does. */
  readonly direct: boolean;
  /** A short clause for the confirmation list: "has no sketch to build from". */
  readonly brief: string;
  /** The health message stored on the step (at most 400 characters). */
  readonly message: string;
}

export interface KeepImpact {
  readonly featureId: string;
  readonly featureName: string;
  /** The steps that stay and turn red, in timeline order. Empty when nothing is built on the step. */
  readonly marks: readonly BrokenMark[];
  /** Solids that leave the model: the body of a deleted new-body step and its split pieces. A body whose step stays is kept as it was. */
  readonly removedBodyNames: readonly string[];
}

const clip = (text: string): string => (text.length <= 400 ? text : `${text.slice(0, 397)}...`);

/** What each kept step lost, worked out against the timeline as it stands before the delete. */
export function keepImpact(project: WorkbenchProject, featureId: string): KeepImpact | undefined {
  const history = project.design;
  const deleted = history?.features.find((candidate) => candidate.id === featureId);
  if (history === undefined || deleted === undefined) return undefined;
  const dependents = dependentsOf(history, featureId);
  const deletedIsSketch = deleted.kind === "sketch";
  const deletedBodyId = deleted.kind !== "sketch" && !modifiesBody(deleted) ? deleted.bodyId : undefined;
  const direct = new Map<string, { readonly brief: string; readonly message: string }>();
  for (const step of dependents) {
    if (step.kind === "sketch") continue;
    const lost = directLoss(step, deleted, deletedIsSketch, deletedBodyId);
    if (lost !== undefined) direct.set(step.id, lost);
  }
  const firstDirect = dependents.find((step) => direct.has(step.id));
  const marks = dependents.map((step): BrokenMark => {
    const own = direct.get(step.id);
    if (own !== undefined) return { id: step.id, name: step.name, kind: step.kind, direct: true, brief: own.brief, message: clip(own.message) };
    const cause = firstDirect?.name;
    return {
      id: step.id, name: step.name, kind: step.kind, direct: false,
      brief: cause === undefined ? `was built on ${deleted.name}` : `follows ${cause}, which cannot be rebuilt`,
      message: clip(cause === undefined
        ? `${deleted.name} was deleted, and ${step.name} was built on it. Delete this step, or undo the delete.`
        : `${cause} cannot be rebuilt because ${deleted.name} was deleted, so ${step.name} cannot be applied. Repair ${cause} first, or delete this step.`)
    };
  });
  const goneBodies = deletedBodyId === undefined ? [] : (project.part.generalBodies ?? []).filter((body) => body.id === deletedBodyId || isSplitPieceOf(deletedBodyId, body.id)).map((body) => body.name);
  return { featureId, featureName: deleted.name, marks, removedBodyNames: goneBodies };
}

function directLoss(step: DesignSolidFeature, deleted: DesignFeature, deletedIsSketch: boolean, deletedBodyId: string | undefined): { readonly brief: string; readonly message: string } | undefined {
  const tail = " Delete it, or undo the delete (Ctrl+Z).";
  if (deletedIsSketch) {
    if (step.sketchFeatureId === deleted.id && usesSketchGeometry(step)) {
      return canRepairSketch(step)
        ? { brief: "has no sketch to build from; edit it to pick another sketch", message: `${deleted.name} was deleted, so ${step.name} has no profile to build from. Edit it to choose another sketch, or delete it.` }
        : { brief: "has no sketch to build from; delete it and build it again", message: `${deleted.name} was deleted, so ${step.name} has no profile to build from. Delete it and build it again from another sketch.` };
    }
    if (step.sweepPath?.sketchFeatureId === deleted.id) return { brief: "lost the path it follows", message: `${deleted.name} was deleted, so ${step.name} lost the path it follows.${tail}` };
    if (step.loftSecondarySketchFeatureId === deleted.id) return { brief: "lost its second profile", message: `${deleted.name} was deleted, so ${step.name} lost its second profile.${tail}` };
    return undefined;
  }
  if (deletedBodyId === undefined) return undefined;
  if (modifiesBody(step) && step.bodyId === deletedBodyId) return { brief: "has no solid to change", message: `${deleted.name} was deleted, so ${step.name} has no solid to change.${tail}` };
  if (step.kind === "pattern" && step.pattern?.sourceBodyId === deletedBodyId) return { brief: "has no body to repeat", message: `${deleted.name} was deleted, so ${step.name} has no body to repeat.${tail}` };
  if (step.indentToolBodyId === deletedBodyId || (step.combineToolBodyIds ?? []).includes(deletedBodyId)) return { brief: "lost the body it used as a tool", message: `${deleted.name} was deleted, so ${step.name} lost the body it used as a tool.${tail}` };
  return undefined;
}

/**
 * Deletes one step and leaves everything built on it in the timeline, marked as needing attention with the reason. The solid of a deleted
 * new-body step leaves the model; the solid of a step whose sketch went stays as it was (the browser shows it out of date). One project
 * revision, so one Undo puts everything back.
 */
export function deleteKeepingDependents(project: WorkbenchProject, featureId: string): DesignChange {
  const history = designOf(project);
  const impact = keepImpact(project, featureId);
  if (impact === undefined) return { ok: false, diagnostics: [{ code: "BROKEN_REFERENCE", message: "The timeline feature does not exist.", relatedIds: [featureId], recovery: "Refresh the project and pick an existing feature." }] };
  const index = history.features.findIndex((candidate) => candidate.id === featureId);
  const deleted = history.features[index]!;
  const marks = new Map(impact.marks.map((mark) => [mark.id, mark.message]));
  const features = history.features.filter((candidate) => candidate.id !== featureId).map((candidate): DesignFeature => {
    const message = marks.get(candidate.id);
    return message === undefined ? candidate : { ...candidate, health: { message } } as DesignFeature;
  });
  const next: DesignHistory = {
    ...history,
    features,
    rollbackIndex: index < history.rollbackIndex ? history.rollbackIndex - 1 : history.rollbackIndex,
    editingSketchId: history.editingSketchId === featureId ? null : history.editingSketchId
  };
  const goneBodyId = deleted.kind !== "sketch" && !modifiesBody(deleted) ? deleted.bodyId : undefined;
  const bodies = (project.part.generalBodies ?? []).filter((body) => goneBodyId === undefined || (body.id !== goneBodyId && !isSplitPieceOf(goneBodyId, body.id)));
  const kept = impact.marks.length;
  return {
    ok: true,
    value: {
      project: withHistory({ ...project, part: { ...project.part, generalBodies: bodies } }, next),
      changedIds: [featureId, ...impact.marks.map((mark) => mark.id)],
      summary: `Deleted ${deleted.name}${kept === 0 ? "" : `; ${kept} step${kept === 1 ? "" : "s"} built on it stay${kept === 1 ? "s" : ""} in the timeline and need attention`}.`
    }
  };
}

/** The sketches a broken step could be rebuilt from: those that come before it in the timeline, oldest first. */
export function repairCandidates(history: DesignHistory, featureId: string): readonly DesignSketchFeature[] {
  const index = history.features.findIndex((candidate) => candidate.id === featureId);
  if (index < 0) return [];
  return history.features.slice(0, index).filter((candidate): candidate is DesignSketchFeature => candidate.kind === "sketch");
}

/** The sketch a step names when that sketch is no longer in the timeline, or undefined when the step is not waiting for a sketch. */
export function lostSketchOf(history: DesignHistory, feature: DesignFeature): string | undefined {
  if (feature.kind === "sketch" || !usesSketchGeometry(feature)) return undefined;
  return history.features.some((candidate) => candidate.id === feature.sketchFeatureId && candidate.kind === "sketch") ? undefined : feature.sketchFeatureId;
}

export type SketchRepair =
  | { readonly ok: true; readonly feature: DesignSolidFeature; /** Something the person should know changed with the repair. */ readonly note?: string }
  | { readonly ok: false; readonly message: string };

/**
 * The step pointed at another sketch. The profile choice and the revolve axis named curves of the old sketch, so they go back to their
 * defaults (the outer profile with its holes; the sketch's Y axis). The mark that said the step was broken goes too; the rebuild that
 * follows says whether the new sketch works. Only an extrude or revolve whose sketch is gone, and a sketch that comes before it, qualify.
 */
export function repairSketchReference(history: DesignHistory, feature: DesignSolidFeature, sketchId: string): SketchRepair {
  if (!canRepairSketch(feature)) return { ok: false, message: `${feature.name} cannot take another sketch from this panel. Delete it and build it again.` };
  if (lostSketchOf(history, feature) === undefined) return { ok: false, message: `${feature.name} still has its sketch.` };
  const target = repairCandidates(history, feature.id).find((candidate) => candidate.id === sketchId);
  if (target === undefined) return { ok: false, message: `${sketchId} is not a sketch that comes before ${feature.name}, so it cannot be used for it.` };
  const { health: _broken, revolveAxis, ...rest } = feature;
  const resetAxis = revolveAxis !== undefined && revolveAxis.kind === "sketch-line";
  const kept = revolveAxis === undefined || resetAxis ? {} : { revolveAxis };
  return {
    ok: true,
    feature: { ...rest, ...kept, sketchFeatureId: target.id, profileIds: [] },
    ...(resetAxis ? { note: `${feature.name} turned about a line of the deleted sketch; it now turns about the sketch's Y axis.` } : {})
  };
}

/** Whether a step is waiting for a repair of the kind this module makes (a sketch is gone, or it is marked broken). */
export function needsRepair(history: DesignHistory, feature: DesignFeature): boolean {
  return feature.kind !== "sketch" && (isMarkedBroken(feature) || lostSketchOf(history, feature) !== undefined);
}
