import { renderExchangeSha256 } from "./canonical.js";
import type {
  AssetUriPolicy,
  AppearanceTarget,
  DerivedTessellationReference,
  PathTraceRequest,
  PhysicalMaterial,
  RenderExchangeDiagnostic,
  RenderRequest,
  RenderScene,
  Sha256Digest,
  Vector2,
  Vector3,
  Matrix4
} from "./types.js";
import {
  DEFAULT_ASSET_URI_POLICY,
  diagnostic,
  validateColor,
  validateContentReference,
  validateDigest,
  validateFinite,
  validateStableId,
  validateUniqueIds
} from "./validation.js";

const FORBIDDEN_RENDER_GEOMETRY_KEYS = new Set([
  "brep", "exactGeometry", "exactShape", "geometryMutation", "modellingTolerance",
  "positions", "shape", "topology", "vertices"
]);

export interface RenderSourceManifest {
  readonly exactDocumentId: string;
  readonly exactDocumentRevision: number;
  readonly exactDocumentDigest: Sha256Digest;
  readonly tessellations: readonly {
    readonly tessellationId: string;
    readonly sourceExactShapeDigest: Sha256Digest;
    readonly tessellationDigest: Sha256Digest;
    readonly topologyBindingDigest: Sha256Digest;
  }[];
}

export function renderSourceManifest(scene: RenderScene): RenderSourceManifest {
  return {
    exactDocumentId: scene.exactDocumentId,
    exactDocumentRevision: scene.exactDocumentRevision,
    exactDocumentDigest: scene.exactDocumentDigest,
    tessellations: scene.tessellations.map((item) => ({
      tessellationId: item.tessellationId,
      sourceExactShapeDigest: item.sourceExactShapeDigest,
      tessellationDigest: item.tessellationDigest,
      topologyBindingDigest: item.topologyBindingDigest
    }))
  };
}

export async function renderSceneDigest(scene: RenderScene): Promise<Sha256Digest> {
  return renderExchangeSha256(scene);
}

export function validateRenderScene(
  scene: RenderScene,
  assetPolicy: AssetUriPolicy = DEFAULT_ASSET_URI_POLICY
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  diagnostics.push(...validateStableId(scene.sceneId, "scene.sceneId"));
  diagnostics.push(...validateStableId(scene.exactDocumentId, "scene.exactDocumentId"));
  diagnostics.push(...validateDigest(scene.exactDocumentDigest, "scene.exactDocumentDigest"));
  diagnostics.push(...validateFinite(scene.sceneRevision, "scene.sceneRevision", { min: 0, integer: true }));
  diagnostics.push(...validateFinite(scene.exactDocumentRevision, "scene.exactDocumentRevision", { min: 0, integer: true }));

  diagnostics.push(...validateUniqueIds(scene.tessellations.map((item) => item.tessellationId), "scene.tessellations.ids"));
  diagnostics.push(...validateUniqueIds(scene.physicalMaterials.map((item) => item.materialId), "scene.physicalMaterials.ids"));
  diagnostics.push(...validateUniqueIds(scene.appearances.map((item) => item.appearanceId), "scene.appearances.ids"));
  diagnostics.push(...validateUniqueIds(scene.textures.map((item) => item.textureId), "scene.textures.ids"));
  diagnostics.push(...validateUniqueIds(scene.materialAssignments.map((item) => item.assignmentId), "scene.materialAssignments.ids"));
  diagnostics.push(...validateUniqueIds(scene.appearanceOverrides.map((item) => item.overrideId), "scene.appearanceOverrides.ids"));
  diagnostics.push(...validateUniqueIds(scene.decals.map((item) => item.decalId), "scene.decals.ids"));
  diagnostics.push(...validateUniqueIds(scene.lights.map((item) => item.lightId), "scene.lights.ids"));

  scene.tessellations.forEach((item, index) => diagnostics.push(...validateTessellation(
    item, index, scene.exactDocumentRevision, assetPolicy
  )));
  scene.physicalMaterials.forEach((item, index) => diagnostics.push(...validatePhysicalMaterial(item, index)));

  const textureIds = new Set(scene.textures.map((item) => item.textureId));
  scene.textures.forEach((item, index) => {
    diagnostics.push(...validateContentReference(item.content, `scene.textures[${index}].content`, assetPolicy));
    diagnostics.push(...validateFinite(item.uvSet, `scene.textures[${index}].uvSet`, { min: 0, integer: true }));
    diagnostics.push(...validateVector(item.transform.offset, `scene.textures[${index}].transform.offset`));
    diagnostics.push(...validateVector(item.transform.scale, `scene.textures[${index}].transform.scale`));
    diagnostics.push(...validateFinite(item.transform.rotationRadians, `scene.textures[${index}].transform.rotationRadians`));
  });

  const appearanceIds = new Set(scene.appearances.map((item) => item.appearanceId));
  scene.physicalMaterials.forEach((material, index) => {
    if (material.defaultAppearanceId !== undefined && !appearanceIds.has(material.defaultAppearanceId)) diagnostics.push(missingReference(
      `scene.physicalMaterials[${index}].defaultAppearanceId`, "appearance", material.defaultAppearanceId
    ));
  });
  scene.appearances.forEach((appearance, index) => {
    const path = `scene.appearances[${index}]`;
    diagnostics.push(...validateColor(appearance.baseColor, `${path}.baseColor`));
    diagnostics.push(...validateColor(appearance.emissiveColor, `${path}.emissiveColor`));
    diagnostics.push(...validateFinite(appearance.metallic, `${path}.metallic`, { min: 0, max: 1 }));
    diagnostics.push(...validateFinite(appearance.roughness, `${path}.roughness`, { min: 0, max: 1 }));
    diagnostics.push(...validateFinite(appearance.normalScale, `${path}.normalScale`, { min: 0 }));
    diagnostics.push(...validateFinite(appearance.emissiveStrength, `${path}.emissiveStrength`, { min: 0 }));
    diagnostics.push(...validateFinite(appearance.alphaCutoff, `${path}.alphaCutoff`, { min: 0, max: 1 }));
    appearance.textureIds.forEach((textureId, textureIndex) => {
      if (!textureIds.has(textureId)) diagnostics.push(missingReference(`${path}.textureIds[${textureIndex}]`, "texture", textureId));
    });
  });

  const materialIds = new Set(scene.physicalMaterials.map((item) => item.materialId));
  scene.materialAssignments.forEach((assignment, index) => {
    validateTarget(assignment.target, `scene.materialAssignments[${index}].target`, diagnostics);
    if (!materialIds.has(assignment.physicalMaterialId)) diagnostics.push(missingReference(
      `scene.materialAssignments[${index}].physicalMaterialId`, "physical material", assignment.physicalMaterialId
    ));
  });
  scene.appearanceOverrides.forEach((override, index) => {
    validateTarget(override.target, `scene.appearanceOverrides[${index}].target`, diagnostics);
    if (!appearanceIds.has(override.appearanceId)) diagnostics.push(missingReference(
      `scene.appearanceOverrides[${index}].appearanceId`, "appearance", override.appearanceId
    ));
    diagnostics.push(...validateFinite(override.priority, `scene.appearanceOverrides[${index}].priority`, { integer: true }));
  });
  scene.decals.forEach((decal, index) => {
    const path = `scene.decals[${index}]`;
    validateTarget(decal.target, `${path}.target`, diagnostics);
    diagnostics.push(...validateContentReference(decal.content, `${path}.content`, assetPolicy));
    diagnostics.push(...validateMatrix(decal.transform, `${path}.transform`));
    diagnostics.push(...validateFinite(decal.opacity, `${path}.opacity`, { min: 0, max: 1 }));
    diagnostics.push(...validateFinite(decal.roughnessInfluence, `${path}.roughnessInfluence`, { min: -1, max: 1 }));
  });

  if (scene.environment !== null) {
    diagnostics.push(...validateStableId(scene.environment.environmentId, "scene.environment.environmentId"));
    diagnostics.push(...validateContentReference(scene.environment.content, "scene.environment.content", assetPolicy));
    diagnostics.push(...validateFinite(scene.environment.rotationRadians, "scene.environment.rotationRadians"));
    diagnostics.push(...validateFinite(scene.environment.intensity, "scene.environment.intensity", { min: 0 }));
    diagnostics.push(...validateColor(scene.environment.backgroundColor, "scene.environment.backgroundColor"));
  }
  scene.lights.forEach((light, index) => diagnostics.push(...validateLight(light, `scene.lights[${index}]`)));
  diagnostics.push(...validateFinite(scene.shadows.maximumDistanceMeters, "scene.shadows.maximumDistanceMeters", { min: 0 }));
  diagnostics.push(...validateFinite(scene.shadows.normalBiasMeters, "scene.shadows.normalBiasMeters", { min: 0 }));
  diagnostics.push(...validateFinite(scene.shadows.contactDistanceMeters, "scene.shadows.contactDistanceMeters", { min: 0 }));
  diagnostics.push(...validateFinite(scene.toneMapping.exposureEv, "scene.toneMapping.exposureEv", { min: -24, max: 24 }));
  diagnostics.push(...validateFinite(scene.toneMapping.whiteBalanceKelvin, "scene.toneMapping.whiteBalanceKelvin", { min: 1000, max: 40000 }));
  diagnostics.push(...validateMatrix(scene.camera.transform, "scene.camera.transform"));
  diagnostics.push(...validateFinite(scene.camera.verticalFieldOfViewRadians, "scene.camera.verticalFieldOfViewRadians", { min: 0.001, max: Math.PI - 0.001 }));
  diagnostics.push(...validateFinite(scene.camera.orthographicHeightMeters, "scene.camera.orthographicHeightMeters", { min: Number.MIN_VALUE }));
  diagnostics.push(...validateFinite(scene.camera.nearMeters, "scene.camera.nearMeters", { min: Number.MIN_VALUE }));
  diagnostics.push(...validateFinite(scene.camera.farMeters, "scene.camera.farMeters", { min: Number.MIN_VALUE }));
  if (scene.camera.farMeters <= scene.camera.nearMeters) diagnostics.push(diagnostic(
    "INVALID_RENDER_REQUEST", "error", "scene.camera.farMeters", "Far plane must be farther than the near plane.", "Increase farMeters."
  ));

  diagnostics.push(...findForbiddenGeometryFields(scene));
  return diagnostics;
}

export function validateRenderRequest(
  request: RenderRequest,
  assetPolicy: AssetUriPolicy = DEFAULT_ASSET_URI_POLICY
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [
    ...validateStableId(request.requestId, "request.requestId"),
    ...validateFinite(request.widthPixels, "request.widthPixels", { min: 1, max: 32768, integer: true }),
    ...validateFinite(request.heightPixels, "request.heightPixels", { min: 1, max: 32768, integer: true }),
    ...validateRenderScene(request.scene, assetPolicy)
  ];
  if (request.mode === "path-trace") diagnostics.push(...validatePathTraceSettings(request));
  return diagnostics;
}

function validatePathTraceSettings(request: PathTraceRequest): readonly RenderExchangeDiagnostic[] {
  return [
    ...validateFinite(request.samplesPerPixel, "request.samplesPerPixel", { min: 1, max: 1_000_000, integer: true }),
    ...validateFinite(request.maximumBounces, "request.maximumBounces", { min: 0, max: 128, integer: true }),
    ...validateFinite(request.russianRouletteStartBounce, "request.russianRouletteStartBounce", { min: 0, max: 128, integer: true }),
    ...validateFinite(request.clampIndirect, "request.clampIndirect", { min: 0 }),
    ...validateFinite(request.deterministicSeed, "request.deterministicSeed", { min: 0, integer: true }),
    ...validateFinite(request.maximumRenderMilliseconds, "request.maximumRenderMilliseconds", { min: 1, integer: true })
  ];
}

function validateTessellation(
  item: DerivedTessellationReference,
  index: number,
  documentRevision: number,
  assetPolicy: AssetUriPolicy
): readonly RenderExchangeDiagnostic[] {
  const path = `scene.tessellations[${index}]`;
  const diagnostics: RenderExchangeDiagnostic[] = [
    ...validateDigest(item.sourceExactShapeDigest, `${path}.sourceExactShapeDigest`),
    ...validateDigest(item.tessellationDigest, `${path}.tessellationDigest`),
    ...validateDigest(item.topologyBindingDigest, `${path}.topologyBindingDigest`),
    ...validateFinite(item.sourceDocumentRevision, `${path}.sourceDocumentRevision`, { min: 0, integer: true }),
    ...validateFinite(item.linearDeflectionMeters, `${path}.linearDeflectionMeters`, { min: Number.MIN_VALUE }),
    ...validateFinite(item.angularDeflectionRadians, `${path}.angularDeflectionRadians`, { min: Number.MIN_VALUE, max: Math.PI }),
    ...validateFinite(item.triangleCount, `${path}.triangleCount`, { min: 0, integer: true }),
    ...validateFinite(item.vertexCount, `${path}.vertexCount`, { min: 0, integer: true }),
    ...validateContentReference(item.content, `${path}.content`, assetPolicy)
  ];
  if (item.representation !== "derived-display-tessellation") diagnostics.push(diagnostic(
    "EXACT_SOURCE_REQUIRED", "error", `${path}.representation`, "Render geometry must be a derived display tessellation.",
    "Generate a digest-bound tessellation from the exact kernel; never substitute editable mesh geometry."
  ));
  if (item.sourceDocumentRevision !== documentRevision) diagnostics.push(diagnostic(
    "TESSELLATION_REVISION_MISMATCH", "error", `${path}.sourceDocumentRevision`,
    "Tessellation was produced from a different exact-document revision.", "Regenerate the display tessellation from the current exact model."
  ));
  return diagnostics;
}

function validatePhysicalMaterial(material: PhysicalMaterial, index: number): readonly RenderExchangeDiagnostic[] {
  const path = `scene.physicalMaterials[${index}]`;
  const diagnostics: RenderExchangeDiagnostic[] = [
    ...validateFinite(material.density.value, `${path}.density.value`, { min: Number.MIN_VALUE })
  ];
  if (material.poissonRatio !== undefined) diagnostics.push(...validateFinite(material.poissonRatio, `${path}.poissonRatio`, { min: -1, max: 0.5 }));
  if (material.elasticModulus !== undefined) diagnostics.push(...validateFinite(material.elasticModulus.value, `${path}.elasticModulus.value`, { min: 0 }));
  if (material.yieldStrength !== undefined) diagnostics.push(...validateFinite(material.yieldStrength.value, `${path}.yieldStrength.value`, { min: 0 }));
  if (material.thermalConductivity !== undefined) diagnostics.push(...validateFinite(material.thermalConductivity.value, `${path}.thermalConductivity.value`, { min: 0 }));
  if (material.specificHeat !== undefined) diagnostics.push(...validateFinite(material.specificHeat.value, `${path}.specificHeat.value`, { min: 0 }));
  if (material.engineeringSourceDigest !== undefined) diagnostics.push(...validateDigest(material.engineeringSourceDigest, `${path}.engineeringSourceDigest`));
  return diagnostics;
}

function validateLight(light: RenderScene["lights"][number], path: string): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [...validateColor(light.color, `${path}.color`)];
  if (light.kind === "directional") {
    diagnostics.push(...validateFinite(light.intensityLux, `${path}.intensityLux`, { min: 0 }));
    diagnostics.push(...validateDirection(light.direction, `${path}.direction`));
  } else if (light.kind === "point") {
    diagnostics.push(...validateFinite(light.luminousFluxLumens, `${path}.luminousFluxLumens`, { min: 0 }));
    diagnostics.push(...validateVector(light.positionMeters, `${path}.positionMeters`));
    diagnostics.push(...validateFinite(light.rangeMeters, `${path}.rangeMeters`, { min: 0 }));
  } else if (light.kind === "spot") {
    diagnostics.push(...validateFinite(light.luminousFluxLumens, `${path}.luminousFluxLumens`, { min: 0 }));
    diagnostics.push(...validateVector(light.positionMeters, `${path}.positionMeters`));
    diagnostics.push(...validateDirection(light.direction, `${path}.direction`));
    diagnostics.push(...validateFinite(light.innerConeRadians, `${path}.innerConeRadians`, { min: 0, max: Math.PI }));
    diagnostics.push(...validateFinite(light.outerConeRadians, `${path}.outerConeRadians`, { min: 0, max: Math.PI }));
    diagnostics.push(...validateFinite(light.rangeMeters, `${path}.rangeMeters`, { min: 0 }));
    if (light.innerConeRadians > light.outerConeRadians) diagnostics.push(diagnostic(
      "INVALID_RENDER_REQUEST", "error", `${path}.innerConeRadians`, "Spot inner cone exceeds its outer cone.", "Reduce the inner cone."
    ));
  } else {
    diagnostics.push(...validateFinite(light.luminanceNits, `${path}.luminanceNits`, { min: 0 }));
    diagnostics.push(...validateMatrix(light.transform, `${path}.transform`));
    diagnostics.push(...validateVector(light.sizeMeters, `${path}.sizeMeters`));
    if (light.sizeMeters.some((value) => value <= 0)) diagnostics.push(diagnostic(
      "INVALID_RENDER_REQUEST", "error", `${path}.sizeMeters`, "Area-light dimensions must be positive.", "Supply positive width and height."
    ));
  }
  return diagnostics;
}

function validateTarget(target: AppearanceTarget, path: string, diagnostics: RenderExchangeDiagnostic[]): void {
  if (target.kind === "component") diagnostics.push(...validateStableId(target.componentId, `${path}.componentId`));
  else if (target.kind === "occurrence") diagnostics.push(...validateStableId(target.occurrenceId, `${path}.occurrenceId`));
  else if (target.kind === "body") diagnostics.push(...validateStableId(target.bodyId, `${path}.bodyId`));
  else {
    diagnostics.push(...validateDigest(target.exactShapeDigest, `${path}.exactShapeDigest`));
    if (target.topologyReferenceKey.length === 0) diagnostics.push(diagnostic(
      "REFERENCE_NOT_FOUND", "error", `${path}.topologyReferenceKey`, "Face override requires a stable topology reference.", "Select a persistent exact-kernel face reference."
    ));
  }
}

function validateVector(vector: Vector2 | Vector3, path: string): readonly RenderExchangeDiagnostic[] {
  return vector.flatMap((value, index) => validateFinite(value, `${path}[${index}]`));
}

function validateDirection(vector: Vector3, path: string): readonly RenderExchangeDiagnostic[] {
  const diagnostics = [...validateVector(vector, path)];
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-6) diagnostics.push(diagnostic(
    "INVALID_RENDER_REQUEST", "error", path, "Direction must be normalized.", "Normalize the three-vector before submission."
  ));
  return diagnostics;
}

function validateMatrix(matrix: Matrix4, path: string): readonly RenderExchangeDiagnostic[] {
  return matrix.flatMap((value, index) => validateFinite(value, `${path}[${index}]`));
}

function missingReference(path: string, kind: string, id: string): RenderExchangeDiagnostic {
  return diagnostic("REFERENCE_NOT_FOUND", "error", path, `Referenced ${kind} '${id}' does not exist in the scene.`, `Add the ${kind} or update the reference.`);
}

function findForbiddenGeometryFields(scene: RenderScene): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  const inspect = (value: unknown, path: string, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_RENDER_GEOMETRY_KEYS.has(key)) diagnostics.push(diagnostic(
        "EXACT_SOURCE_REQUIRED", "error", `${path}.${key}`, "Render-scene payload attempts to carry editable or exact geometry.",
        "Keep exact B-rep data in the kernel and pass only immutable derived tessellation references."
      ));
      else inspect(item, `${path}.${key}`, depth + 1);
    }
  };
  inspect(scene, "scene", 0);
  return diagnostics;
}
