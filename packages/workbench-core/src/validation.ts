import { circleThroughThreePoints } from "./arc-geometry.js";
import { SPLINE_MAX_FIT_POINTS, SPLINE_MIN_FIT_POINTS } from "./spline-limits.js";
import { NEW_PRIMITIVE_SHAPES, validPrimitiveBody } from "./primitive-bodies.js";
import { validConstructionBinder, validNewPlaneDefinition } from "./construction-refs.js";
import { MAX_SPLINE_FIT_POINTS } from "./spline-limits.js";
import {
  WORKBENCH_FORMAT,
  WORKBENCH_SCHEMA_VERSION,
  ELECTROMECHANICAL_CATALOG_REVISION,
  GENERAL_BODY_OPERATIONS,
  SKETCH_DATUM_PLANES,
  SKETCH_POINT_REFS,
  SKETCH_RELATIVE_DISTANCE_NAMES,
  isSketchDatumEntityId,
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
  type GeneralSolidBody,
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
import { validSubdCageData } from "./subd-cage.js";
import { validSketchObjectFields } from "./sketch-objects.js";
import { createElectricalTemplate } from "./templates.js";
import { validateDesignHistory } from "./design.js";
import { MAX_EXPRESSION_LENGTH, parseExpression } from "./expressions.js";
import {
  ELECTROMECHANICAL_CATALOG,
  createElectromechanicalAssembly,
  electricalSignature,
  electromechanicalTerminalWorldPoint
} from "./electromechanical.js";
import { createVehicleTemplate, solveVehicleGeometry, VEHICLE_PARAMETER_RANGES } from "./vehicle.js";
import { MASTER_CART_TEMPLATE_IDS } from "./master-cart.js";
import { validatePartFeatureStack } from "./part-features.js";
import { MODEL_ENVELOPE, sketchEntityProblem } from "./envelope.js";
import { describeByteLimit, MCP_CALL_MAX_BYTES, PROJECT_FILE_MAX_BYTES } from "./envelope-limits.js";
import { sketchShapeProblem } from "./sketch-problem-messages.js";
import { validSketchPlaneFace } from "./feature-refs.js";
import { AUDIT_CHECKPOINT_KIND, AUDIT_MAX_ENTRIES } from "./audit-archive.js";

export const WORKBENCH_LIMITS = {
  /** A project file as Open and the validators accept it: the same constant Save checks (see envelope-limits.ts). */
  maxJsonBytes: PROJECT_FILE_MAX_BYTES,
  /** What one MCP tool call may carry, on the local server and on the deployed transport (see envelope-limits.ts). */
  maxMcpInputBytes: MCP_CALL_MAX_BYTES,
  maxEntities: 500,
  maxConstraints: 1_000,
  maxComponents: 100,
  maxMates: 200,
  maxElectricalNets: 200,
  /** Entries the audit holds before the oldest are folded into a checkpoint (see audit-archive.ts). */
  maxAuditEntries: AUDIT_MAX_ENTRIES,
  /** Component, assembly and electrical coordinates. Sketch geometry has its own, larger limit: see MODEL_ENVELOPE. */
  maxCoordinateMm: 10_000,
  maxSketchCoordinateMm: MODEL_ENVELOPE.maxSketchCoordinateMm,
  minGeometryMm: MODEL_ENVELOPE.minGeometryMm,
  maxSurfaceSegments: 48
} as const;

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const WORKSPACES: readonly WorkspaceId[] = ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];

/**
 * Validates a project and returns an independent deep copy of it. With `share: true` the copy is not made: the result reuses the
 * input's own objects (an operation reducer builds the next project from the previous one by structural sharing and does not need
 * a second full copy of every mesh to check it).
 */
export function validateWorkbenchProject(input: unknown, options?: { readonly share?: boolean }): WorkbenchResult<WorkbenchProject> {
  const requiredRoot = [
    "format", "schemaVersion", "applicationVersion", "id", "name", "revision", "unit", "activeWorkspace",
    "sketch", "part", "assembly", "surface", "drawing", "audit"
  ];
  if (!isRecord(input) || !requiredRoot.every((key) => Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !requiredRoot.includes(key) && key !== "electrical" && key !== "vehicle" && key !== "design")) {
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
  // The timeline is optional: projects saved before it existed simply have none.
  if (Object.hasOwn(input, "design") && !validateDesignHistory(input.design, (candidate) => validateSketch(candidate).ok)) {
    return invalid("The design timeline is invalid: a feature, a sketch snapshot, a reference or the rollback marker is wrong.");
  }
  if (options?.share === true) return { ok: true, value: { ...(input as unknown as WorkbenchProject), assembly: normalizedAssembly, electrical: electrical.value, vehicle: vehicle.value } };
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
  if (value.layout === "single-track" && parameters.trackM !== 0) return invalid("A single-track vehicle must have a track of zero.");
  if (value.layout !== "single-track" && parameters.trackM <= 0) return invalid("A multi-track vehicle must have a positive track width.");
  if (parameters.cgFromRearM >= parameters.wheelbaseM) return invalid("The centre of gravity from the rear axle must be less than the wheelbase.");
  if (parameters.frontSagM > parameters.frontTravelM) return invalid("Front suspension sag cannot exceed front suspension travel.");
  if (parameters.rearSagM > parameters.rearTravelM) return invalid("Rear suspension sag cannot exceed rear suspension travel.");
  if (parameters.frontRollingRadiusM <= parameters.frontLoadedRadiusM) return invalid("The front rolling radius must be greater than the front loaded radius.");
  if (parameters.rearRollingRadiusM <= parameters.rearLoadedRadiusM) return invalid("The rear rolling radius must be greater than the rear loaded radius.");
  if (value.powertrain === "electric" && parameters.batteryEnergyCapacityJ <= 0) return invalid("An electric powertrain requires a positive battery energy capacity.");
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
    return failure("RESOURCE_LIMIT", `The project file is larger than the ${describeByteLimit(WORKBENCH_LIMITS.maxJsonBytes)} limit.`, [], "Open a smaller PS3D workbench project, or delete bodies you no longer need and save it again.");
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

/** A tilt is a world axis and a non-zero angle up to a half turn either way. */
export function validSketchPlaneTilt(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["axis", "angleDeg"]) && ["x", "y", "z"].includes(String(value.axis))
    && typeof value.angleDeg === "number" && Number.isFinite(value.angleDeg) && value.angleDeg !== 0 && Math.abs(value.angleDeg) <= 180;
}

/** A frame is an origin within reach and two unit, perpendicular axes (the third axis follows from them). */
export function validSketchPlaneFrame(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["originMm", "uAxis", "normal"])) return false;
  const triple = (candidate: unknown, limit: number): candidate is readonly [number, number, number] => Array.isArray(candidate) && candidate.length === 3
    && candidate.every((part) => typeof part === "number" && Number.isFinite(part) && Math.abs(part) <= limit);
  if (!triple(value.originMm, 100_000) || !triple(value.uAxis, 1.000001) || !triple(value.normal, 1.000001)) return false;
  const u = value.uAxis;
  const n = value.normal;
  return Math.abs(Math.hypot(u[0], u[1], u[2]) - 1) < 1e-6 && Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-6
    && Math.abs(u[0] * n[0] + u[1] * n[1] + u[2] * n[2]) < 1e-6;
}

function validateSketch(value: unknown): WorkbenchResult<WorkbenchSketch> {
  // A sketch past its size limits says which limit and by how much, instead of the generic "invalid" message.
  if (isRecord(value)) {
    const curves = Array.isArray(value.entities) ? value.entities.length : 0;
    const relations = Array.isArray(value.constraints) ? value.constraints.length : 0;
    if (curves > WORKBENCH_LIMITS.maxEntities) return failure("RESOURCE_LIMIT", `The sketch has ${curves} curves; the limit is ${WORKBENCH_LIMITS.maxEntities}.`, [], "Delete or merge curves, or split the part into more than one sketch.");
    if (relations > WORKBENCH_LIMITS.maxConstraints) return failure("RESOURCE_LIMIT", `The sketch has ${relations} relations and dimensions; the limit is ${WORKBENCH_LIMITS.maxConstraints.toLocaleString("en-US")}. Every Horizontal, Vertical, joint and dimension counts.`, [], "Delete relations you no longer need, or split the part into more than one sketch.");
  }
  const optionalOffset = isRecord(value) && Object.hasOwn(value, "planeOffsetMm") ? ["planeOffsetMm"] : [];
  const optionalTilt = isRecord(value) && Object.hasOwn(value, "planeTilt") ? ["planeTilt"] : [];
  const optionalFrame = isRecord(value) && Object.hasOwn(value, "planeFrame") ? ["planeFrame"] : [];
  const optionalFace = isRecord(value) && Object.hasOwn(value, "planeFace") ? ["planeFace"] : [];
  const optionalObjects = isRecord(value) ? ["texts", "patterns", "underlay"].filter((key) => Object.hasOwn(value, key)) : [];
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "plane", "gridMm", "snapToleranceMm", "entities", "constraints", ...optionalOffset, ...optionalTilt, ...optionalFrame, ...optionalFace, ...optionalObjects])
    || (optionalFace.length > 0 && (!validSketchPlaneFace(value.planeFace) || optionalTilt.length > 0 || optionalFrame.length > 0))
    || (optionalTilt.length > 0 && !validSketchPlaneTilt(value.planeTilt))
    || (optionalFrame.length > 0 && (!validSketchPlaneFrame(value.planeFrame) || value.plane !== "datum:xy" || optionalOffset.length > 0 || optionalTilt.length > 0))
    || value.id !== "sketch:primary-profile" || !(SKETCH_DATUM_PLANES as readonly unknown[]).includes(value.plane) || !shortText(value.name, 1, 120)
    || (optionalOffset.length > 0 && !finiteRange(value.planeOffsetMm, -MODEL_ENVELOPE.maxPlaneOffsetMm, MODEL_ENVELOPE.maxPlaneOffsetMm))
    || !finiteRange(value.gridMm, 0.1, 100) || !finiteRange(value.snapToleranceMm, 0.01, 10)
    || !Array.isArray(value.entities) || value.entities.length > WORKBENCH_LIMITS.maxEntities
    || !Array.isArray(value.constraints) || value.constraints.length > WORKBENCH_LIMITS.maxConstraints) {
    return invalid(sketchShapeProblem(value, WORKBENCH_LIMITS));
  }
  const entityIds = new Set<string>();
  for (const entity of value.entities) {
    const problem = sketchEntityProblem(entity);
    if (problem !== undefined) return failure(problem.code === "INVALID_OPERATION" ? "INVALID_PROJECT" : problem.code, problem.message, problem.entityId === undefined ? [] : [problem.entityId], "Fix or delete that sketch entity; sizes must stay within 0.01 mm and +/-100,000 mm.");
    const id = (entity as SketchEntity).id;
    if (entityIds.has(id)) return failure("INVALID_PROJECT", `Sketch entity ${id} appears twice; every entity needs its own ID.`, [id], "Give each sketch entity a unique ID.");
    entityIds.add(id);
  }
  const constraintIds = new Set<string>();
  for (const constraint of value.constraints) {
    if (!validateConstraint(constraint, entityIds) || constraintIds.has(constraint.id)) {
      return invalid("A sketch constraint is invalid, duplicated, or references a missing entity.");
    }
    constraintIds.add(constraint.id);
  }
  if (!validSketchObjectFields(value, entityIds)) return invalid("A sketch text, pattern or underlay record is invalid or refers to a missing curve.");
  return { ok: true, value: value as unknown as WorkbenchSketch };
}

const CONSTRAINT_KINDS = ["horizontal", "vertical", "parallel", "perpendicular", "tangent", "collinear", "midpoint", "symmetry", "coincident", "concentric", "equal", "radius", "distance", "fixed", "angle", "arc-length", "perimeter", "smooth", "pierce", "refraction"];

/** Whether a value is a sketch relation the project would accept, given the ids of the entities it may refer to (the clipboard reads relations with exactly this rule). */
export function isValidSketchConstraint(value: unknown, entityIds: ReadonlySet<string>): value is WorkbenchSketchConstraint {
  return validateConstraint(value, entityIds);
}

function validateConstraint(value: unknown, entityIds: ReadonlySet<string>): value is WorkbenchSketchConstraint {
  // A reference perimeter may sum a whole chain of curves; a refraction names three lines and a symmetry three curves.
  const maxEntities = !isRecord(value) ? 0 : value.kind === "perimeter" ? 64 : value.kind === "symmetry" || value.kind === "refraction" ? 3 : 2;
  if (!isRecord(value) || !stableId(value.id) || !Array.isArray(value.entityIds) || value.entityIds.length < 1 || value.entityIds.length > maxEntities
    || value.entityIds.some((id) => typeof id !== "string" || !(entityIds.has(id) || isSketchDatumEntityId(id)))) return false;
  if (!CONSTRAINT_KINDS.includes(String(value.kind))) return false;
  const hasValue = Object.hasOwn(value, "valueMm");
  const hasDimension = Object.hasOwn(value, "dimension");
  const hasSuppressed = Object.hasOwn(value, "suppressed");
  const hasPoints = Object.hasOwn(value, "points");
  const hasValueDeg = Object.hasOwn(value, "valueDeg");
  const hasExpression = Object.hasOwn(value, "expression");
  const hasDriven = Object.hasOwn(value, "driven");
  const hasPierce = Object.hasOwn(value, "pierce");
  const hasRatio = Object.hasOwn(value, "ratio");
  const expectedKeys = ["id", "kind", "entityIds", ...(hasValue ? ["valueMm"] : []), ...(hasDimension ? ["dimension"] : []), ...(hasSuppressed ? ["suppressed"] : []), ...(hasPoints ? ["points"] : []),
    ...(hasValueDeg ? ["valueDeg"] : []), ...(hasDriven ? ["driven"] : []), ...(hasPierce ? ["pierce"] : []), ...(hasRatio ? ["ratio"] : []), ...(hasExpression ? ["expression"] : [])];
  if (!exactKeys(value, expectedKeys) || (hasSuppressed && typeof value.suppressed !== "boolean")) return false;
  // An expression only drives a dimension, and must be short, parseable text.
  if (hasExpression && (!(hasValue || hasValueDeg) || typeof value.expression !== "string" || value.expression.length < 1 || value.expression.length > MAX_EXPRESSION_LENGTH || !parseExpression(value.expression).ok)) return false;
  if (hasDriven && typeof value.driven !== "boolean") return false;
  const driven = value.driven === true;
  // A driven (reference) dimension is measured: it carries no value of its own, and only dimension kinds can be driven.
  if (driven && (hasValue || hasValueDeg || !["radius", "distance", "angle", "arc-length", "perimeter"].includes(String(value.kind)))) return false;
  if (hasDimension && (!hasValue && !driven)) return false;
  if (hasDimension && !["length", "width", "height", "radius", "diameter", "aligned", "horizontal", "vertical", "point-line", "line-line", "major-radius", "minor-radius"].includes(String(value.dimension))) return false;
  if (hasValueDeg && (value.kind !== "angle" || !(typeof value.valueDeg === "number" && Number.isFinite(value.valueDeg) && value.valueDeg >= 0 && value.valueDeg < 360))) return false;
  if (value.kind === "angle" && !driven && !hasValueDeg) return false;
  // An angle is between two lines (or a line and an axis); an ellipse alone gives the turn of its major axis.
  if (value.kind === "angle" && (value.entityIds.length < 1 || value.entityIds.length > 2 || hasValue)) return false;
  if (hasPoints) {
    // Only point-level relations name defining points, and each name must be a known point reference.
    const points = value.points;
    if ((value.kind !== "coincident" && value.kind !== "midpoint" && value.kind !== "smooth" && value.kind !== "fixed" && value.kind !== "distance") || !Array.isArray(points) || points.length < 1 || points.length > value.entityIds.length
      || points.some((point) => !(SKETCH_POINT_REFS as readonly unknown[]).includes(point))) return false;
    if (value.kind === "smooth" && (points.length !== 2 || points.some((point) => point !== "start" && point !== "end"))) return false;
  }
  if (value.kind === "smooth" && (!hasPoints || value.entityIds.length !== 2)) return false;
  if (hasPierce) {
    const pierce = value.pierce;
    if (value.kind !== "pierce" || !isRecord(pierce)) return false;
    const validReference = pierce.kind === "axis"
      ? exactKeys(pierce, ["kind", "axisId"]) && stableId(pierce.axisId)
      : pierce.kind === "body-edge" && exactKeys(pierce, ["kind", "bodyId", "chain"]) && stableId(pierce.bodyId) && integerRange(pierce.chain, 0, 100_000);
    if (!validReference) return false;
  }
  if (value.kind === "pierce" && (!hasPierce || value.entityIds.length !== 1)) return false;
  if (hasRatio && (value.kind !== "refraction" || !finiteRange(value.ratio, 0.05, 20))) return false;
  if (value.kind === "refraction" && (!hasRatio || value.entityIds.length !== 3)) return false;
  if (hasValue && value.kind === "arc-length" || hasValue && value.kind === "perimeter") return finiteRange(value.valueMm, WORKBENCH_LIMITS.minGeometryMm, MODEL_ENVELOPE.maxSketchLongMm);
  // A distance between points may be zero (two points level with each other).
  if (hasValue && value.kind === "distance" && (SKETCH_RELATIVE_DISTANCE_NAMES as readonly unknown[]).includes(value.dimension)) return finiteRange(value.valueMm, 0, MODEL_ENVELOPE.maxSketchSizeMm);
  return !hasValue || finiteRange(value.valueMm, WORKBENCH_LIMITS.minGeometryMm, MODEL_ENVELOPE.maxSketchSizeMm);
}

function validatePart(value: unknown): WorkbenchResult<PartIntent> {
  const required = ["id", "name", "widthMm", "heightMm", "thicknessMm", "holeDiameterMm", "edgeTreatmentMm", "patternCount", "revolveAngleDeg"];
  const optional = ["previewBodies", "modelUpdateSerial", "generalBodies", "construction", "constructionAxes", "constructionPoints", "constructionUcses", "constructionBinders"];
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
  if (Object.hasOwn(value, "generalBodies") && (!Array.isArray(value.generalBodies) || value.generalBodies.length > 64)) return invalid("The part general-body collection is invalid.");
  if (Array.isArray(value.generalBodies)) {
    const generalIds = new Set<string>();
    for (const body of value.generalBodies) {
      if (!validateGeneralSolidBody(body) || generalIds.has(body.id)) return invalid("A part general body is invalid or duplicated.");
      generalIds.add(body.id);
    }
  }
  if (Object.hasOwn(value, "construction") && (!Array.isArray(value.construction) || value.construction.length > 64)) return invalid("The construction-plane collection is invalid.");
  if (Array.isArray(value.construction)) {
    const planeIds = new Set<string>();
    for (const plane of value.construction) {
      if (!validateConstructionPlane(plane) || planeIds.has(plane.id)) return invalid("A construction plane is invalid or duplicated.");
      planeIds.add(plane.id);
    }
  }
  if (Object.hasOwn(value, "constructionAxes") && (!Array.isArray(value.constructionAxes) || value.constructionAxes.length > 64)) return invalid("The construction-axis collection is invalid.");
  if (Array.isArray(value.constructionAxes)) {
    const axisIds = new Set<string>();
    for (const axis of value.constructionAxes) {
      if (!validateConstructionAxis(axis) || axisIds.has(axis.id)) return invalid("A construction axis is invalid or duplicated.");
      axisIds.add(axis.id);
    }
  }
  if (Object.hasOwn(value, "constructionBinders") && (!Array.isArray(value.constructionBinders) || value.constructionBinders.length > 128)) return invalid("The construction-binder collection is invalid.");
  if (Array.isArray(value.constructionBinders)) {
    const binderIds = new Set<string>();
    for (const binder of value.constructionBinders) {
      if (!validConstructionBinder(binder) || binderIds.has(binder.id)) return invalid("A construction binder is invalid or duplicated.");
      binderIds.add(binder.id);
    }
  }
  if (Object.hasOwn(value, "constructionPoints") && (!Array.isArray(value.constructionPoints) || value.constructionPoints.length > 128)) return invalid("The construction-point collection is invalid.");
  if (Array.isArray(value.constructionPoints)) {
    const pointIds = new Set<string>();
    for (const point of value.constructionPoints) {
      if (!validateConstructionPoint(point) || pointIds.has(point.id)) return invalid("A construction point is invalid or duplicated.");
      pointIds.add(point.id);
    }
  }
  if (Object.hasOwn(value, "constructionUcses") && (!Array.isArray(value.constructionUcses) || value.constructionUcses.length > 64)) return invalid("The construction-UCS collection is invalid.");
  if (Array.isArray(value.constructionUcses)) {
    const ucsIds = new Set<string>();
    for (const ucs of value.constructionUcses) {
      if (!validateConstructionUcs(ucs) || ucsIds.has(ucs.id)) return invalid("A construction UCS is invalid or duplicated.");
      ucsIds.add(ucs.id);
    }
  }
  if ((Math.min(value.widthMm as number, value.heightMm as number) - (value.holeDiameterMm as number)) / 2 < 1) {
    return failure("DEGENERATE_GEOMETRY", "The bore leaves less than the 1 mm wall allowance.", ["part:mounting-plate"], "Reduce the bore or enlarge the plate.");
  }
  return { ok: true, value: value as unknown as PartIntent };
}

function validateGeneralSolidBody(value: unknown): value is GeneralSolidBody {
  const required = ["id", "name", "visible", "color", "positionsMm", "indices"];
  const optional = ["feature", "brep", "subd"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120)
    || typeof value.visible !== "boolean" || typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)) return false;
  const positions = value.positionsMm;
  if (!Array.isArray(positions) || positions.length < 12 || positions.length % 3 !== 0 || positions.length > 300_000
    || positions.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 1_000_000)) return false;
  const vertexCount = positions.length / 3;
  const indices = value.indices;
  if (!Array.isArray(indices) || indices.length < 3 || indices.length % 3 !== 0 || indices.length > 300_000
    || indices.some((entry) => typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= vertexCount)) return false;
  if (Object.hasOwn(value, "feature")) {
    const feature = value.feature;
    if (!isRecord(feature) || !(GENERAL_BODY_OPERATIONS as readonly string[]).includes(String(feature.operation)) || !["xy", "xz", "yz"].includes(String(feature.plane))
      || typeof feature.valueMm !== "number" || !Number.isFinite(feature.valueMm)) return false;
  }
  if (Object.hasOwn(value, "subd") && !validSubdCageData(value.subd)) return false;
  if (Object.hasOwn(value, "brep")) {
    const brep = value.brep;
    if (!isRecord(brep) || !isRecord(brep.topology) || !Array.isArray(brep.faces) || brep.faces.length > 4_096 || !Array.isArray(brep.faceTriangles)) return false;
    const topology = brep.topology;
    if (["vertices", "edges", "faces"].some((key) => typeof topology[key] !== "number" || !Number.isInteger(topology[key]) || (topology[key] as number) < 0)) return false;
    if (brep.faces.some((face) => !isRecord(face) || typeof face.role !== "string" || typeof face.key !== "string" || !shortText(face.role, 1, 120) || !shortText(face.key, 1, 200)
      || typeof face.areaMm2 !== "number" || !Number.isFinite(face.areaMm2) || face.areaMm2 < 0)) return false;
    const faceCount = brep.faces.length;
    if (brep.faceTriangles.length !== indices.length / 3) return false;
    if (brep.faceTriangles.some((face) => typeof face !== "number" || !Number.isInteger(face) || face < -1 || face >= faceCount)) return false;
  }
  return true;
}

function validateVec3Mm(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component) && Math.abs(component) <= 100_000);
}

function validateConstructionAxis(value: unknown): value is import("./types.js").ConstructionAxis {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean" || !isRecord(value.definition)) return false;
  const def = value.definition;
  if (def.kind === "two-points") {
    return validateVec3Mm(def.a) && validateVec3Mm(def.b) && (def.a[0] !== def.b[0] || def.a[1] !== def.b[1] || def.a[2] !== def.b[2])
      && Object.keys(def).every((key) => ["kind", "a", "b"].includes(key));
  }
  if (def.kind === "point-and-direction") {
    return validateVec3Mm(def.origin) && validateVec3Mm(def.direction)
      && Math.hypot(def.direction[0], def.direction[1], def.direction[2]) > 1e-6
      && Object.keys(def).every((key) => ["kind", "origin", "direction"].includes(key));
  }
  if (def.kind === "plane-intersection") {
    return SKETCH_DATUM_PLANES.includes(def.planeA as never) && SKETCH_DATUM_PLANES.includes(def.planeB as never) && def.planeA !== def.planeB
      && Object.keys(def).every((key) => ["kind", "planeA", "planeB"].includes(key));
  }
  if (def.kind === "perpendicular-to-plane") {
    return SKETCH_DATUM_PLANES.includes(def.plane as never) && validateVec3Mm(def.point)
      && Object.keys(def).every((key) => ["kind", "plane", "point"].includes(key));
  }
  if (def.kind === "cylinder-axis") {
    return stableId(def.bodyId) && Object.keys(def).every((key) => ["kind", "bodyId"].includes(key));
  }
  return false;
}

function validateConstructionPoint(value: unknown): value is import("./types.js").ConstructionPoint {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean" || !isRecord(value.definition)) return false;
  const def = value.definition;
  if (def.kind === "xyz") return validateVec3Mm(def.position) && Object.keys(def).every((key) => ["kind", "position"].includes(key));
  if (def.kind === "midpoint") return validateVec3Mm(def.a) && validateVec3Mm(def.b) && Object.keys(def).every((key) => ["kind", "a", "b"].includes(key));
  if (def.kind === "axis-plane-intersection") {
    return stableId(def.axisId) && SKETCH_DATUM_PLANES.includes(def.plane as never) && Object.keys(def).every((key) => ["kind", "axisId", "plane"].includes(key));
  }
  return false;
}

function validateConstructionPlane(value: unknown): value is import("./types.js").ConstructionPlane {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean"
    || !isRecord(value.definition)) return false;
  const def = value.definition;
  if (def.kind === "offset") {
    return SKETCH_DATUM_PLANES.includes(def.basePlane as never) && typeof def.offsetMm === "number"
      && Number.isFinite(def.offsetMm) && Math.abs(def.offsetMm) <= MODEL_ENVELOPE.maxPlaneOffsetMm
      && Object.keys(def).every((key) => ["kind", "basePlane", "offsetMm"].includes(key));
  }
  if (def.kind === "angle") {
    return SKETCH_DATUM_PLANES.includes(def.basePlane as never) && ["x", "y", "z"].includes(String(def.axis))
      && typeof def.angleDeg === "number" && Number.isFinite(def.angleDeg) && Math.abs(def.angleDeg) <= 360
      && Object.keys(def).every((key) => ["kind", "basePlane", "axis", "angleDeg"].includes(key));
  }
  if (def.kind === "three-points") {
    return Array.isArray(def.points) && def.points.length === 3
      && def.points.every((point: unknown) => Array.isArray(point) && point.length === 3 && point.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000))
      && Object.keys(def).every((key) => ["kind", "points"].includes(key));
  }
  if (def.kind === "midplane") {
    return SKETCH_DATUM_PLANES.includes(def.basePlane as never) && typeof def.fromMm === "number" && Number.isFinite(def.fromMm) && Math.abs(def.fromMm) <= MODEL_ENVELOPE.maxPlaneOffsetMm
      && typeof def.toMm === "number" && Number.isFinite(def.toMm) && Math.abs(def.toMm) <= MODEL_ENVELOPE.maxPlaneOffsetMm && def.fromMm !== def.toMm
      && Object.keys(def).every((key) => ["kind", "basePlane", "fromMm", "toMm"].includes(key));
  }
  if (def.kind === "tangent-to-cylinder") {
    return stableId(def.bodyId) && typeof def.angleDeg === "number" && Number.isFinite(def.angleDeg) && Math.abs(def.angleDeg) <= 360
      && Object.keys(def).every((key) => ["kind", "bodyId", "angleDeg"].includes(key));
  }
  if (def.kind === "perpendicular-to-axis") {
    return stableId(def.axisId) && validateVec3Mm(def.point) && Object.keys(def).every((key) => ["kind", "axisId", "point"].includes(key));
  }
  return validNewPlaneDefinition(def) ?? false;
}

function validateConstructionUcs(value: unknown): value is import("./types.js").ConstructionUcs {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean") return false;
  if (Object.keys(value).some((key) => !["id", "name", "visible", "origin", "xAxis", "yAxis"].includes(key))) return false;
  if (!validateVec3Mm(value.origin) || !validateVec3Mm(value.xAxis) || !validateVec3Mm(value.yAxis)) return false;
  return Math.hypot(value.xAxis[0], value.xAxis[1], value.xAxis[2]) > 1e-9 && Math.hypot(value.yAxis[0], value.yAxis[1], value.yAxis[2]) > 1e-9;
}

function validatePartPreviewBody(value: unknown): value is PartPreviewBody {
  const required = ["id", "name", "shape", "visible", "color", "translationMm", "rotationDeg", "sizeMm"];
  const optional = ["boreDiameterMm", "edgeTreatment", "shellThicknessMm", "draftAngleDeg", "revolveAngleDeg", "featureTrace", "primitiveParams"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120)
    || !["block", "cylinder", "cone", "sphere", "torus", "revolved", ...NEW_PRIMITIVE_SHAPES].includes(String(value.shape))
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
  if (!validPrimitiveBody(value as unknown as PartPreviewBody)) return false;
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
  const optional = ["featureCount", "masterCart", "sourceElectricalComponentId", "catalogPartId", "mesh"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key)) || !Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120) || !["plate", "spacer", "pin", "cap", "box", "cylinder", "cone", "sphere", "hex-prism", "ring", "torus", "gear", "mesh"].includes(String(value.shape))
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
  // A mesh component carries its triangles; no other shape may.
  if ((value.shape === "mesh") !== Object.hasOwn(value, "mesh") || (value.shape === "mesh" && !validateComponentMesh(value.mesh))) return false;
  return true;
}

function validateComponentMesh(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["positionsMm", "indices", "faceTriangles"].includes(key)) || !Array.isArray(value.positionsMm) || !Array.isArray(value.indices)) return false;
  const positions = value.positionsMm;
  const indices = value.indices;
  if (positions.length < 12 || positions.length % 3 !== 0 || positions.length > 300_000 || indices.length < 3 || indices.length % 3 !== 0 || indices.length > 300_000) return false;
  if (positions.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 20_000)) return false;
  if (indices.some((entry) => typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= positions.length / 3)) return false;
  if (Object.hasOwn(value, "faceTriangles")) {
    const faces = value.faceTriangles;
    if (!Array.isArray(faces) || faces.length !== indices.length / 3 || faces.some((entry) => typeof entry !== "number" || !Number.isInteger(entry) || entry < -1 || entry > 4_096)) return false;
  }
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
    || !finiteRange(value.crownMm, -500, 500) || !finiteRange(value.twistDeg, -45, 45)
    || !integerRange(value.uSegments, 4, WORKBENCH_LIMITS.maxSurfaceSegments)
    || !integerRange(value.vSegments, 4, WORKBENCH_LIMITS.maxSurfaceSegments)) return invalid("The surface intent is outside its supported envelope.");
  return { ok: true, value: value as unknown as SurfaceIntent };
}

function validateDrawing(value: unknown): WorkbenchResult<DrawingSettings> {
  const required = ["id", "title", "sheet", "projection", "scale", "showDimensions", "notes"];
  const optional = ["viewPreset", "displayStyle", "showSectionView", "draftingStandard", "showGdt", "datumScheme", "gdtPositionToleranceMm", "gdtFlatnessToleranceMm", "gdtPerpendicularityToleranceMm", "generalToleranceLinearMm", "generalToleranceAngularDeg", "drawingNumber", "revisionTag", "drawnBy", "checkedBy", "approvedBy", "organization"];
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
    || (Object.hasOwn(value, "generalToleranceAngularDeg") && !finiteRange(value.generalToleranceAngularDeg, 0.01, 10))
    || (Object.hasOwn(value, "drawingNumber") && !shortText(value.drawingNumber, 1, 40))
    || (Object.hasOwn(value, "revisionTag") && !shortText(value.revisionTag, 1, 12))
    || (Object.hasOwn(value, "drawnBy") && !shortText(value.drawnBy, 0, 40))
    || (Object.hasOwn(value, "checkedBy") && !shortText(value.checkedBy, 0, 40))
    || (Object.hasOwn(value, "approvedBy") && !shortText(value.approvedBy, 0, 40))
    || (Object.hasOwn(value, "organization") && !shortText(value.organization, 0, 60))) return invalid("The drawing settings are invalid.");
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
  if (!Array.isArray(value) || value.length > WORKBENCH_LIMITS.maxAuditEntries) return invalid(`The revision audit is not a list or holds more than ${WORKBENCH_LIMITS.maxAuditEntries} entries.`);
  const ids = new Set<string>();
  let expected = 1;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const checkpoint = index === 0 && isRecord(entry) && entry.kind === AUDIT_CHECKPOINT_KIND;
    if (checkpoint) {
      const folded = (entry as Record<string, unknown>).checkpoint;
      if (!isRecord(folded) || !exactKeys(folded, ["firstRevision", "lastRevision", "operations", "digest"]) || !integerRange(folded.firstRevision, 1, 1_000_000_000)
        || !integerRange(folded.lastRevision, 1, 1_000_000_000) || !integerRange(folded.operations, 1, 1_000_000_000) || (folded.operations as number) > (folded.lastRevision as number)
        || (folded.lastRevision as number) < (folded.firstRevision as number) || typeof folded.digest !== "string" || !/^[0-9a-f]{64}$/u.test(folded.digest)
        || (entry as Record<string, unknown>).revision !== folded.lastRevision) return invalid("The audit checkpoint is malformed: it needs the first and last folded revision, the operation count and a SHA-256 digest.");
      expected = folded.lastRevision as number;
    }
    if (!isRecord(entry) || !exactKeys(entry, checkpoint ? ["revision", "operationId", "kind", "intentKey", "summary", "changedIds", "checkpoint"] : ["revision", "operationId", "kind", "intentKey", "summary", "changedIds"])
      || entry.revision !== expected || !stableId(entry.operationId) || ids.has(entry.operationId)
      || typeof entry.kind !== "string" || !shortText(entry.intentKey, 1, 8_192) || !shortText(entry.summary, 1, 240)
      || !Array.isArray(entry.changedIds) || entry.changedIds.length > MAX_AUDIT_CHANGED_IDS || entry.changedIds.some((id) => !stableId(id))) {
      return invalid(`Audit entry ${index + 1} is invalid or out of sequence (expected revision ${expected}).`);
    }
    ids.add(entry.operationId);
    expected += 1;
  }
  if (expected - 1 !== revision) return invalid(`The revision audit ends at revision ${expected - 1}, but the project is at revision ${revision}.`);
  return { ok: true, value: value as unknown as readonly OperationAuditEntry[] };
}

/** An audit entry names at most this many changed IDs; a larger edit (a big paste or pattern) is recorded with its first IDs and a count in the summary. */
export const MAX_AUDIT_CHANGED_IDS = 200;

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

