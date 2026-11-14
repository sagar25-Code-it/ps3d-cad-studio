import { dependentsOf, isSplitPieceOf, modifiesBody } from "./design.js";
import type { DesignFeature, DesignHistory, DesignSolidFeature, WorkbenchProject } from "./types.js";

/**
 * What deleting a timeline step takes with it, worked out before anything is removed so the person can be told first. The
 * rule is the one `delete-design-feature` applies (`dependentsOf`): steps built on a sketch, joins and cuts of a body whose
 * own step goes, copies of a removed body, and steps that used a removed body as a tool. This module only reads.
 */
export interface DeleteImpactItem {
  readonly id: string;
  readonly name: string;
  readonly kind: DesignFeature["kind"];
  /** Why this step goes, in one clause: "built on Sketch 1", "changes the body made by Extrude 1". */
  readonly reason: string;
}

export interface DeleteImpact {
  readonly featureId: string;
  readonly featureName: string;
  readonly featureKind: DesignFeature["kind"];
  /** The other steps that go with it, in timeline order. Empty when the step stands alone. */
  readonly dependents: readonly DeleteImpactItem[];
  /** The names of the solids that disappear from the model (the bodies of removed new-body steps and their split pieces). */
  readonly removedBodyNames: readonly string[];
}

const nameOf = (history: DesignHistory, id: string): string => history.features.find((feature) => feature.id === id)?.name ?? "a step";

/** The step that made a body: the first step that is not a join, cut or edit of it. */
function baseStepName(history: DesignHistory, bodyId: string, closure: ReadonlySet<string>): string | undefined {
  const base = history.features.find((other): other is DesignSolidFeature => other.kind !== "sketch" && other.bodyId === bodyId && !modifiesBody(other) && closure.has(other.id));
  return base?.name;
}

function reasonFor(history: DesignHistory, step: DesignSolidFeature, closure: ReadonlySet<string>): string {
  if (closure.has(step.sketchFeatureId)) return `built on ${nameOf(history, step.sketchFeatureId)}`;
  if (step.sweepPath !== undefined && closure.has(step.sweepPath.sketchFeatureId)) return `follows the path in ${nameOf(history, step.sweepPath.sketchFeatureId)}`;
  if (step.loftSecondarySketchFeatureId !== undefined && closure.has(step.loftSecondarySketchFeatureId)) return `takes its second profile from ${nameOf(history, step.loftSecondarySketchFeatureId)}`;
  if (step.kind === "pattern" && step.pattern !== undefined) {
    const source = baseStepName(history, step.pattern.sourceBodyId, closure);
    if (source !== undefined) return `repeats the body made by ${source}`;
  }
  const own = modifiesBody(step) ? baseStepName(history, step.bodyId, closure) : undefined;
  if (own !== undefined) return `changes the body made by ${own}`;
  const toolBodies = [...(step.indentToolBodyId === undefined ? [] : [step.indentToolBodyId]), ...(step.combineToolBodyIds ?? [])];
  for (const bodyId of toolBodies) {
    const tool = baseStepName(history, bodyId, closure);
    if (tool !== undefined) return `uses the body made by ${tool} as a tool`;
  }
  return "depends on it";
}

/** What deleting `featureId` removes, or undefined when there is no such step. */
export function deleteImpact(project: WorkbenchProject, featureId: string): DeleteImpact | undefined {
  const history = project.design;
  const feature = history?.features.find((candidate) => candidate.id === featureId);
  if (history === undefined || feature === undefined) return undefined;
  const dependents = dependentsOf(history, featureId);
  const closure = new Set<string>([featureId, ...dependents.map((dependent) => dependent.id)]);
  const items = dependents.map((dependent): DeleteImpactItem => ({
    id: dependent.id,
    name: dependent.name,
    kind: dependent.kind,
    reason: dependent.kind === "sketch" ? "depends on it" : reasonFor(history, dependent, closure)
  }));
  // Only a body's own (new-body) step takes the body with it; a join or cut that goes leaves the body in place.
  const goneBodies = new Set(history.features
    .filter((candidate): candidate is DesignSolidFeature => closure.has(candidate.id) && candidate.kind !== "sketch" && !modifiesBody(candidate))
    .map((candidate) => candidate.bodyId));
  const removedBodyNames = (project.part.generalBodies ?? [])
    .filter((body) => goneBodies.has(body.id) || [...goneBodies].some((root) => isSplitPieceOf(root, body.id)))
    .map((body) => body.name);
  return { featureId, featureName: feature.name, featureKind: feature.kind, dependents: items, removedBodyNames };
}

/** The sentence the confirmation opens with: what the person asked for and how much more goes. */
export function deleteImpactHeadline(impact: DeleteImpact): string {
  const count = impact.dependents.length;
  return count === 0
    ? `Delete ${impact.featureName}.`
    : `Deleting ${impact.featureName} also deletes ${count} other step${count === 1 ? "" : "s"} that ${count === 1 ? "depends" : "depend"} on it.`;
}
