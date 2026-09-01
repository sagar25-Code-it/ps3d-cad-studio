import {
  WORKBENCH_FORMAT,
  WORKBENCH_SCHEMA_VERSION,
  ELECTROMECHANICAL_CATALOG_REVISION,
  isElectricalSheetPositionAvailable,
  type AssemblyIntent,
  type AssemblyMate,
  type ComponentInstance,
  type DrawingSettings,
  type ElectricalComponent,
  type ElectricalIntent,
  type ElectricalNet,
  type OperationAuditEntry,
  type PartIntent,
  type PartPreviewBody,
  type SketchEntity,
  type SurfaceIntent,
  type VehicleIntent,
  type VehicleLayerId,
  type VehicleParameterKey,
  type WorkbenchDiagnostic,
  type WorkbenchProject,
  type WorkbenchResult,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint,
  type WorkspaceId
} from "./types.js";
import { createElectricalTemplate } from "./templates.js";
import {
  ELECTROMECHANICAL_CATALOG,
  createElectromechanicalAssembly,
  electricalSignature,
  electromechanicalTerminalWorldPoint
} from "./electromechanical.js";
import { createVehicleTemplate, solveVehicleGeometry, VEHICLE_PARAMETER_RANGES } from "./vehicle.js";
import { MASTER_CART_TEMPLATE_IDS } from "./master-cart.js";
import { validatePartFeatureStack } from "./part-features.js";

export const WORKBENCH_LIMITS = {
  maxJsonBytes: 1_000_000,
  maxEntities: 500,
  maxConstraints: 1_000,
  maxComponents: 100,
  maxMates: 200,
  maxElectricalNets: 200,
  maxAuditEntries: 500,
  maxCoordinateMm: 10_000,
  minGeometryMm: 0.01,
  maxSurfaceSegments: 48
} as const;

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const WORKSPACES: readonly WorkspaceId[] = ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];

export function validateWorkbenchProject(input: unknown): WorkbenchResult<WorkbenchProject> {
  const requiredRoot = [
    "format", "schemaVersion", "applicationVersion", "id", "name", "revision", "unit", "activeWorkspace",
    "sketch", "part", "assembly", "surface", "drawing", "audit"
  ];
  if (!isRecord(input) || !requiredRoot.every((key) => Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !requiredRoot.includes(key) && key !== "electrical" && key !== "vehicle")) {
    return invalid("The project root has missing or unsupported fields.");
  }
  if (input.format !== WORKBENCH_FORMAT || input.schemaVersion !== WORKBENCH_SCHEMA_VERSION) {
    return invalid("Only ps3d-workbench-project schema version 1 is supported.");
  }
  if (typeof input.applicationVersion !== "string" || input.applicationVersion.length > 64
    || !stableId(input.id) || !shortText(input.name, 1, 120)
    || !nonNegativeInteger(input.revision) || input.unit !== "mm" || !WORKSPACES.includes(input.activeWorkspace as WorkspaceId)) {
    return invalid("The project identity, revision, unit, or workspace is invalid.");
  }

  const sketch = validateSketch(input.sketch);
  if (!sketch.ok) return sketch;
  const part = validatePart(input.part);
  if (!part.ok) return part;
  const assembly = validateAssembly(normalizeLegacyElectromechanicalAssemblyInput(input.assembly));
  if (!assembly.ok) return assembly;
  const surface = validateSurface(input.surface);
  if (!surface.ok) return surface;
  const drawing = validateDrawing(input.drawing);
  if (!drawing.ok) return drawing;
  const electrical = validateElectrical(Object.hasOwn(input, "electrical") ? input.electrical : createElectricalTemplate("bess-single-line"));
  if (!electrical.ok) return electrical;
  const vehicle = validateVehicle(Object.hasOwn(input, "vehicle") ? input.vehicle : createVehicleTemplate("ice-road-motorcycle"));
  if (!vehicle.ok) return vehicle;
  const normalizedAssembly = normalizeLegacyElectromechanicalSource(assembly.value);
  const electromechanical = validateElectromechanicalConsistency(normalizedAssembly, electrical.value, input.revision as number);
  if (!electromechanical.ok) return electromechanical;
  const audit = validateAudit(input.audit, input.revision as number);
  if (!audit.ok) return audit;
  return { ok: true, value: { ...(structuredClone(input) as unknown as WorkbenchProject), assembly: structuredClone(normalizedAssembly), electrical: structuredClone(electrical.value), vehicle: structuredClone(vehicle.value) } };
}

function validateVehicle(value: unknown): WorkbenchResult<VehicleIntent> {
  const expected = ["id", "name", "template", "kind", "powertrain", "layout", "state", "parameters", "layers", "inputStatus", "tireDataStatus", "brakeDataStatus", "notes"];
  const templates = ["ice-road-motorcycle", "step-through-scooter", "ev-street-motorcycle", "delta-cargo-three-wheeler", "tadpole-geometry-three-wheeler"];
  if (!isRecord(value) || !exactKeys(value, expected) || value.id !== "vehicle:primary" || !shortText(value.name, 1, 120)
    || !templates.includes(String(value.template)) || !["motorcycle", "scooter", "three-wheeler"].includes(String(value.kind))
    || !["ice", "electric"].includes(String(value.powertrain)) || !["single-track", "delta-1f2r", "tadpole-2f1r"].includes(String(value.layout))
    || !["full-droop", "design-ride", "full-bump"].includes(String(value.state)) || !isRecord(value.parameters) || !isRecord(value.layers)
    || !["illustrative-unvalidated", "user-reviewed"].includes(String(value.inputStatus))
    || !["unverified", "supplier-reviewed"].includes(String(value.tireDataStatus)) || !["unverified", "supplier-reviewed"].includes(String(value.brakeDataStatus))
    || !Array.isArray(value.notes) || value.notes.length < 1 || value.notes.length > 8 || value.notes.some((note) => !shortText(note, 1, 320))) {
    return invalid("The vehicle intent is invalid or has unsupported fields.");
  }
  const parameterRecord = value.parameters as Readonly<Record<string, unknown>>;
  const layerRecord = value.layers as Readonly<Record<string, unknown>>;
  const parameterKeys = Object.keys(VEHICLE_PARAMETER_RANGES) as VehicleParameterKey[];
  const unknownParameterKeys = Object.keys(parameterRecord).filter((key) => !parameterKeys.includes(key as VehicleParameterKey));
  if (unknownParameterKeys.length > 0) return invalid("The vehicle parameter set contains unsupported fields.");
  const legacyDefaultableKeys: readonly VehicleParameterKey[] = [
    "casterRad", "kingpinInclinationRad", "scrubRadiusM", "toeRad", "ackermannPercent",
    "rearSwingarmPivotFromRearM", "rearSwingarmPivotHeightM", "rearShockUpperFromRearM",
    "rearShockUpperHeightM", "rearShockArmRatio", "frontSuspensionInboardHalfTrackM",
    "frontLowerArmHeightM", "frontUpperArmHeightM"
  ];
  const missingParameterKeys = parameterKeys.filter((key) => !Object.hasOwn(parameterRecord, key));
  if (missingParameterKeys.some((key) => !legacyDefaultableKeys.includes(key))) return invalid("The vehicle parameter set is incomplete; only documented schema-1 geometry fields may be migrated from template defaults.");
  const defaults = createVehicleTemplate(value.template as VehicleIntent["template"]).parameters;
  const parameters = { ...defaults, ...parameterRecord } as unknown as VehicleIntent["parameters"];
  for (const key of parameterKeys) {
    const range = VEHICLE_PARAMETER_RANGES[key];
    if (!finiteRange(parameters[key], range[0], range[1])) return invalid(`Vehicle parameter ${key} is outside its supported SI envelope.`);
  }
  if (!Number.isInteger(parameters.frontDiscCount) || !Number.isInteger(parameters.rearDiscCount)) return invalid("Vehicle brake disc counts must be whole numbers.");
  const templateContract: Readonly<Record<VehicleIntent["template"], readonly [VehicleIntent["kind"], VehicleIntent["powertrain"], VehicleIntent["layout"]]>> = {
    "ice-road-motorcycle": ["motorcycle", "ice", "single-track"],
    "step-through-scooter": ["scooter", "ice", "single-track"],
    "ev-street-motorcycle": ["motorcycle", "electric", "single-track"],
    "delta-cargo-three-wheeler": ["three-wheeler", "electric", "delta-1f2r"],
    "tadpole-geometry-three-wheeler": ["three-wheeler", "electric", "tadpole-2f1r"]
  };
  const contract = templateContract[value.template as VehicleIntent["template"]];
  if (value.kind !== contract[0] || value.powertrain !== contract[1] || value.layout !== contract[2]) return invalid("Vehicle template, kind, powertrain, and wheel layout are inconsistent.");
  const frontWheelCount = value.layout === "tadpole-2f1r" ? 2 : 1;
  const rearWheelCount = value.layout === "delta-1f2r" ? 2 : 1;
  if (parameters.frontDiscCount % frontWheelCount !== 0 || parameters.rearDiscCount % rearWheelCount !== 0) {
    return invalid("A paired axle requires an equal whole-disc count at every modeled wheel; no unmodeled central axle brake is permitted.");
  }
  if (parameters.frontDiscEffectiveRadiusM >= parameters.frontLoadedRadiusM
    || parameters.rearDiscEffectiveRadiusM >= parameters.rearLoadedRadiusM) {
    return invalid("Brake effective radius must remain strictly inside the corresponding loaded tire radius.");
  }
  if ((value.layout === "delta-1f2r" && parameters.trackM <= parameters.rearTireWidthM)
    || (value.layout === "tadpole-2f1r" && parameters.trackM <= parameters.frontTireWidthM)) {
    return invalid("Paired-wheel track must exceed the corresponding tire width so wheel envelopes do not overlap.");
  }
  if ((value.layout === "single-track" && parameters.trackM !== 0)
    || (value.layout !== "single-track" && parameters.trackM <= 0)
    || parameters.cgFromRearM >= parameters.wheelbaseM
    || parameters.frontSagM > parameters.frontTravelM
    || parameters.rearSagM > parameters.rearTravelM
    || parameters.frontRollingRadiusM <= parameters.frontLoadedRadiusM
    || parameters.rearRollingRadiusM <= parameters.rearLoadedRadiusM
    || (value.powertrain === "electric" && parameters.batteryEnergyCapacityJ <= 0)) return invalid("Vehicle topology, CG, tire radii, energy source, or suspension state is inconsistent.");
  if (value.layout === "tadpole-2f1r" && (parameters.frontSuspensionInboardHalfTrackM >= parameters.trackM / 2 - 0.06
    || parameters.frontUpperArmHeightM <= parameters.frontLowerArmHeightM + 0.05
    || parameters.wheelbaseM / Math.tan(parameters.steeringAngleRad) <= parameters.trackM / 2 + 0.05)) return invalid("Tadpole front-suspension or Ackermann target controls are geometrically inconsistent.");
  const layerKeys: readonly VehicleLayerId[] = ["skeleton", "hardpoints", "envelopes", "wheels", "chassis", "suspension", "steering", "brakes", "powertrain", "cg-loads"];
  if (!exactKeys(layerRecord, layerKeys) || layerKeys.some((key) => typeof layerRecord[key] !== "boolean")) return invalid("Vehicle layers are invalid or incomplete.");
  const normalized = { ...value, parameters, inputStatus: missingParameterKeys.length > 0 ? "illustrative-unvalidated" : value.inputStatus } as unknown as VehicleIntent;
  for (const state of ["full-droop", "design-ride", "full-bump"] as const) {
    const geometry = solveVehicleGeometry({ ...normalized, state });
    if (geometry.errors.length > 0) return invalid(`Vehicle ${state} kinematics are invalid: ${geometry.errors[0]}`);
  }
  return { ok: true, value: normalized };
}

export function parseWorkbenchProjectText(text: string): WorkbenchResult<WorkbenchProject> {
  if (new TextEncoder().encode(text).byteLength > WORKBENCH_LIMITS.maxJsonBytes) {
    return failure("RESOURCE_LIMIT", "The project exceeds the 1 MB preview limit.", [], "Open a smaller PS3D workbench project.");
  }
  try {
    return validateWorkbenchProject(JSON.parse(text) as unknown);
  } catch {
    return invalid("The project is not valid JSON.");
  }
}

export function failure(
  code: WorkbenchDiagnostic["code"],
  message: string,
  relatedIds: readonly string[],
  recovery: string
): WorkbenchResult<never> {
  return { ok: false, diagnostics: [{ code, message, relatedIds, recovery }] };
}

function validateSketch(value: unknown): WorkbenchResult<WorkbenchSketch> {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "plane", "gridMm", "snapToleranceMm", "entities", "constraints"])
    || value.id !== "sketch:primary-profile" || value.plane !== "datum:xy" || !shortText(value.name, 1, 120)
    || !finiteRange(value.gridMm, 0.1, 100) || !finiteRange(value.snapToleranceMm, 0.01, 10)
    || !Array.isArray(value.entities) || value.entities.length > WORKBENCH_LIMITS.maxEntities
    || !Array.isArray(value.constraints) || value.constraints.length > WORKBENCH_LIMITS.maxConstraints) {
    return invalid("The primary sketch is invalid or exceeds its limits.");
  }
  const entityIds = new Set<string>();
  for (const entity of value.entities) {
    if (!validateEntity(entity) || entityIds.has(entity.id)) return invalid("A sketch entity is invalid or has a duplicate ID.");
    entityIds.add(entity.id);
  }
  const constraintIds = new Set<string>();
  for (const constraint of value.constraints) {
    if (!validateConstraint(constraint, entityIds) || constraintIds.has(constraint.id)) {
      return invalid("A sketch constraint is invalid, duplicated, or references a missing entity.");
    }
    constraintIds.add(constraint.id);
  }
  return { ok: true, value: value as unknown as WorkbenchSketch };
}

function validateEntity(value: unknown): value is SketchEntity {
  if (!isRecord(value) || !stableId(value.id) || typeof value.construction !== "boolean"
    || (Object.hasOwn(value, "visible") && typeof value.visible !== "boolean")) return false;
  const optionalVisibility = Object.hasOwn(value, "visible") ? ["visible"] : [];
  if (value.kind === "line") {
    return exactKeys(value, ["id", "kind", "start", "end", "construction", ...optionalVisibility])
      && vec2(value.start) && vec2(value.end) && distance(value.start, value.end) >= WORKBENCH_LIMITS.minGeometryMm;
  }
  if (value.kind === "rectangle") {
    return exactKeys(value, ["id", "kind", "center", "widthMm", "heightMm", "rotationDeg", "construction", ...optionalVisibility])
      && vec2(value.center) && finiteRange(value.widthMm, WORKBENCH_LIMITS.minGeometryMm, 20_000)
      && finiteRange(value.heightMm, WORKBENCH_LIMITS.minGeometryMm, 20_000) && finiteRange(value.rotationDeg, -360, 360);
  }
  if (value.kind === "circle") {
    return exactKeys(value, ["id", "kind", "center", "radiusMm", "construction", ...optionalVisibility])
      && vec2(value.center) && finiteRange(value.radiusMm, WORKBENCH_LIMITS.minGeometryMm, 10_000);
  }
  if (value.kind === "arc") {
    return exactKeys(value, ["id", "kind", "start", "mid", "end", "construction", ...optionalVisibility])
      && vec2(value.start) && vec2(value.mid) && vec2(value.end)
      && Math.abs(cross2(value.start, value.mid, value.end)) >= 1e-4;
  }
  return false;
}

function validateConstraint(value: unknown, entityIds: ReadonlySet<string>): value is WorkbenchSketchConstraint {
  if (!isRecord(value) || !stableId(value.id) || !Array.isArray(value.entityIds) || value.entityIds.length < 1 || value.entityIds.length > 2
    || value.entityIds.some((id) => typeof id !== "string" || !entityIds.has(id))) return false;
  const kinds = ["horizontal", "vertical", "parallel", "perpendicular", "tangent", "collinear", "midpoint", "symmetry", "coincident", "concentric", "equal", "radius", "distance", "fixed"];
  if (!kinds.includes(String(value.kind))) return false;
  const hasValue = Object.hasOwn(value, "valueMm");
  const hasDimension = Object.hasOwn(value, "dimension");
  const expectedKeys = ["id", "kind", "entityIds", ...(hasValue ? ["valueMm"] : []), ...(hasDimension ? ["dimension"] : [])];
  if (!exactKeys(value, expectedKeys) || (hasDimension && !hasValue)) return false;
  if (hasDimension && !["length", "width", "height", "radius"].includes(String(value.dimension))) return false;
  return !hasValue || finiteRange(value.valueMm, WORKBENCH_LIMITS.minGeometryMm, 20_000);
}

function validatePart(value: unknown): WorkbenchResult<PartIntent> {
  const required = ["id", "name", "widthMm", "heightMm", "thicknessMm", "holeDiameterMm", "edgeTreatmentMm", "patternCount", "revolveAngleDeg"];
  const optional = ["previewBodies", "modelUpdateSerial"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || value.id !== "part:mounting-plate" || !shortText(value.name, 1, 120)
    || !finiteRange(value.widthMm, 5, 500) || !finiteRange(value.heightMm, 5, 500)
    || !finiteRange(value.thicknessMm, 1, 100) || !finiteRange(value.holeDiameterMm, 1, 250)
    || !finiteRange(value.edgeTreatmentMm, 0, 25) || !integerRange(value.patternCount, 1, 24)
    || !finiteRange(value.revolveAngleDeg, 1, 360)
    || (Object.hasOwn(value, "modelUpdateSerial") && !integerRange(value.modelUpdateSerial, 0, 1_000_000))) return invalid("The part intent is outside its supported envelope.");
  if (Object.hasOwn(value, "previewBodies") && (!Array.isArray(value.previewBodies) || value.previewBodies.length > 64)) return invalid("The part preview-body collection is invalid.");
  if (Array.isArray(value.previewBodies)) {
    const ids = new Set<string>();
    for (const body of value.previewBodies) {
      if (!validatePartPreviewBody(body) || ids.has(body.id)) return invalid("A part preview body is invalid or duplicated.");
      ids.add(body.id);
    }
  }
  if ((Math.min(value.widthMm as number, value.heightMm as number) - (value.holeDiameterMm as number)) / 2 < 1) {
    return failure("DEGENERATE_GEOMETRY", "The bore leaves less than the 1 mm wall allowance.", ["part:mounting-plate"], "Reduce the bore or enlarge the plate.");
  }
  return { ok: true, value: value as unknown as PartIntent };
}

function validatePartPreviewBody(value: unknown): value is PartPreviewBody {
  const required = ["id", "name", "shape", "visible", "color", "translationMm", "rotationDeg", "sizeMm"];
  const optional = ["boreDiameterMm", "edgeTreatment", "shellThicknessMm", "draftAngleDeg", "revolveAngleDeg", "featureTrace"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120)
    || !["block", "cylinder", "cone", "sphere", "revolved"].includes(String(value.shape))
    || typeof value.visible !== "boolean" || typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)
    || !vec3(value.translationMm) || !vec3(value.rotationDeg, 360)
    || !Array.isArray(value.sizeMm) || value.sizeMm.length !== 3
    || !finiteRange(value.sizeMm[0], WORKBENCH_LIMITS.minGeometryMm, 10_000)
    || !finiteRange(value.sizeMm[1], 0, 10_000)
    || !finiteRange(value.sizeMm[2], WORKBENCH_LIMITS.minGeometryMm, 10_000)) return false;
  const [x, y, z] = value.sizeMm;
  if ((value.shape === "cylinder" || value.shape === "sphere") && Math.abs(x - y) > 1e-9) return false;
  if (value.shape === "sphere" && Math.abs(x - z) > 1e-9) return false;
  if (value.shape === "revolved" && (!finiteRange(value.revolveAngleDeg, 0.001, 360) || y <= 0 || y >= x)) return false;
  if (value.shape !== "revolved" && Object.hasOwn(value, "revolveAngleDeg")) return false;
  if (Object.hasOwn(value, "boreDiameterMm") && !finiteRange(value.boreDiameterMm, WORKBENCH_LIMITS.minGeometryMm, 9_999)) return false;
  if (Object.hasOwn(value, "shellThicknessMm") && !finiteRange(value.shellThicknessMm, WORKBENCH_LIMITS.minGeometryMm, 5_000)) return false;
  if (Object.hasOwn(value, "draftAngleDeg") && !finiteRange(value.draftAngleDeg, 0.001, 20)) return false;
  if (Object.hasOwn(value, "edgeTreatment") && (!isRecord(value.edgeTreatment) || !exactKeys(value.edgeTreatment, ["kind", "sizeMm"])
    || !["blend", "chamfer"].includes(String(value.edgeTreatment.kind)) || !finiteRange(value.edgeTreatment.sizeMm, WORKBENCH_LIMITS.minGeometryMm, 5_000))) return false;
  if (Object.hasOwn(value, "featureTrace") && (!isRecord(value.featureTrace) || !exactKeys(value.featureTrace, ["kind", "operationId", "parentIds"])
    || !["primitive", "revolve", "pattern", "mirror", "unite", "subtract", "trim", "face-edit", "edge-treatment", "draft", "shell", "heal"].includes(String(value.featureTrace.kind))
    || !stableId(value.featureTrace.operationId) || !Array.isArray(value.featureTrace.parentIds) || value.featureTrace.parentIds.length < 1 || value.featureTrace.parentIds.length > 8
    || value.featureTrace.parentIds.some((id) => !stableId(id)))) return false;
  return validatePartFeatureStack(value as unknown as PartPreviewBody).ok;
}

function validateAssembly(value: unknown): WorkbenchResult<WorkbenchProject["assembly"]> {
  const required = ["id", "name", "explodeMm", "components", "mates"];
  const optional = ["template", "nominalEnvelopeMm", "designStatus", "safetyNotes", "electricalLinks", "electricalRoutes", "electromechanicalSource"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || value.id !== "assembly:fixture-demo" || !shortText(value.name, 1, 120) || !finiteRange(value.explodeMm, 0, WORKBENCH_LIMITS.maxCoordinateMm)
    || !Array.isArray(value.components) || value.components.length < 1 || value.components.length > WORKBENCH_LIMITS.maxComponents
    || !Array.isArray(value.mates) || value.mates.length > WORKBENCH_LIMITS.maxMates
    || (Object.hasOwn(value, "template") && !["custom", "cargo-20ft", "cargo-40ft-hc", "bess-20ft-hc", "electrical-panel"].includes(String(value.template)))
    || (Object.hasOwn(value, "nominalEnvelopeMm") && !vec3(value.nominalEnvelopeMm, 20_000, true))
    || (Object.hasOwn(value, "designStatus") && !["editable-preview", "arrangement-study", "electromechanical-layout"].includes(String(value.designStatus)))
    || (Object.hasOwn(value, "safetyNotes") && (!Array.isArray(value.safetyNotes) || value.safetyNotes.length > 8 || value.safetyNotes.some((note) => !shortText(note, 1, 300))))) {
    return invalid("The assembly is invalid or exceeds its limits.");
  }
  const componentIds = new Set<string>();
  for (const component of value.components) {
    if (!validateComponent(component) || componentIds.has(component.id)) return invalid("An assembly component is invalid or duplicated.");
    componentIds.add(component.id);
  }
  const mateIds = new Set<string>();
  for (const mate of value.mates) {
    if (!validateMate(mate, componentIds) || mateIds.has(mate.id)) return invalid("An assembly mate is invalid, duplicated, or references a missing component.");
    mateIds.add(mate.id);
  }
  if (Object.hasOwn(value, "electricalLinks")) {
    if (!Array.isArray(value.electricalLinks) || value.electricalLinks.length > WORKBENCH_LIMITS.maxComponents) return invalid("The electromechanical device trace is invalid.");
    const linkedElectrical = new Set<string>();
    const linkedAssembly = new Set<string>();
    for (const link of value.electricalLinks) {
      if (!isRecord(link) || !exactKeys(link, ["electricalComponentId", "electricalReference", "assemblyComponentId", "catalogPartId", "terminalMap", "status"])
        || !stableId(link.electricalComponentId) || !shortText(link.electricalReference, 1, 24)
        || !stableId(link.assemblyComponentId) || !componentIds.has(link.assemblyComponentId) || !stableId(link.catalogPartId)
        || link.status !== "mapped-generic" || linkedElectrical.has(link.electricalComponentId) || linkedAssembly.has(link.assemblyComponentId)
        || !Array.isArray(link.terminalMap) || link.terminalMap.length < 1 || link.terminalMap.length > 8
        || link.terminalMap.some((mapping) => !isRecord(mapping) || !exactKeys(mapping, ["electricalTerminal", "catalogTerminal"])
          || !shortText(mapping.electricalTerminal, 1, 24) || !shortText(mapping.catalogTerminal, 1, 24))) return invalid("An electromechanical device link is invalid or duplicated.");
      linkedElectrical.add(link.electricalComponentId);
      linkedAssembly.add(link.assemblyComponentId);
    }
  }
  if (Object.hasOwn(value, "electricalRoutes")) {
    if (!Array.isArray(value.electricalRoutes) || value.electricalRoutes.length > WORKBENCH_LIMITS.maxElectricalNets) return invalid("The electromechanical route trace is invalid.");
    const routeIds = new Set<string>();
    for (const route of value.electricalRoutes) {
      if (!isRecord(route) || !exactKeys(route, ["id", "electricalNetId", "name", "class", "endpoints", "pointsMm", "status"])
        || !stableId(route.id) || routeIds.has(route.id) || !stableId(route.electricalNetId) || !shortText(route.name, 1, 80)
        || !["power-dc", "power-ac", "control", "ground"].includes(String(route.class)) || route.status !== "routed-preview"
        || !Array.isArray(route.endpoints) || route.endpoints.length < 2 || route.endpoints.length > 16
        || route.endpoints.some((endpoint) => !isRecord(endpoint) || !exactKeys(endpoint, ["componentId", "terminal"]) || !stableId(endpoint.componentId) || !shortText(endpoint.terminal, 1, 24))
        || !Array.isArray(route.pointsMm) || route.pointsMm.length < 2 || route.pointsMm.length > 128 || route.pointsMm.some((point) => !vec3(point))) return invalid("An electromechanical route is invalid or duplicated.");
      routeIds.add(route.id);
    }
  }
  if (Object.hasOwn(value, "electromechanicalSource")) {
    const source = value.electromechanicalSource;
    const required = ["catalogRevision", "electricalTitle", "electricalSignature", "layoutPreset", "status"];
    const optional = ["sourceElectricalId", "sourceProjectRevision"];
    if (!isRecord(source) || !required.every((key) => Object.hasOwn(source, key)) || Object.keys(source).some((key) => !required.includes(key) && !optional.includes(key))
      || source.catalogRevision !== ELECTROMECHANICAL_CATALOG_REVISION || !shortText(source.electricalTitle, 1, 120)
      || !shortText(source.electricalSignature, 1, 64) || !["panel-backplate", "equipment-lineup"].includes(String(source.layoutPreset)) || !["current", "stale"].includes(String(source.status))
      || (Object.hasOwn(source, "sourceElectricalId") && source.sourceElectricalId !== "electrical:main")
      || (Object.hasOwn(source, "sourceProjectRevision") && !nonNegativeInteger(source.sourceProjectRevision))) return invalid("The electromechanical source record is invalid.");
  }
  return { ok: true, value: value as unknown as WorkbenchProject["assembly"] };
}

function validateComponent(value: unknown): value is ComponentInstance {
  const required = ["id", "name", "shape", "grounded", "visible", "color", "translationMm", "rotationDeg", "sizeMm", "explosionDirection"];
  const optional = ["featureCount", "masterCart", "sourceElectricalComponentId", "catalogPartId"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key)) || !Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120) || !["plate", "spacer", "pin", "cap", "box", "cylinder", "cone", "sphere", "hex-prism", "ring", "torus", "gear"].includes(String(value.shape))
    || typeof value.grounded !== "boolean" || typeof value.visible !== "boolean" || typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)
    || !vec3(value.translationMm) || !vec3(value.rotationDeg, 360) || !vec3(value.sizeMm, 20_000, true) || !vec3(value.explosionDirection, 1)
    || (Object.hasOwn(value, "sourceElectricalComponentId") && !stableId(value.sourceElectricalComponentId))
    || (Object.hasOwn(value, "catalogPartId") && !stableId(value.catalogPartId))) return false;
  const [first, second, third] = value.sizeMm as readonly number[];
  if (["cylinder", "sphere", "hex-prism"].includes(String(value.shape)) && Math.abs(first! - second!) > 1e-9) return false;
  if (value.shape === "sphere" && Math.abs(first! - third!) > 1e-9) return false;
  if (value.shape === "cone" && (second! > first! || first! <= 0 || second! <= 0)) return false;
  if (["ring", "gear"].includes(String(value.shape)) && (second! >= first! || second! <= 0)) return false;
  if (value.shape === "torus" && (second! >= first! || Math.abs(second! - third!) > 1e-9)) return false;
  if (Object.hasOwn(value, "featureCount") && (!Number.isSafeInteger(value.featureCount) || (value.featureCount as number) < 3 || (value.featureCount as number) > 240 || value.shape !== "gear")) return false;
  if (Object.hasOwn(value, "masterCart") && !validateMasterCartTrace(value.masterCart)) return false;
  return true;
}

function validateMasterCartTrace(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ["instanceId", "templateId", "role", "sizeLabel", "materialLabel", "finishLabel", "parameterSummary", "provenance"])
    && stableId(value.instanceId)
    && MASTER_CART_TEMPLATE_IDS.includes(value.templateId as never)
    && shortText(value.role, 1, 80)
    && shortText(value.sizeLabel, 1, 100)
    && shortText(value.materialLabel, 1, 100)
    && shortText(value.finishLabel, 1, 100)
    && shortText(value.parameterSummary, 1, 240)
    && value.provenance === "original-ps3d-parametric-preview";
}

function validateMate(value: unknown, componentIds: ReadonlySet<string>): value is AssemblyMate {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || !Array.isArray(value.componentIds)
    || value.componentIds.length < 1 || value.componentIds.length > 2 || value.componentIds.some((id) => typeof id !== "string" || !componentIds.has(id))
    || !["fixed", "coincident-origin", "aligned-axis"].includes(String(value.kind))
    || !["satisfied", "redundant", "conflict"].includes(String(value.status))) return false;
  const hasAxis = Object.hasOwn(value, "axis");
  return exactKeys(value, hasAxis ? ["id", "name", "kind", "componentIds", "axis", "status"] : ["id", "name", "kind", "componentIds", "status"])
    && (!hasAxis || ["x", "y", "z"].includes(String(value.axis)));
}

function validateSurface(value: unknown): WorkbenchResult<SurfaceIntent> {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "mode", "widthMm", "depthMm", "crownMm", "twistDeg", "uSegments", "vSegments"])
    || value.id !== "surface:primary" || !shortText(value.name, 1, 120) || !["bezier", "loft"].includes(String(value.mode))
    || !finiteRange(value.widthMm, 1, 2_000) || !finiteRange(value.depthMm, 1, 2_000)
    || !finiteRange(value.crownMm, -500, 500) || !finiteRange(value.twistDeg, -90, 90)
    || !integerRange(value.uSegments, 4, WORKBENCH_LIMITS.maxSurfaceSegments)
    || !integerRange(value.vSegments, 4, WORKBENCH_LIMITS.maxSurfaceSegments)) return invalid("The surface intent is outside its supported envelope.");
  return { ok: true, value: value as unknown as SurfaceIntent };
}

function validateDrawing(value: unknown): WorkbenchResult<DrawingSettings> {
  const required = ["id", "title", "sheet", "projection", "scale", "showDimensions", "notes"];
  const optional = ["viewPreset", "displayStyle", "showSectionView", "draftingStandard", "showGdt", "datumScheme", "gdtPositionToleranceMm", "gdtFlatnessToleranceMm", "gdtPerpendicularityToleranceMm", "generalToleranceLinearMm", "generalToleranceAngularDeg"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || value.id !== "drawing:main-sheet" || !shortText(value.title, 1, 80) || !["A4", "A3"].includes(String(value.sheet))
    || !["first-angle", "third-angle"].includes(String(value.projection)) || ![1, 2, 5].includes(value.scale as number)
    || typeof value.showDimensions !== "boolean" || !shortText(value.notes, 0, 240)
    || (Object.hasOwn(value, "viewPreset") && !["automatic-4-view", "orthographic-3-view", "front-only"].includes(String(value.viewPreset)))
    || (Object.hasOwn(value, "displayStyle") && !["visible-edges", "visible-hidden-edges"].includes(String(value.displayStyle)))
    || (Object.hasOwn(value, "showSectionView") && typeof value.showSectionView !== "boolean")
    || (Object.hasOwn(value, "draftingStandard") && !["ASME", "ISO"].includes(String(value.draftingStandard)))
    || (Object.hasOwn(value, "showGdt") && typeof value.showGdt !== "boolean")
    || (Object.hasOwn(value, "datumScheme") && !["none", "plate-3-2-1"].includes(String(value.datumScheme)))
    || (Object.hasOwn(value, "gdtPositionToleranceMm") && !finiteRange(value.gdtPositionToleranceMm, 0.001, 10))
    || (Object.hasOwn(value, "gdtFlatnessToleranceMm") && !finiteRange(value.gdtFlatnessToleranceMm, 0.001, 10))
    || (Object.hasOwn(value, "gdtPerpendicularityToleranceMm") && !finiteRange(value.gdtPerpendicularityToleranceMm, 0.001, 10))
    || (Object.hasOwn(value, "generalToleranceLinearMm") && !finiteRange(value.generalToleranceLinearMm, 0.001, 10))
    || (Object.hasOwn(value, "generalToleranceAngularDeg") && !finiteRange(value.generalToleranceAngularDeg, 0.01, 10))) return invalid("The drawing settings are invalid.");
  return { ok: true, value: value as unknown as DrawingSettings };
}

function validateElectrical(value: unknown): WorkbenchResult<ElectricalIntent> {
  if (!isRecord(value) || !exactKeys(value, ["id", "title", "standard", "template", "components", "nets", "notes"])
    || value.id !== "electrical:main" || !shortText(value.title, 1, 120)
    || !["IEC", "ANSI"].includes(String(value.standard))
    || !["bess-single-line", "dc-control", "motor-starter"].includes(String(value.template))
    || !Array.isArray(value.components) || value.components.length < 1 || value.components.length > WORKBENCH_LIMITS.maxComponents
    || !Array.isArray(value.nets) || value.nets.length > WORKBENCH_LIMITS.maxElectricalNets
    || !shortText(value.notes, 0, 800)) return invalid("The electrical schematic intent is invalid or exceeds its limits.");
  const componentIds = new Set<string>();
  const terminals = new Map<string, ReadonlySet<string>>();
  for (const component of value.components) {
    if (!validateElectricalComponent(component) || componentIds.has(component.id)) return invalid("An electrical component is invalid or duplicated.");
    componentIds.add(component.id);
    terminals.set(component.id, new Set(component.terminals));
  }
  const netIds = new Set<string>();
  for (const net of value.nets) {
    if (!validateElectricalNet(net, terminals) || netIds.has(net.id)) return invalid("An electrical net is invalid, duplicated, or references a missing terminal.");
    netIds.add(net.id);
  }
  return { ok: true, value: value as unknown as ElectricalIntent };
}

function validateElectricalComponent(value: unknown): value is ElectricalComponent {
  const kinds = ["battery", "fuse", "disconnect", "contactor", "inverter", "transformer", "breaker", "load", "motor", "ground", "terminal", "sensor", "hvac"];
  if (!isRecord(value) || !exactKeys(value, ["id", "kind", "reference", "label", "value", "position", "rotationDeg", "terminals"])
    || !stableId(value.id) || !kinds.includes(String(value.kind)) || !shortText(value.reference, 1, 24)
    || !shortText(value.label, 1, 80) || !shortText(value.value, 0, 100) || !finiteRange(value.rotationDeg, -360, 360)
    || !electricalSheetPosition(value.position, value.rotationDeg) || !Array.isArray(value.terminals)
    || value.terminals.length < 1 || value.terminals.length > 8 || value.terminals.some((terminal) => !shortText(terminal, 1, 24))) return false;
  const catalog = ELECTROMECHANICAL_CATALOG.find((part) => part.kind === value.kind);
  if (catalog === undefined || new Set(value.terminals).size !== value.terminals.length) return false;
  const declared = [...value.terminals].sort().join("\u0000");
  const expected = catalog.terminals.map((terminal) => terminal.name).sort().join("\u0000");
  return declared === expected;
}

function validateElectricalNet(value: unknown, terminals: ReadonlyMap<string, ReadonlySet<string>>): value is ElectricalNet {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "class", "endpoints"])
    || !stableId(value.id) || !shortText(value.name, 1, 80)
    || !["power-dc", "power-ac", "control", "ground"].includes(String(value.class))
    || !Array.isArray(value.endpoints) || value.endpoints.length < 2 || value.endpoints.length > 16) return false;
  const endpointKeys = new Set<string>();
  const endpointComponents = new Set<string>();
  for (const endpoint of value.endpoints) {
    if (!isRecord(endpoint) || !exactKeys(endpoint, ["componentId", "terminal"])
      || !stableId(endpoint.componentId) || !shortText(endpoint.terminal, 1, 24)
      || terminals.get(endpoint.componentId)?.has(endpoint.terminal) !== true) return false;
    const key = `${endpoint.componentId}:${endpoint.terminal}`;
    if (endpointKeys.has(key)) return false;
    if (endpointComponents.has(endpoint.componentId)) return false;
    endpointKeys.add(key);
    endpointComponents.add(endpoint.componentId);
  }
  return true;
}

function validateElectromechanicalConsistency(assembly: AssemblyIntent, electrical: ElectricalIntent, projectRevision: number): WorkbenchResult<true> {
  const hasSource = assembly.electromechanicalSource !== undefined;
  const hasLinks = assembly.electricalLinks !== undefined;
  const hasRoutes = assembly.electricalRoutes !== undefined;
  const taggedComponents = assembly.components.filter((component) => component.sourceElectricalComponentId !== undefined || component.catalogPartId !== undefined);
  if (!hasSource && !hasLinks && !hasRoutes) return taggedComponents.length === 0 ? { ok: true, value: true } : invalid("Electromechanical component metadata exists without a realization source record.");
  if (!hasSource || !hasLinks || !hasRoutes) return invalid("Electromechanical source, device links, and conductor paths must be present together.");

  const source = assembly.electromechanicalSource!;
  const links = assembly.electricalLinks!;
  const routes = assembly.electricalRoutes!;
  const assemblyById = new Map(assembly.components.map((component) => [component.id, component]));
  const catalogById = new Map(ELECTROMECHANICAL_CATALOG.map((part) => [part.id, part]));
  const linkByElectrical = new Map(links.map((link) => [link.electricalComponentId, link]));
  const linkedAssemblyIds = new Set(links.map((link) => link.assemblyComponentId));

  for (const link of links) {
    const body = assemblyById.get(link.assemblyComponentId);
    const catalog = catalogById.get(link.catalogPartId);
    if (body === undefined || catalog === undefined
      || body.sourceElectricalComponentId !== link.electricalComponentId || body.catalogPartId !== link.catalogPartId) {
      return invalid("An ECAD-to-MCAD link does not match its generated assembly component or local catalog part.");
    }
    const electricalTerminals = new Set<string>();
    const catalogTerminals = new Set<string>();
    const allowedCatalogTerminals = new Set(catalog.terminals.map((terminal) => terminal.name));
    for (const terminal of link.terminalMap) {
      if (electricalTerminals.has(terminal.electricalTerminal) || catalogTerminals.has(terminal.catalogTerminal) || !allowedCatalogTerminals.has(terminal.catalogTerminal)) {
        return invalid("An ECAD-to-MCAD terminal map is duplicated or references a missing catalog terminal.");
      }
      if (terminal.electricalTerminal !== terminal.catalogTerminal) {
        return invalid("Retained ECAD-to-MCAD trace evidence contains an unreviewed terminal remapping.");
      }
      electricalTerminals.add(terminal.electricalTerminal);
      catalogTerminals.add(terminal.catalogTerminal);
    }
    if (catalogTerminals.size !== allowedCatalogTerminals.size || [...allowedCatalogTerminals].some((terminal) => !catalogTerminals.has(terminal))) {
      return invalid("Retained ECAD-to-MCAD trace evidence does not cover every catalog terminal exactly once.");
    }
  }
  if (taggedComponents.some((component) => !linkedAssemblyIds.has(component.id))) return invalid("A generated electromechanical component is not covered by the device-link table.");

  for (const route of routes) {
    for (const endpoint of route.endpoints) {
      const link = linkByElectrical.get(endpoint.componentId);
      if (link === undefined || !link.terminalMap.some((terminal) => terminal.electricalTerminal === endpoint.terminal)) {
        return invalid("An electromechanical route endpoint is not covered by the retained device and terminal trace.");
      }
    }
  }

  if (source.sourceProjectRevision !== undefined && source.sourceProjectRevision > projectRevision) {
    return invalid("An electromechanical source record cannot claim a future project revision.");
  }
  if (source.status === "stale") return { ok: true, value: true };
  if (source.sourceElectricalId !== electrical.id || source.sourceProjectRevision === undefined || source.sourceProjectRevision > projectRevision
    || source.electricalSignature !== electricalSignature(electrical) || source.electricalTitle !== electrical.title) return invalid("A current electromechanical source record does not match the current schematic identity, revision, or content.");
  if (links.length !== electrical.components.length || routes.length !== electrical.nets.length) return invalid("A current electromechanical realization must cover every schematic device and net exactly once.");
  const expected = createElectromechanicalAssembly(electrical, source.layoutPreset, links.map((link) => ({ electricalComponentId: link.electricalComponentId, catalogPartId: link.catalogPartId })));
  if (!expected.ok) return invalid("A current electromechanical realization can no longer be reproduced from its reviewed source and catalog mapping.");
  if (assembly.template !== expected.value.template || assembly.designStatus !== expected.value.designStatus
    || assembly.nominalEnvelopeMm === undefined || expected.value.nominalEnvelopeMm === undefined || !sameVec3(assembly.nominalEnvelopeMm, expected.value.nominalEnvelopeMm)
    || !sameStrings(assembly.safetyNotes ?? [], expected.value.safetyNotes ?? [])) {
    return invalid("A current electromechanical realization is missing or has altered its protected template, envelope, design status, or safety boundary.");
  }
  const expectedBodies = new Map(expected.value.components.map((component) => [component.id, component]));
  const expectedRoutes = new Map(expected.value.electricalRoutes!.map((route) => [route.electricalNetId, route]));
  if (assembly.name !== expected.value.name || assembly.components.length !== expected.value.components.length
    || assembly.mates.length !== expected.value.mates.length || links.length !== expected.value.electricalLinks!.length
    || routes.length !== expected.value.electricalRoutes!.length) {
    return invalid("A current electromechanical realization has added, removed, or renamed deterministic generated content.");
  }
  for (const expectedComponent of expected.value.components) {
    const actual = assemblyById.get(expectedComponent.id);
    if (actual === undefined || !sameGeneratedComponent(actual, expectedComponent)) {
      return invalid("A current electromechanical realization has altered a protected package or mounting-infrastructure component.");
    }
  }
  const matesById = new Map(assembly.mates.map((mate) => [mate.id, mate]));
  for (const expectedMate of expected.value.mates) {
    const mate = matesById.get(expectedMate.id);
    if (mate === undefined || mate.name !== expectedMate.name || mate.kind !== expectedMate.kind || mate.status !== expectedMate.status
      || !sameStrings(mate.componentIds, expectedMate.componentIds) || mate.axis !== expectedMate.axis) {
      return invalid("A current electromechanical realization is missing or has altered a deterministic fixed mate.");
    }
  }
  const expectedLinks = new Map(expected.value.electricalLinks!.map((link) => [link.electricalComponentId, link]));
  for (const link of links) {
    const expectedLink = expectedLinks.get(link.electricalComponentId);
    if (expectedLink === undefined || link.electricalReference !== expectedLink.electricalReference
      || link.assemblyComponentId !== expectedLink.assemblyComponentId || link.catalogPartId !== expectedLink.catalogPartId
      || link.status !== expectedLink.status || link.terminalMap.length !== expectedLink.terminalMap.length
      || link.terminalMap.some((terminal, index) => terminal.electricalTerminal !== expectedLink.terminalMap[index]!.electricalTerminal
        || terminal.catalogTerminal !== expectedLink.terminalMap[index]!.catalogTerminal)) {
      return invalid("A current electromechanical device trace differs from its deterministic reviewed mapping.");
    }
  }
  const support = assemblyById.get("component:em-support");
  const expectedSupport = expectedBodies.get("component:em-support");
  if (support === undefined || expectedSupport === undefined || support.shape !== expectedSupport.shape
    || !sameVec3(support.translationMm, expectedSupport.translationMm) || !sameVec3(support.sizeMm, expectedSupport.sizeMm)
    || !sameVec3(support.rotationDeg, expectedSupport.rotationDeg)) return invalid("The current electromechanical support no longer matches the reviewed layout preset.");

  for (const component of electrical.components) {
    const link = linkByElectrical.get(component.id);
    const catalog = link === undefined ? undefined : catalogById.get(link.catalogPartId);
    if (link === undefined || catalog === undefined || link.electricalReference !== component.reference || catalog.kind !== component.kind) return invalid("A current device link does not match its schematic component identity, reference, or kind.");
    const body = assemblyById.get(link.assemblyComponentId);
    const expectedBody = expectedBodies.get(link.assemblyComponentId);
    if (body === undefined || expectedBody === undefined || body.name !== expectedBody.name || body.shape !== catalog.shape || !sameVec3(body.sizeMm, catalog.sizeMm)
      || !sameVec3(body.translationMm, expectedBody.translationMm) || !sameVec3(body.rotationDeg, expectedBody.rotationDeg)) {
      return invalid("A current generated package body no longer matches its reviewed catalog shape, size, position, or orientation.");
    }
    if (link.terminalMap.some((terminal) => terminal.electricalTerminal !== terminal.catalogTerminal)) {
      return invalid("A current device link contains an unreviewed terminal remapping.");
    }
    const mappedElectrical = [...link.terminalMap].map((terminal) => terminal.electricalTerminal).sort();
    if (mappedElectrical.join("\u0000") !== [...component.terminals].sort().join("\u0000")) return invalid("A current device link does not map every schematic terminal exactly once.");
  }

  const routeByNet = new Map(routes.map((route) => [route.electricalNetId, route]));
  for (const net of electrical.nets) {
    const route = routeByNet.get(net.id);
    if (route === undefined || route.name !== net.name || route.class !== net.class || !sameEndpoints(route.endpoints, net.endpoints)) return invalid("A current route guide does not match its source net and endpoint sequence.");
    const expectedRoute = expectedRoutes.get(net.id);
    if (expectedRoute === undefined || route.id !== expectedRoute.id || route.status !== expectedRoute.status
      || !samePath(route.pointsMm, expectedRoute.pointsMm)) return invalid("A current conductor path no longer matches its deterministic reviewed route.");
    if (!route.pointsMm.every((point) => point[0] >= -assembly.nominalEnvelopeMm![0] / 2 - 1e-9
      && point[0] <= assembly.nominalEnvelopeMm![0] / 2 + 1e-9
      && point[1] >= -assembly.nominalEnvelopeMm![1] / 2 - 1e-9
      && point[1] <= assembly.nominalEnvelopeMm![1] / 2 + 1e-9
      && point[2] >= -1e-9 && point[2] <= assembly.nominalEnvelopeMm![2] + 1e-9)) {
      return invalid("A current conductor path leaves the protected mounting-plate envelope.");
    }
    for (let index = 1; index < route.pointsMm.length; index += 1) {
      const from = route.pointsMm[index - 1]!;
      const to = route.pointsMm[index]!;
      const changedAxes = from.reduce((count, value, axis) => count + (Math.abs(value - to[axis]!) > 1e-9 ? 1 : 0), 0);
      if (changedAxes > 1) return invalid("A current conductor path contains a non-orthogonal segment.");
    }
    const first = terminalWorldPoint(net.endpoints[0]!, linkByElectrical, assemblyById, catalogById);
    const last = terminalWorldPoint(net.endpoints.at(-1)!, linkByElectrical, assemblyById, catalogById);
    if (first === undefined || last === undefined || !sameVec3(route.pointsMm[0]!, first) || !sameVec3(route.pointsMm.at(-1)!, last)) return invalid("A current route guide endpoint is disconnected from its mapped 3D terminal.");
  }
  return { ok: true, value: true };
}

function normalizeLegacyElectromechanicalSource(assembly: AssemblyIntent): AssemblyIntent {
  const source = assembly.electromechanicalSource;
  if (source === undefined || (source.sourceElectricalId !== undefined && source.sourceProjectRevision !== undefined)) return assembly;
  return { ...assembly, electromechanicalSource: { ...source, status: "stale" } };
}

function normalizeLegacyElectromechanicalAssemblyInput(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.electromechanicalSource)
    || value.electromechanicalSource.catalogRevision !== "ps3d-generic-em/1") return value;
  return {
    ...value,
    electromechanicalSource: {
      ...value.electromechanicalSource,
      catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION,
      status: "stale"
    }
  };
}

function terminalWorldPoint(
  endpoint: ElectricalNet["endpoints"][number],
  links: ReadonlyMap<string, NonNullable<AssemblyIntent["electricalLinks"]>[number]>,
  components: ReadonlyMap<string, ComponentInstance>,
  catalog: ReadonlyMap<string, (typeof ELECTROMECHANICAL_CATALOG)[number]>
): readonly [number, number, number] | undefined {
  const link = links.get(endpoint.componentId);
  const body = link === undefined ? undefined : components.get(link.assemblyComponentId);
  const part = link === undefined ? undefined : catalog.get(link.catalogPartId);
  const mapped = link?.terminalMap.find((terminal) => terminal.electricalTerminal === endpoint.terminal)?.catalogTerminal;
  return body === undefined || part === undefined || mapped === undefined
    ? undefined
    : electromechanicalTerminalWorldPoint(body, part, mapped);
}

function sameGeneratedComponent(left: ComponentInstance, right: ComponentInstance): boolean {
  return left.id === right.id && left.name === right.name && left.shape === right.shape
    && left.grounded === right.grounded && left.visible === right.visible && left.color === right.color
    && sameVec3(left.translationMm, right.translationMm) && sameVec3(left.rotationDeg, right.rotationDeg)
    && sameVec3(left.sizeMm, right.sizeMm) && sameVec3(left.explosionDirection, right.explosionDirection)
    && left.sourceElectricalComponentId === right.sourceElectricalComponentId
    && left.catalogPartId === right.catalogPartId;
}

function sameEndpoints(left: readonly ElectricalNet["endpoints"][number][], right: readonly ElectricalNet["endpoints"][number][]): boolean {
  return left.length === right.length && left.every((endpoint, index) => endpoint.componentId === right[index]!.componentId && endpoint.terminal === right[index]!.terminal);
}

function sameVec3(left: readonly number[], right: readonly number[]): boolean {
  return left.length === 3 && right.length === 3 && left.every((value, index) => Math.abs(value - right[index]!) <= 1e-9);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePath(left: readonly (readonly number[])[], right: readonly (readonly number[])[]): boolean {
  return left.length === right.length && left.every((point, index) => sameVec3(point, right[index]!));
}

function validateAudit(value: unknown, revision: number): WorkbenchResult<readonly OperationAuditEntry[]> {
  if (!Array.isArray(value) || value.length > WORKBENCH_LIMITS.maxAuditEntries || value.length !== revision) return invalid("The revision audit is incomplete or exceeds its limit.");
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry) || !exactKeys(entry, ["revision", "operationId", "kind", "intentKey", "summary", "changedIds"])
      || entry.revision !== index + 1 || !stableId(entry.operationId) || ids.has(entry.operationId)
      || typeof entry.kind !== "string" || !shortText(entry.intentKey, 1, 8_192) || !shortText(entry.summary, 1, 240)
      || !Array.isArray(entry.changedIds) || entry.changedIds.length > WORKBENCH_LIMITS.maxMates + 1 || entry.changedIds.some((id) => !stableId(id))) return invalid("An audit entry is invalid or out of sequence.");
    ids.add(entry.operationId);
  }
  return { ok: true, value: value as unknown as readonly OperationAuditEntry[] };
}

function invalid(message: string): WorkbenchResult<never> {
  return failure("INVALID_PROJECT", message, [], "Use a bounded PS3D workbench project created by this version.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
}

function shortText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function integerRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function vec2(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((coordinate) => finiteRange(coordinate, -WORKBENCH_LIMITS.maxCoordinateMm, WORKBENCH_LIMITS.maxCoordinateMm));
}

function electricalSheetPosition(value: unknown, rotationDeg: unknown): value is readonly [number, number] {
  return vec2(value) && typeof rotationDeg === "number" && isElectricalSheetPositionAvailable(value, rotationDeg);
}

function vec3(value: unknown, maximum: number = WORKBENCH_LIMITS.maxCoordinateMm, positive = false): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((coordinate) => finiteRange(coordinate, positive ? WORKBENCH_LIMITS.minGeometryMm : -maximum, maximum));
}

function distance(left: readonly [number, number], right: readonly [number, number]): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function cross2(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
