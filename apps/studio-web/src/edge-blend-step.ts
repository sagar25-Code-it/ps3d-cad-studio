import type { DesignSolidFeature, EdgeBlendGroup, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { applyEdgeBlend, type BlendFaces, type EdgeBlendSpec } from "../../../packages/workbench-geometry/src/index.js";
import { stableFaceKey } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";

/**
 * Fillet and chamfer as timeline steps ("edge-blend"). The step remembers which edges were picked (their segments and, when the
 * body had named faces, the keys of the faces beside them); replay finds those edges again on the body as it is rebuilt and
 * treats them, or says why it could not.
 */

/** The named faces of a body, when it has them and they describe its current mesh. */
export function facesOfBody(body: GeneralSolidBody): BlendFaces | undefined {
  if (body.brep === undefined || body.brep.faceTriangles.length * 3 !== body.indices.length) return undefined;
  return { faceTriangles: body.brep.faceTriangles, keys: body.brep.faces.map((face) => face.key) };
}

/** What a step asks of the kernel. */
export function blendSpecOf(step: DesignSolidFeature): EdgeBlendSpec | undefined {
  if (step.kind !== "edge-blend" || step.blendType === undefined) return undefined;
  return {
    type: step.blendType, sizeMm: step.valueMm,
    ...(step.blendEndSizeMm === undefined ? {} : { endSizeMm: step.blendEndSizeMm }),
    ...(step.blendSecondSizeMm === undefined ? {} : { secondSizeMm: step.blendSecondSizeMm }),
    ...(step.blendAngleDeg === undefined ? {} : { angleDeg: step.blendAngleDeg }),
    ...(step.blendFlip === true ? { flip: true } : {})
  };
}

export type EdgeBlendOutcome =
  | { readonly ok: true; readonly body: GeneralSolidBody; readonly notes: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Applies an edge-blend step to a body. The result keeps the body's named faces and adds one face for the blend's own surface. */
export async function blendBodyEdges(step: DesignSolidFeature, body: GeneralSolidBody): Promise<EdgeBlendOutcome> {
  const spec = blendSpecOf(step);
  const groups: readonly EdgeBlendGroup[] = step.blendEdges ?? [];
  if (spec === undefined || groups.length === 0) return { ok: false, message: "This step has no edges or no blend recorded." };
  const noun = spec.type === "fillet" ? "Fillet" : "Chamfer";
  const faces = facesOfBody(body);
  const result = applyEdgeBlend({ positionsMm: body.positionsMm, indices: body.indices }, faces, groups, spec);
  if (!result.ok) return { ok: false, message: `${noun}: ${result.message}` };
  const { feature: _feature, brep: _brep, ...kept } = body;
  void _feature; void _brep;
  const next: GeneralSolidBody = { ...kept, ...(body.feature === undefined ? {} : { feature: body.feature }), positionsMm: Array.from(result.positionsMm), indices: Array.from(result.indices) };
  const notes = result.resolved.map((group, index) => `edge ${index + 1} found ${group.via === "face-keys" ? "by its faces" : "by position"} (${group.deviationMm.toFixed(2)} mm from where it was picked)`);
  if (faces === undefined || body.brep === undefined || result.faceTriangles === undefined) return { ok: true, body: next, notes };

  // Keep the body's faces and their keys; the blend's own surface is one new face.
  const faceTriangles = Array.from(result.faceTriangles);
  const areas = new Array<number>(Math.max(body.brep.faces.length, (result.newFaceIndex ?? -1) + 1)).fill(0);
  const p = result.positionsMm;
  for (let triangle = 0; triangle < faceTriangles.length; triangle += 1) {
    const face = faceTriangles[triangle]!;
    if (face < 0) continue;
    const a = result.indices[triangle * 3]! * 3; const b = result.indices[triangle * 3 + 1]! * 3; const c = result.indices[triangle * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!; const uy = p[b + 1]! - p[a + 1]!; const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!; const vy = p[c + 1]! - p[a + 1]!; const vz = p[c + 2]! - p[a + 2]!;
    areas[face] = areas[face]! + 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  const role = `${step.id}.blend`;
  const faceList = await Promise.all(areas.map(async (area, index) => {
    const old = body.brep!.faces[index];
    return old !== undefined ? { role: old.role, key: old.key, areaMm2: area } : { role, key: await stableFaceKey(step.bodyId, role), areaMm2: area };
  }));
  const edges = new Set<string>();
  for (let corner = 0; corner < result.indices.length; corner += 3) {
    for (const [from, to] of [[result.indices[corner]!, result.indices[corner + 1]!], [result.indices[corner + 1]!, result.indices[corner + 2]!], [result.indices[corner + 2]!, result.indices[corner]!]] as const) edges.add(from < to ? `${from},${to}` : `${to},${from}`);
  }
  return {
    ok: true, notes,
    body: { ...next, brep: { topology: { vertices: result.positionsMm.length / 3, edges: edges.size, faces: faceList.length }, faces: faceList, faceTriangles, origin: "mesh-boolean" } }
  };
}

export type BlendSizes =
  | { readonly ok: true; readonly valueMm: number; readonly endSizeMm?: number; readonly secondSizeMm?: number; readonly angleDeg?: number }
  | { readonly ok: false; readonly message: string };

const NUMBER = "(\d+(?:[.,]\d+)?)";
const asNumber = (text: string): number => Number(text.replace(",", "."));

/**
 * Reads the size typed into the Fillet or Chamfer prompt. A fillet takes a radius ("2") or a radius that changes along the edge
 * ("1-4"); a chamfer takes one distance ("3"), two distances ("5x2") or a distance and an angle with the first face ("4@30").
 */
export function parseBlendSizes(type: "fillet" | "chamfer", text: string): BlendSizes {
  const raw = text.trim().toLowerCase().replace(/°|deg(?:rees)?$/gu, "").replace(/\s*mm$/u, "");
  const single = new RegExp(`^${NUMBER}$`, "u").exec(raw);
  const bad = (what: string): BlendSizes => ({ ok: false, message: what });
  const positive = (value: number): boolean => Number.isFinite(value) && value > 0 && value <= 10_000;
  if (single !== null) {
    const value = asNumber(single[1]!);
    return positive(value) ? { ok: true, valueMm: value } : bad("Enter a positive size in millimetres.");
  }
  if (type === "fillet") {
    const range = new RegExp(`^${NUMBER}\s*(?:-|:|→|to)\s*${NUMBER}$`, "u").exec(raw);
    if (range === null) return bad("Enter a radius such as 2, or a radius that changes along the edge such as 1-4.");
    const start = asNumber(range[1]!);
    const end = asNumber(range[2]!);
    if (!positive(start) || !positive(end)) return bad("Both radii must be positive.");
    return start === end ? { ok: true, valueMm: start } : { ok: true, valueMm: start, endSizeMm: end };
  }
  const pair = new RegExp(`^${NUMBER}\s*(?:x|\*|×|,)\s*${NUMBER}$`, "u").exec(raw);
  if (pair !== null) {
    const first = asNumber(pair[1]!);
    const second = asNumber(pair[2]!);
    if (!positive(first) || !positive(second)) return bad("Both distances must be positive.");
    return first === second ? { ok: true, valueMm: first } : { ok: true, valueMm: first, secondSizeMm: second };
  }
  const angled = new RegExp(`^${NUMBER}\s*(?:@|at)\s*${NUMBER}$`, "u").exec(raw);
  if (angled !== null) {
    const distance = asNumber(angled[1]!);
    const angle = asNumber(angled[2]!);
    if (!positive(distance)) return bad("The distance must be positive.");
    if (!(angle > 0 && angle < 180)) return bad("The angle must be between 0° and 180°.");
    return { ok: true, valueMm: distance, angleDeg: angle };
  }
  return bad("Enter a distance such as 3, two distances such as 5x2, or a distance and an angle such as 4@30.");
}
