import type { SketchEntity, Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { buildArrangement, interiorPointOf, PROFILE_GAP_TOLERANCE_MM, type Arrangement, type ArrangementCycle, type CycleStep } from "./arrangement.js";
import type { SketchProfile, SketchProfileBoundary, SketchProfileSegment } from "./index.js";

/**
 * Turns the faces of the planar arrangement into selectable profiles ("regions").
 *
 * A profile is one enclosed region: its outer boundary plus the boundaries of any islands inside it (`holes`). Profile ids
 * keep the old scheme wherever it still names the region (`profile:<entity>` for a whole primitive, `profile:loop-<hash>` for a
 * loop of whole curves) and use `profile:rg-<hash>` of the boundary pieces for regions cut out by splitting. Every profile also
 * carries a `ref`: its id plus a geometric signature (area, centroid, which holes it had), which is what a feature stores so it can
 * find its region again after the sketch is edited.
 */

const bare = (entityId: string): string => (entityId.startsWith("entity:") ? entityId.slice("entity:".length) : entityId);

export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function reversed(steps: readonly CycleStep[]): CycleStep[] {
  return [...steps].reverse().map((step) => ({ edge: step.edge, forward: !step.forward }));
}

function orientedPoints(step: CycleStep): readonly Vec2[] {
  return step.forward ? step.edge.points : [...step.edge.points].reverse();
}

function polygonOf(steps: readonly CycleStep[]): Vec2[] {
  const points: Vec2[] = [];
  for (const step of steps) {
    const sampled = orientedPoints(step);
    for (let index = 0; index + 1 < sampled.length; index += 1) points.push(sampled[index]!);
  }
  return points;
}

function areaOfSteps(steps: readonly CycleStep[]): number {
  let area2 = 0;
  for (const step of steps) area2 += step.forward ? step.edge.area2 : -step.edge.area2;
  return area2 / 2;
}

function centroidOf(points: readonly Vec2[], signedArea: number): Vec2 {
  if (Math.abs(signedArea) < 1e-12) return points[0] ?? [0, 0];
  // Shifted to the first point so a far-away sketch keeps its precision.
  const origin = points[0]!;
  let x = 0;
  let y = 0;
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const cx = current[0] - origin[0];
    const cy = current[1] - origin[1];
    const nx = next[0] - origin[0];
    const ny = next[1] - origin[1];
    const factor = cx * ny - nx * cy;
    x += (cx + nx) * factor;
    y += (cy + ny) * factor;
    twice += factor;
  }
  if (Math.abs(twice) < 1e-12) return origin;
  return [origin[0] + x / (3 * twice), origin[1] + y / (3 * twice)];
}

interface Loop {
  readonly id: string;
  readonly entityIds: readonly string[];
  readonly boundary: SketchProfileBoundary;
  readonly areaMm2: number;
  readonly centroid: Vec2;
  readonly points: readonly Vec2[];
}

/** Describes one counter-clockwise loop of edges: its boundary kind (exact for whole primitives), identity, area and centroid. */
function describeLoop(steps: readonly CycleStep[], entities: ReadonlyMap<string, SketchEntity>): Loop {
  const points = polygonOf(steps);
  const owners = steps.flatMap((step) => step.edge.owners);
  const entityIds = [...new Set(owners.map((owner) => owner.entityId))].sort();
  const areaPolygon = areaOfSteps(steps);

  // One rectangle: its four whole sides.
  if (steps.length === 4 && steps.every((step) => step.edge.whole)) {
    for (const candidate of entityIds) {
      const entity = entities.get(candidate);
      if (entity?.kind !== "rectangle") continue;
      const sides = new Set<number>();
      for (const step of steps) for (const owner of step.edge.owners) if (owner.entityId === candidate && owner.side >= 0) sides.add(owner.side);
      if (sides.size !== 4) continue;
      return {
        id: `profile:${bare(entity.id)}`, entityIds: [entity.id],
        boundary: { kind: "rectangle", center: entity.center, widthMm: entity.widthMm, heightMm: entity.heightMm, rotationDeg: entity.rotationDeg },
        areaMm2: entity.widthMm * entity.heightMm, centroid: entity.center, points
      };
    }
  }
  // One whole circle, ellipse or closed spline.
  if (steps.length === 1 && steps[0]!.edge.whole) {
    const edge = steps[0]!.edge;
    for (const owner of edge.owners) {
      const entity = entities.get(owner.entityId);
      if (entity === undefined) continue;
      if (entity.kind === "circle" && edge.curveKind === "circle") {
        return { id: `profile:${bare(entity.id)}`, entityIds: [entity.id], boundary: { kind: "circle", center: entity.center, radiusMm: entity.radiusMm }, areaMm2: Math.PI * entity.radiusMm ** 2, centroid: entity.center, points };
      }
      if (entity.kind === "ellipse" && edge.curveKind === "ellipse") {
        return {
          id: `profile:${bare(entity.id)}`, entityIds: [entity.id],
          boundary: { kind: "ellipse", center: entity.center, majorRadiusMm: entity.majorRadiusMm, minorRadiusMm: entity.minorRadiusMm, rotationDeg: entity.rotationDeg },
          areaMm2: Math.PI * entity.majorRadiusMm * entity.minorRadiusMm, centroid: entity.center, points
        };
      }
    }
  }
  const segments: SketchProfileSegment[] = steps.map((step) => {
    const owner = step.edge.owners[0]!;
    const kind: SketchProfileSegment["kind"] = step.edge.curveKind === "line" ? "line" : step.edge.curveKind === "spline" || step.edge.curveKind === "ellipse" ? "spline" : "arc";
    return { entityId: owner.entityId, kind, edgeCount: step.edge.points.length - 1, key: owner.key };
  });
  const allLines = segments.every((segment) => segment.kind === "line");
  const boundary: SketchProfileBoundary = allLines ? { kind: "line-loop", points } : { kind: "curve-loop", points, segments };
  let id: string;
  if (steps.every((step) => step.edge.whole)) {
    id = entityIds.length === 1 ? `profile:${bare(entityIds[0]!)}` : `profile:loop-${fnv1a(entityIds.join("|"))}`;
  } else {
    id = `profile:rg-${fnv1a([...new Set(owners.map((owner) => owner.key))].sort().join("|"))}`;
  }
  return { id, entityIds, boundary, areaMm2: Math.abs(areaPolygon), centroid: centroidOf(points, areaPolygon), points };
}

const fixed = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const MAX_REF_HOLES = 16;

/** The geometric reference a feature stores for a region: id, area, centroid and the holes it had. */
export function profileRefOf(profile: Pick<SketchProfile, "id" | "areaMm2" | "centroid"> & { readonly holes?: readonly Pick<SketchProfile, "id">[] }): string {
  const holes = profile.holes ?? [];
  const holeKeys = holes.length === 0 ? "0" : holes.length > MAX_REF_HOLES ? "all" : holes.map((hole) => fnv1a(hole.id).slice(0, 4)).sort().join(".");
  return `${profile.id}~a${fixed(profile.areaMm2)}~x${fixed(profile.centroid[0])}~y${fixed(profile.centroid[1])}~h${holeKeys}`;
}

export interface ParsedProfileRef {
  readonly id: string;
  /** Present when the reference carries a geometric signature. */
  readonly areaMm2?: number;
  readonly centroid?: Vec2;
  /** The holes the region had when the reference was made: 4-hex keys, "all", or empty for none. Absent for a bare id. */
  readonly holeKeys?: readonly string[] | "all";
}

export function parseProfileRef(ref: string): ParsedProfileRef {
  const parts = ref.split("~");
  const id = parts[0]!;
  if (parts.length < 5) return { id };
  const area = Number(parts[1]!.slice(1));
  const x = Number(parts[2]!.slice(1));
  const y = Number(parts[3]!.slice(1));
  if (parts[1]![0] !== "a" || parts[2]![0] !== "x" || parts[3]![0] !== "y" || parts[4]![0] !== "h" || ![area, x, y].every(Number.isFinite)) return { id };
  const holes = parts[4]!.slice(1);
  return { id, areaMm2: area, centroid: [x, y], holeKeys: holes === "all" ? "all" : holes === "0" || holes === "" ? [] : holes.split(".") };
}

export function holeKeyOf(holeId: string): string {
  return fnv1a(holeId).slice(0, 4);
}

/** The profiles of an arrangement, largest first. */
export function profilesOfArrangement(arrangement: Arrangement, sketchEntities: readonly SketchEntity[]): SketchProfile[] {
  const entities = new Map(sketchEntities.map((entity) => [entity.id, entity] as const));
  const profiles: SketchProfile[] = [];
  const seen = new Map<string, number>();
  for (const face of arrangement.faces) {
    const outer = describeLoop(face.outer.steps, entities);
    const holeLoops = face.holes.map((hole) => describeLoop(reversed(hole.steps), entities));
    // Holes ordered by size so ids and signatures do not depend on trace order.
    holeLoops.sort((left, right) => right.areaMm2 - left.areaMm2 || left.id.localeCompare(right.id));
    let net = outer.areaMm2;
    let cx = outer.centroid[0] * outer.areaMm2;
    let cy = outer.centroid[1] * outer.areaMm2;
    for (const hole of holeLoops) {
      net -= hole.areaMm2;
      cx -= hole.centroid[0] * hole.areaMm2;
      cy -= hole.centroid[1] * hole.areaMm2;
    }
    const centroid: Vec2 = holeLoops.length === 0 ? outer.centroid : net > 1e-12 ? [cx / net, cy / net] : outer.centroid;
    const holeProfiles: SketchProfile[] = holeLoops.map((hole) => holeProfile(hole));
    const interiorPoint = interiorPointOf(outer.points, holeLoops.map((hole) => hole.points));
    const count = seen.get(outer.id) ?? 0;
    seen.set(outer.id, count + 1);
    const id = count === 0 ? outer.id : `${outer.id}-${count + 1}`;
    const base = { id, entityIds: outer.entityIds, boundary: outer.boundary, areaMm2: net, centroid, interiorPoint };
    const profile: SketchProfile = { ...base, ...(holeProfiles.length === 0 ? {} : { holes: holeProfiles }), ref: profileRefOf({ ...base, holes: holeProfiles }) };
    profiles.push(profile);
  }
  return profiles.sort((left, right) => right.areaMm2 - left.areaMm2 || left.id.localeCompare(right.id));
}

function holeProfile(loop: Loop): SketchProfile {
  const base = { id: loop.id, entityIds: loop.entityIds, boundary: loop.boundary, areaMm2: loop.areaMm2, centroid: loop.centroid };
  return { ...base, interiorPoint: interiorPointOf(loop.points, []), ref: profileRefOf(base) };
}

export interface ProfileDetectionOptions {
  /** Curve ends closer than this are one joint. Defaults to the profile gap tolerance, or the sketch snap reach when that is smaller. */
  readonly gapToleranceMm?: number;
}

export function profileGapToleranceOf(sketch: Pick<WorkbenchSketch, "snapToleranceMm">, options: ProfileDetectionOptions = {}): number {
  if (options.gapToleranceMm !== undefined) return options.gapToleranceMm;
  const snap = Number.isFinite(sketch.snapToleranceMm) && sketch.snapToleranceMm > 0 ? sketch.snapToleranceMm : PROFILE_GAP_TOLERANCE_MM;
  return Math.min(PROFILE_GAP_TOLERANCE_MM, Math.max(snap, 1e-6));
}

/** Curves that take part in profile detection: visible and not construction. */
export function profileCurves(sketch: Pick<WorkbenchSketch, "entities">): readonly SketchEntity[] {
  return sketch.entities.filter((entity) => entity.visible !== false && !entity.construction && entity.kind !== "point");
}


export type { ArrangementCycle };
