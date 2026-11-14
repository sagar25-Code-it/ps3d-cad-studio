import { baseFeatureOf, designOf, modifiesBody, withHistory, type DesignChange } from "./design.js";
import { isReferenceFeature, referenceNeeds } from "./reference-feature.js";
import type { DesignFeature, DesignHistory, WorkbenchProject } from "./types.js";

/**
 * HS-03: moving a step to another place in the timeline. A step may move wherever everything it was built on still comes before it and
 * everything built on it still comes after it; any other move is refused with the step it would break, by name. The rules here are pure
 * (they read the history only) so the drag handler, the operation and the tests all ask the same question.
 *
 * What a step needs is read from the recorded references, in the order the history has now: the sketch it is built on (and a sweep path or
 * second loft profile), the step that made the body it joins to, cuts or edits, the bodies a pattern copies or a combine / indent takes as
 * tools, a body a "to" extent or a model-edge axis points at, and, for a sketch, the body whose face it lies on or whose edges it projects.
 * Two steps that only share a body (a fillet and a hole in the same plate) are independent: they may swap, and the rebuild reports a step
 * whose edges no longer exist instead of the move being refused.
 */
export interface StepNeed {
  /** The step that has to stay before. */
  readonly id: string;
  /** How the step uses it, as a verb phrase that reads after "it": "is built on", "changes the body made by". */
  readonly verb: string;
}

export interface ReorderProblem {
  readonly message: string;
  readonly recovery: string;
  /** The steps the move would put in the wrong order: the moved step and the one it conflicts with. */
  readonly relatedIds: readonly string[];
}

const nameOf = (history: DesignHistory, id: string): string => history.features.find((feature) => feature.id === id)?.name ?? "a step";

/** The steps `feature` needs to come before it, worked out against `history` as it stands. */
export function stepNeeds(history: DesignHistory, feature: DesignFeature): readonly StepNeed[] {
  const needs: StepNeed[] = [];
  const add = (id: string | undefined, verb: string): void => {
    if (id === undefined || id === feature.id || needs.some((need) => need.id === id && need.verb === verb)) return;
    if (history.features.some((candidate) => candidate.id === id)) needs.push({ id, verb });
  };
  const bodyMaker = (bodyId: string): string | undefined => {
    const base = baseFeatureOf(history, bodyId);
    return base === undefined || base.id === feature.id ? undefined : base.id;
  };
  const position = history.features.findIndex((candidate) => candidate.id === feature.id);
  // A sketch placed on a construction plane, a plane, axis or point built on others, and a pattern about a construction axis or plane.
  for (const need of referenceNeeds(history, feature, (bodyId) => baseFeatureOf(history, bodyId))) add(need.id, need.verb);
  if (isReferenceFeature(feature)) return needs;
  if (feature.kind === "sketch") {
    const face = feature.sketch.planeFace;
    // A sketch on a face lies on the body as it was when the sketch was drawn: every step of that body before it made the face.
    if (face !== undefined) {
      for (const step of history.features.slice(0, Math.max(position, 0))) if (step.kind !== "sketch" && step.bodyId === face.bodyId) add(step.id, "is drawn on a face of the body made by");
    }
    for (const projection of feature.sketch.projections ?? []) {
      for (const step of history.features.slice(0, Math.max(position, 0))) if (step.kind !== "sketch" && step.bodyId === projection.bodyId) add(step.id, "projects edges of the body made by");
    }
    for (const constraint of feature.sketch.constraints) {
      if (constraint.pierce?.kind === "body-edge") add(bodyMaker(constraint.pierce.bodyId), "is pierced by an edge of the body made by");
    }
    return needs;
  }
  add(feature.sketchFeatureId, "is built on");
  add(feature.sweepPath?.sketchFeatureId, "follows the path in");
  add(feature.loftSecondarySketchFeatureId, "takes its second profile from");
  if (modifiesBody(feature)) add(bodyMaker(feature.bodyId), "changes the body made by");
  if (feature.extentTarget !== undefined && feature.extentTarget.bodyId !== feature.bodyId) add(bodyMaker(feature.extentTarget.bodyId), "reaches as far as the body made by");
  if (feature.revolveAxis?.kind === "model-edge") add(bodyMaker(feature.revolveAxis.bodyId), "turns about an edge of the body made by");
  if (feature.kind === "pattern" && feature.pattern !== undefined) {
    add(bodyMaker(feature.pattern.sourceBodyId), "repeats the body made by");
    for (const id of feature.pattern.featureIds ?? []) add(id, "repeats");
    // The copies of one pattern keep their order: copy 2 is laid out after copy 1.
    for (const step of history.features.slice(0, Math.max(position, 0))) {
      if (step.kind !== "sketch" && step.pattern?.groupId === feature.pattern.groupId) add(step.id, "continues the pattern of");
    }
  }
  if (feature.indentToolBodyId !== undefined) add(bodyMaker(feature.indentToolBodyId), "uses the body made by");
  for (const toolId of feature.combineToolBodyIds ?? []) add(bodyMaker(toolId), "uses the body made by");
  return needs;
}

/** The steps (by ID, in timeline order) that need `featureId` to stay before them. */
export function stepsNeeding(history: DesignHistory, featureId: string): readonly { readonly id: string; readonly verb: string }[] {
  const found: { readonly id: string; readonly verb: string }[] = [];
  for (const feature of history.features) {
    const need = stepNeeds(history, feature).find((candidate) => candidate.id === featureId);
    if (need !== undefined) found.push({ id: feature.id, verb: need.verb });
  }
  return found;
}

/** `history.features` with the step moved so that it ends up at `toIndex` (0 to length - 1). */
export function movedOrder(features: readonly DesignFeature[], featureId: string, toIndex: number): readonly DesignFeature[] {
  const from = features.findIndex((feature) => feature.id === featureId);
  if (from < 0) return features;
  const rest = features.filter((feature) => feature.id !== featureId);
  return [...rest.slice(0, toIndex), features[from]!, ...rest.slice(toIndex)];
}

/**
 * Whether the step can move to `toIndex` (the place it ends up in, counted from 0). Returns what stops it, or undefined when the move is
 * allowed. A move that leaves the order as it is is not a move and is refused too, so a caller never records a change that changed nothing.
 */
export function reorderProblem(history: DesignHistory, featureId: string, toIndex: number): ReorderProblem | undefined {
  const from = history.features.findIndex((feature) => feature.id === featureId);
  if (from < 0) return { message: "The timeline step to move does not exist.", recovery: "Refresh the project and pick an existing step.", relatedIds: [featureId] };
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= history.features.length) return { message: "That position is outside the timeline.", recovery: "Drop the step between two steps of the timeline.", relatedIds: [featureId] };
  if (toIndex === from) return { message: `${nameOf(history, featureId)} is already there.`, recovery: "Drop the step at a different place.", relatedIds: [featureId] };
  const moved = history.features[from]!;
  const order = movedOrder(history.features, featureId, toIndex);
  const at = (id: string): number => order.findIndex((feature) => feature.id === id);
  if (toIndex < from) {
    // Moving earlier can only separate the step from what it was built on.
    for (const need of stepNeeds(history, moved)) {
      if (at(need.id) > at(featureId)) {
        return {
          message: `${moved.name} cannot move before ${nameOf(history, need.id)}: it ${need.verb} ${nameOf(history, need.id)}.`,
          recovery: `Drop it after ${nameOf(history, need.id)}, or edit ${moved.name} so it uses something that comes earlier.`,
          relatedIds: [featureId, need.id]
        };
      }
    }
  } else {
    // Moving later can only separate the step from the steps built on it.
    for (const user of stepsNeeding(history, featureId)) {
      if (at(user.id) < at(featureId)) {
        return {
          message: `${moved.name} cannot move after ${nameOf(history, user.id)}: ${nameOf(history, user.id)} ${user.verb} ${moved.name}.`,
          recovery: `Drop it before ${nameOf(history, user.id)}, or delete ${nameOf(history, user.id)} first.`,
          relatedIds: [featureId, user.id]
        };
      }
    }
  }
  return undefined;
}

/** Every place (final index) the step may be dropped, the one it is at excluded. For drawing the drop slots that are open. */
export function reorderTargets(history: DesignHistory, featureId: string): readonly number[] {
  const targets: number[] = [];
  for (let index = 0; index < history.features.length; index += 1) {
    if (reorderProblem(history, featureId, index) === undefined) targets.push(index);
  }
  return targets;
}

/**
 * Where the rollback marker sits after a step moved. The marker stays between the same two steps; the moved step is on whichever side of
 * it its new place says. Dropped right at the marker it stays on the side it came from, so a step only turns on or off by crossing it.
 */
export function markerAfterMove(history: DesignHistory, featureId: string, toIndex: number): number {
  const from = history.features.findIndex((feature) => feature.id === featureId);
  const wasActive = from < history.rollbackIndex;
  const withoutMoved = history.rollbackIndex - (wasActive ? 1 : 0);
  if (toIndex < withoutMoved) return withoutMoved + 1;
  if (toIndex > withoutMoved) return withoutMoved;
  return withoutMoved + (wasActive ? 1 : 0);
}

/** Moves one step to `toIndex`, keeping the rollback marker between the same two steps. The caller rebuilds the solids afterwards (`regenerate-design`). */
export function moveDesignFeature(project: WorkbenchProject, featureId: string, toIndex: number): DesignChange {
  const history = designOf(project);
  const problem = reorderProblem(history, featureId, toIndex);
  if (problem !== undefined) return { ok: false, diagnostics: [{ code: "INVALID_OPERATION", message: problem.message, relatedIds: problem.relatedIds, recovery: problem.recovery }] };
  const moved = history.features.find((feature) => feature.id === featureId)!;
  const next: DesignHistory = { ...history, features: movedOrder(history.features, featureId, toIndex), rollbackIndex: markerAfterMove(history, featureId, toIndex) };
  return { ok: true, value: { project: withHistory(project, next), changedIds: [featureId], summary: `Moved ${moved.name} to step ${toIndex + 1} of ${history.features.length}.` } };
}
