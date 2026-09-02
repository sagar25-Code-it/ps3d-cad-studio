export type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

function normalize(value: unknown, seen: Set<object>): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not permit non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not permit cyclic arrays.");
    seen.add(value);
    const result = value.map((entry) => normalize(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not permit cyclic objects.");
    seen.add(value);
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        throw new TypeError(`Canonical JSON does not permit ${typeof entry} at '${key}'.`);
      }
      result[key] = normalize(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError(`Canonical JSON does not permit ${typeof value}.`);
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value, new Set<object>()));
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
