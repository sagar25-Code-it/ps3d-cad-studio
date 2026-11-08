import type { HoleThread } from "./hole-thread.js";

type Vec3 = readonly [number, number, number];

export type HoleStyle = "simple" | "counterbore" | "countersink";

/** What to drill: where it starts on a face, which way the face looks, and the shape of the hole. */
export interface HoleSpec {
  readonly style: HoleStyle;
  /** The point on the face where the hole starts. */
  readonly originMm: Vec3;
  /** The face's outward direction; the hole is drilled the opposite way, into the material. */
  readonly normal: Vec3;
  readonly diameterMm: number;
  /** How deep the full-diameter hole goes, measured from the face. */
  readonly depthMm: number;
  /** Counterbore: the wide pocket's diameter and depth. */
  readonly counterDiameterMm?: number;
  readonly counterDepthMm?: number;
  /** Countersink: the diameter at the face and the included angle of the cone. */
  readonly sinkDiameterMm?: number;
  readonly sinkAngleDeg?: number;
  /** A tapped hole's thread. The cutter is always the plain tap-drill bore; a modelled thread is then shaped into the cut wall (see threadBoreWall). */
  readonly thread?: HoleThread;
}

export type HoleCutterResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly sinkDepthMm: number }
  | { readonly ok: false; readonly message: string };

const OVERSHOOT_MM = 0.5;
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

function unit(vector: Vec3): Vec3 | undefined {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 1e-9 ? undefined : [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** Snaps a direction that is within a hair of a coordinate axis onto it, so holes in flat faces stay exactly square. */
export function snapToAxis(vector: Vec3): Vec3 {
  const direction = unit(vector);
  if (direction === undefined) return [0, 0, 1];
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]!) > 0.99995) return [axis === 0 ? Math.sign(direction[0]) : 0, axis === 1 ? Math.sign(direction[1]) : 0, axis === 2 ? Math.sign(direction[2]) : 0];
  }
  return direction;
}

/** The depth of the cone of a countersink: from the face down to where it meets the straight hole. */
export function countersinkDepthMm(sinkDiameterMm: number, diameterMm: number, includedAngleDeg: number): number {
  return (sinkDiameterMm - diameterMm) / 2 / Math.tan((includedAngleDeg * Math.PI) / 360);
}

/**
 * The solid to subtract for a hole: a profile (radius against depth from the face) spun about the hole's axis. It starts a little
 * above the face so the cut leaves no sliver, and its profile depends on the style: a plain cylinder, a cylinder under a wider
 * pocket (counterbore) or a cylinder under a cone (countersink). The mesh is closed and outward-facing.
 */
export function holeCutter(spec: HoleSpec, segments = 48): HoleCutterResult {
  const normal = unit(spec.normal);
  if (normal === undefined) return { ok: false, message: "The hole has no direction: its face normal is zero." };
  if (!spec.originMm.every(Number.isFinite)) return { ok: false, message: "The hole position is not a finite point." };
  const radius = spec.diameterMm / 2;
  if (!(radius > 0)) return { ok: false, message: "A hole needs a positive diameter." };
  if (!(spec.depthMm > 0)) return { ok: false, message: "A hole needs a positive depth." };
  if (!Number.isInteger(segments) || segments < 8 || segments > 128) return { ok: false, message: "The hole needs between 8 and 128 segments." };
  const e = OVERSHOOT_MM;
  let profile: [number, number][];
  let sinkDepth = 0;
  if (spec.style === "counterbore") {
    if (!finite(spec.counterDiameterMm) || !finite(spec.counterDepthMm) || !(spec.counterDiameterMm > spec.diameterMm) || !(spec.counterDepthMm > 0)) return { ok: false, message: "A counterbore needs a pocket wider than the hole and a positive pocket depth." };
    if (!(spec.counterDepthMm < spec.depthMm)) return { ok: false, message: "The counterbore pocket must be shallower than the hole." };
    const wide = spec.counterDiameterMm / 2;
    profile = [[0, -e], [wide, -e], [wide, spec.counterDepthMm], [radius, spec.counterDepthMm], [radius, spec.depthMm], [0, spec.depthMm]];
  } else if (spec.style === "countersink") {
    if (!finite(spec.sinkDiameterMm) || !finite(spec.sinkAngleDeg) || !(spec.sinkDiameterMm > spec.diameterMm) || !(spec.sinkAngleDeg >= 10 && spec.sinkAngleDeg <= 170)) return { ok: false, message: "A countersink needs a face diameter wider than the hole and an included angle from 10° to 170°." };
    sinkDepth = countersinkDepthMm(spec.sinkDiameterMm, spec.diameterMm, spec.sinkAngleDeg);
    if (!(sinkDepth < spec.depthMm)) return { ok: false, message: "The countersink cone must be shallower than the hole." };
    const slope = Math.tan((spec.sinkAngleDeg * Math.PI) / 360);
    profile = [[0, -e], [spec.sinkDiameterMm / 2 + e * slope, -e], [radius, sinkDepth], [radius, spec.depthMm], [0, spec.depthMm]];
  } else {
    profile = [[0, -e], [radius, -e], [radius, spec.depthMm], [0, spec.depthMm]];
  }
  // A frame (u, v, normal) at the face; the hole runs along -normal.
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uRaw: Vec3 = [helper[1] * normal[2] - helper[2] * normal[1], helper[2] * normal[0] - helper[0] * normal[2], helper[0] * normal[1] - helper[1] * normal[0]];
  const u = unit(uRaw)!;
  const v: Vec3 = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
  const positions: number[] = [];
  const point = (r: number, angle: number, depth: number): void => {
    const c = Math.cos(angle) * r;
    const s = Math.sin(angle) * r;
    positions.push(
      spec.originMm[0] + u[0] * c + v[0] * s - normal[0] * depth,
      spec.originMm[1] + u[1] * c + v[1] * s - normal[1] * depth,
      spec.originMm[2] + u[2] * c + v[2] * s - normal[2] * depth
    );
  };
  // One ring of vertices per profile point; points on the axis collapse to a single vertex.
  const firstOfRing: number[] = [];
  for (const [r, depth] of profile) {
    firstOfRing.push(positions.length / 3);
    if (r === 0) point(0, 0, depth);
    else for (let j = 0; j < segments; j += 1) point(r, (j / segments) * Math.PI * 2, depth);
  }
  const indices: number[] = [];
  const ringVertex = (ring: number, j: number): number => (profile[ring]![0] === 0 ? firstOfRing[ring]! : firstOfRing[ring]! + (j % segments));
  for (let ring = 0; ring + 1 < profile.length; ring += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = ringVertex(ring, j);
      const b = ringVertex(ring, j + 1);
      const c = ringVertex(ring + 1, j + 1);
      const d = ringVertex(ring + 1, j);
      if (a !== b) indices.push(a, b, c);
      if (c !== d && a !== d) indices.push(a, c, d);
    }
  }
  // The profile is traversed in one direction, so the winding is the same everywhere; make it point outward.
  let volume = 0;
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const a = indices[corner]! * 3;
    const b = indices[corner + 1]! * 3;
    const c = indices[corner + 2]! * 3;
    volume += (positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)) / 6;
  }
  if (volume < 0) for (let corner = 0; corner + 2 < indices.length; corner += 3) { const t = indices[corner + 1]!; indices[corner + 1] = indices[corner + 2]!; indices[corner + 2] = t; }
  return { ok: true, positionsMm: positions, indices, sinkDepthMm: sinkDepth };
}
