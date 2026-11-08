import type { BodyEditSpec, DesignHistory, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { addWebs, draftFaces, flexBody, offsetRegion, replaceFaces, shellBody, type FaceEditResult, type FlexResult, type WebResult } from "../../../packages/workbench-geometry/src/index.js";
import { openChains, sketchPlaneNormal, sketchPointToWorld } from "./web-profile.js";

/**
 * Applies one body-edit step (general shell, draft, offset region, replace face, ...) to the body a timeline replay has built so
 * far. The step names its faces by where they were picked, so each is found again in the current mesh; a face that is gone, or an
 * edit the mesh cannot take, comes back as a message and the replay skips that step like any other failed step.
 */
export type BodyEditOutcome =
  | { readonly ok: true; readonly body: GeneralSolidBody; readonly notes: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** The context a step may need beyond the body: the timeline, for steps built from a sketch. */
export interface BodyEditContext {
  readonly history: DesignHistory;
}

/** A rib / web is built from the open curves of the sketch the step names. */
function webEdit(step: DesignSolidFeature, spec: Extract<BodyEditSpec, { readonly kind: "web" }>, body: GeneralSolidBody, context: BodyEditContext): WebResult {
  const sketchFeature = context.history.features.find((feature): feature is DesignSketchFeature => feature.id === step.sketchFeatureId && feature.kind === "sketch");
  if (sketchFeature === undefined) return { ok: false, message: "The sketch this rib was drawn in is no longer in the timeline." };
  const chains = openChains(sketchFeature.sketch, spec.entityIds);
  if (chains.length === 0) return { ok: false, message: "The curves this rib was drawn from are no longer in its sketch." };
  const world = chains.map((chain) => chain.map((point) => sketchPointToWorld(sketchFeature.sketch, point)));
  return addWebs({ positionsMm: body.positionsMm, indices: body.indices }, world, { thicknessMm: spec.thicknessMm, direction: spec.direction, extendToBody: spec.extendToBody, flip: spec.flip, normal: sketchPlaneNormal(sketchFeature.sketch) });
}

function meshEdit(step: DesignSolidFeature, spec: BodyEditSpec, body: GeneralSolidBody, context: BodyEditContext): FaceEditResult | FlexResult | WebResult | undefined {
  const mesh = { positionsMm: body.positionsMm, indices: body.indices };
  switch (spec.kind) {
    case "shell": return shellBody(mesh, { thicknessMm: spec.thicknessMm, side: spec.side, openFaces: spec.openFaces });
    case "draft": return draftFaces(mesh, { angleDeg: spec.angleDeg, pullDirection: spec.pullDirection, neutralPointMm: spec.neutralPointMm, faces: spec.faces });
    case "offset-region": return offsetRegion(mesh, { distanceMm: spec.distanceMm, faces: spec.faces });
    case "replace-face": return replaceFaces(mesh, { faces: spec.faces, toFace: spec.toFace, toPlane: spec.toPlane });
    case "web": return webEdit(step, spec, body, context);
    case "flex": return flexBody(mesh, { mode: spec.mode, angleDeg: spec.angleDeg, axisPointMm: spec.axisPointMm, axisDirectionMm: spec.axisDirectionMm, lengthDirectionMm: spec.lengthDirectionMm, zoneLengthMm: spec.zoneLengthMm });
    default: return undefined;
  }
}

/** The body with new geometry: the old face names no longer describe it, so the kernel face map is dropped like a Boolean's. */
export function withGeometry(body: GeneralSolidBody, positionsMm: readonly number[], indices: readonly number[]): GeneralSolidBody {
  const { brep: _faceNames, ...rest } = body;
  void _faceNames;
  return { ...rest, positionsMm: [...positionsMm], indices: [...indices] };
}

export async function applyBodyEdit(step: DesignSolidFeature, body: GeneralSolidBody, context: BodyEditContext): Promise<BodyEditOutcome> {
  const spec = step.bodyEdit;
  if (spec === undefined) return { ok: false, message: "This step has no body edit recorded." };
  const result = meshEdit(step, spec, body, context);
  if (result === undefined) return { ok: false, message: `${spec.kind} is not available yet.` };
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, body: withGeometry(body, result.positionsMm, result.indices), notes: result.notes };
}
