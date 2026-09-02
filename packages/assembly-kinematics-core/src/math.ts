import type { Quaternion, Transform3, Vec3 } from "./canonical.js";

export const EPSILON = 1e-12;

export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function isFiniteVec3(value: Vec3): boolean {
  return value.every(isFiniteNumber);
}

export function addVec3(first: Vec3, second: Vec3): Vec3 {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

export function subtractVec3(first: Vec3, second: Vec3): Vec3 {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

export function scaleVec3(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

export function magnitudeVec3(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

export function normalizeVec3(value: Vec3): Vec3 | null {
  const magnitude = magnitudeVec3(value);
  return magnitude > EPSILON && Number.isFinite(magnitude) ? scaleVec3(value, 1 / magnitude) : null;
}

export function normalizeQuaternion(value: Quaternion): Quaternion | null {
  const magnitude = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!(magnitude > EPSILON) || !Number.isFinite(magnitude)) return null;
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude, value[3] / magnitude];
}

export function multiplyQuaternions(first: Quaternion, second: Quaternion): Quaternion {
  const [ax, ay, az, aw] = first;
  const [bx, by, bz, bw] = second;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

export function inverseQuaternion(value: Quaternion): Quaternion {
  return [-value[0], -value[1], -value[2], value[3]];
}

export function rotateVec3(rotation: Quaternion, value: Vec3): Vec3 {
  const vectorQuaternion: Quaternion = [value[0], value[1], value[2], 0];
  const rotated = multiplyQuaternions(multiplyQuaternions(rotation, vectorQuaternion), inverseQuaternion(rotation));
  return [rotated[0], rotated[1], rotated[2]];
}

/** Compose rigid transforms: result applies second, then first. */
export function composeTransforms(first: Transform3, second: Transform3): Transform3 {
  const rotation = normalizeQuaternion(multiplyQuaternions(first.rotation, second.rotation));
  if (rotation === null) throw new TypeError("Cannot compose a zero-length quaternion.");
  return {
    translationMeters: addVec3(first.translationMeters, rotateVec3(first.rotation, second.translationMeters)),
    rotation,
    scale: [1, 1, 1]
  };
}

export function inverseRigidTransform(value: Transform3): Transform3 {
  const normalized = normalizeQuaternion(value.rotation);
  if (normalized === null) throw new TypeError("Cannot invert a zero-length quaternion.");
  const rotation = inverseQuaternion(normalized);
  return {
    translationMeters: rotateVec3(rotation, scaleVec3(value.translationMeters, -1)),
    rotation,
    scale: [1, 1, 1]
  };
}

export function zAxisMotionTransform(angleRadians: number, offsetMeters: number): Transform3 {
  const half = angleRadians / 2;
  return {
    translationMeters: [0, 0, offsetMeters],
    rotation: [0, 0, Math.sin(half), Math.cos(half)],
    scale: [1, 1, 1]
  };
}

export function transformDifference(first: Transform3, second: Transform3): {
  readonly translationMeters: number;
  readonly rotationRadians: number;
} {
  const translationMeters = magnitudeVec3(subtractVec3(first.translationMeters, second.translationMeters));
  const firstRotation = normalizeQuaternion(first.rotation);
  const secondRotation = normalizeQuaternion(second.rotation);
  if (firstRotation === null || secondRotation === null) {
    return { translationMeters, rotationRadians: Number.POSITIVE_INFINITY };
  }
  const dot = Math.abs(
    firstRotation[0] * secondRotation[0]
      + firstRotation[1] * secondRotation[1]
      + firstRotation[2] * secondRotation[2]
      + firstRotation[3] * secondRotation[3]
  );
  return { translationMeters, rotationRadians: 2 * Math.acos(Math.min(1, dot)) };
}

export function withTranslatedTransform(base: Transform3, offset: Vec3): Transform3 {
  return {
    translationMeters: addVec3(base.translationMeters, offset),
    rotation: base.rotation,
    scale: base.scale
  };
}
