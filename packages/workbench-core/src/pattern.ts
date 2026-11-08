/**
 * Pattern steps of the parametric timeline: a rectangular (linear), circular or mirror pattern of a whole body or of recorded
 * features (holes and extrude cuts). A pattern step stores how the copies are laid out and what is copied; the mesh work happens
 * in the geometry package and the timeline replay, so editing the source regenerates the copies.
 */

export type PatternVec = readonly [number, number, number];

/** The axis a circular pattern turns about: a world axis through the origin, or a construction axis of the part (followed live). */
export type PatternAxisRef =
  | { readonly kind: "datum"; readonly axis: "x" | "y" | "z" }
  | { readonly kind: "construction"; readonly axisId: string };

/**
 * The plane a mirror reflects across: a datum plane, optionally moved along its own axis (XY at z = offset, XZ at y = offset,
 * YZ at x = offset), or a construction plane of the part (followed live).
 */
export type PatternPlaneRef =
  | { readonly kind: "datum"; readonly plane: "xy" | "xz" | "yz"; readonly offsetMm?: number }
  | { readonly kind: "construction"; readonly planeId: string };

export interface RectangularPatternShape {
  readonly type: "rectangular";
  /** Instances in the first direction, the original included. */
  readonly countA: number;
  /** Distance between neighbours, or with `sizing: "extent"` the distance from the first instance to the last. */
  readonly spacingAMm: number;
  readonly directionA: PatternVec;
  /** Instances in the second direction; 1 makes a one-direction pattern. */
  readonly countB: number;
  readonly spacingBMm: number;
  readonly directionB: PatternVec;
  readonly sizing: "spacing" | "extent";
}

export interface CircularPatternShape {
  readonly type: "circular";
  /** Instances around the axis, the original included. */
  readonly count: number;
  /** 360 spreads the instances evenly round the full circle; less puts the last instance this far from the first. Negative turns the other way. */
  readonly totalAngleDeg: number;
  readonly axis: PatternAxisRef;
}

export interface MirrorPatternShape {
  readonly type: "mirror";
  readonly plane: PatternPlaneRef;
}

export type PatternShape = RectangularPatternShape | CircularPatternShape | MirrorPatternShape;

export type PatternDefinition = PatternShape & {
  /** "new-bodies" makes each copy a body of its own; "join" merges the copies into the patterned body with a Boolean union. */
  readonly result: "new-bodies" | "join";
  /** Shared by the steps one pattern command made, so they edit and read as one pattern. */
  readonly groupId: string;
  /** The body whose shape is copied. For a pattern of features it is the body the features are in. */
  readonly sourceBodyId: string;
  /** New-bodies steps only: which copy this step builds (1 is the first copy after the original). */
  readonly copyIndex?: number;
  /** Pattern of features: the timeline steps (holes, extrude cuts) to repeat at every position, in the same body. */
  readonly featureIds?: readonly string[];
};

export const MAX_PATTERN_INSTANCES = 100;

const finiteIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const wholeIn = (value: unknown, min: number, max: number): value is number => finiteIn(value, min, max) && Number.isInteger(value);
const stableText = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const direction = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 1_000_000) && Math.hypot(value[0] as number, value[1] as number, value[2] as number) > 1e-9;

function validAxisRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "datum") return sameKeys(value, ["kind", "axis"], []) && ["x", "y", "z"].includes(String(value.axis));
  return value.kind === "construction" && sameKeys(value, ["kind", "axisId"], []) && stableText(value.axisId);
}

function validPlaneRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "datum") return sameKeys(value, ["kind", "plane"], ["offsetMm"]) && ["xy", "xz", "yz"].includes(String(value.plane)) && (!Object.hasOwn(value, "offsetMm") || finiteIn(value.offsetMm, -100_000, 100_000));
  return value.kind === "construction" && sameKeys(value, ["kind", "planeId"], []) && stableText(value.planeId);
}

/** How many instances (the original included) a pattern shape lays out. A mirror makes two. */
export function patternInstanceCount(shape: PatternShape): number {
  return shape.type === "rectangular" ? shape.countA * shape.countB : shape.type === "circular" ? shape.count : 2;
}

/** Whether a stored pattern definition is complete and inside the limits the replay supports. */
export function validPatternDefinition(value: unknown): value is PatternDefinition {
  if (!isRecord(value)) return false;
  const common = ["type", "result", "groupId", "sourceBodyId"];
  if (!["new-bodies", "join"].includes(String(value.result)) || !stableText(value.groupId) || !stableText(value.sourceBodyId)) return false;
  if (Object.hasOwn(value, "copyIndex") && !wholeIn(value.copyIndex, 1, MAX_PATTERN_INSTANCES)) return false;
  if (Object.hasOwn(value, "featureIds")) {
    const ids = value.featureIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 32 || ids.some((id) => !stableText(id)) || new Set(ids).size !== ids.length) return false;
  }
  // A new-bodies step builds one numbered copy; a join or feature pattern changes the source body itself and has no copy number.
  const features = Object.hasOwn(value, "featureIds");
  if ((value.result === "new-bodies") !== Object.hasOwn(value, "copyIndex")) return false;
  if (features && value.result === "new-bodies") return false;
  const trailing = ["copyIndex", "featureIds"];
  if (value.type === "rectangular") {
    if (!sameKeys(value, [...common, "countA", "spacingAMm", "directionA", "countB", "spacingBMm", "directionB", "sizing"], trailing)) return false;
    if (!wholeIn(value.countA, 1, MAX_PATTERN_INSTANCES) || !wholeIn(value.countB, 1, MAX_PATTERN_INSTANCES) || (value.countA as number) * (value.countB as number) < 2 || (value.countA as number) * (value.countB as number) > MAX_PATTERN_INSTANCES) return false;
    if (!["spacing", "extent"].includes(String(value.sizing))) return false;
    if (!finiteIn(value.spacingAMm, 0, 100_000) || !((value.spacingAMm as number) > 0) || !direction(value.directionA)) return false;
    if (!finiteIn(value.spacingBMm, 0, 100_000) || !direction(value.directionB)) return false;
    if ((value.countB as number) > 1 && !((value.spacingBMm as number) > 0)) return false;
    return true;
  }
  if (value.type === "circular") {
    if (!sameKeys(value, [...common, "count", "totalAngleDeg", "axis"], trailing)) return false;
    return wholeIn(value.count, 2, MAX_PATTERN_INSTANCES) && finiteIn(value.totalAngleDeg, -360, 360) && Math.abs(value.totalAngleDeg as number) >= 0.001 && validAxisRef(value.axis);
  }
  if (value.type === "mirror") return sameKeys(value, [...common, "plane"], trailing) && validPlaneRef(value.plane);
  return false;
}

/** A short phrase for the timeline and the status line: "4 × 2 rectangular", "6 around Z", "mirror about XY". */
export function describePattern(pattern: PatternDefinition): string {
  const what = pattern.featureIds === undefined ? (pattern.result === "join" ? "joined" : "new bodies") : `${pattern.featureIds.length} feature${pattern.featureIds.length === 1 ? "" : "s"}`;
  if (pattern.type === "rectangular") {
    const count = pattern.countB > 1 ? `${pattern.countA} × ${pattern.countB}` : `${pattern.countA}`;
    return `${count} rectangular · ${what}`;
  }
  if (pattern.type === "circular") {
    const axis = pattern.axis.kind === "datum" ? pattern.axis.axis.toUpperCase() : "a construction axis";
    return `${pattern.count} around ${axis}${Math.abs(pattern.totalAngleDeg) === 360 ? "" : ` over ${Number(pattern.totalAngleDeg.toFixed(2))}°`} · ${what}`;
  }
  const plane = pattern.plane.kind === "datum" ? pattern.plane.plane.toUpperCase() : "a construction plane";
  return `mirror about ${plane} · ${what}`;
}
