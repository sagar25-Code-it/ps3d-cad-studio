import { failure, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import { pointInRing } from "./arrangement.js";
import type { SketchProfile, SketchProfileBoundary, SketchProfileSegment } from "./index.js";
import { profileOutlineMm } from "./profile-outline.js";
import { shapesOf } from "./profile-detect.js";
import { fnv1a, holeKeyOf, parseProfileRef, profileBaseOf } from "./profile-regions.js";

/**
 * Turns a profile selection into the solid-ready region: one or more groups, each an outer outline with the holes cut through it.
 *
 * Two ways to name a profile, because there are two things a person can mean:
 *  - A bare id (`profile:rect`, an id from `detectSketchProfiles`) means the closed outline *as drawn*, with the outlines inside it
 *    as holes (and islands inside the holes). An empty selection means the largest outline. This is what an older feature stored.
 *  - A reference (`profile.ref`, id plus signature) names an exact *region*: the face of the arrangement, with the holes it had
 *    when it was picked. Faces next to each other merge, so a ring and the disc in its hole together are the full plate. Nothing
 *    is added automatically, and the reference finds its region again after the sketch is edited.
 */

export interface ProfileRegionGroup {
  readonly outer: SketchProfile;
  /** Profiles that become holes through the outer profile, largest first. */
  readonly holes: readonly SketchProfile[];
}

export interface ProfileRegion {
  /** The first (largest) group's outer profile and holes, kept for single-region callers. */
  readonly outer: SketchProfile;
  readonly holes: readonly SketchProfile[];
  /** Every disjoint piece of the selection: separate bosses, or an island standing in a hole. The first entry is `outer` and `holes`. */
  readonly groups: readonly ProfileRegionGroup[];
  /** Things worth saying that did not stop the build: a curve that crosses the outline and was left out, a hole that touches it. */
  readonly warnings: readonly string[];
}

const TOLERANCE_MM = 0.01;

// ---------------------------------------------------------------------------------------------
// Rings and how they relate
// ---------------------------------------------------------------------------------------------

interface Ring {
  readonly points: readonly Vec2[];
  readonly box: readonly [number, number, number, number];
  readonly area: number;
}

const ringCache = new WeakMap<SketchProfile, Ring>();

function ringOf(profile: SketchProfile): Ring {
  const cached = ringCache.get(profile);
  if (cached !== undefined) return cached;
  const points = profileOutlineMm(profile.boundary);
  const ring = makeRing(points);
  ringCache.set(profile, ring);
  return ring;
}

function makeRing(points: readonly Vec2[]): Ring {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const p = points[index]!;
    const q = points[(index + 1) % points.length]!;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return { points, box: [minX, minY, maxX, maxY], area: Math.abs(twice) / 2 };
}

function grossArea(profile: SketchProfile): number {
  return ringOf(profile).area;
}

function distanceToRing(point: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[previous]!;
    const b = ring[index]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const w = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    const d = Math.hypot(point[0] - (a[0] + dx * w), point[1] - (a[1] + dy * w));
    if (d < best) best = d;
  }
  return best;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const o2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  const o3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
  const o4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

type Relation = "disjoint" | "inside" | "contains" | "cross" | "same";

interface Related {
  readonly relation: Relation;
  /** The outlines share a point or a stretch (a hole tangent to the edge, two regions side by side). */
  readonly touching: boolean;
}

/** How ring `b` sits relative to ring `a`: inside it, containing it, crossing it, the same, or apart. */
function relate(a: Ring, b: Ring): Related {
  const margin = TOLERANCE_MM;
  if (b.box[0] > a.box[2] + margin || a.box[0] > b.box[2] + margin || b.box[1] > a.box[3] + margin || a.box[1] > b.box[3] + margin) return { relation: "disjoint", touching: false };
  const classify = (points: readonly Vec2[], against: Ring): { inside: number; on: number; outside: number } => {
    let inside = 0;
    let on = 0;
    let outside = 0;
    for (const point of points) {
      if (point[0] < against.box[0] - margin || point[0] > against.box[2] + margin || point[1] < against.box[1] - margin || point[1] > against.box[3] + margin) { outside += 1; continue; }
      if (distanceToRing(point, against.points) <= margin) on += 1;
      else if (pointInRing(point, against.points)) inside += 1;
      else outside += 1;
    }
    return { inside, on, outside };
  };
  const bIn = classify(b.points, a);
  const aIn = classify(a.points, b);
  const touching = bIn.on > 0 || aIn.on > 0;
  if (bIn.inside > 0 && bIn.outside > 0) return { relation: "cross", touching };
  if (aIn.inside > 0 && aIn.outside > 0) return { relation: "cross", touching };
  if (bIn.inside > 0) return { relation: "inside", touching };
  if (aIn.inside > 0) return { relation: "contains", touching };
  if (bIn.on === b.points.length && aIn.on === a.points.length) return { relation: "same", touching: true };
  if (bIn.on > 0 && bIn.outside === 0 && bIn.inside === 0 && aIn.outside > 0) return { relation: "disjoint", touching: true };
  // No vertex of either is inside the other: the outlines can still cross (a plus sign of two bars).
  for (let i = 0; i < a.points.length; i += 1) {
    const a0 = a.points[i]!;
    const a1 = a.points[(i + 1) % a.points.length]!;
    for (let j = 0; j < b.points.length; j += 1) {
      if (segmentsCross(a0, a1, b.points[j]!, b.points[(j + 1) % b.points.length]!)) return { relation: "cross", touching };
    }
  }
  return { relation: "disjoint", touching };
}

const shortId = (id: string): string => {
  const bare = profileBaseOf(id).replace(/^profile:/u, "").replace(/^entity:/u, "");
  return bare.length > 18 ? `${bare.slice(0, 12)}…` : bare;
};

// ---------------------------------------------------------------------------------------------
// Finding the profile a stored reference means
// ---------------------------------------------------------------------------------------------

export interface MatchedProfile {
  readonly profile: SketchProfile;
  /** The id still names a profile ("id"), only its loop name does ("name": the curves were moved or resized), or the region was found by its geometry. */
  readonly how: "id" | "name" | "geometry";
}

/** The area and centroid of a profile's outline, read from its id (the same numbers a stored reference carries). */
function outlineSignature(profile: SketchProfile): { readonly areaMm2: number; readonly centroid: Vec2 } {
  const parsed = parseProfileRef(profile.id);
  if (parsed.areaMm2 !== undefined && parsed.centroid !== undefined) return { areaMm2: parsed.areaMm2, centroid: parsed.centroid };
  return { areaMm2: profile.areaMm2 + (profile.holes ?? []).reduce((total, hole) => total + hole.areaMm2, 0), centroid: profile.centroid };
}

/**
 * Finds the region a stored id or reference means among the current profiles. In order of trust:
 *  1. the same id (nothing about the region changed);
 *  2. the same loop name (the curves that bound it were moved or resized: the id carries the entities, not the size);
 *  3. the region whose outline area and centroid are closest to the signature in the id (a fillet, chamfer, split or trim replaces the
 *     curves and so the name, but hardly the region).
 * Returns undefined when nothing fits well enough, so a lost region is reported instead of guessed.
 */
export function matchProfileRef(ref: string, profiles: readonly SketchProfile[], useGeometry = true): MatchedProfile | undefined {
  const parsed = parseProfileRef(ref);
  const byId = profiles.find((profile) => profile.id === parsed.id);
  if (byId !== undefined) return { profile: byId, how: "id" };
  const wantedArea = parsed.areaMm2;
  const wantedCentroid = parsed.centroid;
  const sameName = profiles.filter((profile) => profileBaseOf(profile.id) === parsed.base);
  if (sameName.length === 1) return { profile: sameName[0]!, how: "name" };
  if (!useGeometry && sameName.length === 0) return undefined;
  if (wantedArea === undefined || wantedCentroid === undefined || wantedArea <= 0) return sameName.length > 1 ? { profile: sameName.sort((left, right) => right.areaMm2 - left.areaMm2)[0]!, how: "name" } : undefined;
  const size = Math.sqrt(wantedArea);
  const scored = (sameName.length > 1 ? sameName : profiles)
    .map((profile) => {
      const signature = outlineSignature(profile);
      const ratio = signature.areaMm2 / wantedArea;
      const offset = Math.hypot(signature.centroid[0] - wantedCentroid[0], signature.centroid[1] - wantedCentroid[1]);
      return { profile, ratio, offset, score: offset / size + Math.abs(Math.log(Math.max(ratio, 1e-9))) };
    })
    .filter((item) => item.ratio >= 0.4 && item.ratio <= 2.5 && item.offset <= 0.35 * size)
    .sort((left, right) => left.score - right.score);
  const best = scored[0];
  if (best === undefined) return undefined;
  const second = scored[1];
  if (second !== undefined && second.score < best.score * 1.5 && best.score > 0.05) return undefined;
  return { profile: best.profile, how: "geometry" };
}


// ---------------------------------------------------------------------------------------------
// Resolving a selection
// ---------------------------------------------------------------------------------------------

interface ExactPick {
  readonly profile: SketchProfile;
  /** Which of the region's holes are kept as holes; the rest are filled. */
  readonly keep: "all" | ReadonlySet<string>;
}

export function resolveProfileRegion(
  profiles: readonly SketchProfile[],
  selectedIds: readonly string[],
  options: { readonly includeIslands: boolean }
): WorkbenchResult<ProfileRegion> {
  if (profiles.length === 0) return failure("INVALID_OPERATION", "Draw or select a closed profile first.", [], "Draw a closed profile in the sketch.");
  const unique = [...new Set(selectedIds)];
  const shapes = shapesOf(profiles);
  const exact: ExactPick[] = [];
  const outlines: SketchProfile[] = [];
  const pins = new Map<SketchProfile, readonly string[] | "all">();
  for (const id of unique) {
    const parsed = parseProfileRef(id);
    // The profile the id names: the region of that name, else (for a plain id) the drawn shape of that name -- a rectangle a circle crosses
    // is one shape but several regions -- else the region whose outline is closest to the signature in the id.
    const found = matchProfileRef(id, profiles, false)
      ?? (parsed.exact || shapes === undefined ? undefined : matchProfileRef(id, shapes, false))
      ?? matchProfileRef(id, profiles);
    if (found === undefined) return missing(id);
    if (parsed.exact) {
      const holes = found.profile.holes ?? [];
      let keep: "all" | Set<string>;
      if (parsed.holeKeys === "all" || parsed.holeKeys === undefined) keep = "all";
      else {
        const keys = new Set(parsed.holeKeys);
        // A region found again by geometry may have had its hole redrawn; as many holes as before are the same holes.
        keep = found.how === "geometry" && holes.length === keys.size ? "all" : new Set(holes.map((hole) => holeKeyOf(hole.id)).filter((key) => keys.has(key)));
      }
      exact.push({ profile: found.profile, keep });
    } else {
      outlines.push(found.profile);
      if (parsed.holeKeys !== undefined) pins.set(found.profile, parsed.holeKeys);
    }
  }
  if (exact.length > 0) {
    // Plain ids mixed into a reference selection are regions with all their holes.
    for (const profile of outlines) exact.push({ profile, keep: "all" });
    return unionRegion(profiles, exact, options.includeIslands);
  }
  return outlineRegion(profiles, shapes ?? profiles, outlines, options.includeIslands, pins);
}

function missing(id: string): WorkbenchResult<never> {
  return failure("INVALID_OPERATION", `The selected profile ${shortId(id)} no longer exists in the sketch.`, [id], "Select the profile again, or restore the curves that bounded it.");
}

// ---------------------------------------------------------------------------------------------
// Outline mode: bare ids and the empty selection
// ---------------------------------------------------------------------------------------------

function outlineRegion(profiles: readonly SketchProfile[], universe: readonly SketchProfile[], picked: readonly SketchProfile[], includeIslands: boolean, pins: ReadonlyMap<SketchProfile, readonly string[] | "all"> = new Map()): WorkbenchResult<ProfileRegion> {
  const warnings: string[] = [];
  const roots = picked.length > 0 ? [...picked].sort((left, right) => grossArea(right) - grossArea(left)) : [pickLargest(universe.length > 0 ? universe : profiles)];
  const rootRings = roots.map((root) => ringOf(root));
  const everything = universe.length > 0 ? universe : profiles;

  // Several picks: the nesting of the picks decides what is outer, hole or island; outlines that cross are refused.
  if (roots.length > 1) {
    const parent: number[] = roots.map(() => -1);
    for (let i = 0; i < roots.length; i += 1) {
      for (let j = i + 1; j < roots.length; j += 1) {
        const related = relate(rootRings[i]!, rootRings[j]!);
        if (related.relation === "cross") {
          return failure("INVALID_OPERATION", `The selected profiles ${shortId(roots[i]!.id)} and ${shortId(roots[j]!.id)} overlap: their outlines cross, so they cannot be one region.`, [...roots[i]!.entityIds, ...roots[j]!.entityIds], "Select regions that do not overlap, or split the shapes at their intersection first (Break at intersections) and pick the pieces.");
        }
        if (related.relation === "same") { warnings.push(`${shortId(roots[j]!.id)} lies exactly on ${shortId(roots[i]!.id)}; the duplicate was ignored.`); parent[j] = -2; continue; }
        if (related.relation === "inside" && parent[j] !== -2) {
          if (parent[j] === -1 || grossArea(roots[parent[j]!]!) > grossArea(roots[i]!)) parent[j] = i;
        }
      }
    }
    const depth = (index: number): number => (parent[index] === -2 ? -1 : parent[index]! < 0 ? 0 : depth(parent[index]!) + 1);
    const groups: { outer: SketchProfile; holes: SketchProfile[] }[] = [];
    const groupOf = new Map<number, { outer: SketchProfile; holes: SketchProfile[] }>();
    roots.forEach((root, index) => {
      const d = depth(index);
      if (d < 0 || d % 2 === 1) return;
      const group = { outer: root, holes: [] as SketchProfile[] };
      groupOf.set(index, group);
      groups.push(group);
    });
    roots.forEach((root, index) => {
      const d = depth(index);
      if (d < 0 || d % 2 === 0) return;
      groupOf.get(parent[index]!)?.holes.push(root);
    });
    return finish(groups, warnings);
  }

  const root = roots[0]!;
  const groups: { outer: SketchProfile; holes: SketchProfile[] }[] = [];
  if (!includeIslands) return finish([{ outer: root, holes: [] }], warnings);

  // One outline: the outlines drawn inside it are holes, the ones inside those are islands, and so on.
  const rootRing = rootRings[0]!;
  const inside: { profile: SketchProfile; ring: Ring }[] = [];
  for (const candidate of everything) {
    if (candidate === root || candidate.id === root.id) continue;
    const ring = ringOf(candidate);
    if (ring.area >= rootRing.area * (1 - 1e-9)) {
      if (ring.area > rootRing.area * (1 + 1e-9)) continue;
    }
    const related = relate(rootRing, ring);
    if (related.relation === "inside") {
      inside.push({ profile: candidate, ring });
      if (related.touching) warnings.push(`${describe(candidate)} touches the outline of ${shortId(root.id)}; it is kept as a hole, but a hole that touches the edge leaves a zero-width wall. Move it inward or dimension it clear of the edge.`);
    } else if (related.relation === "cross") {
      warnings.push(`${describe(candidate)} crosses the outline of ${shortId(root.id)}, so it is not a hole and was left out. Select the regions you want (the pieces on either side of the crossing), or move it clear.`);
    } else if (related.relation === "same") {
      warnings.push(`${describe(candidate)} lies exactly on the outline of ${shortId(root.id)} and was ignored.`);
    }
  }
  // Two identical outlines drawn on top of each other are one hole.
  for (let index = inside.length - 1; index >= 0; index -= 1) {
    const item = inside[index]!;
    if (inside.slice(0, index).some((other) => Math.abs(other.ring.area - item.ring.area) <= 1e-6 * (1 + item.ring.area) && relate(other.ring, item.ring).relation === "same")) inside.splice(index, 1);
  }
  // Holes that overlap each other are one void: build the region from the faces instead of from the outlines.
  const overlappingHoles = inside.some((item, index) => inside.slice(index + 1).some((other) => relate(item.ring, other.ring).relation === "cross"));
  if (overlappingHoles && profiles.every((profile) => profile.interiorPoint !== undefined)) {
    const merged = regionFromFaces(profiles, everything, root, rootRing);
    if (merged !== undefined) return merged.ok ? { ok: true, value: { ...merged.value, warnings: [...warnings, ...merged.value.warnings] } } : merged;
  }
  const parentOf = new Map<SketchProfile, SketchProfile | undefined>();
  for (const item of inside) {
    let best: { profile: SketchProfile; area: number } | undefined;
    for (const other of inside) {
      if (other === item || other.ring.area <= item.ring.area) continue;
      const related = relate(other.ring, item.ring);
      if (related.relation === "inside" && (best === undefined || other.ring.area < best.area)) best = { profile: other.profile, area: other.ring.area };
    }
    parentOf.set(item.profile, best?.profile);
  }
  // An id pins the holes the region had when it was made; outlines drawn inside it since are left out (they are for a later feature).
  const pin = pins.get(root);
  if (pin !== undefined && pin !== "all") {
    const allowed = new Set(pin);
    const topOf = (profile: SketchProfile): SketchProfile => {
      let current = profile;
      for (let next = parentOf.get(current); next !== undefined; next = parentOf.get(current)) current = next;
      return current;
    };
    for (let index = inside.length - 1; index >= 0; index -= 1) {
      if (!allowed.has(holeKeyOf(topOf(inside[index]!.profile).id))) inside.splice(index, 1);
    }
  }
  const place = (outer: SketchProfile, depth: number): void => {
    const group = { outer, holes: [] as SketchProfile[] };
    groups.push(group);
    const children = inside.filter((item) => parentOf.get(item.profile) === (outer === root ? undefined : outer)).map((item) => item.profile);
    const direct = outer === root ? children : children;
    for (const child of direct.sort((left, right) => grossArea(right) - grossArea(left))) {
      group.holes.push(child);
      const grandchildren = inside.filter((item) => parentOf.get(item.profile) === child).map((item) => item.profile);
      for (const island of grandchildren.sort((left, right) => grossArea(right) - grossArea(left))) place(island, depth + 2);
    }
  };
  place(root, 0);
  return finish(groups, [...warnings, ...touchWarnings(groups, false)]);
}

function pickLargest(profiles: readonly SketchProfile[]): SketchProfile {
  let best = profiles[0]!;
  let bestArea = grossArea(best);
  for (const profile of profiles) {
    const area = grossArea(profile);
    if (area > bestArea + 1e-9) { best = profile; bestArea = area; }
  }
  return best;
}

function describe(profile: SketchProfile): string {
  const kind = profile.boundary.kind === "circle" ? "The circle" : profile.boundary.kind === "rectangle" ? "The rectangle" : profile.boundary.kind === "ellipse" ? "The ellipse" : "The outline";
  return `${kind} ${shortId(profile.entityIds[0] ?? profile.id)}`;
}

function finish(groups: readonly { outer: SketchProfile; holes: readonly SketchProfile[] }[], warnings: readonly string[]): WorkbenchResult<ProfileRegion> {
  const ordered = [...groups].sort((left, right) => grossArea(right.outer) - grossArea(left.outer));
  const first = ordered[0]!;
  return { ok: true, value: { outer: first.outer, holes: first.holes, groups: ordered, warnings } };
}

// ---------------------------------------------------------------------------------------------
// Region mode: exact references, merged faces
// ---------------------------------------------------------------------------------------------

class PointRegistry {
  private readonly cells = new Map<string, number>();
  readonly points: Vec2[] = [];
  private readonly cell = 1e-5;
  id(point: Vec2): number {
    const cx = Math.floor(point[0] / this.cell);
    const cy = Math.floor(point[1] / this.cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const found = this.cells.get(`${cx + dx},${cy + dy}`);
        if (found !== undefined && Math.hypot(this.points[found]![0] - point[0], this.points[found]![1] - point[1]) <= 2e-6) return found;
      }
    }
    const id = this.points.length;
    this.points.push(point);
    this.cells.set(`${cx},${cy}`, id);
    return id;
  }
}

interface EdgeInfo {
  readonly kind: SketchProfileSegment["kind"];
  readonly entityId: string;
  readonly key: string;
}

interface DirectedEdge {
  readonly from: number;
  readonly to: number;
  readonly info: EdgeInfo;
  cancelled: boolean;
}

/** One entry per ring edge describing which curve it came from. */
function edgeInfos(profile: SketchProfile, boundary: SketchProfileBoundary, count: number): EdgeInfo[] {
  const owner = profile.entityIds[0] ?? profile.id;
  if (boundary.kind === "curve-loop") {
    const infos: EdgeInfo[] = [];
    for (const segment of boundary.segments) for (let index = 0; index < segment.edgeCount; index += 1) infos.push({ kind: segment.kind, entityId: segment.entityId, key: segment.key ?? segment.entityId });
    return infos;
  }
  if (boundary.kind === "circle") return Array.from({ length: count }, () => ({ kind: "arc" as const, entityId: owner, key: owner }));
  if (boundary.kind === "ellipse") return Array.from({ length: count }, () => ({ kind: "spline" as const, entityId: owner, key: owner }));
  if (boundary.kind === "rectangle") return Array.from({ length: count }, (_, index) => ({ kind: "line" as const, entityId: owner, key: `${owner}/s${index}` }));
  return Array.from({ length: count }, (_, index) => ({ kind: "line" as const, entityId: owner, key: `${profile.id}/e${index}` }));
}

function unionRegion(universe: readonly SketchProfile[], picks: readonly ExactPick[], includeIslands: boolean): WorkbenchResult<ProfileRegion> {
  const warnings: string[] = [];
  const included = new Map<string, SketchProfile>();
  for (const pick of picks) included.set(pick.profile.id, pick.profile);
  // A hole that is not kept is filled with every face inside it.
  for (const pick of picks) {
    for (const hole of pick.profile.holes ?? []) {
      const kept = includeIslands && (pick.keep === "all" || pick.keep.has(holeKeyOf(hole.id)));
      if (kept) continue;
      const ring = ringOf(hole);
      for (const face of universe) {
        if (included.has(face.id) || face.interiorPoint === undefined) continue;
        const point = face.interiorPoint;
        if (point[0] < ring.box[0] || point[0] > ring.box[2] || point[1] < ring.box[1] || point[1] > ring.box[3]) continue;
        if (pointInRing(point, ring.points)) included.set(face.id, face);
      }
    }
  }
  const registry = new PointRegistry();
  const edges: DirectedEdge[] = [];
  const outgoing = new Map<number, DirectedEdge[]>();
  const incoming = new Map<string, DirectedEdge[]>();
  const add = (from: number, to: number, info: EdgeInfo): void => {
    if (from === to) return;
    const edge: DirectedEdge = { from, to, info, cancelled: false };
    const opposite = incoming.get(`${to}>${from}`)?.find((candidate) => !candidate.cancelled);
    if (opposite !== undefined) { opposite.cancelled = true; return; }
    edges.push(edge);
    const list = outgoing.get(from);
    if (list === undefined) outgoing.set(from, [edge]); else list.push(edge);
    const key = `${from}>${to}`;
    const inList = incoming.get(key);
    if (inList === undefined) incoming.set(key, [edge]); else inList.push(edge);
  };
  // Every ring (an outline or a hole of an included face) and the edges it contributed, so a ring that no neighbour cancelled can be kept whole.
  const rings: { readonly ids: number[]; readonly infos: EdgeInfo[]; readonly reverse: boolean; readonly edges: (DirectedEdge | undefined)[] }[] = [];
  const ringEdges = (profile: SketchProfile, boundary: SketchProfileBoundary, reverse: boolean): void => {
    const points = profileOutlineMm(boundary);
    const infos = edgeInfos(profile, boundary, points.length);
    const ids = points.map((point) => registry.id(point));
    const own: (DirectedEdge | undefined)[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const next = (index + 1) % points.length;
      const info = infos[index] ?? { kind: "line" as const, entityId: profile.entityIds[0] ?? profile.id, key: `${profile.id}/e${index}` };
      const before = edges.length;
      if (reverse) add(ids[next]!, ids[index]!, info); else add(ids[index]!, ids[next]!, info);
      own.push(edges.length > before ? edges[edges.length - 1] : undefined);
    }
    rings.push({ ids, infos: infos.slice(0, points.length), reverse, edges: own });
  };
  for (const face of included.values()) {
    ringEdges(face, face.boundary, false);
    for (const hole of face.holes ?? []) ringEdges(hole, hole.boundary, true);
  }
  // A ring none of whose edges met a neighbour's stays exactly as it was: chaining it with other rings at a point where they touch (a hole
  // tangent to the outline, two holes meeting) would tie the outline and the hole into one figure-eight loop.
  const live = edges.filter((edge) => !edge.cancelled);
  const used = new Set<DirectedEdge>();
  const loops: { ids: number[]; infos: EdgeInfo[] }[] = [];
  for (const ring of rings) {
    if (ring.ids.length < 3 || ring.edges.some((edge) => edge === undefined || edge.cancelled)) continue;
    for (const edge of ring.edges) used.add(edge!);
    loops.push(ring.reverse
      ? { ids: [ring.ids[0]!, ...ring.ids.slice(1).reverse()], infos: [...ring.infos].reverse() }
      : { ids: [...ring.ids], infos: [...ring.infos] });
  }
  for (const start of live) {
    if (used.has(start)) continue;
    const ids: number[] = [];
    const infos: EdgeInfo[] = [];
    let edge: DirectedEdge | undefined = start;
    let guard = 0;
    while (edge !== undefined && !used.has(edge) && guard < live.length + 2) {
      used.add(edge);
      ids.push(edge.from);
      infos.push(edge.info);
      guard += 1;
      if (edge.to === start.from) break;
      const options: DirectedEdge[] = (outgoing.get(edge.to) ?? []).filter((candidate) => !candidate.cancelled && !used.has(candidate));
      if (options.length <= 1) { edge = options[0]; continue; }
      // At a pinch take the edge that turns most to the right, which keeps the lobes apart.
      const here = registry.points[edge.to]!;
      const back = registry.points[edge.from]!;
      const backAngle = Math.atan2(back[1] - here[1], back[0] - here[0]);
      let best: DirectedEdge | undefined;
      let bestTurn = Infinity;
      for (const candidate of options) {
        const target = registry.points[candidate.to]!;
        let turn = backAngle - Math.atan2(target[1] - here[1], target[0] - here[0]);
        turn = ((turn % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (turn === 0) turn = 2 * Math.PI;
        if (turn < bestTurn) { bestTurn = turn; best = candidate; }
      }
      edge = best;
    }
    if (ids.length >= 3) loops.push({ ids, infos });
  }
  // Classify: counter-clockwise loops are outlines, clockwise ones are holes.
  interface Described { readonly profile: SketchProfile; readonly ring: Ring }
  const known = new Map<string, SketchProfile>();
  const signature = (ids: readonly number[]): string => fnv1a([...new Set(ids)].sort((a, b) => a - b).join(","));
  const registerBoundary = (profile: SketchProfile): void => {
    const ids = profileOutlineMm(profile.boundary).map((point) => registry.id(point));
    known.set(signature(ids), profile);
  };
  for (const face of included.values()) {
    registerBoundary(face);
    for (const hole of face.holes ?? []) registerBoundary(hole);
  }
  const outers: Described[] = [];
  const holes: Described[] = [];
  for (const loop of loops) {
    const ringPoints = loop.ids.map((id) => registry.points[id]!);
    const ring = makeRing(ringPoints);
    let twice = 0;
    for (let index = 0; index < ringPoints.length; index += 1) {
      const p = ringPoints[index]!;
      const q = ringPoints[(index + 1) % ringPoints.length]!;
      twice += p[0] * q[1] - q[0] * p[1];
    }
    if (ring.area < 1e-9) continue;
    const counterClockwise = twice > 0;
    const reuse = known.get(signature(loop.ids));
    let profile = reuse;
    if (profile === undefined) {
      const oriented = counterClockwise ? loop : { ids: [...loop.ids].reverse(), infos: [...loop.infos].reverse() };
      profile = synthesize(oriented.ids.map((id) => registry.points[id]!), oriented.infos, ring.area);
    }
    (counterClockwise ? outers : holes).push({ profile, ring: ringOf(profile) });
  }
  if (outers.length === 0) return failure("INVALID_OPERATION", "The selected regions do not enclose any area.", picks.flatMap((pick) => pick.profile.entityIds), "Select a region of the sketch.");
  outers.sort((left, right) => right.ring.area - left.ring.area);
  const groups: { outer: SketchProfile; holes: SketchProfile[] }[] = outers.map((item) => ({ outer: item.profile, holes: [] }));
  for (const hole of holes.sort((left, right) => right.ring.area - left.ring.area)) {
    let owner = -1;
    for (let index = outers.length - 1; index >= 0; index -= 1) {
      if (outers[index]!.ring.area > hole.ring.area && holeStandsIn(hole.ring, outers[index]!.ring)) { owner = index; break; }
    }
    if (owner >= 0) groups[owner]!.holes.push(hole.profile);
    else warnings.push(`A hole in the selected regions has no outline around it and was ignored.`);
  }
  return finish(groups, [...warnings, ...touchWarnings(groups)]);
}

/**
 * Whether a hole's ring lies inside an outline's ring. A hole that touches the outline (tangent, or within the tolerance) has corners
 * on the outline itself, where "inside" is undefined, so those corners are skipped and the rest decide: all of them inside.
 */
function holeStandsIn(hole: Ring, outer: Ring): boolean {
  if (hole.box[0] < outer.box[0] - TOLERANCE_MM || hole.box[2] > outer.box[2] + TOLERANCE_MM || hole.box[1] < outer.box[1] - TOLERANCE_MM || hole.box[3] > outer.box[3] + TOLERANCE_MM) return false;
  const stride = Math.max(1, Math.floor(hole.points.length / 12));
  let counted = 0;
  for (let index = 0; index < hole.points.length; index += stride) {
    const point = hole.points[index]!;
    if (distanceToRing(point, outer.points) <= 1e-6) continue;
    if (!pointInRing(point, outer.points)) return false;
    counted += 1;
  }
  return counted > 0;
}

/**
 * Holes of a region that touch the outline or one another, or sit closer than the tolerance: a wall that thin cannot be built, and a
 * kernel refusal on its own ("a hole crosses the outline") does not say which holes are meant.
 */
const holeName = (hole: SketchProfile): string => shortId(hole.entityIds[0] ?? hole.id);

function touchWarnings(groups: readonly { readonly outer: SketchProfile; readonly holes: readonly SketchProfile[] }[], includeOutline = true): string[] {
  const notes: string[] = [];
  for (const group of groups) {
    if (group.holes.length === 0) continue;
    const outerRing = ringOf(group.outer);
    const rings = group.holes.map((hole) => ({ hole, ring: ringOf(hole) }));
    if (includeOutline) for (const item of rings) {
      if (relate(outerRing, item.ring).touching) notes.push(`The hole ${holeName(item.hole)} touches the outline of ${shortId(group.outer.id)} (or lies within ${TOLERANCE_MM} mm of it), which leaves a zero-width wall. Move it inward or dimension it clear of the edge.`);
    }
    // Sweep by left edge so only holes whose boxes (grown by the tolerance) overlap are compared.
    const order = [...rings].sort((left, right) => left.ring.box[0] - right.ring.box[0]);
    for (let index = 0; index < order.length; index += 1) {
      const left = order[index]!;
      for (let next = index + 1; next < order.length; next += 1) {
        const right = order[next]!;
        if (right.ring.box[0] > left.ring.box[2] + TOLERANCE_MM) break;
        if (right.ring.box[1] > left.ring.box[3] + TOLERANCE_MM || left.ring.box[1] > right.ring.box[3] + TOLERANCE_MM) continue;
        const related = relate(left.ring, right.ring);
        if (related.touching && related.relation === "disjoint") notes.push(`The holes ${holeName(left.hole)} and ${holeName(right.hole)} touch or lie within ${TOLERANCE_MM} mm of each other, which leaves a zero-width wall between them. Move them apart, or overlap them to make one opening.`);
      }
    }
  }
  return notes;
}

function synthesize(points: readonly Vec2[], infos: readonly EdgeInfo[], area: number): SketchProfile {
  const segments: SketchProfileSegment[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const info = infos[index]!;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.key === info.key && info.kind !== "line") segments[segments.length - 1] = { ...last, edgeCount: last.edgeCount + 1 };
    else segments.push({ entityId: info.entityId, kind: info.kind, edgeCount: 1, key: info.key });
  }
  const allLines = segments.every((segment) => segment.kind === "line");
  const boundary: SketchProfileBoundary = allLines ? { kind: "line-loop", points } : { kind: "curve-loop", points, segments };
  let cx = 0;
  let cy = 0;
  let twice = 0;
  const origin = points[0]!;
  for (let index = 0; index < points.length; index += 1) {
    const p = points[index]!;
    const q = points[(index + 1) % points.length]!;
    const px = p[0] - origin[0];
    const py = p[1] - origin[1];
    const qx = q[0] - origin[0];
    const qy = q[1] - origin[1];
    const f = px * qy - qx * py;
    cx += (px + qx) * f;
    cy += (py + qy) * f;
    twice += f;
  }
  const centroid: Vec2 = Math.abs(twice) < 1e-12 ? origin : [origin[0] + cx / (3 * twice), origin[1] + cy / (3 * twice)];
  const entityIds = [...new Set(infos.map((info) => info.entityId))].sort();
  const id = `profile:region-${fnv1a(points.map((point) => `${Math.round(point[0] * 1e4)},${Math.round(point[1] * 1e4)}`).sort().join("|"))}`;
  return { id, entityIds, boundary, areaMm2: area, centroid };
}

/** The ids or references among `ids` that name no profile any more, described for a message ("a region of about 120 mm² near (10, 5)"). */
export function lostProfileRefs(profiles: readonly SketchProfile[], ids: readonly string[]): string[] {
  const lost: string[] = [];
  const shapes = shapesOf(profiles);
  for (const id of new Set(ids)) {
    const parsed = parseProfileRef(id);
    if (matchProfileRef(id, profiles, false) !== undefined || (shapes !== undefined && matchProfileRef(id, shapes, false) !== undefined) || matchProfileRef(id, profiles) !== undefined) continue;
    const round = (value: number): string => String(Math.round(value * 100) / 100);
    lost.push(parsed.areaMm2 !== undefined && parsed.centroid !== undefined ? `a region of about ${round(parsed.areaMm2)} mm² near (${round(parsed.centroid[0])}, ${round(parsed.centroid[1])})` : shortId(parsed.base));
  }
  return lost;
}

/**
 * The region an outline stands for, built from the faces inside it: a face is solid when the deepest outline covering it sits an
 * even number of outlines down (the outline itself, an island in a hole ...) and a void otherwise. Outlines that merely overlap
 * one another sit at the same depth, so overlapping holes are one void.
 */
function regionFromFaces(faces: readonly SketchProfile[], outlines: readonly SketchProfile[], root: SketchProfile, rootRing: Ring): WorkbenchResult<ProfileRegion> | undefined {
  const rings = outlines.map((outline) => ({ outline, ring: ringOf(outline) }));
  const within = rings.filter((item) => item.outline.id === root.id || (item.ring.area <= rootRing.area * (1 + 1e-9) && relate(rootRing, item.ring).relation === "inside"));
  const depthOf = new Map<SketchProfile, number>();
  for (const item of within) {
    let depth = 0;
    for (const other of within) if (other !== item && other.ring.area > item.ring.area && relate(other.ring, item.ring).relation === "inside") depth += 1;
    depthOf.set(item.outline, depth);
  }
  const rootDepth = depthOf.get(within.find((item) => item.outline.id === root.id)?.outline ?? root) ?? 0;
  const solid: ExactPick[] = [];
  for (const face of faces) {
    const point = face.interiorPoint;
    if (point === undefined || point[0] < rootRing.box[0] || point[0] > rootRing.box[2] || point[1] < rootRing.box[1] || point[1] > rootRing.box[3] || !pointInRing(point, rootRing.points)) continue;
    let deepest = rootDepth;
    for (const item of within) {
      if (item.outline.id === root.id || !pointInRing(point, item.ring.points)) continue;
      deepest = Math.max(deepest, depthOf.get(item.outline) ?? 0);
    }
    if ((deepest - rootDepth) % 2 === 0) solid.push({ profile: face, keep: "all"});
  }
  if (solid.length === 0) return undefined;
  return unionRegion(faces, solid, true);
}

/**
 * Whether a selection box picks a region: a window box picks regions that lie wholly inside it; a crossing box picks regions it
 * actually touches (an outline point inside the box, a box corner inside the region, or an edge crossing the box), not merely
 * regions whose bounding box overlaps it.
 */
export function profileInBox(profile: SketchProfile, box: { readonly min: Vec2; readonly max: Vec2 }, mode: "window" | "crossing"): boolean {
  const ring = ringOf(profile);
  if (mode === "window") return ring.box[0] >= box.min[0] && ring.box[2] <= box.max[0] && ring.box[1] >= box.min[1] && ring.box[3] <= box.max[1];
  if (ring.box[0] > box.max[0] || ring.box[2] < box.min[0] || ring.box[1] > box.max[1] || ring.box[3] < box.min[1]) return false;
  const inside = (point: Vec2): boolean => point[0] >= box.min[0] && point[0] <= box.max[0] && point[1] >= box.min[1] && point[1] <= box.max[1];
  if (ring.points.some(inside)) return true;
  const corners: Vec2[] = [[box.min[0], box.min[1]], [box.max[0], box.min[1]], [box.max[0], box.max[1]], [box.min[0], box.max[1]]];
  const holeRings = (profile.holes ?? []).map((hole) => ringOf(hole));
  for (const corner of corners) {
    if (pointInRing(corner, ring.points) && !holeRings.some((hole) => pointInRing(corner, hole.points))) return true;
  }
  for (let index = 0; index < ring.points.length; index += 1) {
    const a = ring.points[index]!;
    const b = ring.points[(index + 1) % ring.points.length]!;
    for (let side = 0; side < 4; side += 1) if (segmentsCross(a, b, corners[side]!, corners[(side + 1) % 4]!)) return true;
  }
  return false;
}
