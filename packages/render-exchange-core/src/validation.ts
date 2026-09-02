import type {
  AssetScheme,
  AssetUriPolicy,
  ContentReference,
  RenderExchangeDiagnostic,
  RgbColor,
  RgbaColor,
  Sha256Digest,
  StableId
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/iu;

export const DEFAULT_ASSET_URI_POLICY: AssetUriPolicy = Object.freeze({
  allowedSchemes: ["asset", "blob", "data", "https", "urn"] as const,
  allowedHttpsOrigins: [] as const,
  allowEmbeddedData: false,
  maximumEmbeddedBytes: 4_000_000,
  requireDigest: true,
  forbidCredentials: true,
  forbidFragments: true
});

export function diagnostic(
  code: RenderExchangeDiagnostic["code"],
  severity: RenderExchangeDiagnostic["severity"],
  path: string,
  message: string,
  recovery: string
): RenderExchangeDiagnostic {
  return { code, severity, path, message, recovery };
}

export function isStableId(value: string): value is StableId {
  return ID_PATTERN.test(value);
}

export function isSha256Digest(value: string): value is Sha256Digest {
  return DIGEST_PATTERN.test(value);
}

export function validateStableId(value: string, path: string): readonly RenderExchangeDiagnostic[] {
  return isStableId(value) ? [] : [diagnostic(
    "INVALID_ID", "error", path, `Identifier '${value}' is not a stable namespaced ID.`,
    "Use a lowercase namespaced identifier such as 'scene:main'."
  )];
}

export function validateDigest(value: string, path: string): readonly RenderExchangeDiagnostic[] {
  return isSha256Digest(value) ? [] : [diagnostic(
    "INVALID_DIGEST", "error", path, "Content digest must be lowercase SHA-256 with the 'sha256:' prefix.",
    "Hash the exact bytes and provide all 64 hexadecimal characters."
  )];
}

export function validateContentReference(
  reference: ContentReference,
  path: string,
  policy: AssetUriPolicy = DEFAULT_ASSET_URI_POLICY
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [...validateDigest(reference.contentDigest, `${path}.contentDigest`)];
  if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0) diagnostics.push(diagnostic(
    "INVALID_NUMBER", "error", `${path}.byteLength`, "Asset byte length must be a non-negative safe integer.", "Use the exact byte count."
  ));
  if (!MEDIA_TYPE_PATTERN.test(reference.mediaType)) diagnostics.push(diagnostic(
    "INVALID_EXCHANGE_JOB", "error", `${path}.mediaType`, "Asset media type is invalid.", "Use a registered type such as image/png."
  ));
  diagnostics.push(...validateAssetUri(reference.uri, reference.byteLength, path, policy));
  return diagnostics;
}

export function validateAssetUri(
  uri: string,
  declaredByteLength: number,
  path: string,
  policy: AssetUriPolicy = DEFAULT_ASSET_URI_POLICY
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  if (uri.includes("\\") || uri.split(/[/?#]/u).some((part) => part === "..")) diagnostics.push(diagnostic(
    "ASSET_TRAVERSAL_DENIED", "error", `${path}.uri`, "Asset URI contains a traversal segment or backslash.",
    "Use a normalized content-addressed URI without parent traversal."
  ));
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return [...diagnostics, diagnostic(
      "ASSET_SCHEME_DENIED", "error", `${path}.uri`, "Asset URI is not absolute.",
      "Use an approved absolute URI such as asset:, urn:, blob:, data:, or https:."
    )];
  }
  const scheme = parsed.protocol.slice(0, -1) as AssetScheme;
  if (!policy.allowedSchemes.includes(scheme)) diagnostics.push(diagnostic(
    "ASSET_SCHEME_DENIED", "error", `${path}.uri`, `URI scheme '${scheme}' is not allowed.`, "Use an explicitly approved asset scheme."
  ));
  if (policy.forbidCredentials && (parsed.username.length > 0 || parsed.password.length > 0)) diagnostics.push(diagnostic(
    "ASSET_CREDENTIALS_DENIED", "error", `${path}.uri`, "Credentials must not be embedded in an asset URI.",
    "Use an authenticated fetch layer and a credential-free content reference."
  ));
  if (policy.forbidFragments && parsed.hash.length > 0) diagnostics.push(diagnostic(
    "ASSET_FRAGMENT_DENIED", "error", `${path}.uri`, "URI fragments are forbidden by policy.", "Remove the fragment."
  ));
  if (scheme === "https" && policy.allowedHttpsOrigins.length > 0 && !policy.allowedHttpsOrigins.includes(parsed.origin)) diagnostics.push(diagnostic(
    "ASSET_ORIGIN_DENIED", "error", `${path}.uri`, `HTTPS origin '${parsed.origin}' is not allowlisted.`, "Use an allowlisted origin or ingest the asset first."
  ));
  if (scheme === "data" && !policy.allowEmbeddedData) diagnostics.push(diagnostic(
    "ASSET_SCHEME_DENIED", "error", `${path}.uri`, "Embedded data URIs are disabled.", "Store the asset in the content-addressed asset service."
  ));
  if (scheme === "data" && declaredByteLength > policy.maximumEmbeddedBytes) diagnostics.push(diagnostic(
    "ASSET_TOO_LARGE", "error", `${path}.byteLength`, "Embedded asset exceeds the policy limit.", "Store it as a separate content-addressed asset."
  ));
  return diagnostics;
}

export function validateFinite(value: number, path: string, options: { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {}): readonly RenderExchangeDiagnostic[] {
  if (!Number.isFinite(value) || (options.integer === true && !Number.isSafeInteger(value))
    || (options.min !== undefined && value < options.min) || (options.max !== undefined && value > options.max)) {
    return [diagnostic(
      "INVALID_NUMBER", "error", path, `Value '${String(value)}' is outside the allowed numeric range.`, "Supply a finite value inside the documented range."
    )];
  }
  return [];
}

export function validateColor(color: RgbColor | RgbaColor, path: string): readonly RenderExchangeDiagnostic[] {
  return color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1) ? [] : [diagnostic(
    "INVALID_COLOR", "error", path, "Color channels must be finite normalized values from 0 through 1.", "Normalize every color channel."
  )];
}

export function validateUniqueIds(items: readonly StableId[], path: string): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  const seen = new Set<string>();
  items.forEach((id, index) => {
    diagnostics.push(...validateStableId(id, `${path}[${index}]`));
    if (seen.has(id)) diagnostics.push(diagnostic(
      "DUPLICATE_ID", "error", `${path}[${index}]`, `Duplicate identifier '${id}'.`, "Assign one stable ID per object."
    ));
    seen.add(id);
  });
  return diagnostics;
}

export function hasErrors(diagnostics: readonly RenderExchangeDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}
