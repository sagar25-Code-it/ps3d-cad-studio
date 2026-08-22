import type * as THREE from "three";
import { metersPerUnit } from "./formats.js";
import { cloneExchangeObject, disposeExchangeObject } from "./metrics.js";
import type { ExchangeExportOptions, ExchangeExportResult } from "./types.js";

export async function exportExchangeObject(source: THREE.Object3D, options: ExchangeExportOptions): Promise<ExchangeExportResult> {
  const root = cloneExchangeObject(source);
  const stem = sanitizeStem(options.fileStem ?? "ps3d-model");
  try {
    if (options.format === "glb" || options.format === "gltf") {
      const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
      const binary = options.format === "glb";
      const result = await new GLTFExporter().parseAsync(root, { binary, embedImages: true, onlyVisible: true, trs: false });
      const blob = result instanceof ArrayBuffer
        ? new Blob([result], { type: "model/gltf-binary" })
        : new Blob([JSON.stringify(result, null, 2)], { type: "model/gltf+json" });
      return { blob, fileName: `${stem}.${options.format}`, format: options.format, unit: "m", warning: "glTF exports the visible runtime scene in meters; it does not contain PS3D parametric feature history." };
    }

    if (options.format === "usdz") {
      const { USDZExporter } = await import("three/examples/jsm/exporters/USDZExporter.js");
      const bytes = await new USDZExporter().parseAsync(root, { onlyVisible: true, quickLookCompatible: true });
      return { blob: new Blob([bytes], { type: "model/vnd.usdz+zip" }), fileName: `${stem}.usdz`, format: "usdz", unit: "m", warning: "USDZ is a runtime scene package, not an exact mechanical-CAD document." };
    }

    root.scale.multiplyScalar(1 / metersPerUnit(options.unit));
    root.updateMatrixWorld(true);
    if (options.format === "obj") {
      const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
      const text = new OBJExporter().parse(root);
      return { blob: new Blob([text], { type: "text/plain" }), fileName: `${stem}-${options.unit}.obj`, format: "obj", unit: options.unit, warning: `OBJ coordinates were written in ${options.unit}; OBJ itself has no authoritative unit field.` };
    }
    if (options.format === "stl") {
      const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
      const binary = options.binary !== false;
      const value = new STLExporter().parse(root, { binary });
      const blob = typeof value === "string"
        ? new Blob([value], { type: "model/stl" })
        : new Blob([value.buffer], { type: "model/stl" });
      return { blob, fileName: `${stem}-${options.unit}.stl`, format: "stl", unit: options.unit, warning: `STL coordinates were written in ${options.unit}; STL stores triangles without an authoritative unit field.` };
    }
    if (options.format === "ply") {
      const { PLYExporter } = await import("three/examples/jsm/exporters/PLYExporter.js");
      const binary = options.binary !== false;
      const value = await new Promise<string | ArrayBuffer>((resolve, reject) => {
        try {
          const immediate = new PLYExporter().parse(root, resolve, { binary, littleEndian: true });
          if (immediate !== null) resolve(immediate);
        } catch (error) { reject(error); }
      });
      return { blob: new Blob([value], { type: "application/octet-stream" }), fileName: `${stem}-${options.unit}.ply`, format: "ply", unit: options.unit, warning: `PLY coordinates were written in ${options.unit}; receiving tools may still require an explicit unit choice.` };
    }
    throw new Error(`Unsupported export format: ${options.format}`);
  } finally {
    disposeExchangeObject(root);
  }
}

export async function exportGlbBytes(source: THREE.Object3D): Promise<Uint8Array> {
  const result = await exportExchangeObject(source, { format: "glb", unit: "m", binary: true, fileStem: "model" });
  return new Uint8Array(await result.blob.arrayBuffer());
}

function sanitizeStem(value: string): string {
  const stem = value.trim().replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return stem.length === 0 ? "ps3d-model" : stem.slice(0, 80);
}
