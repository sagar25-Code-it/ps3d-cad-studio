import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { assertProductionModuleAllowed } from "./production-boundary.mjs";
import { verifyEvaluatorSourceIdentity } from "./verify-source-identity.mjs";
import { verifyGeneratedSourceSetHash, verifyVercelPreinstallSourceSet } from "./verify-generated-source-set.mjs";

const root = resolve(import.meta.dirname, "..");
const evaluatorSourceHash = await verifyEvaluatorSourceIdentity();
const generatedSourceSet = process.env.VERCEL === "1"
  ? await verifyVercelPreinstallSourceSet()
  : await verifyGeneratedSourceSetHash();
for (const forbiddenImport of ["manifold-3d", "@modelcontextprotocol/server", "zod"]) {
  let syntheticBoundaryRejected = false;
  try {
    assertProductionModuleAllowed(forbiddenImport);
  } catch {
    syntheticBoundaryRejected = true;
  }
  if (!syntheticBoundaryRejected) {
    throw new Error(`Production module-graph boundary did not reject ${forbiddenImport}.`);
  }
}
const assetsDirectory = resolve(root, "dist", "assets");
const assets = await readdir(assetsDirectory);
const forbiddenAssets = assets.filter((name) => name.endsWith(".wasm") || /manifold/iu.test(name));
if (forbiddenAssets.length > 0) throw new Error(`Production bundle contains evaluation-only geometry artifacts: ${forbiddenAssets.join(", ")}`);

const workerName = assets.find((name) => /^worker-.*\.js$/u.test(name));
if (workerName === undefined) throw new Error("Production bundle is missing the isolated model worker.");
let workerSource = "";
for (const scriptName of assets.filter((name) => name.endsWith(".js"))) {
  const source = await readFile(resolve(assetsDirectory, scriptName), "utf8");
  if (scriptName === workerName) workerSource = source;
  if (
    /manifold-3d|@modelcontextprotocol\/(?:core|server)|\bMcpServer\b|\bStdioServerTransport\b|new Function\s*\(|\beval\s*\(|\bWebAssembly\b|application\/wasm|wasmBinary|AGFzb/iu.test(
      source
    )
  ) {
    throw new Error(`Production script ${scriptName} contains a server-only, evaluation-only, dynamic-eval, or embedded-WASM marker.`);
  }
}
if (!workerSource.includes(evaluatorSourceHash) || !workerSource.includes("ps3d-solid-bracket-kernel")) {
  throw new Error("Production worker does not carry the verified evaluator source and kernel identities.");
}

const licenses = await readFile(resolve(root, "dist", "third-party-licenses.txt"), "utf8");
for (const bundled of ["react", "react-dom", "three"]) {
  if (!licenses.includes(bundled)) throw new Error(`Production license payload is missing ${bundled}.`);
}
if (/manifold-3d/iu.test(licenses)) throw new Error("Production license payload incorrectly labels the evaluation-only candidate as bundled.");
const [projectLicense, builtProjectLicense] = await Promise.all([
  readFile(resolve(root, "LICENSE"), "utf8"),
  readFile(resolve(root, "dist", "LICENSE.txt"), "utf8")
]);
if (projectLicense !== builtProjectLicense) throw new Error("Production artifact must carry the exact project MIT license.");

const hosting = JSON.parse(await readFile(resolve(root, "vercel.json"), "utf8"));
const allHeaders = hosting.headers.flatMap((entry) => entry.headers);
const csp = allHeaders.find((header) => header.key === "Content-Security-Policy")?.value;
if (typeof csp !== "string" || !csp.includes("script-src 'self'") || !csp.includes("worker-src 'self'")) {
  throw new Error("Static hosting must enforce same-origin scripts and workers.");
}
if (csp.includes("'unsafe-eval'") || csp.includes("'wasm-unsafe-eval'")) throw new Error("Production CSP must not permit dynamic evaluation.");
const defaultHeaders = hosting.headers.find((entry) => entry.source === "/(.*)")?.headers ?? [];
const htmlCache = defaultHeaders.find((header) => header.key === "Cache-Control")?.value;
if (htmlCache !== "no-cache, must-revalidate") throw new Error("HTML and SPA routes must explicitly revalidate.");
const assetHeaders = hosting.headers.find((entry) => entry.source === "/assets/(.*)")?.headers ?? [];
const assetCache = assetHeaders.find((header) => header.key === "Cache-Control")?.value;
if (assetCache !== "public, max-age=31536000, immutable") throw new Error("Content-hashed assets must retain immutable caching.");

process.stdout.write(`Verified production boundary: ${assets.length} assets, strict CSP, no Node MCP SDK/WASM/Manifold/dynamic-eval path.\n`);
process.stdout.write(`Verified bundled evaluator source identity: ${evaluatorSourceHash}.\n`);
process.stdout.write(`Verified generated source set: ${generatedSourceSet.hash} (${generatedSourceSet.fileCount} files).\n`);
