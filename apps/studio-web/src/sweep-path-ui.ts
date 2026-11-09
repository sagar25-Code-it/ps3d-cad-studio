import type { DesignSketchFeature, SweepPathRef, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { chainSketchCurves } from "./sweep-loft-feature.js";

/**
 * The choices behind the sweep "path" controls of the Sketch workspace: which sketch the path comes from (this one, or a finished sketch
 * of the timeline on another plane), which of its curves, chained end to end. The result is the same `sweepPath` reference the MCP route and
 * the timeline already build and rebuild; nothing here knows how a sweep is made.
 */

/** The sketch id stored for the working sketch before it is finished (it has no timeline id yet). */
export const WORKING_PATH_SKETCH = "working";

export interface PathSketchChoice {
  /** `WORKING_PATH_SKETCH` for the sketch being drawn, otherwise the id of a finished sketch feature. */
  readonly id: string;
  readonly name: string;
  /** How many lines, arcs and splines it offers as path curves. */
  readonly curves: number;
}

const PATH_KINDS = new Set(["line", "arc", "spline"]);

/** The curves of a sketch a path can be made of: visible lines, arcs and splines (construction curves are the usual choice for a path). */
export function pathCurvesOf(sketch: WorkbenchSketch): readonly { readonly id: string; readonly kind: "line" | "arc" | "spline"; readonly label: string }[] {
  const counts = new Map<string, number>();
  return sketch.entities.flatMap((entity) => {
    if (!PATH_KINDS.has(entity.kind) || entity.visible === false) return [];
    const kind = entity.kind as "line" | "arc" | "spline";
    const ordinal = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, ordinal);
    return [{ id: entity.id, kind, label: `${kind[0]!.toUpperCase()}${kind.slice(1)} ${ordinal}${entity.construction ? " (construction)" : ""}` }];
  });
}

/** The sketches a path can come from: the working sketch first, then every finished sketch that has path curves. */
export function pathSketchChoices(finished: readonly DesignSketchFeature[], working: WorkbenchSketch, workingTimelineId: string | null): readonly PathSketchChoice[] {
  const choices: PathSketchChoice[] = [{ id: WORKING_PATH_SKETCH, name: "This sketch", curves: pathCurvesOf(working).length }];
  for (const feature of finished) {
    // The sketch being edited is the working sketch; it is not offered twice.
    if (feature.id === workingTimelineId) continue;
    const curves = pathCurvesOf(feature.sketch).length;
    if (curves > 0) choices.push({ id: feature.id, name: feature.name, curves });
  }
  return choices;
}

/** The sketch a choice names, or undefined when it is gone. */
export function pathSketchOf(choiceId: string, finished: readonly DesignSketchFeature[], working: WorkbenchSketch): WorkbenchSketch | undefined {
  if (choiceId === WORKING_PATH_SKETCH) return working;
  return finished.find((candidate) => candidate.id === choiceId)?.sketch;
}

const END_TOLERANCE_MM = 0.05;

function endsOf(sketch: WorkbenchSketch, id: string): readonly (readonly [number, number])[] {
  const entity = sketch.entities.find((candidate) => candidate.id === id);
  if (entity === undefined) return [];
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind === "arc") return [entity.start, entity.end];
  if (entity.kind === "spline") return entity.fitPoints.length < 2 ? [] : [entity.fitPoints[0]!, entity.fitPoints[entity.fitPoints.length - 1]!];
  return [];
}

/**
 * The picked curves plus every curve that continues them through a shared end, so one click on a curve of an outline selects the whole open
 * chain. A curve that branches (three curves meeting at one point) stops the walk there. The order is the order the chain is walked in.
 */
export function chainFromCurve(sketch: WorkbenchSketch, seedId: string): readonly string[] {
  const usable = new Set(pathCurvesOf(sketch).map((curve) => curve.id));
  if (!usable.has(seedId)) return [];
  const tolerance = Math.max(END_TOLERANCE_MM, sketch.snapToleranceMm);
  const touching = (point: readonly [number, number], excluding: ReadonlySet<string>): string[] =>
    [...usable].filter((id) => !excluding.has(id) && endsOf(sketch, id).some((end) => Math.hypot(end[0] - point[0], end[1] - point[1]) <= tolerance));
  const walk = (start: readonly [number, number], used: Set<string>): string[] => {
    const found: string[] = [];
    let tip = start;
    for (;;) {
      const next = touching(tip, used);
      if (next.length !== 1) break;
      const id = next[0]!;
      found.push(id);
      used.add(id);
      const ends = endsOf(sketch, id);
      const far = ends.find((end) => Math.hypot(end[0] - tip[0], end[1] - tip[1]) > tolerance) ?? ends[1];
      if (far === undefined) break;
      tip = far;
    }
    return found;
  };
  const ends = endsOf(sketch, seedId);
  if (ends.length < 2) return [seedId];
  const used = new Set<string>([seedId]);
  const forward = walk(ends[1]!, used);
  const backward = walk(ends[0]!, used);
  return [...backward.reverse(), seedId, ...forward];
}

export type PathDescription =
  | { readonly ok: true; readonly curves: number; readonly lengthMm: number }
  | { readonly ok: false; readonly message: string };

/** Whether the picked curves chain into one path, and how long it is; otherwise the reason (a gap, a curve that cannot be a path, nothing picked). */
export function describePath(sketch: WorkbenchSketch, entityIds: readonly string[], sketchName = "this sketch"): PathDescription {
  if (entityIds.length === 0) return { ok: false, message: "Pick the curves of the path." };
  const stub: DesignSketchFeature = { id: "feature:path-check", name: sketchName, kind: "sketch", suppressed: false, sketch };
  const chain = chainSketchCurves(stub, entityIds);
  if (!chain.ok) return { ok: false, message: chain.message };
  let length = 0;
  for (let index = 1; index < chain.points.length; index += 1) length += Math.hypot(chain.points[index]![0] - chain.points[index - 1]![0], chain.points[index]![1] - chain.points[index - 1]![1]);
  return { ok: true, curves: entityIds.length, lengthMm: length };
}

export interface SweepPathParams {
  readonly sweepPathEntityId?: string;
  readonly sweepPath?: SweepPathRef;
}

/**
 * What the create-solid call carries for a path. A single curve of the working sketch keeps the older single-curve form (the profile and the
 * path then share a sketch); anything else - several curves, or a finished sketch - is a chained `sweepPath` that points at that sketch.
 * `workingFeatureId` is the id the working sketch gets once it is finished.
 */
export function sweepPathParams(choiceId: string, entityIds: readonly string[], workingFeatureId: string): SweepPathParams {
  if (entityIds.length === 0) return {};
  if (choiceId === WORKING_PATH_SKETCH) {
    return entityIds.length === 1 ? { sweepPathEntityId: entityIds[0]! } : { sweepPath: { sketchFeatureId: workingFeatureId, entityIds: [...entityIds] } };
  }
  return { sweepPath: { sketchFeatureId: choiceId, entityIds: [...entityIds] } };
}
