import type { WorkbenchOperation, WorkbenchProject, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, designOf } from "../../../packages/workbench-core/src/index.js";
import { isRebuildFailure, isRebuildNote, rebuildDependentsOfAll, type RebuildResult } from "./design-regeneration.js";
import { upgradeLegacyProfileRefs } from "./legacy-profile-refs.js";
import { refreshLooseSketchProjections, refreshSketchProjections } from "./sketch-projection-refresh.js";

/**
 * The life of a working sketch against the timeline: finishing it, cancelling it, and reopening another sketch while this one has
 * unfinished work. Everything here is a pure function of the project (plus the kernel rebuild, which is asynchronous), so the
 * app, the tests and any other host get the same answers, and each action produces ONE project to push, hence one Undo step.
 */
type Intent = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

export type SessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

let serial = 0;

/** Applies one operation to a project without recording it anywhere: the caller decides what becomes an Undo step. */
export function applyIntent(project: WorkbenchProject, intent: Intent): SessionResult<{ readonly project: WorkbenchProject; readonly summary: string }> {
  serial += 1;
  const operation = { ...intent, operationId: `operation:ui-session-${serial}-${Date.now().toString(36)}`, expectedRevision: project.revision } as WorkbenchOperation;
  const applied = applyWorkbenchOperation(project, operation);
  if (!applied.ok) return { ok: false, message: applied.diagnostics[0]?.message ?? "The project operation was rejected." };
  return { ok: true, value: { project: applied.value.project, summary: applied.value.summary } };
}

function sameSketch(a: WorkbenchSketch, b: WorkbenchSketch): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export type WorkingSketchState =
  /** Nothing to record: the sketch is empty and new, or it is exactly what the timeline already holds. */
  | { readonly kind: "clean"; readonly sketchFeatureId: string | undefined }
  /** New geometry that is not in the timeline yet. */
  | { readonly kind: "new-unsaved" }
  /** A timeline sketch that was changed (including emptied) since it was opened. */
  | { readonly kind: "edited"; readonly sketchFeatureId: string };

/** Compares the working sketch with the timeline sketch it came from. */
export function workingSketchState(project: WorkbenchProject): WorkingSketchState {
  const history = designOf(project);
  const editing = history.features.find((feature) => feature.id === history.editingSketchId && feature.kind === "sketch");
  if (editing === undefined || editing.kind !== "sketch") return project.sketch.entities.length === 0 ? { kind: "clean", sketchFeatureId: undefined } : { kind: "new-unsaved" };
  return sameSketch(editing.sketch, project.sketch) ? { kind: "clean", sketchFeatureId: editing.id } : { kind: "edited", sketchFeatureId: editing.id };
}

/**
 * The timeline features that are in both projects and are not the same in the second: a finished sketch whose curves or dimensions
 * changed, a step whose numbers changed. A change of the health note alone does not count (it says how the last rebuild went).
 * Finishing a sketch can change other features without touching them directly, because a dimension of the finished sketch may be
 * used by name (d1) in another sketch's dimension or in a step's value; those are what this finds.
 */
export function changedTimelineFeatureIds(before: WorkbenchProject, after: WorkbenchProject): readonly string[] {
  const earlier = new Map(designOf(before).features.map((feature) => [feature.id, feature] as const));
  const plain = (feature: object): string => JSON.stringify({ ...feature, health: undefined });
  return designOf(after).features.flatMap((feature) => {
    const was = earlier.get(feature.id);
    if (was === undefined || was === feature || was.kind !== feature.kind) return [];
    if (feature.kind === "sketch" && was.kind === "sketch") return was.name === feature.name && was.suppressed === feature.suppressed && sameSketch(was.sketch, feature.sketch) ? [] : [feature.id];
    return plain(was) === plain(feature) ? [] : [feature.id];
  });
}

export interface CommitOutcome {
  readonly project: WorkbenchProject;
  /** The timeline sketch that now holds the working sketch, or undefined when there was nothing to record. */
  readonly sketchFeatureId: string | undefined;
  readonly rebuilt: readonly RebuildResult[];
  readonly failed: readonly RebuildResult[];
  /** What the region detector said about steps that were rebuilt (a hole left out, a curve crossing an outline): the step was applied. */
  readonly notes: readonly string[];
  /** True when the project changed at all. */
  readonly changed: boolean;
  readonly summary: string;
}

/**
 * Finishes the working sketch into the timeline and rebuilds the solids that stand on it, as ONE new project. The sketch update
 * and the regenerated solids used to be two project pushes, so one Undo left the sketch and the solids out of step (audit
 * Sketch-to-solid P25). `then` operations (reopen another sketch, start a new one) join the same project so they share the step.
 */
export async function commitWorkingSketchAtomically(
  project: WorkbenchProject,
  options: { readonly featureId: string; readonly name: string; readonly then?: readonly Intent[] }
): Promise<SessionResult<CommitOutcome>> {
  const state = workingSketchState(project);
  let current = project;
  let sketchFeatureId: string | undefined = state.kind === "clean" ? state.sketchFeatureId : undefined;
  let rebuilt: readonly RebuildResult[] = [];
  let summary = "";
  let changed = false;
  if (state.kind !== "clean") {
    // Features that stored a bare profile name still know their region by the sketch the timeline holds; once the edit replaces it they would not.
    if (state.kind === "edited") current = upgradeLegacyProfileRefs(current, state.sketchFeatureId).project;
    const beforeCommit = current;
    const committed = applyIntent(current, { kind: "commit-design-sketch", featureId: options.featureId, name: options.name });
    if (!committed.ok) return committed;
    current = committed.value.project;
    summary = committed.value.summary;
    changed = true;
    sketchFeatureId = designOf(current).editingSketchId ?? undefined;
    // The edited sketch, and every other sketch or step that the commit changed with it: a dimension of this sketch used by name
    // somewhere else re-drives that sketch or step in the same operation, and the bodies built there have to follow too.
    const roots = [...new Set([...(state.kind === "edited" && sketchFeatureId !== undefined ? [sketchFeatureId] : []), ...changedTimelineFeatureIds(beforeCommit, current)])];
    if (roots.length > 0) {
      rebuilt = await rebuildDependentsOfAll(current, roots);
      if (rebuilt.length > 0) {
        const regenerated = applyIntent(current, { kind: "regenerate-design", results: rebuilt });
        if (!regenerated.ok) return regenerated;
        current = regenerated.value.project;
        // A sketch that projected one of the rebuilt solids but has no step yet is not replayed by any of them: its curves are refreshed by sketch.
        const loose = await refreshLooseSketchProjections(current);
        if (loose.length > 0) {
          const refreshed = applyIntent(current, { kind: "regenerate-design", results: [], sketchCurves: loose });
          if (!refreshed.ok) return refreshed;
          current = refreshed.value.project;
        }
      }
    }
  }
  for (const next of options.then ?? []) {
    const applied = applyIntent(current, next);
    if (!applied.ok) return applied;
    current = applied.value.project;
    summary = applied.value.summary;
    changed = true;
    // A sketch that is opened shows its projected curves where their solids are now, whatever rebuilt (or did not) since it was finished.
    if (next.kind === "edit-design-sketch") {
      const refresh = await refreshSketchProjections(current, next.featureId);
      if (refresh !== undefined) {
        const refreshed = applyIntent(current, { kind: "regenerate-design", results: [], sketchCurves: [refresh] });
        if (!refreshed.ok) return refreshed;
        current = refreshed.value.project;
      }
    }
  }
  const failed = rebuilt.filter(isRebuildFailure);
  const notes = rebuilt.flatMap((result) => (isRebuildNote(result.message) ? [result.message!] : []));
  return { ok: true, value: { project: current, sketchFeatureId, rebuilt, failed, notes, changed, summary } };
}

export type CancelOutcome =
  | { readonly kind: "nothing-to-discard" }
  | { readonly kind: "discarded"; readonly project: WorkbenchProject; readonly summary: string };

/**
 * Cancel in the confirmation corner: throws away what this sketch session changed. A sketch that came from the timeline goes back
 * to the timeline's version; a new one goes back to how it was when the Sketch workspace was entered (`entry`, empty for a sketch
 * started from the plane dialog). The restored project is one Undo step, so a Cancel pressed by mistake can be undone.
 */
export function cancelSketchSession(project: WorkbenchProject, entry: WorkbenchSketch | undefined): SessionResult<CancelOutcome> {
  const state = workingSketchState(project);
  if (state.kind === "clean") return { ok: true, value: { kind: "nothing-to-discard" } };
  if (state.kind === "edited") {
    const reopened = applyIntent(project, { kind: "edit-design-sketch", featureId: state.sketchFeatureId });
    if (!reopened.ok) return reopened;
    return { ok: true, value: { kind: "discarded", project: reopened.value.project, summary: "Discarded the sketch changes; the sketch is back as it was in the timeline." } };
  }
  const baseline = entry ?? { ...project.sketch, entities: [], constraints: [] };
  if (sameSketch(baseline, project.sketch)) return { ok: true, value: { kind: "nothing-to-discard" } };
  const fresh = applyIntent(project, {
    kind: "new-design-sketch",
    plane: baseline.plane,
    ...(baseline.plane === "datum:yz" && baseline.planeFrame === undefined ? { convention: baseline.planeConvention === "z-up" ? "z-up" as const : "legacy" as const } : {}),
    ...(baseline.planeOffsetMm === undefined || baseline.planeOffsetMm === 0 ? {} : { offsetMm: baseline.planeOffsetMm }),
    ...(baseline.planeTilt === undefined ? {} : { tilt: baseline.planeTilt }),
    ...(baseline.planeFrame === undefined ? {} : { frame: baseline.planeFrame })
  });
  if (!fresh.ok) return fresh;
  let restored = fresh.value.project;
  if (baseline.entities.length > 0) {
    const refilled = applyIntent(restored, { kind: "apply-sketch-edit", label: "Restored the sketch as it was", removeEntityIds: [], updateEntities: [], addEntities: baseline.entities, addConstraints: baseline.constraints });
    if (!refilled.ok) return refilled;
    restored = refilled.value.project;
  }
  return { ok: true, value: { kind: "discarded", project: restored, summary: "Discarded the sketch session; the sketch is back as it was when you opened it." } };
}
