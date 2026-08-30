export const WORKBENCH_FORMAT = "ps3d-workbench-project" as const;
export const WORKBENCH_SCHEMA_VERSION = 1 as const;
export const WORKBENCH_APPLICATION_VERSION = "0.2.0-preview.1" as const;
export const ELECTRICAL_SHEET_BOUNDS = { minX: 72, maxX: 1_528, minY: 135, maxY: 650 } as const;
export const ELECTRICAL_SHEET_RESERVED_REGIONS = [
  { id: "concept-bom", minX: 1_130, maxX: 1_545, minY: 72, maxY: 282 },
  { id: "erc-panel", minX: 45, maxX: 695, minY: 622, maxY: 832 },
  { id: "release-title", minX: 1_130, maxX: 1_545, minY: 640, maxY: 832 }
] as const;
export const ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT = { minX: -72, maxX: 72, minY: -58, maxY: 118 } as const;

export type WorkspaceId = "sketch" | "part" | "assembly" | "surface" | "drawing" | "electrical" | "vehicle" | "automate";
export type CapabilityLevel = "qualified" | "preview" | "unavailable";
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export function electricalComponentSheetFootprint(position: Vec2, rotationDeg = 0): { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number } {
  const radians = rotationDeg * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minY],
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minY],
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxY],
    [ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.minX, ELECTRICAL_COMPONENT_LOCAL_FOOTPRINT.maxY]
  ] as const;
  const rotated = corners.map(([x, y]) => [position[0] + x * cosine - y * sine, position[1] + x * sine + y * cosine] as const);
  return {
    minX: Math.min(...rotated.map((point) => point[0])),
    maxX: Math.max(...rotated.map((point) => point[0])),
    minY: Math.min(...rotated.map((point) => point[1])),
    maxY: Math.max(...rotated.map((point) => point[1]))
  };
}

export function isElectricalSheetPositionAvailable(position: Vec2, rotationDeg = 0): boolean {
  const footprint = electricalComponentSheetFootprint(position, rotationDeg);
  return footprint.minX >= ELECTRICAL_SHEET_BOUNDS.minX && footprint.maxX <= ELECTRICAL_SHEET_BOUNDS.maxX
    && footprint.minY >= ELECTRICAL_SHEET_BOUNDS.minY && footprint.maxY <= ELECTRICAL_SHEET_BOUNDS.maxY
    && !ELECTRICAL_SHEET_RESERVED_REGIONS.some((region) => rectanglesOverlap(footprint, region));
}

export function constrainElectricalSheetPosition(position: Vec2, rotationDeg = 0): Vec2 {
  const initial = electricalComponentSheetFootprint([0, 0], rotationDeg);
  const minimumX = ELECTRICAL_SHEET_BOUNDS.minX - initial.minX;
  const maximumX = ELECTRICAL_SHEET_BOUNDS.maxX - initial.maxX;
  const minimumY = ELECTRICAL_SHEET_BOUNDS.minY - initial.minY;
  const maximumY = ELECTRICAL_SHEET_BOUNDS.maxY - initial.maxY;
  let candidate: Vec2 = [Math.min(maximumX, Math.max(minimumX, position[0])), Math.min(maximumY, Math.max(minimumY, position[1]))];
  for (let pass = 0; pass < ELECTRICAL_SHEET_RESERVED_REGIONS.length * 2; pass += 1) {
    const footprint = electricalComponentSheetFootprint(candidate, rotationDeg);
    const region = ELECTRICAL_SHEET_RESERVED_REGIONS.find((item) => rectanglesOverlap(footprint, item));
    if (region === undefined) break;
    const alternatives: readonly Vec2[] = [
      [region.minX - initial.maxX - 1, candidate[1]], [region.maxX - initial.minX + 1, candidate[1]],
      [candidate[0], region.minY - initial.maxY - 1], [candidate[0], region.maxY - initial.minY + 1]
    ];
    candidate = alternatives
      .filter((item) => item[0] >= minimumX && item[0] <= maximumX && item[1] >= minimumY && item[1] <= maximumY)
      .sort((left, right) => Math.hypot(left[0] - position[0], left[1] - position[1]) - Math.hypot(right[0] - position[0], right[1] - position[1]))[0] ?? candidate;
  }
  return candidate;
}

function rectanglesOverlap(left: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }, right: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }): boolean {
  return left.maxX >= right.minX && left.minX <= right.maxX && left.maxY >= right.minY && left.minY <= right.maxY;
}

export interface WorkbenchDiagnostic {
  readonly code:
    | "INVALID_PROJECT"
    | "INVALID_OPERATION"
    | "REVISION_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "OUTSIDE_SUPPORTED_ENVELOPE"
    | "RESOURCE_LIMIT"
    | "BROKEN_REFERENCE"
    | "CONSTRAINT_CONFLICT"
    | "DEGENERATE_GEOMETRY"
    | "UNSUPPORTED_CAPABILITY"
    | "PREVIEW_RECEIPT_MISMATCH"
    | "CONFIRMATION_REQUIRED";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export type WorkbenchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostics: readonly WorkbenchDiagnostic[] };

export type SketchEntity =
  | {
      readonly id: string;
      readonly kind: "line";
      readonly start: Vec2;
      readonly end: Vec2;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "rectangle";
      readonly center: Vec2;
      readonly widthMm: number;
      readonly heightMm: number;
      readonly rotationDeg: number;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "circle";
      readonly center: Vec2;
      readonly radiusMm: number;
      readonly construction: boolean;
      readonly visible?: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "arc";
      readonly start: Vec2;
      readonly mid: Vec2;
      readonly end: Vec2;
      readonly construction: boolean;
      readonly visible?: boolean;
    };

export type SketchConstraintKind =
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "collinear"
  | "midpoint"
  | "symmetry"
  | "coincident"
  | "concentric"
  | "equal"
  | "radius"
  | "distance"
  | "fixed";

export interface WorkbenchSketchConstraint {
  readonly id: string;
  readonly kind: SketchConstraintKind;
  readonly entityIds: readonly string[];
  readonly valueMm?: number;
  readonly dimension?: "length" | "width" | "height" | "radius";
}

export interface WorkbenchSketch {
  readonly id: "sketch:primary-profile";
  readonly name: string;
  readonly plane: "datum:xy";
  readonly gridMm: number;
  readonly snapToleranceMm: number;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly WorkbenchSketchConstraint[];
}

export interface PartIntent {
  readonly id: "part:mounting-plate";
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly thicknessMm: number;
  readonly holeDiameterMm: number;
  readonly edgeTreatmentMm: number;
  readonly patternCount: number;
  readonly revolveAngleDeg: number;
  /**
   * Monotonic user-requested rebuild counter for the bounded analytic feature
   * layer. Geometry is generated deterministically from the records below;
   * incrementing this value provides an explicit, auditable Update Model step.
   */
  readonly modelUpdateSerial?: number;
  /**
   * Independent editable preview bodies. These deliberately remain separate
   * from the qualified centered-bore body until an exact persistent-topology
   * kernel can evaluate their Boolean and face-level relationships.
   * Optional for backward compatibility with earlier workbench/1 documents.
   */
  readonly previewBodies?: readonly PartPreviewBody[];
}

export type PartPreviewBodyShape = "block" | "cylinder" | "cone" | "sphere";

export type PartAnalyticBodyShape = PartPreviewBodyShape | "revolved";
export type PartBodyFaceId = "x-negative" | "x-positive" | "y-negative" | "y-positive" | "z-negative" | "z-positive";
export type PartBodyEdgeTreatment = "blend" | "chamfer";
export type PartBodyFeatureKind =
  | "primitive"
  | "revolve"
  | "pattern"
  | "mirror"
  | "unite"
  | "subtract"
  | "trim"
  | "face-edit"
  | "edge-treatment"
  | "draft"
  | "shell"
  | "heal";

export interface PartBodyFeatureTrace {
  readonly kind: PartBodyFeatureKind;
  readonly operationId: string;
  readonly parentIds: readonly string[];
}

export interface PartPreviewBody {
  readonly id: string;
  readonly name: string;
  readonly shape: PartAnalyticBodyShape;
  readonly visible: boolean;
  readonly color: string;
  readonly translationMm: Vec3;
  readonly rotationDeg: Vec3;
  /**
   * Shape parameters encoded as a bounded XYZ tuple:
   * block = width/depth/height; cylinder = diameter/diameter/height;
   * cone = base diameter/top diameter/height; sphere = diameter/diameter/diameter.
   */
  readonly sizeMm: Vec3;
  /** Optional closed analytic through-bore for supported block/cylinder bodies. */
  readonly boreDiameterMm?: number;
  /** Optional supported vertical-edge treatment for analytic blocks. */
  readonly edgeTreatment?: { readonly kind: PartBodyEdgeTreatment; readonly sizeMm: number };
  /** Optional open-top wall thickness for supported block/cylinder bodies. */
  readonly shellThicknessMm?: number;
  /** Supported positive taper from the smaller lower face to the nominal upper face. */
  readonly draftAngleDeg?: number;
  /** Sweep angle for a revolved annular rectangular profile. */
  readonly revolveAngleDeg?: number;
  /** Stable trace used by feature history, Update Model, and MCP inspection. */
  readonly featureTrace?: PartBodyFeatureTrace;
}

export type MasterCartTemplateId =
  | "socket-head-cap-screw"
  | "hex-head-bolt"
  | "flat-head-socket-screw"
  | "shoulder-screw"
  | "hex-nut"
  | "flat-washer"
  | "deep-groove-ball-bearing"
  | "sleeve-bushing"
  | "flanged-bushing"
  | "spur-gear"
  | "roller-chain-sprocket"
  | "roller-chain-link"
  | "timing-belt-pulley"
  | "timing-belt-loop"
  | "o-ring"
  | "linear-bearing"
  | "linear-shaft"
  | "acme-lead-screw"
  | "shaft-collar"
  | "hydraulic-straight-fitting"
  | "hydraulic-elbow-fitting"
  | "tube-compression-union"
  | "tube-compression-elbow"
  | "hex-key"
  | "combination-wrench";

export type ComponentShape =
  | "plate"
  | "spacer"
  | "pin"
  | "cap"
  | "box"
  | "cylinder"
  | "cone"
  | "sphere"
  | "hex-prism"
  | "ring"
  | "torus"
  | "gear";

export interface MasterCartComponentTrace {
  readonly instanceId: string;
  readonly templateId: MasterCartTemplateId;
  readonly role: string;
  readonly sizeLabel: string;
  readonly materialLabel: string;
  readonly finishLabel: string;
  readonly parameterSummary: string;
  readonly provenance: "original-ps3d-parametric-preview";
}

export interface ComponentInstance {
  readonly id: string;
  readonly name: string;
  readonly shape: ComponentShape;
  readonly grounded: boolean;
  readonly visible: boolean;
  readonly color: string;
  readonly translationMm: Vec3;
  readonly rotationDeg: Vec3;
  readonly sizeMm: Vec3;
  readonly explosionDirection: Vec3;
  /** Optional radial detail used by original PS3D gear and sprocket preview meshes. */
  readonly featureCount?: number;
  /** Trace for one grouped, independently generated Master Cart preview item. */
  readonly masterCart?: MasterCartComponentTrace;
  /** Present only on deterministic schematic-to-assembly package instances. */
  readonly sourceElectricalComponentId?: string;
  readonly catalogPartId?: string;
}

export interface AssemblyMate {
  readonly id: string;
  readonly name: string;
  readonly kind: "fixed" | "coincident-origin" | "aligned-axis";
  readonly componentIds: readonly string[];
  readonly axis?: "x" | "y" | "z";
  readonly status: "satisfied" | "redundant" | "conflict";
}

export interface AssemblyIntent {
  readonly id: "assembly:fixture-demo";
  readonly name: string;
  readonly explodeMm: number;
  readonly components: readonly ComponentInstance[];
  readonly mates: readonly AssemblyMate[];
  /** Optional for schema-1 compatibility. `custom` is assumed when absent. */
  readonly template?: AssemblyTemplateId;
  /** Nominal planning envelope only; never a certification or as-built record. */
  readonly nominalEnvelopeMm?: Vec3;
  readonly designStatus?: "editable-preview" | "arrangement-study" | "electromechanical-layout";
  readonly safetyNotes?: readonly string[];
  /** Traceability records for generated generic electromechanical packages. */
  readonly electricalLinks?: readonly ElectromechanicalDeviceLink[];
  /** Orthogonal planning guides only; these are not sized conductors or harnesses. */
  readonly electricalRoutes?: readonly ElectromechanicalRouteIntent[];
  readonly electromechanicalSource?: ElectromechanicalSourceRecord;
}

export type AssemblyTemplateId = "custom" | "cargo-20ft" | "cargo-40ft-hc" | "bess-20ft-hc" | "electrical-panel";

export type ElectricalStandard = "IEC" | "ANSI";
export type ElectricalTemplateId = "bess-single-line" | "dc-control" | "motor-starter";
export type ElectricalComponentKind =
  | "battery"
  | "fuse"
  | "disconnect"
  | "contactor"
  | "inverter"
  | "transformer"
  | "breaker"
  | "load"
  | "motor"
  | "ground"
  | "terminal"
  | "sensor"
  | "hvac";
export type ElectricalNetClass = "power-dc" | "power-ac" | "control" | "ground";

export interface ElectricalComponent {
  readonly id: string;
  readonly kind: ElectricalComponentKind;
  readonly reference: string;
  readonly label: string;
  readonly value: string;
  readonly position: Vec2;
  readonly rotationDeg: number;
  readonly terminals: readonly string[];
}

export interface ElectricalNetEndpoint {
  readonly componentId: string;
  readonly terminal: string;
}

export interface ElectricalNet {
  readonly id: string;
  readonly name: string;
  readonly class: ElectricalNetClass;
  readonly endpoints: readonly ElectricalNetEndpoint[];
}

export interface ElectricalIntent {
  readonly id: "electrical:main";
  readonly title: string;
  readonly standard: ElectricalStandard;
  readonly template: ElectricalTemplateId;
  readonly components: readonly ElectricalComponent[];
  readonly nets: readonly ElectricalNet[];
  readonly notes: string;
}

export type VehicleTemplateId = "ice-road-motorcycle" | "step-through-scooter" | "ev-street-motorcycle" | "delta-cargo-three-wheeler" | "tadpole-geometry-three-wheeler";
export type VehicleKind = "motorcycle" | "scooter" | "three-wheeler";
export type VehiclePowertrainKind = "ice" | "electric";
export type VehicleLayout = "single-track" | "delta-1f2r" | "tadpole-2f1r";
export type VehicleSimulationState = "full-droop" | "design-ride" | "full-bump";
export type VehicleLayerId = "skeleton" | "hardpoints" | "envelopes" | "wheels" | "chassis" | "suspension" | "steering" | "brakes" | "powertrain" | "cg-loads";
export type VehicleSide = "center" | "left" | "right";
export type VehicleGeometryStatus = "pass" | "review" | "fail";
export type VehicleFrontSuspensionTopology = "telescopic-fork" | "double-wishbone";
export type VehicleRearSuspensionTopology = "swingarm" | "unit-swing" | "trailing-arm-beam";
export type VehicleSteeringTopology = "steered-fork" | "rack-and-tie-rod";
export type VehicleFrameTopology = "diamond-cradle" | "step-through-underbone" | "cargo-twin-rail" | "reverse-trike-spaceframe";

export interface VehicleTopology {
  readonly frontSuspension: VehicleFrontSuspensionTopology;
  readonly rearSuspension: VehicleRearSuspensionTopology;
  readonly steering: VehicleSteeringTopology;
  readonly frame: VehicleFrameTopology;
  readonly frontWheelCount: 1 | 2;
  readonly rearWheelCount: 1 | 2;
  readonly drivenAxle: "front" | "rear";
}

export interface VehicleParameters {
  readonly wheelbaseM: number;
  readonly frontLoadedRadiusM: number;
  readonly rearLoadedRadiusM: number;
  readonly frontRollingRadiusM: number;
  readonly rearRollingRadiusM: number;
  readonly frontTireWidthM: number;
  readonly rearTireWidthM: number;
  readonly trackM: number;
  readonly rakeRad: number;
  readonly forkNormalOffsetM: number;
  readonly casterRad: number;
  readonly kingpinInclinationRad: number;
  readonly scrubRadiusM: number;
  readonly toeRad: number;
  readonly ackermannPercent: number;
  readonly steeringAngleRad: number;
  readonly rearSwingarmPivotFromRearM: number;
  readonly rearSwingarmPivotHeightM: number;
  readonly rearShockUpperFromRearM: number;
  readonly rearShockUpperHeightM: number;
  readonly rearShockArmRatio: number;
  readonly frontSuspensionInboardHalfTrackM: number;
  readonly frontLowerArmHeightM: number;
  readonly frontUpperArmHeightM: number;
  readonly frontTravelM: number;
  readonly rearTravelM: number;
  readonly frontSagM: number;
  readonly rearSagM: number;
  readonly frontSpringRateNPerM: number;
  readonly rearSpringRateNPerM: number;
  readonly frontMotionRatio: number;
  readonly rearMotionRatio: number;
  readonly curbMassKg: number;
  readonly riderMassKg: number;
  readonly payloadKg: number;
  readonly cgFromRearM: number;
  readonly cgHeightM: number;
  readonly targetDecelerationMps2: number;
  readonly lateralAccelerationMps2: number;
  readonly tireFrictionCoefficient: number;
  readonly frontBrakeInputForceN: number;
  readonly rearBrakeInputForceN: number;
  readonly frontBrakeLeverRatio: number;
  readonly rearBrakeLeverRatio: number;
  readonly frontMasterCylinderDiameterM: number;
  readonly rearMasterCylinderDiameterM: number;
  readonly frontEquivalentClampAreaM2: number;
  readonly rearEquivalentClampAreaM2: number;
  readonly frontDiscCount: number;
  readonly rearDiscCount: number;
  readonly frontDiscEffectiveRadiusM: number;
  readonly rearDiscEffectiveRadiusM: number;
  readonly frontPadFrictionCoefficient: number;
  readonly rearPadFrictionCoefficient: number;
  readonly frontBrakeEfficiency: number;
  readonly rearBrakeEfficiency: number;
  readonly frontRatedPressurePa: number;
  readonly rearRatedPressurePa: number;
  readonly speedMps: number;
  readonly reactionTimeS: number;
  readonly gradeRad: number;
  readonly driveTorqueNm: number;
  readonly finalDriveRatio: number;
  readonly drivelineEfficiency: number;
  readonly rollingResistanceCoefficient: number;
  readonly dragCoefficient: number;
  readonly frontalAreaSquareM: number;
  readonly airDensityKgPerCubicM: number;
  readonly batteryEnergyCapacityJ: number;
  readonly usableBatteryFraction: number;
  readonly energyConsumptionJPerM: number;
}

export type VehicleParameterKey = keyof VehicleParameters;

export interface VehicleHardPoint {
  readonly id: string;
  readonly label: string;
  readonly category: "axle" | "contact" | "frame" | "suspension" | "steering" | "powertrain" | "cg";
  readonly positionM: Vec3;
  readonly side: VehicleSide;
  readonly source: "authored" | "derived";
  readonly stateDependent: boolean;
  readonly symmetryMateId?: string;
}

export interface VehicleGeometryMember {
  readonly id: string;
  readonly label: string;
  readonly layer: VehicleLayerId;
  readonly fromHardpointId: string;
  readonly toHardpointId: string;
  readonly radiusM: number;
  readonly style: "solid" | "construction";
}

export interface VehicleWheelPose {
  readonly id: string;
  readonly label: string;
  readonly axle: "front" | "rear";
  readonly side: VehicleSide;
  readonly centerHardpointId: string;
  readonly radiusM: number;
  readonly widthM: number;
  readonly steerRad: number;
  readonly camberRad: number;
}

export interface VehicleGeometryCheck {
  readonly id: string;
  readonly label: string;
  readonly status: VehicleGeometryStatus;
  readonly measured: string;
  readonly requirement: string;
}

export interface VehicleGeometryModel {
  readonly schema: "ps3d-vehicle-geometry/2";
  readonly coordinateSystem: "+X forward / +Y left / +Z up; chassis-fixed from design ride";
  readonly topology: VehicleTopology;
  readonly hardpoints: readonly VehicleHardPoint[];
  readonly members: readonly VehicleGeometryMember[];
  readonly wheels: readonly VehicleWheelPose[];
  readonly designWheelbaseM: number;
  readonly stateWheelbaseM: number;
  readonly frontTrackM: number;
  readonly rearTrackM: number;
  readonly rearSwingarmLengthM: number;
  readonly rearShockLengthM: number;
  readonly frontCamberChangeRad: number | null;
  readonly idealInnerSteerRad: number | null;
  readonly idealOuterSteerRad: number | null;
  readonly modeledInnerSteerRad: number | null;
  readonly modeledOuterSteerRad: number | null;
  readonly ackermannErrorRad: number | null;
  readonly checks: readonly VehicleGeometryCheck[];
  readonly errors: readonly string[];
}

export interface VehicleIntent {
  readonly id: "vehicle:primary";
  readonly name: string;
  readonly template: VehicleTemplateId;
  readonly kind: VehicleKind;
  readonly powertrain: VehiclePowertrainKind;
  readonly layout: VehicleLayout;
  readonly state: VehicleSimulationState;
  readonly parameters: VehicleParameters;
  readonly layers: Readonly<Record<VehicleLayerId, boolean>>;
  readonly inputStatus: "illustrative-unvalidated" | "user-reviewed";
  readonly tireDataStatus: "unverified" | "supplier-reviewed";
  readonly brakeDataStatus: "unverified" | "supplier-reviewed";
  readonly notes: readonly string[];
}

export interface VehicleAnalysis {
  readonly schema: "ps3d-vehicle-analysis/2";
  readonly status: "review" | "blocked";
  readonly topology: VehicleTopology;
  readonly trailM: number | null;
  /** Null means straight-ahead steering has no finite circular turn radius. */
  readonly turningRadiusM: number | null;
  readonly stateWheelbaseM: number;
  readonly frontTrackM: number;
  readonly rearTrackM: number;
  readonly rearSwingarmLengthM: number;
  readonly rearShockLengthM: number;
  readonly frontCamberChangeRad: number | null;
  readonly idealInnerSteerRad: number | null;
  readonly idealOuterSteerRad: number | null;
  readonly modeledInnerSteerRad: number | null;
  readonly modeledOuterSteerRad: number | null;
  readonly ackermannErrorRad: number | null;
  readonly totalMassKg: number;
  readonly staticFrontLoadN: number;
  readonly staticRearLoadN: number;
  readonly brakingFrontLoadN: number;
  readonly brakingRearLoadN: number;
  readonly predictedBrakingFrontLoadN: number;
  readonly predictedBrakingRearLoadN: number;
  readonly idealFrontBrakePercent: number;
  readonly hardwareFrontBrakePercent: number;
  readonly frontLockMarginN: number;
  readonly rearLockMarginN: number;
  readonly frontWheelRateNPerM: number;
  readonly rearWheelRateNPerM: number;
  readonly frontAxleWheelRateNPerM: number;
  readonly rearAxleWheelRateNPerM: number;
  readonly frontNaturalFrequencyHz: number;
  readonly rearNaturalFrequencyHz: number;
  readonly frontHydraulicPressurePa: number;
  readonly rearHydraulicPressurePa: number;
  readonly availableFrontBrakeTorqueNm: number;
  readonly availableRearBrakeTorqueNm: number;
  readonly predictedBrakeDecelerationMps2: number;
  /** Null means utilization is undefined because the normal-force capacity is zero. */
  readonly frontCombinedTireUtilization: number | null;
  readonly rearCombinedTireUtilization: number | null;
  readonly firstBrakeLimit: "hydraulic-capacity" | "front-adhesion" | "rear-adhesion" | "wheel-lift" | "pressure-rating" | "none";
  /** Null means a moving vehicle has no finite stop under the modeled zero-deceleration state. */
  readonly brakingDistanceM: number | null;
  readonly totalStoppingDistanceM: number | null;
  readonly roadLoadN: number;
  readonly rawTractiveForceN: number;
  readonly tractiveForceN: number;
  readonly adhesionLimitedTractiveForceN: number;
  readonly wheelLiftAccelerationLimitMps2: number;
  readonly wheelSpeedRpm: number;
  readonly sourceSpeedRpm: number;
  readonly sourcePowerW: number;
  readonly firstDriveLimit: "source-input" | "adhesion" | "wheel-lift";
  readonly scenarioLongitudinalAccelerationMps2: number;
  readonly assumptionEvRangeKm: number | null;
  readonly steadyLeanAngleRad: number | null;
  readonly supportWheelLoadsN: readonly { readonly contactId: string; readonly loadN: number }[] | null;
  readonly minimumSupportLoadN: number | null;
  readonly approximateTipThresholdMps2: number | null;
  readonly hardpoints: readonly VehicleHardPoint[];
  readonly geometryChecks: readonly VehicleGeometryCheck[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
}

export const ELECTROMECHANICAL_CATALOG_REVISION = "ps3d-generic-panel/2" as const;
export type ElectromechanicalLayoutPreset = "panel-backplate" | "equipment-lineup";
export type ElectromechanicalMounting = "panel" | "din-rail" | "floor" | "field";
export type ElectricalTerminalRole = "positive" | "negative" | "line" | "load" | "ac" | "protective-earth" | "signal" | "unspecified";

export interface ElectromechanicalTerminalDefinition {
  readonly name: string;
  readonly role: ElectricalTerminalRole;
  readonly positionMm: Vec3;
  readonly direction: Vec3;
}

export interface ElectromechanicalCatalogPart {
  readonly id: string;
  readonly revision: typeof ELECTROMECHANICAL_CATALOG_REVISION;
  readonly kind: ElectricalComponentKind;
  readonly label: string;
  readonly classification: "generic-envelope";
  readonly provenance: "original-ps3d-mit";
  readonly shape: Extract<ComponentShape, "box" | "cylinder">;
  readonly sizeMm: Vec3;
  readonly color: string;
  readonly mounting: ElectromechanicalMounting;
  readonly planningClearanceMm: Vec3;
  readonly terminals: readonly ElectromechanicalTerminalDefinition[];
}

export interface ElectromechanicalMapping {
  readonly electricalComponentId: string;
  readonly catalogPartId: string;
}

export interface ElectromechanicalDeviceLink {
  readonly electricalComponentId: string;
  readonly electricalReference: string;
  readonly assemblyComponentId: string;
  readonly catalogPartId: string;
  readonly terminalMap: readonly { readonly electricalTerminal: string; readonly catalogTerminal: string }[];
  readonly status: "mapped-generic";
}

export interface ElectromechanicalRouteIntent {
  readonly id: string;
  readonly electricalNetId: string;
  readonly name: string;
  readonly class: ElectricalNetClass;
  readonly endpoints: readonly ElectricalNetEndpoint[];
  readonly pointsMm: readonly Vec3[];
  readonly status: "routed-preview";
}

export interface ElectromechanicalSourceRecord {
  readonly catalogRevision: typeof ELECTROMECHANICAL_CATALOG_REVISION;
  readonly electricalTitle: string;
  readonly electricalSignature: string;
  readonly sourceElectricalId?: ElectricalIntent["id"];
  readonly sourceProjectRevision?: number;
  readonly layoutPreset: ElectromechanicalLayoutPreset;
  readonly status: "current" | "stale";
}

export interface ElectromechanicalReadiness {
  readonly status: "ready" | "blocked";
  readonly mappedComponents: number;
  readonly totalComponents: number;
  readonly routableNets: number;
  readonly totalNets: number;
  readonly targetEnvelopeMm: Vec3;
  readonly blockingErrors: readonly string[];
  readonly warnings: readonly string[];
}

export interface SurfaceIntent {
  readonly id: "surface:primary";
  readonly name: string;
  readonly mode: "bezier" | "loft";
  readonly widthMm: number;
  readonly depthMm: number;
  readonly crownMm: number;
  readonly twistDeg: number;
  readonly uSegments: number;
  readonly vSegments: number;
}

export type DrawingViewPreset = "automatic-4-view" | "orthographic-3-view" | "front-only";
export type DrawingDisplayStyle = "visible-edges" | "visible-hidden-edges";
export type DrawingDraftingStandard = "ASME" | "ISO";
export type DrawingDatumScheme = "none" | "plate-3-2-1";

export interface DrawingSettings {
  readonly id: "drawing:main-sheet";
  readonly title: string;
  readonly sheet: "A4" | "A3";
  readonly projection: "first-angle" | "third-angle";
  readonly scale: 1 | 2 | 5;
  readonly showDimensions: boolean;
  readonly notes: string;
  /** Optional for schema-1 compatibility. Missing values use the drawing generator defaults. */
  readonly viewPreset?: DrawingViewPreset;
  /** Drawing view edge style. Projected hidden edges are never inferred from this flag elsewhere. */
  readonly displayStyle?: DrawingDisplayStyle;
  /** Generates a model-derived full section through the centered bore. */
  readonly showSectionView?: boolean;
  /** Drafting basis used for projection defaults and sheet annotation vocabulary. */
  readonly draftingStandard?: DrawingDraftingStandard;
  /** Enables explicitly configured datum labels and feature-control frames. */
  readonly showGdt?: boolean;
  /** Explicit datum reference frame template. `none` never invents datum references. */
  readonly datumScheme?: DrawingDatumScheme;
  /** Explicit GD&T values. They are intentionally independent of the general tolerance. */
  readonly gdtPositionToleranceMm?: number;
  readonly gdtFlatnessToleranceMm?: number;
  readonly gdtPerpendicularityToleranceMm?: number;
  /** User-defined general tolerance applied only where no individual tolerance is shown. */
  readonly generalToleranceLinearMm?: number;
  readonly generalToleranceAngularDeg?: number;
}

export interface OperationAuditEntry {
  readonly revision: number;
  readonly operationId: string;
  readonly kind: WorkbenchOperation["kind"];
  readonly intentKey: string;
  readonly summary: string;
  readonly changedIds: readonly string[];
}

export interface WorkbenchProject {
  readonly format: typeof WORKBENCH_FORMAT;
  readonly schemaVersion: typeof WORKBENCH_SCHEMA_VERSION;
  readonly applicationVersion: string;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly unit: "mm";
  readonly activeWorkspace: WorkspaceId;
  readonly sketch: WorkbenchSketch;
  readonly part: PartIntent;
  readonly assembly: AssemblyIntent;
  readonly surface: SurfaceIntent;
  readonly drawing: DrawingSettings;
  readonly electrical: ElectricalIntent;
  readonly vehicle: VehicleIntent;
  readonly audit: readonly OperationAuditEntry[];
}

interface OperationEnvelope {
  readonly operationId: string;
  readonly expectedRevision: number;
}

export type WorkbenchOperation = OperationEnvelope & (
  | { readonly kind: "select-workspace"; readonly workspace: WorkspaceId }
  | { readonly kind: "add-sketch-entity"; readonly entity: SketchEntity }
  | { readonly kind: "delete-sketch-entity"; readonly entityId: string }
  | { readonly kind: "add-sketch-constraint"; readonly constraint: WorkbenchSketchConstraint }
  | { readonly kind: "delete-sketch-constraint"; readonly constraintId: string }
  | { readonly kind: "set-sketch-dimension"; readonly entityId: string; readonly dimension: "length" | "width" | "height" | "radius"; readonly valueMm: number }
  | { readonly kind: "toggle-sketch-construction"; readonly entityId: string }
  | { readonly kind: "toggle-sketch-entity-visibility"; readonly entityId: string }
  | {
      readonly kind: "set-part-parameter";
      readonly parameter: "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm" | "edgeTreatmentMm" | "patternCount" | "revolveAngleDeg";
      readonly value: number;
    }
  | { readonly kind: "add-part-preview-bodies"; readonly bodies: readonly PartPreviewBody[] }
  | { readonly kind: "delete-part-preview-body"; readonly bodyId: string }
  | { readonly kind: "set-part-preview-body-transform"; readonly bodyId: string; readonly translationMm: Vec3; readonly rotationDeg: Vec3 }
  | { readonly kind: "set-part-preview-body-size"; readonly bodyId: string; readonly sizeMm: Vec3 }
  | { readonly kind: "set-part-preview-body-color"; readonly bodyId: string; readonly color: string }
  | { readonly kind: "toggle-part-preview-body-visibility"; readonly bodyId: string }
  | { readonly kind: "isolate-part-preview-body"; readonly bodyId: string }
  | { readonly kind: "set-part-preview-bodies-visibility"; readonly visible: boolean }
  | {
      readonly kind: "create-part-revolve";
      readonly bodyId: string;
      readonly name: string;
      readonly outerDiameterMm: number;
      readonly innerDiameterMm: number;
      readonly heightMm: number;
      readonly angleDeg: number;
      readonly translationMm: Vec3;
    }
  | { readonly kind: "pattern-part-feature"; readonly bodyId: string; readonly instanceIds: readonly string[]; readonly direction: "x" | "y" | "z"; readonly spacingMm: number }
  | { readonly kind: "mirror-part-feature"; readonly bodyId: string; readonly newBodyId: string; readonly plane: "xy" | "xz" | "yz" }
  | { readonly kind: "boolean-part-bodies"; readonly targetBodyId: string; readonly toolBodyId: string; readonly operation: "unite" | "subtract" }
  | { readonly kind: "trim-part-body"; readonly bodyId: string; readonly keptLengthMm: number; readonly side: "negative" | "positive" }
  | { readonly kind: "set-part-body-edge-treatment"; readonly bodyId: string; readonly treatment: PartBodyEdgeTreatment; readonly sizeMm: number }
  | { readonly kind: "set-part-body-draft"; readonly bodyId: string; readonly angleDeg: number }
  | { readonly kind: "set-part-body-shell"; readonly bodyId: string; readonly thicknessMm: number }
  | { readonly kind: "move-part-body-face"; readonly bodyId: string; readonly face: PartBodyFaceId; readonly offsetMm: number; readonly mode: "move" | "offset" }
  | { readonly kind: "replace-part-body-face"; readonly bodyId: string; readonly face: PartBodyFaceId; readonly localPositionMm: number }
  | { readonly kind: "delete-part-body-face"; readonly bodyId: string; readonly feature: "bore" | "edge-treatment" | "shell" | "draft" }
  | { readonly kind: "update-part-model" }
  | { readonly kind: "set-assembly-explode"; readonly valueMm: number }
  | { readonly kind: "apply-assembly-template"; readonly template: Exclude<AssemblyTemplateId, "custom" | "electrical-panel"> }
  | { readonly kind: "add-assembly-component"; readonly component: ComponentInstance }
  | { readonly kind: "add-assembly-components"; readonly components: readonly ComponentInstance[] }
  | { readonly kind: "delete-assembly-component"; readonly componentId: string }
  | { readonly kind: "set-component-translation"; readonly componentId: string; readonly translationMm: Vec3 }
  | { readonly kind: "toggle-component-grounded"; readonly componentId: string }
  | { readonly kind: "toggle-component-visibility"; readonly componentId: string }
  | { readonly kind: "add-assembly-mate"; readonly mate: AssemblyMate }
  | { readonly kind: "delete-assembly-mate"; readonly mateId: string }
  | { readonly kind: "set-surface-mode"; readonly mode: "bezier" | "loft" }
  | {
      readonly kind: "set-surface-parameter";
      readonly parameter: "widthMm" | "depthMm" | "crownMm" | "twistDeg" | "uSegments" | "vSegments";
      readonly value: number;
    }
  | { readonly kind: "set-drawing-sheet"; readonly sheet: "A4" | "A3" }
  | { readonly kind: "set-drawing-projection"; readonly projection: "first-angle" | "third-angle" }
  | { readonly kind: "set-drawing-scale"; readonly scale: 1 | 2 | 5 }
  | { readonly kind: "set-drawing-dimensions"; readonly show: boolean }
  | { readonly kind: "set-drawing-view-preset"; readonly preset: DrawingViewPreset }
  | { readonly kind: "set-drawing-display-style"; readonly style: DrawingDisplayStyle }
  | { readonly kind: "set-drawing-section-view"; readonly show: boolean }
  | { readonly kind: "set-drawing-drafting-standard"; readonly standard: DrawingDraftingStandard }
  | { readonly kind: "set-drawing-gdt"; readonly show: boolean }
  | { readonly kind: "set-drawing-datum-scheme"; readonly scheme: DrawingDatumScheme }
  | { readonly kind: "set-drawing-gdt-specification"; readonly positionMm: number; readonly flatnessMm: number; readonly perpendicularityMm: number }
  | { readonly kind: "set-drawing-general-tolerance"; readonly linearMm: number; readonly angularDeg: number }
  | { readonly kind: "set-drawing-notes"; readonly notes: string }
  | { readonly kind: "apply-electrical-template"; readonly template: ElectricalTemplateId }
  | { readonly kind: "set-electrical-standard"; readonly standard: ElectricalStandard }
  | { readonly kind: "set-electrical-component-position"; readonly componentId: string; readonly position: Vec2 }
  | { readonly kind: "add-electrical-component"; readonly component: ElectricalComponent }
  | { readonly kind: "delete-electrical-component"; readonly componentId: string }
  | { readonly kind: "add-electrical-net"; readonly net: ElectricalNet }
  | { readonly kind: "delete-electrical-net"; readonly netId: string }
  | { readonly kind: "set-electrical-notes"; readonly notes: string }
  | { readonly kind: "apply-vehicle-template"; readonly template: VehicleTemplateId }
  | { readonly kind: "set-vehicle-parameter"; readonly parameter: VehicleParameterKey; readonly value: number }
  | { readonly kind: "set-vehicle-simulation-state"; readonly state: VehicleSimulationState }
  | { readonly kind: "toggle-vehicle-layer"; readonly layer: VehicleLayerId }
  | {
      readonly kind: "generate-electromechanical-realization";
      readonly catalogRevision: typeof ELECTROMECHANICAL_CATALOG_REVISION;
      readonly layoutPreset: ElectromechanicalLayoutPreset;
      readonly mappings: readonly ElectromechanicalMapping[];
      readonly replaceMode: "replace-assembly";
    }
);

/**
 * Canonical runtime operation registry shared by validation, MCP discovery,
 * documentation, and verification. `satisfies` rejects unknown entries while
 * the completeness assignment below makes TypeScript fail if a new operation
 * union member is added without updating this registry.
 */
export const WORKBENCH_OPERATION_KINDS = [
  "select-workspace", "add-sketch-entity", "delete-sketch-entity", "add-sketch-constraint", "delete-sketch-constraint",
  "set-sketch-dimension", "toggle-sketch-construction", "toggle-sketch-entity-visibility", "set-part-parameter", "add-part-preview-bodies", "delete-part-preview-body",
  "set-part-preview-body-transform", "set-part-preview-body-size", "set-part-preview-body-color", "toggle-part-preview-body-visibility",
  "isolate-part-preview-body", "set-part-preview-bodies-visibility", "create-part-revolve", "pattern-part-feature", "mirror-part-feature",
  "boolean-part-bodies", "trim-part-body", "set-part-body-edge-treatment", "set-part-body-draft", "set-part-body-shell",
  "move-part-body-face", "replace-part-body-face", "delete-part-body-face", "update-part-model", "set-assembly-explode", "apply-assembly-template",
  "add-assembly-component", "add-assembly-components", "delete-assembly-component", "set-component-translation", "toggle-component-grounded",
  "toggle-component-visibility", "add-assembly-mate", "delete-assembly-mate", "set-surface-mode", "set-surface-parameter", "set-drawing-sheet", "set-drawing-projection",
  "set-drawing-scale", "set-drawing-dimensions", "set-drawing-view-preset", "set-drawing-display-style", "set-drawing-section-view",
  "set-drawing-drafting-standard", "set-drawing-gdt", "set-drawing-datum-scheme", "set-drawing-gdt-specification",
  "set-drawing-general-tolerance", "set-drawing-notes", "apply-electrical-template", "set-electrical-standard",
  "set-electrical-component-position", "add-electrical-component", "delete-electrical-component", "add-electrical-net",
  "delete-electrical-net", "set-electrical-notes", "apply-vehicle-template", "set-vehicle-parameter",
  "set-vehicle-simulation-state", "toggle-vehicle-layer", "generate-electromechanical-realization"
] as const satisfies readonly WorkbenchOperation["kind"][];

const WORKBENCH_OPERATION_KIND_COMPLETENESS: Record<
  Exclude<WorkbenchOperation["kind"], (typeof WORKBENCH_OPERATION_KINDS)[number]>,
  never
> = {};
void WORKBENCH_OPERATION_KIND_COMPLETENESS;

export interface AppliedWorkbenchOperation {
  readonly project: WorkbenchProject;
  readonly changedIds: readonly string[];
  readonly summary: string;
  readonly exactRetry: boolean;
}

export interface CapabilityRecord {
  readonly id: string;
  readonly workspace: WorkspaceId;
  readonly name: string;
  readonly level: CapabilityLevel;
  readonly summary: string;
}
