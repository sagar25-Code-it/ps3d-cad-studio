import { baseFeatureOf, deleteDesignFeature, designOf, emptyDesignHistory, isFeatureActive, MAX_DESIGN_FEATURES, uniqueFeatureName, withHistory, type DesignChange } from "./design.js";
import {
  isReferenceFeature,
  listFor,
  materializeReference,
  referenceKindOf,
  referenceNeeds,
  sameValue,
  specOfItem,
  type ReferenceFeature,
  type ReferenceItem,
  type ReferenceSpec
} from "./reference-feature.js";
import type { DesignFeature, DesignHistory, DesignSolidFeature, PartIntent, SketchPlaneFrame, WorkbenchDiagnostic, WorkbenchProject } from "./types.js";

/**
 * Keeps the part's construction planes, axes, points and primitives and the timeline steps that describe them in step (see
 * reference-feature.ts). Two directions, both pure and both run after every operation:
 *
 *  - `syncReferenceItems`: the timeline is the truth. Each step's item is derived from it; an item is shown while its step is live (before
 *    the rollback marker, not suppressed, built on live steps) and hidden when it stops being, as a body is.
 *  - `adoptListChanges`: the lists are what the older operations (and an MCP client) write. An item they add gets a step at the marker, an
 *    item they delete takes its step (and what depends on it) with it, and an item they change (a primitive moved or resized, a rename)
 *    is recorded in its step.
 *
 * Items that predate the timeline stay as they are, without a step, until `adoptLegacyReferences` puts them in.
 */

function fail(message: string, relatedIds: readonly string[], recovery: string, code: WorkbenchDiagnostic["code"] = "INVALID_OPERATION"): DesignChange {
  return { ok: false, diagnostics: [{ code, message, relatedIds, recovery }] };
}

const insertAt = <T>(items: readonly T[], index: number, item: T): readonly T[] => [...items.slice(0, index), item, ...items.slice(index)];

const SPEC_KINDS: readonly ReferenceSpec["kind"][] = ["axis", "plane", "point", "primitive"];

type PartLists = Pick<PartIntent, "construction" | "constructionAxes" | "constructionPoints" | "previewBodies">;
const KEY_OF: Readonly<Record<ReferenceSpec["kind"], keyof PartLists>> = { plane: "construction", axis: "constructionAxes", point: "constructionPoints", primitive: "previewBodies" };

const referenceSteps = (history: DesignHistory | undefined): readonly ReferenceFeature[] => (history?.features ?? []).filter(isReferenceFeature);

function sameLists(a: WorkbenchProject, b: WorkbenchProject): boolean {
  return a.part.construction === b.part.construction && a.part.constructionAxes === b.part.constructionAxes
    && a.part.constructionPoints === b.part.constructionPoints && a.part.previewBodies === b.part.previewBodies;
}

function withLists(project: WorkbenchProject, lists: Partial<Record<keyof PartLists, readonly ReferenceItem[]>>): WorkbenchProject {
  return { ...project, part: { ...project.part, ...lists } as PartIntent };
}

// ---------------------------------------------------------------------------------------------
// Timeline to part
// ---------------------------------------------------------------------------------------------

/**
 * Makes the part's lists show what the timeline's reference steps say. A step with no item gets one; an item whose step is gone is
 * removed; an item that differs from its step is replaced by what the step derives. Visibility follows the step's live state when that
 * changed (a step that became live is shown, one that stopped being is hidden) and is the person's own choice otherwise.
 */
export function syncReferenceItems(project: WorkbenchProject, previous: DesignHistory | undefined): WorkbenchProject {
  const history = project.design;
  const steps = referenceSteps(history);
  const earlier = referenceSteps(previous);
  if (steps.length === 0 && earlier.length === 0) return project;
  const lists: Record<ReferenceSpec["kind"], readonly ReferenceItem[]> = {
    plane: listFor(project, "plane"), axis: listFor(project, "axis"), point: listFor(project, "point"), primitive: listFor(project, "primitive")
  };
  const touched = new Set<ReferenceSpec["kind"]>();
  const stepIds = new Set(steps.map((step) => step.id));
  // An item whose step is gone goes with it, unless another step now describes the same item.
  for (const gone of earlier) {
    if (stepIds.has(gone.id) || steps.some((step) => step.bodyId === gone.bodyId && step.reference.kind === gone.reference.kind)) continue;
    const kind = gone.reference.kind;
    if (lists[kind].some((item) => item.id === gone.bodyId)) { lists[kind] = lists[kind].filter((item) => item.id !== gone.bodyId); touched.add(kind); }
  }
  for (const step of steps) {
    const kind = step.reference.kind;
    const active = history !== undefined && isFeatureActive(history, step.id);
    const existing = lists[kind].find((item) => item.id === step.bodyId);
    const before = previous?.features.find((candidate) => candidate.id === step.id);
    const wasActive = before === undefined || previous === undefined ? undefined : isFeatureActive(previous, step.id);
    const visible = existing === undefined ? active : wasActive === undefined ? existing.visible && active : wasActive !== active ? active : existing.visible;
    const wanted = materializeReference(step, visible);
    if (existing !== undefined && sameValue(existing, wanted)) continue;
    lists[kind] = existing === undefined ? [...lists[kind], wanted] : lists[kind].map((item) => item.id === step.bodyId ? wanted : item);
    touched.add(kind);
  }
  if (touched.size === 0) return project;
  const changes: Partial<Record<keyof PartLists, readonly ReferenceItem[]>> = {};
  for (const kind of touched) changes[KEY_OF[kind]] = lists[kind];
  return withLists(project, changes);
}

// ---------------------------------------------------------------------------------------------
// Part to timeline
// ---------------------------------------------------------------------------------------------

function stepIdFor(history: DesignHistory, itemId: string): string {
  const slug = `feature:ref-${itemId.replace(/[^a-z0-9._-]/gu, "-")}`.slice(0, 120);
  let candidate = slug;
  for (let copy = 2; history.features.some((feature) => feature.id === candidate); copy += 1) candidate = `${slug.slice(0, 112)}-${copy}`;
  return candidate;
}

/** A new step for an item of the part that no step describes. */
export function stepForItem(history: DesignHistory, kind: ReferenceSpec["kind"], item: ReferenceItem): ReferenceFeature {
  return {
    id: stepIdFor(history, item.id),
    name: uniqueFeatureName(history, item.name),
    kind: referenceKindOf({ kind } as ReferenceSpec),
    suppressed: false,
    sketchFeatureId: "",
    profileIds: [],
    valueMm: 0,
    bodyId: item.id,
    reference: specOfItem(kind, item)
  } as ReferenceFeature;
}

/** The items of the part that no timeline step describes yet (the ones saved before reference steps existed, or added since the lists were last adopted). */
export function legacyReferenceItems(project: WorkbenchProject): readonly { readonly id: string; readonly name: string; readonly kind: ReferenceSpec["kind"] }[] {
  const owned = new Set(referenceSteps(project.design).map((step) => step.bodyId));
  const found: { id: string; name: string; kind: ReferenceSpec["kind"] }[] = [];
  for (const kind of SPEC_KINDS) for (const item of listFor(project, kind)) if (!owned.has(item.id)) found.push({ id: item.id, name: item.name, kind });
  return found;
}

/**
 * Brings what an operation did to the part's lists into the timeline: a new item gets a step at the rollback marker, a deleted item takes
 * its step and what is built on it with it, and a changed item (moved, resized, renamed) is recorded in its step. `before` is the project
 * the operation started from.
 */
export function adoptListChanges(before: WorkbenchProject, after: WorkbenchProject): WorkbenchProject {
  if (sameLists(before, after)) return after;
  let project = after;
  // Items the operation deleted: their steps go, with every step built on them.
  for (const step of referenceSteps(project.design)) {
    const now = listFor(project, step.reference.kind).some((item) => item.id === step.bodyId);
    const was = listFor(before, step.reference.kind).some((item) => item.id === step.bodyId);
    if (now || !was || !designOf(project).features.some((feature) => feature.id === step.id)) continue;
    const removed = deleteDesignFeature(project, step.id);
    if (removed.ok) project = removed.value.project;
  }
  // Items the operation added: each becomes a step at the marker (axes first, so a plane or point made in the same operation finds its axis).
  for (const kind of SPEC_KINDS) {
    const known = new Set(listFor(before, kind).map((item) => item.id));
    for (const item of listFor(project, kind)) {
      const history = designOf(project);
      if (known.has(item.id) || referenceSteps(history).some((step) => step.bodyId === item.id) || history.features.length >= MAX_DESIGN_FEATURES) continue;
      const step = stepForItem(history, kind, item);
      project = withHistory(project, { ...history, features: insertAt(history.features, history.rollbackIndex, step), rollbackIndex: history.rollbackIndex + 1 });
    }
  }
  // Items the operation changed: the step records what the item says now.
  for (const step of referenceSteps(project.design)) {
    const kind = step.reference.kind;
    const item = listFor(project, kind).find((candidate) => candidate.id === step.bodyId);
    const was = listFor(before, kind).find((candidate) => candidate.id === step.bodyId);
    if (item === undefined || was === undefined || item === was) continue;
    const spec = specOfItem(kind, item);
    const specChanged = !sameValue(spec, step.reference);
    const renamed = item.name !== was.name && item.name !== step.name;
    if (!specChanged && !renamed) continue;
    const history = designOf(project);
    const { expressions: _expressions, ...bare } = step;
    void _expressions;
    const next: DesignSolidFeature = { ...(specChanged ? bare : step), reference: spec, name: renamed ? uniqueFeatureName(history, item.name, step.id) : step.name };
    project = withHistory(project, { ...history, features: history.features.map((feature): DesignFeature => feature.id === step.id ? next : feature) });
  }
  return project;
}

/**
 * Run after every operation: what the operation did to the lists is adopted into the timeline, then what the timeline says is written
 * back into the lists. `before` is the project the operation started from.
 */
export function reconcileReferences(before: WorkbenchProject, after: WorkbenchProject): WorkbenchProject {
  const involved = before.design?.features.some(isReferenceFeature) === true || after.design?.features.some(isReferenceFeature) === true || !sameLists(before, after);
  if (!involved) return after;
  const adopted = adoptListChanges(before, after);
  if (adopted === after && adopted.design === before.design) return after;
  return syncReferenceItems(adopted, before.design);
}

/** Puts every item that predates the timeline into it as a step, in the order of the lists, at the rollback marker. Refused when there is none. */
export function adoptLegacyReferences(project: WorkbenchProject): DesignChange {
  const legacy = legacyReferenceItems(project);
  if (legacy.length === 0) return fail("Every construction plane, axis, point and primitive is already a step of the timeline.", [], "Nothing to add.");
  const history = designOf(project);
  if (history.features.length + legacy.length > MAX_DESIGN_FEATURES) return fail(`The timeline has room for ${MAX_DESIGN_FEATURES - history.features.length} more steps, and ${legacy.length} items are waiting.`, [], "Delete steps you no longer need first.", "RESOURCE_LIMIT");
  const emptied = withLists(project, { construction: [], constructionAxes: [], constructionPoints: [], previewBodies: [] });
  const adopted = adoptListChanges(emptied, project);
  const next = syncReferenceItems(adopted, project.design);
  return { ok: true, value: { project: next, changedIds: legacy.map((item) => item.id), summary: `Added ${legacy.length} construction ${legacy.length === 1 ? "item" : "items"} to the timeline.` } };
}

// ---------------------------------------------------------------------------------------------
// Editing a step
// ---------------------------------------------------------------------------------------------

/** Replaces a reference step (its definition, name or expressions). The item of the part follows when the operation is reconciled. */
export function updateDesignReference(project: WorkbenchProject, feature: DesignSolidFeature): DesignChange {
  const history = designOf(project);
  const index = history.features.findIndex((candidate) => candidate.id === feature.id);
  const existing = history.features[index];
  if (existing === undefined || !isReferenceFeature(existing)) return fail("The step to edit is not a construction plane, axis, point or primitive of the timeline.", [feature.id], "Pick one of those steps.", "BROKEN_REFERENCE");
  if (!isReferenceFeature(feature) || feature.kind !== existing.kind || feature.reference.kind !== existing.reference.kind || feature.bodyId !== existing.bodyId) {
    return fail("A construction step keeps its kind and its identity when it is edited.", [feature.id], "Edit the numbers of the step, not what kind of step it is.");
  }
  const name = feature.name.trim();
  if (name === "") return fail("The step name cannot be blank.", [feature.id], "Type at least one character for the name.");
  const clash = history.features.find((candidate) => candidate.id !== feature.id && candidate.name.trim().toLowerCase() === name.toLowerCase());
  if (clash !== undefined) return fail(`Another timeline step is already called "${clash.name}", and two steps cannot share a name.`, [feature.id, clash.id], `Choose a different name, for example "${uniqueFeatureName(history, name, feature.id)}".`);
  const { health: _cleared, ...clean } = feature;
  void _cleared;
  const candidate = { ...clean, name } as DesignSolidFeature;
  const features = history.features.map((entry): DesignFeature => entry.id === feature.id ? candidate : entry);
  const next: DesignHistory = { ...history, features };
  // What the edited step is built on has to come before it.
  const problem = referenceNeeds(next, candidate, (bodyId) => baseFeatureOf(next, bodyId)).find((need) => next.features.findIndex((entry) => entry.id === need.id) > index);
  if (problem !== undefined) {
    const late = next.features.find((entry) => entry.id === problem.id)!;
    return fail(`${name} cannot be built on ${late.name}: that step comes after it in the timeline.`, [feature.id, late.id], `Move ${late.name} before ${name}, or choose something that comes earlier.`);
  }
  return { ok: true, value: { project: withHistory(project, next), changedIds: [feature.id], summary: `Updated ${name}.` } };
}

/** Moves the sketches placed on construction planes onto the frames given (the planes as they are now). Frames for other sketches are refused. */
export function followDesignPlanes(project: WorkbenchProject, frames: readonly { readonly featureId: string; readonly frame: SketchPlaneFrame }[]): DesignChange {
  const history = designOf(project);
  const byId = new Map(frames.map((entry) => [entry.featureId, entry.frame]));
  for (const featureId of byId.keys()) {
    const feature = history.features.find((candidate) => candidate.id === featureId);
    if (feature === undefined || feature.kind !== "sketch" || feature.sketch.planeRef === undefined) return fail("Only a sketch placed on a construction plane follows one.", [featureId], "Pick a sketch that was started on a construction plane.", "BROKEN_REFERENCE");
  }
  const moved: string[] = [];
  const features = history.features.map((feature): DesignFeature => {
    const frame = byId.get(feature.id);
    if (frame === undefined || feature.kind !== "sketch" || sameValue(feature.sketch.planeFrame, frame)) return feature;
    moved.push(feature.id);
    return { ...feature, sketch: { ...feature.sketch, planeFrame: frame } };
  });
  if (moved.length === 0) return { ok: true, value: { project, changedIds: [], summary: "The sketches on construction planes are already on their planes." } };
  const editing = history.editingSketchId !== null && moved.includes(history.editingSketchId) ? byId.get(history.editingSketchId) : undefined;
  const next: WorkbenchProject = editing === undefined ? project : { ...project, sketch: { ...project.sketch, planeFrame: editing } };
  return { ok: true, value: { project: withHistory(next, { ...history, features }), changedIds: moved, summary: `Moved ${moved.length} sketch${moved.length === 1 ? "" : "es"} with the plane${moved.length === 1 ? "" : "s"} they are placed on.` } };
}

/** The ids of the construction items that are hidden by the timeline (rolled back, suppressed or built on something that is), for pickers that should not offer them. */
export function inactiveReferenceIds(project: WorkbenchProject): ReadonlySet<string> {
  const history = project.design ?? emptyDesignHistory();
  return new Set(referenceSteps(history).filter((step) => !isFeatureActive(history, step.id)).map((step) => step.bodyId));
}
