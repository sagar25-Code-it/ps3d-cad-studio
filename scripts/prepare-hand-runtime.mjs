import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "apps", "studio-web", "node_modules", "@mediapipe", "tasks-vision");
const runtimeRoot = resolve(root, "node_modules", ".cache", "ps3d-hand-runtime");
const modelUrl = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const modelRelativePath = "mediapipe/models/hand_landmarker-float16-v1.task";
const modelSha256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";
const modelBytes = 7_819_105;
const packageAssets = [
  {
    source: "wasm/vision_wasm_module_internal.js",
    target: "mediapipe/wasm/vision_wasm_module_internal.js",
    sha256: "da8934057f147b622e82cfb4c0dbd85461c598e268588b5a8ba9ca963a8ff82d"
  },
  {
    source: "wasm/vision_wasm_module_internal.wasm",
    target: "mediapipe/wasm/vision_wasm_module_internal.wasm",
    sha256: "2dabd8e23c60984628beb7bb338764c81a08e6837145273f59578684b5d53c1b"
  }
];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function copyVerifiedAsset(asset) {
  const source = resolve(packageRoot, ...asset.source.split("/"));
  if (await sha256(source) !== asset.sha256) {
    throw new Error(`MediaPipe package asset hash mismatch: ${asset.source}`);
  }
  const target = resolve(runtimeRoot, ...asset.target.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  if (await sha256(target) !== asset.sha256) throw new Error(`Copied MediaPipe asset hash mismatch: ${asset.target}`);
}

async function ensureModel() {
  const target = resolve(runtimeRoot, ...modelRelativePath.split("/"));
  const existingHash = await sha256(target).catch(() => "");
  if (existingHash === modelSha256 && (await readFile(target)).byteLength === modelBytes) return target;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  await rm(temporary, { force: true });
  try {
    const response = await fetch(modelUrl, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Hand model download failed: ${response.status} ${response.statusText}`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number.parseInt(declaredLength, 10) !== modelBytes) {
      throw new Error(`Hand model length header mismatch: expected ${modelBytes}, received ${declaredLength}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== modelBytes) throw new Error(`Hand model size mismatch: expected ${modelBytes}, received ${bytes.byteLength}`);
    const downloadedHash = createHash("sha256").update(bytes).digest("hex");
    if (downloadedHash !== modelSha256) {
      throw new Error(`Hand model hash mismatch: expected ${modelSha256}, received ${downloadedHash}`);
    }
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (
  packageManifest.name !== "@mediapipe/tasks-vision"
  || packageManifest.version !== "1.0.1"
  || packageManifest.license !== "Apache-2.0"
) {
  throw new Error("Installed MediaPipe package identity does not match the reviewed runtime.");
}

await Promise.all(packageAssets.map(copyVerifiedAsset));
await ensureModel();
const manifest = {
  schema: "ps3d-local-hand-runtime-v1",
  generated: true,
  networkAtRuntime: false,
  package: {
    name: "@mediapipe/tasks-vision",
    version: "1.0.1",
    license: "Apache-2.0",
    assets: packageAssets.map(({ target, sha256: hash }) => ({ path: `/${target}`, sha256: hash }))
  },
  model: {
    name: "MediaPipe HandLandmarker full float16",
    version: "1",
    source: modelUrl,
    path: `/${modelRelativePath}`,
    sha256: modelSha256,
    bytes: modelBytes
  }
};
const manifestPath = resolve(runtimeRoot, "mediapipe", "runtime-manifest.json");
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`Prepared hash-pinned local hand runtime: ${modelSha256}.\n`);
