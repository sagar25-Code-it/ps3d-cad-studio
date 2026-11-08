import type { GeneralSolidBody } from "./types.js";

/**
 * The control cage of a SubD form body: the polygons the smooth surface is subdivided from. A body that carries one is a "form" that
 * can still be edited (move vertices, extrude faces, add edge loops); finishing the form drops the cage and leaves a plain solid.
 */
export interface SubdCageData {
  /** Flat x, y, z of the cage vertices in millimetres. */
  readonly verticesMm: readonly number[];
  /** Vertex indices of each face, counter-clockwise seen from outside. */
  readonly faces: readonly (readonly number[])[];
  /** Catmull-Clark subdivision levels the body was tessellated at (0 to 5). */
  readonly levels: number;
}

export const MAX_CAGE_VERTICES = 8192;
export const MAX_CAGE_FACES_STORED = 4096;

/** Whether a stored cage has the right shape and in-range indices (the topology is checked when it is subdivided). */
export function validSubdCageData(value: unknown): value is SubdCageData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.every((key) => ["verticesMm", "faces", "levels"].includes(key))) return false;
  const { verticesMm, faces, levels } = record;
  if (!Array.isArray(verticesMm) || verticesMm.length < 9 || verticesMm.length % 3 !== 0 || verticesMm.length > MAX_CAGE_VERTICES * 3
    || verticesMm.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 1_000_000)) return false;
  if (typeof levels !== "number" || !Number.isInteger(levels) || levels < 0 || levels > 5) return false;
  const count = verticesMm.length / 3;
  return Array.isArray(faces) && faces.length >= 1 && faces.length <= MAX_CAGE_FACES_STORED
    && faces.every((face) => Array.isArray(face) && face.length >= 3 && face.length <= 16 && face.every((vertex) => typeof vertex === "number" && Number.isInteger(vertex) && vertex >= 0 && vertex < count));
}

/** An open surface (not a solid): it has area and edges but no volume. */
export function isSurfaceBody(body: Pick<GeneralSolidBody, "feature">): boolean {
  return body.feature?.operation === "surface";
}

/** A SubD form that is still editable through its control cage. */
export function isFormBody(body: Pick<GeneralSolidBody, "subd">): boolean {
  return body.subd !== undefined;
}
