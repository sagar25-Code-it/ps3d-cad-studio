import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const recordRelativePath = "provenance/GENERATED_MATERIAL.md";
const excludedDirectories = new Set([".git", "node_modules", "dist", ".test-dist", ".mcp-dist"]);

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
  const record = await readFile(resolve(root, ...recordRelativePath.split("/")), "utf8");
  const expected = /Canonical source-set hash:\s*\r?\n\s*`([a-f0-9]{64})`/u.exec(record)?.[1];
  const expectedCountText = /Canonical source-set file count:\s*(\d+)/u.exec(record)?.[1];
  const expectedCount = expectedCountText === undefined ? undefined : Number.parseInt(expectedCountText, 10);
  if (expected === undefined || expected !== calculated.hash || expectedCount === undefined || expectedCount !== calculated.fileCount) {
    throw new Error(`Generated source-set identity mismatch: record=${expected ?? "missing"}/${expectedCount ?? "missing"} actual=${calculated.hash}/${calculated.fileCount}`);
  }
  return calculated;
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
  if (process.argv.includes("--print")) {
    const calculated = await calculateGeneratedSourceSetHash();
    process.stdout.write(`${calculated.hash} ${calculated.fileCount}\n`);
  } else {
    const calculated = await verifyGeneratedSourceSetHash();
    process.stdout.write(`Verified generated source set: ${calculated.hash} (${calculated.fileCount} files)\n`);
  }
}
