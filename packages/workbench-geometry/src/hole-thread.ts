import type { HoleSpec } from "./hole.js";

type Vec3 = readonly [number, number, number];

/** A thread on a tapped hole. `cosmetic` leaves the hole plain and only annotates it; `modelled` cuts the helical groove into the wall. */
export interface HoleThread {
  readonly mode: "cosmetic" | "modelled";
  readonly pitchMm: number;
  /** The thread's major diameter: the nominal size, where the groove reaches. The hole's own diameter is the minor (tap-drill) diameter. */
  readonly majorDiameterMm: number;
  /** How deep the thread runs from the face; 0 or missing threads the hole's full depth. */
  readonly lengthMm?: number;
  readonly handedness: "right" | "left";
}

/** ISO 68-1 sizes: the thread depth for a pitch is 5/8 of the fundamental triangle's height (H = 0.866 P), i.e. 0.5413 P. */
export function isoThreadDepthMm(pitchMm: number): number {
  return 0.5413 * pitchMm;
}

/** Coarse ISO metric pitch for a nominal size (M3 to M12), which is what a tapped hole of that size is cut with. */
export const COARSE_PITCH_MM: Readonly<Record<number, number>> = { 2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75 };

/** The tap-drill (minor) diameter that goes with a nominal size and pitch: D - 1.0825 P. */
export function tapDrillDiameterMm(nominalMm: number, pitchMm: number): number {
  return nominalMm - 1.082532 * pitchMm;
}

/** Why a thread cannot be cut on a hole of this diameter, or undefined when it can. */
export function threadProblem(thread: HoleThread, minorDiameterMm: number): string | undefined {
  if (!(thread.pitchMm > 0) || thread.pitchMm > 50) return "A thread needs a pitch between 0 and 50 mm.";
  if (!(thread.majorDiameterMm > minorDiameterMm)) return "The thread's major diameter must be larger than the hole's own (tap-drill) diameter.";
  const depth = (thread.majorDiameterMm - minorDiameterMm) / 2;
  if (depth > thread.pitchMm) return `The thread would be ${depth.toFixed(2)} mm deep, deeper than its ${thread.pitchMm} mm pitch; use a smaller major diameter or a coarser pitch.`;
  if (thread.lengthMm !== undefined && !(thread.lengthMm >= 0)) return "A thread length cannot be negative.";
  return undefined;
}

/** How many rings of the groove are sampled per pitch (the thread flanks are this fine). */
export const THREAD_SAMPLES_PER_PITCH = 8;

/** The groove shape across one pitch, 0 at the root (the minor diameter) to 1 at the crest (the major diameter): a trapezoid with 1/8 pitch flats. */
export function threadGroove(phase: number): number {
  let wrapped = phase - Math.floor(phase);
  if (wrapped >= 0.5) wrapped -= 1;
  const a = Math.abs(wrapped);
  if (a <= 1 / 16) return 1;
  if (a >= 7 / 16) return 0;
  return 1 - (a - 1 / 16) / (3 / 8);
}

/** How deep the thread runs: its `lengthMm` when that is shorter than the hole, otherwise the hole's whole depth. */
export function resolvedThreadLengthMm(thread: HoleThread, holeDepthMm: number): number {
  return thread.lengthMm !== undefined && thread.lengthMm > 0 && thread.lengthMm < holeDepthMm ? thread.lengthMm : holeDepthMm;
}

/** The groove's strength at depth d: full along the thread, running out over its last pitch back to the plain bore when the thread is shorter than the hole. */
export function threadAmplitude(depthMm: number, thread: HoleThread, holeDepthMm: number): number {
  const length = resolvedThreadLengthMm(thread, holeDepthMm);
  if (length >= holeDepthMm) return 1;
  if (depthMm <= length - thread.pitchMm) return 1;
  if (depthMm >= length) return 0;
  return (length - depthMm) / thread.pitchMm;
}

/**
 * The radius of a threaded hole's wall at an angle about its axis and a depth below the face: minor + (major - minor)/2 * groove(...).
 * The groove follows a true helix, d / pitch + hand * angle / 2 pi being constant along it; `angle` is measured about the face's
 * outward normal, so a right-hand thread (hand +1) gets deeper as the angle falls, i.e. turning clockwise seen from the face.
 */
export function threadRadiusMm(minorDiameterMm: number, thread: HoleThread, holeDepthMm: number, depthMm: number, angleRad: number): number {
  const groove = (thread.majorDiameterMm - minorDiameterMm) / 2;
  const hand = thread.handedness === "right" ? 1 : -1;
  return minorDiameterMm / 2 + threadAmplitude(depthMm, thread, holeDepthMm) * groove * threadGroove(depthMm / thread.pitchMm + (hand * angleRad) / (Math.PI * 2));
}

/**
 * A cosmetic thread: the circles a drawing or viewport shows for a tapped hole without cutting a helix. The major-diameter circle
 * is drawn at the face and the minor circle at the thread's end, with the axis line between them.
 */
export interface CosmeticThread {
  readonly designation: string;
  readonly originMm: Vec3;
  /** Unit vector pointing into the material. */
  readonly axisMm: Vec3;
  readonly majorDiameterMm: number;
  readonly minorDiameterMm: number;
  readonly pitchMm: number;
  readonly lengthMm: number;
  readonly handedness: "right" | "left";
}

/** The cosmetic thread a hole step describes, for any thread mode (a modelled thread is annotated too). */
export function cosmeticThreadOf(spec: HoleSpec, thread: HoleThread): CosmeticThread {
  const length = Math.hypot(spec.normal[0], spec.normal[1], spec.normal[2]);
  const axis: Vec3 = length < 1e-9 ? [0, 0, -1] : [-spec.normal[0] / length, -spec.normal[1] / length, -spec.normal[2] / length];
  const nominal = Number(thread.majorDiameterMm.toFixed(2));
  return {
    designation: `M${nominal}x${Number(thread.pitchMm.toFixed(3))}${thread.handedness === "left" ? "-LH" : ""}`,
    originMm: spec.originMm,
    axisMm: axis,
    majorDiameterMm: thread.majorDiameterMm,
    minorDiameterMm: spec.diameterMm,
    pitchMm: thread.pitchMm,
    lengthMm: resolvedThreadLengthMm(thread, spec.depthMm),
    handedness: thread.handedness
  };
}

/** Closed circle polylines of a cosmetic thread (major circle at the face, minor circle at its end) plus the axis, as 3D points. */
export function cosmeticThreadCurves(thread: CosmeticThread, segments = 48): readonly (readonly Vec3[])[] {
  const n: Vec3 = [-thread.axisMm[0], -thread.axisMm[1], -thread.axisMm[2]];
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uRaw: Vec3 = [helper[1] * n[2] - helper[2] * n[1], helper[2] * n[0] - helper[0] * n[2], helper[0] * n[1] - helper[1] * n[0]];
  const uLength = Math.hypot(uRaw[0], uRaw[1], uRaw[2]) || 1;
  const u: Vec3 = [uRaw[0] / uLength, uRaw[1] / uLength, uRaw[2] / uLength];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const circle = (radius: number, depth: number): Vec3[] => {
    const points: Vec3[] = [];
    for (let j = 0; j <= segments; j += 1) {
      const angle = (j / segments) * Math.PI * 2;
      const c = Math.cos(angle) * radius;
      const s = Math.sin(angle) * radius;
      points.push([
        thread.originMm[0] + u[0] * c + v[0] * s + thread.axisMm[0] * depth,
        thread.originMm[1] + u[1] * c + v[1] * s + thread.axisMm[1] * depth,
        thread.originMm[2] + u[2] * c + v[2] * s + thread.axisMm[2] * depth
      ]);
    }
    return points;
  };
  return [
    circle(thread.majorDiameterMm / 2, 0),
    circle(thread.minorDiameterMm / 2, thread.lengthMm),
    [thread.originMm, [thread.originMm[0] + thread.axisMm[0] * thread.lengthMm, thread.originMm[1] + thread.axisMm[1] * thread.lengthMm, thread.originMm[2] + thread.axisMm[2] * thread.lengthMm]]
  ];
}
