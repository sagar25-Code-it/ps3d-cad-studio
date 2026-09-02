import type { Sha256Digest } from "./types.js";

const HEX = "0123456789abcdef";

export function canonicalRenderExchangeJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value, new Set<object>()));
}

export async function renderExchangeSha256(value: unknown): Promise<Sha256Digest> {
  const bytes = new TextEncoder().encode(canonicalRenderExchangeJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += `${HEX[byte >>> 4]}${HEX[byte & 0x0f]}`;
  return output;
}

function toCanonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Render/exchange values must contain only finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || typeof value === "undefined") {
    throw new TypeError(`Render/exchange values cannot canonicalize ${typeof value}.`);
  }
  if (typeof value !== "object") throw new TypeError("Unsupported render/exchange value.");
  if (ancestors.has(value)) throw new TypeError("Render/exchange values cannot contain cycles.");

  if (value instanceof ArrayBuffer) return { $binary: "ArrayBuffer", hex: bytesToHex(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      $binary: value.constructor.name,
      hex: bytesToHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toCanonicalValue(item, ancestors));
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) throw new TypeError(`Render/exchange field '${key}' is undefined.`);
      result[key] = toCanonicalValue(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
