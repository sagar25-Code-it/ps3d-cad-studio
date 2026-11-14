import type { DesignSolidFeature, EdgeBlendGroup, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { EDGE_BLEND_MAX_GROUPS, edgeBlendTitle } from "../../../packages/workbench-core/src/index.js";
import { describePickedEdge, pickableEdges, type PickableEdge } from "../../../packages/workbench-geometry/src/index.js";
import { facesOfBody } from "./edge-blend-step.js";

/**
 * The ribbon's whole-body modifiers (Hole, Fillet All, Chamfer All) as ordinary timeline steps. Until now they swapped the
 * body's mesh in place and recorded nothing, so the next rebuild silently removed them. These helpers describe the same
 * geometry as a replayable feature: the hole as a "hole" step at the point the one-shot drilled (the vertex centroid on the
 * top face, straight down), and Fillet All / Chamfer All as one "edge-blend" step holding every sharp convex run.
 */

/** Where the one-shot Hole drilled: the vertex centroid in X and Y, on the top (+Z) face. Mirrors defaultHoleOrigin in mesh-modify.ts. */
export function centroidHolePoint(positionsMm: readonly number[]): readonly [number, number, number] | undefined {
  if (positionsMm.length < 9) return undefined;
  let sumX = 0, sumY = 0, count = 0;
  let maxZ = -Infinity;
  for (let index = 0; index < positionsMm.length; index += 3) {
    sumX += positionsMm[index]!;
    sumY += positionsMm[index + 1]!;
    maxZ = Math.max(maxZ, positionsMm[index + 2]!);
    count += 1;
  }
  const round = (value: number): number => Number((value / count).toFixed(3));
  return [round(sumX), round(sumY), Number(maxZ.toFixed(3))];
}

/** The ribbon Hole as a timeline step: a simple through-hole at the centroid of the top face, drilled straight down. */
export function centroidHoleFeature(
  body: GeneralSolidBody,
  diameterMm: number,
  sketchFeatureId: string,
  id = `feature:hole-${crypto.randomUUID()}`
): DesignSolidFeature | string {
  if (!(diameterMm > 0) || !Number.isFinite(diameterMm)) return "The hole diameter must be a positive length.";
  const point = centroidHolePoint(body.positionsMm);
  if (point === undefined) return `${body.name} has no surface to drill into.`;
  return {
    id, name: `Hole Ø ${diameterMm} mm`, kind: "hole", suppressed: false,
    sketchFeatureId, profileIds: [], valueMm: Math.max(0.01, diameterMm),
    bodyId: body.id, operation: "direct-edit",
    holeStyle: "simple", holePositionMm: point, holeNormal: [0, 0, 1],
    holeDiameterMm: diameterMm, holeDepthMm: 0
  };
}

/** Every sharp convex run of the body, remembered the way a picked fillet edge is (segments plus the face keys beside them). */
export function allConvexEdgeGroups(body: GeneralSolidBody): readonly EdgeBlendGroup[] | string {
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices });
  if (typeof edges === "string") return edges;
  if (edges.length === 0) return `${body.name} has no sharp convex edge to treat.`;
  const chains = new Map<number, PickableEdge[]>();
  for (const edge of edges) {
    const bucket = chains.get(edge.chain);
    if (bucket === undefined) chains.set(edge.chain, [edge]); else bucket.push(edge);
  }
  const faces = facesOfBody(body);
  const groups = [...chains.values()].map((chain) => describePickedEdge(chain, faces));
  if (groups.length > EDGE_BLEND_MAX_GROUPS) return `${body.name} has ${groups.length} sharp runs; one step holds at most ${EDGE_BLEND_MAX_GROUPS}. Pick the edges in smaller sets instead.`;
  return groups;
}

/** Fillet All / Chamfer All as one timeline step whose edge sets are every sharp convex run of the body as it stands. */
export function blendAllFeature(
  body: GeneralSolidBody,
  blendType: "fillet" | "chamfer",
  sizeMm: number,
  sketchFeatureId: string,
  id = `feature:edge-blend-${crypto.randomUUID()}`
): DesignSolidFeature | string {
  if (!(sizeMm > 0) || !Number.isFinite(sizeMm)) return `The ${blendType === "fillet" ? "fillet radius" : "chamfer distance"} must be a positive length.`;
  const groups = allConvexEdgeGroups(body);
  if (typeof groups === "string") return groups;
  const draft: DesignSolidFeature = {
    id, name: blendType === "fillet" ? "Fillet" : "Chamfer", kind: "edge-blend", suppressed: false,
    sketchFeatureId, profileIds: [], valueMm: sizeMm, bodyId: body.id, operation: "direct-edit",
    blendType, blendEdges: groups
  };
  return { ...draft, name: `${edgeBlendTitle(draft)} (all edges)` };
}
