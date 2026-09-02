export const RENDER_EXCHANGE_PROTOCOL_VERSION = 1 as const;

export type StableId = string;
export type Sha256Digest = `sha256:${string}`;
export type Vector2 = readonly [number, number];
export type Vector3 = readonly [number, number, number];
export type RgbColor = readonly [number, number, number];
export type RgbaColor = readonly [number, number, number, number];
export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export type LengthUnit = "m" | "mm" | "cm" | "in" | "ft";
export type AngleUnit = "rad" | "deg";
export type MassUnit = "kg" | "g" | "lb";
export type AssetScheme = "asset" | "blob" | "data" | "https" | "urn";

export interface AssetUriPolicy {
  readonly allowedSchemes: readonly AssetScheme[];
  readonly allowedHttpsOrigins: readonly string[];
  readonly allowEmbeddedData: boolean;
  readonly maximumEmbeddedBytes: number;
  readonly requireDigest: true;
  readonly forbidCredentials: true;
  readonly forbidFragments: boolean;
}

export interface ContentReference {
  readonly uri: string;
  readonly contentDigest: Sha256Digest;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly fileName?: string;
}

export interface ScalarProperty {
  readonly value: number;
  readonly unit: string;
  readonly source: "supplier" | "standard" | "measured" | "estimated" | "user";
  readonly sourceReference?: string;
}

/** Engineering properties; authoritative for mass/analysis, never changed by appearance overrides. */
export interface PhysicalMaterial {
  readonly materialId: StableId;
  readonly name: string;
  readonly revision: string;
  readonly materialClass: "metal" | "polymer" | "ceramic" | "composite" | "wood" | "glass" | "fluid" | "other";
  readonly density: ScalarProperty;
  readonly elasticModulus?: ScalarProperty;
  readonly poissonRatio?: number;
  readonly yieldStrength?: ScalarProperty;
  readonly thermalConductivity?: ScalarProperty;
  readonly specificHeat?: ScalarProperty;
  readonly engineeringSourceDigest?: Sha256Digest;
  readonly defaultAppearanceId?: StableId;
}

export type TextureSemantic =
  | "base-color" | "metallic" | "roughness" | "normal" | "height"
  | "ambient-occlusion" | "emissive" | "opacity" | "clearcoat" | "sheen";

export interface TextureReference {
  readonly textureId: StableId;
  readonly semantic: TextureSemantic;
  readonly content: ContentReference;
  readonly colorSpace: "srgb" | "linear" | "raw";
  readonly uvSet: number;
  readonly transform: {
    readonly offset: Vector2;
    readonly scale: Vector2;
    readonly rotationRadians: number;
  };
  readonly wrapU: "repeat" | "clamp" | "mirror";
  readonly wrapV: "repeat" | "clamp" | "mirror";
}

/** Rendering-only PBR data. It has no density, strength, or simulation authority. */
export interface PbrAppearance {
  readonly appearanceId: StableId;
  readonly name: string;
  readonly model: "metallic-roughness";
  readonly baseColor: RgbaColor;
  readonly metallic: number;
  readonly roughness: number;
  readonly normalScale: number;
  readonly emissiveColor: RgbColor;
  readonly emissiveStrength: number;
  readonly opacityMode: "opaque" | "mask" | "blend";
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  readonly textureIds: readonly StableId[];
}

export type AppearanceTarget =
  | { readonly kind: "component"; readonly componentId: StableId }
  | { readonly kind: "occurrence"; readonly occurrenceId: StableId }
  | { readonly kind: "body"; readonly bodyId: StableId }
  | { readonly kind: "face"; readonly exactShapeDigest: Sha256Digest; readonly topologyReferenceKey: string };

export interface MaterialAssignment {
  readonly assignmentId: StableId;
  readonly target: AppearanceTarget;
  readonly physicalMaterialId: StableId;
}

export interface AppearanceOverride {
  readonly overrideId: StableId;
  readonly target: AppearanceTarget;
  readonly appearanceId: StableId;
  readonly priority: number;
  readonly purpose: "design" | "selection" | "analysis-overlay" | "presentation";
}

export interface DecalReference {
  readonly decalId: StableId;
  readonly content: ContentReference;
  readonly target: AppearanceTarget;
  readonly projection: "planar" | "cylindrical" | "spherical" | "uv";
  readonly transform: Matrix4;
  readonly opacity: number;
  readonly roughnessInfluence: number;
}

export interface HdrEnvironmentReference {
  readonly environmentId: StableId;
  readonly content: ContentReference;
  readonly rotationRadians: number;
  readonly intensity: number;
  readonly visibleToCamera: boolean;
  readonly backgroundColor: RgbColor;
}

export type SceneLight =
  | {
      readonly lightId: StableId;
      readonly kind: "directional";
      readonly color: RgbColor;
      readonly intensityLux: number;
      readonly direction: Vector3;
      readonly castsShadow: boolean;
    }
  | {
      readonly lightId: StableId;
      readonly kind: "point";
      readonly color: RgbColor;
      readonly luminousFluxLumens: number;
      readonly positionMeters: Vector3;
      readonly rangeMeters: number;
      readonly castsShadow: boolean;
    }
  | {
      readonly lightId: StableId;
      readonly kind: "spot";
      readonly color: RgbColor;
      readonly luminousFluxLumens: number;
      readonly positionMeters: Vector3;
      readonly direction: Vector3;
      readonly innerConeRadians: number;
      readonly outerConeRadians: number;
      readonly rangeMeters: number;
      readonly castsShadow: boolean;
    }
  | {
      readonly lightId: StableId;
      readonly kind: "area";
      readonly color: RgbColor;
      readonly luminanceNits: number;
      readonly transform: Matrix4;
      readonly sizeMeters: Vector2;
      readonly shape: "rectangle" | "disk";
      readonly castsShadow: boolean;
    };

export interface ShadowSettings {
  readonly enabled: boolean;
  readonly mapSize: 512 | 1024 | 2048 | 4096 | 8192;
  readonly maximumDistanceMeters: number;
  readonly normalBiasMeters: number;
  readonly contactShadows: boolean;
  readonly contactDistanceMeters: number;
}

export interface ToneMappingSettings {
  readonly operator: "none" | "linear" | "reinhard" | "aces-filmic" | "agx";
  readonly exposureEv: number;
  readonly whiteBalanceKelvin: number;
  readonly outputColorSpace: "srgb" | "display-p3" | "rec2020";
}

/** Immutable display derivative. It can be discarded and regenerated from the exact model. */
export interface DerivedTessellationReference {
  readonly tessellationId: StableId;
  readonly representation: "derived-display-tessellation";
  readonly sourceExactShapeDigest: Sha256Digest;
  readonly sourceDocumentRevision: number;
  readonly tessellationDigest: Sha256Digest;
  readonly topologyBindingDigest: Sha256Digest;
  readonly linearDeflectionMeters: number;
  readonly angularDeflectionRadians: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly content: ContentReference;
}

export interface CameraSettings {
  readonly projection: "perspective" | "orthographic";
  readonly transform: Matrix4;
  readonly verticalFieldOfViewRadians: number;
  readonly orthographicHeightMeters: number;
  readonly nearMeters: number;
  readonly farMeters: number;
}

export interface RenderScene {
  readonly sceneId: StableId;
  readonly sceneRevision: number;
  readonly exactDocumentId: StableId;
  readonly exactDocumentRevision: number;
  readonly exactDocumentDigest: Sha256Digest;
  readonly tessellations: readonly DerivedTessellationReference[];
  readonly physicalMaterials: readonly PhysicalMaterial[];
  readonly appearances: readonly PbrAppearance[];
  readonly textures: readonly TextureReference[];
  readonly materialAssignments: readonly MaterialAssignment[];
  readonly appearanceOverrides: readonly AppearanceOverride[];
  readonly decals: readonly DecalReference[];
  readonly environment: HdrEnvironmentReference | null;
  readonly lights: readonly SceneLight[];
  readonly shadows: ShadowSettings;
  readonly toneMapping: ToneMappingSettings;
  readonly camera: CameraSettings;
}

export interface RasterRenderRequest {
  readonly requestId: StableId;
  readonly mode: "raster";
  readonly scene: RenderScene;
  readonly widthPixels: number;
  readonly heightPixels: number;
  readonly antialiasing: "none" | "fxaa" | "msaa-4x" | "msaa-8x";
  readonly transparentBackground: boolean;
}

export interface PathTraceRequest {
  readonly requestId: StableId;
  readonly mode: "path-trace";
  readonly scene: RenderScene;
  readonly widthPixels: number;
  readonly heightPixels: number;
  readonly samplesPerPixel: number;
  readonly maximumBounces: number;
  readonly russianRouletteStartBounce: number;
  readonly clampIndirect: number;
  readonly denoiser: "none" | "oidn" | "optix" | "renderer-native";
  readonly deterministicSeed: number;
  readonly maximumRenderMilliseconds: number;
}

export type RenderRequest = RasterRenderRequest | PathTraceRequest;

export interface RenderProductReceipt {
  readonly protocolVersion: typeof RENDER_EXCHANGE_PROTOCOL_VERSION;
  readonly requestDigest: Sha256Digest;
  readonly sceneDigest: Sha256Digest;
  readonly exactDocumentDigest: Sha256Digest;
  readonly tessellationDigests: readonly Sha256Digest[];
  readonly renderer: { readonly implementation: string; readonly version: string; readonly buildDigest: Sha256Digest };
  readonly output: ContentReference;
  readonly deterministic: boolean;
  readonly resultDigest: Sha256Digest;
}

export const EXACT_NEUTRAL_FORMATS = ["step", "iges", "brep"] as const;
export const MESH_FORMATS = ["stl", "obj", "3mf"] as const;
export const DRAWING_FORMATS = ["dxf", "svg"] as const;
export const PROPRIETARY_FORMATS = ["nx", "catia-v5", "creo", "solidworks"] as const;

export type ExactNeutralFormat = typeof EXACT_NEUTRAL_FORMATS[number];
export type MeshFormat = typeof MESH_FORMATS[number];
export type DrawingFormat = typeof DRAWING_FORMATS[number];
export type OpenExchangeFormat = ExactNeutralFormat | MeshFormat | DrawingFormat;
export type ProprietaryExchangeFormat = typeof PROPRIETARY_FORMATS[number];
export type ExchangeFormat = OpenExchangeFormat | ProprietaryExchangeFormat;
export type ExchangeDirection = "import" | "export";

export interface TransferPreservationRequest {
  readonly assemblyStructure: "required" | "preferred" | "ignore";
  readonly names: "required" | "preferred" | "ignore";
  readonly colors: "required" | "preferred" | "ignore";
  readonly layers: "required" | "preferred" | "ignore";
  readonly productMetadata: "required" | "preferred" | "ignore";
}

export interface ExchangeValidationOptions {
  readonly validateExactGeometry: boolean;
  readonly rejectInvalidGeometry: boolean;
  readonly rejectNonManifoldMesh: boolean;
  readonly maximumToleranceMeters: number;
}

export interface ExchangeHealingOptions {
  readonly enabled: boolean;
  readonly sewOpenShells: boolean;
  readonly fixSmallEdges: boolean;
  readonly fixWireGaps: boolean;
  readonly orientShells: boolean;
  readonly maximumHealingToleranceMeters: number;
}

export interface LicensedTranslatorRequirement {
  readonly provider: string;
  readonly capabilityId: string;
  readonly licenseEntitlementId: string;
  readonly minimumVersion: string;
}

interface ExchangeJobBase {
  readonly protocolVersion: typeof RENDER_EXCHANGE_PROTOCOL_VERSION;
  readonly jobId: StableId;
  readonly direction: ExchangeDirection;
  readonly documentId: StableId;
  readonly documentRevision: number;
  readonly documentDigest: Sha256Digest;
  readonly lengthUnit: LengthUnit;
  readonly angleUnit: AngleUnit;
  readonly preservation: TransferPreservationRequest;
  readonly validation: ExchangeValidationOptions;
  readonly healing: ExchangeHealingOptions;
  readonly artifact: ContentReference;
}

export interface OpenExchangeJob extends ExchangeJobBase {
  readonly translatorKind: "open-format";
  readonly format: OpenExchangeFormat;
  readonly meshOptions?: {
    readonly linearDeflectionMeters: number;
    readonly angularDeflectionRadians: number;
    readonly binary: boolean;
  };
  readonly drawingOptions?: {
    readonly paperSpace: boolean;
    readonly preserveAssociativeIds: boolean;
  };
}

export interface ProprietaryExchangeJob extends ExchangeJobBase {
  readonly translatorKind: "licensed-proprietary";
  readonly format: ProprietaryExchangeFormat;
  readonly translatorRequirement: LicensedTranslatorRequirement;
}

export type ExchangeJob = OpenExchangeJob | ProprietaryExchangeJob;

export interface TranslatorIdentity {
  readonly translatorId: StableId;
  readonly implementation: string;
  readonly implementationVersion: string;
  readonly buildDigest: Sha256Digest;
  readonly licenseProvider: string | null;
}

export interface TranslatorCapability {
  readonly capabilityId: string;
  readonly format: ExchangeFormat;
  readonly directions: readonly ExchangeDirection[];
  readonly minimumFormatVersion: string | null;
  readonly maximumFormatVersion: string | null;
  readonly requiresLicense: boolean;
  readonly activeEntitlementIds: readonly string[];
  readonly preserves: {
    readonly assemblyStructure: boolean;
    readonly names: boolean;
    readonly colors: boolean;
    readonly layers: boolean;
    readonly productMetadata: boolean;
  };
}

export interface TranslatorManifest {
  readonly identity: TranslatorIdentity;
  readonly capabilities: readonly TranslatorCapability[];
}

export type RenderExchangeDiagnosticCode =
  | "INVALID_ID" | "INVALID_DIGEST" | "INVALID_NUMBER" | "INVALID_COLOR"
  | "ASSET_SCHEME_DENIED" | "ASSET_ORIGIN_DENIED" | "ASSET_CREDENTIALS_DENIED"
  | "ASSET_FRAGMENT_DENIED" | "ASSET_TRAVERSAL_DENIED" | "ASSET_TOO_LARGE"
  | "REFERENCE_NOT_FOUND" | "DUPLICATE_ID" | "EXACT_SOURCE_REQUIRED"
  | "TESSELLATION_REVISION_MISMATCH" | "INVALID_RENDER_REQUEST"
  | "UNSUPPORTED_FORMAT" | "LICENSED_TRANSLATOR_REQUIRED" | "LICENSE_ENTITLEMENT_MISSING"
  | "TRANSLATOR_CAPABILITY_MISSING" | "PRESERVATION_UNAVAILABLE" | "INVALID_EXCHANGE_JOB"
  | "HEALING_INCOMPLETE" | "GEOMETRY_INVALID" | "TRANSFER_LOSS" | "RECEIPT_MISMATCH";

export interface RenderExchangeDiagnostic {
  readonly code: RenderExchangeDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly path: string;
  readonly message: string;
  readonly recovery: string;
}

export interface HealingReport {
  readonly attempted: boolean;
  readonly changedGeometry: boolean;
  readonly inputToleranceMeters: number;
  readonly outputToleranceMeters: number;
  readonly fixedSmallEdges: number;
  readonly fixedWireGaps: number;
  readonly sewnShells: number;
  readonly remainingOpenShells: number;
  readonly diagnostics: readonly RenderExchangeDiagnostic[];
}

export interface GeometryValidationReport {
  readonly attempted: boolean;
  readonly valid: boolean;
  readonly exact: boolean;
  readonly manifold: boolean | null;
  readonly closed: boolean | null;
  readonly checkedToleranceMeters: number;
  readonly invalidEntityCount: number;
  readonly diagnostics: readonly RenderExchangeDiagnostic[];
}

export interface TransferPreservationReport {
  readonly assemblyStructure: "preserved" | "flattened" | "not-applicable" | "unknown";
  readonly names: "preserved" | "partial" | "lost" | "not-applicable" | "unknown";
  readonly colors: "preserved" | "partial" | "lost" | "not-applicable" | "unknown";
  readonly layers: "preserved" | "partial" | "lost" | "not-applicable" | "unknown";
  readonly productMetadata: "preserved" | "partial" | "lost" | "not-applicable" | "unknown";
}

export interface TransferStatistics {
  readonly assemblies: number;
  readonly components: number;
  readonly bodies: number;
  readonly solids: number;
  readonly shells: number;
  readonly faces: number;
  readonly curves: number;
  readonly meshes: number;
  readonly drawingEntities: number;
  readonly skippedEntities: number;
}

export interface ExchangeTransferReport {
  readonly jobId: StableId;
  readonly direction: ExchangeDirection;
  readonly format: ExchangeFormat;
  readonly status: "succeeded" | "succeeded-with-warnings" | "failed";
  readonly sourceArtifact: ContentReference;
  readonly resultArtifact: ContentReference | null;
  readonly translator: TranslatorIdentity;
  readonly sourceLengthUnit: LengthUnit;
  readonly resultLengthUnit: LengthUnit;
  readonly scaleApplied: number;
  readonly preservation: TransferPreservationReport;
  readonly healing: HealingReport;
  readonly validation: GeometryValidationReport;
  readonly statistics: TransferStatistics;
  readonly diagnostics: readonly RenderExchangeDiagnostic[];
}

export interface ExchangeContentReceipt {
  readonly protocolVersion: typeof RENDER_EXCHANGE_PROTOCOL_VERSION;
  readonly jobDigest: Sha256Digest;
  readonly reportDigest: Sha256Digest;
  readonly sourceContentDigest: Sha256Digest;
  readonly resultContentDigest: Sha256Digest | null;
  readonly documentDigest: Sha256Digest;
  readonly translatorBuildDigest: Sha256Digest;
  readonly receiptDigest: Sha256Digest;
}
