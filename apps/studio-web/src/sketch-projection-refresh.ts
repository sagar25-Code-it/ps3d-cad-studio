import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, isFeatureActive, modifiesBody, PROJECTION_NOTE_PREFIX } from "../../../packages/workbench-core/src/index.js";
import { replayBodyState } from "./design-regeneration.js";
import { LINKED_PROJECT_MODES, planSketchProject, type SketchProjectCommand, type SketchProjectPlan } from "./sketch-project-command.js";
import { followSketchProjections, projectionBodyIds } from "./sketch-projection-follow.js";

/**
 * Linked projections outside a rebuild. A rebuild works a sketch's projected curves out again whenever a step built on that sketch is
 * replayed (design-regeneration.ts). Two cases have no such step and are handled here, with the same rule for which shape of the
 * solid the sketch sees, so the three never disagree:
 *
 *   - Project inside a sketch that already has a step on the projected solid (a cut through the plate): the curves must come from
 *     the solid as it is BEFORE that step, which is what the replay will project from. Read from the finished solid they would
 *     include the edge of the sketch's own hole, and every later rebuild would report a different number of curves.
 *   - A sketch that nothing is built on yet, or that is being opened: nothing replays it, so its curves are refreshed by sketch.
 */

/** The step a sketch's projections of a solid are read before: the first live or stored step built on the sketch that makes or changes that solid. */
export function firstStepOnBody(project: WorkbenchProject, sketchFeatureId: string | null | undefined, bodyId: string): { readonly step: DesignSolidFeature; readonly index: number } | undefined {
  if (sketchFeatureId === null || sketchFeatureId === undefined) return undefined;
  const features = designOf(project).features;
  const index = features.findIndex((feature) => feature.kind !== "sketch" && feature.sketchFeatureId === sketchFeatureId && feature.bodyId === bodyId);
  const step = features[index];
  return step === undefined || step.kind === "sketch" ? undefined : { step, index };
}

export type ProjectionSource =
  | { readonly ok: true; readonly body: GeneralSolidBody; /** The step of this sketch the solid was read before, when there is one. */ readonly before?: DesignSolidFeature }
  | { readonly ok: false; readonly message: string };

/**
 * The shape of a solid as a timeline sketch sees it: the solid as it is just before the first step that the sketch itself has on it,
 * otherwise the solid as the part holds it. A sketch cannot see a solid that is made from the sketch.
 */
export async function projectionSourceBody(project: WorkbenchProject, sketchFeatureId: string | null | undefined, bodyId: string): Promise<ProjectionSource> {
  const stored = project.part.generalBodies?.find((candidate) => candidate.id === bodyId);
  const own = firstStepOnBody(project, sketchFeatureId, bodyId);
  if (own === undefined) return stored === undefined ? { ok: false, message: "The solid is no longer in the design." } : { ok: true, body: stored };
  const name = stored?.name ?? "The solid";
  if (!modifiesBody(own.step)) return { ok: false, message: `${name} is made from this sketch (${own.step.name}), so there is nothing of it before the sketch to bring in. Project it into a later sketch instead.` };
  const earlier = await replayBodyState(project, bodyId, own.index);
  if (earlier.current === undefined) return stored === undefined ? { ok: false, message: "The solid is no longer in the design." } : { ok: true, body: stored };
  return { ok: true, body: { ...earlier.current, name: stored?.name ?? earlier.current.name }, before: own.step };
}

/** Refreshed linked curves of one timeline sketch, in the shape the `regenerate-design` operation takes (`sketchCurves`). */
export interface SketchCurveRefresh {
  readonly sketchFeatureId: string;
  readonly entities: readonly SketchEntity[];
  readonly message?: string;
}

const sketchFeatureOf = (project: WorkbenchProject, sketchFeatureId: string): DesignSketchFeature | undefined =>
  designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === sketchFeatureId && feature.kind === "sketch");

/**
 * Works the linked projections of one timeline sketch out again from their solids as the sketch sees them. Returns undefined when
 * there is nothing to store: no linked projection, or every curve is already where its solid puts it and the sketch carries no
 * projection note that would have to be cleared.
 */
export async function refreshSketchProjections(project: WorkbenchProject, sketchFeatureId: string): Promise<SketchCurveRefresh | undefined> {
  const sketchFeature = sketchFeatureOf(project, sketchFeatureId);
  if (sketchFeature === undefined || (sketchFeature.sketch.projections?.length ?? 0) === 0) return undefined;
  const bodies = new Map<string, GeneralSolidBody>();
  for (const bodyId of projectionBodyIds(sketchFeature.sketch)) {
    const source = await projectionSourceBody(project, sketchFeatureId, bodyId);
    if (source.ok) bodies.set(bodyId, source.body);
  }
  const followed = followSketchProjections(sketchFeature, (bodyId) => bodies.get(bodyId));
  const noted = sketchFeature.health?.message.startsWith(PROJECTION_NOTE_PREFIX) === true;
  if (followed.entities.length === 0 && followed.warning === undefined && !noted) return undefined;
  // The note is stored behind its prefix, within the 400 characters a health message may have.
  const message = followed.warning?.slice(0, 400 - PROJECTION_NOTE_PREFIX.length);
  if (followed.entities.length === 0 && noted && message !== undefined && sketchFeature.health?.message === `${PROJECTION_NOTE_PREFIX}${message}`) return undefined;
  return { sketchFeatureId, entities: followed.entities, ...(message === undefined ? {} : { message }) };
}

/** Whether a live step is built on the sketch: such a sketch is followed by the rebuild of that step. */
function hasLiveStep(project: WorkbenchProject, sketchFeatureId: string): boolean {
  const history = designOf(project);
  return history.features.some((feature) => feature.kind !== "sketch" && feature.sketchFeatureId === sketchFeatureId && isFeatureActive(history, feature.id));
}

/**
 * The refreshes for every timeline sketch with linked projections that no live step is built on. Run after a rebuild, so a sketch
 * that was projected and finished but not used yet still shows its curves where the solid is now.
 */
export async function refreshLooseSketchProjections(project: WorkbenchProject): Promise<readonly SketchCurveRefresh[]> {
  const refreshes: SketchCurveRefresh[] = [];
  for (const feature of designOf(project).features) {
    if (feature.kind !== "sketch" || (feature.sketch.projections?.length ?? 0) === 0 || hasLiveStep(project, feature.id)) continue;
    const refresh = await refreshSketchProjections(project, feature.id);
    if (refresh !== undefined) refreshes.push(refresh);
  }
  return refreshes;
}

/**
 * Plans a Project, Intersect, Silhouette or Convert for the working sketch. The whole-body commands, whose curves stay linked, read
 * the solid as the sketch being edited sees it (`projectionSourceBody`), and the status line says so when that is not the finished
 * solid. The picked-edge and picked-face commands are snapshots of what was clicked and use the solid as given.
 */
export async function planSketchProjectForSession(
  project: WorkbenchProject,
  body: GeneralSolidBody,
  command: SketchProjectCommand,
  options: Parameters<typeof planSketchProject>[3]
): Promise<SketchProjectPlan> {
  if (LINKED_PROJECT_MODES[command] === undefined) return planSketchProject(project, body, command, options);
  const source = await projectionSourceBody(project, designOf(project).editingSketchId, body.id);
  if (!source.ok) return { ok: false, message: source.message };
  const planned = planSketchProject(project, source.body, command, options);
  if (!planned.ok || source.before === undefined) return planned;
  return { ...planned, summary: `${planned.summary} ${body.name} was read as it is before ${source.before.name}, the step this sketch already has on it.` };
}
