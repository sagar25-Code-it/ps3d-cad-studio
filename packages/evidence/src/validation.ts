import {
  APPLICATION_VERSION,
  ENGINE_PROFILE,
  SKETCH_SOLVER_PROFILE,
  fail,
  hasExactKeys,
  isRecord,
  isStableId,
  validateCadDocument,
  type CadDocument,
  type Result
} from "../../model-schema/src/index.js";
import {
  BUILD_IDENTITY,
  canonicalizeJson,
  commandJournalPrefixHash,
  semanticDocumentHash,
  type CommittedRevision,
  type RevisionEvidence
} from "./index.js";

const HASH = /^[a-f0-9]{64}$/u;

export function isRevisionEvidence(value: unknown, document?: CadDocument): value is RevisionEvidence {
  if (!isRecord(value) || !hasExactKeys(value, [
    "evidenceSchemaVersion", "documentId", "revision", "parentRevision", "semanticHash", "commandJournalPrefixHash",
    "engineProfile", "engineIdentity", "policies", "body", "replayVerification"
  ])) return false;
  if (value.evidenceSchemaVersion !== 3 || !isStableId(value.documentId) || !isRevision(value.revision)
    || !(value.parentRevision === null || isRevision(value.parentRevision)) || !isHash(value.semanticHash)
    || !isHash(value.commandJournalPrefixHash) || value.engineProfile !== ENGINE_PROFILE
    || value.replayVerification !== "not-yet-cross-browser-qualified") return false;
  if (document !== undefined && (value.documentId !== document.id || value.revision !== document.revision
    || value.parentRevision !== document.parentRevision || value.engineProfile !== document.engineProfile)) return false;
  return isEngineIdentity(value.engineIdentity) && isPolicies(value.policies) && isBodyEvidence(value.body);
}

export async function validateCommittedRevision(value: unknown): Promise<Result<CommittedRevision>> {
  if (!isRecord(value) || !hasExactKeys(value, ["document", "evidence"])) return invalid("The committed revision envelope is malformed.");
  const document = validateCadDocument(value.document);
  if (!document.ok) return document;
  if (!isRevisionEvidence(value.evidence, document.value)) return invalid("Revision evidence is malformed or belongs to another document revision.");
  const [semanticHash, journalHash] = await Promise.all([
    semanticDocumentHash(document.value), commandJournalPrefixHash(document.value.commandJournal)
  ]);
  if (semanticHash !== value.evidence.semanticHash || journalHash !== value.evidence.commandJournalPrefixHash) {
    return invalid("Revision evidence does not bind the supplied semantic document and journal.");
  }
  return { ok: true, value: { document: document.value, evidence: structuredClone(value.evidence) } };
}

export function revisionEvidenceEqual(left: RevisionEvidence, right: RevisionEvidence): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function isEngineIdentity(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "applicationVersion", "nativeSchemaVersion", "sketchSolverProfile", "solidEngineProfile", "sourceCompilerProfile",
    "evaluatorSourceSet", "kernel", "wasmArtifactSha256", "wasmDisposition"
  ])) return false;
  return value.applicationVersion === APPLICATION_VERSION && value.nativeSchemaVersion === 1
    && value.sketchSolverProfile === SKETCH_SOLVER_PROFILE && value.solidEngineProfile === ENGINE_PROFILE
    && value.sourceCompilerProfile === "typescript@7.0.2+vite@7.3.6+esbuild@0.28.2"
    && value.wasmArtifactSha256 === null && value.wasmDisposition === "not-used-by-production-engine"
    && isSourceSet(value.evaluatorSourceSet) && isKernel(value.kernel);
}

function isSourceSet(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["buildId", "algorithm", "sha256"])
    && value.buildId === BUILD_IDENTITY.buildId && value.algorithm === BUILD_IDENTITY.sourceSet.algorithm
    && value.sha256 === BUILD_IDENTITY.sourceSet.sha256 && isHash(value.sha256);
}

function isKernel(value: unknown): boolean {
  const expected = BUILD_IDENTITY.kernel;
  return isRecord(value) && hasExactKeys(value, ["adapter", "adapterVersion", "dependency", "dependencyVersion", "representation"])
    && value.adapter === expected.adapter && value.adapterVersion === expected.adapterVersion
    && value.dependency === expected.dependency && value.dependencyVersion === expected.dependencyVersion
    && value.representation === expected.representation;
}

function isPolicies(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["units", "circularSegments", "minimumWallMeters", "meshHashAlgorithm"])
    && value.units === "SI-meters-radians" && value.circularSegments === 96 && value.minimumWallMeters === 0.001
    && value.meshHashAlgorithm === "ps3d-canonical-mesh-v1-sha256";
}

function isBodyEvidence(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "canonicalMeshHash", "boundsMeters", "surfaceAreaSquareMeters", "volumeCubicMeters", "topology",
    "toleranceMeters", "validityChecks"
  ]) || !isStableId(value.id) || !isHash(value.canonicalMeshHash) || !isPositive(value.surfaceAreaSquareMeters)
    || !isPositive(value.volumeCubicMeters) || !isPositive(value.toleranceMeters)) return false;
  const checks = ["finite", "nondegenerate", "closed", "manifold", "oriented", "positive-volume"];
  return isBounds(value.boundsMeters) && isTopology(value.topology) && Array.isArray(value.validityChecks)
    && value.validityChecks.length === checks.length && value.validityChecks.every((check, index) => check === checks[index]);
}

function isBounds(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["min", "max", "size"]) || !isTriple(value.min) || !isTriple(value.max) || !isTriple(value.size)) return false;
  const minimum = value.min;
  const maximum = value.max;
  return value.size.every((part, axis) => part > 0 && Math.abs(part - (maximum[axis]! - minimum[axis]!)) <= 1e-12);
}

function isTopology(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["vertices", "edges", "triangles", "components", "genus", "closed", "manifold", "consistentlyOriented"])
    && isPositiveInteger(value.vertices) && isPositiveInteger(value.edges) && isPositiveInteger(value.triangles)
    && (value.triangles as number) <= 250_000 && (value.vertices as number) <= 750_000
    && isPositiveInteger(value.components) && isRevision(value.genus) && value.closed === true
    && value.manifold === true && value.consistentlyOriented === true;
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === "number" && Number.isFinite(part));
}

function isHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function isPositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function isRevision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

function invalid(message: string): Result<never> {
  return fail("UNSUPPORTED_OR_CORRUPT_FILE", message, [], "Open an unmodified Phase 0 native revision artifact created by this qualified build.");
}
