import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { assertProductionModuleAllowed } from "./production-boundary.mjs";
import { verifyEvaluatorSourceIdentity } from "./verify-source-identity.mjs";
import { verifyGeneratedSourceSetHash, verifyVercelPreinstallSourceSet } from "./verify-generated-source-set.mjs";

const root = resolve(import.meta.dirname, "..");
const distDirectory = resolve(root, "dist");
const assetsDirectory = resolve(distDirectory, "assets");
const handRuntimeFiles = new Map([
  ["mediapipe/models/hand_landmarker-float16-v1.task", "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"],
  ["mediapipe/wasm/vision_wasm_module_internal.js", "da8934057f147b622e82cfb4c0dbd85461c598e268588b5a8ba9ca963a8ff82d"],
  ["mediapipe/wasm/vision_wasm_module_internal.wasm", "2dabd8e23c60984628beb7bb338764c81a08e6837145273f59578684b5d53c1b"]
]);

const evaluatorSourceHash = await verifyEvaluatorSourceIdentity();
const generatedSourceSet = process.env.VERCEL === "1"
  ? await verifyVercelPreinstallSourceSet()
  : await verifyGeneratedSourceSetHash();

for (const forbiddenImport of ["manifold-3d", "@modelcontextprotocol/server", "zod"]) {
  let rejected = false;
  try {
    assertProductionModuleAllowed(forbiddenImport);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Production module-graph boundary did not reject ${forbiddenImport}.`);
}

const assets = await readdir(assetsDirectory);
const scripts = [];
for (const scriptName of assets.filter((name) => name.endsWith(".js"))) {
  const source = await readFile(resolve(assetsDirectory, scriptName), "utf8");
  scripts.push({ name: scriptName, source });
  if (/manifold-3d|@modelcontextprotocol\/(?:core|server)|\bMcpServer\b|\bStdioServerTransport\b/iu.test(source)) {
    throw new Error(`Production script ${scriptName} contains a server-only or evaluation-only marker.`);
  }
  if (/new Function\s*\(|\beval\s*\(|AGFzb/iu.test(source)) {
    throw new Error(`Production script ${scriptName} contains dynamic evaluation or an embedded-WASM marker.`);
  }
}

const evaluatorWorkers = scripts.filter(({ name, source }) => /^worker-.*\.js$/u.test(name)
  && source.includes(evaluatorSourceHash)
  && source.includes("ps3d-solid-bracket-kernel"));
if (evaluatorWorkers.length !== 1) throw new Error("Production bundle must contain exactly one source-verified solid evaluator worker.");

const handWorkers = scripts.filter(({ name, source }) => /^hand-landmarker-worker-.*\.js$/u.test(name)
  && source.includes("ps3d-hand-landmarker-worker-v1"));
if (handWorkers.length !== 1) throw new Error("Production bundle must contain exactly one identified hand-landmark worker.");
const handWorker = handWorkers[0];
if (handWorker === undefined || !/WebAssembly\.instantiate|wasmBinaryPath/u.test(handWorker.source)) {
  throw new Error("The identified hand worker is missing the reviewed MediaPipe WASM loader path.");
}
for (const script of scripts) {
  if (script === handWorker) continue;
  if (/WebAssembly\.(?:compile|compileStreaming|instantiate|instantiateStreaming)|wasmBinary|application\/wasm/iu.test(script.source)) {
    throw new Error(`Production script ${script.name} contains an unapproved WebAssembly execution path.`);
  }
}

const runtimeManifestPath = resolve(distDirectory, "mediapipe", "runtime-manifest.json");
const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
if (
  runtimeManifest.schema !== "ps3d-local-hand-runtime-v1"
  || runtimeManifest.networkAtRuntime !== false
  || runtimeManifest.package?.name !== "@mediapipe/tasks-vision"
  || runtimeManifest.package?.version !== "1.0.1"
  || runtimeManifest.package?.license !== "Apache-2.0"
) {
  throw new Error("Hand runtime manifest identity or offline-runtime boundary is invalid.");
}
if (
  runtimeManifest.model?.source !== "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
  || runtimeManifest.model?.path !== "/mediapipe/models/hand_landmarker-float16-v1.task"
  || runtimeManifest.model?.sha256 !== handRuntimeFiles.get("mediapipe/models/hand_landmarker-float16-v1.task")
  || runtimeManifest.model?.bytes !== 7_819_105
) {
  throw new Error("Hand Landmarker model manifest does not match the reviewed artifact.");
}

const distFiles = await listFiles(distDirectory, "");
const handRuntimePaths = distFiles.filter((path) => path.startsWith("mediapipe/"));
const expectedHandRuntimePaths = ["mediapipe/runtime-manifest.json", ...handRuntimeFiles.keys()];
if (!sameSet(handRuntimePaths, expectedHandRuntimePaths)) {
  throw new Error(`Production hand-runtime file set is not allowlisted: ${handRuntimePaths.join(", ") || "none"}.`);
}
const runtimeBinaryPaths = distFiles.filter((path) => path.endsWith(".wasm") || path.endsWith(".task"));
const expectedBinaryPaths = [...handRuntimeFiles.keys()].filter((path) => path.endsWith(".wasm") || path.endsWith(".task"));
if (!sameSet(runtimeBinaryPaths, expectedBinaryPaths)) {
  throw new Error(`Production binary/model set is not allowlisted: ${runtimeBinaryPaths.join(", ") || "none"}.`);
}
for (const [relativePath, expectedHash] of handRuntimeFiles) {
  const actualHash = await sha256(resolve(distDirectory, ...relativePath.split("/")));
  if (actualHash !== expectedHash) throw new Error(`Hand runtime hash mismatch: ${relativePath}.`);
}
const manifestAssets = runtimeManifest.package?.assets;
if (!Array.isArray(manifestAssets) || manifestAssets.length !== 2) {
  throw new Error("Hand runtime manifest must list the two reviewed package assets.");
}
for (const [relativePath, expectedHash] of handRuntimeFiles) {
  if (relativePath.endsWith(".task")) continue;
  const manifestAsset = manifestAssets.find((asset) => asset?.path === `/${relativePath}`);
  if (manifestAsset?.sha256 !== expectedHash) throw new Error(`Hand runtime manifest hash mismatch: ${relativePath}.`);
}

const licenses = await readFile(resolve(distDirectory, "third-party-licenses.txt"), "utf8");
for (const bundled of ["react", "react-dom", "three", "@mediapipe/tasks-vision - 1.0.1 (Apache-2.0)"]) {
  if (!licenses.includes(bundled)) throw new Error(`Production license payload is missing ${bundled}.`);
}
if (/manifold-3d/iu.test(licenses)) throw new Error("Production license payload incorrectly labels the evaluation-only candidate as bundled.");
const [projectLicense, builtProjectLicense, notices, builtNotices] = await Promise.all([
  readFile(resolve(root, "LICENSE"), "utf8"),
  readFile(resolve(distDirectory, "LICENSE.txt"), "utf8"),
  readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
  readFile(resolve(distDirectory, "THIRD_PARTY_NOTICES.md"), "utf8")
]);
if (projectLicense !== builtProjectLicense) throw new Error("Production artifact must carry the exact project MIT license.");
if (notices !== builtNotices || !notices.includes("@mediapipe/tasks-vision | 1.0.1 | Apache-2.0")) {
  throw new Error("Production artifact must carry the reviewed third-party camera-runtime notice.");
}
if (await sha256(resolve(distDirectory, "licenses", "APACHE-2.0.txt")) !== "a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47") {
  throw new Error("Production artifact must carry the reviewed complete Apache License 2.0 text.");
}

const hosting = JSON.parse(await readFile(resolve(root, "vercel.json"), "utf8"));
const defaultHeaders = hosting.headers.find((entry) => entry.source === "/(.*)")?.headers ?? [];
const csp = defaultHeaders.find((header) => header.key === "Content-Security-Policy")?.value;
if (
  typeof csp !== "string"
  || !csp.includes("script-src 'self' 'wasm-unsafe-eval'")
  || !csp.includes("worker-src 'self'")
  || !csp.includes("connect-src 'self'")
) {
  throw new Error("Static hosting must permit only same-origin scripts, workers, connections, and the reviewed WASM execution mode.");
}
if (csp.includes("'unsafe-eval'")) throw new Error("Production CSP must not permit general dynamic evaluation.");
const permissionsPolicy = defaultHeaders.find((header) => header.key === "Permissions-Policy")?.value;
if (typeof permissionsPolicy !== "string" || !permissionsPolicy.includes("camera=(self)") || !permissionsPolicy.includes("microphone=()")) {
  throw new Error("Camera hand control must permit only same-origin camera access while microphone access remains disabled.");
}
const htmlCache = defaultHeaders.find((header) => header.key === "Cache-Control")?.value;
if (htmlCache !== "no-cache, must-revalidate") throw new Error("HTML and SPA routes must explicitly revalidate.");
const assetHeaders = hosting.headers.find((entry) => entry.source === "/assets/(.*)")?.headers ?? [];
if (assetHeaders.find((header) => header.key === "Cache-Control")?.value !== "public, max-age=31536000, immutable") {
  throw new Error("Content-hashed assets must retain immutable caching.");
}
const handHeaders = hosting.headers.find((entry) => entry.source === "/mediapipe/(.*)")?.headers ?? [];
if (
  handHeaders.find((header) => header.key === "Cache-Control")?.value !== "public, max-age=31536000, immutable"
  || handHeaders.find((header) => header.key === "Cross-Origin-Resource-Policy")?.value !== "same-origin"
) {
  throw new Error("Hash-pinned hand runtime assets must be immutable and same-origin protected.");
}

const expectedSpaRoutes = ["/access", "/learn", "/about", "/command-audit", "/oauth/consent"];
for (const route of expectedSpaRoutes) {
  if (hosting.rewrites.find((entry) => entry.source === route)?.destination !== "/") {
    throw new Error(`Public SPA route ${route} must rewrite to the clean root document.`);
  }
}
if (hosting.rewrites.some((entry) => entry.destination === "/index.html")) {
  throw new Error("Vercel rewrites must not target /index.html while cleanUrls is enabled.");
}

process.stdout.write(`Verified production boundary: ${assets.length} assets, strict same-origin CSP, one hash-pinned vision WASM/model pair, no Node MCP SDK/Manifold/dynamic-eval path.\n`);
process.stdout.write(`Verified bundled evaluator source identity: ${evaluatorSourceHash}.\n`);
process.stdout.write(`Verified generated source set: ${generatedSourceSet.hash} (${generatedSourceSet.fileCount} files).\n`);

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function listFiles(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(resolve(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
