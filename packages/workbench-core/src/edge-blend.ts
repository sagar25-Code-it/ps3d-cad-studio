import type { DesignSolidFeature, EdgeBlendGroup } from "./types.js";

/**
 * Validation of the fields an edge-blend timeline step carries: the picked edges, the kind of blend and its sizes. The generic
 * solid-feature validator calls `validEdgeBlendFields` for every step, so a saved project and a live operation are held to the same rules.
 */
export const EDGE_BLEND_KEYS = ["blendType", "blendEdges", "blendEndSizeMm", "blendSecondSizeMm", "blendAngleDeg", "blendFlip"] as const;

/** Fillet All / Chamfer All record one group per sharp run, so a plate with a few bores already needs more than a handful. */
export const EDGE_BLEND_MAX_GROUPS = 64;
const MAX_GROUPS = EDGE_BLEND_MAX_GROUPS;
const MAX_SEGMENTS_PER_GROUP = 512;
const COORDINATE_LIMIT = 1_000_000;

const has = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key);
const positive = (candidate: unknown, max: number): boolean => typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 && candidate <= max;
const point = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.length === 3 && candidate.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= COORDINATE_LIMIT);

export function validEdgeBlendGroup(candidate: unknown): candidate is EdgeBlendGroup {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
  const group = candidate as Record<string, unknown>;
  if (!Object.keys(group).every((key) => key === "segments" || key === "faceKeys" || key === "concave") || !has(group, "segments")) return false;
  const segments = group["segments"];
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_SEGMENTS_PER_GROUP) return false;
  if (segments.some((segment) => !Array.isArray(segment) || segment.length !== 2 || !point(segment[0]) || !point(segment[1]))) return false;
  if (has(group, "faceKeys")) {
    const keys = group["faceKeys"];
    if (!Array.isArray(keys) || keys.length !== 2 || keys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 160)) return false;
  }
  if (has(group, "concave") && typeof group["concave"] !== "boolean") return false;
  return true;
}

/** Whether the edge-blend fields of a solid feature are valid: absent on every other kind, complete and consistent on an edge-blend step. */
export function validEdgeBlendFields(value: Record<string, unknown>): boolean {
  if (value["kind"] !== "edge-blend") return !EDGE_BLEND_KEYS.some((key) => has(value, key));
  if (value["operation"] !== "direct-edit") return false;
  const type = value["blendType"];
  if (type !== "fillet" && type !== "chamfer") return false;
  if (!positive(value["valueMm"], 10_000)) return false;
  const groups = value["blendEdges"];
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS || !groups.every(validEdgeBlendGroup)) return false;
  const fillet = type === "fillet";
  if (has(value, "blendEndSizeMm") && (!fillet || !positive(value["blendEndSizeMm"], 10_000))) return false;
  if (has(value, "blendSecondSizeMm") && (fillet || !positive(value["blendSecondSizeMm"], 10_000))) return false;
  if (has(value, "blendAngleDeg") && (fillet || typeof value["blendAngleDeg"] !== "number" || !(value["blendAngleDeg"] > 0 && value["blendAngleDeg"] < 180))) return false;
  if (has(value, "blendSecondSizeMm") && has(value, "blendAngleDeg")) return false;
  if (has(value, "blendFlip") && (fillet || typeof value["blendFlip"] !== "boolean")) return false;
  return true;
}

const trimmed = (value: number): string => String(Number(value.toFixed(3)));

/** The kind and size of an edge-blend step: "Fillet R 2 mm", "Fillet R 1 → 4 mm", "Chamfer 3 × 2 mm", "Chamfer 4 mm at 30°". */
export function edgeBlendTitle(feature: DesignSolidFeature): string {
  const size = feature.valueMm;
  let how: string;
  if (feature.blendType === "chamfer") {
    how = feature.blendAngleDeg !== undefined ? `Chamfer ${trimmed(size)} mm at ${trimmed(feature.blendAngleDeg)}°`
      : feature.blendSecondSizeMm !== undefined ? `Chamfer ${trimmed(size)} × ${trimmed(feature.blendSecondSizeMm)} mm`
        : `Chamfer ${trimmed(size)} mm`;
  } else {
    how = feature.blendEndSizeMm !== undefined && feature.blendEndSizeMm !== size ? `Fillet R ${trimmed(size)} → ${trimmed(feature.blendEndSizeMm)} mm` : `Fillet R ${trimmed(size)} mm`;
  }
  return how;
}

/** What an edge-blend step does, in a few words: "Fillet R 2 mm · 2 edges", "Chamfer 4 mm at 30° · 1 edge (inside)". */
export function edgeBlendSummary(feature: DesignSolidFeature): string {
  const groups = feature.blendEdges ?? [];
  const how = edgeBlendTitle(feature);
  const inside = groups.filter((group) => group.concave === true).length;
  const where = `${groups.length} ${groups.length === 1 ? "edge" : "edges"}${inside === 0 ? "" : inside === groups.length ? " (inside)" : ` (${inside} inside)`}`;
  return `${how} · ${where}`;
}
