import { booleanMeshes } from "./mesh-boolean.js";
import {
  analyzeFaces, cross, dot, meetPoint, movePlanes, resolveFace, scale, sub, unit,
  type FaceAnalysis, type FaceRefLike, type FaceRegion, type MeshLike, type PlaneLike, type V3
} from "./face-analysis.js";

/**
 * Edits of a closed body chosen by its faces: a general Shell, a Draft on picked faces, Offset region and Replace face.
 * Each one works from the flat regions of the mesh (see `face-analysis`), so it applies to any closed body, not only to a
 * rectangular one, and it keeps every face that was not chosen exactly where it was.
 */
export type FaceEditResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly notes: readonly string[]; readonly skipped: readonly SkippedFace[] }
  | { readonly ok: false; readonly message: string };

/** A picked face an edit could not use, and why. */
export interface SkippedFace {
  readonly ref: FaceRefLike;
  readonly reason: string;
}

interface Picked {
  readonly regions: readonly FaceRegion[];
  readonly skipped: readonly SkippedFace[];
}

function pick(mesh: MeshLike, analysis: FaceAnalysis, refs: readonly FaceRefLike[], what: string, usable: (region: FaceRegion) => string | undefined): Picked | string {
  const regions: FaceRegion[] = [];
  const skipped: SkippedFace[] = [];
  for (const ref of refs) {
    const found = resolveFace(mesh, analysis, ref, what);
    if (!found.ok) { skipped.push({ ref, reason: found.message }); continue; }
    if (found.region.curved) { skipped.push({ ref, reason: "It is a curved face (one facet of a cylinder or dome), and only flat faces can be used." }); continue; }
    const problem = usable(found.region);
    if (problem !== undefined) { skipped.push({ ref, reason: problem }); continue; }
    if (!regions.some((region) => region.id === found.region.id)) regions.push(found.region);
  }
  return { regions, skipped };
}

const withMesh = (positionsMm: readonly number[], indices: readonly number[], notes: readonly string[] = [], skipped: readonly SkippedFace[] = []): FaceEditResult => ({ ok: true, positionsMm, indices, notes, skipped });

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

export interface ShellFaceSpec {
  readonly thicknessMm: number;
  readonly side: "inside" | "outside" | "both";
  readonly openFaces: readonly FaceRefLike[];
}

/**
 * Hollows a closed body. The wall is built from two solids: the outer one (the body, grown outward for "outside" or "both") and
 * the cavity (the body with every non-open face moved inward, or kept for "outside"), whose open faces are pushed far out of
 * the body so the cavity breaks through them. The result is outer minus cavity, so it has walls of the exact thickness on every
 * flat face and an opening wherever a face was chosen.
 */
export function shellBody(mesh: MeshLike, spec: ShellFaceSpec): FaceEditResult {
  const t = spec.thicknessMm;
  if (!(t > 0) || !Number.isFinite(t)) return { ok: false, message: "The wall thickness must be a positive length." };
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return { ok: false, message: analysis };
  const picked = pick(mesh, analysis, spec.openFaces, "An open face", () => undefined);
  if (typeof picked === "string") return { ok: false, message: picked };
  if (picked.skipped.length > 0) return { ok: false, message: `Shell: ${picked.skipped[0]!.reason}` };
  const open = new Set(picked.regions.map((region) => region.id));
  if (open.size >= analysis.regions.length) return { ok: false, message: "Shell: every face is open, so nothing is left to be a wall." };
  const grow = spec.side === "outside" ? t : spec.side === "both" ? t / 2 : 0;
  const cut = spec.side === "outside" ? 0 : spec.side === "both" ? -t / 2 : -t;
  const push = analysis.diagonalMm * 2 + 4 * t + 10;
  const shifted = (offsets: (region: FaceRegion) => number): { readonly positionsMm: readonly number[] } | { readonly failure: string } => {
    const overrides = new Map<number, PlaneLike>();
    for (const region of analysis.regions) {
      const by = offsets(region);
      if (by !== 0) overrides.set(region.id, { normal: region.normal, offset: region.offset + by });
    }
    if (overrides.size === 0) return { positionsMm: mesh.positionsMm };
    const moved = movePlanes(mesh, analysis, overrides);
    return moved.ok ? { positionsMm: moved.positionsMm } : { failure: moved.message };
  };
  const outer = shifted((region) => (open.has(region.id) ? 0 : grow));
  if ("failure" in outer) return { ok: false, message: `The outer surface does not fit: ${outer.failure}` };
  const cavity = shifted((region) => (open.has(region.id) ? push : cut));
  if ("failure" in cavity) return { ok: false, message: `A ${t} mm wall is too thick for this body: ${cavity.failure}` };
  const result = booleanMeshes({ positionsMm: outer.positionsMm, indices: mesh.indices }, { positionsMm: cavity.positionsMm, indices: mesh.indices }, "cut");
  if (!result.ok) return { ok: false, message: `The shell could not be cut: ${result.message}` };
  return withMesh(result.value.positionsMm, result.value.indices, [`Shelled ${open.size === 0 ? "to a closed cavity" : `with ${open.size} open face${open.size === 1 ? "" : "s"}`}, ${t} mm ${spec.side}.`]);
}

// ---------------------------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------------------------

export interface DraftFaceSpec {
  readonly angleDeg: number;
  readonly pullDirection: V3;
  readonly neutralPointMm: V3;
  readonly faces: readonly FaceRefLike[];
}

/**
 * Tilts the picked flat faces by `angleDeg` from the pull direction, turning each one about the line where its plane meets the
 * neutral plane (the plane through `neutralPointMm`, square to the pull direction). Positive narrows the body along the pull
 * direction. A curved face, or a face square to the pull direction, cannot be drafted and is reported in `skipped`; the others
 * still are. The vertices follow, so faces that were not picked keep their planes.
 */
export function draftFaces(mesh: MeshLike, spec: DraftFaceSpec): FaceEditResult {
  const pull = unit(spec.pullDirection);
  if (pull === undefined) return { ok: false, message: "The pull direction has no length." };
  if (!Number.isFinite(spec.angleDeg) || spec.angleDeg === 0 || Math.abs(spec.angleDeg) > 45) return { ok: false, message: "The draft angle must be between -45° and 45° and not zero." };
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return { ok: false, message: analysis };
  const alpha = (spec.angleDeg * Math.PI) / 180;
  const neutralOffset = dot(pull, spec.neutralPointMm);
  const picked = pick(mesh, analysis, spec.faces, "A draft face", (region) => {
    const along = dot(region.normal, pull);
    if (Math.abs(along) > Math.cos((1 * Math.PI) / 180)) return "It is square to the pull direction (a cap), so there is no wall to lean.";
    return undefined;
  });
  if (typeof picked === "string") return { ok: false, message: picked };
  if (picked.regions.length === 0) return { ok: false, message: `Draft: no picked face can be drafted. ${picked.skipped[0]?.reason ?? "Pick at least one flat face."}` };
  const overrides = new Map<number, PlaneLike>();
  const skipped = [...picked.skipped];
  for (const region of picked.regions) {
    const sideways = unit(sub(region.normal, scale(pull, dot(region.normal, pull))))!;
    const tilted: V3 = [sideways[0] * Math.cos(alpha) + pull[0] * Math.sin(alpha), sideways[1] * Math.cos(alpha) + pull[1] * Math.sin(alpha), sideways[2] * Math.cos(alpha) + pull[2] * Math.sin(alpha)];
    // A point on the line where the face's plane meets the neutral plane: it stays put as the face turns.
    const lineDirection = cross(region.normal, pull);
    const onLine = meetPoint([{ normal: region.normal, offset: region.offset }, { normal: pull, offset: neutralOffset }, { normal: unit(lineDirection)!, offset: dot(unit(lineDirection)!, spec.neutralPointMm) }], spec.neutralPointMm);
    overrides.set(region.id, { normal: tilted, offset: dot(tilted, onLine) });
  }
  const moved = movePlanes(mesh, analysis, overrides);
  if (!moved.ok) return { ok: false, message: `Draft: ${moved.message}` };
  return withMesh(moved.positionsMm, mesh.indices, [`Drafted ${picked.regions.length} face${picked.regions.length === 1 ? "" : "s"} by ${spec.angleDeg}°${skipped.length === 0 ? "" : `; ${skipped.length} picked face${skipped.length === 1 ? "" : "s"} could not be drafted`}.`], skipped);
}

// ---------------------------------------------------------------------------------------------
// Offset region and Replace face
// ---------------------------------------------------------------------------------------------

export interface OffsetRegionSpec {
  readonly distanceMm: number;
  readonly faces: readonly FaceRefLike[];
}

/**
 * Moves each picked flat face (with all the faces coplanar to it that touch it, which is one region) along its outward
 * direction by `distanceMm`. The faces around it stretch or shrink to follow, and no face that was not picked changes plane.
 */
export function offsetRegion(mesh: MeshLike, spec: OffsetRegionSpec): FaceEditResult {
  if (!Number.isFinite(spec.distanceMm) || spec.distanceMm === 0) return { ok: false, message: "The offset distance must be a non-zero length." };
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return { ok: false, message: analysis };
  const picked = pick(mesh, analysis, spec.faces, "An offset face", () => undefined);
  if (typeof picked === "string") return { ok: false, message: picked };
  if (picked.skipped.length > 0) return { ok: false, message: `Offset region: ${picked.skipped[0]!.reason}` };
  const overrides = new Map<number, PlaneLike>();
  for (const region of picked.regions) overrides.set(region.id, { normal: region.normal, offset: region.offset + spec.distanceMm });
  const moved = movePlanes(mesh, analysis, overrides);
  if (!moved.ok) return { ok: false, message: `Offset region: ${moved.message}` };
  const triangles = picked.regions.reduce((sum, region) => sum + region.triangles.length, 0);
  return withMesh(moved.positionsMm, mesh.indices, [`Offset ${picked.regions.length} region${picked.regions.length === 1 ? "" : "s"} (${triangles} triangles) by ${spec.distanceMm} mm.`]);
}

export interface ReplaceFaceSpec {
  readonly faces: readonly FaceRefLike[];
  readonly toFace?: FaceRefLike | undefined;
  readonly toPlane?: FaceRefLike | undefined;
}

/**
 * Replaces the picked faces by the plane of another face (or a given plane): each one is tilted and moved until it lies on that
 * plane, and its neighbours follow. The replacement plane faces the same way as the face it replaces.
 */
export function replaceFaces(mesh: MeshLike, spec: ReplaceFaceSpec): FaceEditResult {
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return { ok: false, message: analysis };
  let target: PlaneLike;
  if (spec.toFace !== undefined) {
    const found = resolveFace(mesh, analysis, spec.toFace, "The face to replace with");
    if (!found.ok) return { ok: false, message: `Replace face: ${found.message}` };
    if (found.region.curved) return { ok: false, message: "Replace face: the face to replace with is curved; use a flat face or a plane." };
    target = { normal: found.region.normal, offset: found.region.offset };
  } else if (spec.toPlane !== undefined) {
    const normal = unit(spec.toPlane.normalMm);
    if (normal === undefined) return { ok: false, message: "Replace face: the plane has no direction." };
    target = { normal, offset: dot(normal, spec.toPlane.pointMm) };
  } else return { ok: false, message: "Replace face needs a face or a plane to replace with." };
  const picked = pick(mesh, analysis, spec.faces, "A face to replace", () => undefined);
  if (typeof picked === "string") return { ok: false, message: picked };
  if (picked.skipped.length > 0) return { ok: false, message: `Replace face: ${picked.skipped[0]!.reason}` };
  const overrides = new Map<number, PlaneLike>();
  let unchanged = 0;
  for (const region of picked.regions) {
    const facing = dot(region.normal, target.normal);
    if (Math.abs(facing) < 0.1) return { ok: false, message: "Replace face: the replacement plane is nearly square to the face, so the face would have to stand on edge." };
    const normal: V3 = facing < 0 ? scale(target.normal, -1) : target.normal;
    const offset = facing < 0 ? -target.offset : target.offset;
    if (dot(normal, region.normal) > 0.999999 && Math.abs(offset - region.offset) < 1e-6) { unchanged += 1; continue; }
    overrides.set(region.id, { normal, offset });
  }
  if (overrides.size === 0) return { ok: false, message: unchanged > 0 ? "Replace face: the face already lies on that plane." : "Replace face: no face was picked." };
  const moved = movePlanes(mesh, analysis, overrides);
  if (!moved.ok) return { ok: false, message: `Replace face: ${moved.message}` };
  return withMesh(moved.positionsMm, mesh.indices, [`Replaced ${overrides.size} face${overrides.size === 1 ? "" : "s"} by the chosen plane.`]);
}

/**
 * The border of each picked face as line segments, for outlining the picks in the viewport. A pick that matches no flat face
 * is left out.
 */
export function faceOutlineSegments(mesh: MeshLike, refs: readonly FaceRefLike[]): readonly (readonly [V3, V3])[] {
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return [];
  const segments: [V3, V3][] = [];
  for (const ref of refs) {
    const found = resolveFace(mesh, analysis, ref);
    if (!found.ok) continue;
    const used = new Map<string, { a: V3; b: V3; count: number }>();
    for (const t of found.region.triangles) {
      const corners = [0, 1, 2].map((k) => analysis.weld[mesh.indices[t * 3 + k]!]!);
      for (let k = 0; k < 3; k += 1) {
        const a = corners[k]!; const b = corners[(k + 1) % 3]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const entry = used.get(key);
        if (entry === undefined) used.set(key, { a: analysis.weldedPositions[a]!, b: analysis.weldedPositions[b]!, count: 1 });
        else entry.count += 1;
      }
    }
    for (const entry of used.values()) if (entry.count === 1) segments.push([entry.a, entry.b]);
  }
  return segments;
}
