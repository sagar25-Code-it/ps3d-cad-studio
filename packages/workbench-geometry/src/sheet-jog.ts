import { sheetFrameOf, type SheetMesh } from "./sheet-edge-flange.js";

type Vec3 = readonly [number, number, number];

/**
 * A jog: two opposite bends that step a flat sheet up or down. The bends share one radius and angle, joined by a straight sloping
 * web, so the far side of the sheet ends up parallel to the near side, `offsetMm` higher or lower.
 */
export interface JogSpec {
  /** Plate edge the jog line runs parallel to (index as for an edge flange). */
  readonly edgeIndex: number;
  /** Distance from that edge, into the plate, to where the first bend starts. */
  readonly positionMm: number;
  /** Signed step of the far side along the sheet normal. */
  readonly offsetMm: number;
  readonly angleDeg: number;
  readonly innerRadiusMm: number;
}

/** The shape of a jog's centre line (the mid-thickness surface, K = 0.5), worked out from the spec and the sheet thickness. */
export interface JogProfile {
  readonly thicknessMm: number;
  /** +1 for a step up, -1 for a step down. */
  readonly sign: 1 | -1;
  readonly alphaRad: number;
  /** Radius of the centre line through each bend: inner radius + half the thickness. */
  readonly centreRadiusMm: number;
  /** Length of the straight web between the two bends. */
  readonly webMm: number;
  /** Length of sheet the jog uses up: two bend arcs and the web, measured along the centre line. */
  readonly zoneMm: number;
  /** How far the jog advances across the sheet, measured flat. */
  readonly runMm: number;
}

export type JogProfileResult = { readonly ok: true; readonly profile: JogProfile } | { readonly ok: false; readonly message: string };

/** Works out a jog's centre line, or says why the numbers cannot make one (a step too small for two bends of that radius and angle). */
export function jogProfile(spec: Pick<JogSpec, "offsetMm" | "angleDeg" | "innerRadiusMm">, thicknessMm: number): JogProfileResult {
  const { offsetMm, angleDeg, innerRadiusMm } = spec;
  if (![offsetMm, angleDeg, innerRadiusMm, thicknessMm].every(Number.isFinite) || offsetMm === 0 || !(thicknessMm > 0) || innerRadiusMm < 0) return { ok: false, message: "A jog needs a non-zero offset, a positive sheet thickness and a bend radius of 0 or more." };
  if (!(angleDeg >= 1 && angleDeg <= 89)) return { ok: false, message: "A jog angle must be between 1° and 89°." };
  const alpha = angleDeg * Math.PI / 180;
  const centre = innerRadiusMm + thicknessMm / 2;
  const height = Math.abs(offsetMm);
  const bendRise = 2 * centre * (1 - Math.cos(alpha));
  const web = (height - bendRise) / Math.sin(alpha);
  if (web < -1e-9) return { ok: false, message: `A ${height} mm step is too small for two ${angleDeg}° bends of inner radius ${innerRadiusMm} mm in ${thicknessMm} mm sheet; the bends alone rise ${bendRise.toFixed(2)} mm. Use a larger step, a smaller angle or a smaller radius.` };
  const webMm = Math.max(0, web);
  return {
    ok: true,
    profile: {
      thicknessMm, sign: offsetMm > 0 ? 1 : -1, alphaRad: alpha, centreRadiusMm: centre, webMm,
      zoneMm: 2 * centre * alpha + webMm,
      runMm: 2 * centre * Math.sin(alpha) + webMm * Math.cos(alpha)
    }
  };
}

interface CentrePoint {
  /** Across the sheet from the start of the jog, and height above the sheet's mid-plane. */
  readonly across: number;
  readonly height: number;
  /** Unit normal of the sheet there (across, height). */
  readonly normalAcross: number;
  readonly normalHeight: number;
}

/** The centre line of the jog `x` along its length (0 to `zoneMm`), with the sheet normal there. */
export function jogCentreAt(profile: JogProfile, x: number): CentrePoint {
  const { alphaRad: alpha, centreRadiusMm: rc, webMm: web, sign } = profile;
  const arc = rc * alpha;
  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);
  let across: number;
  let height: number;
  let heading: number;
  if (x <= arc) {
    const phi = rc === 0 ? 0 : x / rc;
    across = rc * Math.sin(phi);
    height = rc * (1 - Math.cos(phi));
    heading = phi;
  } else if (x <= arc + web) {
    const along = x - arc;
    across = rc * sinA + along * cosA;
    height = rc * (1 - cosA) + along * sinA;
    heading = alpha;
  } else {
    const phi = rc === 0 ? 0 : Math.min(alpha, (x - arc - web) / rc);
    across = rc * sinA + web * cosA + rc * (sinA - Math.sin(alpha - phi));
    height = rc * (1 - cosA) + web * sinA + rc * (Math.cos(alpha - phi) - cosA);
    heading = alpha - phi;
  }
  const signedHeading = sign * heading;
  return { across, height: sign * height, normalAcross: -Math.sin(signedHeading), normalHeight: Math.cos(signedHeading) };
}

const KEY_SCALE = 1e5;
const pointKey = (x: number, y: number, z: number): string => `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)},${Math.round(z * KEY_SCALE)}`;

export type JogResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly profile: JogProfile }
  | { readonly ok: false; readonly message: string };

/** Merges vertices that sit at the same place so edges are shared between triangles, and drops vertices no triangle uses. */
function weld(positions: readonly number[], indices: readonly number[]): { positions: number[]; indices: number[] } {
  const remap = new Map<string, number>();
  const outPositions: number[] = [];
  const outIndices: number[] = [];
  const target = (index: number): number => {
    const key = pointKey(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
    let found = remap.get(key);
    if (found === undefined) {
      found = outPositions.length / 3;
      remap.set(key, found);
      outPositions.push(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
    }
    return found;
  };
  for (let c = 0; c + 2 < indices.length; c += 3) {
    const a = target(indices[c]!);
    const b = target(indices[c + 1]!);
    const d = target(indices[c + 2]!);
    if (a !== b && b !== d && a !== d) outIndices.push(a, b, d);
  }
  return { positions: outPositions, indices: outIndices };
}

/** Cuts every triangle that straddles the plane `distance(point) = 0`, sharing the new vertex between the triangles on either side of an edge. */
function slice(positions: number[], indices: number[], distanceOf: (x: number, y: number, z: number) => number): number[] {
  const eps = 1e-7;
  const d: number[] = [];
  for (let i = 0; i < positions.length / 3; i += 1) d.push(distanceOf(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!));
  const cuts = new Map<number, number>();
  const cutVertex = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * 4_194_304 + hi;
    let found = cuts.get(key);
    if (found === undefined) {
      const t = d[lo]! / (d[lo]! - d[hi]!);
      found = positions.length / 3;
      positions.push(
        positions[lo * 3]! + (positions[hi * 3]! - positions[lo * 3]!) * t,
        positions[lo * 3 + 1]! + (positions[hi * 3 + 1]! - positions[lo * 3 + 1]!) * t,
        positions[lo * 3 + 2]! + (positions[hi * 3 + 2]! - positions[lo * 3 + 2]!) * t
      );
      d.push(0);
      cuts.set(key, found);
    }
    return found;
  };
  const out: number[] = [];
  for (let c = 0; c + 2 < indices.length; c += 3) {
    const tri = [indices[c]!, indices[c + 1]!, indices[c + 2]!];
    const side = tri.map((index) => (d[index]! > eps ? 1 : d[index]! < -eps ? -1 : 0));
    if (!(side.includes(1) && side.includes(-1))) { out.push(...tri); continue; }
    const zero = side.indexOf(0);
    if (zero >= 0) {
      // One vertex lies on the plane and the other two on opposite sides: split along the line from it to the opposite edge.
      const z = tri[zero]!;
      const a = tri[(zero + 1) % 3]!;
      const b = tri[(zero + 2) % 3]!;
      const p = cutVertex(a, b);
      out.push(z, a, p, z, p, b);
      continue;
    }
    // Two vertices on one side and one alone on the other.
    const lone = [0, 1, 2].find((k) => side[k] !== side[(k + 1) % 3] && side[k] !== side[(k + 2) % 3])!;
    const l = tri[lone]!;
    const a = tri[(lone + 1) % 3]!;
    const b = tri[(lone + 2) % 3]!;
    const pa = cutVertex(l, a);
    const pb = cutVertex(l, b);
    out.push(l, pa, pb, pa, a, b, pa, b, pb);
  }
  return out;
}

/** The distances along the jog (from its start) at which the sheet is cut so each facet follows the bends closely. */
export function jogCutPositions(profile: JogProfile): readonly number[] {
  const arc = profile.centreRadiusMm * profile.alphaRad;
  const steps = Math.max(3, Math.ceil(profile.alphaRad * 180 / Math.PI / 10));
  const cuts: number[] = [0];
  for (let k = 1; k <= steps; k += 1) cuts.push(arc * k / steps);
  if (profile.webMm > 1e-9) cuts.push(arc + profile.webMm);
  for (let k = 1; k <= steps; k += 1) cuts.push(arc + profile.webMm + arc * k / steps);
  return cuts.filter((value, index) => index === 0 || value - cuts[index - 1]! > 1e-9);
}

/**
 * Bends a jog into a sheet-metal body. The sheet beyond the jog line is lifted by the offset and brought nearer by the difference
 * between the bends' developed length and the ground they cover; the strip in between is wrapped round the two bends with its
 * thickness kept, so a flat plate becomes the stepped profile. `base` names the edge and the thickness (as for an edge flange),
 * `body` is the sheet as it is now. Refused when something taller than the sheet stands in the strip the jog bends, such as a flange
 * running across it. The jogged body is centre-line (K = 0.5) exact, so its volume is the plate's.
 */
export function jogSheetMesh(body: SheetMesh, base: SheetMesh, normalIn: Vec3, spec: JogSpec): JogResult {
  const frame = sheetFrameOf(base, normalIn);
  if (frame === undefined) return { ok: false, message: "This body has no flat top face with a thickness to put a jog in." };
  const edge = frame.edges[spec.edgeIndex];
  if (edge === undefined) return { ok: false, message: `There is no edge ${spec.edgeIndex}; this plate has ${frame.edges.length} (0 to ${frame.edges.length - 1}).` };
  const made = jogProfile(spec, frame.thicknessMm);
  if (!made.ok) return made;
  const profile = made.profile;
  if (!(spec.positionMm >= 0)) return { ok: false, message: "The jog position cannot be negative." };
  const inward: Vec3 = [-edge.outward[0], -edge.outward[1], -edge.outward[2]];
  const normal = frame.normal;
  const start = edge.startMm;
  const acrossOf = (x: number, y: number, z: number): number => (x - start[0]) * inward[0] + (y - start[1]) * inward[1] + (z - start[2]) * inward[2];
  const heightOf = (x: number, y: number, z: number): number => x * normal[0] + y * normal[1] + z * normal[2];
  const welded = weld(body.positionsMm, body.indices);
  let positions = welded.positions;
  let indices = welded.indices;
  let maxAcross = -Infinity;
  for (let i = 0; i < positions.length; i += 3) maxAcross = Math.max(maxAcross, acrossOf(positions[i]!, positions[i + 1]!, positions[i + 2]!));
  const zoneStart = spec.positionMm;
  const zoneEnd = zoneStart + profile.zoneMm;
  if (!(maxAcross > zoneEnd + 1e-6)) return { ok: false, message: `The jog needs ${profile.zoneMm.toFixed(2)} mm of sheet for its bends starting ${zoneStart.toFixed(2)} mm from edge ${spec.edgeIndex}, and the sheet only reaches ${maxAcross.toFixed(2)} mm. Move the jog nearer the edge or make the sheet longer.` };
  for (const x of jogCutPositions(profile)) {
    const plane = zoneStart + x;
    indices = slice(positions, indices, (px, py, pz) => acrossOf(px, py, pz) - plane);
  }
  // The sheet inside the strip must be just the sheet: its heights lie in one thickness-wide band.
  const thickness = frame.thicknessMm;
  let low = Infinity;
  let high = -Infinity;
  const used = new Set(indices);
  for (const vertex of used) {
    const a = acrossOf(positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!);
    if (a < zoneStart - 1e-7 || a > zoneEnd + 1e-7) continue;
    const h = heightOf(positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!);
    low = Math.min(low, h);
    high = Math.max(high, h);
  }
  if (!Number.isFinite(low)) return { ok: false, message: "There is no sheet where this jog would bend." };
  if (high - low > thickness + 1e-4) return { ok: false, message: `Something ${(high - low).toFixed(2)} mm tall stands in the strip this jog bends (the sheet is ${thickness.toFixed(2)} mm thick), for example a flange or an earlier jog. Make the jog first, or move it clear.` };
  const midHeight = low + thickness / 2;
  const shiftAcross = profile.runMm - profile.zoneMm;
  const rise = profile.sign * Math.abs(spec.offsetMm);
  const out = positions.slice();
  for (const vertex of used) {
    const px = positions[vertex * 3]!;
    const py = positions[vertex * 3 + 1]!;
    const pz = positions[vertex * 3 + 2]!;
    const a = acrossOf(px, py, pz);
    if (a <= zoneStart + 1e-9) continue;
    const h = heightOf(px, py, pz);
    let dAcross: number;
    let dHeight: number;
    if (a >= zoneEnd - 1e-9) {
      dAcross = shiftAcross;
      dHeight = rise;
    } else {
      const along = a - zoneStart;
      const centre = jogCentreAt(profile, along);
      const offset = h - midHeight;
      dAcross = centre.across + offset * centre.normalAcross - along;
      dHeight = centre.height + offset * centre.normalHeight - offset;
    }
    out[vertex * 3] = px + inward[0] * dAcross + normal[0] * dHeight;
    out[vertex * 3 + 1] = py + inward[1] * dAcross + normal[1] * dHeight;
    out[vertex * 3 + 2] = pz + inward[2] * dAcross + normal[2] * dHeight;
  }
  const final = weld(out, indices);
  return { ok: true, positionsMm: final.positions, indices: final.indices, profile };
}
