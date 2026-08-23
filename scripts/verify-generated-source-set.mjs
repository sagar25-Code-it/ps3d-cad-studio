import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const recordRelativePath = "provenance/GENERATED_MATERIAL.md";
const vercelMarkerRelativePath = ".vercel/ps3d-source-set-preverified.json";
const excludedDirectories = new Set([".git", ".vercel", "node_modules", ".pnpm-store", "dist", ".test-dist", ".mcp-dist"]);

export async function calculateGeneratedSourceSetHash() {
  const paths = await listFiles(root, "");
  const hash = createHash("sha256");
  for (const path of paths.sort(ordinalCompare)) {
    hash.update(path, "utf8");
    hash.update(Uint8Array.of(0));
    hash.update(await readFile(resolve(root, ...path.split("/"))));
    hash.update(Uint8Array.of(0));
  }
  return { hash: hash.digest("hex"), fileCount: paths.length };
}

export async function verifyGeneratedSourceSetHash() {
  const calculated = await calculateGeneratedSourceSetHash();
  const { hash: expected, fileCount: expectedCount } = await readRecordedSourceSetIdentity();
  if (expected === undefined || expected !== calculated.hash || expectedCount === undefined || expectedCount !== calculated.fileCount) {
    throw new Error(`Generated source-set identity mismatch: record=${expected ?? "missing"}/${expectedCount ?? "missing"} actual=${calculated.hash}/${calculated.fileCount}`);
  }
  return calculated;
}

export async function markVercelPreinstallSourceSet() {
  const verified = await verifyGeneratedSourceSetHash();
  const commitSha = readVercelCommitSha();
  await mkdir(resolve(root, ".vercel"), { recursive: true });
  await writeFile(
    resolve(root, ...vercelMarkerRelativePath.split("/")),
    `${JSON.stringify({ schemaVersion: 1, ...verified, commitSha }, null, 2)}\n`,
    "utf8"
  );
  return { ...verified, commitSha };
}

export async function verifyVercelPreinstallSourceSet() {
  const marker = JSON.parse(await readFile(resolve(root, ...vercelMarkerRelativePath.split("/")), "utf8"));
  const expected = await readRecordedSourceSetIdentity();
  const commitSha = readVercelCommitSha();
  if (
    marker.schemaVersion !== 1 ||
    marker.hash !== expected.hash ||
    marker.fileCount !== expected.fileCount ||
    marker.commitSha !== commitSha
  ) {
    throw new Error("Vercel pre-install source-set marker is missing, stale, or bound to a different Git commit.");
  }
  return { hash: marker.hash, fileCount: marker.fileCount };
}

async function readRecordedSourceSetIdentity() {
  const record = await readFile(resolve(root, ...recordRelativePath.split("/")), "utf8");
  const hash = /Canonical source-set hash:\s*\r?\n\s*`([a-f0-9]{64})`/u.exec(record)?.[1];
  const fileCountText = /Canonical source-set file count:\s*(\d+)/u.exec(record)?.[1];
  const fileCount = fileCountText === undefined ? undefined : Number.parseInt(fileCountText, 10);
  return { hash, fileCount };
}

function readVercelCommitSha() {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  if (commitSha !== null && !/^[a-f0-9]{40}$/iu.test(commitSha)) {
    throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character hexadecimal Git commit identity when provided.");
  }
  return commitSha;
}

async function listFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (relative === recordRelativePath) continue;
    if (entry.isSymbolicLink()) throw new Error(`Source-set hashing rejects symbolic links: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(resolve(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (typeof process !== "undefined" && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--mark-vercel-preinstall")) {
    const marked = await markVercelPreinstallSourceSet();
    process.stdout.write(`Verified and marked Vercel pre-install source set: ${marked.hash} (${marked.fileCount} files).\n`);
  } else if (process.argv.includes("--print")) {
    const calculated = await calculateGeneratedSourceSetHash();
    process.stdout.write(`${calculated.hash} ${calculated.fileCount}\n`);
  } else {
    const calculated = await verifyGeneratedSourceSetHash();
    process.stdout.write(`Verified generated source set: ${calculated.hash} (${calculated.fileCount} files)\n`);
  }
}
