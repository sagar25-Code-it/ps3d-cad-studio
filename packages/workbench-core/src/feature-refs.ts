/**
 * Payload checks for the references a sketch-driven feature keeps to other geometry: the axis a revolve turns about, the chained path of
 * a sweep, the sketch a loft's second profile comes from and the face a sketch lies on. Kept apart from design.ts, which only lists the keys
 * and asks `validFeatureRefs`.
 */

export const FEATURE_REF_KEYS = ["revolveAxis", "sweepPath", "loftSecondarySketchFeatureId"] as const;

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const stable = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const point3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 1_000_000);

/** Whether the optional reference fields of a solid feature are well formed and used by the kind that understands them. */
export function validFeatureRefs(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, "revolveAxis")) {
    const axis = value.revolveAxis;
    if (value.kind !== "revolve" || !isRecord(axis)) return false;
    if (axis.kind === "sketch-axis") {
      if (!exactly(axis, ["kind", "axis"]) || (axis.axis !== "x" && axis.axis !== "y")) return false;
    } else if (axis.kind === "sketch-line") {
      if (!exactly(axis, ["kind", "entityId"]) || typeof axis.entityId !== "string" || axis.entityId.length === 0 || axis.entityId.length > 160) return false;
    } else if (axis.kind === "model-edge") {
      if (!exactly(axis, ["kind", "bodyId", "startMm", "endMm"]) || !stable(axis.bodyId) || !point3(axis.startMm) || !point3(axis.endMm)) return false;
      const a = axis.startMm as readonly number[];
      const b = axis.endMm as readonly number[];
      if (Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-6) return false;
    } else return false;
  }
  if (Object.hasOwn(value, "sweepPath")) {
    const path = value.sweepPath;
    if (value.kind !== "sweep" || !isRecord(path) || !exactly(path, ["sketchFeatureId", "entityIds"]) || !stable(path.sketchFeatureId)) return false;
    if (!Array.isArray(path.entityIds) || path.entityIds.length < 1 || path.entityIds.length > 64 || path.entityIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 160)) return false;
    if (new Set(path.entityIds as readonly string[]).size !== path.entityIds.length) return false;
    // A path is either a chain or a straight direction, not both.
    if (Object.hasOwn(value, "sweepDirectionMm") || Object.hasOwn(value, "sweepPathEntityId")) return false;
  }
  if (Object.hasOwn(value, "loftSecondarySketchFeatureId")) {
    if (value.kind !== "loft" || !stable(value.loftSecondarySketchFeatureId) || !Object.hasOwn(value, "loftSecondaryProfileIds")) return false;
  }
  return true;
}

/** A sketch plane's face reference (see SketchPlaneFaceRef): the shape check shared by the sketch validators. */
export function validSketchPlaneFace(value: unknown): boolean {
  return isRecord(value) && exactly(value, ["bodyId", "faceKey", "faceRole", "axis", "outwardPositive", "coordinateMm", "areaMm2"])
    && stable(value.bodyId) && typeof value.faceKey === "string" && value.faceKey.length >= 1 && value.faceKey.length <= 200
    && typeof value.faceRole === "string" && value.faceRole.length >= 1 && value.faceRole.length <= 200
    && (value.axis === "x" || value.axis === "y" || value.axis === "z") && typeof value.outwardPositive === "boolean"
    && typeof value.coordinateMm === "number" && Number.isFinite(value.coordinateMm) && Math.abs(value.coordinateMm) <= 1_000_000
    && typeof value.areaMm2 === "number" && Number.isFinite(value.areaMm2) && value.areaMm2 >= 0;
}
