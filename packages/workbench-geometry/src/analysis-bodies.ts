/**
 * Collects the solid bodies of the Part workspace as plain meshes for the analysis tools: general mesh solids and the
 * analytic preview bodies, visible ones only unless asked otherwise.
 */

import type { PartIntent, PartPreviewBody } from "../../workbench-core/src/index.js";
import { previewBodyMeshMm } from "./part.js";
import type { AnalysisBodyMesh } from "./mesh-interference.js";

/** Preview bodies are immutable records, so their generated meshes are kept per record and per-body results downstream can be cached on the mesh arrays. */
const previewMeshes = new WeakMap<PartPreviewBody, { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }>();

export function partAnalysisBodies(part: PartIntent, options: { readonly includeHidden?: boolean } = {}): readonly AnalysisBodyMesh[] {
  const includeHidden = options.includeHidden === true;
  const bodies: AnalysisBodyMesh[] = [];
  for (const body of part.previewBodies ?? []) {
    if (!includeHidden && !body.visible) continue;
    let mesh = previewMeshes.get(body);
    if (mesh === undefined) { mesh = previewBodyMeshMm(body); previewMeshes.set(body, mesh); }
    bodies.push({ id: body.id, name: body.name, positionsMm: mesh.positionsMm, indices: mesh.indices });
  }
  for (const body of part.generalBodies ?? []) {
    if (!includeHidden && !body.visible) continue;
    bodies.push({ id: body.id, name: body.name, positionsMm: body.positionsMm, indices: body.indices });
  }
  return bodies;
}
