import type {
  SurfaceAnalysisRequest,
  SurfaceDependencyChange,
  SurfaceEvaluationReceipt,
  SurfaceFeatureRequest,
  SurfaceInvalidationReport
} from "./types.js";

const HEX = "0123456789abcdef";

export function canonicalSurfaceJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value, new Set<object>()));
}

export async function surfaceSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSurfaceJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let output = "";
  for (const byte of new Uint8Array(digest)) output += `${HEX[byte >>> 4]}${HEX[byte & 0x0f]}`;
  return output;
}

export function collectSurfaceDependencyKeys(request: SurfaceFeatureRequest | SurfaceAnalysisRequest): readonly string[] {
  const keys = new Set<string>();
  collectDependencyValues(request, keys, new Set<object>());
  return [...keys].sort();
}

export async function surfaceInvalidationDigest(
  artifactId: string,
  requestDigest: string,
  dependencyKeys: readonly string[]
): Promise<string> {
  return surfaceSha256({
    artifactId,
    dependencyKeys: [...dependencyKeys].sort(),
    requestDigest,
    schema: "ps3d.surface-invalidation.v1"
  });
}

export async function invalidateSurfaceReceipts(
  change: SurfaceDependencyChange,
  receipts: readonly SurfaceEvaluationReceipt[]
): Promise<SurfaceInvalidationReport> {
  const changed = [...new Set(change.changedKeys)].sort();
  const invalidated: string[] = [];
  const retained: string[] = [];

  for (const receipt of [...receipts].sort((left, right) => left.artifactId.localeCompare(right.artifactId))) {
    const affected = receipt.dependencyKeys.some((key) => changed.includes(key));
    (affected ? invalidated : retained).push(receipt.artifactId);
  }

  return {
    changeDigest: await surfaceSha256({ changedKeys: changed, schema: "ps3d.surface-change.v1" }),
    invalidatedArtifactIds: invalidated,
    retainedArtifactIds: retained
  };
}

function collectDependencyValues(value: unknown, keys: Set<string>, visited: Set<object>): void {
  if (value === null || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) collectDependencyValues(item, keys, visited);
      return;
    }

    const record = value as Record<string, unknown>;
    if (record["representation"] === "exact-brep" && typeof record["contentDigest"] === "string") {
      keys.add(`shape:${record["contentDigest"]}`);
    }
    if (record["referenceVersion"] === 1 && typeof record["key"] === "string") {
      keys.add(`topology:${record["key"]}`);
      if (typeof record["lineageDigest"] === "string") keys.add(`lineage:${record["lineageDigest"]}`);
    }

    for (const child of Object.values(record)) collectDependencyValues(child, keys, visited);
  } finally {
    visited.delete(value);
  }
}

function toCanonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Surface contract values must contain only finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || typeof value === "undefined") {
    throw new TypeError(`Surface contract cannot canonicalize ${typeof value}.`);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported surface contract value.");
  if (ancestors.has(value)) throw new TypeError("Surface contract values cannot contain cycles.");

  if (value instanceof ArrayBuffer) {
    return { $binary: "ArrayBuffer", bytes: Array.from(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      $binary: value.constructor.name,
      bytes: Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toCanonicalValue(item, ancestors));
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) throw new TypeError(`Surface contract field '${key}' is undefined.`);
      canonical[key] = toCanonicalValue(record[key], ancestors);
    }
    return canonical;
  } finally {
    ancestors.delete(value);
  }
}
