import type * as THREE from "three";

export type ExchangeUnit = "auto" | "mm" | "cm" | "m" | "in";
export type ExchangeFormatId =
  | "gltf" | "obj" | "stl" | "ply" | "3mf" | "collada" | "fbx" | "amf"
  | "3ds" | "vrml" | "vtk" | "usd" | "gcode" | "xyz" | "u3d-prc"
  | "step-iges" | "parasolid-acis" | "dwg-dxf" | "native-cad" | "dcc";
export type ExchangeSupport = "local" | "pdf-pass-through" | "converter-required" | "kernel-required";
export type ExchangeDirection = "import" | "export" | "both" | "pdf-only";
export type ExchangeCategory = "scene" | "mesh" | "toolpath" | "point-cloud" | "exact-cad" | "authoring" | "pdf-payload";

export interface ExchangeFormatRecord {
  readonly id: ExchangeFormatId;
  readonly name: string;
  readonly extensions: readonly string[];
  readonly direction: ExchangeDirection;
  readonly support: ExchangeSupport;
  readonly category: ExchangeCategory;
  readonly summary: string;
  readonly fidelity: string;
  readonly autoUnit: Exclude<ExchangeUnit, "auto"> | "embedded" | "unitless";
}

export interface ExchangeBounds {
  readonly minMeters: readonly [number, number, number];
  readonly maxMeters: readonly [number, number, number];
  readonly sizeMeters: readonly [number, number, number];
  readonly centerMeters: readonly [number, number, number];
}

export interface ExchangeMetrics {
  readonly objectCount: number;
  readonly meshCount: number;
  readonly pointCount: number;
  readonly lineCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly materialCount: number;
  readonly bounds: ExchangeBounds;
}

export interface ExchangeImportOptions {
  readonly unit: ExchangeUnit;
}

export interface ExchangeImportResult {
  readonly object: THREE.Object3D;
  readonly format: ExchangeFormatRecord;
  readonly primaryFileName: string;
  readonly companionFileNames: readonly string[];
  readonly sourceUnit: Exclude<ExchangeUnit, "auto">;
  readonly metrics: ExchangeMetrics;
  readonly warnings: readonly string[];
  readonly releaseResources: () => void;
}

export type ExchangeExportFormat = "glb" | "gltf" | "obj" | "stl" | "ply" | "usdz";

export interface ExchangeExportOptions {
  readonly format: ExchangeExportFormat;
  readonly unit: Exclude<ExchangeUnit, "auto">;
  readonly binary?: boolean;
  readonly fileStem?: string;
}

export interface ExchangeExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly format: ExchangeExportFormat;
  readonly unit: Exclude<ExchangeUnit, "auto">;
  readonly warning: string;
}

export interface ViewportJpeg {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface PdfModelPackageInput {
  readonly title: string;
  readonly projectName: string;
  readonly sourceLabel: string;
  readonly metrics: ExchangeMetrics;
  readonly preview: ViewportJpeg;
  readonly glbBytes: Uint8Array;
  readonly generatedAt?: Date;
}

export interface Interactive3dPdfInput {
  readonly title: string;
  readonly payloadName: string;
  readonly payloadBytes: Uint8Array;
  readonly subtype: "U3D" | "PRC";
  readonly generatedAt?: Date;
}
