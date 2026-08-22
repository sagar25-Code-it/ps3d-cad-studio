import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const inventoryPath = resolve(root, "provenance", "dependencies.json");
const lockfilePath = resolve(root, "pnpm-lock.yaml");
const requiredFields = [
  "id",
  "kind",
  "name",
  "version",
  "source",
  "integrity",
  "license",
  "usage",
  "scope",
  "approvedBy",
  "approvedOn",
  "noticeRequirements"
];

function lockedCoordinates(lockfile) {
  const coordinates = [];
  let insidePackages = false;

  for (const line of lockfile.split(/\r?\n/u)) {
    if (line === "packages:") {
      insidePackages = true;
      continue;
    }
    if (insidePackages && line === "snapshots:") break;
    if (!insidePackages) continue;

    const match = /^  (\S.*):$/u.exec(line);
    if (match === null) continue;
    let coordinate = match[1];
    if (
      (coordinate.startsWith("'") && coordinate.endsWith("'")) ||
      (coordinate.startsWith('"') && coordinate.endsWith('"'))
    ) {
      coordinate = coordinate.slice(1, -1);
    }
    coordinates.push(coordinate);
  }

  return coordinates.sort();
}

function assertNonEmptyString(entry, field) {
  if (typeof entry[field] !== "string" || entry[field].trim() === "") {
    throw new Error(`Dependency ${entry.id ?? "<missing id>"} has no ${field}.`);
  }
}

export async function verifyDependencyInventory() {
  const [inventoryText, lockfile] = await Promise.all([
    readFile(inventoryPath, "utf8"),
    readFile(lockfilePath, "utf8")
  ]);
  const inventory = JSON.parse(inventoryText);

  if (inventory.allowUndeclaredDependencies !== false || inventory.defaultDecision !== "deny") {
    throw new Error("Dependency inventory must remain deny-by-default with no undeclared dependencies.");
  }
  if (!Array.isArray(inventory.dependencies)) throw new Error("Dependency inventory has no dependency array.");

  const ids = new Set();
  const inventoryCoordinates = [];
  for (const entry of inventory.dependencies) {
    for (const field of requiredFields) assertNonEmptyString(entry, field);
    if (ids.has(entry.id)) throw new Error(`Duplicate dependency inventory id: ${entry.id}`);
    ids.add(entry.id);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(entry.version)) {
      throw new Error(`Dependency ${entry.id} does not use an exact version.`);
    }
    if (!entry.source.startsWith("https://registry.npmjs.org/")) {
      throw new Error(`Dependency ${entry.id} does not use the official npm registry tarball URL.`);
    }
    if (!entry.integrity.startsWith("sha512-")) throw new Error(`Dependency ${entry.id} has no SHA-512 integrity.`);
    if (entry.scope !== "development-tool-external") inventoryCoordinates.push(`${entry.name}@${entry.version}`);
  }

  const locked = lockedCoordinates(lockfile);
  inventoryCoordinates.sort();
  const lockedSet = new Set(locked);
  const inventorySet = new Set(inventoryCoordinates);
  const missing = locked.filter((coordinate) => !inventorySet.has(coordinate));
  const stale = inventoryCoordinates.filter((coordinate) => !lockedSet.has(coordinate));

  if (locked.length !== lockedSet.size) throw new Error("Lockfile packages section contains duplicate coordinates.");
  if (inventoryCoordinates.length !== inventorySet.size) throw new Error("Inventory contains duplicate package coordinates.");
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Dependency inventory mismatch. Missing: ${missing.join(", ") || "none"}. Stale: ${stale.join(", ") || "none"}.`
    );
  }

  return { lockedCount: locked.length, externalToolCount: inventory.dependencies.length - inventoryCoordinates.length };
}

if (typeof process !== "undefined" && process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await verifyDependencyInventory();
  process.stdout.write(
    `Verified dependency inventory: ${result.lockedCount} locked packages and ${result.externalToolCount} external tool.\n`
  );
}
