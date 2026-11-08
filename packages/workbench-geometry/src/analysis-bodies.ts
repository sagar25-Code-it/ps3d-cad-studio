/**
 * Collects the solid bodies of the Part workspace as plain meshes for the analysis tools: general mesh solids and the
 * analytic preview bodies, visible ones only unless asked otherwise.
 */

import type { PartIntent } from "../../workbench-core/src/index.js";
import { previewBodyMeshMm } from "./part.js";
import type { AnalysisBodyMesh } from "./mesh-interference.js";

export function partAnalysisBodies(part: PartIntent, options: { readonly includeHidden?: boolean } = {}): readonly AnalysisBodyMesh[] {
  const includeHidden = options.includeHidden === true;
  const bodies: AnalysisBodyMesh[] = [];
  for (const body of part.previewBodies ?? []) {
    if (!includeHidden && !body.visible) continue;
    const mesh = previewBodyMeshMm(body);
    bodies.push({ id: body.id, name: body.name, positionsMm: mesh.positionsMm, indices: mesh.indices });
  }
  for (const body of part.generalBodies ?? []) {
    if (!includeHidden && !body.visible) continue;
    bodies.push({ id: body.id, name: body.name, positionsMm: body.positionsMm, indices: body.indices });
  }
  return bodies;
}
