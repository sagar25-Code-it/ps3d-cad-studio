import { SHEET_FEATURE_KEYS, SHEET_FEATURE_KINDS, validSheetFeatureExtras } from "./sheet-features.js";
import type {
  DesignFeature,
  DesignHistory,
  DesignSketchFeature,
  DesignSolidFeature,
  GeneralSolidBody,
  SketchDatumPlane,
  SketchPlaneFrame,
  SketchPlaneTilt,
  WorkbenchDiagnostic,
  WorkbenchProject,
  WorkbenchResult
} from "./types.js";
import { validPatternDefinition } from "./pattern.js";
import { validFeatureExpressions } from "./feature-bindings.js";
import { validParameterTable } from "./parameter-graph.js";
import { EDGE_BLEND_KEYS, validEdgeBlendFields } from "./edge-blend.js";
import { BODY_EDIT_KINDS, BODY_EDIT_ONLY_KINDS, validBodyEdit } from "./body-edit.js";

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

/** The ID of the `ordinal`-th piece (2, 3, ...) a body was split into by a cut or hole; piece 1 keeps the body's own ID. */
export function splitPieceId(bodyId: string, ordinal: number): string {
  return `${bodyId}.piece-${ordinal}`;
}

/** The display name of the `ordinal`-th piece of a split body. */
export function splitPieceName(name: string, ordinal: number): string {
  return `${name} (piece ${ordinal})`;
}

/** Whether `candidateId` names a piece that was split off the body `bodyId`. */
export function isSplitPieceOf(bodyId: string, candidateId: string): boolean {
  return candidateId.startsWith(`${bodyId}.piece-`);
}

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

/** A join, cut, direct-edit, or face-modifying feature changes a body that an earlier step made; every other solid step makes a body of its own. */
export function modifiesBody(feature: DesignFeature): feature is DesignSolidFeature & { readonly operation: "join" | "cut" | "direct-edit" } {
  if (feature.kind === "sketch") return false;
  if (feature.kind === "move-body" || feature.kind === "scale-body" || feature.kind === "move-face" || feature.kind === "offset-face" || feature.kind === "emboss") return true;
  if (feature.kind === "indent" || feature.kind === "sheet-edge-flange" || feature.kind === "hole" || feature.kind === "edge-blend" || feature.kind === "sheet-jog") return true;
  // A pattern joined into its body, or of features in it, changes that body; a new-bodies pattern makes bodies of its own.
  if (feature.kind === "pattern") return feature.pattern !== undefined && (feature.pattern.result === "join" || feature.pattern.featureIds !== undefined);
  if (feature.bodyEdit !== undefined) return true;
  return feature.operation === "join" || feature.operation === "cut";
}

/** A step that reshapes an existing body by picked faces or a transform (general shell / draft, offset region, replace face, web, wrap, flex). */
export function isBodyEditFeature(feature: DesignFeature): feature is DesignSolidFeature & { readonly bodyEdit: NonNullable<DesignSolidFeature["bodyEdit"]> } {
  return feature.kind !== "sketch" && feature.bodyEdit !== undefined;
}

/** Direct-edit feature kinds that transform a body in place (not a sketch-driven rebuild). */
export function isDirectEditFeature(feature: DesignFeature): feature is DesignSolidFeature & { readonly kind: "move-body" | "scale-body" | "move-face" | "offset-face" | "emboss" } {
  return feature.kind !== "sketch" && (feature.kind === "move-body" || feature.kind === "scale-body" || feature.kind === "move-face" || feature.kind === "offset-face" || feature.kind === "emboss");
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
      const copiesClosureBody = feature.kind === "pattern" && feature.pattern !== undefined && history.features.some((other) => closure.has(other.id) && other.kind !== "sketch" && !modifiesBody(other) && other.bodyId === feature.pattern!.sourceBodyId);
      const modifiesClosureBody = modifiesBody(feature) && history.features.some((other) => closure.has(other.id) && other.kind !== "sketch" && !modifiesBody(other) && other.bodyId === feature.bodyId);
      if (builtOnClosure || modifiesClosureBody || copiesClosureBody) { closure.add(feature.id); grew = true; }
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
  // A copy made by a pattern is only on while the step that made its source body is.
  if (feature.kind === "pattern" && feature.pattern?.result === "new-bodies") {
    const source = baseFeatureOf(history, feature.pattern.sourceBodyId);
    if (source === undefined || history.features.indexOf(source) >= index || !isFeatureActive(history, source.id)) return false;
  }
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

/**
 * Shows a feature's solid while the feature is live, and records the new history. A body is only shown or hidden when its step
 * is new or its live state changed (suppressed, unsuppressed, rolled back or forward), so a body the user hid stays hidden through
 * any other timeline edit.
 */
function withHistory(project: WorkbenchProject, history: DesignHistory): WorkbenchProject {
  const previous = project.design;
  const owned = new Map<string, boolean>();
  for (const feature of history.features) {
    // A body is shown while the step that made it is live; its joins and cuts change its shape, not whether it is shown.
    if (feature.kind === "sketch" || modifiesBody(feature)) continue;
    const live = isFeatureActive(history, feature.id);
    const existed = previous !== undefined && previous.features.some((candidate) => candidate.id === feature.id);
    if (existed && isFeatureActive(previous, feature.id) === live) continue;
    owned.set(feature.bodyId, live);
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
  const next: DesignHistory = { ...history, features: insertAt(history.features, history.rollbackIndex, feature), rollbackIndex: history.rollbackIndex + 1, editingSketchId: featureId };
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

export function newDesignSketch(project: WorkbenchProject, plane: SketchDatumPlane, offsetMm = 0, tilt?: SketchPlaneTilt, frame?: SketchPlaneFrame): DesignChange {
  const history = designOf(project);
  const { planeOffsetMm: _previousOffset, planeTilt: _previousTilt, planeFrame: _previousFrame, ...rest } = project.sketch;
  const sketch = { ...rest, name: "Sketch", plane, ...(offsetMm === 0 ? {} : { planeOffsetMm: offsetMm }), ...(tilt === undefined ? {} : { planeTilt: tilt }), ...(frame === undefined ? {} : { planeFrame: frame }), entities: [], constraints: [] };
  const where = frame !== undefined ? "a plane through three points"
    : `the ${plane.replace("datum:", "").toUpperCase()} plane${offsetMm === 0 ? "" : ` offset ${offsetMm} mm`}${tilt === undefined ? "" : ` tilted ${tilt.angleDeg}° about ${tilt.axis.toUpperCase()}`}`;
  return changed({ ...project, sketch, activeWorkspace: "sketch", design: { ...history, editingSketchId: null } }, [project.sketch.id], `Started a new sketch on ${where}.`);
}

function checkSolidFeature(history: DesignHistory, feature: DesignSolidFeature, body: GeneralSolidBody, replacing: boolean): DesignChange | undefined {
  if (feature.bodyId !== body.id) return fail("INVALID_OPERATION", "The solid's ID must match the feature's body ID.", [feature.id, body.id], "Build the solid with the feature's body ID.");
  const sketch = history.features.find((candidate) => candidate.id === feature.sketchFeatureId);
  if (sketch === undefined || sketch.kind !== "sketch") return missing(feature.sketchFeatureId, "The feature must be built on a sketch feature in the timeline.");
  const duplicate = history.features.find((candidate) => (candidate.id === feature.id) !== replacing && candidate.id === feature.id);
  if (duplicate !== undefined) return fail("INVALID_OPERATION", "A timeline feature with this ID already exists.", [feature.id], "Use a new feature ID.");
  if (feature.kind === "pattern" && feature.pattern !== undefined) {
    const source = baseFeatureOf(history, feature.pattern.sourceBodyId);
    const at = replacing ? history.features.findIndex((candidate) => candidate.id === feature.id) : history.rollbackIndex;
    if (source === undefined || history.features.indexOf(source) >= at) return fail("INVALID_OPERATION", "A pattern needs a body that an earlier step made.", [feature.id, feature.pattern.sourceBodyId], "Pattern a body that was created earlier in the timeline.");
    const repeated = feature.pattern.featureIds ?? [];
    const missingStep = repeated.find((id) => { const found = history.features.findIndex((candidate) => candidate.id === id && candidate.kind !== "sketch" && candidate.bodyId === feature.pattern!.sourceBodyId); return found < 0 || found >= at; });
    if (missingStep !== undefined) return fail("INVALID_OPERATION", "A pattern of features can only repeat earlier steps of the same body.", [feature.id, missingStep], "Pick holes or cuts that come before the pattern in the timeline.");
  }
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

export function regenerateDesign(project: WorkbenchProject, results: readonly { readonly featureId: string; readonly body?: GeneralSolidBody; readonly pieces?: readonly GeneralSolidBody[]; readonly message?: string }[]): DesignChange {
  const history = designOf(project);
  const byId = new Map(results.map((result) => [result.featureId, result] as const));
  if (byId.size !== results.length) return fail("INVALID_OPERATION", "A feature appears twice in the rebuild results.", [], "Send one result per feature.");
  for (const result of results) {
    const feature = history.features.find((candidate) => candidate.id === result.featureId);
    if (feature === undefined || feature.kind === "sketch") return missing(result.featureId, "A rebuilt feature does not exist or is not a solid feature.");
    if (result.body !== undefined && result.body.id !== feature.bodyId) return fail("INVALID_OPERATION", "A rebuilt solid must keep its feature's body ID.", [feature.id], "Build the solid with the feature's body ID.");
    if (result.pieces !== undefined && (result.body === undefined || result.pieces.some((piece) => !isSplitPieceOf(feature.bodyId, piece.id)))) return fail("INVALID_OPERATION", "Pieces split off a solid must be named after the solid they came from.", [feature.id], "Name each piece with splitPieceId.");
  }
  const rebuiltRoots = results.flatMap((result) => result.body === undefined ? [] : [result.body.id]);
  const existingBodies = project.part.generalBodies ?? [];
  const priorVisibility = new Map(existingBodies.map((candidate) => [candidate.id, candidate.visible] as const));
  // A rebuilt body replaces the pieces it split into last time; the new pieces (if any) come back after the bodies.
  const kept = existingBodies.filter((candidate) => !rebuiltRoots.some((root) => isSplitPieceOf(root, candidate.id)));
  const newPieces = results.flatMap((result) => (result.pieces ?? []).map((piece) => ({ ...piece, visible: priorVisibility.get(piece.id) ?? piece.visible })));
  if (kept.length + newPieces.length > MAX_GENERAL_BODIES) return fail("RESOURCE_LIMIT", "Splitting the solid would pass the part's body limit.", [project.part.id], "Delete a general body before cutting the solid apart.");
  const bodies = kept.map((candidate) => {
    for (const result of results) {
      if (result.body !== undefined && result.body.id === candidate.id) return { ...result.body, visible: candidate.visible };
    }
    return candidate;
  }).concat(newPieces);
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
    `Rebuilt ${results.length - failed} feature${results.length - failed === 1 ? "" : "s"}${failed === 0 ? "" : `; ${failed} could not be rebuilt`}.${newPieces.length === 0 ? "" : ` The solid was cut into ${newPieces.length + results.filter((result) => result.pieces !== undefined && result.body !== undefined).length} separate bodies (${newPieces.map((piece) => piece.name).join(", ")} split off).`}`
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
    ...history,
    features: history.features.filter((candidate) => !removed.has(candidate.id)),
    rollbackIndex: history.rollbackIndex - removedBeforeMarker,
    editingSketchId: history.editingSketchId !== null && removed.has(history.editingSketchId) ? null : history.editingSketchId
  };
  const bodies = (project.part.generalBodies ?? []).filter((candidate) => !goneBodies.has(candidate.id) && ![...goneBodies].some((root) => isSplitPieceOf(root, candidate.id)));
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

const TRIPLE = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.length === 3 && candidate.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 1_000_000);

/** The reach of a feature: distance, through-all, or a "to" extent with the target it measures. */
function validExtent(value: Record<string, unknown>): boolean {
  const hasExtent = Object.hasOwn(value, "extent");
  const hasTarget = Object.hasOwn(value, "extentTarget");
  if (!hasExtent) return !hasTarget;
  const extent = String(value.extent);
  if (!["distance", "through-all", "to-face", "to-body", "to-vertex", "to-first", "to-last"].includes(extent)) return false;
  // Through-all only makes sense for an extruded cut: the tool is stretched across the body it cuts.
  if (extent === "through-all") return value.kind === "extrude" && value.operation === "cut" && !hasTarget;
  if (extent === "distance") return !hasTarget;
  const revolveTo = extent === "to-first" || extent === "to-last";
  if (value.kind !== (revolveTo ? "revolve" : "extrude") || !hasTarget || !isRecord(value.extentTarget)) return false;
  const target = value.extentTarget;
  if (!hasOnly(target, ["kind", "bodyId"], ["faceRole", "pointMm", "normal"]) || !stable(target.bodyId)) return false;
  const wanted = extent === "to-body" ? "body" : extent === "to-vertex" ? "vertex" : "face";
  if (target.kind !== wanted) return false;
  if (Object.hasOwn(target, "pointMm") && !TRIPLE(target.pointMm)) return false;
  if (target.kind === "vertex" && !Object.hasOwn(target, "pointMm")) return false;
  if (Object.hasOwn(target, "faceRole") && (target.kind !== "face" || typeof target.faceRole !== "string" || target.faceRole.length === 0 || target.faceRole.length > 160)) return false;
  if (Object.hasOwn(target, "normal")) {
    if (target.kind !== "face" || !TRIPLE(target.normal)) return false;
    const normal = target.normal as readonly number[];
    if (Math.hypot(normal[0]!, normal[1]!, normal[2]!) < 1e-6) return false;
  }
  // A face needs a name or a point to be found again by; a "to" reach has one end only, so it cannot straddle the plane.
  if (target.kind === "face" && !Object.hasOwn(target, "faceRole") && !Object.hasOwn(target, "pointMm")) return false;
  if (value.direction === "symmetric") return false;
  if (revolveTo && value.direction === "two-side") return false;
  return true;
}

/** Direction, the second distance of a two-side feature, and the thin-wall options of a revolve. */
function validDirectionAndThin(value: Record<string, unknown>): boolean {
  const sweptKind = value.kind === "extrude" || value.kind === "revolve";
  if (Object.hasOwn(value, "direction") && (!sweptKind || !["one-side", "symmetric", "flipped", "two-side"].includes(String(value.direction)))) return false;
  const hasSecond = Object.hasOwn(value, "secondValueMm");
  if (hasSecond !== (value.direction === "two-side")) return false;
  if (hasSecond && (typeof value.secondValueMm !== "number" || !Number.isFinite(value.secondValueMm) || value.secondValueMm <= 0 || value.secondValueMm > 100_000)) return false;
  if (value.kind === "revolve" && typeof value.valueMm === "number" && value.valueMm > 360) return false;
  if (value.kind === "revolve" && hasSecond && (value.valueMm as number) + (value.secondValueMm as number) > 360) return false;
  if (Object.hasOwn(value, "thinWallMm")) {
    if (value.kind !== "revolve" || typeof value.thinWallMm !== "number" || !Number.isFinite(value.thinWallMm) || value.thinWallMm <= 0 || value.thinWallMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "thinSide") && (!Object.hasOwn(value, "thinWallMm") || !["inside", "outside", "center"].includes(String(value.thinSide)))) return false;
  return true;
}

export function validSolidFeaturePayload(value: unknown): value is DesignSolidFeature {
  if (!isRecord(value) || !hasOnly(value, ["id", "name", "kind", "suppressed", "sketchFeatureId", "profileIds", "valueMm", "bodyId"], ["direction", "secondValueMm", "thinWallMm", "thinSide", "extentTarget", "edge", "operation", "extent", "health", "sweepDirectionMm", "sweepPathEntityId", "sweepTwistDeg", "sweepFrameTransport", "loftTopScale", "loftSecondaryProfileIds", "loftContinuity", "loftRailEntityId", "loftTangencyWeight", "moveDeltaMm", "scaleFactor", "targetFaceRole", "moveFaceDeltaMm", "offsetFaceMm", "helixRadiusMm", "helixPitchMm", "helixTurns", "helixHandedness", "edgeEndSizeMm", "threadPitchMm", "threadTurns", "threadDepthMm", "threadHandedness", "ribThicknessMm", "ribDirection", "domeHeightMm", "embossHeightMm", "indentToolBodyId", "sheetThicknessMm", "sheetBendRadiusMm", "flangeLengthMm", "flangeAngleDeg", "flangeEdgeIndex", "flangeReliefMm", "holeStyle", "holePositionMm", "holeNormal", "holeDiameterMm", "holeDepthMm", "holeCounterDiameterMm", "holeCounterDepthMm", "holeSinkDiameterMm", "holeSinkAngleDeg", "hemStyle", "shellOpenFace", "shellThicknessMm", "draftNeutralFace", "draftAngleDeg", "pattern", "expressions", "bodyEdit", "holeThread", "flangeReliefShape", ...EDGE_BLEND_KEYS, ...SHEET_FEATURE_KEYS])) return false;
  if (Object.hasOwn(value, "operation") && !["new-body", "join", "cut", "direct-edit"].includes(String(value.operation))) return false;
  if (!validExtent(value)) return false;
  if (!stable(value.id) || !shortText(value.name, 120) || !["extrude", "revolve", "sweep", "loft", "edge-fillet", "edge-chamfer", "shell", "draft", "move-body", "scale-body", "move-face", "offset-face", "helix", "thread", "rib", "dome", "emboss", "indent", "sheet-base", "sheet-flange", "sheet-hem", "sheet-edge-flange", "hole", "pattern", "edge-blend", ...BODY_EDIT_ONLY_KINDS, ...SHEET_FEATURE_KINDS].includes(String(value.kind)) || typeof value.suppressed !== "boolean") return false;
  if (!stable(value.sketchFeatureId) || !stable(value.bodyId)) return false;
  if (!Array.isArray(value.profileIds) || value.profileIds.length > 64 || value.profileIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 160)) return false;
  if (typeof value.valueMm !== "number" || !Number.isFinite(value.valueMm) || value.valueMm === 0 || Math.abs(value.valueMm) > 100_000) return false;
  if (!validDirectionAndThin(value)) return false;
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
  if (Object.hasOwn(value, "targetFaceRole")) {
    if ((value.kind !== "move-face" && value.kind !== "offset-face" && value.kind !== "dome" && value.kind !== "emboss") || typeof value.targetFaceRole !== "string" || value.targetFaceRole.length === 0 || value.targetFaceRole.length > 160) return false;
  }
  if (Object.hasOwn(value, "moveFaceDeltaMm")) {
    if (value.kind !== "move-face") return false;
    const delta = value.moveFaceDeltaMm;
    if (!Array.isArray(delta) || delta.length !== 3 || delta.some((component) => typeof component !== "number" || !Number.isFinite(component) || Math.abs(component) > 100_000)) return false;
  }
  if (Object.hasOwn(value, "offsetFaceMm")) {
    if (value.kind !== "offset-face" || typeof value.offsetFaceMm !== "number" || !Number.isFinite(value.offsetFaceMm) || value.offsetFaceMm === 0 || Math.abs(value.offsetFaceMm) > 100_000) return false;
  }
  if (Object.hasOwn(value, "helixRadiusMm")) {
    if (value.kind !== "helix" || typeof value.helixRadiusMm !== "number" || !Number.isFinite(value.helixRadiusMm) || value.helixRadiusMm <= 0 || value.helixRadiusMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "helixPitchMm")) {
    if (value.kind !== "helix" || typeof value.helixPitchMm !== "number" || !Number.isFinite(value.helixPitchMm) || value.helixPitchMm <= 0 || value.helixPitchMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "helixTurns")) {
    if (value.kind !== "helix" || typeof value.helixTurns !== "number" || !Number.isFinite(value.helixTurns) || value.helixTurns <= 0 || value.helixTurns > 100) return false;
  }
  if (Object.hasOwn(value, "helixHandedness")) {
    if (value.kind !== "helix" || !["right", "left"].includes(String(value.helixHandedness))) return false;
  }
  // Direct-edit kinds carry operation "direct-edit" and act on an existing body.
  if (value.kind === "move-body") {
    if (value.operation !== "direct-edit" || !Object.hasOwn(value, "moveDeltaMm")) return false;
  }
  if (value.kind === "scale-body") {
    if (value.operation !== "direct-edit" || !Object.hasOwn(value, "scaleFactor")) return false;
  }
  if (value.kind === "move-face") {
    if (value.operation !== "direct-edit" || !Object.hasOwn(value, "moveFaceDeltaMm") || !Object.hasOwn(value, "targetFaceRole")) return false;
  }
  if (value.kind === "offset-face") {
    if (value.operation !== "direct-edit" || !Object.hasOwn(value, "offsetFaceMm") || !Object.hasOwn(value, "targetFaceRole")) return false;
  }
  if (value.kind === "helix") {
    if (!Object.hasOwn(value, "helixRadiusMm") || !Object.hasOwn(value, "helixPitchMm") || !Object.hasOwn(value, "helixTurns")) return false;
  }
  if (value.operation === "direct-edit" && value.kind !== "move-body" && value.kind !== "scale-body" && value.kind !== "move-face" && value.kind !== "offset-face" && value.kind !== "emboss" && value.kind !== "sheet-edge-flange" && value.kind !== "hole" && value.kind !== "pattern" && value.kind !== "edge-blend" && value.kind !== "sheet-jog" && !Object.hasOwn(value, "bodyEdit")) return false;
  if (Object.hasOwn(value, "pattern") && value.kind !== "pattern") return false;
  if (value.kind === "pattern") {
    // A new-bodies pattern builds a body of its own; a joined pattern and a pattern of features change the body they are in.
    if (!validPatternDefinition(value.pattern)) return false;
    const pattern = value.pattern;
    if (value.operation !== (pattern.result === "new-bodies" ? "new-body" : "direct-edit")) return false;
    if (pattern.result === "new-bodies" && value.bodyId === pattern.sourceBodyId) return false;
    if (pattern.result !== "new-bodies" && value.bodyId !== pattern.sourceBodyId) return false;
  }
  if (!validEdgeBlendFields(value)) return false;
  if (Object.hasOwn(value, "edgeEndSizeMm")) {
    if (value.kind !== "edge-fillet" || typeof value.edgeEndSizeMm !== "number" || !Number.isFinite(value.edgeEndSizeMm) || value.edgeEndSizeMm <= 0 || value.edgeEndSizeMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "threadPitchMm")) {
    if (value.kind !== "thread" || typeof value.threadPitchMm !== "number" || !Number.isFinite(value.threadPitchMm) || value.threadPitchMm <= 0 || value.threadPitchMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "threadTurns")) {
    if (value.kind !== "thread" || typeof value.threadTurns !== "number" || !Number.isFinite(value.threadTurns) || value.threadTurns <= 0 || value.threadTurns > 100) return false;
  }
  if (Object.hasOwn(value, "threadDepthMm")) {
    if (value.kind !== "thread" || typeof value.threadDepthMm !== "number" || !Number.isFinite(value.threadDepthMm) || value.threadDepthMm <= 0 || value.threadDepthMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "threadHandedness")) {
    if (value.kind !== "thread" || !["right", "left"].includes(String(value.threadHandedness))) return false;
  }
  if (Object.hasOwn(value, "ribThicknessMm")) {
    if (value.kind !== "rib" || typeof value.ribThicknessMm !== "number" || !Number.isFinite(value.ribThicknessMm) || value.ribThicknessMm <= 0 || value.ribThicknessMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "ribDirection")) {
    if (value.kind !== "rib" || !["symmetric", "one-side"].includes(String(value.ribDirection))) return false;
  }
  if (Object.hasOwn(value, "domeHeightMm")) {
    if (value.kind !== "dome" || typeof value.domeHeightMm !== "number" || !Number.isFinite(value.domeHeightMm) || value.domeHeightMm === 0 || Math.abs(value.domeHeightMm) > 10_000) return false;
  }
  if (Object.hasOwn(value, "embossHeightMm")) {
    if (value.kind !== "emboss" || typeof value.embossHeightMm !== "number" || !Number.isFinite(value.embossHeightMm) || value.embossHeightMm === 0 || Math.abs(value.embossHeightMm) > 10_000) return false;
  }
  if (Object.hasOwn(value, "indentToolBodyId")) {
    if (value.kind !== "indent" || !stable(String(value.indentToolBodyId))) return false;
  }
  const sheetKind = value.kind === "sheet-base" || value.kind === "sheet-flange" || value.kind === "sheet-hem" || value.kind === "sheet-lofted-bend";
  const bendKind = sheetKind || value.kind === "sheet-edge-flange" || value.kind === "sheet-jog";
  if (Object.hasOwn(value, "sheetThicknessMm")) {
    if (!sheetKind || typeof value.sheetThicknessMm !== "number" || !Number.isFinite(value.sheetThicknessMm) || value.sheetThicknessMm <= 0 || value.sheetThicknessMm > 1000) return false;
  }
  if (Object.hasOwn(value, "sheetBendRadiusMm")) {
    if (!bendKind || typeof value.sheetBendRadiusMm !== "number" || !Number.isFinite(value.sheetBendRadiusMm) || value.sheetBendRadiusMm < 0 || value.sheetBendRadiusMm > 1000) return false;
  }
  if (Object.hasOwn(value, "flangeLengthMm")) {
    if (!bendKind || typeof value.flangeLengthMm !== "number" || !Number.isFinite(value.flangeLengthMm) || value.flangeLengthMm <= 0 || value.flangeLengthMm > 10_000) return false;
  }
  if (Object.hasOwn(value, "flangeAngleDeg")) {
    if ((value.kind !== "sheet-flange" && value.kind !== "sheet-edge-flange") || typeof value.flangeAngleDeg !== "number" || !Number.isFinite(value.flangeAngleDeg) || value.flangeAngleDeg <= 0 || value.flangeAngleDeg > 180) return false;
  }
  if (Object.hasOwn(value, "hemStyle")) {
    if (value.kind !== "sheet-hem" || !["closed", "open"].includes(String(value.hemStyle))) return false;
  }
  if (sheetKind && !Object.hasOwn(value, "sheetThicknessMm")) return false;
  if ((value.kind === "sheet-flange" || value.kind === "sheet-hem") && (!Object.hasOwn(value, "flangeLengthMm") || !Object.hasOwn(value, "sheetBendRadiusMm"))) return false;
  if (value.kind === "sheet-flange" && !Object.hasOwn(value, "flangeAngleDeg")) return false;
  if (Object.hasOwn(value, "flangeEdgeIndex")) {
    if (value.kind !== "sheet-edge-flange" || typeof value.flangeEdgeIndex !== "number" || !Number.isInteger(value.flangeEdgeIndex) || value.flangeEdgeIndex < 0 || value.flangeEdgeIndex > 1000) return false;
  }
  if (Object.hasOwn(value, "flangeReliefMm")) {
    if (value.kind !== "sheet-edge-flange" || typeof value.flangeReliefMm !== "number" || !Number.isFinite(value.flangeReliefMm) || value.flangeReliefMm < 0 || value.flangeReliefMm > 1000) return false;
  }
  if (Object.hasOwn(value, "flangeReliefShape")) {
    // How a corner relief is cut: a straight gap between the flanges, or a square or round notch taken out of the plate's corner.
    if (value.kind !== "sheet-edge-flange" || !["straight", "square", "round"].includes(String(value.flangeReliefShape))) return false;
  }
  const holeKeys = ["holeThread", "holeStyle", "holePositionMm", "holeNormal", "holeDiameterMm", "holeDepthMm", "holeCounterDiameterMm", "holeCounterDepthMm", "holeSinkDiameterMm", "holeSinkAngleDeg"];
  if (value.kind !== "hole" && holeKeys.some((key) => Object.hasOwn(value, key))) return false;
  if (value.kind === "hole") {
    const triple = (candidate: unknown, nonZero: boolean): boolean => Array.isArray(candidate) && candidate.length === 3 && candidate.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 1_000_000) && (!nonZero || candidate.some((entry) => entry !== 0));
    const positive = (candidate: unknown, max: number): boolean => typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate <= max;
    if (value.operation !== "direct-edit") return false;
    if (!["simple", "counterbore", "countersink"].includes(String(value.holeStyle))) return false;
    if (!triple(value.holePositionMm, false) || !triple(value.holeNormal, true) || !positive(value.holeDiameterMm, 10_000)) return false;
    if (Object.hasOwn(value, "holeDepthMm") && !(typeof value.holeDepthMm === "number" && Number.isFinite(value.holeDepthMm) && value.holeDepthMm >= 0 && value.holeDepthMm <= 100_000)) return false;
    const counterbore = value.holeStyle === "counterbore";
    const countersink = value.holeStyle === "countersink";
    if (counterbore !== (Object.hasOwn(value, "holeCounterDiameterMm") && Object.hasOwn(value, "holeCounterDepthMm"))) return false;
    if (countersink !== (Object.hasOwn(value, "holeSinkDiameterMm") && Object.hasOwn(value, "holeSinkAngleDeg"))) return false;
    if (!counterbore && (Object.hasOwn(value, "holeCounterDiameterMm") || Object.hasOwn(value, "holeCounterDepthMm"))) return false;
    if (!countersink && (Object.hasOwn(value, "holeSinkDiameterMm") || Object.hasOwn(value, "holeSinkAngleDeg"))) return false;
    if (counterbore && (!positive(value.holeCounterDiameterMm, 10_000) || !positive(value.holeCounterDepthMm, 100_000) || (value.holeCounterDiameterMm as number) <= (value.holeDiameterMm as number))) return false;
    if (Object.hasOwn(value, "holeThread")) {
      // A thread belongs on a plain hole: its diameter is the tap-drill (minor) diameter and the thread reaches the major diameter.
      const thread = value.holeThread;
      if (!isRecord(thread) || !hasOnly(thread, ["mode", "pitchMm", "majorDiameterMm", "handedness"], ["lengthMm"]) || value.holeStyle !== "simple") return false;
      if (!["cosmetic", "modelled"].includes(String(thread.mode)) || !["right", "left"].includes(String(thread.handedness))) return false;
      if (!positive(thread.pitchMm, 50) || !positive(thread.majorDiameterMm, 10_000) || (thread.majorDiameterMm as number) <= (value.holeDiameterMm as number)) return false;
      if ((thread.majorDiameterMm as number) - (value.holeDiameterMm as number) > 2 * (thread.pitchMm as number)) return false;
      if (Object.hasOwn(thread, "lengthMm") && !(typeof thread.lengthMm === "number" && Number.isFinite(thread.lengthMm) && thread.lengthMm >= 0 && thread.lengthMm <= 100_000)) return false;
    }
    if (countersink && (!positive(value.holeSinkDiameterMm, 10_000) || typeof value.holeSinkAngleDeg !== "number" || !(value.holeSinkAngleDeg >= 10 && value.holeSinkAngleDeg <= 170) || (value.holeSinkDiameterMm as number) <= (value.holeDiameterMm as number))) return false;
  }
  if (value.kind === "sheet-edge-flange") {
    if (value.operation !== "direct-edit") return false;
    if (!["flangeEdgeIndex", "sheetBendRadiusMm", "flangeLengthMm", "flangeAngleDeg"].every((key) => Object.hasOwn(value, key))) return false;
  }
  // Each new kind must carry its required parameters.
  if (value.kind === "thread") {
    if (!Object.hasOwn(value, "threadPitchMm") || !Object.hasOwn(value, "threadTurns") || !Object.hasOwn(value, "threadDepthMm")) return false;
  }
  if (value.kind === "rib") {
    if (!Object.hasOwn(value, "ribThicknessMm")) return false;
  }
  if (value.kind === "dome") {
    if (!Object.hasOwn(value, "domeHeightMm")) return false;
  }
  if (value.kind === "emboss") {
    if (!Object.hasOwn(value, "embossHeightMm") || !Object.hasOwn(value, "targetFaceRole")) return false;
  }
  if (value.kind === "indent") {
    if (!Object.hasOwn(value, "indentToolBodyId")) return false;
  }
  if (Object.hasOwn(value, "loftRailEntityId")) {
    if (value.kind !== "loft" || typeof value.loftRailEntityId !== "string" || value.loftRailEntityId.length === 0 || value.loftRailEntityId.length > 160) return false;
  }
  if (Object.hasOwn(value, "loftTopScale")) {
    if (value.kind !== "loft" && value.kind !== "sheet-lofted-bend") return false;
    if (typeof value.loftTopScale !== "number" || !Number.isFinite(value.loftTopScale) || value.loftTopScale <= 0 || value.loftTopScale > 100) return false;
  }
  if (Object.hasOwn(value, "loftSecondaryProfileIds")) {
    if (value.kind !== "loft" && value.kind !== "sheet-lofted-bend") return false;
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
  if (Object.hasOwn(value, "expressions") && !validFeatureExpressions(value.kind as DesignSolidFeature["kind"], value.expressions)) return false;
  // A body edit reshapes an existing body, so it is a direct edit; a shell or draft only counts as one when it carries the payload.
  const bodyEditKind = (BODY_EDIT_KINDS as readonly string[]).includes(String(value.kind));
  if (Object.hasOwn(value, "bodyEdit")) {
    if (!bodyEditKind || value.operation !== "direct-edit" || !validBodyEdit(value.bodyEdit, String(value.kind))) return false;
    if (Object.hasOwn(value, "shellOpenFace") || Object.hasOwn(value, "draftNeutralFace") || Object.hasOwn(value, "draftAngleDeg") || Object.hasOwn(value, "shellThicknessMm")) return false;
  } else if ((BODY_EDIT_ONLY_KINDS as readonly string[]).includes(String(value.kind))) return false;
  if (Object.hasOwn(value, "health") && !(isRecord(value.health) && hasOnly(value.health, ["message"], []) && shortText(value.health.message, 400))) return false;
  if (!validSheetFeatureExtras(value)) return false;
  return true;
}

/** Checks a saved timeline: feature shapes, unique IDs, solids built on earlier sketches, and a consistent rollback marker. */
export function validateDesignHistory(value: unknown, validSketch: (sketch: unknown) => boolean): value is DesignHistory {
  if (!isRecord(value) || !hasOnly(value, ["features", "rollbackIndex", "editingSketchId"], ["parameters"])) return false;
  const features = value.features;
  if (!Array.isArray(features) || features.length > MAX_DESIGN_FEATURES) return false;
  if (typeof value.rollbackIndex !== "number" || !Number.isInteger(value.rollbackIndex) || value.rollbackIndex < 0 || value.rollbackIndex > features.length) return false;
  const ids = new Set<string>();
  const sketchIds = new Set<string>();
  const bodyIds = new Set<string>();
  const solidsOfBody = new Map<string, Set<string>>();
  for (const feature of features) {
    if (!isRecord(feature) || !stable(feature.id) || ids.has(feature.id)) return false;
    ids.add(feature.id);
    if (feature.kind === "sketch") {
      if (!hasOnly(feature, ["id", "name", "kind", "suppressed", "sketch"], ["health"]) || !shortText(feature.name, 120) || typeof feature.suppressed !== "boolean" || !validSketch(feature.sketch)) return false;
      sketchIds.add(feature.id);
    } else {
      if (!validSolidFeaturePayload(feature) || !sketchIds.has(feature.sketchFeatureId)) return false;
      if (feature.kind === "pattern") {
        // A pattern copies a body an earlier step made, and repeats only earlier steps of that body.
        const pattern = (feature as unknown as DesignSolidFeature).pattern!;
        if (!bodyIds.has(pattern.sourceBodyId)) return false;
        if (pattern.featureIds !== undefined && pattern.featureIds.some((id) => !solidsOfBody.get(pattern.sourceBodyId)?.has(id))) return false;
      }
      if (modifiesBody(feature)) {
        // A join or cut modifies a body an earlier step made.
        if (!bodyIds.has(feature.bodyId)) return false;
      } else {
        if (bodyIds.has(feature.bodyId)) return false;
        bodyIds.add(feature.bodyId);
      }
      if (!solidsOfBody.has(feature.bodyId as string)) solidsOfBody.set(feature.bodyId as string, new Set());
      solidsOfBody.get(feature.bodyId as string)!.add(feature.id);
    }
  }
  if (!(value.editingSketchId === null || (typeof value.editingSketchId === "string" && sketchIds.has(value.editingSketchId)))) return false;
  // The parameter table and every bound number must form a graph without a cycle.
  return validParameterTable(value as unknown as DesignHistory);
}
