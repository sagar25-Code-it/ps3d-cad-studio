import type { WorkbenchSketch } from "../../../packages/workbench-core/src/index.js";
import { placeDirection } from "../../../packages/workbench-geometry/src/index.js";

/**
 * `sweepDirectionMm` is a direction in WORLD space (the feature documentation says so, and the sweep dialog offers x, y and z of the
 * world). The sweep builders work in the frame of the sketch's datum plane and place the finished body onto a tilted or three-point
 * plane afterwards, which turns every direction they were given along with it. So the world direction is turned back into the datum
 * frame first; on a plain datum plane (XY, XZ, YZ, offset or not) the two frames are the same and nothing changes.
 *
 * Before this was done a typed (0, 0, 1) on a sketch tilted 30 degrees came out along the tilted normal, and the true world normal of the
 * plane came out as a sheared prism.
 */
export function sweepDirectionInDatumFrame(direction: readonly [number, number, number], sketch: Pick<WorkbenchSketch, "planeTilt" | "planeFrame">): readonly [number, number, number] {
  if (sketch.planeTilt === undefined && sketch.planeFrame === undefined) return direction;
  return placeDirection([direction[0], direction[1], direction[2]], sketch, true);
}
