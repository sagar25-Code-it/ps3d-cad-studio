import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "provenance", "BUILD_IDENTITY.json");

export async function calculateEvaluatorSourceHash() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const hash = createHash("sha256");
  for (const relativePath of manifest.sourceSet.paths) {
    hash.update(relativePath, "utf8");
    hash.update(Uint8Array.of(0));
    hash.update(canonicalSourceBytes(await readFile(resolve(root, ...relativePath.split("/")))));
    hash.update(Uint8Array.of(0));
  }
  return { actual: hash.digest("hex"), manifest };
}

function canonicalSourceBytes(bytes) {
  let crlfCount = 0;
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) crlfCount += 1;
  }
  if (crlfCount === 0) return bytes;
  const canonical = new Uint8Array(bytes.length - crlfCount);
  let target = 0;
  for (let source = 0; source < bytes.length; source += 1) {
    if (bytes[source] === 13 && bytes[source + 1] === 10) continue;
    canonical[target] = bytes[source];
    target += 1;
  }
  return canonical;
}

export async function verifyEvaluatorSourceIdentity() {
  const { actual, manifest } = await calculateEvaluatorSourceHash();
  if (actual !== manifest.sourceSet.sha256) {
    throw new Error(`Evaluator source identity mismatch: manifest=${manifest.sourceSet.sha256} actual=${actual}`);
  }
  return actual;
}

function validateManifest(manifest) {
  exactKeys(manifest, ["identitySchemaVersion", "buildId", "sourceSet", "kernel"]);
  exactKeys(manifest.sourceSet, ["algorithm", "sha256", "paths"]);
  exactKeys(manifest.kernel, ["engineProfile", "adapter", "adapterVersion", "dependency", "dependencyVersion", "representation"]);
  if (manifest.identitySchemaVersion !== 1 || manifest.sourceSet.algorithm !== "ps3d-evaluator-source-closure-v1-sha256"
    || !/^[a-f0-9]{64}$/u.test(manifest.sourceSet.sha256) || !Array.isArray(manifest.sourceSet.paths)
    || manifest.sourceSet.paths.length === 0) throw new Error("Build identity manifest has an invalid schema.");
  const sorted = [...manifest.sourceSet.paths].sort(ordinalCompare);
  if (new Set(sorted).size !== sorted.length || sorted.some((path, index) => path !== manifest.sourceSet.paths[index])) {
    throw new Error("Evaluator source closure paths must be unique and ordinally sorted.");
  }
  for (const path of sorted) {
    if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")
      || path === "provenance/BUILD_IDENTITY.json") throw new Error(`Unsafe evaluator source path: ${String(path)}`);
  }
}

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Build identity record must be an object.");
  const actual = Object.keys(value).sort(ordinalCompare);
  const wanted = [...expected].sort(ordinalCompare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error("Build identity record has missing or unsupported keys.");
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (typeof process !== "undefined" && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--print")) {
    const { actual } = await calculateEvaluatorSourceHash();
    process.stdout.write(`${actual}\n`);
  } else {
    const hash = await verifyEvaluatorSourceIdentity();
    process.stdout.write(`Verified evaluator source identity: ${hash}\n`);
  }
}
