import { designOf, isHealthNote, isReferenceFeature, type DesignFeature, type WorkbenchProject } from "../../workbench-core/src/index.js";

/**
 * What the design timeline says about the health of a project: steps whose last rebuild failed, steps that point at a sketch or a solid
 * that is gone, a rolled-back timeline, suppressed steps. Plain facts read from the project; nothing is rebuilt here.
 */

export interface TimelineFinding {
  readonly id: string;
  readonly workspace: "sketch" | "part";
  readonly severity: "info" | "warning" | "error";
  readonly title: string;
  readonly message: string;
  readonly recovery: string;
  readonly relatedIds: readonly string[];
  readonly evidence: string;
}

export interface TimelineMetrics {
  readonly timelineSteps: number;
  readonly timelineSketches: number;
  readonly timelineSolids: number;
  readonly timelineFailedSteps: number;
}

const KIND_LABEL = (feature: DesignFeature): string => (feature.kind === "sketch" ? "sketch" : feature.kind);

export function timelineMetrics(project: WorkbenchProject): TimelineMetrics {
  const features = designOf(project).features;
  return {
    timelineSteps: features.length,
    timelineSketches: features.filter((feature) => feature.kind === "sketch").length,
    timelineSolids: features.filter((feature) => feature.kind !== "sketch" && !isReferenceFeature(feature)).length,
    timelineFailedSteps: features.filter((feature) => feature.health !== undefined && !isHealthNote(feature.health.message)).length
  };
}

export function timelineFindings(project: WorkbenchProject): readonly TimelineFinding[] {
  const history = designOf(project);
  const findings: TimelineFinding[] = [];
  const sketchIds = new Set(history.features.filter((feature) => feature.kind === "sketch").map((feature) => feature.id));
  const bodyIds = new Set((project.part.generalBodies ?? []).map((body) => body.id));
  for (const feature of history.features) {
    const workspace = feature.kind === "sketch" ? "sketch" : "part";
    if (feature.health !== undefined) {
      const note = isHealthNote(feature.health.message);
      findings.push({
        id: `health:timeline-${note ? "note" : "failed"}:${feature.id}`,
        workspace,
        severity: note ? "info" : "error",
        title: note ? `${feature.name} was applied with a note` : `${feature.name} could not be rebuilt`,
        message: feature.health.message,
        recovery: feature.kind === "sketch"
          ? `Reopen the sketch with edit-design-sketch (featureId ${feature.id}), repair it and commit it again.`
          : isReferenceFeature(feature)
            ? `Change the step with update-design-reference (it is a construction plane, axis, point or primitive) so what it refers to exists.`
            : `Reopen its sketch (${feature.sketchFeatureId}) with edit-design-sketch and repair what the step refers to, or change the step with update-design-solid; then run regenerate-design.`,
        relatedIds: feature.kind === "sketch" || isReferenceFeature(feature) ? [feature.id] : [feature.id, feature.sketchFeatureId],
        evidence: `${KIND_LABEL(feature)} step ${feature.id}`
      });
    }
    if (feature.kind !== "sketch" && !isReferenceFeature(feature)) {
      if (!sketchIds.has(feature.sketchFeatureId)) {
        findings.push({ id: `health:timeline-orphan:${feature.id}`, workspace: "part", severity: "error", title: `${feature.name} has lost its sketch`, message: `The ${feature.kind} step ${feature.id} is built on ${feature.sketchFeatureId}, which is no longer in the timeline.`, recovery: "Restore the sketch (undo) or delete the step.", relatedIds: [feature.id, feature.sketchFeatureId], evidence: `${feature.kind} step ${feature.id}` });
      }
      if (!feature.suppressed && feature.operation === undefined && !bodyIds.has(feature.bodyId)) {
        findings.push({ id: `health:timeline-no-body:${feature.id}`, workspace: "part", severity: "warning", title: `${feature.name} has no solid`, message: `The step ${feature.id} owns the body ${feature.bodyId}, which the part does not hold.`, recovery: "Run regenerate-design to rebuild the solids from the timeline.", relatedIds: [feature.id, feature.bodyId], evidence: `${feature.kind} step ${feature.id}` });
      }
    }
  }
  const suppressed = history.features.filter((feature) => feature.suppressed);
  if (suppressed.length > 0) {
    findings.push({ id: "health:timeline-suppressed", workspace: "part", severity: "info", title: "Timeline steps are suppressed", message: `${suppressed.length} step${suppressed.length === 1 ? " is" : "s are"} suppressed and skipped when the solids are rebuilt.`, recovery: "Unsuppress a step with set-design-feature-suppressed when it should count again.", relatedIds: suppressed.map((feature) => feature.id).slice(0, 40), evidence: suppressed.map((feature) => feature.name).slice(0, 8).join(" | ") });
  }
  if (history.rollbackIndex < history.features.length) {
    findings.push({ id: "health:timeline-rollback", workspace: "part", severity: "warning", title: "The timeline is rolled back", message: `Only the first ${history.rollbackIndex} of ${history.features.length} steps are active; the later steps are not part of the solids.`, recovery: "Move the rollback marker to the end with set-design-rollback before relying on the solids.", relatedIds: history.features.slice(history.rollbackIndex).map((feature) => feature.id).slice(0, 40), evidence: `rollback at ${history.rollbackIndex}/${history.features.length}` });
  }
  return findings;
}
