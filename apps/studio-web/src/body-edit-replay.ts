import type { BodyEditSpec, DesignHistory, DesignSolidFeature, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { draftFaces, offsetRegion, replaceFaces, shellBody, type FaceEditResult } from "../../../packages/workbench-geometry/src/index.js";

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

function meshEdit(spec: BodyEditSpec, body: GeneralSolidBody): FaceEditResult | undefined {
  const mesh = { positionsMm: body.positionsMm, indices: body.indices };
  switch (spec.kind) {
    case "shell": return shellBody(mesh, { thicknessMm: spec.thicknessMm, side: spec.side, openFaces: spec.openFaces });
    case "draft": return draftFaces(mesh, { angleDeg: spec.angleDeg, pullDirection: spec.pullDirection, neutralPointMm: spec.neutralPointMm, faces: spec.faces });
    case "offset-region": return offsetRegion(mesh, { distanceMm: spec.distanceMm, faces: spec.faces });
    case "replace-face": return replaceFaces(mesh, { faces: spec.faces, toFace: spec.toFace, toPlane: spec.toPlane });
    default: return undefined;
  }
}

/** The body with new geometry: the old face names no longer describe it, so the kernel face map is dropped like a Boolean's. */
export function withGeometry(body: GeneralSolidBody, positionsMm: readonly number[], indices: readonly number[]): GeneralSolidBody {
  const { brep: _faceNames, ...rest } = body;
  void _faceNames;
  return { ...rest, positionsMm: [...positionsMm], indices: [...indices] };
}

export async function applyBodyEdit(step: DesignSolidFeature, body: GeneralSolidBody, _context: BodyEditContext): Promise<BodyEditOutcome> {
  const spec = step.bodyEdit;
  if (spec === undefined) return { ok: false, message: "This step has no body edit recorded." };
  const result = meshEdit(spec, body);
  if (result === undefined) return { ok: false, message: `${spec.kind} is not available yet.` };
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, body: withGeometry(body, result.positionsMm, result.indices), notes: result.notes };
}
