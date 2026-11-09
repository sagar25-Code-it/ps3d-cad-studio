import { designOf, isHealthNote, type DesignFeature, type WorkbenchProject } from "../../workbench-core/src/index.js";

const MAX_LISTED = 200;

/**
 * The design timeline as ps3d_inspect_project reports it: every step with the ids the recipes refer to (sketch features to build on, solid
 * bodies to join or cut), its plane or distance, and the reason when its last rebuild failed. A caller can pick the next call from this
 * without opening the whole project.
 */
export function timelineSummary(project: WorkbenchProject): Readonly<Record<string, unknown>> {
  const history = designOf(project);
  const bodies = project.part.generalBodies ?? [];
  const describe = (feature: DesignFeature): Readonly<Record<string, unknown>> => {
    const base = { id: feature.id, name: feature.name, kind: feature.kind, suppressed: feature.suppressed };
    const health = feature.health === undefined ? {} : { health: { message: feature.health.message, failed: !isHealthNote(feature.health.message) } };
    if (feature.kind === "sketch") {
      return { ...base, plane: feature.sketch.plane, ...(feature.sketch.planeOffsetMm === undefined ? {} : { offsetMm: feature.sketch.planeOffsetMm }), entities: feature.sketch.entities.length, constraints: feature.sketch.constraints.length, ...health };
    }
    return { ...base, sketchFeatureId: feature.sketchFeatureId, valueMm: feature.valueMm, bodyId: feature.bodyId, ...(feature.operation === undefined ? {} : { operation: feature.operation }), ...health };
  };
  return {
    steps: history.features.length,
    rollbackIndex: history.rollbackIndex,
    editingSketchId: history.editingSketchId,
    sketchFeatureIds: history.features.filter((feature) => feature.kind === "sketch").map((feature) => feature.id).slice(0, MAX_LISTED),
    failedFeatureIds: history.features.filter((feature) => feature.health !== undefined && !isHealthNote(feature.health.message)).map((feature) => feature.id).slice(0, MAX_LISTED),
    features: history.features.slice(0, MAX_LISTED).map(describe),
    truncated: history.features.length > MAX_LISTED,
    bodies: bodies.slice(0, MAX_LISTED).map((body) => ({ id: body.id, name: body.name, visible: body.visible, triangles: body.indices.length / 3 })),
    parameters: (history.parameters ?? []).slice(0, MAX_LISTED).map((parameter) => ({ name: parameter.name, expression: parameter.expression, unit: parameter.unit }))
  };
}
