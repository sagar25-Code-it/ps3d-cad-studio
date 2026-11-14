import type { DesignSolidFeature, GeneralSolidBody, HolePlacement } from "../../../packages/workbench-core/src/index.js";

/**
 * HS-15: a hole is placed on a face by its distances from two neighbouring faces, the way a person measures it, and the point is worked
 * out again from those faces at every rebuild. This module finds the three faces when the hole is made (`holePlacementFor`) and
 * solves the point from the faces as the body is now (`resolveHolePlacement`). Only flat faces take part: a hole on a curved face, or
 * beside no two flat faces at right angles to it, keeps the plain point it was picked at.
 */

type Vec3 = readonly [number, number, number];

/** A flat face of a body: its outward unit normal and the plane `normal · p = offset`. */
export interface FacePlane {
  readonly key: string;
  readonly role: string;
  readonly normal: Vec3;
  readonly offset: number;
}

type BodyFaces = Pick<GeneralSolidBody, "positionsMm" | "indices" | "brep">;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** How far a point may sit from a face's plane and still be on it (a picked point carries a little rounding). */
const ON_FACE_MM = 0.1;
/** A triangle whose normal differs from its face's mean by more than this (cosine) makes the face curved. */
const FLAT_COSINE = 0.9995;

/** The flat faces of a body that has named faces, one plane each. A curved face is left out. */
export function planarFacesOf(body: BodyFaces): readonly FacePlane[] {
  const brep = body.brep;
  if (brep === undefined || brep.faceTriangles.length * 3 !== body.indices.length) return [];
  const sums = brep.faces.map(() => ({ normal: [0, 0, 0] as [number, number, number], centroid: [0, 0, 0] as [number, number, number], area: 0 }));
  const triangles: { readonly face: number; readonly unit: Vec3 }[] = [];
  for (let triangle = 0; triangle < brep.faceTriangles.length; triangle += 1) {
    const face = brep.faceTriangles[triangle]!;
    const sum = sums[face];
    if (sum === undefined) continue;
    const point = (slot: number): Vec3 => { const base = body.indices[triangle * 3 + slot]! * 3; return [body.positionsMm[base]!, body.positionsMm[base + 1]!, body.positionsMm[base + 2]!]; };
    const a = point(0); const b = point(1); const c = point(2);
    const normal = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const twice = Math.hypot(normal[0], normal[1], normal[2]);
    if (twice < 1e-12) continue;
    const area = twice / 2;
    for (let axis = 0; axis < 3; axis += 1) { sum.normal[axis]! += normal[axis]!; sum.centroid[axis]! += ((a[axis]! + b[axis]! + c[axis]!) / 3) * area; }
    sum.area += area;
    triangles.push({ face, unit: [normal[0] / twice, normal[1] / twice, normal[2] / twice] });
  }
  const planes: FacePlane[] = [];
  sums.forEach((sum, index) => {
    const length = Math.hypot(sum.normal[0], sum.normal[1], sum.normal[2]);
    if (sum.area < 1e-9 || length < 1e-9) return;
    const normal: Vec3 = [sum.normal[0] / length, sum.normal[1] / length, sum.normal[2] / length];
    if (triangles.some((entry) => entry.face === index && dot(entry.unit, normal) < FLAT_COSINE)) return;
    const centre: Vec3 = [sum.centroid[0] / sum.area, sum.centroid[1] / sum.area, sum.centroid[2] / sum.area];
    const face = brep.faces[index]!;
    planes.push({ key: face.key, role: face.role, normal, offset: dot(normal, centre) });
  });
  return planes;
}

/**
 * The placement of a hole picked at `pointMm` on a face looking along `normal`: the face it starts on and its distances from the
 * two nearest flat faces at right angles to it (not parallel to each other), or undefined when the body has no named flat faces
 * there. The distances are how far inside each neighbour face the point lies.
 */
export function holePlacementFor(body: BodyFaces, pointMm: Vec3, normal: Vec3): HolePlacement | undefined {
  const planes = planarFacesOf(body);
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (planes.length < 3 || length < 1e-9) return undefined;
  const direction: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  let start: FacePlane | undefined;
  let startGap = Infinity;
  for (const plane of planes) {
    if (dot(plane.normal, direction) < 0.99) continue;
    const gap = Math.abs(dot(plane.normal, pointMm) - plane.offset);
    if (gap <= ON_FACE_MM && gap < startGap) { start = plane; startGap = gap; }
  }
  if (start === undefined) return undefined;
  const inside = (plane: FacePlane): number => plane.offset - dot(plane.normal, pointMm);
  const sides = planes
    .filter((plane) => plane.key !== start!.key && Math.abs(dot(plane.normal, start!.normal)) < 0.1 && inside(plane) > -ON_FACE_MM)
    .sort((left, right) => inside(left) - inside(right));
  const first = sides[0];
  const second = sides.find((plane) => first !== undefined && Math.abs(dot(plane.normal, first.normal)) < 0.5);
  if (first === undefined || second === undefined) return undefined;
  const entry = (plane: FacePlane): HolePlacement["from"][0] => ({ faceKey: plane.key, faceRole: plane.role, distanceMm: Math.max(inside(plane), 1e-3) });
  return { face: { faceKey: start.key, faceRole: start.role }, from: [entry(first), entry(second)] };
}

export type PlacementResolution =
  | { readonly ok: true; readonly pointMm: Vec3; readonly normal: Vec3 }
  | { readonly ok: false; readonly message: string };

/**
 * A face's role without the `target.` the mesh Boolean puts in front of the roles of the body it works on. A face of the plate keeps its
 * name through every cut and hole, but its role (and so its key) gains one prefix each time, so a placement made before a Boolean (or
 * read after one, as a pattern does) is matched by the role underneath.
 */
export function canonicalFaceRole(role: string): string {
  let rest = role;
  while (rest.startsWith("target.")) rest = rest.slice("target.".length);
  return rest;
}

const findFace = (planes: readonly FacePlane[], ref: { readonly faceKey: string; readonly faceRole: string }): FacePlane | undefined => {
  const wanted = canonicalFaceRole(ref.faceRole);
  return planes.find((plane) => plane.key === ref.faceKey) ?? planes.find((plane) => plane.role === ref.faceRole) ?? planes.find((plane) => canonicalFaceRole(plane.role) === wanted);
};

/** The point a placement gives on the body as it is now: on the start face, each distance inside its neighbour face. */
export function resolveHolePlacement(placement: HolePlacement, body: BodyFaces): PlacementResolution {
  const planes = planarFacesOf(body);
  const start = findFace(planes, placement.face);
  const first = findFace(planes, placement.from[0]);
  const second = findFace(planes, placement.from[1]);
  if (start === undefined || first === undefined || second === undefined) {
    const lost = start === undefined ? "the face it starts on" : first === undefined ? "its first neighbour face" : "its second neighbour face";
    return { ok: false, message: `${lost[0]!.toUpperCase()}${lost.slice(1)} is gone or no longer flat, so the hole cannot follow its faces.` };
  }
  const rows: readonly (readonly [Vec3, number])[] = [[start.normal, start.offset], [first.normal, first.offset - placement.from[0].distanceMm], [second.normal, second.offset - placement.from[1].distanceMm]];
  const [r0, r1, r2] = rows as readonly [readonly [Vec3, number], readonly [Vec3, number], readonly [Vec3, number]];
  const determinant = dot(r0[0], cross(r1[0], r2[0]));
  if (Math.abs(determinant) < 0.2) return { ok: false, message: "The faces the hole was placed from no longer stand at an angle to each other, so the hole cannot follow them." };
  // Solve A p = b with the rows as the normals: p = (b0 (n1 x n2) + b1 (n2 x n0) + b2 (n0 x n1)) / det.
  const c12 = cross(r1[0], r2[0]); const c20 = cross(r2[0], r0[0]); const c01 = cross(r0[0], r1[0]);
  const point: [number, number, number] = [0, 1, 2].map((axis) => (r0[1] * c12[axis]! + r1[1] * c20[axis]! + r2[1] * c01[axis]!) / determinant) as [number, number, number];
  if (!point.every(Number.isFinite)) return { ok: false, message: "The hole position could not be worked out from its faces." };
  return { ok: true, pointMm: point, normal: start.normal };
}

export interface ResolvedHolePosition {
  readonly pointMm: Vec3;
  readonly normal: Vec3;
  /** Present when the hole was placed from faces but could not follow them: it stays at its last position and says why. */
  readonly note?: string;
}

/** Where a hole step sits on `body`: from its faces when it was placed from faces and they are there, otherwise the point it stores. */
export function resolvedHolePosition(step: DesignSolidFeature, body: { readonly positionsMm: readonly number[]; readonly indices?: readonly number[] | undefined; readonly brep?: GeneralSolidBody["brep"] | undefined }): ResolvedHolePosition | undefined {
  const stored = step.holePositionMm;
  const normal = step.holeNormal;
  if (stored === undefined || normal === undefined) return undefined;
  const fallback: ResolvedHolePosition = { pointMm: stored as Vec3, normal: normal as Vec3 };
  if (step.holePlacement === undefined) return fallback;
  if (body.indices === undefined || body.brep === undefined) return { ...fallback, note: "This hole was placed from faces, but the solid has no named faces here, so it stays where it was last placed." };
  const resolved = resolveHolePlacement(step.holePlacement, { positionsMm: body.positionsMm, indices: body.indices, brep: body.brep });
  return resolved.ok ? { pointMm: resolved.pointMm, normal: resolved.normal } : { ...fallback, note: `${resolved.message} It stays where it was last placed.` };
}

/* ---- HS-15 review: the faces a hole is measured from are named, shown and can be chosen again ---- */

const trimMm = (value: number): string => String(Number(value.toFixed(2)));

/**
 * What a flat face is called to a person: the side it looks to ("Right", "Back", "Top"...) and where it is ("x = 30 mm"), so two parallel
 * faces (an outer wall and the wall of a pocket) never share a name. A face that is not square to an axis is an "Angled face".
 */
export function faceName(plane: FacePlane): string {
  const axes: readonly { readonly index: number; readonly letter: string; readonly positive: string; readonly negative: string }[] = [
    { index: 0, letter: "x", positive: "Right", negative: "Left" },
    { index: 1, letter: "y", positive: "Back", negative: "Front" },
    { index: 2, letter: "z", positive: "Top", negative: "Bottom" }
  ];
  for (const axis of axes) {
    const component = plane.normal[axis.index]!;
    if (Math.abs(component) < 0.999) continue;
    return `${component > 0 ? axis.positive : axis.negative} face (${axis.letter} = ${trimMm(component > 0 ? plane.offset : -plane.offset)} mm)`;
  }
  return "Angled face";
}

/** A flat face a hole can be measured from, with how far the hole is inside it. */
export interface FaceChoice {
  readonly faceKey: string;
  readonly faceRole: string;
  readonly name: string;
  readonly distanceMm: number;
  readonly normal: Vec3;
}

/** The faces of a face-placed hole as the solid is now: their names, the faces it could be measured from instead, and the keys in use. */
export interface PlacementReferences {
  readonly start: { readonly faceKey: string; readonly faceRole: string; readonly name: string };
  /** The two faces the hole is measured from now, in the placement's order, by their keys in the solid as it is now. */
  readonly current: readonly [FaceChoice, FaceChoice];
  /** Every flat face at right angles to the start face that the hole lies inside, nearest first. */
  readonly choices: readonly FaceChoice[];
}

/** Names the faces of a placement on `body` and lists the faces it could be measured from; undefined when the placement cannot be resolved there. */
export function placementReferences(placement: HolePlacement, body: BodyFaces): PlacementReferences | undefined {
  const planes = planarFacesOf(body);
  const start = findFace(planes, placement.face);
  const first = findFace(planes, placement.from[0]);
  const second = findFace(planes, placement.from[1]);
  const at = resolveHolePlacement(placement, body);
  if (start === undefined || first === undefined || second === undefined || !at.ok) return undefined;
  const choiceOf = (plane: FacePlane): FaceChoice => ({ faceKey: plane.key, faceRole: plane.role, name: faceName(plane), distanceMm: plane.offset - dot(plane.normal, at.pointMm), normal: plane.normal });
  const choices = planes
    .filter((plane) => plane.key !== start.key && Math.abs(dot(plane.normal, start.normal)) < 0.1 && plane.offset - dot(plane.normal, at.pointMm) > -ON_FACE_MM)
    .map(choiceOf)
    .sort((left, right) => left.distanceMm - right.distanceMm);
  return { start: { faceKey: start.key, faceRole: start.role, name: faceName(start) }, current: [choiceOf(first), choiceOf(second)], choices };
}

export type Repick = { readonly ok: true; readonly placement: HolePlacement } | { readonly ok: false; readonly message: string };

/**
 * The placement with one or both of its measuring faces replaced. The new distance is how far the hole already is inside the new face,
 * so choosing another face does not move the hole. Two faces that are the same, or parallel, cannot pin a point and are refused.
 */
export function repickedPlacement(placement: HolePlacement, references: PlacementReferences, picks: { readonly first?: FaceChoice | undefined; readonly second?: FaceChoice | undefined }): Repick {
  const first = picks.first ?? references.current[0];
  const second = picks.second ?? references.current[1];
  if (first.faceKey === second.faceKey) return { ok: false, message: `Both distances are measured from the ${first.name}. Pick two different faces.` };
  if (Math.abs(dot(first.normal, second.normal)) > 0.5) return { ok: false, message: `The ${first.name} and the ${second.name} face the same way, so they cannot fix a point together. Pick a face that stands at an angle to the other.` };
  const entry = (choice: FaceChoice, kept: HolePlacement["from"][0], changed: boolean): HolePlacement["from"][0] => changed ? { faceKey: choice.faceKey, faceRole: choice.faceRole, distanceMm: Math.max(choice.distanceMm, 1e-3) } : kept;
  return { ok: true, placement: { ...placement, from: [entry(first, placement.from[0], picks.first !== undefined), entry(second, placement.from[1], picks.second !== undefined)] } };
}

/** The border of one named flat face as line segments, for outlining it in the view: the edges used by exactly one of its triangles. */
export function faceOutline(body: BodyFaces, ref: { readonly faceKey: string; readonly faceRole: string }): readonly (readonly [Vec3, Vec3])[] {
  const brep = body.brep;
  if (brep === undefined || brep.faceTriangles.length * 3 !== body.indices.length) return [];
  const wanted = canonicalFaceRole(ref.faceRole);
  const index = brep.faces.findIndex((face) => face.key === ref.faceKey) >= 0 ? brep.faces.findIndex((face) => face.key === ref.faceKey)
    : brep.faces.findIndex((face) => face.role === ref.faceRole) >= 0 ? brep.faces.findIndex((face) => face.role === ref.faceRole)
      : brep.faces.findIndex((face) => canonicalFaceRole(face.role) === wanted);
  if (index < 0) return [];
  const point = (vertex: number): Vec3 => [body.positionsMm[vertex * 3]!, body.positionsMm[vertex * 3 + 1]!, body.positionsMm[vertex * 3 + 2]!];
  const keyOf = (p: Vec3): string => p.map((value) => Math.round(value * 1e4)).join(",");
  const edges = new Map<string, { a: Vec3; b: Vec3; count: number }>();
  brep.faceTriangles.forEach((face, triangle) => {
    if (face !== index) return;
    const corners = [0, 1, 2].map((slot) => point(body.indices[triangle * 3 + slot]!));
    for (let slot = 0; slot < 3; slot += 1) {
      const a = corners[slot]!; const b = corners[(slot + 1) % 3]!;
      const ka = keyOf(a); const kb = keyOf(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const found = edges.get(key);
      if (found === undefined) edges.set(key, { a, b, count: 1 }); else found.count += 1;
    }
  });
  return [...edges.values()].filter((edge) => edge.count === 1).map((edge) => [edge.a, edge.b] as const);
}
