import * as THREE from "three";
import { formatForFileName, metersPerUnit, resolvedSourceUnit } from "./formats.js";
import { inspectExchangeObject } from "./metrics.js";
import type { ExchangeFormatRecord, ExchangeImportOptions, ExchangeImportResult } from "./types.js";

const MAX_FILES = 64;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_VERTICES = 5_000_000;

export async function importReferenceModel(files: readonly File[], options: ExchangeImportOptions): Promise<ExchangeImportResult> {
  validateFiles(files);
  const candidates = files.map((file) => ({ file, format: formatForFileName(file.name) })).filter((entry): entry is { file: File; format: ExchangeFormatRecord } => entry.format !== undefined);
  const primary = candidates.find((entry) => entry.format.support === "local" && (entry.format.direction === "import" || entry.format.direction === "both"));
  if (primary === undefined) {
    const known = candidates[0]?.format;
    if (known?.support === "kernel-required") throw new Error(`${known.name} needs an exact CAD kernel. Export upstream to STEP plus a reviewed kernel, or to GLB/STL for reference preview.`);
    if (known?.support === "converter-required") throw new Error(`${known.name} needs an authorized converter. Export upstream to GLB, OBJ, FBX, USDZ, STL, or another supported neutral format.`);
    if (known?.support === "pdf-pass-through") throw new Error(`${known.name} is accepted only as an already encoded interactive-PDF payload, not as viewport geometry.`);
    throw new Error("No supported primary 3D file was found in the selection.");
  }

  const local = createLocalLoadingManager(files);
  try {
    const object = await parsePrimary(primary.file, primary.format, local.manager);
    object.name = primary.file.name;
    const sourceUnit = resolvedSourceUnit(primary.format, options.unit);
    object.scale.multiplyScalar(metersPerUnit(sourceUnit));
    prepareRenderableObject(object, primary.file.name);
    object.updateMatrixWorld(true);
    const metrics = inspectExchangeObject(object);
    if (metrics.meshCount === 0 && metrics.pointCount === 0 && metrics.lineCount === 0) throw new Error("The file parsed but contained no supported mesh, point, or line geometry.");
    if (metrics.vertexCount + metrics.pointCount > MAX_VERTICES) throw new Error(`The parsed asset exceeds the ${MAX_VERTICES.toLocaleString()} vertex safety limit.`);
    const warnings = buildWarnings(primary.format, options.unit, local.unresolved, candidates.length);
    return {
      object,
      format: primary.format,
      primaryFileName: primary.file.name,
      companionFileNames: files.filter((file) => file !== primary.file).map((file) => file.name),
      sourceUnit,
      metrics,
      warnings,
      releaseResources: local.release
    };
  } catch (error) {
    local.release();
    throw error;
  }
}

async function parsePrimary(file: File, format: ExchangeFormatRecord, manager: THREE.LoadingManager): Promise<THREE.Object3D> {
  const buffer = await file.arrayBuffer();
  const text = async (): Promise<string> => new TextDecoder().decode(buffer);
  switch (format.id) {
    case "gltf": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader(manager).parseAsync(file.name.toLowerCase().endsWith(".gltf") ? await text() : buffer, "");
      return gltf.scene;
    }
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      return new OBJLoader(manager).parse(await text());
    }
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      return meshFromGeometry(new STLLoader(manager).parse(buffer), "#4bc5db");
    }
    case "ply": {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      return meshFromGeometry(new PLYLoader(manager).parse(buffer), "#68c9dc");
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      return new ThreeMFLoader(manager).parse(buffer);
    }
    case "collada": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const collada = new ColladaLoader(manager).parse(await text(), "");
      if (collada === null) throw new Error("COLLADA parser returned no scene.");
      return collada.scene;
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      return new FBXLoader(manager).parse(buffer, "");
    }
    case "amf": {
      const { AMFLoader } = await import("three/examples/jsm/loaders/AMFLoader.js");
      return new AMFLoader(manager).parse(buffer);
    }
    case "3ds": {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      return new TDSLoader(manager).parse(buffer, "");
    }
    case "vrml": {
      const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
      return new VRMLLoader(manager).parse(await text(), "");
    }
    case "vtk": {
      const { VTKLoader } = await import("three/examples/jsm/loaders/VTKLoader.js");
      return meshFromGeometry(new VTKLoader(manager).parse(buffer, ""), "#62c6db");
    }
    case "usd": {
      const { USDLoader } = await import("three/examples/jsm/loaders/USDLoader.js");
      return new USDLoader(manager).parse(buffer, "");
    }
    case "gcode": {
      const { GCodeLoader } = await import("three/examples/jsm/loaders/GCodeLoader.js");
      return new GCodeLoader(manager).parse(await text());
    }
    case "xyz": {
      const { XYZLoader } = await import("three/examples/jsm/loaders/XYZLoader.js");
      const loader = new XYZLoader(manager) as unknown as { parse(data: string): THREE.BufferGeometry };
      const geometry = loader.parse(await text());
      const hasColor = geometry.hasAttribute("color");
      return new THREE.Points(geometry, new THREE.PointsMaterial({ color: "#5bd8e8", size: 0.0016, sizeAttenuation: true, vertexColors: hasColor }));
    }
    default:
      throw new Error(`${format.name} is cataloged but has no local viewport parser.`);
  }
}

function meshFromGeometry(geometry: THREE.BufferGeometry, color: string): THREE.Mesh {
  if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
  const hasColor = geometry.hasAttribute("color");
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.06, vertexColors: hasColor, side: THREE.DoubleSide }));
}

function prepareRenderableObject(root: THREE.Object3D, sourceName: string): void {
  let ordinal = 0;
  root.traverse((entry) => {
    if (entry instanceof THREE.Mesh) {
      if (!entry.geometry.hasAttribute("normal")) entry.geometry.computeVertexNormals();
      entry.userData["semanticId"] = `import:${sourceName}:mesh-${ordinal}`;
      entry.userData["selectionKind"] = "body";
      ordinal += 1;
    } else if (entry instanceof THREE.Points || entry instanceof THREE.Line) {
      entry.userData["semanticId"] = `import:${sourceName}:reference-${ordinal}`;
      entry.userData["selectionKind"] = "body";
      ordinal += 1;
    }
  });
}

function validateFiles(files: readonly File[]): void {
  if (files.length === 0) throw new Error("Choose at least one local 3D file.");
  if (files.length > MAX_FILES) throw new Error(`Select no more than ${MAX_FILES} files, including companions.`);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error("The selected local file set exceeds the 200 MB safety limit.");
  if (files.some((file) => file.size === 0)) throw new Error("Empty files are not accepted as 3D exchange inputs.");
}

function createLocalLoadingManager(files: readonly File[]): { manager: THREE.LoadingManager; unresolved: string[]; release: () => void } {
  const manager = new THREE.LoadingManager();
  const unresolved: string[] = [];
  const objectUrls: string[] = [];
  const localUrls = new Map<string, string>();
  for (const file of files) {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    const relative = normalizePath(file.webkitRelativePath || file.name);
    localUrls.set(relative, url);
    localUrls.set(baseName(relative), url);
  }
  manager.setURLModifier((rawUrl) => {
    if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return rawUrl;
    const normalized = normalizePath(safeDecode(rawUrl).split(/[?#]/, 1)[0] ?? rawUrl);
    const resolved = localUrls.get(normalized) ?? localUrls.get(baseName(normalized));
    if (resolved !== undefined) return resolved;
    unresolved.push(rawUrl);
    throw new Error(`Blocked non-local or missing companion resource: ${rawUrl}`);
  });
  let released = false;
  return {
    manager,
    unresolved,
    release: () => {
      if (released) return;
      released = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    }
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

function baseName(value: string): string {
  return value.split("/").at(-1) ?? value;
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function buildWarnings(format: ExchangeFormatRecord, requestedUnit: ExchangeImportOptions["unit"], unresolved: readonly string[], candidateCount: number): string[] {
  const warnings = [format.fidelity];
  if (requestedUnit === "auto" && (format.autoUnit === "unitless" || ["obj", "stl", "ply", "3ds", "vtk", "xyz"].includes(format.id))) warnings.push(`Auto unit used the ${format.autoUnit === "unitless" ? "millimeter" : format.autoUnit} convention. Override the source unit if the scale is wrong.`);
  if (candidateCount > 1) warnings.push("Multiple primary 3D files were selected; PS3D opened the first supported model and treated the rest as companions.");
  if (unresolved.length > 0) warnings.push(`${unresolved.length} missing or non-local companion resource request(s) were blocked.`);
  if (format.id === "vtk") warnings.push("Three.js has deprecated its legacy VTK loader; convert future assets to glTF when possible.");
  return warnings;
}
