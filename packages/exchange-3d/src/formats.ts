import type { ExchangeFormatId, ExchangeFormatRecord, ExchangeUnit } from "./types.js";

export const EXCHANGE_FORMATS: readonly ExchangeFormatRecord[] = [
  { id: "gltf", name: "glTF / GLB", extensions: [".glb", ".gltf"], direction: "both", support: "local", category: "scene", autoUnit: "m", summary: "Preferred web interchange with hierarchy, materials, cameras, animation, and embedded or companion assets.", fidelity: "Runtime scene; not a parametric feature tree." },
  { id: "obj", name: "Wavefront OBJ", extensions: [".obj"], direction: "both", support: "local", category: "mesh", autoUnit: "mm", summary: "Local polygon mesh geometry. Companion material files are safely resolved when supplied.", fidelity: "Tessellated and unitless; source-unit choice is required for precision." },
  { id: "stl", name: "STL", extensions: [".stl"], direction: "both", support: "local", category: "mesh", autoUnit: "mm", summary: "Binary or ASCII triangle mesh for fabrication workflows.", fidelity: "Triangles only; no materials, hierarchy, units, or CAD features." },
  { id: "ply", name: "PLY", extensions: [".ply"], direction: "both", support: "local", category: "mesh", autoUnit: "mm", summary: "Polygon or vertex-color mesh exchange.", fidelity: "Tessellated and usually unitless." },
  { id: "3mf", name: "3MF", extensions: [".3mf"], direction: "import", support: "local", category: "mesh", autoUnit: "mm", summary: "Packaged additive-manufacturing mesh preview.", fidelity: "Reference mesh; build metadata is not converted into PS3D features." },
  { id: "collada", name: "COLLADA", extensions: [".dae"], direction: "import", support: "local", category: "scene", autoUnit: "embedded", summary: "Scene hierarchy, meshes, and locally supplied companion resources.", fidelity: "Runtime scene preview; authoring semantics may be reduced." },
  { id: "fbx", name: "FBX", extensions: [".fbx"], direction: "import", support: "local", category: "scene", autoUnit: "cm", summary: "Binary or ASCII scene preview with common mesh and hierarchy data.", fidelity: "Reference scene; exact Autodesk authoring semantics are not preserved." },
  { id: "amf", name: "AMF", extensions: [".amf"], direction: "import", support: "local", category: "mesh", autoUnit: "mm", summary: "Additive-manufacturing mesh preview.", fidelity: "Reference mesh only." },
  { id: "3ds", name: "3D Studio", extensions: [".3ds"], direction: "import", support: "local", category: "scene", autoUnit: "mm", summary: "Legacy 3D Studio scene and mesh preview.", fidelity: "Legacy tessellated scene; precision and materials may be reduced." },
  { id: "vrml", name: "VRML", extensions: [".wrl", ".vrml"], direction: "import", support: "local", category: "scene", autoUnit: "m", summary: "VRML 2 scene preview using only local companion files.", fidelity: "Runtime scene; unsupported script behavior is not executed." },
  { id: "vtk", name: "VTK legacy", extensions: [".vtk"], direction: "import", support: "local", category: "mesh", autoUnit: "mm", summary: "Legacy VTK polygon data preview.", fidelity: "Mesh geometry only; Three.js marks this loader as deprecated." },
  { id: "usd", name: "USD / USDZ", extensions: [".usd", ".usda", ".usdc", ".usdz"], direction: "both", support: "local", category: "scene", autoUnit: "embedded", summary: "USD family scene preview; USDZ scene export is available.", fidelity: "Runtime scene subset; not a full USD composition engine." },
  { id: "gcode", name: "G-code", extensions: [".gcode", ".nc", ".tap"], direction: "import", support: "local", category: "toolpath", autoUnit: "mm", summary: "Toolpath line preview for manufacturing inspection.", fidelity: "Path visualization, not a solid model." },
  { id: "xyz", name: "XYZ point cloud", extensions: [".xyz"], direction: "import", support: "local", category: "point-cloud", autoUnit: "mm", summary: "Local XYZ point-cloud preview.", fidelity: "Points only; no surface reconstruction." },
  { id: "u3d-prc", name: "U3D / PRC", extensions: [".u3d", ".prc"], direction: "pdf-only", support: "pdf-pass-through", category: "pdf-payload", autoUnit: "embedded", summary: "Already encoded payload can be embedded as a true PDF 3D annotation.", fidelity: "Pass-through only; PS3D does not encode meshes into U3D or PRC." },
  { id: "step-iges", name: "STEP / IGES", extensions: [".step", ".stp", ".iges", ".igs"], direction: "import", support: "kernel-required", category: "exact-cad", autoUnit: "embedded", summary: "Exact CAD interchange requires a separately reviewed B-rep kernel or conversion service.", fidelity: "Not currently opened; never mislabeled as local support." },
  { id: "parasolid-acis", name: "Parasolid / ACIS", extensions: [".x_t", ".x_b", ".sat", ".sab"], direction: "import", support: "kernel-required", category: "exact-cad", autoUnit: "embedded", summary: "Licensed exact-kernel formats require authorized SDKs.", fidelity: "Not currently opened." },
  { id: "dwg-dxf", name: "DWG / DXF", extensions: [".dwg", ".dxf"], direction: "import", support: "converter-required", category: "exact-cad", autoUnit: "embedded", summary: "A reviewed 2D/3D CAD converter and conformance suite are required.", fidelity: "Not currently opened as 3D geometry." },
  { id: "native-cad", name: "Native mechanical CAD", extensions: [".sldprt", ".sldasm", ".ipt", ".iam", ".catpart", ".catproduct", ".prt", ".asm", ".f3d"], direction: "import", support: "converter-required", category: "authoring", autoUnit: "embedded", summary: "Vendor-native feature history requires an authorized vendor SDK or upstream neutral export.", fidelity: "Not currently opened." },
  { id: "dcc", name: "DCC authoring", extensions: [".blend", ".max", ".c4d", ".skp", ".ma", ".mb"], direction: "import", support: "converter-required", category: "authoring", autoUnit: "embedded", summary: "Authoring-tool projects should be exported upstream to GLB, OBJ, FBX, or USDZ.", fidelity: "Not currently opened." }
] as const;

export function formatForFileName(fileName: string): ExchangeFormatRecord | undefined {
  const lower = fileName.toLowerCase();
  return EXCHANGE_FORMATS.find((format) => format.extensions.some((extension) => lower.endsWith(extension)));
}

export function formatById(id: ExchangeFormatId): ExchangeFormatRecord {
  const format = EXCHANGE_FORMATS.find((entry) => entry.id === id);
  if (format === undefined) throw new Error(`Unknown exchange format: ${id}`);
  return format;
}

export function resolvedSourceUnit(format: ExchangeFormatRecord, requested: ExchangeUnit): Exclude<ExchangeUnit, "auto"> {
  if (requested !== "auto") return requested;
  if (format.autoUnit === "m" || format.autoUnit === "cm" || format.autoUnit === "mm" || format.autoUnit === "in") return format.autoUnit;
  return "m";
}

export function metersPerUnit(unit: Exclude<ExchangeUnit, "auto">): number {
  if (unit === "mm") return 0.001;
  if (unit === "cm") return 0.01;
  if (unit === "in") return 0.0254;
  return 1;
}
