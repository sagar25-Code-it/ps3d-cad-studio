import type { SketchPlaneFrame, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, isFeatureActive, isReferenceFeature } from "../../../packages/workbench-core/src/index.js";
import { evaluateConstructionPlane, frameThroughPoints } from "../../../packages/workbench-geometry/src/index.js";

/**
 * Sketches placed on a construction plane follow it. The plane's frame (origin, in-plane axis, normal) is worked out from its step as
 * it is now and compared with the frame each sketch carries; the sketches that differ are listed with the new frame, to be applied with
 * the follow-design-planes operation, after which the solids built on them are rebuilt like for any other sketch edit.
 */

const SAME = 1e-9;
const sameVector = (a: readonly number[], b: readonly number[]): boolean => a.every((value, index) => Math.abs(value - b[index]!) <= SAME);
export const sameFrame = (a: SketchPlaneFrame, b: SketchPlaneFrame): boolean => sameVector(a.originMm, b.originMm) && sameVector(a.uAxis, b.uAxis) && sameVector(a.normal, b.normal);

/** The frame a sketch placed on this plane lies in, or undefined when the plane does not resolve right now. */
export function planeSketchFrame(project: WorkbenchProject, planeId: string): SketchPlaneFrame | undefined {
  const plane = (project.part.construction ?? []).find((candidate) => candidate.id === planeId);
  if (plane === undefined) return undefined;
  // A plane through three points is sketched on in the frame the sketch plane dialog gives it, so a sketch made there and a sketch following the plane agree.
  if (plane.definition.kind === "three-points") { const through = frameThroughPoints(plane.definition.points); return "error" in through ? undefined : through; }
  const frame = evaluateConstructionPlane(plane, project.part.generalBodies ?? [], project.part.constructionAxes ?? [], project.part.constructionBinders ?? []);
  if ("error" in frame) return undefined;
  // The sketch's own Y axis is the plane's v axis (normal x u), so a sketch on an offset XZ plane has Y up (+Z), as one on the XZ datum does; its normal points the way a solid grows from it.
  const [u, v] = [frame.uAxis, frame.vAxis];
  const normal: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  return length < 1e-9 ? undefined : { originMm: frame.origin, uAxis: frame.uAxis, normal: [normal[0] / length, normal[1] / length, normal[2] / length] };
}

/** The sketches of the timeline whose plane moved, with the frame each has to move to. */
export function planeFollowFrames(project: WorkbenchProject): readonly { readonly featureId: string; readonly frame: SketchPlaneFrame }[] {
  const history = designOf(project);
  const moved: { featureId: string; frame: SketchPlaneFrame }[] = [];
  for (const feature of history.features) {
    if (feature.kind !== "sketch" || feature.sketch.planeRef === undefined || feature.sketch.planeFrame === undefined) continue;
    const step = history.features.find((candidate) => isReferenceFeature(candidate) && candidate.bodyId === feature.sketch.planeRef);
    if (step === undefined || !isFeatureActive(history, step.id)) continue;
    const frame = planeSketchFrame(project, feature.sketch.planeRef);
    if (frame !== undefined && !sameFrame(frame, feature.sketch.planeFrame)) moved.push({ featureId: feature.id, frame });
  }
  return moved;
}

/** The plane (by id) whose frame equals `frame`, among the planes the sketch dialog offers, so a sketch started from the dialog knows which plane it follows. */
export function planeIdOfFrame(options: readonly { readonly frame: SketchPlaneFrame; readonly planeId?: string }[], frame: SketchPlaneFrame | undefined): string | undefined {
  if (frame === undefined) return undefined;
  return options.find((option) => option.planeId !== undefined && sameFrame(option.frame, frame))?.planeId;
}
