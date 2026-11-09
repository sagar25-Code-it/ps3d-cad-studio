import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchEntity, SweepPathRef } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles, resolveProfileRegion, sampleArcToBound, sampleSplineToBound, type ProfileRegion } from "../../../packages/workbench-sketch/src/index.js";
import {
  loftProfiles, loopCentroid, pathStartFrame, placeDirection, resamplePath, solidMeshVolume, sweepAlongPath, sweepRigid, flipped,
  signedArea2, type Loops2, type Loops3, type SolidMesh, type V3
} from "../../../packages/workbench-geometry/src/index.js";
import { profilePolygonMm } from "./general-modeling.js";
import { datumKey, DATUM_PLANE_NORMAL, sketchToWorld, sketchWorldNormal } from "./sketch-world.js";

type Point2 = readonly [number, number];

export type SketchLookup = (featureId: string) => DesignSketchFeature | undefined;

export type SweepLoftOutcome =
  | { readonly ok: true; readonly body: GeneralSolidBody; readonly warning?: string }
  | { readonly ok: false; readonly message: string };

/**
 * Sweeps and lofts that need more than one plane or carry holes: a sweep along a chain of curves (from this sketch or another), a straight
 * sweep of a profile with holes, and a loft between sketches on different planes or of profiles with holes. Bodies come back in world
 * coordinates, already on their sketch planes, so the caller does not move them again.
 */

// ---------------------------------------------------------------------------------------------
// Chains of curves
// ---------------------------------------------------------------------------------------------

interface Piece {
  readonly id: string;
  readonly points: readonly Point2[];
}

function samplesOf(entity: SketchEntity): readonly Point2[] | undefined {
  if (entity.kind === "line") return [entity.start, entity.end];
  if (entity.kind === "arc") return sampleArcToBound(entity.start, entity.mid, entity.end);
  if (entity.kind === "spline") return sampleSplineToBound(entity.fitPoints);
  return undefined;
}

const gap = (a: Point2, b: Point2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Keeps at most `limit` evenly spaced points of a sampled piece, always the first and the last (a straight piece has only those two). */
function thinned(points: readonly Point2[], limit: number): readonly Point2[] {
  if (points.length <= limit || limit < 2) return points;
  const kept: Point2[] = [];
  for (let index = 0; index < limit; index += 1) kept.push(points[Math.round((index * (points.length - 1)) / (limit - 1))]!);
  return kept;
}

/** Chains pieces end to end starting from the first one, in the order given; returns the polyline or the first gap it could not close. */
function chainInOrder(pieces: readonly Piece[], toleranceMm: number): { readonly ok: true; readonly points: readonly Point2[] } | { readonly ok: false; readonly message: string } {
  const first = pieces[0]!;
  let points: Point2[] = [...first.points];
  if (pieces.length > 1) {
    const second = pieces[1]!;
    const ends = [first.points[0]!, first.points[first.points.length - 1]!];
    const nextEnds = [second.points[0]!, second.points[second.points.length - 1]!];
    // Orient the first piece so that its end is the one nearest the second piece.
    let best = Infinity;
    let reverse = false;
    for (const [firstIndex, end] of ends.entries()) for (const next of nextEnds) {
      const distance = gap(end, next);
      if (distance < best) { best = distance; reverse = firstIndex === 0; }
    }
    if (reverse) points.reverse();
  }
  for (let index = 1; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    const tail = points[points.length - 1]!;
    const head = piece.points[0]!;
    const foot = piece.points[piece.points.length - 1]!;
    const forward = gap(tail, head) <= gap(tail, foot);
    const distance = forward ? gap(tail, head) : gap(tail, foot);
    if (distance > toleranceMm) return { ok: false, message: `The sweep path is not connected: ${pieces[index - 1]!.id.replace(/^entity:/u, "")} and ${piece.id.replace(/^entity:/u, "")} are ${distance.toFixed(2)} mm apart. Join their ends (Coincident) or pick curves that touch.` };
    const oriented = forward ? piece.points : [...piece.points].reverse();
    points = [...points, ...oriented.slice(1)];
  }
  return { ok: true, points };
}

/** The curves of a sketch chained end to end (in the order given, or reordered to connect), as one polyline in sketch millimetres. */
export function chainSketchCurves(sketchFeature: DesignSketchFeature, entityIds: readonly string[], maxPointsPerPiece?: number): { readonly ok: true; readonly points: readonly Point2[] } | { readonly ok: false; readonly message: string } {
  const pieces: Piece[] = [];
  for (const id of entityIds) {
    const entity = sketchFeature.sketch.entities.find((candidate) => candidate.id === id);
    if (entity === undefined) return { ok: false, message: `The sweep path curve ${id.replace(/^entity:/u, "")} is no longer in ${sketchFeature.name}. Pick the path again.` };
    const samples = samplesOf(entity);
    if (samples === undefined || samples.length < 2) return { ok: false, message: `A sweep path is made of lines, arcs and splines; ${id.replace(/^entity:/u, "")} is a ${entity.kind}.` };
    pieces.push({ id, points: maxPointsPerPiece === undefined ? samples : thinned(samples, maxPointsPerPiece) });
  }
  if (pieces.length === 0) return { ok: false, message: "The sweep path has no curves." };
  const tolerance = Math.max(0.05, sketchFeature.sketch.snapToleranceMm);
  const ordered = chainInOrder(pieces, tolerance);
  if (ordered.ok || pieces.length < 3) return ordered;
  // The picks were not in order: try every piece as the start, always continuing with an unused piece that touches the end.
  for (const start of pieces) {
    for (const reversed of [false, true]) {
      const sequence: Piece[] = [{ id: start.id, points: reversed ? [...start.points].reverse() : start.points }];
      const used = new Set([start.id]);
      let tail = sequence[0]!.points[sequence[0]!.points.length - 1]!;
      for (;;) {
        const next = pieces.find((piece) => !used.has(piece.id) && (gap(tail, piece.points[0]!) <= tolerance || gap(tail, piece.points[piece.points.length - 1]!) <= tolerance));
        if (next === undefined) break;
        const forward = gap(tail, next.points[0]!) <= gap(tail, next.points[next.points.length - 1]!);
        const oriented = forward ? next.points : [...next.points].reverse();
        sequence.push({ id: next.id, points: oriented });
        used.add(next.id);
        tail = oriented[oriented.length - 1]!;
      }
      if (used.size === pieces.length) {
        const joined = chainInOrder(sequence, tolerance);
        if (joined.ok) return joined;
      }
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------------------------
// Profiles in the world
// ---------------------------------------------------------------------------------------------

function worldLoops(region: ProfileRegion, sketchFeature: DesignSketchFeature, lift = 0): Loops3 {
  const toWorld = (polygon: readonly Point2[]): V3[] => polygon.map(([x, y]) => sketchToWorld(sketchFeature.sketch, x, y, lift));
  return { outer: toWorld(profilePolygonMm(region.outer.boundary)), holes: region.holes.map((hole) => toWorld(profilePolygonMm(hole.boundary))) };
}

function bodyOf(feature: DesignSolidFeature, sketchFeature: DesignSketchFeature, mesh: SolidMesh, color: string): GeneralSolidBody {
  const outward = solidMeshVolume(mesh) >= 0 ? mesh : flipped(mesh);
  return {
    id: feature.bodyId, name: feature.name, visible: true, color,
    positionsMm: outward.positionsMm, indices: outward.indices,
    feature: { operation: feature.kind === "loft" ? "loft" : "sweep", plane: datumKey(sketchFeature.sketch), valueMm: feature.valueMm }
  };
}

const MAX_TRIANGLES = 99_000;
/** Triangles a sweep along a curved path may use before the path is sampled more coarsely (the mesh is stored as plain JSON). */
const SWEEP_TRIANGLE_BUDGET = 16_000;

function checked(mesh: SolidMesh, what: string): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (mesh.positionsMm.length / 3 > 99_000 || mesh.indices.length / 3 > MAX_TRIANGLES * 2) return { ok: false, message: `The ${what} has too many triangles to store. Use a shorter or simpler path or profile.` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------------------------

/** The path a sweep follows, if it has one: the new chained reference, or the single curve of the older form (always from the profile's own sketch). */
export function sweepPathOf(feature: DesignSolidFeature): SweepPathRef | undefined {
  if (feature.sweepPath !== undefined) return feature.sweepPath;
  return feature.sweepPathEntityId === undefined ? undefined : { sketchFeatureId: feature.sketchFeatureId, entityIds: [feature.sweepPathEntityId] };
}

/** Whether a sweep or loft needs the builders in this file (otherwise the classic single-sketch builders handle it). */
export function needsSweepLoftBuilder(feature: DesignSolidFeature, holeCount: number): boolean {
  if (feature.kind === "sweep") return sweepPathOf(feature) !== undefined || holeCount > 0;
  if (feature.kind === "loft") return feature.loftSecondarySketchFeatureId !== undefined || holeCount > 0;
  return false;
}

export async function buildSweepFeature(feature: DesignSolidFeature, sketchFeature: DesignSketchFeature, region: ProfileRegion, color: string, lookup: SketchLookup | undefined): Promise<SweepLoftOutcome> {
  const path = sweepPathOf(feature);
  const notes: string[] = [];
  if (path === undefined) {
    // A straight sweep of a profile with holes: the profile moves along the direction, keeping its orientation.
    if (feature.sweepDirectionMm === undefined) return { ok: false, message: "A sweep needs a direction vector or a path." };
    const direction = feature.sweepDirectionMm;
    const size = Math.hypot(direction[0], direction[1], direction[2]);
    if (size < 1e-6) return { ok: false, message: "The sweep direction must not be zero." };
    const normalDatum = DATUM_PLANE_NORMAL[datumKey(sketchFeature.sketch)];
    if (Math.abs(direction[0] * normalDatum[0] + direction[1] * normalDatum[1] + direction[2] * normalDatum[2]) / size < 1e-6) {
      return { ok: false, message: "The sweep direction is parallel to the sketch plane, which would flatten the solid. Give it a component off the plane." };
    }
    const shiftDatum: V3 = [direction[0] / size * Math.abs(feature.valueMm), direction[1] / size * Math.abs(feature.valueMm), direction[2] / size * Math.abs(feature.valueMm)];
    const built = sweepRigid({ loops: worldLoops(region, sketchFeature), normal: unitNormal(sketchFeature), shift: placeDirection(shiftDatum, sketchFeature.sketch), ...(feature.sweepTwistDeg === undefined ? {} : { twistDeg: feature.sweepTwistDeg }) });
    if (!built.ok) return built;
    const fit = checked(built.mesh, "sweep");
    if (!fit.ok) return fit;
    return { ok: true, body: bodyOf(feature, sketchFeature, built.mesh, color) };
  }

  const pathSketch = path.sketchFeatureId === sketchFeature.id ? sketchFeature : lookup?.(path.sketchFeatureId);
  if (pathSketch === undefined) return { ok: false, message: lookup === undefined ? "The sketch holding this sweep's path could not be reached from here." : "The sketch holding this sweep's path is no longer in the timeline. Pick the path again, or delete the sweep." };
  let chain = chainSketchCurves(pathSketch, path.entityIds);
  if (!chain.ok) return chain;
  // A long curved path sampled to the chord error bound can ask for more triangles than a stored mesh should carry (every station repeats
  // the whole section): thin each curve evenly, never below 12 points, until the sweep fits the budget.
  const sectionPoints = profilePolygonMm(region.outer.boundary).length + region.holes.reduce((total, hole) => total + profilePolygonMm(hole.boundary).length, 0);
  for (let limit = 256; limit >= 12 && (chain.points.length - 1) * sectionPoints * 2 > SWEEP_TRIANGLE_BUDGET; limit = Math.floor(limit / 2)) {
    const coarser = chainSketchCurves(pathSketch, path.entityIds, limit);
    if (!coarser.ok) break;
    chain = coarser;
  }
  let worldPath = chain.points.map(([x, y]) => sketchToWorld(pathSketch.sketch, x, y));
  const sameSketch = pathSketch.id === sketchFeature.id;
  // The sweep starts at the end of the path that is nearer the profile.
  const profileCentre = centroid3(worldLoops(region, sketchFeature).outer);
  if (dist3(worldPath[0]!, profileCentre) > dist3(worldPath[worldPath.length - 1]!, profileCentre) + 1e-9) worldPath = [...worldPath].reverse();
  const t0 = pathStartFrame(worldPath, [1, 0, 0]);
  if (t0 === undefined) return { ok: false, message: "The sweep path has no length." };
  let startU: V3;
  let loops: Loops2;
  const outline2 = profilePolygonMm(region.outer.boundary);
  if (sameSketch) {
    // The profile and its path are drawn on one plane: the profile is taken as the cross-section at the path's start, turned to face along
    // the path (its x across the path in the sketch plane, its y out of the plane) and centred on its own centroid.
    const normal = unitNormal(sketchFeature);
    startU = cross3(normal, t0.tangent);
    const centre = loopCentroid(outline2);
    const shift = (polygon: readonly Point2[]): Point2[] => polygon.map(([x, y]) => [x - centre[0], y - centre[1]]);
    loops = { outer: shift(outline2), holes: region.holes.map((hole) => shift(profilePolygonMm(hole.boundary))) };
    // The cross-section sits on the path's start point.
    notes.push("The profile and the path are in one sketch, so the profile is swept as the cross-section at the start of the path (centred on its centroid).");
    const frame = pathStartFrame(worldPath, startU);
    if (frame === undefined) return { ok: false, message: "The sweep path is perpendicular to its own sketch plane at the start, which leaves no direction for the profile. Draw the path in the sketch plane." };
  } else {
    const origin = worldPath[0]!;
    startU = sub3(sketchToWorld(sketchFeature.sketch, 1, 0), sketchToWorld(sketchFeature.sketch, 0, 0));
    const frame = pathStartFrame(worldPath, startU)!;
    const normal = unitNormal(sketchFeature);
    if (Math.abs(dot3(normal, frame.tangent)) < 0.95) notes.push("The profile's plane is not perpendicular to the start of the path; the sweep section is taken perpendicular to the path.");
    const local = (point: V3): Point2 => [dot3(sub3(point, origin), frame.u), dot3(sub3(point, origin), frame.v)];
    const world = worldLoops(region, sketchFeature);
    loops = { outer: world.outer.map(local), holes: world.holes.map((hole) => hole.map(local)) };
    startU = frame.u;
    const trueArea = Math.hypot(...newell(world.outer)) / 2;
    if (Math.abs(signedArea2(loops.outer)) < 0.2 * trueArea) {
      return { ok: false, message: "The profile's plane is almost parallel to the start of the path, so the sweep section would be flattened. Draw the profile on a plane that crosses the path, ideally at right angles to it." };
    }
  }
  const built = sweepAlongPath({ loops, path: worldPath, startU, ...(feature.sweepTwistDeg === undefined ? {} : { twistDeg: feature.sweepTwistDeg }) });
  if (!built.ok) return built;
  const fit = checked(built.mesh, "sweep");
  if (!fit.ok) return fit;
  const warning = [...notes.filter((note) => !note.startsWith("The profile and the path are in one sketch")), ...built.notes].join(" ");
  return { ok: true, body: bodyOf(feature, sketchFeature, built.mesh, color), ...(warning === "" ? {} : { warning }) };
}

// ---------------------------------------------------------------------------------------------
// Loft
// ---------------------------------------------------------------------------------------------

export async function buildLoftFeature(feature: DesignSolidFeature, sketchFeature: DesignSketchFeature, region: ProfileRegion, color: string, lookup: SketchLookup | undefined): Promise<SweepLoftOutcome> {
  const from = worldLoops(region, sketchFeature);
  let to: Loops3;
  let rail: readonly V3[] | undefined;
  const secondaryIds = feature.loftSecondaryProfileIds ?? [];
  if (secondaryIds.length > 0) {
    const otherId = feature.loftSecondarySketchFeatureId;
    const other = otherId === undefined || otherId === sketchFeature.id ? sketchFeature : lookup?.(otherId);
    if (other === undefined) return { ok: false, message: lookup === undefined ? "The sketch holding this loft's second profile could not be reached from here." : "The sketch holding this loft's second profile is no longer in the timeline. Pick the profile again, or delete the loft." };
    const profiles = detectSketchProfiles(other.sketch);
    const missing = secondaryIds.find((id) => !profiles.some((profile) => profile.id === id));
    if (missing !== undefined) return { ok: false, message: `The second profile of this loft no longer exists in ${other.name}. Edit that sketch to close it again, or delete the loft.` };
    const resolved = resolveProfileRegion(profiles, secondaryIds, { includeIslands: region.holes.length > 0 });
    if (!resolved.ok) return { ok: false, message: resolved.diagnostics[0]?.message ?? "The second profile of the loft is not usable." };
    // A second profile in the profile's own sketch stands the distance `valueMm` above it; one in another sketch is where its plane puts it.
    to = worldLoops(resolved.value, other, other.id === sketchFeature.id ? Math.abs(feature.valueMm) : 0);
  } else {
    const scale = feature.loftTopScale;
    if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return { ok: false, message: "Loft needs a positive top scale or a second profile." };
    const outline = profilePolygonMm(region.outer.boundary);
    const centre = loopCentroid(outline);
    const lift = Math.abs(feature.valueMm);
    const scaled = (polygon: readonly Point2[]): V3[] => polygon.map(([x, y]) => sketchToWorld(sketchFeature.sketch, centre[0] + (x - centre[0]) * scale, centre[1] + (y - centre[1]) * scale, lift));
    to = { outer: scaled(outline), holes: region.holes.map((hole) => scaled(profilePolygonMm(hole.boundary))) };
  }
  if (feature.loftRailEntityId !== undefined) {
    const entity = sketchFeature.sketch.entities.find((candidate) => candidate.id === feature.loftRailEntityId);
    const samples = entity === undefined ? undefined : samplesOf(entity);
    if (samples !== undefined && samples.length >= 2) {
      const rings = 12;
      const lift = Math.abs(feature.valueMm);
      rail = resamplePath(samples, rings).map(([x, y], index) => sketchToWorld(sketchFeature.sketch, x, y, (lift * index) / (rings - 1)));
    }
  }
  const built = loftProfiles({
    from, to, continuity: feature.loftContinuity ?? "position",
    ...(feature.loftTangencyWeight === undefined ? {} : { tangencyWeight: feature.loftTangencyWeight }),
    ...(rail === undefined ? {} : { rail })
  });
  if (!built.ok) return built;
  const fit = checked(built.mesh, "loft");
  if (!fit.ok) return fit;
  return { ok: true, body: bodyOf(feature, sketchFeature, built.mesh, color) };
}

function unitNormal(sketchFeature: DesignSketchFeature): V3 {
  const normal = sketchWorldNormal(sketchFeature.sketch);
  const size = Math.hypot(normal[0], normal[1], normal[2]);
  return [normal[0] / size, normal[1] / size, normal[2] / size];
}

function centroid3(points: readonly V3[]): V3 {
  const sum = points.reduce<V3>((total, p) => [total[0] + p[0], total[1] + p[1], total[2] + p[2]], [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}
const dist3 = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function newell(points: readonly V3[]): V3 {
  let nx = 0; let ny = 0; let nz = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
