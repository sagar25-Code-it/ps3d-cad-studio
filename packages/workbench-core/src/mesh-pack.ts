/**
 * Compact storage of tessellated meshes.
 *
 * A body used to be stored as two JSON number lists, so a torus of 9,216 triangles took 1.7 MB and a project with a few such bodies could
 * not travel in one MCP call (4 MB) or be opened comfortably. The mesh now travels as one record of base64 typed arrays:
 *
 *   { "packedMesh": { "v": 1, "vertices": N, "pos": { "t": "f32", "n": M, "d": "<base64>" }, "idx": ..., "weld": ..., "faces": ... } }
 *
 * - `pos` are the distinct vertex positions as little-endian float32 when every coordinate is exactly a float32 value, and as float64
 *   otherwise. Nothing is ever rounded: a packed mesh unpacks to the very numbers it was packed from.
 * - `weld` maps each of the N stored vertices to its distinct position, so a mesh that repeats every corner per triangle (flat shading)
 *   is restored exactly, repeats included. It is absent when no position repeats.
 * - `idx` is the triangle index list; it is absent when the index list is simply 0, 1, 2, ... (unindexed triangles).
 * - `faces` is the face number of each triangle (the B-rep link), when the body has one.
 *
 * The packed form is the SERIALISED form only. In memory a body keeps `positionsMm` and `indices` as plain lists, every reader of the
 * model is unchanged, and projects saved before this existed (plain lists) are read as they always were. Save and open are exact.
 */

export const PACKED_MESH_VERSION = 1;

type ArrayType = "f32" | "f64" | "u16" | "u32" | "i16" | "i32";

export interface PackedArray {
  readonly t: ArrayType;
  /** How many numbers the array holds. */
  readonly n: number;
  /** Little-endian bytes as base64. */
  readonly d: string;
}

export interface PackedMesh {
  readonly v: 1;
  /** The number of stored vertices (positions / 3). */
  readonly vertices: number;
  readonly pos: PackedArray;
  readonly idx?: PackedArray;
  readonly weld?: PackedArray;
  readonly faces?: PackedArray;
}

export type MeshUnpack<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** The largest vertex and index counts a mesh may unpack to (the body validators allow 300,000 numbers). */
const MAX_NUMBERS = 600_000;
/** A mesh below this many numbers is not worth packing. */
const MIN_PACKED_NUMBERS = 90;

// ---------------------------------------------------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) table[ALPHABET.charCodeAt(index)] = index;
  return table;
})();

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2]! : 0;
    chunk += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | (b >> 4)]!
      + (index + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : "=")
      + (index + 2 < bytes.length ? ALPHABET[c & 63]! : "=");
    if (chunk.length >= 8_192) { parts.push(chunk); chunk = ""; }
  }
  parts.push(chunk);
  return parts.join("");
}

function fromBase64(text: string, expectedBytes: number): Uint8Array | undefined {
  if (text.length % 4 !== 0 || text.length > 8_000_000) return undefined;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const length = (text.length / 4) * 3 - padding;
  if (length !== expectedBytes) return undefined;
  const out = new Uint8Array(length);
  let write = 0;
  for (let index = 0; index < text.length; index += 4) {
    const codes = [text.charCodeAt(index), text.charCodeAt(index + 1), text.charCodeAt(index + 2), text.charCodeAt(index + 3)];
    const values = codes.map((code, offset) => (code === 61 && offset >= 2 ? 0 : code < 128 ? LOOKUP[code]! : -1));
    if (values.some((value) => value < 0)) return undefined;
    const triple = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    if (write < length) out[write++] = (triple >> 16) & 255;
    if (write < length) out[write++] = (triple >> 8) & 255;
    if (write < length) out[write++] = triple & 255;
  }
  return out;
}

const BYTES: Readonly<Record<ArrayType, number>> = { f32: 4, f64: 8, u16: 2, u32: 4, i16: 2, i32: 4 };

function packNumbers(values: readonly number[], type: ArrayType): PackedArray {
  const buffer = new ArrayBuffer(values.length * BYTES[type]);
  const view = new DataView(buffer);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const at = index * BYTES[type];
    switch (type) {
      case "f32": view.setFloat32(at, value, true); break;
      case "f64": view.setFloat64(at, value, true); break;
      case "u16": view.setUint16(at, value, true); break;
      case "u32": view.setUint32(at, value, true); break;
      case "i16": view.setInt16(at, value, true); break;
      case "i32": view.setInt32(at, value, true); break;
    }
  }
  return { t: type, n: values.length, d: toBase64(new Uint8Array(buffer)) };
}

function unpackNumbers(packed: unknown, allowed: readonly ArrayType[], label: string): MeshUnpack<readonly number[]> {
  if (typeof packed !== "object" || packed === null) return { ok: false, message: `${label} is missing.` };
  const record = packed as Record<string, unknown>;
  const type = record.t;
  if (typeof type !== "string" || !(allowed as readonly string[]).includes(type)) return { ok: false, message: `${label} has an unsupported number type.` };
  const count = record.n;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_NUMBERS) return { ok: false, message: `${label} has an invalid length.` };
  if (typeof record.d !== "string") return { ok: false, message: `${label} has no data.` };
  const kind = type as ArrayType;
  const bytes = fromBase64(record.d, count * BYTES[kind]);
  if (bytes === undefined) return { ok: false, message: `${label} is damaged: its data does not match its length.` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    const at = index * BYTES[kind];
    switch (kind) {
      case "f32": out[index] = view.getFloat32(at, true); break;
      case "f64": out[index] = view.getFloat64(at, true); break;
      case "u16": out[index] = view.getUint16(at, true); break;
      case "u32": out[index] = view.getUint32(at, true); break;
      case "i16": out[index] = view.getInt16(at, true); break;
      case "i32": out[index] = view.getInt32(at, true); break;
    }
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------------------------------------------------
// One mesh
// ---------------------------------------------------------------------------------------------------------------------

function isNumberList(value: unknown): value is readonly number[] {
  return Array.isArray(value) && (value.length === 0 || typeof value[0] === "number");
}

/** Whether every coordinate is exactly a float32 value, so storing it as one loses nothing. */
export function isFloat32Exact(positions: readonly number[]): boolean {
  for (let index = 0; index < positions.length; index += 1) if (Math.fround(positions[index]!) !== positions[index]) return false;
  return true;
}

function unsignedType(maximum: number): "u16" | "u32" {
  return maximum <= 0xffff ? "u16" : "u32";
}

/** Packs one mesh, or returns undefined when it is too small to bother or is not a clean list of numbers. */
export function packMesh(positions: readonly number[], indices: readonly number[], faceTriangles?: readonly number[]): PackedMesh | undefined {
  if (positions.length + indices.length < MIN_PACKED_NUMBERS || positions.length % 3 !== 0 || positions.length > MAX_NUMBERS || indices.length > MAX_NUMBERS) return undefined;
  const vertices = positions.length / 3;
  for (let index = 0; index < positions.length; index += 1) if (!Number.isFinite(positions[index]!)) return undefined;
  let sequential = indices.length === vertices;
  for (let index = 0; index < indices.length; index += 1) {
    const value = indices[index]!;
    if (!Number.isInteger(value) || value < 0 || value >= vertices) return undefined;
    if (value !== index) sequential = false;
  }
  const useFloat32 = isFloat32Exact(positions);
  // Distinct positions, keyed by their exact stored bytes.
  const keyOf = (index: number): string => `${positions[index * 3]},${positions[index * 3 + 1]},${positions[index * 3 + 2]}`;
  const seen = new Map<string, number>();
  const distinct: number[] = [];
  const weld: number[] = [];
  for (let index = 0; index < vertices; index += 1) {
    const key = keyOf(index);
    let slot = seen.get(key);
    if (slot === undefined) {
      slot = distinct.length / 3;
      seen.set(key, slot);
      distinct.push(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
    }
    weld.push(slot);
  }
  const distinctCount = distinct.length / 3;
  const welded = distinctCount < vertices;
  let faces: PackedArray | undefined;
  if (faceTriangles !== undefined) {
    let low = 0;
    let high = 0;
    for (const face of faceTriangles) {
      if (!Number.isInteger(face)) return undefined;
      low = Math.min(low, face);
      high = Math.max(high, face);
    }
    faces = packNumbers(faceTriangles, low >= -32_768 && high <= 32_767 ? "i16" : "i32");
  }
  return {
    v: PACKED_MESH_VERSION,
    vertices,
    pos: packNumbers(welded ? distinct : positions, useFloat32 ? "f32" : "f64"),
    ...(sequential ? {} : { idx: packNumbers(indices, unsignedType(vertices - 1)) }),
    ...(welded ? { weld: packNumbers(weld, unsignedType(distinctCount - 1)) } : {}),
    ...(faces === undefined ? {} : { faces })
  };
}

export interface UnpackedMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  readonly faceTriangles?: readonly number[];
}

/** Restores a mesh exactly as it was before `packMesh`. Every list is bounds-checked, so a damaged or hostile record is refused with a reason. */
export function unpackMesh(packed: unknown): MeshUnpack<UnpackedMesh> {
  if (typeof packed !== "object" || packed === null || Array.isArray(packed)) return { ok: false, message: "A packed mesh must be an object." };
  const record = packed as Record<string, unknown>;
  if (record.v !== PACKED_MESH_VERSION) return { ok: false, message: `This packed mesh has version ${String(record.v)}; this build reads version ${PACKED_MESH_VERSION}.` };
  const allowedKeys = ["v", "vertices", "pos", "idx", "weld", "faces"];
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) return { ok: false, message: "A packed mesh has a field this build does not know." };
  const vertices = record.vertices;
  if (typeof vertices !== "number" || !Number.isInteger(vertices) || vertices < 1 || vertices * 3 > MAX_NUMBERS) return { ok: false, message: "A packed mesh has an invalid vertex count." };
  const pos = unpackNumbers(record.pos, ["f32", "f64"], "The packed positions");
  if (!pos.ok) return pos;
  if (pos.value.length % 3 !== 0) return { ok: false, message: "The packed positions are not a whole number of points." };
  let positions: readonly number[] = pos.value;
  if (Object.hasOwn(record, "weld")) {
    const weld = unpackNumbers(record.weld, ["u16", "u32"], "The packed vertex map");
    if (!weld.ok) return weld;
    const distinct = pos.value.length / 3;
    if (weld.value.length !== vertices || weld.value.some((slot) => slot >= distinct)) return { ok: false, message: "The packed vertex map points outside the packed positions." };
    const expanded = new Array<number>(vertices * 3);
    for (let index = 0; index < vertices; index += 1) {
      const slot = weld.value[index]! * 3;
      expanded[index * 3] = pos.value[slot]!;
      expanded[index * 3 + 1] = pos.value[slot + 1]!;
      expanded[index * 3 + 2] = pos.value[slot + 2]!;
    }
    positions = expanded;
  } else if (positions.length !== vertices * 3) {
    return { ok: false, message: "The packed positions do not match the vertex count." };
  }
  let indices: readonly number[];
  if (Object.hasOwn(record, "idx")) {
    const decoded = unpackNumbers(record.idx, ["u16", "u32"], "The packed triangle indices");
    if (!decoded.ok) return decoded;
    if (decoded.value.some((index) => index >= vertices)) return { ok: false, message: "The packed triangle indices point outside the vertices." };
    indices = decoded.value;
  } else {
    indices = Array.from({ length: vertices }, (_, index) => index);
  }
  let faceTriangles: readonly number[] | undefined;
  if (Object.hasOwn(record, "faces")) {
    const decoded = unpackNumbers(record.faces, ["i16", "i32"], "The packed face numbers");
    if (!decoded.ok) return decoded;
    faceTriangles = decoded.value;
  }
  return { ok: true, value: { positionsMm: positions, indices, ...(faceTriangles === undefined ? {} : { faceTriangles }) } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Whole projects, operations and results
// ---------------------------------------------------------------------------------------------------------------------

const MAX_DEPTH = 12;

/** Applies `visit` to every record under `value` (not into number lists), sharing every part that did not change. */
function mapRecords(value: unknown, visit: (record: Record<string, unknown>) => Record<string, unknown> | undefined, depth = 0): unknown {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length === 0 || typeof value[0] === "number") return value;
    let changed: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const next = mapRecords(value[index], visit, depth + 1);
      if (next !== value[index]) { changed ??= value.slice(); changed[index] = next; }
    }
    return changed ?? value;
  }
  const record = value as Record<string, unknown>;
  const replaced = visit(record);
  const base = replaced ?? record;
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(base)) {
    const next = mapRecords(base[key], visit, depth + 1);
    if (next !== base[key]) { copy ??= { ...base }; copy[key] = next; }
  }
  return copy ?? base;
}

/**
 * Replaces the plain mesh lists of every body and component mesh under `value` with their packed form. The input is not changed. A mesh
 * that is too small, or not a clean list of numbers, stays as it is.
 */
export function packMeshes<T>(value: T): T {
  return mapRecords(value, (record) => {
    if (!isNumberList(record.positionsMm) || !isNumberList(record.indices) || Object.hasOwn(record, "packedMesh")) return undefined;
    const brep = typeof record.brep === "object" && record.brep !== null && !Array.isArray(record.brep) ? record.brep as Record<string, unknown> : undefined;
    const faceSource = brep !== undefined && isNumberList(brep.faceTriangles) ? brep.faceTriangles : isNumberList(record.faceTriangles) ? record.faceTriangles : undefined;
    const packed = packMesh(record.positionsMm, record.indices, faceSource);
    if (packed === undefined) return undefined;
    // The record keeps its field order: the packed mesh takes the place of positionsMm.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key === "positionsMm") out["packedMesh"] = packed;
      else if (key === "indices") continue;
      else if (key === "faceTriangles" && faceSource === record.faceTriangles) continue;
      else if (key === "brep" && brep !== undefined && faceSource === brep.faceTriangles) {
        const { faceTriangles: _faces, ...brepRest } = brep;
        void _faces;
        out[key] = brepRest;
      } else out[key] = record[key];
    }
    return out;
  }) as T;
}

/**
 * The reverse of `packMeshes`: every record that carries a `packedMesh` gets its plain lists back, in their original place. Input without
 * packed meshes comes back as the same object. A damaged packed mesh is refused with the reason.
 */
export function unpackMeshes(value: unknown): MeshUnpack<unknown> {
  let failure: string | undefined;
  const result = mapRecords(value, (record) => {
    if (failure !== undefined || !Object.hasOwn(record, "packedMesh")) return undefined;
    const unpacked = unpackMesh(record.packedMesh);
    if (!unpacked.ok) { failure = `${typeof record.id === "string" ? `Body ${record.id}: ` : ""}${unpacked.message}`; return undefined; }
    const faces = unpacked.value.faceTriangles;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key === "packedMesh") {
        out["positionsMm"] = unpacked.value.positionsMm;
        out["indices"] = unpacked.value.indices;
        if (faces !== undefined && !(typeof record.brep === "object" && record.brep !== null && !Array.isArray(record.brep))) out["faceTriangles"] = faces;
      } else if (key === "brep" && faces !== undefined && typeof record.brep === "object" && record.brep !== null && !Array.isArray(record.brep)) {
        // faceTriangles sits after faces, where the type declares it.
        const brep: Record<string, unknown> = {};
        for (const brepKey of Object.keys(record.brep)) {
          brep[brepKey] = (record.brep as Record<string, unknown>)[brepKey];
          if (brepKey === "faces") brep["faceTriangles"] = faces;
        }
        if (!Object.hasOwn(brep, "faceTriangles")) brep["faceTriangles"] = faces;
        out[key] = brep;
      } else out[key] = record[key];
    }
    return out;
  });
  return failure === undefined ? { ok: true, value: result } : { ok: false, message: failure };
}

/** Whether any record under the value carries a packed mesh (a cheap check before unpacking). */
export function hasPackedMeshes(value: unknown): boolean {
  let found = false;
  mapRecords(value, (record) => { if (Object.hasOwn(record, "packedMesh")) found = true; return undefined; });
  return found;
}
