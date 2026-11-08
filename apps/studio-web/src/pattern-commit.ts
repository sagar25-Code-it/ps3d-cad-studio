import type { DesignSolidFeature, PatternDefinition, PatternShape, WorkbenchOperation, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { MAX_DESIGN_FEATURES, MAX_GENERAL_BODIES, applyWorkbenchOperation, baseFeatureOf, describePattern, designOf, isFeatureActive, modifiesBody } from "../../../packages/workbench-core/src/index.js";
import { patternTransforms, summarizePattern } from "../../../packages/workbench-geometry/src/index.js";
import { replayAllBodies } from "./design-regeneration.js";
import { copyGeneralBody, patternContextOf } from "./pattern-replay.js";

/** What the pattern dialog asks for. `featureIds` empty or absent patterns the whole body; otherwise it repeats those hole and cut steps. */
export interface PatternRequest {
  readonly shape: PatternShape;
  readonly result: "new-bodies" | "join";
  readonly sourceBodyId: string;
  readonly featureIds?: readonly string[];
}

export type PatternCommit =
  | { readonly ok: true; readonly project: WorkbenchProject; readonly summary: string; readonly groupId: string; readonly selectBodyId: string }
  | { readonly ok: false; readonly message: string };

export interface PatternPreview {
  readonly ok: true;
  readonly instances: number;
  readonly copies: number;
  readonly text: string;
  readonly overlapping: boolean;
}

let serial = 0;
const freshId = (prefix: string): string => {
  serial += 1;
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${serial}`;
  return `${prefix}:${random.toLowerCase()}`;
};

function run(project: WorkbenchProject, intent: Record<string, unknown>): { readonly ok: true; readonly project: WorkbenchProject } | { readonly ok: false; readonly message: string } {
  const result = applyWorkbenchOperation(project, { ...intent, operationId: freshId("operation"), expectedRevision: project.revision } as unknown as WorkbenchOperation);
  return result.ok ? { ok: true, project: result.value.project } : { ok: false, message: result.diagnostics[0]?.message ?? "The project rejected the pattern." };
}

/** The pattern steps of a timeline grouped by the command that made them, in timeline order. */
export function patternGroups(project: WorkbenchProject): readonly { readonly groupId: string; readonly steps: readonly DesignSolidFeature[] }[] {
  const groups = new Map<string, DesignSolidFeature[]>();
  for (const feature of designOf(project).features) {
    if (feature.kind === "sketch" || feature.pattern === undefined) continue;
    const list = groups.get(feature.pattern.groupId) ?? [];
    list.push(feature);
    groups.set(feature.pattern.groupId, list);
  }
  return [...groups.entries()].map(([groupId, steps]) => ({ groupId, steps }));
}

/** The request that would rebuild an existing pattern group, for opening it in the dialog. */
export function requestOfGroup(steps: readonly DesignSolidFeature[]): PatternRequest | undefined {
  const first = steps[0]?.pattern;
  if (first === undefined) return undefined;
  const { result, groupId: _group, sourceBodyId, copyIndex: _copy, featureIds, ...shape } = first;
  void _group; void _copy;
  return { shape: shape as PatternShape, result, sourceBodyId, ...(featureIds === undefined ? {} : { featureIds }) };
}

/** Holes, cuts and joins of a body that a pattern can repeat: the live steps of that body other than the one that made it. */
export function patternableFeatures(project: WorkbenchProject, bodyId: string): readonly DesignSolidFeature[] {
  const history = designOf(project);
  return history.features.filter((feature): feature is DesignSolidFeature =>
    feature.kind !== "sketch" && feature.bodyId === bodyId && modifiesBody(feature) && isFeatureActive(history, feature.id)
    && (feature.kind === "hole" || (feature.kind !== "pattern" && (feature.operation === "cut" || feature.operation === "join"))));
}

/** The numbers shown under the dialog's fields: how many copies, how far the pattern reaches, whether copies overlap. */
export function previewPattern(project: WorkbenchProject, request: PatternRequest): PatternPreview | { readonly ok: false; readonly message: string } {
  const body = (project.part.generalBodies ?? []).find((candidate) => candidate.id === request.sourceBodyId);
  if (body === undefined) return { ok: false, message: "Select a solid body first." };
  const layout = patternTransforms(request.shape, patternContextOf(project));
  if (!layout.ok) return { ok: false, message: layout.message };
  const features = request.featureIds ?? [];
  if (features.length > 0) {
    return { ok: true, instances: layout.transforms.length + 1, copies: layout.transforms.length, overlapping: false,
      text: `${features.length} feature${features.length === 1 ? "" : "s"} repeated at ${layout.transforms.length} new position${layout.transforms.length === 1 ? "" : "s"} (${features.length * layout.transforms.length} cut${features.length * layout.transforms.length === 1 ? "" : "s"} in all)` };
  }
  const summary = summarizePattern(layout.transforms, body.positionsMm);
  if (summary === undefined) return { ok: false, message: "The body has no geometry to pattern." };
  const tail = request.result === "join" ? " (copies are merged into this body)" : ` (${summary.copies} new ${summary.copies === 1 ? "body" : "bodies"})`;
  return { ok: true, instances: summary.instances, copies: summary.copies, overlapping: summary.overlappingPairs > 0, text: `${summary.text}${tail}` };
}

function labelOf(request: PatternRequest, sourceName: string): string {
  const kind = request.shape.type === "rectangular" ? "Rectangular pattern" : request.shape.type === "circular" ? "Circular pattern" : "Mirror";
  return `${kind} of ${sourceName}`.slice(0, 110);
}

function definitionOf(request: PatternRequest, groupId: string, copyIndex?: number): PatternDefinition {
  const featureIds = request.featureIds ?? [];
  return {
    ...request.shape, result: featureIds.length > 0 ? "join" : request.result, groupId, sourceBodyId: request.sourceBodyId,
    ...(copyIndex === undefined || featureIds.length > 0 || request.result !== "new-bodies" ? {} : { copyIndex }),
    ...(featureIds.length > 0 ? { featureIds } : {})
  } as PatternDefinition;
}

/** Replays the timeline and stores the results, in chunks the operation accepts. Fails if one of `mustApply` could not be rebuilt. */
async function regenerate(project: WorkbenchProject, mustApply: readonly string[]): Promise<{ readonly ok: true; readonly project: WorkbenchProject } | { readonly ok: false; readonly message: string }> {
  const results = await replayAllBodies(project);
  const blocked = results.find((result) => mustApply.includes(result.featureId) && result.message !== undefined);
  if (blocked?.message !== undefined) return { ok: false, message: `Not applied: ${blocked.message}` };
  let next = project;
  for (let start = 0; start < results.length; start += 100) {
    const stored = run(next, { kind: "regenerate-design", results: results.slice(start, start + 100) });
    if (!stored.ok) return stored;
    next = stored.project;
  }
  return { ok: true, project: next };
}

/** Adds a pattern to the timeline as one or more steps and replays the body or bodies they make. The caller stores the returned project as one undo step. */
export async function addPattern(project: WorkbenchProject, request: PatternRequest): Promise<PatternCommit> {
  const history = designOf(project);
  const bodies = project.part.generalBodies ?? [];
  const source = bodies.find((candidate) => candidate.id === request.sourceBodyId);
  if (source === undefined) return { ok: false, message: "Select a solid body first." };
  const base = baseFeatureOf(history, source.id);
  if (base === undefined) return { ok: false, message: `${source.name} is not a step of the timeline (it came from Combine or an import), so a pattern cannot follow it. Patterns need a body built from a sketch.` };
  const layout = patternTransforms(request.shape, patternContextOf(project));
  if (!layout.ok) return { ok: false, message: layout.message };
  const featureIds = request.featureIds ?? [];
  if (featureIds.length > 0) {
    const live = new Set(patternableFeatures(project, source.id).map((feature) => feature.id));
    const missing = featureIds.find((id) => !live.has(id));
    if (missing !== undefined) return { ok: false, message: "A feature to repeat is not a live hole or cut of this body." };
  }
  const newBodies = featureIds.length === 0 && request.result === "new-bodies";
  if (newBodies) {
    if (bodies.length + layout.transforms.length > MAX_GENERAL_BODIES) return { ok: false, message: `That would make ${layout.transforms.length} new bodies, over the part's limit of ${MAX_GENERAL_BODIES}. Use fewer copies or join them.` };
    if (history.features.length + layout.transforms.length > MAX_DESIGN_FEATURES) return { ok: false, message: "The timeline would pass its limit of steps. Use fewer copies or join them." };
  }
  const groupId = freshId("pattern-group");
  const label = labelOf(request, source.name);
  let next = project;
  const ids: string[] = [];
  const steps = newBodies ? layout.transforms.map((_, index) => index + 1) : [0];
  for (const copy of steps) {
    const bodyId = newBodies ? freshId("general-body") : source.id;
    const pattern = definitionOf(request, groupId, newBodies ? copy : undefined);
    const feature: DesignSolidFeature = {
      id: freshId("feature"), name: newBodies ? `${label} (${copy} of ${layout.transforms.length})` : label, kind: "pattern", suppressed: false,
      sketchFeatureId: base.sketchFeatureId, profileIds: [], valueMm: Math.max(1, newBodies ? 1 : layout.transforms.length), bodyId,
      operation: newBodies ? "new-body" : "direct-edit", pattern
    };
    const body = newBodies ? await copyGeneralBody(source, layout.transforms[copy - 1]!, bodyId, `${source.name} copy ${copy}`) : source;
    const added = run(next, { kind: "add-design-solid", feature, body });
    if (!added.ok) return added;
    next = added.project;
    ids.push(feature.id);
  }
  const rebuilt = await regenerate(next, ids);
  if (!rebuilt.ok) return rebuilt;
  const created = designOf(rebuilt.project).features.filter((feature) => ids.includes(feature.id));
  const lastBody = created.at(-1);
  return {
    ok: true, project: rebuilt.project, groupId,
    selectBodyId: lastBody !== undefined && lastBody.kind !== "sketch" ? lastBody.bodyId : source.id,
    summary: `${describePattern(definitionOf(request, groupId, newBodies ? 1 : undefined))} of ${source.name}: ${newBodies ? `${layout.transforms.length} new bod${layout.transforms.length === 1 ? "y" : "ies"} in the timeline` : featureIds.length > 0 ? `repeated at ${layout.transforms.length} position${layout.transforms.length === 1 ? "" : "s"}` : "copies joined into the body"}. Edit the source and the pattern follows.`
  };
}

/**
 * Changes a pattern: its layout, counts and spacing. The steps keep their place in the timeline and their body IDs, so work done
 * on a copy survives; copies that are no longer in the layout are deleted with what was built on them, and new ones are added after the last.
 */
export async function editPattern(project: WorkbenchProject, groupId: string, request: PatternRequest): Promise<PatternCommit> {
  const group = patternGroups(project).find((candidate) => candidate.groupId === groupId);
  if (group === undefined) return { ok: false, message: "That pattern is no longer in the timeline." };
  const history = designOf(project);
  const layout = patternTransforms(request.shape, patternContextOf(project));
  if (!layout.ok) return layout;
  const first = group.steps[0]!;
  const sourceBodyId = first.pattern!.sourceBodyId;
  const source = (project.part.generalBodies ?? []).find((candidate) => candidate.id === sourceBodyId);
  if (source === undefined) return { ok: false, message: "The body this pattern copies is gone." };
  const newBodies = first.pattern!.result === "new-bodies";
  const edited: PatternRequest = { ...request, result: newBodies ? "new-bodies" : "join", sourceBodyId, ...(first.pattern!.featureIds === undefined ? {} : { featureIds: first.pattern!.featureIds }) };
  const wanted = newBodies ? layout.transforms.length : 1;
  const label = labelOf(edited, source.name);
  let next = project;
  const touched: string[] = [];
  for (const [index, step] of group.steps.slice(0, wanted).entries()) {
    const feature: DesignSolidFeature = {
      ...step, name: newBodies ? `${label} (${index + 1} of ${wanted})` : label, valueMm: Math.max(1, newBodies ? 1 : layout.transforms.length),
      pattern: definitionOf(edited, groupId, newBodies ? index + 1 : undefined)
    };
    const body = (next.part.generalBodies ?? []).find((candidate) => candidate.id === step.bodyId);
    if (body === undefined) return { ok: false, message: "A body of this pattern is missing." };
    const updated = run(next, { kind: "update-design-solid", feature, body });
    if (!updated.ok) return updated;
    next = updated.project;
    touched.push(step.id);
  }
  for (const extra of group.steps.slice(wanted)) {
    const removed = run(next, { kind: "delete-design-feature", featureId: extra.id });
    if (!removed.ok) return removed;
    next = removed.project;
  }
  if (newBodies && wanted > group.steps.length) {
    const bodiesNow = next.part.generalBodies ?? [];
    if (bodiesNow.length + (wanted - group.steps.length) > MAX_GENERAL_BODIES) return { ok: false, message: `That would pass the part's limit of ${MAX_GENERAL_BODIES} bodies.` };
    const after = designOf(next);
    const lastIndex = after.features.findIndex((feature) => feature.id === group.steps.at(-1)!.id);
    const originalMarker = history.rollbackIndex;
    if (lastIndex + 1 > designOf(next).rollbackIndex) return { ok: false, message: "Roll the timeline forward past the pattern before adding copies to it." };
    let moved = run(next, { kind: "set-design-rollback", index: lastIndex + 1 });
    if (!moved.ok) return moved;
    next = moved.project;
    const base = baseFeatureOf(designOf(next), sourceBodyId)!;
    for (let copy = group.steps.length + 1; copy <= wanted; copy += 1) {
      const bodyId = freshId("general-body");
      const feature: DesignSolidFeature = {
        id: freshId("feature"), name: `${label} (${copy} of ${wanted})`, kind: "pattern", suppressed: false, sketchFeatureId: base.sketchFeatureId,
        profileIds: [], valueMm: 1, bodyId, operation: "new-body", pattern: definitionOf(edited, groupId, copy)
      };
      const added = run(next, { kind: "add-design-solid", feature, body: await copyGeneralBody(source, layout.transforms[copy - 1]!, bodyId, `${source.name} copy ${copy}`) });
      if (!added.ok) return added;
      next = added.project;
      touched.push(feature.id);
    }
    moved = run(next, { kind: "set-design-rollback", index: Math.min(designOf(next).features.length, originalMarker + (wanted - group.steps.length)) });
    if (!moved.ok) return moved;
    next = moved.project;
  }
  const rebuilt = await regenerate(next, touched);
  if (!rebuilt.ok) return rebuilt;
  return { ok: true, project: rebuilt.project, groupId, selectBodyId: source.id, summary: `Updated the pattern: ${describePattern(definitionOf(edited, groupId, newBodies ? 1 : undefined))}.` };
}
