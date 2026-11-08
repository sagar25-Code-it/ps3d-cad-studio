import { analyzeFaces, add, cross, dot, length, scale, sub, unit, type FaceRefLike, type MeshLike, type V3 } from "./face-analysis.js";
import { sliceMesh } from "./flex.js";
import { frameAboutAxis, type CylinderFit, type WrapProfile, type WrapResult, type WrapSpec } from "./wrap.js";
import { insidePolygon, simplifyClosed } from "./wrap-tool.js";

/**
 * Wraps `profile` onto the cylinder `fit`, centred where `ref` was picked, raising (emboss) or sinking (deboss) the part of the
 * surface under the profile by `heightMm`.
 *
 * No Boolean is used. The body is cut along the planes of the profile's walls, which imprints the profile's outline on the cylinder
 * wall; the triangles of the wall that lie inside the outline are then moved radially by the height, and a wall of triangles joins
 * each edge of the moved patch to the unmoved surface around it. The result keeps the body's own facets, so the raised surface
 * stands exactly `heightMm` above (or below) the surface it grew from, however many curves the outline has.
 */
/**
 * Merges vertices closer than `tolerance` and drops the triangles that collapse. Cutting along many planes leaves slivers where two
 * cuts nearly meet; collapsing them keeps every remaining vertex well apart, so the body can be welded and checked reliably.
 */
function collapseNear(positions: readonly V3[], triangles: readonly [number, number, number][], tolerance: number): { positions: V3[]; triangles: [number, number, number][] } {
  const parent = positions.map((_, i) => i);
  const find = (i: number): number => { let r = i; while (parent[r] !== r) r = parent[r]!; let c = i; while (parent[c] !== r) { const next = parent[c]!; parent[c] = r; c = next; } return r; };
  const cell = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  positions.forEach((point, index) => {
    const cx = Math.floor(point[0] / tolerance); const cy = Math.floor(point[1] / tolerance); const cz = Math.floor(point[2] / tolerance);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (const other of cell.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        const q = positions[other]!;
        if (Math.hypot(point[0] - q[0], point[1] - q[1], point[2] - q[2]) < tolerance) parent[find(index)] = find(other);
      }
    }
    const own = key(cx, cy, cz);
    const list = cell.get(own);
    if (list === undefined) cell.set(own, [index]); else list.push(index);
  });
  const remap = new Map<number, number>();
  const kept: V3[] = [];
  const idOf = (i: number): number => { const r = find(i); let id = remap.get(r); if (id === undefined) { id = kept.length; kept.push(positions[r]!); remap.set(r, id); } return id; };
  const out: [number, number, number][] = [];
  for (const [a, b, c] of triangles) {
    const x = idOf(a); const y = idOf(b); const z = idOf(c);
    if (x !== y && y !== z && x !== z) out.push([x, y, z]);
  }
  return { positions: kept, triangles: out };
}

export function wrapProfile(mesh: MeshLike, profile: WrapProfile, fit: CylinderFit, ref: FaceRefLike, spec: WrapSpec): WrapResult {
  // Where two cuts of the outline nearly meet on a facet edge the cut mesh can come out with a pinched corner. Moving the profile by
  // a hundredth of a millimetre breaks that coincidence, so a refused attempt is retried a few times with a tiny nudge.
  let last: WrapResult = { ok: false, message: "The profile could not be wrapped." };
  for (const nudge of [0, 0.0071, -0.0113, 0.0197, -0.0263]) {
    last = wrapOnce(mesh, profile, fit, ref, spec, nudge);
    if (last.ok || !last.message.includes("not a valid solid")) return last;
  }
  return last;
}

function wrapOnce(mesh: MeshLike, profile: WrapProfile, fit: CylinderFit, ref: FaceRefLike, spec: WrapSpec, nudge: number): WrapResult {
  if (!(spec.heightMm > 0) || !Number.isFinite(spec.heightMm)) return { ok: false, message: "The wrap height must be a positive length." };
  const radius = fit.radiusMm;
  if (spec.mode === "deboss" && spec.heightMm >= radius) return { ok: false, message: "A deboss cannot be as deep as the cylinder's radius." };
  const us = profile.outer.map((p) => p[0]);
  const vs = profile.outer.map((p) => p[1]);
  const cu = (Math.min(...us) + Math.max(...us)) / 2;
  const cv = (Math.min(...vs) + Math.max(...vs)) / 2;
  const span = (Math.max(...us) - Math.min(...us)) / radius;
  if (span > (150 * Math.PI) / 180) return { ok: false, message: `The profile is ${(span * radius).toFixed(1)} mm wide, which wraps ${((span * 180) / Math.PI).toFixed(0)}° round a ${radius.toFixed(1)} mm cylinder. Wrap supports profiles up to 150° round.` };
  const [e1, e2] = frameAboutAxis(fit.axisMm);
  const axis = fit.axisMm;
  const picked = sub(ref.pointMm, fit.axisPointMm);
  const theta0 = Math.atan2(dot(picked, e2), dot(picked, e1));
  const along0 = dot(picked, axis);
  const place = (x: number, y: number, r: number): V3 => {
    const theta = theta0 + (x + nudge) / radius;
    return add(add(fit.axisPointMm, scale(axis, along0 + y + nudge * 0.61)), add(scale(e1, r * Math.cos(theta)), scale(e2, r * Math.sin(theta))));
  };
  const shift = (ring: readonly (readonly [number, number])[]): [number, number][] => ring.map((p): [number, number] => [p[0] - cu, p[1] - cv]);
  const outer = shift(simplifyClosed(profile.outer, 0.03));
  const holes = profile.holes.map((hole) => shift(simplifyClosed(hole, 0.03)));
  const edges = [outer, ...holes].reduce((sum, ring) => sum + ring.length, 0);
  if (edges > 90) return { ok: false, message: `The profile has ${edges} edges even after simplifying it; wrap supports up to 90. Make it simpler or smaller.` };
  // The planes of the profile's walls: each edge is a skew quad between two radial lines, taken as two triangles.
  const planes: { normal: V3; offset: number }[] = [];
  const addPlane = (a: V3, b: V3, c: V3): void => {
    const normal = unit(cross(sub(b, a), sub(c, a)));
    if (normal === undefined) return;
    const offset = dot(normal, a);
    const flip = normal[0] < -1e-9 || (Math.abs(normal[0]) <= 1e-9 && (normal[1] < -1e-9 || (Math.abs(normal[1]) <= 1e-9 && normal[2] < 0)));
    const n: V3 = flip ? [-normal[0], -normal[1], -normal[2]] : normal;
    const d = flip ? -offset : offset;
    if (!planes.some((q) => Math.abs(q.normal[0] - n[0]) + Math.abs(q.normal[1] - n[1]) + Math.abs(q.normal[2] - n[2]) < 1e-7 && Math.abs(q.offset - d) < 1e-6)) planes.push({ normal: n, offset: d });
  };
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i += 1) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const a1 = place(p[0], p[1], radius);
      const a2 = place(q[0], q[1], radius);
      const mid = place((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, radius + 1);
      const inner = place((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, radius);
      addPlane(a1, a2, add(a1, sub(mid, inner)));
    }
  }
  // Cut only near the profile: the planes run on for ever, but the work is in a box round the profile.
  const corners = [outer, ...holes].flatMap((ring) => ring.flatMap((point) => [place(point[0], point[1], radius - 1), place(point[0], point[1], radius + 1)]));
  const margin = Math.max(1, radius * 0.1);
  const window = {
    min: [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]!)) - margin) as unknown as V3,
    max: [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]!)) + margin) as unknown as V3
  };
  const sliced = sliceMesh(mesh, planes, window);
  if (typeof sliced === "string") return { ok: false, message: sliced };
  const { positions, triangles } = collapseNear(sliced.positions, sliced.triangles, 2e-4);
  const tolerance = Math.max(0.05, radius * 0.002);
  const radialOf = (point: V3): { readonly distance: number; readonly direction: V3 } => {
    const q = sub(point, fit.axisPointMm);
    const perpendicular = sub(q, scale(axis, dot(q, axis)));
    const distance = length(perpendicular);
    return { distance, direction: distance < 1e-12 ? [0, 0, 0] : scale(perpendicular, 1 / distance) };
  };
  const innerLimit = radius * Math.cos(Math.PI / fit.segments) - tolerance;
  const onWall = triangles.map(([a, b, c]) => {
    const pa = positions[a]!;
    const pb = positions[b]!;
    const pc = positions[c]!;
    // A sliver has no reliable normal; it is judged by where its corners are.
    const normal = cross(sub(pb, pa), sub(pc, pa));
    const n = length(normal) > 1e-7 ? unit(normal) : undefined;
    if (n !== undefined && Math.abs(dot(n, axis)) > 0.05) return false;
    return [pa, pb, pc].every((p) => {
      const d = radialOf(p).distance;
      const along = dot(p, axis);
      return d <= radius + tolerance && d >= innerLimit && along >= fit.axialRangeMm[0] - tolerance && along <= fit.axialRangeMm[1] + tolerance;
    });
  });
  const insideProfile = triangles.map(([a, b, c], index) => {
    if (!onWall[index]) return false;
    const centre = scale(add(positions[a]!, add(positions[b]!, positions[c]!)), 1 / 3);
    const q = sub(centre, fit.axisPointMm);
    let dTheta = Math.atan2(dot(q, e2), dot(q, e1)) - theta0;
    dTheta -= 2 * Math.PI * Math.round(dTheta / (2 * Math.PI));
    const point: [number, number] = [radius * dTheta - nudge, dot(q, axis) - along0 - nudge * 0.61];
    return insidePolygon(point, outer) && !holes.some((hole) => insidePolygon(point, hole));
  });
  const patch = insideProfile.filter(Boolean).length;
  if (patch === 0) return { ok: false, message: "The profile does not cover any of the cylindrical face where it was placed. Pick a spot on the round wall, and keep the profile inside it." };
  // The edges between the patch and everything around it.
  const owner = new Map<string, number>();
  triangles.forEach(([a, b, c], index) => {
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) owner.set(`${from}|${to}`, index);
  });
  const boundary: [number, number][] = [];
  for (let index = 0; index < triangles.length; index += 1) {
    if (!insideProfile[index]) continue;
    const [a, b, c] = triangles[index]!;
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const across = owner.get(`${to}|${from}`);
      if (across === undefined) return { ok: false, message: "The body is not a closed solid, so it cannot be wrapped." };
      if (insideProfile[across]) continue;
      if (!onWall[across]) return { ok: false, message: "The profile runs off the cylindrical face (it reaches the rim or another feature). Make it smaller or move it away from the edge." };
      boundary.push([from, to]);
    }
  }
  const signed = spec.mode === "emboss" ? spec.heightMm : -spec.heightMm;
  const raised = new Map<number, number>();
  const outPositions: number[] = positions.flatMap((p) => [p[0], p[1], p[2]]);
  const lift = (vertex: number): number => {
    let id = raised.get(vertex);
    if (id === undefined) {
      const p = positions[vertex]!;
      const { direction } = radialOf(p);
      id = outPositions.length / 3;
      outPositions.push(p[0] + direction[0] * signed, p[1] + direction[1] * signed, p[2] + direction[2] * signed);
      raised.set(vertex, id);
    }
    return id;
  };
  const outIndices: number[] = [];
  triangles.forEach(([a, b, c], index) => {
    if (insideProfile[index]) outIndices.push(lift(a), lift(b), lift(c));
    else outIndices.push(a, b, c);
  });
  for (const [a, b] of boundary) outIndices.push(a, b, lift(b), a, lift(b), lift(a));
  const checked = analyzeFaces({ positionsMm: outPositions, indices: outIndices });
  if (typeof checked === "string") return { ok: false, message: `The wrapped body is not a valid solid (${checked}). The profile may touch itself or a hole, or the cylinder may be too thin for the depth.` };
  return { ok: true, positionsMm: outPositions, indices: outIndices, notes: [`${spec.mode === "emboss" ? "Embossed" : "Debossed"} ${spec.heightMm} mm onto a Ø${(2 * radius).toFixed(1)} mm cylinder: ${patch} triangles moved, ${planes.length} wall planes imprinted (fit within ${(fit.deviation * 100).toFixed(2)}%).`] };
}
