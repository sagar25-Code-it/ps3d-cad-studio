import type { HoleSpec } from "./hole.js";
import { triangulateLoops } from "../../occt-kernel-adapter/src/polygon.js";
import { THREAD_SAMPLES_PER_PITCH, threadProblem, threadRadiusMm, type HoleThread } from "./hole-thread.js";

type Vec3 = readonly [number, number, number];

export type ThreadedWallResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[] }
  | { readonly ok: false; readonly message: string };

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Shapes a modelled thread into a bore that has already been cut. A Boolean against a helical cutter is not reliable on a tessellated
 * body (thousands of nearly coplanar facets), so the plain tap-drill bore is cut first and its wall is then rebuilt: every triangle
 * of the wall runs between the rim at the face and the rim at the bottom; the edges that cross from one rim to the other are
 * subdivided every pitch/8 and each new vertex, like the rim vertices themselves, is moved to the thread's radius at its angle and
 * depth. The wall becomes a true helical groove that stays welded to the faces around it, because the rim edges are not subdivided
 * and the rim vertices move only within the plane of their face.
 *
 * The bore must be a clean cylinder cut square into flat faces: if its wall is crossed by other edges, or the faces are not square
 * to the axis, or the groove would run into an edge of the face, the mesh is not changed and the reason is returned.
 */
export function threadBoreWall(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }, spec: HoleSpec, thread: HoleThread): ThreadedWallResult {
  const problem = threadProblem(thread, spec.diameterMm);
  if (problem !== undefined) return { ok: false, message: problem };
  if (spec.style !== "simple") return { ok: false, message: "A modelled thread goes in a plain hole; counterbore and countersink holes cannot carry one." };
  const normalLength = Math.hypot(spec.normal[0], spec.normal[1], spec.normal[2]);
  if (normalLength < 1e-9) return { ok: false, message: "The hole has no direction: its face normal is zero." };
  const normal: Vec3 = [spec.normal[0] / normalLength, spec.normal[1] / normalLength, spec.normal[2] / normalLength];
  const axis: Vec3 = [-normal[0], -normal[1], -normal[2]];
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uRaw = cross(helper, normal);
  const uLength = Math.hypot(uRaw[0], uRaw[1], uRaw[2]);
  const u: Vec3 = [uRaw[0] / uLength, uRaw[1] / uLength, uRaw[2] / uLength];
  const v = cross(normal, u);
  const minor = spec.diameterMm / 2;
  const origin = spec.originMm;
  const positions = Array.from(mesh.positionsMm);
  const vertexCount = positions.length / 3;
  const at = (index: number, source: readonly number[] = positions): Vec3 => [source[index * 3]!, source[index * 3 + 1]!, source[index * 3 + 2]!];

  const local = (index: number): { rho: number; depth: number; angle: number } => {
    const rel = sub(at(index), origin);
    const c = dot(rel, u);
    const s = dot(rel, v);
    return { rho: Math.hypot(c, s), depth: dot(rel, axis), angle: Math.atan2(s, c) };
  };
  const polar = (angle: number, depth: number): Vec3 => {
    const radius = threadRadiusMm(spec.diameterMm, thread, spec.depthMm, depth, angle);
    const c = Math.cos(angle) * radius;
    const s = Math.sin(angle) * radius;
    return [origin[0] + u[0] * c + v[0] * s + axis[0] * depth, origin[1] + u[1] * c + v[1] * s + axis[1] * depth, origin[2] + u[2] * c + v[2] * s + axis[2] * depth];
  };

  // The bore's wall: triangles lying on the faceted cylinder (between the chord and the circle) and square to the face.
  const radialTolerance = 1e-4 + 1e-6 * minor;
  const onWall = new Array<boolean>(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    const { rho, depth } = local(i);
    onWall[i] = rho >= minor * 0.99 && rho <= minor + radialTolerance && depth >= -1e-4 && depth <= spec.depthMm + 1e-4;
  }
  const wall: (readonly [number, number, number])[] = [];
  const rest: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!;
    const b = mesh.indices[t + 1]!;
    const c = mesh.indices[t + 2]!;
    let isWall = onWall[a]! && onWall[b]! && onWall[c]!;
    if (isWall) {
      const n = cross(sub(at(b), at(a)), sub(at(c), at(a)));
      const length = Math.hypot(n[0], n[1], n[2]);
      isWall = length > 1e-12 && Math.abs(dot(n, axis)) / length < 1e-3;
    }
    if (isWall) wall.push([a, b, c]);
    else rest.push(a, b, c);
  }
  if (wall.length === 0) return { ok: false, message: "The bore's wall was not found in the cut body, so the thread cannot be shaped." };

  // Two rims: the face the hole starts on and the face (or floor) it ends on, both square to the axis. Anything between them on the
  // old wall (the odd vertex a Boolean leaves mid-wall) is dropped with the old wall triangles.
  const wallVertices = [...new Set(wall.flat())];
  const depths = wallVertices.map((vertex) => local(vertex).depth);
  const topDepth = Math.min(...depths);
  const bottomDepth = Math.max(...depths);
  const topRim = wallVertices.filter((vertex) => Math.abs(local(vertex).depth - topDepth) < 1e-5);
  const bottomRim = wallVertices.filter((vertex) => Math.abs(local(vertex).depth - bottomDepth) < 1e-5);
  const span = bottomDepth - topDepth;
  if (!(span > thread.pitchMm / 2)) return { ok: false, message: "The hole is shallower than half a pitch, so there is no thread to model." };
  if (topRim.length < 8 || bottomRim.length < 8) return { ok: false, message: "A modelled thread needs a plain bore square to its faces: the hole's wall does not run between two flat rims. Use a cosmetic thread here." };
  const rings = Math.max(2, Math.ceil((span * THREAD_SAMPLES_PER_PITCH) / thread.pitchMm));
  if (rings > 2400) return { ok: false, message: `A ${span.toFixed(0)} mm thread of ${thread.pitchMm} mm pitch is too long to model; shorten the thread or use a cosmetic one.` };

  // Zip the two rim loops together by angle: each step takes the next vertex of whichever loop comes first.
  const circular = (x: number): number => { let y = x; while (y > Math.PI) y -= Math.PI * 2; while (y <= -Math.PI) y += Math.PI * 2; return y; };
  const byAngle = (rim: readonly number[]): number[] => [...rim].sort((left, right) => local(left).angle - local(right).angle);
  const topLoop = byAngle(topRim);
  let bottomLoop = byAngle(bottomRim);
  let nearest = 0;
  for (let i = 1; i < bottomLoop.length; i += 1) if (Math.abs(circular(local(bottomLoop[i]!).angle - local(topLoop[0]!).angle)) < Math.abs(circular(local(bottomLoop[nearest]!).angle - local(topLoop[0]!).angle))) nearest = i;
  bottomLoop = [...bottomLoop.slice(nearest), ...bottomLoop.slice(0, nearest)];
  // Angles of a loop as an increasing run starting at `start`.
  const unwrap = (loop: readonly number[], start: number): number[] => {
    const angles: number[] = [];
    let previous = start;
    for (const vertex of loop) {
      let angle = local(vertex).angle;
      while (angle < previous - 1e-9) angle += Math.PI * 2;
      while (angle > previous + Math.PI * 2 - 1e-9) angle -= Math.PI * 2;
      angles.push(angle);
      previous = angle;
    }
    return angles;
  };
  const topAngles = unwrap(topLoop, local(topLoop[0]!).angle);
  const bottomFirst = local(bottomLoop[0]!).angle;
  const bottomAngles = unwrap(bottomLoop, bottomFirst);
  // Put the bottom run beside the top run (it may have started a turn away).
  const shift = Math.round((topAngles[0]! - bottomAngles[0]!) / (Math.PI * 2)) * Math.PI * 2;
  for (let i = 0; i < bottomAngles.length; i += 1) bottomAngles[i] = bottomAngles[i]! + shift;
  const topEnd = topAngles[0]! + Math.PI * 2;
  const bottomEnd = bottomAngles[0]! + Math.PI * 2;
  const zipped: (readonly [number, number, number])[] = [];
  let ti = 0;
  let bi = 0;
  while (ti < topLoop.length || bi < bottomLoop.length) {
    const nextTop = ti < topLoop.length ? (ti + 1 < topLoop.length ? topAngles[ti + 1]! : topEnd) : Infinity;
    const nextBottom = bi < bottomLoop.length ? (bi + 1 < bottomLoop.length ? bottomAngles[bi + 1]! : bottomEnd) : Infinity;
    if (ti < topLoop.length && nextTop <= nextBottom) {
      zipped.push([topLoop[ti]!, topLoop[(ti + 1) % topLoop.length]!, bottomLoop[bi % bottomLoop.length]!]);
      ti += 1;
    } else {
      zipped.push([topLoop[ti % topLoop.length]!, bottomLoop[(bi + 1) % bottomLoop.length]!, bottomLoop[bi]!]);
      bi += 1;
    }
  }
  const levelOf = (vertex: number): 0 | 1 => (Math.abs(local(vertex).depth - topDepth) < 1e-5 ? 0 : 1);

  const extra: number[] = [];
  const interior = new Map<string, number>();
  const pointOn = (top: number, bottom: number, step: number): number => {
    const key = `${top}_${bottom}_${step}`;
    const existing = interior.get(key);
    if (existing !== undefined) return existing;
    const first = local(top);
    const second = local(bottom);
    const turn = circular(second.angle - first.angle);
    const where = polar(first.angle + (turn * step) / rings, first.depth + ((second.depth - first.depth) * step) / rings);
    const index = vertexCount + extra.length / 3;
    extra.push(where[0], where[1], where[2]);
    interior.set(key, index);
    return index;
  };

  const strip: number[] = [];
  for (const triangle of zipped) {
    const levels = triangle.map(levelOf);
    const topCount = levels.filter((level) => level === 0).length;
    if (topCount === 0 || topCount === 3) return { ok: false, message: "The bore's wall has a triangle that does not run between the two faces, so the thread was not applied." };
    // Read each triangle as (rim vertex, rim vertex, apex): the rim edge is the two vertices on the same level.
    const apexLevel = topCount === 2 ? 1 : 0;
    const apexAt = levels.findIndex((level) => level === apexLevel);
    const r1 = triangle[(apexAt + 1) % 3]!;
    const r2 = triangle[(apexAt + 2) % 3]!;
    const apex = triangle[apexAt]!;
    const rimOnTop = apexLevel === 1;
    const along = (rim: number, k: number): number => {
      if (k === 0) return rim;
      if (k === rings) return apex;
      return rimOnTop ? pointOn(rim, apex, k) : pointOn(apex, rim, rings - k);
    };
    for (let k = 0; k < rings; k += 1) {
      const a = along(r1, k);
      const b = along(r2, k);
      if (k === rings - 1) { strip.push(a, b, apex); continue; }
      const c = along(r2, k + 1);
      const d = along(r1, k + 1);
      strip.push(a, b, c, a, c, d);
    }
  }
  // The zipper winds one way round; the wall has to face into the bore, towards the axis.
  {
    const placed = (index: number): Vec3 => (index >= vertexCount ? at(index - vertexCount, extra) : polar(local(index).angle, local(index).depth));
    const pa = placed(strip[0]!);
    const facing = cross(sub(placed(strip[1]!), pa), sub(placed(strip[2]!), pa));
    const relative = sub(pa, origin);
    const alongAxis = dot(relative, axis);
    const toAxis: Vec3 = [-(relative[0] - axis[0] * alongAxis), -(relative[1] - axis[1] * alongAxis), -(relative[2] - axis[2] * alongAxis)];
    if (dot(facing, toAxis) < 0) for (let i = 0; i + 2 < strip.length; i += 3) { const t = strip[i + 1]!; strip[i + 1] = strip[i + 2]!; strip[i + 2] = t; }
  }

  // Move the rim vertices onto the thread's radius, then check the faces around them keep their direction.
  const result = positions.slice();
  const rim = new Set<number>(wallVertices);
  for (const vertex of rim) {
    const { angle, depth } = local(vertex);
    const where = polar(angle, depth);
    result[vertex * 3] = where[0]; result[vertex * 3 + 1] = where[1]; result[vertex * 3 + 2] = where[2];
  }
  const allPositions = [...result, ...extra];
  // The faces around the hole are triangulated for a round hole; with the rim moved they are re-triangulated from their boundary.
  // Each face the rims belong to is found by flood-filling coplanar triangles, its boundary loops are read off (the rim, now
  // following the groove, is one of them) and the region is triangulated afresh, which also drops the stray vertices near the hole.
  let faceTriangles: [number, number, number][] = [];
  for (let t = 0; t < rest.length; t += 3) faceTriangles.push([rest[t]!, rest[t + 1]!, rest[t + 2]!]);
  const rebuilt = new Set<number>();
  const seeds = [topRim[0]!, bottomRim[0]!].map((vertex) => faceTriangles.findIndex((triangle) => triangle.includes(vertex)));
  const replacements: [number, number, number][] = [];
  for (const seed of seeds) {
    if (seed < 0) return { ok: false, message: "The faces around the hole were not found, so the thread was not applied." };
    if (rebuilt.has(seed)) continue;
    const face = retriangulateFace(seed);
    if (typeof face === "string") return { ok: false, message: face };
    for (const t of face.removed) rebuilt.add(t);
    replacements.push(...face.triangles);
  }
  faceTriangles = [...faceTriangles.filter((_, t) => !rebuilt.has(t)), ...replacements];
  const indices = [...faceTriangles.flat(), ...strip];

  function retriangulateFace(seed: number): { readonly removed: number[]; readonly triangles: [number, number, number][] } | string {
    const [sa, sb, sc] = faceTriangles[seed]!;
    const raw = cross(sub(at(sb), at(sa)), sub(at(sc), at(sa)));
    const rawLength = Math.hypot(raw[0], raw[1], raw[2]);
    if (rawLength < 1e-12) return "A face next to the hole is degenerate, so the thread was not applied.";
    const n: Vec3 = [raw[0] / rawLength, raw[1] / rawLength, raw[2] / rawLength];
    if (Math.abs(dot(n, axis)) < 0.999) return "A modelled thread needs the hole to start and end on faces square to its axis.";
    const offset = dot(n, at(sa));
    const owner = new Map<string, number>();
    faceTriangles.forEach(([a, b, c], t) => { owner.set(`${a}>${b}`, t); owner.set(`${b}>${c}`, t); owner.set(`${c}>${a}`, t); });
    const inPlane = (t: number): boolean => {
      const [a, b, c] = faceTriangles[t]!;
      if ([a, b, c].some((vertex) => Math.abs(dot(n, at(vertex)) - offset) > 1e-5)) return false;
      const m = cross(sub(at(b), at(a)), sub(at(c), at(a)));
      return dot(m, n) > 0;
    };
    const region = new Set<number>([seed]);
    const queue = [seed];
    while (queue.length > 0) {
      const t = queue.pop()!;
      const [a, b, c] = faceTriangles[t]!;
      for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
        const neighbour = owner.get(`${to}>${from}`);
        if (neighbour === undefined || region.has(neighbour) || !inPlane(neighbour)) continue;
        region.add(neighbour);
        queue.push(neighbour);
      }
    }
    // Boundary edges (those whose partner belongs to another face) chained into closed loops.
    const next = new Map<number, number[]>();
    for (const t of region) {
      const [a, b, c] = faceTriangles[t]!;
      for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
        const neighbour = owner.get(`${to}>${from}`);
        if (neighbour !== undefined && region.has(neighbour)) continue;
        const list = next.get(from);
        if (list === undefined) next.set(from, [to]);
        else list.push(to);
      }
    }
    const loops: number[][] = [];
    for (const start of [...next.keys()]) {
      while ((next.get(start)?.length ?? 0) > 0) {
        const loop: number[] = [start];
        let current = next.get(start)!.pop()!;
        let guard = 0;
        while (current !== start) {
          loop.push(current);
          const options = next.get(current);
          if (options === undefined || options.length !== 1 || guard++ > 100000) return "The face around the hole touches itself, so the thread was not applied.";
          current = options.pop()!;
        }
        loops.push(loop);
      }
    }
    const helperAxis: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1Raw = cross(helperAxis, n);
    const e1Length = Math.hypot(e1Raw[0], e1Raw[1], e1Raw[2]);
    const e1: Vec3 = [e1Raw[0] / e1Length, e1Raw[1] / e1Length, e1Raw[2] / e1Length];
    const e2 = cross(n, e1);
    const flat = (vertex: number): readonly [number, number] => { const p = at(vertex, allPositions); return [dot(p, e1), dot(p, e2)]; };
    const areaOf = (loop: readonly number[]): number => {
      let twice = 0;
      for (let i = 0; i < loop.length; i += 1) { const p = flat(loop[i]!); const q = flat(loop[(i + 1) % loop.length]!); twice += p[0] * q[1] - q[0] * p[1]; }
      return twice / 2;
    };
    const areas = loops.map(areaOf);
    const outerAt = areas.reduce((best, area, i) => (area > areas[best]! ? i : best), 0);
    if (!(areas[outerAt]! > 0)) return "The face around the hole has no outline, so the thread was not applied.";
    const outer = loops[outerAt]!;
    const holes = loops.filter((_, i) => i !== outerAt);
    let triangles: readonly number[];
    try {
      triangles = triangulateLoops(outer.map(flat), holes.map((hole) => hole.map(flat)));
    } catch {
      return "The thread would run into an edge of the face the hole starts or ends on; move the hole away from the edge or use a smaller thread.";
    }
    const ids = [...outer, ...holes.flat()];
    let made: [number, number, number][] = [];
    for (let i = 0; i + 2 < triangles.length; i += 3) made.push([ids[triangles[i]!]!, ids[triangles[i + 1]!]!, ids[triangles[i + 2]!]!]);
    // The triangulator drops vertices that sit in a straight line on the boundary, but the walls and faces next door share them:
    // put each back by fanning the triangle that spans them.
    const nextInLoop = new Map<number, number>();
    for (const loop of loops) loop.forEach((vertex, i) => nextInLoop.set(vertex, loop[(i + 1) % loop.length]!));
    const used = new Set<number>(made.flat());
    if (ids.some((vertex) => !used.has(vertex))) {
      const repaired: [number, number, number][] = [];
      const pending = [...made];
      while (pending.length > 0) {
        const piece = pending.pop()!;
        let split = false;
        for (let side = 0; side < 3 && !split; side += 1) {
          const p = piece[side]!;
          const q = piece[(side + 1) % 3]!;
          const apex = piece[(side + 2) % 3]!;
          const chain: number[] = [p];
          let walk = nextInLoop.get(p);
          while (walk !== undefined && walk !== q && !used.has(walk) && chain.length < 4096) { chain.push(walk); walk = nextInLoop.get(walk); }
          if (walk === q && chain.length > 1) {
            chain.push(q);
            for (let i = 0; i + 1 < chain.length; i += 1) pending.push([chain[i]!, chain[i + 1]!, apex]);
            split = true;
          }
        }
        if (!split) repaired.push(piece);
      }
      made = repaired;
    }
    return { removed: [...region], triangles: made };
  }

  // The result has to be a closed, consistently wound solid with a positive volume, or it is not used.
  const directed = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) for (let side = 0; side < 3; side += 1) {
    const key = `${indices[i + side]}>${indices[i + (side + 1) % 3]}`;
    directed.set(key, (directed.get(key) ?? 0) + 1);
  }
  for (const [key, count] of directed) {
    const [from, to] = key.split(">");
    if (count !== 1 || directed.get(`${to}>${from}`) !== 1) return { ok: false, message: "The threaded wall did not close up with the faces around the hole, so the thread was not applied." };
  }
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) volume += dot(at(indices[i]!, allPositions), cross(at(indices[i + 1]!, allPositions), at(indices[i + 2]!, allPositions))) / 6;
  if (!(volume > 0)) return { ok: false, message: "The threaded wall produced an inside-out body, so the thread was not applied." };
  // Drop the vertices of the old wall that nothing uses any more.
  const remap = new Map<number, number>();
  const compact: number[] = [];
  const finalIndices = indices.map((index) => {
    let mapped = remap.get(index);
    if (mapped === undefined) { mapped = compact.length / 3; remap.set(index, mapped); compact.push(allPositions[index * 3]!, allPositions[index * 3 + 1]!, allPositions[index * 3 + 2]!); }
    return mapped;
  });
  return { ok: true, positionsMm: compact, indices: finalIndices };
}
