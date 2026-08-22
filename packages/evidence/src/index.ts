import buildIdentityJson from "../../../provenance/BUILD_IDENTITY.json" with { type: "json" };
import { SKETCH_SOLVER_PROFILE, type CadDocument, type CommandJournalEntry } from "../../model-schema/src/index.js";
import type { EvaluatedSolid, KernelIdentity, ModelMesh } from "../../solid-kernel-api/src/index.js";

export interface BuildIdentity {
  readonly identitySchemaVersion: 1;
  readonly buildId: string;
  readonly sourceSet: {
    readonly algorithm: "ps3d-evaluator-source-closure-v1-sha256";
    readonly sha256: string;
    readonly paths: readonly string[];
  };
  readonly kernel: KernelIdentity & { readonly engineProfile: string };
}

export const BUILD_IDENTITY = buildIdentityJson as BuildIdentity;

export interface RevisionEvidence {
  readonly evidenceSchemaVersion: 3;
  readonly documentId: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly semanticHash: string;
  readonly commandJournalPrefixHash: string;
  readonly engineProfile: string;
  readonly engineIdentity: {
    readonly applicationVersion: string;
    readonly nativeSchemaVersion: number;
    readonly sketchSolverProfile: string;
    readonly solidEngineProfile: string;
    readonly sourceCompilerProfile: "typescript@7.0.2+vite@7.3.6+esbuild@0.28.2";
    readonly evaluatorSourceSet: {
      readonly buildId: string;
      readonly algorithm: "ps3d-evaluator-source-closure-v1-sha256";
      readonly sha256: string;
    };
    readonly kernel: KernelIdentity;
    readonly wasmArtifactSha256: null;
    readonly wasmDisposition: "not-used-by-production-engine";
  };
  readonly policies: {
    readonly units: "SI-meters-radians";
    readonly circularSegments: 96;
    readonly minimumWallMeters: 0.001;
    readonly meshHashAlgorithm: "ps3d-canonical-mesh-v1-sha256";
  };
  readonly body: {
    readonly id: string;
    readonly canonicalMeshHash: string;
    readonly boundsMeters: EvaluatedSolid["measurements"]["boundsMeters"];
    readonly surfaceAreaSquareMeters: number;
    readonly volumeCubicMeters: number;
    readonly topology: EvaluatedSolid["topology"];
    readonly toleranceMeters: number;
    readonly validityChecks: readonly ["finite", "nondegenerate", "closed", "manifold", "oriented", "positive-volume"];
  };
  readonly replayVerification: "not-yet-cross-browser-qualified";
}

export interface CommittedRevision {
  readonly document: CadDocument;
  readonly evidence: RevisionEvidence;
}

export function canonicalizeJson(value: unknown): string {
  const result = canonicalize(value, new Set<object>(), { nodes: 0 }, 0);
  if (new TextEncoder().encode(result).byteLength > 4_000_000) throw new TypeError("Canonical JSON exceeds the bounded evidence payload size.");
  return result;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const owned = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function semanticDocumentHash(document: CadDocument): Promise<string> {
  return sha256Hex(canonicalizeJson(document));
}

export async function commandJournalPrefixHash(journal: readonly CommandJournalEntry[]): Promise<string> {
  let prefix = await sha256Hex("ps3d-command-journal/v1");
  for (const entry of journal) prefix = await sha256Hex(canonicalizeJson({ previousPrefixHash: prefix, entry }));
  return prefix;
}

export async function revisionEvidencePayloadHash(evidence: RevisionEvidence): Promise<string> {
  return sha256Hex(`ps3d-revision-evidence/v3\0${canonicalizeJson(evidence)}`);
}

export async function canonicalMeshHash(mesh: ModelMesh): Promise<string> {
  validateHashableMesh(mesh);
  const vertexCount = mesh.positions.length / 3;
  const oldVertexKeys: string[] = [];
  const unique = new Map<string, Uint8Array>();
  const used = new Set<number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    for (let axis = 0; axis < 3; axis += 1) {
      const raw = mesh.positions[vertex * 3 + axis]!;
      if (!Number.isFinite(raw)) throw new TypeError("Canonical mesh hash rejects non-finite positions.");
      view.setFloat64(axis * 8, Object.is(raw, -0) ? 0 : raw, false);
    }
    const key = bytesToHex(bytes);
    oldVertexKeys.push(key);
    unique.set(key, bytes);
  }

  const vertices = [...unique.entries()].sort((left, right) => compareBytes(left[1], right[1]));
  const canonicalIndex = new Map(vertices.map(([key], index) => [key, index]));
  const triangles: Array<[number, number, number]> = [];
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const original = [mesh.indices[offset]!, mesh.indices[offset + 1]!, mesh.indices[offset + 2]!] as const;
    if (original.some((index) => index >= vertexCount)) throw new TypeError("Canonical mesh hash rejects out-of-range indices.");
    original.forEach((index) => used.add(index));
    const triangle: [number, number, number] = [
      canonicalIndex.get(oldVertexKeys[original[0]]!)!,
      canonicalIndex.get(oldVertexKeys[original[1]]!)!,
      canonicalIndex.get(oldVertexKeys[original[2]]!)!
    ];
    if (new Set(triangle).size !== 3) throw new TypeError("Canonical mesh hash rejects collapsed triangles.");
    triangles.push(minimumCyclicRotation(triangle));
  }
  if (used.size !== vertexCount) throw new TypeError("Canonical mesh hash rejects unused vertices.");
  triangles.sort(compareTriples);

  const header = new TextEncoder().encode("ps3d-canonical-mesh/v1\0");
  const length = header.length + 8 + vertices.length * 24 + triangles.length * 12;
  if (!Number.isSafeInteger(length)) throw new TypeError("Canonical mesh hash rejects an unsafe stream length.");
  const stream = new Uint8Array(length);
  stream.set(header, 0);
  const view = new DataView(stream.buffer);
  let cursor = header.length;
  view.setUint32(cursor, vertices.length, false);
  cursor += 4;
  view.setUint32(cursor, triangles.length, false);
  cursor += 4;
  for (const [, bytes] of vertices) {
    stream.set(bytes, cursor);
    cursor += bytes.length;
  }
  for (const triangle of triangles) {
    for (const index of triangle) {
      view.setUint32(cursor, index, false);
      cursor += 4;
    }
  }
  return sha256Hex(stream);
}

export async function buildRevisionEvidence(document: CadDocument, solid: EvaluatedSolid): Promise<RevisionEvidence> {
  assertBuildIdentity(document, solid);
  const [semanticHash, meshHash, journalHash] = await Promise.all([
    semanticDocumentHash(document), canonicalMeshHash(solid.mesh), commandJournalPrefixHash(document.commandJournal)
  ]);
  return {
    evidenceSchemaVersion: 3,
    documentId: document.id,
    revision: document.revision,
    parentRevision: document.parentRevision,
    semanticHash,
    commandJournalPrefixHash: journalHash,
    engineProfile: solid.engineProfile,
    engineIdentity: {
      applicationVersion: document.applicationVersion,
      nativeSchemaVersion: document.schemaVersion,
      sketchSolverProfile: SKETCH_SOLVER_PROFILE,
      solidEngineProfile: solid.engineProfile,
      sourceCompilerProfile: "typescript@7.0.2+vite@7.3.6+esbuild@0.28.2",
      evaluatorSourceSet: {
        buildId: BUILD_IDENTITY.buildId,
        algorithm: BUILD_IDENTITY.sourceSet.algorithm,
        sha256: BUILD_IDENTITY.sourceSet.sha256
      },
      kernel: structuredClone(solid.kernelIdentity),
      wasmArtifactSha256: null,
      wasmDisposition: "not-used-by-production-engine"
    },
    policies: {
      units: "SI-meters-radians", circularSegments: 96, minimumWallMeters: 0.001,
      meshHashAlgorithm: "ps3d-canonical-mesh-v1-sha256"
    },
    body: {
      id: solid.bodyId,
      canonicalMeshHash: meshHash,
      boundsMeters: structuredClone(solid.measurements.boundsMeters),
      surfaceAreaSquareMeters: solid.measurements.surfaceAreaSquareMeters,
      volumeCubicMeters: solid.measurements.volumeCubicMeters,
      topology: structuredClone(solid.topology),
      toleranceMeters: solid.toleranceMeters,
      validityChecks: ["finite", "nondegenerate", "closed", "manifold", "oriented", "positive-volume"]
    },
    replayVerification: "not-yet-cross-browser-qualified"
  };
}

function assertBuildIdentity(document: CadDocument, solid: EvaluatedSolid): void {
  const expected = BUILD_IDENTITY.kernel;
  if (document.engineProfile !== solid.engineProfile || expected.engineProfile !== solid.engineProfile
    || expected.adapter !== solid.kernelIdentity.adapter || expected.adapterVersion !== solid.kernelIdentity.adapterVersion
    || expected.dependency !== solid.kernelIdentity.dependency || expected.dependencyVersion !== solid.kernelIdentity.dependencyVersion
    || expected.representation !== solid.kernelIdentity.representation || !/^[a-f0-9]{64}$/u.test(BUILD_IDENTITY.sourceSet.sha256)) {
    throw new TypeError("Solid or evaluator build identity does not match the qualified build manifest.");
  }
}

function validateHashableMesh(mesh: ModelMesh): void {
  if (!(mesh?.positions instanceof Float64Array) || !(mesh?.indices instanceof Uint32Array)) {
    throw new TypeError("Canonical mesh hash requires Float64Array positions and Uint32Array indices.");
  }
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0) {
    throw new TypeError("Canonical mesh hash rejects empty or misaligned positions.");
  }
  if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0 || mesh.indices.length / 3 > 250_000) {
    throw new TypeError("Canonical mesh hash rejects empty, non-triangle, or oversized index buffers.");
  }
  const vertexCount = mesh.positions.length / 3;
  if (vertexCount > 750_000) throw new TypeError("Canonical mesh hash rejects oversized vertex buffers.");
  for (const coordinate of mesh.positions) {
    if (!Number.isFinite(coordinate)) throw new TypeError("Canonical mesh hash rejects non-finite positions.");
  }
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset]!;
    const b = mesh.indices[offset + 1]!;
    const c = mesh.indices[offset + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) throw new TypeError("Canonical mesh hash rejects out-of-range indices.");
    if (a === b || b === c || c === a) throw new TypeError("Canonical mesh hash rejects collapsed triangles.");
  }
}

function canonicalize(value: unknown, ancestors: Set<object>, state: { nodes: number }, depth: number): string {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 128) throw new TypeError("Canonical JSON exceeds its node or depth limit.");
  if (value === null) return "null";
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (value.length > 1_000_000 || hasLoneSurrogate(value)) throw new TypeError("Canonical JSON rejects oversized or lone-surrogate strings.");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    guardCycle(value, ancestors);
    if (Reflect.ownKeys(value).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length > 0
      || Object.keys(value).length !== value.length) {
      throw new TypeError("Canonical JSON rejects sparse arrays or custom array properties.");
    }
    const items = value.map((item, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || item === undefined) throw new TypeError("Canonical JSON rejects accessors or undefined array values.");
      return canonicalize(item, ancestors, state, depth + 1);
    });
    ancestors.delete(value);
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as object;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical JSON accepts only plain objects.");
    guardCycle(object, ancestors);
    const keys = Reflect.ownKeys(object);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("Canonical JSON rejects symbol keys.");
    const record = object as Record<string, unknown>;
    const fields = (keys as string[]).sort().map((key) => {
      if (key.length > 256 || hasLoneSurrogate(key)) throw new TypeError("Canonical JSON rejects oversized or lone-surrogate keys.");
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        throw new TypeError("Canonical JSON rejects accessors, hidden fields, and undefined values.");
      }
      return `${JSON.stringify(key)}:${canonicalize(record[key], ancestors, state, depth + 1)}`;
    });
    ancestors.delete(object);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON rejects ${typeof value}.`);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function guardCycle(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) throw new TypeError("Canonical JSON rejects cyclic data.");
  ancestors.add(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function minimumCyclicRotation(value: [number, number, number]): [number, number, number] {
  const rotations: Array<[number, number, number]> = [value, [value[1], value[2], value[0]], [value[2], value[0], value[1]]];
  rotations.sort(compareTriples);
  return rotations[0]!;
}

function compareTriples(left: readonly number[], right: readonly number[]): number {
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
}

export * from "./validation.js";
