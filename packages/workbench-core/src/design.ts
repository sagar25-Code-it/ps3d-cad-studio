import type {
  DesignFeature,
  DesignHistory,
  DesignSketchFeature,
  DesignSolidFeature,
  GeneralSolidBody,
  SketchDatumPlane,
  WorkbenchDiagnostic,
  WorkbenchProject,
  WorkbenchResult
} from "./types.js";

/**
 * The parametric history ("timeline"): an ordered list of sketch and solid features with a rollback marker. A sketch
 * feature keeps a snapshot of its sketch; a solid feature (extrude or revolve) names a sketch feature and the profiles to
 * turn into a solid, and owns one body in `part.generalBodies`. Editing a sketch replaces its snapshot, after which the
 * solids built from it are rebuilt by the caller (the kernel is asynchronous) and applied with `regenerate-design`.
 *
 * Everything here is a pure, synchronous reducer over the project, like every other workbench operation.
 */
export type DesignChange = WorkbenchResult<{ readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string }>;

export const MAX_DESIGN_FEATURES = 200;
export const MAX_GENERAL_BODIES = 64;

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;

function fail(code: WorkbenchDiagnostic["code"], message: string, relatedIds: readonly string[], recovery: string): DesignChange {
  return { ok: false, diagnostics: [{ code, message, relatedIds, recovery }] };
}

const missing = (id: string, message: string): DesignChange => fail("BROKEN_REFERENCE", message, [id], "Refresh the project and pick an existing feature.");

export function emptyDesignHistory(): DesignHistory {
  return { features: [], rollbackIndex: 0, editingSketchId: null };
}

export function designOf(project: WorkbenchProject): DesignHistory {
  return project.design ?? emptyDesignHistory();
}

export function isSketchFeature(feature: DesignFeature): feature is DesignSketchFeature {
  return feature.kind === "sketch";
}

export function isSolidFeature(feature: DesignFeature): feature is DesignSolidFeature {
  return feature.kind !== "sketch";
}

/** A join, cut, or direct-edit changes a body that an earlier step made; every other solid step makes a body of its own. */
export function modifiesBody(feature: DesignFeature): feature is DesignSolidFeature & { readonly operation: "join" | "cut" | "direct-edit" } {
  if (feature.kind === "sketch") return false;
  if (feature.kind === "move-body" || feature.kind === "scale-body") return true;
  return feature.operation === "join" || feature.operation === "cut";
}

/** Direct-edit feature kinds that transform a body in place (not a sketch-driven rebuild). */
export function isDirectEditFeature(feature: DesignFeature): feature is DesignSolidFeature & { readonly kind: "move-body" | "scale-body" } {
  return feature.kind !== "sketch" && (feature.kind === "move-body" || feature.kind === "scale-body");
}

/** The step that made a body (its new-body step), if that step is still in the timeline. */
export function baseFeatureOf(history: DesignHistory, bodyId: string): DesignSolidFeature | undefined {
  for (const feature of history.features) {
    if (feature.kind !== "sketch" && feature.bodyId === bodyId && !modifiesBody(feature)) return feature;
  }
  return undefined;
}

/**
 * The features that go when a feature goes: those built on a sketch feature, and the joins and cuts of a body whose
 * new-body step is among them, directly or through another feature that depends on it.
 */
export function dependentsOf(history: DesignHistory, featureId: string): readonly DesignFeature[] {
  const closure = new Set<string>([featureId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const feature of history.features) {
      if (closure.has(feature.id) || feature.kind === "sketch") continue;
      const builtOnClosure = closure.has(feature.sketchFeatureId);
      const modifiesClosureBody = modifiesBody(feature) && history.features.some((other) => closure.has(other.id) && other.kind !== "sketch" && !modifiesBody(other) && other.bodyId === feature.bodyId);
      if (builtOnClosure || modifiesClosureBody) { closure.add(feature.id); grew = true; }
    }
  }
  return history.features.filter((feature) => feature.id !== featureId && closure.has(feature.id));
}

/** Whether a feature takes part in the model right now: before the rollback marker, not suppressed, and built on live sketches. A join or cut also needs its body's new-body step to be live. */
export function isFeatureActive(history: DesignHistory, featureId: string): boolean {
  const index = history.features.findIndex((feature) => feature.id === featureId);
  const feature = history.features[index];
  if (feature === undefined || index >= history.rollbackIndex || feature.suppressed) return false;
  if (feature.kind === "sketch") return true;
  const sketch = history.features.find((candidate) => candidate.id === feature.sketchFeatureId);
  if (sketch === undefined || sketch.suppressed) return false;
  if (!modifiesBody(feature)) return true;
  const base = baseFeatureOf(history, feature.bodyId);
  return base !== undefined && history.features.indexOf(base) < index && isFeatureActive(history, base.id);
}

/**
 * Drops the solid features whose body is no longer in the part (it was deleted or combined into another body), so the
 * timeline never lists a step with nothing behind it. Returns the project unchanged when every solid still exists.
 */
export function pruneOrphanedSolidFeatures(project: WorkbenchProject): { readonly project: WorkbenchProject; readonly removed: readonly string[] } {
  const history = project.design;
  if (history === undefined) return { project, removed: [] };
  const bodies = new Set((project.part.generalBodies ?? []).map((body) => body.id));
  const orphans = history.features.filter((feature) => feature.kind !== "sketch" && !bodies.has(feature.bodyId));
  if (orphans.length === 0) return { project, removed: [] };
  const gone = new Set(orphans.map((feature) => feature.id));
  const removedBeforeMarker = history.features.filter((feature, index) => gone.has(feature.id) && index < history.rollbackIndex).length;
  const next: DesignHistory = { ...history, features: history.features.filter((feature) => !gone.has(feature.id)), rollbackIndex: history.rollbackIndex - removedBeforeMarker };
  return { project: withHistory(project, next), removed: orphans.map((feature) => feature.name) };
}

/** Shows each feature's solid exactly when the feature is active, and records the new history. */
function withHistory(project: WorkbenchProject, history: DesignHistory): WorkbenchProject {
  const owned = new Map<string, boolean>();
  for (const feature of history.features) {
    // A body is shown while the step that made it is live; its joins and cuts change its shape, not whether it is shown.
    if (feature.kind !== "sketch" && !modifiesBody(feature)) owned.set(feature.bodyId, isFeatureActive(history, feature.id));
  }
  const bodies = project.part.generalBodies ?? [];
  const synced = owned.size === 0 ? bodies : bodies.map((body) => owned.has(body.id) && body.visible !== owned.get(body.id) ? { ...body, visible: owned.get(body.id)! } : body);
  return { ...project, design: history, part: owned.size === 0 ? project.part : { ...project.part, generalBodies: synced } };
}

function changed(project: WorkbenchProject, changedIds: readonly string[], summary: string): DesignChange {
  return { ok: true, value: { project, changedIds, summary } };
}

const insertAt = <T>(items: readonly T[], index: number, item: T): readonly T[] => [...items.slice(0, index), item, ...items.slice(index)];

export function commitDesignSketch(project: WorkbenchProject, featureId: string, name: string): DesignChange {
  const history = designOf(project);
  if (project.sketch.entities.length === 0) return fail("INVALID_OPERATION", "The sketch is empty, so there is nothing to finish.", [project.sketch.id], "Draw at least one curve first.");
  const editing = history.features.find((feature): feature is DesignSketchFeature => feature.id === history.editingSketchId && feature.kind === "sketch");
  if (editing !== undefined) {
    const next: DesignHistory = { ...history, features: history.features.map((feature) => feature.id === editing.id ? { ...editing, sketch: project.sketch } : feature) };
    return changed(withHistory(project, next), [editing.id], `Updated ${editing.name} in the timeline.`);
  }
  if (history.features.length >= MAX_DESIGN_FEATURES) return fail("RESOURCE_LIMIT", "The timeline reached its feature limit.", [], "Delete a feature before adding another.");
  if (history.features.some((feature) => feature.id === featureId)) return fail("INVALID_OPERATION", "A timeline feature with this ID already exists.", [featureId], "Use a new feature ID.");
  const feature: DesignSketchFeature = { id: featureId, name, kind: "sketch", suppressed: false, sketch: project.sketch };
  const next: DesignHistory = { features: insertAt(history.features, history.rollbackIndex, feature), rollbackIndex: history.rollbackIndex + 1, editingSketchId: featureId };
  return changed(withHistory(project, next), [featureId], `Finished ${name} into the timeline.`);
}

export function editDesignSketch(project: WorkbenchProject, featureId: string): DesignChange {
  const history = designOf(project);
  const feature = history.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) return missing(featureId, "The sketch feature does not exist.");
  if (feature.kind !== "sketch") return fail("INVALID_OPERATION", "Only a sketch feature can be reopened for editing.", [featureId], "Pick a sketch in the timeline.");
  const next: DesignHistory = { ...history, editingSketchId: featureId };
  return changed({ ...project, sketch: feature.sketch, activeWorkspace: "sketch", design: next }, [featureId], `Reopened ${feature.name} for editing.`);
}

export function newDesignSketch(project: WorkbenchProject, plane: SketchDatumPlane, offsetMm = 0): DesignChange {
  const history = designOf(project);
  const { planeOffsetMm: _previousOffset, ...rest } = project.sketch;
  const sketch = { ...rest, name: "Sketch", plane, ...(offsetMm === 0 ? {} : { planeOffsetMm: offsetMm }), entities: [], constraints: [] };
  return changed({ ...project, sketch, activeWorkspace: "sketch", design: { ...history, editingSketchId: null } }, [project.sketch.id], `Started a new sketch on the ${plane.replace("datum:", "").toUpperCase()} plane${offsetMm === 0 ? "" : ` offset ${offsetMm} mm`}.`);
}

function checkSolidFeature(history: DesignHistory, feature: DesignSolidFeature, body: GeneralSolidBody, replacing: boolean): DesignChange | undefined {
  if (feature.bodyId !== body.id) return fail("INVALID_OPERATION", "The solid's ID must match the feature's body ID.", [feature.id, body.id], "Build the solid with the feature's body ID.");
  const sketch = history.features.find((candidate) => candidate.id === feature.sketchFeatureId);
  if (sketch === undefined || sketch.kind !== "sketch") return missing(feature.sketchFeatureId, "The feature must be built on a sketch feature in the timeline.");
  const duplicate = history.features.find((candidate) => (candidate.id === feature.id) !== replacing && candidate.id === feature.id);
  if (duplicate !== undefined) return fail("INVALID_OPERATION", "A timeline feature with this ID already exists.", [feature.id], "Use a new feature ID.");
  if (modifiesBody(feature)) {
    const base = baseFeatureOf(history, feature.bodyId);
    const before = replacing ? history.features.findIndex((candidate) => candidate.id === feature.id) : history.rollbackIndex;
    if (base === undefined || history.features.indexOf(base) >= before) return fail("INVALID_OPERATION", "A join or cut needs a body that an earlier step made.", [feature.id, feature.bodyId], "Pick a body that was created earlier in the timeline.");
  }
  return undefined;
}

export function addDesignSolid(project: WorkbenchProject, feature: DesignSolidFeature, body: GeneralSolidBody): DesignChange {
  const history = designOf(project);
  const problem = checkSolidFeature(history, feature, body, false);
  if (problem !== undefined) return problem;
  if (history.features.length >= MAX_DESIGN_FEATURES) return fail("RESOURCE_LIMIT", "The timeline reached its feature limit.", [], "Delete a feature before adding another.");
  const bodies = project.part.generalBodies ?? [];
  const next: DesignHistory = { ...history, features: insertAt(history.features, history.rollbackIndex, feature), rollbackIndex: history.rollbackIndex + 1 };
  if (modifiesBody(feature)) {
    // A join or cut replaces the shape of the body it modifies instead of adding a body.
    if (!bodies.some((candidate) => candidate.id === body.id)) return missing(body.id, "The body this feature modifies does not exist.");
    const replaced = bodies.map((candidate) => candidate.id === body.id ? { ...body, visible: candidate.visible } : candidate);
    return changed(withHistory({ ...project, part: { ...project.part, generalBodies: replaced } }, next), [feature.id, body.id], `Added ${feature.name} to the timeline.`);
  }
  if (bodies.length >= MAX_GENERAL_BODIES) return fail("RESOURCE_LIMIT", "The part reached its general mesh-body limit.", [project.part.id], "Delete a general body before adding another.");
  if (bodies.some((candidate) => candidate.id === body.id)) return fail("INVALID_OPERATION", "The general body ID already exists.", [body.id], "Use a new body ID.");
  const withBody: WorkbenchProject = { ...project, part: { ...project.part, generalBodies: [...bodies, body] } };
  return changed(withHistory(withBody, next), [feature.id, body.id], `Added ${feature.name} to the timeline.`);
}

export function updateDesignSolid(project: WorkbenchProject, feature: DesignSolidFeature, body: GeneralSolidBody): DesignChange {
  const history = designOf(project);
  const existing = history.features.find((candidate) => candidate.id === feature.id);
  if (existing === undefined || existing.kind === "sketch") return missing(feature.id, "The solid feature does not exist.");
  const problem = checkSolidFeature(history, feature, body, true);
  if (problem !== undefined) return problem;
  if (existing.bodyId !== feature.bodyId) return fail("INVALID_OPERATION", "A feature keeps its body ID when it is edited.", [feature.id], "Edit the parameters, not the body.");
  const bodies = (project.part.generalBodies ?? []).map((candidate) => candidate.id === body.id ? { ...body, visible: candidate.visible } : candidate);
  const { health: _cleared, ...clean } = feature;
  const next: DesignHistory = { ...history, features: history.features.map((candidate) => candidate.id === feature.id ? clean : candidate) };
  return changed(withHistory({ ...project, part: { ...project.part, generalBodies: bodies } }, next), [feature.id, body.id], `Updated ${feature.name}.`);
}

export function regenerateDesign(project: WorkbenchProject, results: readonly { readonly featureId: string; readonly body?: GeneralSolidBody; readonly message?: string }[]): DesignChange {
  const history = designOf(project);
  const byId = new Map(results.map((result) => [result.featureId, result] as const));
  if (byId.size !== results.length) return fail("INVALID_OPERATION", "A feature appears twice in the rebuild results.", [], "Send one result per feature.");
  for (const result of results) {
    const feature = history.features.find((candidate) => candidate.id === result.featureId);
    if (feature === undefined || feature.kind === "sketch") return missing(result.featureId, "A rebuilt feature does not exist or is not a solid feature.");
    if (result.body !== undefined && result.body.id !== feature.bodyId) return fail("INVALID_OPERATION", "A rebuilt solid must keep its feature's body ID.", [feature.id], "Build the solid with the feature's body ID.");
  }
  const bodies = (project.part.generalBodies ?? []).map((candidate) => {
    for (const result of results) {
      if (result.body !== undefined && result.body.id === candidate.id) return { ...result.body, visible: candidate.visible };
    }
    return candidate;
  });
  const features = history.features.map((feature): DesignFeature => {
    const result = byId.get(feature.id);
    if (result === undefined) return feature;
    const { health: _previous, ...rest } = feature;
    return result.message === undefined ? rest as DesignFeature : { ...rest, health: { message: result.message } } as DesignFeature;
  });
  const failed = results.filter((result) => result.message !== undefined).length;
  return changed(
    withHistory({ ...project, part: { ...project.part, generalBodies: bodies } }, { ...history, features }),
    results.map((result) => result.featureId),
    `Rebuilt ${results.length - failed} feature${results.length - failed === 1 ? "" : "s"}${failed === 0 ? "" : `; ${failed} could not be rebuilt`}.`
  );
}

export function setDesignFeatureSuppressed(project: WorkbenchProject, featureId: string, suppressed: boolean): DesignChange {
  const history = designOf(project);
  const feature = history.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) return missing(featureId, "The timeline feature does not exist.");
  const next: DesignHistory = { ...history, features: history.features.map((candidate): DesignFeature => candidate.id === featureId ? { ...candidate, suppressed } : candidate) };
  return changed(withHistory(project, next), [featureId], `${suppressed ? "Suppressed" : "Unsuppressed"} ${feature.name}.`);
}

export function deleteDesignFeature(project: WorkbenchProject, featureId: string): DesignChange {
  const history = designOf(project);
  const feature = history.features.find((candidate) => candidate.id === featureId);
  if (feature === undefined) return missing(featureId, "The timeline feature does not exist.");
  const removed = new Set<string>([featureId, ...dependentsOf(history, featureId).map((dependent) => dependent.id)]);
  const removedBeforeMarker = history.features.filter((candidate, index) => removed.has(candidate.id) && index < history.rollbackIndex).length;
  // Only a body's own (new-body) step takes the body with it; removing a join or cut leaves the body, which the caller rebuilds.
  const goneBodies = new Set(history.features.filter((candidate): candidate is DesignSolidFeature => removed.has(candidate.id) && candidate.kind !== "sketch" && !modifiesBody(candidate)).map((candidate) => candidate.bodyId));
  const next: DesignHistory = {
    features: history.features.filter((candidate) => !removed.has(candidate.id)),
    rollbackIndex: history.rollbackIndex - removedBeforeMarker,
    editingSketchId: history.editingSketchId !== null && removed.has(history.editingSketchId) ? null : history.editingSketchId
  };
  const bodies = (project.part.generalBodies ?? []).filter((candidate) => !goneBodies.has(candidate.id));
  const extra = removed.size - 1;
  return changed(withHistory({ ...project, part: { ...project.part, generalBodies: bodies } }, next), [...removed], `Deleted ${feature.name}${extra === 0 ? "" : ` and the ${extra} feature${extra === 1 ? "" : "s"} built on it`}.`);
}

export function setDesignRollback(project: WorkbenchProject, index: number): DesignChange {
  const history = designOf(project);
  if (!Number.isInteger(index) || index < 0 || index > history.features.length) return fail("INVALID_OPERATION", "The rollback position is outside the timeline.", [], "Choose a position between the start and the end of the timeline.");
  return changed(withHistory(project, { ...history, rollbackIndex: index }), [], index === history.features.length ? "Rolled forward to the end of the timeline." : `Rolled back to after step ${index}.`);
}

export function renameDesignFeature(project: WorkbenchProject, featureId: string, name: string): DesignChange {
  const history = designOf(project);
  if (!history.features.some((candidate) => candidate.id === featureId)) return missing(featureId, "The timeline feature does not exist.");
  const next: DesignHistory = { ...history, features: history.features.map((candidate): DesignFeature => candidate.id === featureId ? { ...candidate, name } : candidate) };
  return changed(withHistory(project, next), [featureId], `Renamed the feature to ${name}.`);
}

// ---------------------------------------------------------------------------------------------
// Payload checks shared by operation validation and project loading
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stable = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
const shortText = (value: unknown, maximum: number): value is string => typeof value === "string" && value.trim().length >= 1 && value.length <= maximum;
const hasOnly = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

export function validSolidFeaturePayload(value: unknown): value is DesignSolidFeature {
  if (!isRecord(value) || !hasOnly(value, ["id", "name", "kind", "suppressed", "sketchFeatureId", "profileIds", "valueMm", "bodyId"], ["direction", "edge", "operation", "extent", "health", "sweepDirectionMm", "sweepPathEntityId", "sweepTwistDeg", "sweepFrameTransport", "loftTopScale", "loftSecondaryProfileIds", "loftContinuity", "loftRailEntityId", "loftTangencyWeight", "moveDeltaMm", "scaleFactor", "shellOpenFace", "shellThicknessMm", "draftNeutralFace", "draftAngleDeg"])) return false;
  if (Object.hasOwn(value, "operation") && !["new-body", "join", "cut", "direct-edit"].includes(String(value.operation))) return false;
  if (Object.hasOwn(value, "extent")) {
    // Through-all only makes sense for an extruded cut: the tool is stretched across the body it cuts.
    if (!["distance", "through-all"].includes(String(value.extent))) return false;
    if (value.extent === "through-all" && (value.kind !== "extrude" || value.operation !== "cut")) return false;
  }
  if (!stable(value.id) || !shortText(value.name, 120) || !["extrude", "revolve", "sweep", "loft", "edge-fillet", "edge-chamfer", "shell", "draft", "move-body", "scale-body"].includes(String(value.kind)) || typeof value.suppressed !== "boolean") return false;
  if (!stable(value.sketchFeatureId) || !stable(value.bodyId)) return false;
  if (!Array.isArray(value.profileIds) || value.profileIds.length > 64 || value.profileIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 160)) return false;
  if (typeof value.valueMm !== "number" || !Number.isFinite(value.valueMm) || value.valueMm === 0 || Math.abs(value.valueMm) > 100_000) return false;
  if (Object.hasOwn(value, "direction") && (value.kind !== "extrude" || !["one-side", "symmetric", "flipped"].includes(String(value.direction)))) return false;
  if (Object.hasOwn(value, "edge")) {
    const edge = value.edge;
    if (!["extrude", "edge-fillet", "edge-chamfer"].includes(String(value.kind)) || !isRecord(edge) || !hasOnly(edge, ["kind", "sizeMm"], []) || !["chamfer", "fillet"].includes(String(edge.kind))
      || typeof edge.sizeMm !== "number" || !Number.isFinite(edge.sizeMm) || edge.sizeMm <= 0 || edge.sizeMm > 10_000) return false;
    // The treatment kind must match the feature kind so a saved "edge-fillet" step always carries a fillet.
    if (value.kind === "edge-fillet" && edge.kind !== "fillet") return false;
    if (value.kind === "edge-chamfer" && edge.kind !== "chamfer") return false;
  }
  if (Object.hasOwn(value, "sweepDirectionMm")) {
    if (value.kind !== "sweep") return false;
    const direction = value.sweepDirectionMm;
    if (!Array.isArray(direction) || direction.length !== 3 || direction.some((component) => typeof component !== "number" || !Number.isFinite(component))) return false;
    if (Math.hypot(direction[0], direction[1], direction[2]) < 1e-6) return false;
  }
  if (Object.hasOwn(value, "sweepPathEntityId")) {
    if (value.kind !== "sweep" || typeof value.sweepPathEntityId !== "string" || value.sweepPathEntityId.length === 0 || value.sweepPathEntityId.length > 160) return false;
  }
  if (Object.hasOwn(value, "sweepTwistDeg")) {
    if (value.kind !== "sweep" || typeof value.sweepTwistDeg !== "number" || !Number.isFinite(value.sweepTwistDeg) || Math.abs(value.sweepTwistDeg) > 3600) return false;
  }
  if (Object.hasOwn(value, "sweepFrameTransport")) {
    if (value.kind !== "sweep" || typeof value.sweepFrameTransport !== "boolean") return false;
  }
  if (Object.hasOwn(value, "loftTangencyWeight")) {
    if (value.kind !== "loft" || typeof value.loftTangencyWeight !== "number" || !Number.isFinite(value.loftTangencyWeight) || value.loftTangencyWeight < 0 || value.loftTangencyWeight > 2) return false;
  }
  if (Object.hasOwn(value, "moveDeltaMm")) {
    if (value.kind !== "move-body") return false;
    const delta = value.moveDeltaMm;
    if (!Array.isArray(delta) || delta.length !== 3 || delta.some((component) => typeof component !== "number" || !Number.isFinite(component) || Math.abs(component) > 100_000)) return false;
  }
  if (Object.hasOwn(value, "scaleFactor")) {
    if (value.kind !== "scale-body" || typeof value.scaleFactor !== "number" || !Number.isFinite(value.scaleFactor) || value.scaleFactor <= 0 || value.scaleFactor > 100) return false;
  }
  // Direct-edit kinds carry operation "direct-edit" and act on an existing body.
  if (value.kind === "move-body") {
    if (value.operation !== "direct-edit" || !Object.hasOwn(value, "moveDeltaMm")) return false;
  }
  if (value.kind === "scale-body") {
    if (value.operation !== "direct-edit" || !Object.hasOwn(value, "scaleFactor")) return false;
  }
  if (value.operation === "direct-edit" && value.kind !== "move-body" && value.kind !== "scale-body") return false;
  if (Object.hasOwn(value, "loftRailEntityId")) {
    if (value.kind !== "loft" || typeof value.loftRailEntityId !== "string" || value.loftRailEntityId.length === 0 || value.loftRailEntityId.length > 160) return false;
  }
  if (Object.hasOwn(value, "loftTopScale")) {
    if (value.kind !== "loft") return false;
    if (typeof value.loftTopScale !== "number" || !Number.isFinite(value.loftTopScale) || value.loftTopScale <= 0 || value.loftTopScale > 100) return false;
  }
  if (Object.hasOwn(value, "loftSecondaryProfileIds")) {
    if (value.kind !== "loft") return false;
    const ids = value.loftSecondaryProfileIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 64 || ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 160)) return false;
  }
  if (Object.hasOwn(value, "loftContinuity")) {
    if (value.kind !== "loft" || !["position", "tangent", "curvature"].includes(String(value.loftContinuity))) return false;
  }
  if (Object.hasOwn(value, "shellOpenFace")) {
    if (value.kind !== "shell" || !["top", "bottom", "none"].includes(String(value.shellOpenFace))) return false;
  }
  if (Object.hasOwn(value, "shellThicknessMm")) {
    if (value.kind !== "shell" || typeof value.shellThicknessMm !== "number" || !Number.isFinite(value.shellThicknessMm) || value.shellThicknessMm <= 0 || value.shellThicknessMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "draftNeutralFace")) {
    if (value.kind !== "draft" || !["top", "bottom"].includes(String(value.draftNeutralFace))) return false;
  }
  if (Object.hasOwn(value, "draftAngleDeg")) {
    if (value.kind !== "draft" || typeof value.draftAngleDeg !== "number" || !Number.isFinite(value.draftAngleDeg) || value.draftAngleDeg <= 0 || value.draftAngleDeg >= 80) return false;
  }
  if (Object.hasOwn(value, "health") && !(isRecord(value.health) && hasOnly(value.health, ["message"], []) && shortText(value.health.message, 400))) return false;
  return true;
}

/** Checks a saved timeline: feature shapes, unique IDs, solids built on earlier sketches, and a consistent rollback marker. */
export function validateDesignHistory(value: unknown, validSketch: (sketch: unknown) => boolean): value is DesignHistory {
  if (!isRecord(value) || !hasOnly(value, ["features", "rollbackIndex", "editingSketchId"], [])) return false;
  const features = value.features;
  if (!Array.isArray(features) || features.length > MAX_DESIGN_FEATURES) return false;
  if (typeof value.rollbackIndex !== "number" || !Number.isInteger(value.rollbackIndex) || value.rollbackIndex < 0 || value.rollbackIndex > features.length) return false;
  const ids = new Set<string>();
  const sketchIds = new Set<string>();
  const bodyIds = new Set<string>();
  for (const feature of features) {
    if (!isRecord(feature) || !stable(feature.id) || ids.has(feature.id)) return false;
    ids.add(feature.id);
    if (feature.kind === "sketch") {
      if (!hasOnly(feature, ["id", "name", "kind", "suppressed", "sketch"], ["health"]) || !shortText(feature.name, 120) || typeof feature.suppressed !== "boolean" || !validSketch(feature.sketch)) return false;
      sketchIds.add(feature.id);
    } else {
      if (!validSolidFeaturePayload(feature) || !sketchIds.has(feature.sketchFeatureId)) return false;
      if (feature.operation === "join" || feature.operation === "cut") {
        // A join or cut modifies a body an earlier step made.
        if (!bodyIds.has(feature.bodyId)) return false;
      } else {
        if (bodyIds.has(feature.bodyId)) return false;
        bodyIds.add(feature.bodyId);
      }
    }
  }
  return value.editingSketchId === null || (typeof value.editingSketchId === "string" && sketchIds.has(value.editingSketchId));
}
