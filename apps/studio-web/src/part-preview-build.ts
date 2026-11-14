import type { DesignSolidFeature, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, baseFeatureOf, designOf } from "../../../packages/workbench-core/src/index.js";
import { applyEdgeBlend, shellBody } from "../../../packages/workbench-geometry/src/index.js";
import { isRebuildFailure, isRebuildNote, replayBodyState } from "./design-regeneration.js";
import { facesOfBody } from "./edge-blend-step.js";
import { applyParameterValues } from "./feature-parameters.js";
import { panelDraft, panelEdgeGroups, type CommandPanelState } from "./command-panel.js";
import type { PreviewBuild, PreviewRequest } from "./part-preview.js";

/**
 * Builds the ghost for a command's current inputs without committing anything. The step is added to (or changed in) a COPY of the
 * project and the body is replayed from the timeline, exactly the work the real commit does, so the ghost is what OK would make:
 * same builder, same refusals. The real project, the history and the undo stack are never touched.
 *
 * Two entry points feed part-preview.ts:
 *  - `panelPreviewRequest`: a command panel's state (Fillet, Chamfer, Shell, Hole; create and Edit Feature).
 *  - `featurePreviewRequest`: a finished candidate step, for the Edit Feature dock and for commands that build the step themselves
 *    (Extrude and Revolve hand in the step they would add).
 */

/** The step the panel would commit with these values, or why it cannot be built yet. Cheap: no rebuild happens here. */
export type PanelCandidate =
  | { readonly ok: true; readonly feature: DesignSolidFeature; readonly body: GeneralSolidBody; /** Undefined for a solid with no timeline step (the one-shot mesh path). */ readonly timelineSketchId: string | undefined }
  | { readonly ok: false; readonly message: string };

export function panelCandidate(project: WorkbenchProject, state: CommandPanelState): PanelCandidate {
  const body = (project.part.generalBodies ?? []).find((candidate) => candidate.id === state.bodyId);
  if (body === undefined) return { ok: false, message: state.command === "hole" ? "click the face where the hole should start." : state.command === "shell" ? "click a face of the solid to start." : "click an edge of a solid in the view." };
  const history = designOf(project);
  const base = baseFeatureOf(history, body.id);
  const existing = state.editFeatureId === undefined ? undefined : history.features.find((candidate): candidate is DesignSolidFeature => candidate.id === state.editFeatureId && candidate.kind !== "sketch");
  if (base === undefined && existing === undefined) return { ok: true, feature: meshStandIn(state), body, timelineSketchId: undefined };
  const draft = panelDraft(state, { sketchFeatureId: base?.sketchFeatureId ?? existing!.sketchFeatureId, ...(existing === undefined ? {} : { existing }) });
  if (!draft.ok) return { ok: false, message: draft.message.charAt(0).toLowerCase() + draft.message.slice(1) };
  const applied = applyParameterValues(draft.feature, state.values, project);
  if (!applied.ok) return { ok: false, message: applied.message };
  return { ok: true, feature: applied.feature, body, timelineSketchId: base?.sketchFeatureId ?? existing!.sketchFeatureId };
}

/** A solid with no timeline step takes a one-shot change on its mesh; this placeholder only carries the command name for the key. */
function meshStandIn(state: CommandPanelState): DesignSolidFeature {
  return { id: `feature:preview-${state.command}`, name: state.command, kind: "edge-blend", suppressed: false, sketchFeatureId: "", profileIds: [], valueMm: 1, bodyId: state.bodyId ?? "" };
}

let serial = 0;

/** Adds or changes the step on a copy of the project and replays the body: the ghost is the body as it would be after OK. */
export async function previewStep(project: WorkbenchProject, feature: DesignSolidFeature, mode: "create" | "edit", body: GeneralSolidBody, control: { readonly isStale: () => boolean }): Promise<PreviewBuild> {
  serial += 1;
  const operation = mode === "edit" ? { kind: "update-design-solid" as const, feature, body } : { kind: "add-design-solid" as const, feature, body };
  const applied = applyWorkbenchOperation(project, { ...operation, operationId: `operation:preview-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  if (!applied.ok) return { ok: false, message: applied.diagnostics[0]?.message ?? "The project would not take this step." };
  if (control.isStale()) return { ok: false, message: "A newer value replaced this one." };
  const replayed = await replayBodyState(applied.value.project, feature.bodyId);
  const mine = replayed.results.find((result) => result.featureId === feature.id);
  if (mine !== undefined && isRebuildFailure(mine)) return { ok: false, message: mine.message ?? "The step could not be built." };
  const current = replayed.current;
  if (current === undefined || current.positionsMm.length < 9 || current.indices.length < 3) return { ok: false, message: "The result could not be built from the timeline." };
  const existed = (project.part.generalBodies ?? []).some((candidate) => candidate.id === feature.bodyId);
  return {
    ok: true,
    ghost: { positionsMm: current.positionsMm, indices: current.indices, ...(existed ? { replacesBodyId: feature.bodyId } : {}) },
    ...(mine?.message !== undefined && isRebuildNote(mine.message) ? { note: mine.message } : {})
  };
}

/** Fillet, chamfer and shell on a solid that has no timeline step: the same one-shot the commit uses, on the mesh, with plain numbers. */
function previewOnMesh(state: CommandPanelState, body: GeneralSolidBody): PreviewBuild {
  const input = { positionsMm: body.positionsMm, indices: body.indices };
  const plain = (text: string | undefined): number => Number((text ?? "").trim().replace(",", "."));
  const show = (result: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): PreviewBuild => ({ ok: true, ghost: { positionsMm: result.positionsMm, indices: result.indices, replacesBodyId: body.id } });
  if (state.command === "fillet" || state.command === "chamfer") {
    const groups = panelEdgeGroups(state);
    if (groups.length === 0) return { ok: false, message: "click at least one edge in the view." };
    const size = plain(state.values["size"]);
    if (!Number.isFinite(size) || size <= 0) return { ok: false, message: "enter a positive size as a plain number (this solid has no timeline, so expressions are not available)." };
    const result = applyEdgeBlend(input, facesOfBody(body), groups, { type: state.command, sizeMm: size });
    return result.ok ? show(result) : { ok: false, message: result.message };
  }
  if (state.command === "shell") {
    const wall = plain(state.values["wall"]);
    if (!Number.isFinite(wall) || wall <= 0) return { ok: false, message: "enter a positive wall thickness as a plain number." };
    const sideText = state.values["side"];
    const result = shellBody(input, { thicknessMm: wall, side: sideText === "outside" || sideText === "both" ? sideText : "inside", openFaces: state.faces.map((entry) => entry.ref) });
    return result.ok ? show(result) : { ok: false, message: result.message };
  }
  return { ok: false, message: "a hole on a solid with no timeline step has no preview." };
}

/** Text that is equal exactly when the panel's inputs and the project are equal: what the controller compares to skip a rebuild. */
export function panelPreviewKey(project: WorkbenchProject, state: CommandPanelState): string {
  return JSON.stringify([
    project.id, project.revision, state.command, state.mode, state.editFeatureId ?? null, state.bodyId ?? null, state.values,
    state.edges.map((entry) => [entry.bodyId, entry.chain]), state.storedGroups?.length ?? 0,
    state.faces.map((entry) => [entry.ref.pointMm, entry.ref.normalMm]), state.holePoint ?? null
  ]);
}

/**
 * The preview request for a command panel, or the reason there is none yet. `getProject` is read when the build runs, and the
 * request is dropped when the project moved on in between (a revision change makes the key different, so a new request follows).
 */
export function panelPreviewRequest(project: WorkbenchProject, state: CommandPanelState): PreviewRequest | { readonly invalid: string } {
  const candidate = panelCandidate(project, state);
  if (!candidate.ok) return { invalid: candidate.message };
  const { feature, body, timelineSketchId } = candidate;
  return {
    key: panelPreviewKey(project, state),
    build: (control) => timelineSketchId === undefined ? previewOnMesh(state, body) : previewStep(project, feature, state.mode, body, control)
  };
}

/**
 * The preview request for a finished candidate step (Edit Feature dock, Extrude, Revolve): `mode` says whether it is added or replaces a
 * step. A command that makes a body of its own (Extrude as a new body) passes `newBody`, the body it built for the step, as it would
 * hand it to the add-design-solid operation; otherwise the step's body is looked up in the project.
 */
export function featurePreviewRequest(project: WorkbenchProject, feature: DesignSolidFeature, mode: "create" | "edit", newBody?: GeneralSolidBody): PreviewRequest | { readonly invalid: string } {
  const body = newBody ?? (project.part.generalBodies ?? []).find((candidate) => candidate.id === feature.bodyId);
  if (body === undefined) return { invalid: "the solid this step works on is not in the model." };
  return {
    key: JSON.stringify([project.id, project.revision, mode, feature]),
    build: (control) => previewStep(project, feature, mode, body, control)
  };
}
