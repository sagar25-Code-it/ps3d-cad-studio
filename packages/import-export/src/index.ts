import {
  validateCommittedRevision,
  type CommittedRevision,
  type RevisionEvidence
} from "../../evidence/src/index.js";
import {
  MAX_NATIVE_BYTES,
  fail,
  hasExactKeys,
  isRecord,
  type CadDocument,
  type DisplayUnit,
  type Result
} from "../../model-schema/src/index.js";
import { validateClosedMesh, type EvaluatedSolid } from "../../solid-kernel-api/src/index.js";

export interface StlArtifact {
  readonly bytes: ArrayBuffer;
  readonly unit: DisplayUnit;
  readonly triangleCount: number;
  readonly unitScaleFromMeters: number;
  readonly format: "binary-stl-unit-declared-by-export-flow";
}

export const NATIVE_REVISION_FORMAT = "ps3d-native-revision" as const;
export const NATIVE_REVISION_VERSION = 1 as const;

export interface NativeRevisionArtifact {
  readonly artifactFormat: typeof NATIVE_REVISION_FORMAT;
  readonly artifactVersion: typeof NATIVE_REVISION_VERSION;
  readonly document: CadDocument;
  readonly evidence: RevisionEvidence;
}

export async function parseNativeRevisionText(text: string): Promise<Result<NativeRevisionArtifact>> {
  if (new TextEncoder().encode(text).byteLength > MAX_NATIVE_BYTES) {
    return fail("RESOURCE_LIMIT", "The native revision artifact exceeds the 1 MB Phase 0 limit.", [], "Open a bounded Phase 0 artifact.");
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    return invalidNative("The selected native revision artifact is not valid JSON.");
  }
  if (!isRecord(input) || !hasExactKeys(input, ["artifactFormat", "artifactVersion", "document", "evidence"])
    || input.artifactFormat !== NATIVE_REVISION_FORMAT || input.artifactVersion !== NATIVE_REVISION_VERSION) {
    return invalidNative("The selected file is not a supported version 1 PS3D native revision artifact.");
  }
  const committed = await validateCommittedRevision({ document: input.document, evidence: input.evidence });
  if (!committed.ok) return committed;
  return { ok: true, value: asNativeArtifact(committed.value) };
}

export async function serializeNativeRevision(record: CommittedRevision): Promise<Result<string>> {
  const committed = await validateCommittedRevision(record);
  if (!committed.ok) return committed;
  const text = `${JSON.stringify(asNativeArtifact(committed.value), null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_NATIVE_BYTES) {
    return fail("RESOURCE_LIMIT", "The native revision artifact exceeds the 1 MB Phase 0 limit.", [], "Reduce the bounded command journal before export.");
  }
  return { ok: true, value: text };
}

export function exportBinaryStl(solid: EvaluatedSolid, unit: DisplayUnit): Result<StlArtifact> {
  const validation = validateClosedMesh(solid.mesh);
  if (!validation.ok) return validation;
  const triangleCount = solid.mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const bytes = new Uint8Array(buffer);
  const header = new TextEncoder().encode(`PS3D Phase 0 | unit=${unit} | closed mesh solid`);
  bytes.set(header.subarray(0, 80), 0);
  const view = new DataView(buffer);
  view.setUint32(80, triangleCount, true);
  const scale = unit === "mm" ? 1000 : 1 / 0.0254;

  let cursor = 84;
  for (let offset = 0; offset < solid.mesh.indices.length; offset += 3) {
    const a = getPoint(solid, solid.mesh.indices[offset]!, scale);
    const b = getPoint(solid, solid.mesh.indices[offset + 1]!, scale);
    const c = getPoint(solid, solid.mesh.indices[offset + 2]!, scale);
    const normal = normalizedCross(subtract(b, a), subtract(c, a));
    for (const value of [...normal, ...a, ...b, ...c]) {
      if (!Number.isFinite(value)) return fail("INVALID_SOLID_OUTPUT", "STL serialization produced a non-finite value.", [solid.bodyId], "Restore the last valid body.");
      view.setFloat32(cursor, value, true);
      cursor += 4;
    }
    view.setUint16(cursor, 0, true);
    cursor += 2;
  }
  if (cursor !== buffer.byteLength) return fail("INVALID_SOLID_OUTPUT", "STL serialization length is inconsistent.", [solid.bodyId], "Retry the export.");
  return { ok: true, value: { bytes: buffer, unit, triangleCount, unitScaleFromMeters: scale, format: "binary-stl-unit-declared-by-export-flow" } };
}

function getPoint(solid: EvaluatedSolid, index: number, scale: number): [number, number, number] {
  const offset = index * 3;
  return [solid.mesh.positions[offset]! * scale, solid.mesh.positions[offset + 1]! * scale, solid.mesh.positions[offset + 2]! * scale];
}

function subtract(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

function normalizedCross(a: readonly number[], b: readonly number[]): [number, number, number] {
  const cross: [number, number, number] = [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!
  ];
  const magnitude = Math.hypot(...cross);
  return [cross[0] / magnitude, cross[1] / magnitude, cross[2] / magnitude];
}

function asNativeArtifact(record: CommittedRevision): NativeRevisionArtifact {
  return {
    artifactFormat: NATIVE_REVISION_FORMAT,
    artifactVersion: NATIVE_REVISION_VERSION,
    document: structuredClone(record.document),
    evidence: structuredClone(record.evidence)
  };
}

function invalidNative(message: string): Result<never> {
  return fail("UNSUPPORTED_OR_CORRUPT_FILE", message, [], "Open an unmodified Phase 0 native revision artifact.");
}
