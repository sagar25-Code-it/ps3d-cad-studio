import type { WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import type { PreviewScene } from "../../../packages/workbench-geometry/src/index.js";
import { withSketchCurves } from "./sketch-curves.js";
import { withStaleBodies } from "./stale-bodies.js";

/**
 * The part scene in its two uses. `model` is the shape: what Render Studio draws and what is exported. `view` is the same scene with the
 * editing aids of the Part workspace added: the guide lines of the shown sketches and the see-through look of a solid whose rebuild
 * failed. Those aids say how the model is being edited, not what it is, so an image rendered from the part never carries them.
 */
export interface PartScenes {
  readonly model: PreviewScene;
  readonly view: PreviewScene;
}

export function partScenes(model: PreviewScene, project: WorkbenchProject): PartScenes {
  return { model, view: withSketchCurves(withStaleBodies(model, project), project) };
}
