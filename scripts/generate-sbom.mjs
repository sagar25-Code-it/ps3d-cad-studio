import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const inventoryPath = resolve(root, "provenance", "dependencies.json");
const outputPath = resolve(root, "artifacts", "sbom", "ps3d.cdx.json");

export async function generateSbomText() {
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const components = inventory.dependencies.map((entry) => ({
    type: entry.scope === "development-tool-external" ? "application" : "library",
    "bom-ref": entry.id,
    group: entry.name.startsWith("@") ? entry.name.split("/")[0] : undefined,
    name: entry.name,
    version: entry.version,
    hashes: [{ alg: "SHA-512", content: Buffer.from(entry.integrity.slice("sha512-".length), "base64").toString("hex") }],
    licenses: [{ expression: entry.license }],
    purl: npmPurl(entry.name, entry.version),
    externalReferences: [{ type: "distribution", url: entry.source }],
    properties: [
      { name: "ps3d:kind", value: entry.kind },
      { name: "ps3d:scope", value: entry.scope },
      { name: "ps3d:usage", value: entry.usage }
    ]
  })).map((component) => Object.fromEntries(Object.entries(component).filter(([, value]) => value !== undefined)));

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      tools: { components: [{ type: "application", name: "ps3d-inventory-sbom-generator", version: "1" }] },
      component: {
        type: "application",
        "bom-ref": "pkg:generic/ps3d-cad-studio@0.2.0-preview.1",
        name: "ps3d-cad-studio-original",
        version: "0.2.0-preview.1",
        licenses: [{ expression: "MIT" }]
      },
      properties: [
        { name: "ps3d:inventory-state", value: inventory.inventoryState },
        { name: "ps3d:metadata-accessed-on", value: inventory.metadataAccessedOn }
      ]
    },
    components
  };
  return `${JSON.stringify(bom, null, 2)}\n`;
}

function npmPurl(name, version) {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`;
  const [scope, packageName] = name.split("/");
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`;
}

export async function verifySbom() {
  const expected = await generateSbomText();
  const actual = await readFile(outputPath, "utf8").catch(() => "");
  if (actual !== expected) throw new Error("CycloneDX SBOM is missing or stale; run pnpm sbom:generate.");
  return { componentCount: JSON.parse(expected).components.length };
}

export async function writeSbom() {
  const expected = await generateSbomText();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, "utf8");
  return outputPath;
}

if (typeof process !== "undefined" && process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--check")) {
    const result = await verifySbom();
    process.stdout.write(`Verified deterministic CycloneDX SBOM: ${result.componentCount} inventoried components.\n`);
  } else {
    process.stdout.write(`Generated ${await writeSbom()}.\n`);
  }
}
