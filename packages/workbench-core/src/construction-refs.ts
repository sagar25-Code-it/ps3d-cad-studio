import type { ConstructionBinder, ConstructionEdgeRef, ConstructionPathRef, ConstructionPlaneDefinition } from "./types.js";

/**
 * Shape checks for the construction references added with "Plane through two edges", "Plane along path" and the shape /
 * sub-shape binders. They are pure structure checks (finite, bounded, no stray keys); whether an id points at something that
 * exists is decided by the operation that adds the record.
 */

const MAX_COORDINATE_MM = 100_000;
const MAX_POLYLINE_POINTS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function point(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component) && Math.abs(component) <= MAX_COORDINATE_MM);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

export function validEdgeRef(value: unknown): value is ConstructionEdgeRef {
  if (!isRecord(value)) return false;
  if (value.kind === "axis") return exactKeys(value, ["kind", "axisId"]) && stableId(value.axisId);
  if (value.kind === "binder") return exactKeys(value, ["kind", "binderId"]) && stableId(value.binderId);
  if (value.kind === "segment") return exactKeys(value, ["kind", "a", "b"]) && point(value.a) && point(value.b) && !samePoint(value.a, value.b);
  if (value.kind === "body-edge") return exactKeys(value, ["kind", "bodyId", "a", "b"]) && stableId(value.bodyId) && point(value.a) && point(value.b) && !samePoint(value.a, value.b);
  return false;
}

export function validPathRef(value: unknown): value is ConstructionPathRef {
  if (!isRecord(value)) return false;
  if (value.kind === "axis") return exactKeys(value, ["kind", "axisId"]) && stableId(value.axisId);
  if (value.kind === "polyline") {
    return exactKeys(value, ["kind", "pointsMm"], ["sketchFeatureId", "entityId"])
      && Array.isArray(value.pointsMm) && value.pointsMm.length >= 2 && value.pointsMm.length <= MAX_POLYLINE_POINTS && value.pointsMm.every(point)
      && (value.sketchFeatureId === undefined || typeof value.sketchFeatureId === "string" && value.sketchFeatureId.length <= 160)
      && (value.entityId === undefined || typeof value.entityId === "string" && value.entityId.length <= 160);
  }
  return false;
}

/**
 * Checks the two plane definitions this module owns. Returns undefined for any other kind so the caller keeps checking its own
 * kinds, and a verdict for ours.
 */
export function validNewPlaneDefinition(definition: Record<string, unknown>): boolean | undefined {
  if (definition.kind === "through-two-edges") {
    return exactKeys(definition, ["kind", "edgeA", "edgeB"]) && validEdgeRef(definition.edgeA) && validEdgeRef(definition.edgeB);
  }
  if (definition.kind === "along-path") {
    return exactKeys(definition, ["kind", "path", "t", "orientation"]) && validPathRef(definition.path)
      && typeof definition.t === "number" && Number.isFinite(definition.t) && definition.t >= 0 && definition.t <= 1
      && (definition.orientation === "perpendicular" || definition.orientation === "tangent");
  }
  return undefined;
}

export function validConstructionBinder(value: unknown): value is ConstructionBinder {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "visible", "target"]) || !stableId(value.id)
    || typeof value.name !== "string" || value.name.trim().length < 1 || value.name.length > 120 || typeof value.visible !== "boolean"
    || !isRecord(value.target)) return false;
  const target = value.target;
  if (target.kind === "body") return exactKeys(target, ["kind", "bodyId"]) && stableId(target.bodyId);
  if (target.kind === "edge") return exactKeys(target, ["kind", "bodyId", "a", "b"]) && stableId(target.bodyId) && point(target.a) && point(target.b) && !samePoint(target.a, target.b);
  if (target.kind === "face") {
    if (!exactKeys(target, ["kind", "bodyId", "faceKey", "normal", "centroidMm", "areaMm2"]) || !stableId(target.bodyId)
      || typeof target.faceKey !== "string" || target.faceKey.length > 200
      || !point(target.normal) || !point(target.centroidMm)
      || typeof target.areaMm2 !== "number" || !Number.isFinite(target.areaMm2) || target.areaMm2 < 0 || target.areaMm2 > 1e9) return false;
    return Math.abs(Math.hypot(target.normal[0], target.normal[1], target.normal[2]) - 1) < 1e-6;
  }
  return false;
}

/** The ids a plane definition depends on, so an operation can refuse a plane that points at nothing. */
export function planeDependencies(definition: ConstructionPlaneDefinition): { readonly axisIds: readonly string[]; readonly binderIds: readonly string[]; readonly bodyIds: readonly string[] } {
  const axisIds: string[] = []; const binderIds: string[] = []; const bodyIds: string[] = [];
  const edge = (ref: ConstructionEdgeRef): void => {
    if (ref.kind === "axis") axisIds.push(ref.axisId);
    else if (ref.kind === "binder") binderIds.push(ref.binderId);
    else if (ref.kind === "body-edge") bodyIds.push(ref.bodyId);
  };
  if (definition.kind === "through-two-edges") { edge(definition.edgeA); edge(definition.edgeB); }
  else if (definition.kind === "along-path" && definition.path.kind === "axis") axisIds.push(definition.path.axisId);
  else if (definition.kind === "perpendicular-to-axis") axisIds.push(definition.axisId);
  return { axisIds, binderIds, bodyIds };
}

export function binderBodyId(binder: ConstructionBinder): string {
  return binder.target.bodyId;
}

function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-9;
}
