/**
 * Interference detection between solid bodies in the Part workspace: every pair whose bounding boxes overlap is
 * intersected with the mesh Boolean, and the volume of the common region is the interference. When the Boolean cannot
 * give one clean solid (an intersection of several separate pieces, or a body too detailed for it) the volume is
 * estimated by casting parallel rays through a grid of columns and measuring where both bodies are solid, which is
 * exact along each ray and approximate only across the grid. Touching bodies (shared face or edge, zero common
 * volume) are not interference.
 */

import { booleanMeshes } from "./mesh-boolean.js";

type V3 = readonly [number, number, number];

export interface AnalysisBodyMesh {
  readonly id: string;
  readonly name: string;
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

export interface BodyInterference {
  readonly ids: readonly [string, string];
  readonly names: readonly [string, string];
  readonly volumeMm3: number;
  /** `boolean`: exact common solid from the mesh Boolean; `sampled`: ray-column estimate. */
  readonly method: "boolean" | "sampled";
  /** One body lies completely inside the other. */
  readonly containment: "none" | "first-in-second" | "second-in-first";
  readonly overlapBoundsMm: { readonly min: V3; readonly max: V3 };
  /** The common region as a closed mesh, when the Boolean produced one. */
  readonly commonMesh?: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] };
}

export interface InterferenceReport {
  readonly bodiesTested: number;
  readonly pairsTested: number;
  /** Pairs rejected by the bounding-box test, so no Boolean was needed. */
  readonly pairsClear: number;
  readonly interferences: readonly BodyInterference[];
  /** Pairs that could not be judged, with the reason (for example an open mesh). */
  readonly skipped: readonly { readonly ids: readonly [string, string]; readonly reason: string }[];
  readonly totalVolumeMm3: number;
}

export interface InterferenceOptions {
  /** Common volumes at or below this (mm3) are not reported (default 1e-6). */
  readonly minVolumeMm3?: number;
  /** Columns per axis of the sampled fallback (default 64). */
  readonly sampleResolution?: number;
}

export function findBodyInterferences(bodies: readonly AnalysisBodyMesh[], options: InterferenceOptions = {}): InterferenceReport {
  const minVolume = options.minVolumeMm3 ?? 1e-6;
  const bounds = bodies.map((body) => boundsOf(body.positionsMm));
  const interferences: BodyInterference[] = [];
  const skipped: { ids: readonly [string, string]; reason: string }[] = [];
  let pairsTested = 0;
  let pairsClear = 0;
  for (let first = 0; first < bodies.length; first += 1) {
    for (let second = first + 1; second < bodies.length; second += 1) {
      pairsTested += 1;
      const a = bodies[first]!; const b = bodies[second]!;
      const boxA = bounds[first]!; const boxB = bounds[second]!;
      const overlap = overlapBox(boxA, boxB);
      if (overlap === undefined) { pairsClear += 1; continue; }
      const ids = [a.id, b.id] as const;
      const names = [a.name, b.name] as const;
      const result = booleanMeshes({ positionsMm: a.positionsMm, indices: a.indices }, { positionsMm: b.positionsMm, indices: b.indices }, "intersect");
      if (result.ok) {
        if (result.value.volumeMm3 > minVolume) {
          interferences.push({
            ids, names, volumeMm3: result.value.volumeMm3, method: "boolean",
            containment: containmentOf(result.value.volumeMm3, a.positionsMm, a.indices, b.positionsMm, b.indices),
            overlapBoundsMm: overlap, commonMesh: { positionsMm: result.value.positionsMm, indices: result.value.indices }
          });
        } else pairsClear += 1;
        continue;
      }
      if (result.message.includes("intersection is empty")) { pairsClear += 1; continue; }
      const reason = result.message;
      const sampleable = reason.includes("separate pieces") || reason.includes("limited to") || reason.includes("too detailed") || reason.includes("could not be evaluated") || reason.includes("inconsistent volume");
      if (!sampleable) { skipped.push({ ids, reason }); continue; }
      const volume = sampledOverlapVolume(a, b, overlap, options.sampleResolution ?? 64);
      if (volume > minVolume) {
        interferences.push({ ids, names, volumeMm3: volume, method: "sampled", containment: containmentOf(volume, a.positionsMm, a.indices, b.positionsMm, b.indices), overlapBoundsMm: overlap });
      } else pairsClear += 1;
    }
  }
  return {
    bodiesTested: bodies.length,
    pairsTested,
    pairsClear,
    interferences,
    skipped,
    totalVolumeMm3: interferences.reduce((sum, entry) => sum + entry.volumeMm3, 0)
  };
}

function containmentOf(volume: number, positionsA: readonly number[], indicesA: readonly number[], positionsB: readonly number[], indicesB: readonly number[]): BodyInterference["containment"] {
  const volumeA = Math.abs(meshVolume(positionsA, indicesA));
  const volumeB = Math.abs(meshVolume(positionsB, indicesB));
  const tolerance = 1e-6 * Math.max(volumeA, volumeB) + 1e-9;
  if (Math.abs(volume - volumeA) <= tolerance) return "first-in-second";
  if (Math.abs(volume - volumeB) <= tolerance) return "second-in-first";
  return "none";
}

export function meshVolume(positionsMm: readonly number[], indices: readonly number[]): number {
  let six = 0;
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const a = indices[corner]! * 3; const b = indices[corner + 1]! * 3; const c = indices[corner + 2]! * 3;
    const p = positionsMm;
    six += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) + p[a + 1]! * (p[b + 2]! * p[c]! - p[b]! * p[c + 2]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return six / 6;
}

function boundsOf(positionsMm: readonly number[]): { readonly min: V3; readonly max: V3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positionsMm.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positionsMm[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** The box common to two boxes, or undefined when they are apart or only touch. */
function overlapBox(a: { readonly min: V3; readonly max: V3 }, b: { readonly min: V3; readonly max: V3 }): { readonly min: V3; readonly max: V3 } | undefined {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.max(a.min[axis]!, b.min[axis]!);
    max[axis] = Math.min(a.max[axis]!, b.max[axis]!);
    if (!(max[axis]! - min[axis]! > 1e-7)) return undefined;
  }
  return { min, max };
}

/** Volume of the region solid in both bodies, from a grid of columns along Z (exact along each column). */
export function sampledOverlapVolume(a: AnalysisBodyMesh, b: AnalysisBodyMesh, box: { readonly min: V3; readonly max: V3 }, resolution: number): number {
  const n = Math.max(8, Math.floor(resolution));
  const sizeX = box.max[0] - box.min[0];
  const sizeY = box.max[1] - box.min[1];
  const cellX = sizeX / n;
  const cellY = sizeY / n;
  const columnsA = columnIntervals(a, box, n);
  const columnsB = columnIntervals(b, box, n);
  let volume = 0;
  for (let column = 0; column < n * n; column += 1) {
    const left = columnsA[column]; const right = columnsB[column];
    if (left === undefined || right === undefined) continue;
    volume += intervalOverlap(left, right) * cellX * cellY;
  }
  return volume;
}

function columnIntervals(body: AnalysisBodyMesh, box: { readonly min: V3; readonly max: V3 }, n: number): (readonly number[] | undefined)[] {
  const cellX = (box.max[0] - box.min[0]) / n;
  const cellY = (box.max[1] - box.min[1]) / n;
  // A tiny irrational offset keeps rays from running exactly along shared mesh edges.
  const offsetX = cellX * 0.0137;
  const offsetY = cellY * 0.0291;
  const hits: number[][] = Array.from({ length: n * n }, () => []);
  const p = body.positionsMm;
  for (let corner = 0; corner + 2 < body.indices.length; corner += 3) {
    const ia = body.indices[corner]! * 3; const ib = body.indices[corner + 1]! * 3; const ic = body.indices[corner + 2]! * 3;
    const ax = p[ia]!, ay = p[ia + 1]!, az = p[ia + 2]!;
    const bx = p[ib]!, by = p[ib + 1]!, bz = p[ib + 2]!;
    const cx = p[ic]!, cy = p[ic + 1]!, cz = p[ic + 2]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-14) continue;
    const minX = Math.min(ax, bx, cx); const maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy); const maxY = Math.max(ay, by, cy);
    const i0 = Math.max(0, Math.floor((minX - box.min[0]) / cellX - 0.5));
    const i1 = Math.min(n - 1, Math.ceil((maxX - box.min[0]) / cellX - 0.5));
    const j0 = Math.max(0, Math.floor((minY - box.min[1]) / cellY - 0.5));
    const j1 = Math.min(n - 1, Math.ceil((maxY - box.min[1]) / cellY - 0.5));
    for (let i = i0; i <= i1; i += 1) {
      const x = box.min[0] + (i + 0.5) * cellX + offsetX;
      for (let j = j0; j <= j1; j += 1) {
        const y = box.min[1] + (j + 0.5) * cellY + offsetY;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        hits[j * n + i]!.push(l1 * az + l2 * bz + l3 * cz);
      }
    }
  }
  return hits.map((zs) => {
    if (zs.length === 0 || zs.length % 2 !== 0) return undefined;
    zs.sort((left, right) => left - right);
    return zs;
  });
}

/** Length shared by two sorted lists of [enter, exit, enter, exit, ...] crossings. */
function intervalOverlap(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let i = 0; i + 1 < left.length; i += 2) {
    for (let j = 0; j + 1 < right.length; j += 2) {
      const low = Math.max(left[i]!, right[j]!);
      const high = Math.min(left[i + 1]!, right[j + 1]!);
      if (high > low) total += high - low;
    }
  }
  return total;
}
