import type {
  ContentReference,
  ExchangeTransferReport,
  OpenExchangeJob,
  PathTraceRequest,
  ProprietaryExchangeJob,
  RenderScene,
  Sha256Digest,
  TranslatorManifest
} from "../src/index.js";
import { RENDER_EXCHANGE_PROTOCOL_VERSION } from "../src/index.js";

export const DIGEST_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
export const DIGEST_B = `sha256:${"b".repeat(64)}` as Sha256Digest;
export const DIGEST_C = `sha256:${"c".repeat(64)}` as Sha256Digest;
export const DIGEST_D = `sha256:${"d".repeat(64)}` as Sha256Digest;
export const DIGEST_E = `sha256:${"e".repeat(64)}` as Sha256Digest;

export const IDENTITY_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
] as const;

export function content(uri: string, digest: Sha256Digest, mediaType: string): ContentReference {
  return { uri, contentDigest: digest, byteLength: 1024, mediaType };
}

export function scene(): RenderScene {
  return {
    sceneId: "scene:main",
    sceneRevision: 3,
    exactDocumentId: "document:fixture",
    exactDocumentRevision: 8,
    exactDocumentDigest: DIGEST_A,
    tessellations: [{
      tessellationId: "tessellation:body-1",
      representation: "derived-display-tessellation",
      sourceExactShapeDigest: DIGEST_B,
      sourceDocumentRevision: 8,
      tessellationDigest: DIGEST_C,
      topologyBindingDigest: DIGEST_D,
      linearDeflectionMeters: 0.0001,
      angularDeflectionRadians: 0.1,
      triangleCount: 24,
      vertexCount: 18,
      content: content("asset:tessellation/body-1", DIGEST_C, "application/vnd.ps3d.tessellation")
    }],
    physicalMaterials: [{
      materialId: "material:steel",
      name: "Steel",
      revision: "1",
      materialClass: "metal",
      density: { value: 7850, unit: "kg/m3", source: "standard" },
      elasticModulus: { value: 200e9, unit: "Pa", source: "standard" },
      poissonRatio: 0.3,
      yieldStrength: { value: 250e6, unit: "Pa", source: "standard" },
      thermalConductivity: { value: 45, unit: "W/(m K)", source: "standard" },
      specificHeat: { value: 490, unit: "J/(kg K)", source: "standard" },
      engineeringSourceDigest: DIGEST_E,
      defaultAppearanceId: "appearance:steel"
    }],
    appearances: [{
      appearanceId: "appearance:steel",
      name: "Brushed steel",
      model: "metallic-roughness",
      baseColor: [0.55, 0.57, 0.6, 1],
      metallic: 1,
      roughness: 0.32,
      normalScale: 1,
      emissiveColor: [0, 0, 0],
      emissiveStrength: 0,
      opacityMode: "opaque",
      alphaCutoff: 0.5,
      doubleSided: false,
      textureIds: ["texture:steel-normal"]
    }],
    textures: [{
      textureId: "texture:steel-normal",
      semantic: "normal",
      content: content("asset:textures/steel-normal", DIGEST_E, "image/png"),
      colorSpace: "raw",
      uvSet: 0,
      transform: { offset: [0, 0], scale: [1, 1], rotationRadians: 0 },
      wrapU: "repeat",
      wrapV: "repeat"
    }],
    materialAssignments: [{
      assignmentId: "assignment:steel-body",
      target: { kind: "body", bodyId: "body:1" },
      physicalMaterialId: "material:steel"
    }],
    appearanceOverrides: [{
      overrideId: "override:presentation",
      target: { kind: "body", bodyId: "body:1" },
      appearanceId: "appearance:steel",
      priority: 10,
      purpose: "presentation"
    }],
    decals: [],
    environment: {
      environmentId: "environment:studio",
      content: content("asset:environments/studio", DIGEST_D, "image/vnd.radiance"),
      rotationRadians: 0,
      intensity: 1,
      visibleToCamera: true,
      backgroundColor: [0.08, 0.09, 0.1]
    },
    lights: [{
      lightId: "light:key",
      kind: "directional",
      color: [1, 0.98, 0.95],
      intensityLux: 25000,
      direction: [0, -1, 0],
      castsShadow: true
    }],
    shadows: {
      enabled: true,
      mapSize: 2048,
      maximumDistanceMeters: 100,
      normalBiasMeters: 0.0001,
      contactShadows: true,
      contactDistanceMeters: 0.02
    },
    toneMapping: {
      operator: "aces-filmic",
      exposureEv: 0,
      whiteBalanceKelvin: 6500,
      outputColorSpace: "srgb"
    },
    camera: {
      projection: "perspective",
      transform: IDENTITY_MATRIX,
      verticalFieldOfViewRadians: 0.8,
      orthographicHeightMeters: 1,
      nearMeters: 0.01,
      farMeters: 1000
    }
  };
}

export function pathTraceRequest(): PathTraceRequest {
  return {
    requestId: "render:hero",
    mode: "path-trace",
    scene: scene(),
    widthPixels: 1920,
    heightPixels: 1080,
    samplesPerPixel: 256,
    maximumBounces: 12,
    russianRouletteStartBounce: 5,
    clampIndirect: 10,
    denoiser: "oidn",
    deterministicSeed: 42,
    maximumRenderMilliseconds: 120000
  };
}

export function stepExportJob(): OpenExchangeJob {
  return {
    protocolVersion: RENDER_EXCHANGE_PROTOCOL_VERSION,
    jobId: "exchange:step-export",
    direction: "export",
    documentId: "document:fixture",
    documentRevision: 8,
    documentDigest: DIGEST_A,
    lengthUnit: "mm",
    angleUnit: "deg",
    preservation: {
      assemblyStructure: "required",
      names: "required",
      colors: "preferred",
      layers: "preferred",
      productMetadata: "preferred"
    },
    validation: {
      validateExactGeometry: true,
      rejectInvalidGeometry: true,
      rejectNonManifoldMesh: true,
      maximumToleranceMeters: 0.00001
    },
    healing: {
      enabled: false,
      sewOpenShells: false,
      fixSmallEdges: false,
      fixWireGaps: false,
      orientShells: false,
      maximumHealingToleranceMeters: 0.000001
    },
    artifact: content("asset:model/document-8", DIGEST_A, "application/vnd.ps3d.exact-model-manifest"),
    translatorKind: "open-format",
    format: "step"
  };
}

export function nativeNxImportJob(): ProprietaryExchangeJob {
  return {
    ...stepExportJob(),
    jobId: "exchange:nx-import",
    direction: "import",
    translatorKind: "licensed-proprietary",
    format: "nx",
    artifact: content("asset:uploads/model-prt", DIGEST_B, "application/octet-stream"),
    translatorRequirement: {
      provider: "licensed-vendor",
      capabilityId: "translator:nx",
      licenseEntitlementId: "entitlement:nx-prod",
      minimumVersion: "3.2.0"
    }
  };
}

export function translatorManifest(withEntitlement: boolean): TranslatorManifest {
  return {
    identity: {
      translatorId: "translator:worker-1",
      implementation: "PS3D qualified translators",
      implementationVersion: "3.2.1",
      buildDigest: DIGEST_E,
      licenseProvider: "licensed-vendor"
    },
    capabilities: [{
      capabilityId: "translator:step",
      format: "step",
      directions: ["import", "export"],
      minimumFormatVersion: "AP203",
      maximumFormatVersion: "AP242",
      requiresLicense: false,
      activeEntitlementIds: [],
      preserves: {
        assemblyStructure: true,
        names: true,
        colors: true,
        layers: true,
        productMetadata: true
      }
    }, {
      capabilityId: "translator:nx",
      format: "nx",
      directions: ["import"],
      minimumFormatVersion: null,
      maximumFormatVersion: null,
      requiresLicense: true,
      activeEntitlementIds: withEntitlement ? ["entitlement:nx-prod"] : [],
      preserves: {
        assemblyStructure: true,
        names: true,
        colors: true,
        layers: true,
        productMetadata: true
      }
    }]
  };
}

export function successfulStepReport(): ExchangeTransferReport {
  return {
    jobId: "exchange:step-export",
    direction: "export",
    format: "step",
    status: "succeeded",
    sourceArtifact: content("asset:model/document-8", DIGEST_A, "application/vnd.ps3d.exact-model-manifest"),
    resultArtifact: content("asset:exports/model-step", DIGEST_C, "model/step"),
    translator: translatorManifest(false).identity,
    sourceLengthUnit: "mm",
    resultLengthUnit: "mm",
    scaleApplied: 1,
    preservation: {
      assemblyStructure: "preserved",
      names: "preserved",
      colors: "preserved",
      layers: "preserved",
      productMetadata: "preserved"
    },
    healing: {
      attempted: false,
      changedGeometry: false,
      inputToleranceMeters: 0.000001,
      outputToleranceMeters: 0.000001,
      fixedSmallEdges: 0,
      fixedWireGaps: 0,
      sewnShells: 0,
      remainingOpenShells: 0,
      diagnostics: []
    },
    validation: {
      attempted: true,
      valid: true,
      exact: true,
      manifold: true,
      closed: true,
      checkedToleranceMeters: 0.00001,
      invalidEntityCount: 0,
      diagnostics: []
    },
    statistics: {
      assemblies: 1,
      components: 4,
      bodies: 4,
      solids: 4,
      shells: 4,
      faces: 48,
      curves: 0,
      meshes: 0,
      drawingEntities: 0,
      skippedEntities: 0
    },
    diagnostics: []
  };
}
