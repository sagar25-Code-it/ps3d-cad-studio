import type { DesignSketchFeature, GeneralSolidBody, SketchEntity, SketchProjectionObject, WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { applyProjectedCurves, refreshSketchProjection } from "../../../packages/workbench-core/src/index.js";
import { planProjection } from "../../../packages/workbench-geometry/src/index.js";

/**
 * Linked projections follow their solid. When the features built on a sketch are rebuilt, each projection of that sketch is worked
 * out again from its solid as it is at that point and the linked curves take the new shape, so what was drawn against them (an
 * offset, a dimension to a projected edge) moves with the body. A solid that no longer gives the same curves, or that is gone,
 * leaves the curves as they were and says so on the feature.
 */
export interface FollowedProjections {
  /** The sketch feature to build from: its linked curves where the solids put them now. */
  readonly sketchFeature: DesignSketchFeature;
  /** The linked curves that changed (with their existing ids), to be stored with the sketch. Empty when nothing moved. */
  readonly entities: readonly SketchEntity[];
  /** Why a projection could not follow. Shown as the feature's health. */
  readonly warning?: string;
}

/** What one projection gives from a solid today, in the projection's own order; a message when it gives nothing. */
export function projectAgain(sketch: WorkbenchSketch, projection: SketchProjectionObject, body: GeneralSolidBody): readonly SketchEntity[] | string {
  let serial = 0;
  const planned = planProjection({ mode: projection.mode, body, sketch, construction: false, newId: () => `entity:projection-refresh-${serial += 1}` });
  return planned.ok ? planned.plan.entities : planned.message;
}

/**
 * Re-projects every linked projection of a sketch. `bodyOf` returns the current shape of a solid (the one being replayed, one
 * rebuilt earlier in the same pass, or the stored one).
 */
export function followSketchProjections(sketchFeature: DesignSketchFeature, bodyOf: (bodyId: string) => GeneralSolidBody | undefined): FollowedProjections {
  const projections = sketchFeature.sketch.projections;
  if (projections === undefined || projections.length === 0) return { sketchFeature, entities: [] };
  const sketch = sketchFeature.sketch;
  const moved: SketchEntity[] = [];
  const warnings: string[] = [];
  for (const projection of projections) {
    const body = bodyOf(projection.bodyId);
    if (body === undefined) {
      warnings.push(`The solid that curves of ${sketchFeature.name} were projected from is no longer in the design, so they stay where they were.`);
      continue;
    }
    const fresh = projectAgain(sketch, projection, body);
    if (typeof fresh === "string") {
      warnings.push(`The curves ${sketchFeature.name} projected from ${body.name} could not be worked out again (${fresh}), so they stay where they were.`);
      continue;
    }
    const refreshed = refreshSketchProjection(sketch, projection, fresh);
    if (refreshed.status === "mismatch") warnings.push(`${sketchFeature.name}: ${refreshed.message}`);
    else if (refreshed.status === "updated") moved.push(...refreshed.entities);
  }
  // The linked curves take their new shapes and what is tied to them in the sketch follows, exactly as the project will store it.
  const settled = applyProjectedCurves(sketch, new Map(moved.map((entity) => [entity.id, entity] as const)));
  return {
    sketchFeature: settled === sketch ? sketchFeature : { ...sketchFeature, sketch: settled },
    entities: moved,
    ...(warnings.length === 0 ? {} : { warning: warnings.join(" ") })
  };
}

/** The solids a sketch's projections read from. */
export function projectionBodyIds(sketch: Pick<WorkbenchSketch, "projections"> | undefined): readonly string[] {
  return [...new Set((sketch?.projections ?? []).map((projection) => projection.bodyId))];
}
