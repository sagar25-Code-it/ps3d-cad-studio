import { describeBodyFailure, failedBodies, designOf, type WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import type { PreviewScene } from "../../../packages/workbench-geometry/src/index.js";

/** How see-through a solid is drawn while its last rebuild has failed: the last good shape, clearly not current. */
export const STALE_BODY_OPACITY = 0.38;

/**
 * HS-21: the part scene with the solids whose rebuild failed drawn translucent and named "out of date". The mesh is kept (a failed
 * rebuild never deletes work) but it no longer looks like a current, healthy solid; the red chip and the browser row say why.
 */
export function withStaleBodies(scene: PreviewScene, project: WorkbenchProject): PreviewScene {
  const failures = failedBodies(designOf(project));
  if (failures.size === 0) return scene;
  let changed = false;
  const primitives = scene.primitives.map((primitive) => {
    const failure = failures.get(primitive.id);
    if (failure === undefined || primitive.kind !== "mesh") return primitive;
    changed = true;
    return { ...primitive, opacity: Math.min(primitive.opacity, STALE_BODY_OPACITY), name: `${primitive.name} · ${describeBodyFailure(failure)}` };
  });
  return changed ? { ...scene, primitives } : scene;
}
