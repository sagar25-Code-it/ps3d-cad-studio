import { moveDesignFeature } from "./design-reorder.js";
import { isNewPrimitiveShape, NEW_PRIMITIVE_SHAPES, normalizePrimitiveSize, validPrimitiveBody } from "./primitive-bodies.js";
import { nameSketchDimensions, unbindLostDimensionNames } from "./dimension-names.js";
import { hasDimensionLabel, MAX_LABEL_OFFSET_PX, MIN_LABEL_OFFSET_PX, storedLabelOffsetPx, validLabelOffsetPx } from "./dimension-label.js";
import { planeDependencies, validConstructionBinder, validNewPlaneDefinition } from "./construction-refs.js";
import type {
  AppliedWorkbenchOperation,
  AssemblyMate,
  ComponentInstance,
  ElectricalComponent,
  ElectricalIntent,
  ElectricalNet,
  GeneralSolidBody,
  PartIntent,
  PartPreviewBody,
  SketchEntity,
  SurfaceIntent,
  VehicleLayerId,
  VehicleParameterKey,
  WorkbenchOperation,
  WorkbenchProject,
  WorkbenchResult,
  WorkspaceId
} from "./types.js";
import { validSubdCageData } from "./subd-cage.js";
import { uniqueBodyName } from "./body-names.js";
import { ELECTRICAL_SHEET_BOUNDS, ELECTROMECHANICAL_CATALOG_REVISION, GENERAL_BODY_OPERATIONS, SKETCH_DATUM_PLANES, SKETCH_POINT_REFS } from "./types.js";
import { createBessContainerAssembly, createCargoContainerAssembly, createElectricalTemplate } from "./templates.js";
import { createElectromechanicalAssembly, electricalSignature } from "./electromechanical.js";
import { createVehicleTemplate, vehicleHardPoints, VEHICLE_PARAMETER_RANGES } from "./vehicle.js";
import { MASTER_CART_TEMPLATE_IDS } from "./master-cart.js";
import { sketchPlacementProblem } from "./sketch-problem-messages.js";
import { solveLiveSketch, type LiveSketchSolveReport } from "./sketch-solve.js";
import { resizeSketchEntity, setSketchDimension, solveSummary } from "./sketch-dimension-edit.js";
import { checkNewConstraint } from "./sketch-constraint-check.js";
import { anchorsForConstraint, preserveForConstraint } from "./sketch-anchors.js";
import { isSketchDatumEntityId } from "./types.js";
import { solveAssemblyMates } from "./assembly-solve.js";
import { friendlySketchText, sketchEntityName } from "./sketch-names.js";
import {
  addDesignSolid,
  baseFeatureOf,
  commitDesignSketch,
  deleteDesignFeature,
  editDesignSketch,
  newDesignSketch,
  regenerateDesign,
  renameDesignFeature,
  setDesignFeatureSuppressed,
  setDesignRollback,
  pruneOrphanedSolidFeatures,
  updateDesignSolid,
  validSolidFeaturePayload
} from "./design.js";
import {
  booleanPartBodies,
  createRevolvedPartBody,
  deletePartBodyFaceFeature,
  mirrorPartBody,
  movePartBodyFace,
  patternPartBody,
  replacePartBodyFace,
  setPartBodyDraft,
  setPartBodyEdgeTreatment,
  setPartBodyShell,
  trimPartBody,
  validatePartFeatureStack,
  type PartFeatureResult
} from "./part-features.js";
import { setDesignParameters, settleDesignExpressions } from "./design-parameters.js";
import { failure, MAX_AUDIT_CHANGED_IDS, validateWorkbenchProject, validSketchPlaneFrame, validSketchPlaneTilt, WORKBENCH_LIMITS } from "./validation.js";
import { sketchConstraintPayloadProblem } from "./constraint-payload.js";
import { outlineBroken, outlineBrokenMessage } from "./sketch-outline-guard.js";
import { MAX_BODY_MESH_NUMBERS } from "./envelope-limits.js";
import { firstNonFinitePath, MODEL_ENVELOPE, rebuildResultProblem, sketchEntityProblem, solidEnvelopeProblem, type EnvelopeProblem } from "./envelope.js";
import { AUDIT_KEEP_FULL, compactAudit } from "./audit-archive.js";
import { validSketchPlaneFace } from "./feature-refs.js";
import { lostDimensionsNote } from "./sketch-edit-summary.js";
import { applySketchObjectsEdit, explicitObjectIds, reconcileSketchObjects, validSketchObjectsEdit } from "./sketch-objects.js";
import { unpackMeshes } from "./mesh-pack.js";
import { conventionFields } from "./plane-convention.js";
import { quarterTurnEditProblem, seedQuarterTurns } from "./sketch-quarter-turn.js";
import { missingSketchEntityFailure } from "./finished-sketch-hint.js";
import { constraintPayloadProblem, describeGivenValue, parameterTableProblem, sketchObjectsProblem } from "./operation-payload-problems.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const WORKSPACES: readonly WorkspaceId[] = ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];
const COMPONENT_SHAPES: readonly ComponentInstance["shape"][] = ["plate", "spacer", "pin", "cap", "box", "cylinder", "cone", "sphere", "hex-prism", "ring", "torus", "gear", "mesh"];
const PART_PARAMETERS: readonly (keyof Pick<PartIntent, "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm" | "edgeTreatmentMm" | "patternCount" | "revolveAngleDeg">)[] = [
  "widthMm", "heightMm", "thicknessMm", "holeDiameterMm", "edgeTreatmentMm", "patternCount", "revolveAngleDeg"
];
const SURFACE_PARAMETERS: readonly (keyof Omit<SurfaceIntent, "id" | "name" | "mode">)[] = [
  "widthMm", "depthMm", "crownMm", "twistDeg", "uSegments", "vSegments"
];
const SURFACE_PARAMETER_LABELS: Record<"widthMm" | "depthMm" | "crownMm" | "twistDeg" | "uSegments" | "vSegments", { readonly label: string; readonly unit: string }> = {
  widthMm: { label: "Span", unit: " mm" },
  depthMm: { label: "Depth", unit: " mm" },
  crownMm: { label: "Crown height", unit: " mm" },
  twistDeg: { label: "Twist", unit: "°" },
  uSegments: { label: "U tessellation", unit: " seg" },
  vSegments: { label: "V tessellation", unit: " seg" }
};
const VEHICLE_PARAMETERS = Object.keys(VEHICLE_PARAMETER_RANGES) as VehicleParameterKey[];
const VEHICLE_LAYERS: readonly VehicleLayerId[] = ["skeleton", "hardpoints", "envelopes", "wheels", "chassis", "suspension", "steering", "brakes", "powertrain", "cg-loads"];
const VEHICLE_TIRE_PARAMETERS: readonly VehicleParameterKey[] = ["frontLoadedRadiusM", "rearLoadedRadiusM", "frontRollingRadiusM", "rearRollingRadiusM", "frontTireWidthM", "rearTireWidthM", "tireFrictionCoefficient"];
const VEHICLE_BRAKE_PARAMETERS: readonly VehicleParameterKey[] = [
  "frontBrakeInputForceN", "rearBrakeInputForceN", "frontBrakeLeverRatio", "rearBrakeLeverRatio",
  "frontMasterCylinderDiameterM", "rearMasterCylinderDiameterM", "frontEquivalentClampAreaM2",
  "rearEquivalentClampAreaM2", "frontPadFrictionCoefficient", "rearPadFrictionCoefficient",
  "frontDiscEffectiveRadiusM", "rearDiscEffectiveRadiusM", "frontBrakeEfficiency",
  "rearBrakeEfficiency", "frontDiscCount", "rearDiscCount", "frontRatedPressurePa", "rearRatedPressurePa"
];

/**
 * Projects this reducer itself returned. Their validity was just established, so the next operation does not walk every mesh of
 * the project again before it starts (the project it builds is validated in full either way).
 */
const VALIDATED_PROJECTS = new WeakSet<object>();

/**
 * Applies one operation. A payload whose shape the checks did not foresee never escapes as an exception: the call comes back as a refused
 * operation that names the operation and what the engine could not read, so a caller always gets a result to show.
 */
export function applyWorkbenchOperation(
  projectInput: WorkbenchProject,
  operationInput: WorkbenchOperation
): WorkbenchResult<AppliedWorkbenchOperation> {
  try {
    return applyWorkbenchOperationChecked(projectInput, operationInput);
  } catch (error) {
    const kind = isRecord(operationInput) && typeof (operationInput as { kind?: unknown }).kind === "string" ? String((operationInput as { kind: string }).kind).slice(0, 60) : "this";
    const detail = error instanceof Error ? error.message.slice(0, 160) : "unexpected value";
    return failure("INVALID_OPERATION", `The ${kind} operation has a payload the engine could not read (${detail}).`, [], "Compare the payload with the field list of this operation in the capability list; every list, id and number must be present and of the right type.");
  }
}

function applyWorkbenchOperationChecked(
  projectInput: WorkbenchProject,
  operationInput: WorkbenchOperation
): WorkbenchResult<AppliedWorkbenchOperation> {
  const current: WorkbenchResult<WorkbenchProject> = VALIDATED_PROJECTS.has(projectInput) ? { ok: true, value: projectInput } : validateWorkbenchProject(projectInput);
  if (!current.ok) return current;
  const operationResult = validateWorkbenchOperation(operationInput);
  if (!operationResult.ok) return operationResult;
  const operation = operationResult.value;
  let intentKey: string;
  try {
    intentKey = boundedIntentKey(operation);
  } catch (error) {
    // Anything that cannot be written as canonical JSON (a NaN or infinity the shape checks did not look at) is a refused operation, not a crash.
    const where = firstNonFinitePath(operation);
    return failure("INVALID_OPERATION", where === undefined ? `The operation cannot be recorded: ${error instanceof Error ? error.message : "unsupported value"}.` : `The operation carries a number that is not finite (NaN or infinity) at ${where}.`, [operation.operationId], "Check the geometry maths that produced the value and send a finite number.");
  }
  const prior = current.value.audit.find((entry) => entry.operationId === operation.operationId);
  if (prior !== undefined) {
    if (prior.intentKey !== intentKey) {
      return failure("IDEMPOTENCY_CONFLICT", "The operation ID was already used for different intent.", [operation.operationId], "Create a new operation ID for the new intent.");
    }
    return { ok: true, value: { project: current.value, changedIds: prior.changedIds, summary: prior.summary, exactRetry: true } };
  }
  if (operation.expectedRevision !== current.value.revision) {
    return failure("REVISION_CONFLICT", `Expected revision ${operation.expectedRevision}, but the project is at ${current.value.revision}.`, [current.value.id], "Refresh the project and preview the operation again.");
  }
  // A full audit never freezes the project: the oldest entries fold into one checkpoint and the last AUDIT_KEEP_FULL stay in full.
  const priorAudit = current.value.audit.length >= WORKBENCH_LIMITS.maxAuditEntries ? compactAudit(current.value.audit, AUDIT_KEEP_FULL) : current.value.audit;

  // Every driving dimension of the working sketch has a name an expression can use; an edit of the sketch names the new ones.
  const settled = settleDesignExpressions(current.value, operation, withDimensionNames(current.value, operation, applyIntent(current.value, operation)), resizeSketchEntity);
  // Messages name sketch geometry as "Line 3", never by its generated id (see sketch-names.ts).
  const reconciled = settled.ok ? reconcileOperationSketch(current.value, settled.value, operation) : settled;
  if (!reconciled.ok) return { ok: false, diagnostics: reconciled.diagnostics.map((entry) => ({ ...entry, message: friendlySketchText(entry.message, [current.value.sketch]), recovery: friendlySketchText(entry.recovery, [current.value.sketch]) })) };
  const changed = { ok: true as const, value: { ...reconciled.value, summary: friendlySketchText(reconciled.value.summary, [reconciled.value.project.sketch, current.value.sketch]) } };
  const nextRevision = current.value.revision + 1;
  const next: WorkbenchProject = {
    ...refreshMateStatuses(changed.value.project, operation.kind),
    revision: nextRevision,
    audit: [...priorAudit, {
      revision: nextRevision,
      operationId: operation.operationId,
      kind: operation.kind,
      intentKey,
      summary: fitAuditSummary(changed.value.summary),
      // The audit keeps the first ids of a big edit (a paste, a pattern, a break); the operation result still carries them all.
      changedIds: auditChangedIds(changed.value.changedIds)
    }]
  };
  const validated = validateWorkbenchProject(next, { share: true });
  if (!validated.ok) return validated;
  VALIDATED_PROJECTS.add(validated.value);
  return { ok: true, value: { project: validated.value, changedIds: changed.value.changedIds, summary: changed.value.summary, exactRetry: false } };
}

const DIMENSION_NAMING_KINDS: ReadonlySet<WorkbenchOperation["kind"]> = new Set(["set-sketch-dimension", "apply-sketch-edit", "add-sketch-constraint"]);
/** Edits that can take a named dimension away (delete it, delete its curve, make it a reference). */
const DIMENSION_REMOVING_KINDS: ReadonlySet<WorkbenchOperation["kind"]> = new Set(["set-sketch-dimension", "apply-sketch-edit", "delete-sketch-constraint", "delete-sketch-entity"]);

function withDimensionNames<T extends { readonly project: WorkbenchProject; readonly summary: string }>(before: WorkbenchProject, operation: WorkbenchOperation, result: WorkbenchResult<T>): WorkbenchResult<T> {
  if (!result.ok || !(DIMENSION_NAMING_KINDS.has(operation.kind) || DIMENSION_REMOVING_KINDS.has(operation.kind))) return result;
  const named = DIMENSION_NAMING_KINDS.has(operation.kind) ? nameSketchDimensions(before.sketch, result.value.project.sketch, result.value.project.design) : result.value.project.sketch;
  // A dimension whose expression used the name of one that is gone keeps its value and becomes a plain number.
  const freed = DIMENSION_REMOVING_KINDS.has(operation.kind) ? unbindLostDimensionNames(result.value.project.design, named) : { sketch: named, unbound: [] };
  if (freed.sketch === result.value.project.sketch) return result;
  const note = freed.unbound.length === 0 ? "" : ` ${freed.unbound.join(", ")} used the name of a dimension that is gone, so ${freed.unbound.length === 1 ? "it keeps its value as a plain number" : "they keep their values as plain numbers"}.`;
  return { ok: true, value: { ...result.value, project: { ...result.value.project, sketch: freed.sketch }, summary: `${result.value.summary}${note}` } };
}

/** The audit keeps a summary of at most 240 characters; a long one (a big edit that moved many curves) is shortened rather than refused. */
function fitAuditSummary(summary: string): string {
  return summary.length <= 240 ? summary : `${summary.slice(0, 237)}...`;
}

/** The IDs an audit entry lists: the first MAX_AUDIT_CHANGED_IDS, so a large paste or pattern is recorded rather than refused. */
function auditChangedIds(ids: readonly string[]): readonly string[] {
  return ids.length <= MAX_AUDIT_CHANGED_IDS ? ids : ids.slice(0, MAX_AUDIT_CHANGED_IDS);
}

const MATE_STATUS_REFRESH_KINDS: readonly WorkbenchOperation["kind"][] = [
  "set-component-translation", "toggle-component-grounded", "delete-assembly-mate", "delete-assembly-component", "add-assembly-component",
  "add-assembly-components", "apply-assembly-template", "generate-electromechanical-realization"
];

/** Mate statuses are derived from the current positions, so they are refreshed after anything that can change them. */
function refreshMateStatuses(project: WorkbenchProject, kind: WorkbenchOperation["kind"]): WorkbenchProject {
  if (!MATE_STATUS_REFRESH_KINDS.includes(kind) || project.assembly.mates.length === 0) return project;
  const derived = solveAssemblyMates(project.assembly, { move: false });
  return derived.mates.every((mate, index) => mate === project.assembly.mates[index]) ? project : { ...project, assembly: { ...project.assembly, mates: derived.mates } };
}

/** Audit entries cap the intent key at 8,192 characters (see validateAudit). */
const INTENT_KEY_INLINE_LIMIT = 8_000;

/**
 * Idempotency fingerprint of an operation. Small operations keep their exact
 * canonical JSON. Operations that carry bulk data (a tessellated general body
 * can hold tens of thousands of numbers) collapse to a length-and-digest form,
 * so the audit stays within its bound while an exact retry still matches and a
 * reused operation ID with different content still conflicts.
 */
function boundedIntentKey(operation: WorkbenchOperation): string {
  const canonical = canonicalizeJson(operation);
  if (canonical.length <= INTENT_KEY_INLINE_LIMIT) return canonical;
  return `digest:${operation.kind}:${operation.operationId}:${canonical.length}:${fingerprint64(canonical)}`;
}

/** Synchronous 64-bit fingerprint (two independent FNV-1a lanes); for idempotency comparison, not security. */
function fingerprint64(text: string): string {
  let high = 0xcbf29ce4 >>> 0;
  let low = 0x84222325 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x01000193) >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

/** True when a number anywhere inside the value is NaN or infinite; such a payload cannot be canonicalised or stored. */
function containsNonFinite(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (depth > 12 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsNonFinite(item, depth + 1));
  return Object.values(value as Record<string, unknown>).some((item) => containsNonFinite(item, depth + 1));
}

const SKETCH_DIMENSION_NAMES: readonly string[] = ["length", "width", "height", "radius", "diameter", "angle", "arc-length", "perimeter", "aligned", "horizontal", "vertical", "point-line", "line-line", "offset", "major-radius", "minor-radius"];

/** Says what is wrong with a malformed set-sketch-dimension payload instead of a bare "invalid". */
function sketchDimensionProblem(input: Record<string, unknown>): string {
  if (!SKETCH_DIMENSION_NAMES.includes(String(input.dimension))) return `The sketch dimension "${String(input.dimension)}" is not one of: ${SKETCH_DIMENSION_NAMES.join(", ")}.`;
  if (!finite(input.valueMm)) return "The sketch dimension needs a finite number for its value.";
  if (Object.hasOwn(input, "doubled") && (typeof input.doubled !== "boolean" || (input.dimension !== "point-line" && input.dimension !== "line-line"))) return "Only a point-line or line-line distance can be doubled (a diameter across the line), and doubled must be true or false.";
  if (Object.hasOwn(input, "points") && (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > 2 || input.points.some((point) => !(SKETCH_POINT_REFS as readonly unknown[]).includes(point)))) {
    return `The dimension's points must be one or two of: ${SKETCH_POINT_REFS.join(", ")}.`;
  }
  if (Object.hasOwn(input, "expression")) {
    if (input.driven === true) return "A reference (driven) dimension is measured, so it cannot be bound to an expression.";
    if (!(typeof input.expression === "string" && input.expression.length >= 1 && input.expression.length <= 400)) return "A dimension expression must be text of 1 to 400 characters.";
  }
  return "The sketch dimension edit is invalid: check the entity IDs and the dimension name.";
}

export function validateWorkbenchOperation(input: unknown): WorkbenchResult<WorkbenchOperation> {
  // A payload of the wrong shape is a refused operation with a reason, never an exception (operation-payload fuzzer in the tests).
  try {
    return validateWorkbenchOperationShape(input);
  } catch (caught) {
    return invalidOperation(`The operation payload is malformed (${caught instanceof Error ? caught.message : "unreadable field"}). Check each field's name and type against the operation schema.`);
  }
}

function validateWorkbenchOperationShape(rawInput: unknown): WorkbenchResult<WorkbenchOperation> {
  // A body travelling with a packed mesh (MCP, see mesh-pack.ts) is read back to plain lists first.
  const unpacked = unpackMeshes(rawInput);
  if (!unpacked.ok) return invalidOperation(`The operation has a damaged packed mesh: ${unpacked.message}`);
  const input = unpacked.value;
  if (containsNonFinite(input)) return invalidOperation("The operation contains a number that is not finite (NaN or Infinity); enter a finite value.");
  if (!isRecord(input) || !stableId(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || typeof input.kind !== "string") {
    return invalidOperation("The operation envelope is invalid.");
  }
  const common = ["operationId", "expectedRevision", "kind"];
  switch (input.kind) {
    case "select-workspace":
      if (!keys(input, [...common, "workspace"]) || !WORKSPACES.includes(input.workspace as WorkspaceId)) return invalidOperation("The requested workspace is invalid.");
      break;
    case "add-sketch-entity":
      if (!keys(input, [...common, "entity"]) || !isRecord(input.entity)) return invalidOperation("The sketch entity payload is invalid.");
      {
        const problem = sketchEntityProblem(input.entity);
        if (problem !== undefined) return envelopeFailure(problem);
      }
      break;
    case "delete-sketch-entity":
      if (!keys(input, [...common, "entityId"]) || !stableId(input.entityId)) return invalidOperation("The sketch entity ID is invalid.");
      break;
    case "add-sketch-constraint":
      if (!keys(input, [...common, "constraint"]) || !isRecord(input.constraint)) return invalidOperation(constraintPayloadProblem(input.constraint) ?? "The sketch constraint payload needs exactly one field, constraint.");
      {
        // The relation names its own field first (and its position inside an edit); then the bounded-range check of the envelope.
        const named = constraintPayloadProblem(input.constraint);
        if (named !== undefined) return invalidOperation(named);
        const problem = sketchConstraintPayloadProblem(input.constraint);
        if (problem !== undefined) return envelopeFailure(problem);
      }
      break;
    case "delete-sketch-constraint":
      if (!keys(input, [...common, "constraintId"]) || !stableId(input.constraintId)) return invalidOperation("The sketch constraint ID is invalid.");
      break;
    case "set-sketch-dimension":
      if (!keys(input, [...common, "entityId", "dimension", "valueMm", ...(Object.hasOwn(input, "secondEntityId") ? ["secondEntityId"] : []), ...(Object.hasOwn(input, "points") ? ["points"] : []), ...(Object.hasOwn(input, "driven") ? ["driven"] : []), ...(Object.hasOwn(input, "expression") ? ["expression"] : []), ...(Object.hasOwn(input, "doubled") ? ["doubled"] : [])]) || !stableId(input.entityId)
        || !SKETCH_DIMENSION_NAMES.includes(String(input.dimension)) || !finite(input.valueMm)
        || (Object.hasOwn(input, "secondEntityId") && !stableId(input.secondEntityId)) || (Object.hasOwn(input, "driven") && typeof input.driven !== "boolean")
        || (Object.hasOwn(input, "doubled") && (typeof input.doubled !== "boolean" || (input.dimension !== "point-line" && input.dimension !== "line-line")))
        || (Object.hasOwn(input, "points") && (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > 2 || input.points.some((point) => !(SKETCH_POINT_REFS as readonly unknown[]).includes(point))))
        // An expression binds any driving dimension (a length, a radius, an angle in degrees...) to the parameter table; a reference (driven) dimension carries none.
        || (Object.hasOwn(input, "expression") && (!(typeof input.expression === "string" && input.expression.length >= 1 && input.expression.length <= 400) || input.driven === true))) {
        return invalidOperation(sketchDimensionProblem(input));
      }
      break;
    case "toggle-sketch-construction":
      if (!keys(input, [...common, "entityId"]) || !stableId(input.entityId)) return invalidOperation("The sketch entity ID is invalid.");
      break;
    case "toggle-sketch-entity-visibility":
      if (!keys(input, [...common, "entityId"]) || !stableId(input.entityId)) return invalidOperation("The sketch entity ID is invalid.");
      break;
    case "apply-sketch-edit":
      for (const [field, limit, what] of [["removeEntityIds", WORKBENCH_LIMITS.maxEntities, "curves to remove"], ["updateEntities", WORKBENCH_LIMITS.maxEntities, "curves to change"], ["addEntities", WORKBENCH_LIMITS.maxEntities, "curves to add"], ["addConstraints", WORKBENCH_LIMITS.maxConstraints, "relations to add"], ["removeConstraintIds", WORKBENCH_LIMITS.maxConstraints, "relations to remove"]] as const) {
        const list = input[field];
        if (Array.isArray(list) && list.length > limit) return invalidOperation(`One sketch edit can carry at most ${limit} ${what}; this one has ${list.length}. A sketch holds at most ${WORKBENCH_LIMITS.maxEntities} curves, so split the paste, pattern or import into smaller steps.`);
      }
      if (!keys(input, [...common, "removeEntityIds", "updateEntities", "addEntities", "addConstraints", "label", ...(Object.hasOwn(input, "removeConstraintIds") ? ["removeConstraintIds"] : []), ...(Object.hasOwn(input, "objects") ? ["objects"] : [])])
        || (Object.hasOwn(input, "objects") && !validSketchObjectsEdit(input.objects))
        || (Object.hasOwn(input, "removeConstraintIds") && !boundedList(input.removeConstraintIds, WORKBENCH_LIMITS.maxConstraints, stableId))
        || !boundedList(input.removeEntityIds, WORKBENCH_LIMITS.maxEntities, stableId) || !boundedList(input.updateEntities, WORKBENCH_LIMITS.maxEntities, isRecord)
        || !boundedList(input.addEntities, WORKBENCH_LIMITS.maxEntities, isRecord) || !boundedList(input.addConstraints, WORKBENCH_LIMITS.maxConstraints, isRecord)
        || typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80) return invalidOperation(sketchEditPayloadMessage(input));
      for (const entity of [...(input.updateEntities as readonly unknown[]), ...(input.addEntities as readonly unknown[])]) {
        const problem = sketchEntityProblem(entity);
        if (problem !== undefined) return envelopeFailure(problem);
      }
      for (const [index, constraint] of (input.addConstraints as readonly unknown[]).entries()) {
        const named = constraintPayloadProblem(constraint, index);
        if (named !== undefined) return invalidOperation(named);
        const problem = sketchConstraintPayloadProblem(constraint);
        if (problem !== undefined) return envelopeFailure(problem);
      }
      break;
    case "set-sketch-constraints-suppressed":
      if (!keys(input, [...common, "constraintIds", "suppressed"]) || !boundedList(input.constraintIds, 500, stableId) || input.constraintIds.length < 1
        || typeof input.suppressed !== "boolean") return invalidOperation("The constraint relax payload is invalid.");
      break;
    case "set-sketch-dimension-label":
      if (!keys(input, [...common, "constraintId", "offsetPx"]) || !stableId(input.constraintId)) return invalidOperation("Placing a dimension label needs the dimension's constraintId and an offsetPx.");
      if (!validLabelOffsetPx(input.offsetPx)) return invalidOperation(`A dimension label stands ${MIN_LABEL_OFFSET_PX} to ${MAX_LABEL_OFFSET_PX} screen pixels off its geometry; offsetPx must be a number in that range.`);
      break;
    case "set-sketch-plane":
      if (!validSketchPlacementInput(input, common)) return invalidOperation(sketchPlacementProblem(input, common));
      break;
    case "commit-design-sketch":
      if (!keys(input, [...common, "featureId", "name"]) || !stableId(input.featureId) || !shortText(input.name, 1, 120)) return invalidOperation("The sketch feature payload is invalid.");
      if (input.name.trim() === "") return invalidOperation("The feature name cannot be blank. Type at least one character.");
      break;
    case "edit-design-sketch":
    case "delete-design-feature":
      if (!keys(input, [...common, "featureId"]) || !stableId(input.featureId)) return invalidOperation("The timeline feature ID is invalid.");
      break;
    case "new-design-sketch":
      if (!validSketchPlacementInput(input, common)) return invalidOperation(sketchPlacementProblem(input, common));
      break;
    case "add-design-solid":
    case "update-design-solid":
      if (!keys(input, [...common, "feature", "body"]) || !validSolidFeaturePayload(input.feature) || !validGeneralSolidBodyPayload(input.body)) {
        const problem = solidEnvelopeProblem(input.feature, input.body);
        return problem !== undefined ? envelopeFailure(problem) : invalidOperation("The solid feature or its body is invalid.");
      }
      {
        const problem = solidEnvelopeProblem(input.feature, input.body);
        if (problem !== undefined) return envelopeFailure(problem);
      }
      break;
    case "regenerate-design":
      if (Object.hasOwn(input, "sketchCurves") && (!boundedList(input.sketchCurves, 200, isRecord)
        || input.sketchCurves.some((entry) => !stableId(entry.sketchFeatureId) || Object.keys(entry).some((key) => !["sketchFeatureId", "entities", "message"].includes(key))
          || !boundedList(entry.entities, WORKBENCH_LIMITS.maxEntities, isRecord) || entry.entities.some((entity) => sketchEntityProblem(entity) !== undefined)
          || (Object.hasOwn(entry, "message") && !shortText(entry.message, 1, 400))))) return invalidOperation("The refreshed sketch curves are invalid: each entry names a timeline sketch, lists sketch curves, and may carry a message of up to 400 characters.");
      if (!keys(input, [...common, "results", ...(Object.hasOwn(input, "sketchCurves") ? ["sketchCurves"] : [])]) || !boundedList(input.results, 200, isRecord)
        || input.results.some((result) => !stableId(result.featureId) || Object.keys(result).some((key) => !["featureId", "body", "pieces", "message", "sketchPlaneOffsetMm", "sketchEntities"].includes(key))
          || (Object.hasOwn(result, "sketchEntities") && (!boundedList(result.sketchEntities, WORKBENCH_LIMITS.maxEntities, isRecord) || result.sketchEntities.some((entity) => sketchEntityProblem(entity) !== undefined)))
          || (Object.hasOwn(result, "sketchPlaneOffsetMm") && !finiteRange(result.sketchPlaneOffsetMm, -MODEL_ENVELOPE.maxPlaneOffsetMm, MODEL_ENVELOPE.maxPlaneOffsetMm))
          || (Object.hasOwn(result, "body") && !validGeneralSolidBodyPayload(result.body))
          // Pieces a cut or hole severed off the solid; they ride with the result that holds the solid itself.
          || (Object.hasOwn(result, "pieces") && (!Object.hasOwn(result, "body") || !boundedList(result.pieces, 16, validGeneralSolidBodyPayload)))
          // A result with neither a body nor a message means the step applied cleanly (a join or cut reports this: the
          // finished shape travels with the step that made the body).
          || (Object.hasOwn(result, "message") && !shortText(result.message, 1, 400)))) return invalidOperation(Array.isArray(input.results) ? (rebuildResultProblem(input.results) ?? "The rebuild results are invalid.") : "The rebuild results are invalid.");
      break;
    case "set-design-parameters":
      if (!keys(input, [...common, "parameters", ...(Object.hasOwn(input, "renames") ? ["renames"] : []), ...(Object.hasOwn(input, "modelValues") ? ["modelValues"] : [])]) || !boundedList(input.parameters, 200, isRecord)
        || (Object.hasOwn(input, "modelValues") && (!boundedList(input.modelValues, 400, isRecord)
          || input.modelValues.some((value) => !keys(value, ["ownerId", "fieldId", "text"]) || !stableId(value.ownerId) || typeof value.fieldId !== "string" || value.fieldId.length === 0 || value.fieldId.length > 160 || typeof value.text !== "string" || value.text.length > 400)))
        || input.parameters.some((parameter) => !keys(parameter, ["name", "expression", "unit", "comment"]) || typeof parameter.name !== "string" || typeof parameter.expression !== "string"
          || !["mm", "deg", ""].includes(String(parameter.unit)) || typeof parameter.comment !== "string")
        || (Object.hasOwn(input, "renames") && (!boundedList(input.renames, 200, isRecord)
          || input.renames.some((rename) => !keys(rename, ["from", "to"]) || typeof rename.from !== "string" || typeof rename.to !== "string")))) return invalidOperation(parameterTableProblem(input) ?? "The parameter table is invalid.");
      break;
    case "set-design-feature-suppressed":
      if (!keys(input, [...common, "featureId", "suppressed"]) || !stableId(input.featureId) || typeof input.suppressed !== "boolean") return invalidOperation("The suppress request is invalid.");
      break;
    case "set-design-rollback":
      if (!keys(input, [...common, "index"]) || typeof input.index !== "number" || !Number.isInteger(input.index) || input.index < 0 || input.index > 1_000) return invalidOperation("The rollback position is invalid.");
      break;
    case "move-design-feature":
      if (!keys(input, [...common, "featureId", "toIndex"]) || !stableId(input.featureId) || typeof input.toIndex !== "number" || !Number.isInteger(input.toIndex) || input.toIndex < 0 || input.toIndex > 1_000) return invalidOperation("The move request is invalid: name the step and the place (a whole number from 0) it should end up in.");
      break;
    case "rename-design-feature":
      if (!keys(input, [...common, "featureId", "name"]) || !stableId(input.featureId) || !shortText(input.name, 1, 120)) return invalidOperation("The rename request is invalid.");
      if (input.name.trim() === "") return invalidOperation("The feature name cannot be blank. Type at least one character.");
      break;
    case "set-part-parameter":
      if (!keys(input, [...common, "parameter", "value"]) || !PART_PARAMETERS.includes(input.parameter as never) || !finite(input.value)) return invalidOperation("The part parameter edit is invalid.");
      break;
    case "add-part-preview-bodies":
      if (!keys(input, [...common, "bodies"]) || !Array.isArray(input.bodies) || input.bodies.length < 1 || input.bodies.length > 24
        || input.bodies.some((body) => !validPartPreviewBodyPayload(body))) return invalidOperation("The preview-body insertion is invalid.");
      break;
    case "delete-part-preview-body":
    case "toggle-part-preview-body-visibility":
    case "isolate-part-preview-body":
      if (!keys(input, [...common, "bodyId"]) || !stableId(input.bodyId)) return invalidOperation("The preview-body ID is invalid.");
      break;
    case "set-part-preview-bodies-visibility":
      if (!keys(input, [...common, "visible"]) || typeof input.visible !== "boolean") return invalidOperation("The preview-body visibility value is invalid.");
      break;
    case "add-general-body":
      if (!keys(input, [...common, "body"]) || !validGeneralSolidBodyPayload(input.body)) return invalidOperation("The general body insertion is invalid.");
      break;
    case "boolean-general-bodies":
      if (!keys(input, [...common, "targetBodyId", "toolBodyId", "mode", "keepTool", "body"]) || !stableId(input.targetBodyId) || !stableId(input.toolBodyId)
        || input.targetBodyId === input.toolBodyId || !["join", "cut", "intersect"].includes(String(input.mode)) || typeof input.keepTool !== "boolean"
        || !validGeneralSolidBodyPayload(input.body)) return invalidOperation("The general-body Boolean payload is invalid.");
      break;
    case "delete-general-body":
    case "toggle-general-body-visibility":
      if (!keys(input, [...common, "bodyId"]) || !stableId(input.bodyId)) return invalidOperation("The general body ID is invalid.");
      break;
    case "rename-general-body":
      if (!keys(input, [...common, "bodyId", "name"]) || !stableId(input.bodyId) || !shortText(input.name, 1, 120)) return invalidOperation("The body rename request is invalid.");
      if (input.name.trim() === "") return invalidOperation("The body name cannot be blank. Type at least one character.");
      break;
    case "modify-general-body":
      if (!keys(input, [...common, "targetBodyId", "modifier", "label", "body"]) || !stableId(input.targetBodyId)
        || !["hole", "shell", "chamfer", "fillet", "counterbore", "countersink", "tapped-hole", "surface-edit", "stitch", "form-edit", "form-finish"].includes(String(input.modifier)) || !shortText(input.label, 1, 120)
        || !validGeneralSolidBodyPayload(input.body)) return invalidOperation("The modify-general-body payload is invalid.");
      break;
    case "add-construction-plane":
      if (!keys(input, [...common, "plane"]) || !validConstructionPlanePayload(input.plane)) return invalidOperation("The construction-plane insertion is invalid.");
      break;
    case "delete-construction-plane":
    case "toggle-construction-plane-visibility":
      if (!keys(input, [...common, "planeId"]) || !stableId(input.planeId)) return invalidOperation("The construction-plane ID is invalid.");
      break;
    case "rename-construction-plane":
      if (!keys(input, [...common, "planeId", "name"]) || !stableId(input.planeId) || !shortText(input.name, 1, 120)) return invalidOperation("The construction-plane rename is invalid.");
      break;
    case "add-construction-binder":
      if (!keys(input, [...common, "binder"]) || !validConstructionBinder(input.binder)) return invalidOperation("The construction-binder insertion is invalid.");
      break;
    case "delete-construction-binder":
    case "toggle-construction-binder-visibility":
      if (!keys(input, [...common, "binderId"]) || !stableId(input.binderId)) return invalidOperation("The construction-binder ID is invalid.");
      break;
    case "add-construction-axis":
      if (!keys(input, [...common, "axis"]) || !validConstructionAxisPayload(input.axis)) return invalidOperation("The construction-axis insertion is invalid.");
      break;
    case "delete-construction-axis":
    case "toggle-construction-axis-visibility":
      if (!keys(input, [...common, "axisId"]) || !stableId(input.axisId)) return invalidOperation("The construction-axis ID is invalid.");
      break;
    case "rename-construction-axis":
      if (!keys(input, [...common, "axisId", "name"]) || !stableId(input.axisId) || !shortText(input.name, 1, 120)) return invalidOperation("The construction-axis rename is invalid.");
      break;
    case "add-construction-point":
      if (!keys(input, [...common, "point"]) || !validConstructionPointPayload(input.point)) return invalidOperation("The construction-point insertion is invalid.");
      break;
    case "delete-construction-point":
    case "toggle-construction-point-visibility":
      if (!keys(input, [...common, "pointId"]) || !stableId(input.pointId)) return invalidOperation("The construction-point ID is invalid.");
      break;
    case "rename-construction-point":
      if (!keys(input, [...common, "pointId", "name"]) || !stableId(input.pointId) || !shortText(input.name, 1, 120)) return invalidOperation("The construction-point rename is invalid.");
      break;
    case "add-construction-ucs":
      if (!keys(input, [...common, "ucs"]) || !validConstructionUcsPayload(input.ucs)) return invalidOperation("The construction-UCS insertion is invalid.");
      break;
    case "delete-construction-ucs":
    case "toggle-construction-ucs-visibility":
      if (!keys(input, [...common, "ucsId"]) || !stableId(input.ucsId)) return invalidOperation("The construction-UCS ID is invalid.");
      break;
    case "rename-construction-ucs":
      if (!keys(input, [...common, "ucsId", "name"]) || !stableId(input.ucsId) || !shortText(input.name, 1, 120)) return invalidOperation("The construction-UCS rename is invalid.");
      break;
    case "create-part-revolve":
      if (!keys(input, [...common, "bodyId", "name", "outerDiameterMm", "innerDiameterMm", "heightMm", "angleDeg", "translationMm"])
        || !stableId(input.bodyId) || !shortText(input.name, 1, 120)
        || !finiteRange(input.outerDiameterMm, WORKBENCH_LIMITS.minGeometryMm, 10_000)
        || !finiteRange(input.innerDiameterMm, WORKBENCH_LIMITS.minGeometryMm, 9_999)
        || !finiteRange(input.heightMm, WORKBENCH_LIMITS.minGeometryMm, 10_000)
        || !finiteRange(input.angleDeg, 0.001, 360)
        || !vec3(input.translationMm, WORKBENCH_LIMITS.maxCoordinateMm)) return invalidOperation("The revolve feature payload is invalid.");
      break;
    case "pattern-part-feature":
      if (!keys(input, [...common, "bodyId", "instanceIds", "direction", "spacingMm"]) || !stableId(input.bodyId)
        || !Array.isArray(input.instanceIds) || input.instanceIds.length < 1 || input.instanceIds.length > 23
        || input.instanceIds.some((id) => !stableId(id)) || new Set(input.instanceIds).size !== input.instanceIds.length
        || !["x", "y", "z"].includes(String(input.direction)) || !finiteRange(input.spacingMm, WORKBENCH_LIMITS.minGeometryMm, 10_000)) return invalidOperation("The feature-pattern payload is invalid.");
      break;
    case "mirror-part-feature":
      if (!keys(input, [...common, "bodyId", "newBodyId", "plane"]) || !stableId(input.bodyId) || !stableId(input.newBodyId)
        || !["xy", "xz", "yz"].includes(String(input.plane))) return invalidOperation("The mirror-feature payload is invalid.");
      break;
    case "boolean-part-bodies":
      if (!keys(input, [...common, "targetBodyId", "toolBodyId", "operation"]) || !stableId(input.targetBodyId) || !stableId(input.toolBodyId)
        || input.targetBodyId === input.toolBodyId || !["unite", "subtract"].includes(String(input.operation))) return invalidOperation("The Boolean body payload is invalid.");
      break;
    case "trim-part-body":
      if (!keys(input, [...common, "bodyId", "keptLengthMm", "side"]) || !stableId(input.bodyId)
        || !finiteRange(input.keptLengthMm, WORKBENCH_LIMITS.minGeometryMm, 10_000) || !["negative", "positive"].includes(String(input.side))) return invalidOperation("The trim-body payload is invalid.");
      break;
    case "set-part-body-edge-treatment":
      if (!keys(input, [...common, "bodyId", "treatment", "sizeMm"]) || !stableId(input.bodyId)
        || !["blend", "chamfer"].includes(String(input.treatment)) || !finiteRange(input.sizeMm, WORKBENCH_LIMITS.minGeometryMm, 5_000)) return invalidOperation("The edge-treatment payload is invalid.");
      break;
    case "set-part-body-draft":
      if (!keys(input, [...common, "bodyId", "angleDeg"]) || !stableId(input.bodyId) || !finiteRange(input.angleDeg, 0.001, 20)) return invalidOperation("The draft payload is invalid.");
      break;
    case "set-part-body-shell":
      if (!keys(input, [...common, "bodyId", "thicknessMm"]) || !stableId(input.bodyId) || !finiteRange(input.thicknessMm, WORKBENCH_LIMITS.minGeometryMm, 5_000)) return invalidOperation("The shell payload is invalid.");
      break;
    case "move-part-body-face":
      if (!keys(input, [...common, "bodyId", "face", "offsetMm", "mode"]) || !stableId(input.bodyId)
        || !partFace(input.face) || !finiteRange(input.offsetMm, -5_000, 5_000) || Math.abs(input.offsetMm as number) < 1e-12
        || !["move", "offset"].includes(String(input.mode))) return invalidOperation("The face move/offset payload is invalid.");
      break;
    case "replace-part-body-face":
      if (!keys(input, [...common, "bodyId", "face", "localPositionMm"]) || !stableId(input.bodyId)
        || !partFace(input.face) || !finiteRange(input.localPositionMm, -5_000, 5_000)) return invalidOperation("The replace-face payload is invalid.");
      break;
    case "delete-part-body-face":
      if (!keys(input, [...common, "bodyId", "feature"]) || !stableId(input.bodyId)
        || !["bore", "edge-treatment", "shell", "draft"].includes(String(input.feature))) return invalidOperation("The delete-face/heal payload is invalid.");
      break;
    case "update-part-model":
      if (!keys(input, common)) return invalidOperation("Update Model accepts no additional fields.");
      break;
    case "set-part-preview-body-transform":
      if (!keys(input, [...common, "bodyId", "translationMm", "rotationDeg"]) || !stableId(input.bodyId)
        || !vec3(input.translationMm, WORKBENCH_LIMITS.maxCoordinateMm) || !vec3(input.rotationDeg, 360)) return invalidOperation("The preview-body transform is invalid.");
      break;
    case "set-part-preview-body-size":
      if (!keysWithOptional(input, [...common, "bodyId", "sizeMm"], ["primitiveParams"]) || !stableId(input.bodyId) || !partPreviewSize(input.sizeMm)
        || (Object.hasOwn(input, "primitiveParams") && !isRecord(input.primitiveParams))) return invalidOperation("The preview-body size is invalid.");
      break;
    case "set-part-preview-body-color":
      if (!keys(input, [...common, "bodyId", "color"]) || !stableId(input.bodyId) || typeof input.color !== "string" || !COLOR_PATTERN.test(input.color)) return invalidOperation("The preview-body color is invalid.");
      break;
    case "set-assembly-explode":
      if (!keys(input, [...common, "valueMm"]) || !finite(input.valueMm)) return invalidOperation("The assembly explode value is invalid.");
      break;
    case "apply-assembly-template":
      if (!keys(input, [...common, "template"]) || !["cargo-20ft", "cargo-40ft-hc", "bess-20ft-hc"].includes(String(input.template))) return invalidOperation("The assembly template is invalid.");
      break;
    case "add-assembly-component":
      if (!keys(input, [...common, "component"]) || !validComponentPayload(input.component)) return invalidOperation("The assembly component payload is invalid.");
      break;
    case "add-assembly-components":
      if (!keys(input, [...common, "components"]) || !Array.isArray(input.components) || input.components.length < 1 || input.components.length > 32
        || input.components.some((component) => !validComponentPayload(component))
        || new Set(input.components.map((component) => component.id)).size !== input.components.length) return invalidOperation("The grouped assembly-component payload is invalid or duplicated.");
      break;
    case "delete-assembly-component":
      if (!keys(input, [...common, "componentId"]) || !stableId(input.componentId)) return invalidOperation("The component ID is invalid.");
      break;
    case "set-component-translation":
      if (!keys(input, [...common, "componentId", "translationMm"]) || !stableId(input.componentId) || !vec3(input.translationMm, WORKBENCH_LIMITS.maxCoordinateMm)) return invalidOperation("The component translation is invalid.");
      break;
    case "toggle-component-grounded":
      if (!keys(input, [...common, "componentId"]) || !stableId(input.componentId)) return invalidOperation("The component ID is invalid.");
      break;
    case "toggle-component-visibility":
      if (!keys(input, [...common, "componentId"]) || !stableId(input.componentId)) return invalidOperation("The component ID is invalid.");
      break;
    case "add-assembly-mate":
      if (!keys(input, [...common, "mate"]) || !validAssemblyMatePayload(input.mate)) return invalidOperation("The assembly mate payload is invalid.");
      break;
    case "solve-assembly-mates":
      if (!keys(input, common)) return invalidOperation("The mate solve takes no parameters.");
      break;
    case "delete-assembly-mate":
      if (!keys(input, [...common, "mateId"]) || !stableId(input.mateId)) return invalidOperation("The mate ID is invalid.");
      break;
    case "set-surface-mode":
      if (!keys(input, [...common, "mode"]) || !["bezier", "loft"].includes(String(input.mode))) return invalidOperation("The surface mode is invalid.");
      break;
    case "set-surface-parameter":
      if (!keys(input, [...common, "parameter", "value"]) || !SURFACE_PARAMETERS.includes(input.parameter as never) || !finite(input.value)) return invalidOperation("The surface parameter edit is invalid.");
      break;
    case "apply-surface-preset":
      if (!keys(input, [...common, "preset"]) || !["flatten", "canopy"].includes(String(input.preset))) return invalidOperation("The surface preset is invalid.");
      break;
    case "set-drawing-sheet":
      if (!keys(input, [...common, "sheet"]) || !["A4", "A3"].includes(String(input.sheet))) return invalidOperation("The drawing sheet is invalid.");
      break;
    case "set-drawing-projection":
      if (!keys(input, [...common, "projection"]) || !["first-angle", "third-angle"].includes(String(input.projection))) return invalidOperation("The drawing projection is invalid.");
      break;
    case "set-drawing-scale":
      if (!keys(input, [...common, "scale"]) || ![1, 2, 5].includes(input.scale as number)) return invalidOperation("The drawing scale is invalid.");
      break;
    case "set-drawing-dimensions":
      if (!keys(input, [...common, "show"]) || typeof input.show !== "boolean") return invalidOperation("The drawing dimension setting is invalid.");
      break;
    case "set-drawing-view-preset":
      if (!keys(input, [...common, "preset"]) || !["automatic-4-view", "orthographic-3-view", "front-only"].includes(String(input.preset))) return invalidOperation("The automatic drawing view preset is invalid.");
      break;
    case "set-drawing-display-style":
      if (!keys(input, [...common, "style"]) || !["visible-edges", "visible-hidden-edges"].includes(String(input.style))) return invalidOperation("The drawing edge display style is invalid.");
      break;
    case "set-drawing-section-view":
      if (!keys(input, [...common, "show"]) || typeof input.show !== "boolean") return invalidOperation("The drawing section view setting is invalid.");
      break;
    case "set-drawing-drafting-standard":
      if (!keys(input, [...common, "standard"]) || !["ASME", "ISO"].includes(String(input.standard))) return invalidOperation("The drawing standard is invalid.");
      break;
    case "set-drawing-gdt":
      if (!keys(input, [...common, "show"]) || typeof input.show !== "boolean") return invalidOperation("The drawing GD&T setting is invalid.");
      break;
    case "set-drawing-datum-scheme":
      if (!keys(input, [...common, "scheme"]) || !["none", "plate-3-2-1"].includes(String(input.scheme))) return invalidOperation("The drawing datum scheme is invalid.");
      break;
    case "set-drawing-gdt-specification":
      if (!keys(input, [...common, "positionMm", "flatnessMm", "perpendicularityMm"])
        || !finiteRange(input.positionMm, 0.001, 10) || !finiteRange(input.flatnessMm, 0.001, 10)
        || !finiteRange(input.perpendicularityMm, 0.001, 10)) return invalidOperation("The explicit GD&T specification is outside the supported envelope.");
      break;
    case "set-drawing-general-tolerance":
      if (!keys(input, [...common, "linearMm", "angularDeg"]) || !finiteRange(input.linearMm, 0.001, 10) || !finiteRange(input.angularDeg, 0.01, 10)) return invalidOperation("The general drawing tolerance is outside the supported envelope.");
      break;
    case "set-drawing-notes":
      if (!keys(input, [...common, "notes"]) || typeof input.notes !== "string" || input.notes.length > 240) return invalidOperation("The drawing notes are invalid.");
      break;
    case "set-drawing-title-block":
      if (!keys(input, [...common, "drawingNumber", "revisionTag", "drawnBy", "checkedBy", "approvedBy", "organization"])
        || !shortText(input.drawingNumber, 1, 40) || !shortText(input.revisionTag, 1, 12)
        || !shortText(input.drawnBy, 0, 40) || !shortText(input.checkedBy, 0, 40) || !shortText(input.approvedBy, 0, 40)
        || !shortText(input.organization, 0, 60)) return invalidOperation("The drawing title-block fields are invalid.");
      break;
    case "apply-electrical-template":
      if (!keys(input, [...common, "template"]) || !["bess-single-line", "dc-control", "motor-starter"].includes(String(input.template))) return invalidOperation("The electrical template is invalid.");
      break;
    case "set-electrical-standard":
      if (!keys(input, [...common, "standard"]) || !["IEC", "ANSI"].includes(String(input.standard))) return invalidOperation("The electrical drafting basis is invalid.");
      break;
    case "set-electrical-component-position":
      if (!keys(input, [...common, "componentId", "position"]) || !stableId(input.componentId) || !electricalSheetPosition(input.position)) return invalidOperation("The electrical component position must remain inside the visible schematic sheet.");
      break;
    case "add-electrical-component":
      if (!keys(input, [...common, "component"]) || !validElectricalComponentPayload(input.component)) return invalidOperation("The electrical component payload is invalid.");
      break;
    case "delete-electrical-component":
      if (!keys(input, [...common, "componentId"]) || !stableId(input.componentId)) return invalidOperation("The electrical component ID is invalid.");
      break;
    case "add-electrical-net":
      if (!keys(input, [...common, "net"]) || !validElectricalNetPayload(input.net)) return invalidOperation("The electrical net payload is invalid.");
      break;
    case "delete-electrical-net":
      if (!keys(input, [...common, "netId"]) || !stableId(input.netId)) return invalidOperation("The electrical net ID is invalid.");
      break;
    case "set-electrical-notes":
      if (!keys(input, [...common, "notes"]) || typeof input.notes !== "string" || input.notes.length > 800) return invalidOperation("The electrical notes are invalid.");
      break;
    case "apply-vehicle-template":
      if (!keys(input, [...common, "template"]) || !["ice-road-motorcycle", "step-through-scooter", "ev-street-motorcycle", "delta-cargo-three-wheeler", "tadpole-geometry-three-wheeler"].includes(String(input.template))) return invalidOperation("The vehicle template is invalid.");
      break;
    case "set-vehicle-parameter":
      if (!keys(input, [...common, "parameter", "value"]) || !VEHICLE_PARAMETERS.includes(input.parameter as VehicleParameterKey) || !finite(input.value)) return invalidOperation("The vehicle parameter edit is invalid.");
      break;
    case "set-vehicle-evidence-status":
      if (!keys(input, [...common, "field", "reviewed"]) || !["input", "tire", "brake"].includes(String(input.field)) || typeof input.reviewed !== "boolean") return invalidOperation("The vehicle evidence-status edit is invalid.");
      break;
    case "set-vehicle-simulation-state":
      if (!keys(input, [...common, "state"]) || !["full-droop", "design-ride", "full-bump"].includes(String(input.state))) return invalidOperation("The vehicle suspension state is invalid.");
      break;
    case "toggle-vehicle-layer":
      if (!keys(input, [...common, "layer"]) || !VEHICLE_LAYERS.includes(input.layer as VehicleLayerId)) return invalidOperation("The vehicle layer is invalid.");
      break;
    case "generate-electromechanical-realization":
      if (!keys(input, [...common, "catalogRevision", "layoutPreset", "mappings", "replaceMode"])
        || input.catalogRevision !== ELECTROMECHANICAL_CATALOG_REVISION || !["panel-backplate", "equipment-lineup"].includes(String(input.layoutPreset))
        || input.replaceMode !== "replace-assembly" || !Array.isArray(input.mappings) || input.mappings.length < 1 || input.mappings.length > WORKBENCH_LIMITS.maxComponents
        || input.mappings.some((mapping) => !isRecord(mapping) || !keys(mapping, ["electricalComponentId", "catalogPartId"])
          || !stableId(mapping.electricalComponentId) || !stableId(mapping.catalogPartId))) return invalidOperation("The electromechanical realization request is invalid.");
      break;
    default:
      return failure("UNSUPPORTED_CAPABILITY", `Operation ${input.kind} is not supported.`, [], "Use a capability returned by ps3d_capabilities.");
  }
  return { ok: true, value: structuredClone(input) as unknown as WorkbenchOperation };
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical JSON rejects unsupported values.");
}

function applyIntent(project: WorkbenchProject, operation: WorkbenchOperation): WorkbenchResult<{
  readonly project: WorkbenchProject;
  readonly changedIds: readonly string[];
  readonly summary: string;
}> {
  switch (operation.kind) {
    case "select-workspace":
      return changed({ ...project, activeWorkspace: operation.workspace }, [project.id], `Opened ${workspaceLabel(operation.workspace)} workspace.`);
    case "add-sketch-entity": {
      if (project.sketch.entities.some((entity) => entity.id === operation.entity.id)) return invalidOperation("The sketch entity ID already exists.");
      // The cap gets its own message here, as it has in apply-sketch-edit, instead of the generic "invalid or exceeds its limits".
      if (project.sketch.entities.length >= WORKBENCH_LIMITS.maxEntities) return failure("RESOURCE_LIMIT", `The sketch already holds ${project.sketch.entities.length} curves, which is the most it can have (${WORKBENCH_LIMITS.maxEntities}).`, [project.sketch.id], "Delete curves you no longer need, or move part of the drawing into another sketch, then draw again.");
      return changed({ ...project, sketch: { ...project.sketch, entities: [...project.sketch.entities, operation.entity] } }, [operation.entity.id], `Added ${sketchEntityName({ entities: [...project.sketch.entities, operation.entity] }, operation.entity.id)}.`);
    }
    case "delete-sketch-entity": {
      if (!project.sketch.entities.some((entity) => entity.id === operation.entityId)) return missingSketchEntityFailure(project, operation.entityId, "The sketch entity does not exist.");
      const removedConstraints = project.sketch.constraints.filter((constraint) => constraint.entityIds.includes(operation.entityId));
      return changed({
        ...project,
        sketch: {
          ...project.sketch,
          entities: project.sketch.entities.filter((entity) => entity.id !== operation.entityId),
          constraints: project.sketch.constraints.filter((constraint) => !constraint.entityIds.includes(operation.entityId))
        }
      }, [operation.entityId, ...removedConstraints.map((constraint) => constraint.id)], `Deleted ${operation.entityId} and ${removedConstraints.length} dependent constraint(s).`);
    }
    case "add-sketch-constraint": {
      if (project.sketch.constraints.some((constraint) => constraint.id === operation.constraint.id)) return invalidOperation("The sketch constraint ID already exists.");
      if (project.sketch.constraints.length >= WORKBENCH_LIMITS.maxConstraints) return failure("RESOURCE_LIMIT", `The sketch already holds ${project.sketch.constraints.length} relations and dimensions, which is the most it can have (${WORKBENCH_LIMITS.maxConstraints}).`, [project.sketch.id], "Delete relations you no longer need, or relax and remove redundant ones (Validate Sketch lists them), then add this one.");
      // A relation that cannot mean anything (a horizontal circle, a radius on a line, a line parallel to itself) is refused with the reason.
      const refusal = checkNewConstraint(project, operation.constraint);
      if (refusal !== undefined) return refusal;
      const withConstraint = { ...project.sketch, constraints: [...project.sketch.constraints, operation.constraint] };
      // Enforce the relation on the geometry it touches; a conflict rejects the whole operation.
      const entityMap = new Map(withConstraint.entities.map((entity) => [entity.id, entity] as const));
      const solved = solveLiveSketch(withConstraint, operation.constraint.entityIds.filter((id) => !isSketchDatumEntityId(id)), { anchors: anchorsForConstraint(operation.constraint, entityMap, withConstraint.constraints), preserve: preserveForConstraint(operation.constraint, entityMap) });
      if (!solved.ok) return solveFailure(solved);
      // A relation that only a folded or self-crossing outline can satisfy is a contradiction (second re-audit F3).
      const folded = outlineBroken(project.sketch, { entities: solved.entities }, [...operation.constraint.entityIds, ...solved.movedIds]);
      if (folded !== undefined) {
        const explained = outlineBrokenMessage(folded, { ...withConstraint, entities: solved.entities }, operation.constraint);
        return failure("CONSTRAINT_CONFLICT", explained.message, explained.relatedIds, explained.recovery);
      }
      const overlap = solved.redundant.filter((set) => set.constraintIds.includes(operation.constraint.id));
      return changed(
        { ...project, sketch: { ...withConstraint, entities: solved.entities } },
        [operation.constraint.id, ...solved.movedIds],
        `Added ${operation.constraint.kind} constraint.${solveSummary(solved)}${overlap.length === 0 ? "" : ` Note: ${overlap[0]!.message}`}`
      );
    }
    case "delete-sketch-constraint":
      if (!project.sketch.constraints.some((constraint) => constraint.id === operation.constraintId)) return broken(operation.constraintId, "The sketch constraint does not exist.");
      return changed({ ...project, sketch: { ...project.sketch, constraints: project.sketch.constraints.filter((constraint) => constraint.id !== operation.constraintId) } }, [operation.constraintId], `Deleted constraint ${operation.constraintId}.`);
    case "set-sketch-dimension":
      return setSketchDimension(project, operation);
    case "set-sketch-dimension-label": {
      const target = project.sketch.constraints.find((constraint) => constraint.id === operation.constraintId);
      if (target === undefined) return broken(operation.constraintId, "The sketch dimension does not exist.");
      if (!hasDimensionLabel(target)) return failure("INVALID_OPERATION", `A ${target.kind} relation has no dimension text to place.`, [target.id], "Pick a dimension (a length, radius, distance or angle).");
      const labelOffsetPx = storedLabelOffsetPx(operation.offsetPx);
      // Only where the text stands changes: the geometry, the value and every relation stay exactly as they are.
      return changed(
        { ...project, sketch: { ...project.sketch, constraints: project.sketch.constraints.map((constraint) => constraint.id === target.id ? { ...constraint, labelOffsetPx } : constraint) } },
        [target.id],
        "Moved the dimension text. Its position is saved with the sketch."
      );
    }
    case "apply-sketch-edit":
      return applySketchEdit(project, operation);
    case "set-sketch-constraints-suppressed": {
      const wanted = new Set(operation.constraintIds);
      const targets = project.sketch.constraints.filter((constraint) => wanted.has(constraint.id));
      if (targets.length !== wanted.size) return broken([...wanted].find((id) => !targets.some((constraint) => constraint.id === id)) ?? project.sketch.id, "A sketch constraint to relax or restore does not exist.");
      const withFlags = {
        ...project.sketch,
        constraints: project.sketch.constraints.map((constraint) => {
          if (!wanted.has(constraint.id)) return constraint;
          const { suppressed: _previous, ...rest } = constraint;
          return operation.suppressed ? { ...rest, suppressed: true } : rest;
        })
      };
      // Restoring a relation re-enforces it; a restore that conflicts with the geometry is refused.
      const restoredMap = new Map(withFlags.entities.map((entity) => [entity.id, entity] as const));
      const solved = operation.suppressed ? undefined : solveLiveSketch(withFlags, targets.flatMap((constraint) => constraint.entityIds).filter((id) => !isSketchDatumEntityId(id)), { anchors: targets.flatMap((constraint) => anchorsForConstraint(constraint, restoredMap, withFlags.constraints)), preserve: targets.flatMap((constraint) => preserveForConstraint(constraint, restoredMap)) });
      if (solved !== undefined && !solved.ok) return solveFailure(solved);
      return changed(
        { ...project, sketch: { ...withFlags, entities: solved === undefined ? withFlags.entities : solved.entities } },
        [...wanted],
        `${operation.suppressed ? "Relaxed" : "Restored"} ${wanted.size} sketch relation${wanted.size === 1 ? "" : "s"}.${solved === undefined ? "" : solveSummary(solved)}`
      );
    }
    case "set-sketch-plane": {
      const { planeOffsetMm: _previousOffset, planeTilt: _previousTilt, planeFrame: _previousFrame, planeFace: _previousFace, planeConvention: _previousConvention, ...rest } = project.sketch;
      const offset = operation.offsetMm ?? 0;
      return changed(
        { ...project, sketch: { ...rest, plane: operation.plane, ...conventionFields(operation.plane, operation.convention, operation.frame !== undefined, project.sketch), ...(offset === 0 ? {} : { planeOffsetMm: offset }), ...(operation.tilt === undefined ? {} : { planeTilt: operation.tilt }), ...(operation.frame === undefined ? {} : { planeFrame: operation.frame }), ...(operation.face === undefined ? {} : { planeFace: operation.face }) } },
        [project.sketch.id],
        operation.frame === undefined
          ? `Placed the sketch on the ${operation.plane.replace("datum:", "").toUpperCase()} plane${offset === 0 ? "" : ` offset ${offset} mm`}${operation.tilt === undefined ? "" : ` tilted ${operation.tilt.angleDeg}° about ${operation.tilt.axis.toUpperCase()}`}.`
          : "Placed the sketch on a plane through three points."
      );
    }
    case "commit-design-sketch": return commitDesignSketch(project, operation.featureId, operation.name);
    case "edit-design-sketch": return editDesignSketch(project, operation.featureId);
    case "new-design-sketch": return newDesignSketch(project, operation.plane, operation.offsetMm ?? 0, operation.tilt, operation.frame, operation.face, operation.convention);
    case "add-design-solid": return addDesignSolid(project, operation.feature, operation.body);
    case "update-design-solid": return updateDesignSolid(project, operation.feature, operation.body);
    case "regenerate-design": return regenerateDesign(project, operation.results, operation.sketchCurves);
    case "set-design-parameters": return setDesignParameters(project, operation.parameters, operation.renames ?? [], resizeSketchEntity, operation.modelValues ?? []);
    case "set-design-feature-suppressed": return setDesignFeatureSuppressed(project, operation.featureId, operation.suppressed);
    case "delete-design-feature": return deleteDesignFeature(project, operation.featureId);
    case "set-design-rollback": return setDesignRollback(project, operation.index);
    case "move-design-feature": return moveDesignFeature(project, operation.featureId, operation.toIndex);
    case "rename-design-feature": return renameDesignFeature(project, operation.featureId, operation.name);
    case "toggle-sketch-construction": {
      const target = project.sketch.entities.find((entity) => entity.id === operation.entityId);
      if (target === undefined) return missingSketchEntityFailure(project, operation.entityId, "The sketch entity does not exist.");
      return changed({
        ...project,
        sketch: { ...project.sketch, entities: project.sketch.entities.map((entity) => entity.id === target.id ? { ...entity, construction: !entity.construction } : entity) }
      }, [target.id], `${target.construction ? "Returned" : "Converted"} ${target.id} ${target.construction ? "to profile geometry" : "to construction geometry"}.`);
    }
    case "toggle-sketch-entity-visibility": {
      const target = project.sketch.entities.find((entity) => entity.id === operation.entityId);
      if (target === undefined) return missingSketchEntityFailure(project, operation.entityId, "The sketch entity does not exist.");
      const visible = target.visible !== false;
      return changed({
        ...project,
        sketch: { ...project.sketch, entities: project.sketch.entities.map((entity) => entity.id === target.id ? { ...entity, visible: !visible } : entity) }
      }, [target.id], `${visible ? "Hid" : "Showed"} sketch entity ${target.id}.`);
    }
    case "set-part-parameter":
      return changed({ ...project, part: { ...project.part, [operation.parameter]: operation.value } }, [project.part.id], `Set ${humanize(operation.parameter)} to ${formatNumber(operation.value)}.`);
    case "add-part-preview-bodies": {
      const currentBodies = project.part.previewBodies ?? [];
      if (currentBodies.length + operation.bodies.length > 64) {
        return failure("RESOURCE_LIMIT", "The part reached its 64-body preview limit.", [project.part.id], "Delete or hide unnecessary preview bodies before creating another pattern.");
      }
      const incomingIds = new Set(operation.bodies.map((body) => body.id));
      if (incomingIds.size !== operation.bodies.length || operation.bodies.some((body) => currentBodies.some((currentBody) => currentBody.id === body.id))) {
        return invalidOperation("A preview-body ID is duplicated or already exists.");
      }
      return changed(
        { ...project, part: { ...project.part, previewBodies: [...currentBodies, ...operation.bodies] } },
        operation.bodies.map((body) => body.id),
        `Created ${operation.bodies.length} independent preview ${operation.bodies.length === 1 ? "body" : "bodies"}.`
      );
    }
    case "delete-part-preview-body": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The preview body does not exist.");
      return changed({ ...project, part: { ...project.part, previewBodies: currentBodies.filter((body) => body.id !== target.id) } }, [target.id], `Deleted preview body ${target.name}.`);
    }
    case "add-general-body": {
      const current = project.part.generalBodies ?? [];
      if (current.length >= 64) return failure("RESOURCE_LIMIT", "The part reached its general mesh-body limit.", [project.part.id], "Delete a general body before adding another.");
      if (current.some((body) => body.id === operation.body.id)) return invalidOperation("The general body ID already exists.");
      return changed({ ...project, part: { ...project.part, generalBodies: [...current, operation.body] } }, [operation.body.id], `Created ${operation.body.name}.`);
    }
    case "boolean-general-bodies": {
      const current = project.part.generalBodies ?? [];
      const target = current.find((body) => body.id === operation.targetBodyId);
      const tool = current.find((body) => body.id === operation.toolBodyId);
      if (target === undefined || tool === undefined) return broken(target === undefined ? operation.targetBodyId : operation.toolBodyId, "A general body for the Boolean does not exist.");
      const survivors = current.filter((body) => body.id !== target.id && (operation.keepTool || body.id !== tool.id));
      if (survivors.some((body) => body.id === operation.body.id)) return invalidOperation("The Boolean result body ID already exists.");
      const combined = pruneOrphanedSolidFeatures({ ...project, part: { ...project.part, generalBodies: [...survivors, operation.body] } });
      return changed(
        combined.project,
        [target.id, tool.id, operation.body.id],
        `${operation.mode === "join" ? "Joined" : operation.mode === "cut" ? "Cut" : "Intersected"} ${target.name} ${operation.mode === "cut" ? "with" : "and"} ${tool.name} into ${operation.body.name}.${combined.removed.length === 0 ? "" : ` The timeline steps of the combined solids (${combined.removed.join(", ")}) were removed; the result is an ordinary body.`}`
      );
    }
    case "delete-general-body": {
      const current = project.part.generalBodies ?? [];
      const target = current.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The general body does not exist.");
      const pruned = pruneOrphanedSolidFeatures({ ...project, part: { ...project.part, generalBodies: current.filter((body) => body.id !== target.id) } });
      return changed(pruned.project, [target.id], `Deleted ${target.name}.${pruned.removed.length === 0 ? "" : ` Its timeline step (${pruned.removed.join(", ")}) was removed with it.`}`);
    }
    case "toggle-general-body-visibility": {
      const current = project.part.generalBodies ?? [];
      const target = current.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The general body does not exist.");
      return changed({ ...project, part: { ...project.part, generalBodies: current.map((body) => body.id === target.id ? { ...body, visible: !body.visible } : body) } }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "rename-general-body": {
      const current = project.part.generalBodies ?? [];
      const target = current.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The general body does not exist.");
      const name = operation.name.trim();
      const clash = current.find((body) => body.id !== target.id && body.name.trim().toLowerCase() === name.toLowerCase());
      if (clash !== undefined) return failure("INVALID_OPERATION", `Another body is already called "${clash.name}", and two bodies cannot share a name.`, [target.id, clash.id], `Choose a different name, for example "${uniqueBodyName(current.filter((body) => body.id !== target.id).map((body) => body.name), name)}".`);
      return changed({ ...project, part: { ...project.part, generalBodies: current.map((body) => body.id === target.id ? { ...body, name } : body) } }, [target.id], `Renamed ${target.name} to ${name}.`);
    }
    case "modify-general-body": {
      const current = project.part.generalBodies ?? [];
      const target = current.find((body) => body.id === operation.targetBodyId);
      if (target === undefined) return broken(operation.targetBodyId, "The general body being modified does not exist.");
      if (operation.body.id !== operation.targetBodyId) return invalidOperation("A modify result must keep the target body's ID.");
      // HS-04: a solid made by timeline steps is rebuilt from them, so a hole, fillet, chamfer or shell swapped into its mesh would silently
      // vanish at the next rebuild (a sketch edit, a suppress, a rollback). Those are recorded as timeline steps instead.
      const owner = project.design === undefined ? undefined : baseFeatureOf(project.design, target.id);
      if (owner !== undefined && TIMELINE_ONLY_MODIFIERS.has(operation.modifier)) {
        return failure("INVALID_OPERATION",
          `${target.name} is built by the timeline (${owner.name}), so a ${operation.modifier} applied straight to its mesh would be lost at the next rebuild.`,
          [target.id, owner.id],
          "Use the Hole, Fillet, Chamfer or Shell command on the body: it records the change as a timeline step that survives rebuilds and can be edited, suppressed or rolled back.");
      }
      const next = current.map((body) => body.id === target.id ? { ...operation.body, visible: body.visible } : body);
      return changed({ ...project, part: { ...project.part, generalBodies: next } }, [target.id], `${operation.label} on ${target.name}.`);
    }
    case "add-construction-plane": {
      const current = project.part.construction ?? [];
      if (current.length >= 64) return failure("RESOURCE_LIMIT", "The part reached its construction-plane limit.", [project.part.id], "Delete a construction plane before adding another.");
      if (current.some((plane) => plane.id === operation.plane.id)) return invalidOperation("The construction-plane ID already exists.");
      const needs = planeDependencies(operation.plane.definition);
      const missingAxis = needs.axisIds.find((id) => !(project.part.constructionAxes ?? []).some((axis) => axis.id === id));
      if (missingAxis !== undefined) return broken(operation.plane.id, "The construction axis this plane is built on does not exist.");
      const missingBinder = needs.binderIds.find((id) => !(project.part.constructionBinders ?? []).some((binder) => binder.id === id));
      if (missingBinder !== undefined) return broken(operation.plane.id, "The binder this plane is built on does not exist.");
      const missingBody = needs.bodyIds.find((id) => !(project.part.generalBodies ?? []).some((body) => body.id === id));
      if (missingBody !== undefined) return broken(operation.plane.id, "The body this plane's edge was picked on does not exist.");
      return changed({ ...project, part: { ...project.part, construction: [...current, operation.plane] } }, [operation.plane.id], `Created ${operation.plane.name}.`);
    }
    case "delete-construction-plane": {
      const current = project.part.construction ?? [];
      const target = current.find((plane) => plane.id === operation.planeId);
      if (target === undefined) return broken(operation.planeId, "The construction plane does not exist.");
      return changed({ ...project, part: { ...project.part, construction: current.filter((plane) => plane.id !== target.id) } }, [target.id], `Deleted ${target.name}.`);
    }
    case "toggle-construction-plane-visibility": {
      const current = project.part.construction ?? [];
      const target = current.find((plane) => plane.id === operation.planeId);
      if (target === undefined) return broken(operation.planeId, "The construction plane does not exist.");
      return changed({ ...project, part: { ...project.part, construction: current.map((plane) => plane.id === target.id ? { ...plane, visible: !plane.visible } : plane) } }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "rename-construction-plane": {
      const current = project.part.construction ?? [];
      const target = current.find((plane) => plane.id === operation.planeId);
      if (target === undefined) return broken(operation.planeId, "The construction plane does not exist.");
      return changed({ ...project, part: { ...project.part, construction: current.map((plane) => plane.id === target.id ? { ...plane, name: operation.name } : plane) } }, [target.id], `Renamed ${target.name} to ${operation.name}.`);
    }
    case "add-construction-binder": {
      const current = project.part.constructionBinders ?? [];
      if (current.length >= 128) return failure("RESOURCE_LIMIT", "The part reached its construction-binder limit.", [project.part.id], "Delete a binder before adding another.");
      if (current.some((binder) => binder.id === operation.binder.id)) return invalidOperation("The construction-binder ID already exists.");
      if (![...(project.part.generalBodies ?? []), ...(project.part.previewBodies ?? [])].some((body) => body.id === operation.binder.target.bodyId)) return broken(operation.binder.id, "The body this binder points at does not exist.");
      return changed({ ...project, part: { ...project.part, constructionBinders: [...current, operation.binder] } }, [operation.binder.id], `Created ${operation.binder.name}.`);
    }
    case "delete-construction-binder": {
      const current = project.part.constructionBinders ?? [];
      const target = current.find((binder) => binder.id === operation.binderId);
      if (target === undefined) return broken(operation.binderId, "The construction binder does not exist.");
      const stillUsed = (project.part.construction ?? []).some((plane) => planeDependencies(plane.definition).binderIds.includes(target.id));
      if (stillUsed) return failure("BROKEN_REFERENCE", `${target.name} is used by a construction plane.`, [target.id], "Delete the construction plane that uses this binder first.");
      return changed({ ...project, part: { ...project.part, constructionBinders: current.filter((binder) => binder.id !== target.id) } }, [target.id], `Deleted ${target.name}.`);
    }
    case "toggle-construction-binder-visibility": {
      const current = project.part.constructionBinders ?? [];
      const target = current.find((binder) => binder.id === operation.binderId);
      if (target === undefined) return broken(operation.binderId, "The construction binder does not exist.");
      return changed({ ...project, part: { ...project.part, constructionBinders: current.map((binder) => binder.id === target.id ? { ...binder, visible: !binder.visible } : binder) } }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "add-construction-axis": {
      const current = project.part.constructionAxes ?? [];
      if (current.length >= 64) return failure("RESOURCE_LIMIT", "The part reached its construction-axis limit.", [project.part.id], "Delete a construction axis before adding another.");
      if (current.some((axis) => axis.id === operation.axis.id)) return invalidOperation("The construction-axis ID already exists.");
      return changed({ ...project, part: { ...project.part, constructionAxes: [...current, operation.axis] } }, [operation.axis.id], `Created ${operation.axis.name}.`);
    }
    case "delete-construction-axis": {
      const current = project.part.constructionAxes ?? [];
      const target = current.find((axis) => axis.id === operation.axisId);
      if (target === undefined) return broken(operation.axisId, "The construction axis does not exist.");
      // Dependent construction points referring to this axis lose their binding; drop them to keep the project valid.
      const dependents = (project.part.constructionPoints ?? []).filter((point) => point.definition.kind !== "axis-plane-intersection" || point.definition.axisId !== target.id);
      return changed({ ...project, part: { ...project.part, constructionAxes: current.filter((axis) => axis.id !== target.id), constructionPoints: dependents } }, [target.id], `Deleted ${target.name}.`);
    }
    case "toggle-construction-axis-visibility": {
      const current = project.part.constructionAxes ?? [];
      const target = current.find((axis) => axis.id === operation.axisId);
      if (target === undefined) return broken(operation.axisId, "The construction axis does not exist.");
      return changed({ ...project, part: { ...project.part, constructionAxes: current.map((axis) => axis.id === target.id ? { ...axis, visible: !axis.visible } : axis) } }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "rename-construction-axis": {
      const current = project.part.constructionAxes ?? [];
      const target = current.find((axis) => axis.id === operation.axisId);
      if (target === undefined) return broken(operation.axisId, "The construction axis does not exist.");
      return changed({ ...project, part: { ...project.part, constructionAxes: current.map((axis) => axis.id === target.id ? { ...axis, name: operation.name } : axis) } }, [target.id], `Renamed ${target.name} to ${operation.name}.`);
    }
    case "add-construction-point": {
      const current = project.part.constructionPoints ?? [];
      if (current.length >= 128) return failure("RESOURCE_LIMIT", "The part reached its construction-point limit.", [project.part.id], "Delete a construction point before adding another.");
      if (current.some((point) => point.id === operation.point.id)) return invalidOperation("The construction-point ID already exists.");
      if (operation.point.definition.kind === "axis-plane-intersection" && !(project.part.constructionAxes ?? []).some((axis) => axis.id === (operation.point.definition as { readonly axisId: string }).axisId)) {
        return broken(operation.point.id, "The construction axis this point is built on does not exist.");
      }
      return changed({ ...project, part: { ...project.part, constructionPoints: [...current, operation.point] } }, [operation.point.id], `Created ${operation.point.name}.`);
    }
    case "delete-construction-point": {
      const current = project.part.constructionPoints ?? [];
      const target = current.find((point) => point.id === operation.pointId);
      if (target === undefined) return broken(operation.pointId, "The construction point does not exist.");
      return changed({ ...project, part: { ...project.part, constructionPoints: current.filter((point) => point.id !== target.id) } }, [target.id], `Deleted ${target.name}.`);
    }
    case "toggle-construction-point-visibility": {
      const current = project.part.constructionPoints ?? [];
      const target = current.find((point) => point.id === operation.pointId);
      if (target === undefined) return broken(operation.pointId, "The construction point does not exist.");
      return changed({ ...project, part: { ...project.part, constructionPoints: current.map((point) => point.id === target.id ? { ...point, visible: !point.visible } : point) } }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "rename-construction-point": {
      const current = project.part.constructionPoints ?? [];
      const target = current.find((point) => point.id === operation.pointId);
      if (target === undefined) return broken(operation.pointId, "The construction point does not exist.");
      return changed({ ...project, part: { ...project.part, constructionPoints: current.map((point) => point.id === target.id ? { ...point, name: operation.name } : point) } }, [target.id], `Renamed ${target.name} to ${operation.name}.`);
    }
    case "add-construction-ucs": {
      const current = project.part.constructionUcses ?? [];
      if (current.some((ucs) => ucs.id === operation.ucs.id)) return invalidOperation("A construction UCS with this ID already exists.");
      return changed({ ...project, part: { ...project.part, constructionUcses: [...current, operation.ucs] } }, [operation.ucs.id], `Created ${operation.ucs.name}.`);
    }
    case "delete-construction-ucs": {
      const current = project.part.constructionUcses ?? [];
      const target = current.find((ucs) => ucs.id === operation.ucsId);
      if (target === undefined) return broken(operation.ucsId, "The construction UCS does not exist.");
      return changed({ ...project, part: { ...project.part, constructionUcses: current.filter((ucs) => ucs.id !== target.id) } }, [target.id], `Deleted ${target.name}.`);
    }
    case "toggle-construction-ucs-visibility": {
      const current = project.part.constructionUcses ?? [];
      const target = current.find((ucs) => ucs.id === operation.ucsId);
      if (target === undefined) return broken(operation.ucsId, "The construction UCS does not exist.");
      return changed({ ...project, part: { ...project.part, constructionUcses: current.map((ucs) => ucs.id === target.id ? { ...ucs, visible: !ucs.visible } : ucs) } }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "rename-construction-ucs": {
      const current = project.part.constructionUcses ?? [];
      const target = current.find((ucs) => ucs.id === operation.ucsId);
      if (target === undefined) return broken(operation.ucsId, "The construction UCS does not exist.");
      return changed({ ...project, part: { ...project.part, constructionUcses: current.map((ucs) => ucs.id === target.id ? { ...ucs, name: operation.name } : ucs) } }, [target.id], `Renamed ${target.name} to ${operation.name}.`);
    }
    case "set-part-preview-body-transform": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The preview body does not exist.");
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => body.id === target.id ? { ...body, translationMm: operation.translationMm, rotationDeg: operation.rotationDeg } : body) }
      }, [target.id], `Moved ${target.name} to ${operation.translationMm.map(formatNumber).join(", ")} mm.`);
    }
    case "set-part-preview-body-size": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The preview body does not exist.");
      const resized = normalizePartPreviewSize(target.shape, operation.sizeMm);
      if (resized === undefined) return invalidOperation(`The ${target.shape} size tuple is invalid.`);
      const nextParams = operation.primitiveParams ?? target.primitiveParams;
      const resizedBody: PartPreviewBody = { ...target, sizeMm: resized, ...(nextParams === undefined ? {} : { primitiveParams: nextParams }) };
      if (!validPrimitiveBody(resizedBody)) return invalidOperation(`The ${target.shape} parameters are invalid.`);
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => body.id === target.id ? resizedBody : body) }
      }, [target.id], `Resized ${target.name} to ${resized.map(formatNumber).join(" × ")} mm.`);
    }
    case "set-part-preview-body-color": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The preview body does not exist.");
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => body.id === target.id ? { ...body, color: operation.color.toLowerCase() } : body) }
      }, [target.id], `Changed ${target.name} appearance to ${operation.color.toLowerCase()}.`);
    }
    case "toggle-part-preview-body-visibility": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The preview body does not exist.");
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => body.id === target.id ? { ...body, visible: !body.visible } : body) }
      }, [target.id], `${target.visible ? "Hid" : "Showed"} ${target.name}.`);
    }
    case "isolate-part-preview-body": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The preview body does not exist.");
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => ({ ...body, visible: body.id === target.id })) }
      }, currentBodies.map((body) => body.id), `Isolated ${target.name}; the qualified base body remains visible.`);
    }
    case "set-part-preview-bodies-visibility": {
      const currentBodies = project.part.previewBodies ?? [];
      if (currentBodies.every((body) => body.visible === operation.visible)) return changed(project, [], `All independent preview bodies are already ${operation.visible ? "shown" : "hidden"}.`);
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => ({ ...body, visible: operation.visible })) }
      }, currentBodies.map((body) => body.id), `${operation.visible ? "Showed" : "Hid"} all independent preview bodies.`);
    }
    case "create-part-revolve": {
      const currentBodies = project.part.previewBodies ?? [];
      if (currentBodies.length >= 64) return failure("RESOURCE_LIMIT", "The part reached its 64-body preview limit.", [project.part.id], "Delete an unused body before creating the revolve.");
      if (currentBodies.some((body) => body.id === operation.bodyId)) return invalidOperation("The revolved body ID already exists.");
      const result = createRevolvedPartBody({ ...operation });
      if (!result.ok) return partFeatureFailure(result);
      return changed({ ...project, part: { ...project.part, previewBodies: [...currentBodies, result.value] } }, [result.value.id], `Revolved ${result.value.name} through ${formatNumber(operation.angleDeg)}° as a closed analytic body.`);
    }
    case "pattern-part-feature": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The pattern seed body does not exist.");
      if (currentBodies.length + operation.instanceIds.length > 64) return failure("RESOURCE_LIMIT", "The feature pattern exceeds the 64-body preview limit.", [target.id], "Reduce the instance count or delete unused bodies.");
      if (operation.instanceIds.some((id) => currentBodies.some((body) => body.id === id))) return invalidOperation("A feature-pattern instance ID already exists.");
      const result = patternPartBody({ operationId: operation.operationId, body: target, instanceIds: operation.instanceIds, direction: operation.direction, spacingMm: operation.spacingMm });
      if (!result.ok) return partFeatureFailure(result);
      return changed({ ...project, part: { ...project.part, previewBodies: [...currentBodies, ...result.value] } }, [target.id, ...result.value.map((body) => body.id)], `Patterned ${target.name} into ${result.value.length + 1} analytic instances along ${operation.direction.toUpperCase()}.`);
    }
    case "mirror-part-feature": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The mirror seed body does not exist.");
      if (currentBodies.some((body) => body.id === operation.newBodyId)) return invalidOperation("The mirrored body ID already exists.");
      if (currentBodies.length >= 64) return failure("RESOURCE_LIMIT", "The part reached its 64-body preview limit.", [target.id], "Delete an unused body before mirroring.");
      const result = mirrorPartBody({ operationId: operation.operationId, body: target, newBodyId: operation.newBodyId, plane: operation.plane });
      if (!result.ok) return partFeatureFailure(result);
      return changed({ ...project, part: { ...project.part, previewBodies: [...currentBodies, result.value] } }, [target.id, result.value.id], `Mirrored ${target.name} across the global ${operation.plane.toUpperCase()} plane.`);
    }
    case "boolean-part-bodies": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.targetBodyId);
      const tool = currentBodies.find((body) => body.id === operation.toolBodyId);
      if (target === undefined) return broken(operation.targetBodyId, "The Boolean target body does not exist.");
      if (tool === undefined) return broken(operation.toolBodyId, "The Boolean tool body does not exist.");
      const result = booleanPartBodies({ operationId: operation.operationId, target, tool, operation: operation.operation });
      if (!result.ok) return partFeatureFailure(result);
      const nextBodies = currentBodies.filter((body) => body.id !== tool.id).map((body) => body.id === target.id ? result.value : body);
      return changed({ ...project, part: { ...project.part, previewBodies: nextBodies } }, [target.id, tool.id], `${operation.operation === "unite" ? "United" : "Subtracted"} ${tool.name} ${operation.operation === "unite" ? "with" : "from"} ${target.name}; the consumed tool body was removed.`);
    }
    case "trim-part-body": {
      const currentBodies = project.part.previewBodies ?? [];
      const target = currentBodies.find((body) => body.id === operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The trim target body does not exist.");
      const result = trimPartBody({ operationId: operation.operationId, body: target, keptLengthMm: operation.keptLengthMm, side: operation.side });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `Trimmed ${target.name}; kept the local ${operation.side} ${formatNumber(operation.keptLengthMm)} mm region.`);
    }
    case "set-part-body-edge-treatment": {
      const target = findPartBody(project, operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The edge-treatment target body does not exist.");
      const result = setPartBodyEdgeTreatment({ operationId: operation.operationId, body: target, treatment: operation.treatment, sizeMm: operation.sizeMm });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `Applied ${formatNumber(operation.sizeMm)} mm ${operation.treatment} to the four supported vertical edges of ${target.name}.`);
    }
    case "set-part-body-draft": {
      const target = findPartBody(project, operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The draft target body does not exist.");
      const result = setPartBodyDraft({ operationId: operation.operationId, body: target, angleDeg: operation.angleDeg });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `Drafted ${target.name} by ${formatNumber(operation.angleDeg)}° along local Z.`);
    }
    case "set-part-body-shell": {
      const target = findPartBody(project, operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The shell target body does not exist.");
      const result = setPartBodyShell({ operationId: operation.operationId, body: target, thicknessMm: operation.thicknessMm });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `Shelled ${target.name} to ${formatNumber(operation.thicknessMm)} mm and removed its local +Z face.`);
    }
    case "move-part-body-face": {
      const target = findPartBody(project, operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The face-edit target body does not exist.");
      const result = movePartBodyFace({ operationId: operation.operationId, body: target, face: operation.face, offsetMm: operation.offsetMm });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `${operation.mode === "move" ? "Moved" : "Offset"} ${operation.face} of ${target.name} outward by ${formatNumber(operation.offsetMm)} mm.`);
    }
    case "replace-part-body-face": {
      const target = findPartBody(project, operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The replace-face target body does not exist.");
      const result = replacePartBodyFace({ operationId: operation.operationId, body: target, face: operation.face, localPositionMm: operation.localPositionMm });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `Replaced ${operation.face} of ${target.name} at local coordinate ${formatNumber(operation.localPositionMm)} mm.`);
    }
    case "delete-part-body-face": {
      const target = findPartBody(project, operation.bodyId);
      if (target === undefined) return broken(operation.bodyId, "The delete-face target body does not exist.");
      const result = deletePartBodyFaceFeature({ operationId: operation.operationId, body: target, feature: operation.feature });
      if (!result.ok) return partFeatureFailure(result);
      return changed(replacePartBody(project, result.value), [target.id], `Deleted and healed the recognized ${operation.feature} face set on ${target.name}.`);
    }
    case "update-part-model": {
      const currentBodies = project.part.previewBodies ?? [];
      for (const body of currentBodies) {
        const result = validatePartFeatureStack(body);
        if (!result.ok) return partFeatureFailure(result);
      }
      const serial = (project.part.modelUpdateSerial ?? 0) + 1;
      return changed({ ...project, part: { ...project.part, modelUpdateSerial: serial } }, [project.part.id, ...currentBodies.map((body) => body.id)], `Updated and revalidated ${currentBodies.length} analytic preview ${currentBodies.length === 1 ? "body" : "bodies"} (model update ${serial}).`);
    }
    case "set-assembly-explode":
      return changed({ ...project, assembly: { ...project.assembly, explodeMm: operation.valueMm } }, [project.assembly.id], `Set exploded distance to ${formatNumber(operation.valueMm)} mm.`);
    case "apply-assembly-template": { 
      const assembly = operation.template === "bess-20ft-hc" ? createBessContainerAssembly() : createCargoContainerAssembly(operation.template);
      return changed({ ...project, assembly }, [assembly.id, ...assembly.components.map((component) => component.id), ...assembly.mates.map((mate) => mate.id)], `Generated ${assembly.name} as an editable, non-certified planning assembly.`);
    }
    case "add-assembly-component": {
      if (project.assembly.components.length >= WORKBENCH_LIMITS.maxComponents) {
        return failure("RESOURCE_LIMIT", `The assembly reached its ${WORKBENCH_LIMITS.maxComponents}-component preview limit.`, [project.assembly.id], "Delete a component before inserting another one.");
      }
      if (project.assembly.components.some((component) => component.id === operation.component.id)) return invalidOperation("The assembly component ID already exists.");
      const addSource = project.assembly.electromechanicalSource;
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: [...project.assembly.components, operation.component],
          ...(addSource === undefined ? {} : { electromechanicalSource: { ...addSource, status: "stale" as const } })
        }
      }, [operation.component.id], `Inserted ${operation.component.name}.`);
    }
    case "add-assembly-components": {
      if (project.assembly.components.length + operation.components.length > WORKBENCH_LIMITS.maxComponents) {
        return failure("RESOURCE_LIMIT", `This grouped item needs ${operation.components.length} preview bodies, but the assembly limit is ${WORKBENCH_LIMITS.maxComponents}.`, [project.assembly.id], "Delete unused components or choose a simpler catalog item before inserting it.");
      }
      const existingIds = new Set(project.assembly.components.map((component) => component.id));
      if (operation.components.some((component) => existingIds.has(component.id))) return invalidOperation("A grouped assembly component ID already exists.");
      const label = operation.components[0]?.masterCart?.templateId.replaceAll("-", " ") ?? `${operation.components.length}-body item`;
      const addGroupSource = project.assembly.electromechanicalSource;
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: [...project.assembly.components, ...operation.components],
          ...(addGroupSource === undefined ? {} : { electromechanicalSource: { ...addGroupSource, status: "stale" as const } })
        }
      }, operation.components.map((component) => component.id), `Inserted ${label} as one grouped ${operation.components.length}-body Master Cart item.`);
    }
    case "delete-assembly-component": {
      const target = project.assembly.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The assembly component does not exist.");
      if (project.assembly.electromechanicalSource !== undefined && target.id.startsWith("component:em-")) {
        return invalidOperation("A generated panel package or mounting-infrastructure body cannot be deleted directly. Regenerate from the source schematic or replace the complete assembly through the reviewed workflow.");
      }
      const removedIds = new Set(target.masterCart === undefined
        ? [operation.componentId]
        : project.assembly.components.filter((component) => component.masterCart?.instanceId === target.masterCart?.instanceId).map((component) => component.id));
      if (project.assembly.components.length - removedIds.size < 1) return invalidOperation("An assembly must retain at least one component.");
      const removedMates = project.assembly.mates.filter((mate) => mate.componentIds.some((componentId) => removedIds.has(componentId)));
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: project.assembly.components.filter((component) => !removedIds.has(component.id)),
          mates: project.assembly.mates.filter((mate) => !mate.componentIds.some((componentId) => removedIds.has(componentId)))
        }
      }, [...removedIds, ...removedMates.map((mate) => mate.id)], `Deleted ${target.masterCart === undefined ? target.name : `${target.masterCart.templateId.replaceAll("-", " ")} grouped item (${removedIds.size} bodies)`} and ${removedMates.length} dependent mate(s).`);
    }
    case "set-component-translation": {
      const target = project.assembly.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The assembly component does not exist.");
      const source = project.assembly.electromechanicalSource;
      const delta: readonly [number, number, number] = [operation.translationMm[0] - target.translationMm[0], operation.translationMm[1] - target.translationMm[1], operation.translationMm[2] - target.translationMm[2]];
      const movedIds = project.assembly.components.filter((component) => target.masterCart === undefined ? component.id === target.id : component.masterCart?.instanceId === target.masterCart.instanceId).map((component) => component.id);
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: project.assembly.components.map((component) => movedIds.includes(component.id) ? { ...component, translationMm: [component.translationMm[0] + delta[0], component.translationMm[1] + delta[1], component.translationMm[2] + delta[2]] } : component),
          ...(source === undefined ? {} : { electromechanicalSource: { ...source, status: "stale" as const } })
        }
      }, movedIds, `Moved ${target.masterCart === undefined ? target.name : `${target.masterCart.templateId.replaceAll("-", " ")} grouped item`} to ${operation.translationMm.map(formatNumber).join(", ")} mm.`);
    }
    case "toggle-component-grounded": {
      const target = project.assembly.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The assembly component does not exist.");
      const source = project.assembly.electromechanicalSource;
      const groupedIds = project.assembly.components.filter((component) => target.masterCart === undefined ? component.id === target.id : component.masterCart?.instanceId === target.masterCart.instanceId).map((component) => component.id);
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: project.assembly.components.map((component) => groupedIds.includes(component.id) ? { ...component, grounded: !target.grounded } : component),
          ...(source === undefined ? {} : { electromechanicalSource: { ...source, status: "stale" as const } })
        }
      }, groupedIds, `${target.grounded ? "Released" : "Grounded"} ${target.masterCart === undefined ? target.name : `${target.masterCart.templateId.replaceAll("-", " ")} grouped item`}.`);
    }
    case "toggle-component-visibility": {
      const target = project.assembly.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The assembly component does not exist.");
      const source = project.assembly.electromechanicalSource;
      const groupedIds = project.assembly.components.filter((component) => target.masterCart === undefined ? component.id === target.id : component.masterCart?.instanceId === target.masterCart.instanceId).map((component) => component.id);
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: project.assembly.components.map((component) => groupedIds.includes(component.id) ? { ...component, visible: !target.visible } : component),
          ...(source === undefined ? {} : { electromechanicalSource: { ...source, status: "stale" as const } })
        }
      }, groupedIds, `${target.visible ? "Hid" : "Showed"} ${target.masterCart === undefined ? target.name : `${target.masterCart.templateId.replaceAll("-", " ")} grouped item`}.`);
    }
    case "add-assembly-mate": {
      if (project.assembly.mates.length >= WORKBENCH_LIMITS.maxMates) return failure("RESOURCE_LIMIT", "The assembly reached its mate-record limit.", [project.assembly.id], "Delete an unused mate before creating another one.");
      if (project.assembly.mates.some((mate) => mate.id === operation.mate.id)) return invalidOperation("The assembly mate ID already exists.");
      const componentIds = new Set(project.assembly.components.map((component) => component.id));
      if (operation.mate.componentIds.some((componentId) => !componentIds.has(componentId))) return invalidOperation("The assembly mate references a missing component.");
      if (new Set(operation.mate.componentIds).size !== operation.mate.componentIds.length) return invalidOperation("A mate cannot reference the same component twice.");
      const addMateSource = project.assembly.electromechanicalSource;
      // The mate is enforced when it is created: the second component moves onto the first (grounded parts never move).
      const solved = solveAssemblyMates({ ...project.assembly, mates: [...project.assembly.mates, operation.mate] }, { move: true });
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: solved.components,
          mates: solved.mates,
          ...(addMateSource === undefined || solved.movedIds.length === 0 ? {} : { electromechanicalSource: { ...addMateSource, status: "stale" as const } })
        }
      }, [operation.mate.id, ...operation.mate.componentIds, ...solved.movedIds], `Created ${operation.mate.name}.${solved.notes.length === 0 ? "" : ` ${solved.notes.join("; ")}.`}${solved.mates.find((mate) => mate.id === operation.mate.id)?.status === "conflict" ? " It conflicts with another mate or a grounded part, so nothing was moved." : ""}`);
    }
    case "solve-assembly-mates": {
      const solveSource = project.assembly.electromechanicalSource;
      const solved = solveAssemblyMates(project.assembly, { move: true });
      return changed({
        ...project,
        assembly: {
          ...project.assembly,
          components: solved.components,
          mates: solved.mates,
          ...(solveSource === undefined || solved.movedIds.length === 0 ? {} : { electromechanicalSource: { ...solveSource, status: "stale" as const } })
        }
      }, solved.movedIds.length === 0 ? [project.assembly.id] : solved.movedIds, solved.notes.length === 0 ? "Solved mates: every satisfiable mate was already in place." : `Solved mates. ${solved.notes.join("; ")}.`);
    }
    case "delete-assembly-mate": {
      const target = project.assembly.mates.find((mate) => mate.id === operation.mateId);
      if (target === undefined) return broken(operation.mateId, "The assembly mate does not exist.");
      if (project.assembly.electromechanicalSource !== undefined && target.id.startsWith("mate:em-")) return invalidOperation("Generated electromechanical mates must be replaced through the reviewed realization workflow.");
      return changed({ ...project, assembly: { ...project.assembly, mates: project.assembly.mates.filter((mate) => mate.id !== target.id) } }, [target.id], `Deleted mate ${target.name}.`);
    }
    case "set-surface-mode":
      return changed({ ...project, surface: { ...project.surface, mode: operation.mode } }, [project.surface.id], `Switched to ${operation.mode === "bezier" ? "bicubic Bézier" : "blended loft"} preview.`);
    case "set-surface-parameter": {
      const descriptor = SURFACE_PARAMETER_LABELS[operation.parameter];
      return changed({ ...project, surface: { ...project.surface, [operation.parameter]: operation.value } }, [project.surface.id], `Set ${descriptor.label} to ${formatNumber(operation.value)}${descriptor.unit}.`);
    }
    case "apply-surface-preset": {
      const preset = operation.preset === "flatten" ? { crownMm: 0, twistDeg: 0 } : { crownMm: 22, twistDeg: 12 };
      return changed({ ...project, surface: { ...project.surface, ...preset } }, [project.surface.id], operation.preset === "flatten" ? "Applied the flat (C0) surface preset." : "Applied the crowned canopy surface preset.");
    }
    case "set-drawing-sheet":
      return changed({ ...project, drawing: { ...project.drawing, sheet: operation.sheet } }, [project.drawing.id], `Changed sheet to ${operation.sheet}.`);
    case "set-drawing-projection":
      return changed({ ...project, drawing: { ...project.drawing, projection: operation.projection } }, [project.drawing.id], `Changed projection to ${operation.projection}.`);
    case "set-drawing-scale":
      return changed({ ...project, drawing: { ...project.drawing, scale: operation.scale } }, [project.drawing.id], `Changed drawing scale to 1:${operation.scale}.`);
    case "set-drawing-dimensions":
      return changed({ ...project, drawing: { ...project.drawing, showDimensions: operation.show } }, [project.drawing.id], `${operation.show ? "Shown" : "Hidden"} drawing dimensions.`);
    case "set-drawing-view-preset":
      return changed({ ...project, drawing: { ...project.drawing, viewPreset: operation.preset } }, [project.drawing.id], `Generated the ${operation.preset.replaceAll("-", " ")} layout.`);
    case "set-drawing-display-style":
      return changed({ ...project, drawing: { ...project.drawing, displayStyle: operation.style } }, [project.drawing.id], `Changed drawing edges to ${operation.style.replaceAll("-", " ")}.`);
    case "set-drawing-section-view":
      return changed({ ...project, drawing: { ...project.drawing, showSectionView: operation.show } }, [project.drawing.id], `${operation.show ? "Generated" : "Removed"} section A-A.`);
    case "set-drawing-drafting-standard":
      return changed({ ...project, drawing: { ...project.drawing, draftingStandard: operation.standard, projection: operation.standard === "ASME" ? "third-angle" : "first-angle" } }, [project.drawing.id], `Set the drafting basis to ${operation.standard} with its conventional projection default.`);
    case "set-drawing-gdt":
      return changed({ ...project, drawing: { ...project.drawing, showGdt: operation.show } }, [project.drawing.id], `${operation.show ? "Shown" : "Hidden"} explicitly configured datum and GD&T annotations.`);
    case "set-drawing-datum-scheme": {
      const enablesGdt = operation.scheme === "plate-3-2-1" && !project.drawing.showGdt;
      const datumSummary = operation.scheme === "none"
        ? "Set datum scheme to none."
        : enablesGdt
          ? "Set datum scheme to plate 3-2-1 draft and enabled feature-control frames."
          : "Set datum scheme to plate 3-2-1 draft.";
      return changed({ ...project, drawing: { ...project.drawing, datumScheme: operation.scheme, ...(operation.scheme === "plate-3-2-1" ? { showGdt: true } : {}) } }, [project.drawing.id], datumSummary);
    }
    case "set-drawing-gdt-specification":
      return changed({ ...project, drawing: { ...project.drawing, gdtPositionToleranceMm: operation.positionMm, gdtFlatnessToleranceMm: operation.flatnessMm, gdtPerpendicularityToleranceMm: operation.perpendicularityMm } }, [project.drawing.id], "Updated explicit GD&T values without changing the general tolerance.");
    case "set-drawing-general-tolerance":
      return changed({ ...project, drawing: { ...project.drawing, generalToleranceLinearMm: operation.linearMm, generalToleranceAngularDeg: operation.angularDeg } }, [project.drawing.id], `Set the general tolerance to ±${formatNumber(operation.linearMm)} mm and ±${formatNumber(operation.angularDeg)}°.`);
    case "set-drawing-notes":
      return changed({ ...project, drawing: { ...project.drawing, notes: operation.notes } }, [project.drawing.id], "Updated drawing notes.");
    case "set-drawing-title-block":
      return changed({ ...project, drawing: { ...project.drawing, drawingNumber: operation.drawingNumber, revisionTag: operation.revisionTag, drawnBy: operation.drawnBy, checkedBy: operation.checkedBy, approvedBy: operation.approvedBy, organization: operation.organization } }, [project.drawing.id], `Updated title block ${operation.drawingNumber} rev ${operation.revisionTag}.`);
    case "apply-electrical-template": {
      const electrical = createElectricalTemplate(operation.template, project.electrical.standard);
      return changed(markElectromechanicalStale(project, electrical), [electrical.id, ...electrical.components.map((component) => component.id), ...electrical.nets.map((net) => net.id)], `Generated ${electrical.title} with connected nets and a fresh electrical rule check.`);
    }
    case "set-electrical-standard":
      return changed(markElectromechanicalStale(project, { ...project.electrical, standard: operation.standard }), [project.electrical.id], `Set electrical symbol basis to ${operation.standard}.`);
    case "set-electrical-component-position": {
      const target = project.electrical.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The electrical component does not exist.");
      const electrical = { ...project.electrical, components: project.electrical.components.map((component) => component.id === target.id ? { ...component, position: operation.position } : component) };
      return changed(markElectromechanicalStale(project, electrical), [target.id], `Moved ${target.reference} to ${operation.position.map(formatNumber).join(", ")} on the schematic sheet.`);
    }
    case "add-electrical-component": {
      if (project.electrical.components.length >= WORKBENCH_LIMITS.maxComponents) return failure("RESOURCE_LIMIT", "The electrical sheet reached its component limit.", [project.electrical.id], "Delete a component before inserting another one.");
      if (project.electrical.components.some((component) => component.id === operation.component.id)) return invalidOperation("The electrical component ID already exists.");
      const electrical = { ...project.electrical, components: [...project.electrical.components, operation.component] };
      return changed(markElectromechanicalStale(project, electrical), [operation.component.id], `Inserted ${operation.component.reference} ${operation.component.label}.`);
    }
    case "delete-electrical-component": {
      const target = project.electrical.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The electrical component does not exist.");
      if (project.electrical.components.length === 1) return invalidOperation("An electrical sheet must retain at least one component.");
      const removedNets = project.electrical.nets.filter((net) => net.endpoints.some((endpoint) => endpoint.componentId === operation.componentId));
      const electrical = { ...project.electrical, components: project.electrical.components.filter((component) => component.id !== operation.componentId), nets: project.electrical.nets.filter((net) => !removedNets.includes(net)) };
      return changed(markElectromechanicalStale(project, electrical), [operation.componentId, ...removedNets.map((net) => net.id)], `Deleted ${target.reference} and ${removedNets.length} dependent net(s).`);
    }
    case "add-electrical-net": {
      if (project.electrical.nets.length >= WORKBENCH_LIMITS.maxElectricalNets) return failure("RESOURCE_LIMIT", "The electrical sheet reached its net limit.", [project.electrical.id], "Delete a net before adding another one.");
      if (project.electrical.nets.some((net) => net.id === operation.net.id)) return invalidOperation("The electrical net ID already exists.");
      const electrical = { ...project.electrical, nets: [...project.electrical.nets, operation.net] };
      return changed(markElectromechanicalStale(project, electrical), [operation.net.id], `Connected ${operation.net.name} between ${operation.net.endpoints.length} terminals.`);
    }
    case "delete-electrical-net": {
      const target = project.electrical.nets.find((net) => net.id === operation.netId);
      if (target === undefined) return broken(operation.netId, "The electrical net does not exist.");
      const electrical = { ...project.electrical, nets: project.electrical.nets.filter((net) => net.id !== operation.netId) };
      return changed(markElectromechanicalStale(project, electrical), [operation.netId], `Deleted electrical net ${target.name}.`);
    }
    case "set-electrical-notes":
      return changed(markElectromechanicalStale(project, { ...project.electrical, notes: operation.notes }), [project.electrical.id], "Updated electrical design notes.");
    case "apply-vehicle-template": {
      const vehicle = createVehicleTemplate(operation.template);
      return changed({ ...project, vehicle }, [vehicle.id, ...vehicleHardPoints(vehicle).map((point) => point.id)], `Generated ${vehicle.name} as an original, illustrative vehicle skeleton.`);
    }
    case "set-vehicle-parameter": {
      const tireDataStatus = VEHICLE_TIRE_PARAMETERS.includes(operation.parameter) ? "unverified" : project.vehicle.tireDataStatus;
      const brakeDataStatus = VEHICLE_BRAKE_PARAMETERS.includes(operation.parameter) ? "unverified" : project.vehicle.brakeDataStatus;
      return changed({ ...project, vehicle: { ...project.vehicle, parameters: { ...project.vehicle.parameters, [operation.parameter]: operation.value }, inputStatus: "illustrative-unvalidated", tireDataStatus, brakeDataStatus } }, [project.vehicle.id], `Set vehicle ${humanize(operation.parameter)}.`);
    }
    case "set-vehicle-evidence-status": {
      const patch = operation.field === "input"
        ? { inputStatus: operation.reviewed ? "user-reviewed" as const : "illustrative-unvalidated" as const }
        : operation.field === "tire"
          ? { tireDataStatus: operation.reviewed ? "supplier-reviewed" as const : "unverified" as const }
          : { brakeDataStatus: operation.reviewed ? "supplier-reviewed" as const : "unverified" as const };
      const label = operation.field === "input" ? "illustrative inputs" : operation.field === "tire" ? "tire data" : "brake data";
      return changed({ ...project, vehicle: { ...project.vehicle, ...patch } }, [project.vehicle.id], `${operation.reviewed ? "Attested" : "Cleared the attestation for"} vehicle ${label}.`);
    }
    case "set-vehicle-simulation-state":
      return changed({ ...project, vehicle: { ...project.vehicle, state: operation.state } }, [project.vehicle.id], `Set vehicle suspension state to ${humanize(operation.state)}.`);
    case "toggle-vehicle-layer":
      return changed({ ...project, vehicle: { ...project.vehicle, layers: { ...project.vehicle.layers, [operation.layer]: !project.vehicle.layers[operation.layer] } } }, [project.vehicle.id], `Toggled vehicle ${humanize(operation.layer)} layer.`);
    case "generate-electromechanical-realization": {
      const generated = createElectromechanicalAssembly(project.electrical, operation.layoutPreset, operation.mappings, project.revision);
      if (!generated.ok) return generated;
      const assembly = generated.value;
      return changed({ ...project, assembly }, [assembly.id, ...assembly.components.map((component) => component.id), ...assembly.mates.map((mate) => mate.id), ...(assembly.electricalRoutes ?? []).map((route) => route.id)], `Generated ${assembly.name} from ${project.electrical.components.length} mapped schematic device(s) and ${project.electrical.nets.length} unsized conductor path(s).`);
    }
  }
}

function markElectromechanicalStale(project: WorkbenchProject, electrical: ElectricalIntent): WorkbenchProject {
  const source = project.assembly.electromechanicalSource;
  const assembly = source === undefined || source.electricalSignature === electricalSignature(electrical)
    ? project.assembly
    : { ...project.assembly, electromechanicalSource: { ...source, status: "stale" as const } };
  return { ...project, electrical, assembly };
}

/**
 * Applies a sketch edit atomically. Edits are exact geometry, so afterwards the touched
 * constraints must already hold: a solve that would have to move geometry means the edit
 * fights an existing relation, and the whole edit is refused instead of silently undone.
 */
function applySketchEdit(project: WorkbenchProject, operation: Extract<WorkbenchOperation, { readonly kind: "apply-sketch-edit" }>): WorkbenchResult<{
  readonly project: WorkbenchProject;
  readonly changedIds: readonly string[];
  readonly summary: string;
}> {
  const sketch = project.sketch;
  const existing = new Set(sketch.entities.map((entity) => entity.id));
  const removed = new Set(operation.removeEntityIds);
  for (const id of removed) if (!existing.has(id)) return missingSketchEntityFailure(project, id, "A sketch entity to remove does not exist.");
  const updates = new Map(operation.updateEntities.map((entity) => [entity.id, entity] as const));
  if (updates.size !== operation.updateEntities.length) {
    const seenIds = new Set<string>();
    const twice = operation.updateEntities.find((entity) => seenIds.size === seenIds.add(entity.id).size)?.id;
    return invalidOperation(`The sketch edit updates ${twice ?? "the same entity"} twice; list each curve once in updateEntities.`);
  }
  for (const id of updates.keys()) {
    if (!existing.has(id)) return missingSketchEntityFailure(project, id, "A sketch entity to update does not exist.");
    if (removed.has(id)) return invalidOperation(`The sketch edit both removes and updates ${id}; it can do only one of the two.`);
  }
  const addedIds = operation.addEntities.map((entity) => entity.id);
  if (new Set(addedIds).size !== addedIds.length || addedIds.some((id) => existing.has(id))) {
    const seenIds = new Set<string>();
    const reused = addedIds.find((id) => existing.has(id) || seenIds.size === seenIds.add(id).size);
    return invalidOperation(`A new sketch entity reuses the ID ${reused ?? "of another curve"}; give each new curve an ID that is not in the sketch yet.`);
  }
  const entities = [...sketch.entities.filter((entity) => !removed.has(entity.id)).map((entity) => updates.get(entity.id) ?? entity), ...operation.addEntities];
  if (entities.length > WORKBENCH_LIMITS.maxEntities) return failure("RESOURCE_LIMIT", "The sketch would exceed its entity limit.", [sketch.id], "Delete entities or use a smaller pattern count.");
  const removedConstraints = new Set(operation.removeConstraintIds ?? []);
  for (const id of removedConstraints) if (!sketch.constraints.some((constraint) => constraint.id === id)) return broken(id, "A sketch constraint to remove does not exist.");
  const dropped = sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => removed.has(id)));
  const constraints = [...sketch.constraints.filter((constraint) => !constraint.entityIds.some((id) => removed.has(id)) && !removedConstraints.has(constraint.id)), ...operation.addConstraints];
  if (constraints.length > WORKBENCH_LIMITS.maxConstraints) return failure("RESOURCE_LIMIT", "The sketch reached its constraint record limit.", [sketch.id], "Delete a constraint before applying this edit.");
  if (new Set(constraints.map((constraint) => constraint.id)).size !== constraints.length) {
    const seenIds = new Set<string>();
    const reused = constraints.find((constraint) => seenIds.size === seenIds.add(constraint.id).size)?.id;
    return invalidOperation(`A new constraint reuses the ID ${reused ?? "of another relation"}; give each new relation an ID that is not in the sketch yet.`);
  }
  const next = applySketchObjectsEdit({ ...sketch, entities, constraints }, operation.objects);
  const focus = [...updates.keys(), ...addedIds, ...operation.addConstraints.flatMap((constraint) => constraint.entityIds)];
  const solved = solveLiveSketch(next, focus);
  if (!solved.ok) return solveFailure(solved);
  if (solved.movedIds.length > 0) {
    // Horizontal on a vertical line (or Vertical on a horizontal one) is a quarter turn: add-sketch-constraint does it, an exact edit cannot.
    const turn = quarterTurnEditProblem(next, seedQuarterTurns(next, new Set(focus)).turnedIds);
    if (turn !== undefined) return failure("CONSTRAINT_CONFLICT", turn.message, solved.movedIds, turn.recovery);
    return failure(
      "CONSTRAINT_CONFLICT",
      `This edit conflicts with a sketch relation on ${solved.movedIds.map((id) => sketchEntityName(next, id)).join(", ")}. ${solved.notes.join("; ")}.`,
      solved.movedIds,
      "Use Relax Relations on the affected geometry, then repeat the edit."
    );
  }
  const gone = new Set([...dropped.map((constraint) => constraint.id), ...removedConstraints]).size;
  const droppedNote = gone === 0 ? "" : ` Removed ${gone} constraint${gone === 1 ? "" : "s"}.`;
  // The audit entry holds at most 240 characters of summary and 201 IDs; a big edit (a rounded rectangle, a pattern) must not trip that.
  const unsolvedNote = solved.unsolved.length === 0 ? "" : ` Recorded, not solved: ${[...new Set(solved.unsolved.map((entry) => entry.reason))].join(" ")}`;
  // A dimension the edit lets go of is named, never dropped silently.
  const lostNote = lostDimensionsNote(sketch, [...dropped, ...sketch.constraints.filter((constraint) => removedConstraints.has(constraint.id))], operation.addConstraints, removed);
  const summary = `${operation.label}.${droppedNote}${lostNote}${unsolvedNote}`;
  return changed(
    { ...project, sketch: next },
    [...removed, ...updates.keys(), ...addedIds, ...operation.addConstraints.map((constraint) => constraint.id)].slice(0, 200),
    summary.length > 240 ? `${summary.slice(0, 237)}...` : summary
  );
}

/** Operations that put another sketch in the working slot (or rebuild the timeline): a difference from the sketch before them is not a hand edit. */
const SKETCH_SWAPPING_KINDS: ReadonlySet<WorkbenchOperation["kind"]> = new Set(["commit-design-sketch", "edit-design-sketch", "new-design-sketch", "regenerate-design", "set-sketch-plane", "set-design-rollback", "delete-design-feature"]);

/**
 * After an operation that changed the sketch: keeps text objects and associative patterns in step with their curves (a pattern
 * re-generates its instances from its sources), and says in the summary what was reset or let go.
 */
function reconcileOperationSketch(
  before: WorkbenchProject,
  result: { readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string },
  operation: WorkbenchOperation
): WorkbenchResult<{ readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string }> {
  if (result.project.sketch === before.sketch) return { ok: true, value: result };
  const outcome = reconcileSketchObjects(before.sketch, result.project.sketch, explicitObjectIds(operation.kind === "apply-sketch-edit" ? operation.objects : undefined), { detectHandEdits: !SKETCH_SWAPPING_KINDS.has(operation.kind) });
  if (!outcome.ok) return failure("RESOURCE_LIMIT", outcome.message, outcome.relatedIds, "Change the pattern, or remove curves from the sketch, and try again.");
  if (outcome.sketch === result.project.sketch) return { ok: true, value: result };
  return { ok: true, value: { ...result, project: { ...result.project, sketch: outcome.sketch }, summary: outcome.notes.length === 0 ? result.summary : `${result.summary} ${outcome.notes.join(" ")}` } };
}

/** Rejects an operation whose sketch constraints cannot all hold, leaving the sketch untouched. */
function solveFailure(report: Extract<LiveSketchSolveReport, { readonly ok: false }>): WorkbenchResult<never> {
  return failure("CONSTRAINT_CONFLICT", report.message, report.relatedIds, report.recovery);
}

function changed(project: WorkbenchProject, changedIds: readonly string[], summary: string): WorkbenchResult<{ readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string }> {
  return { ok: true, value: { project, changedIds, summary } };
}

/** A sketch edit payload that failed its shape check: say which list is too long, or which field is wrong, instead of the bare "invalid". */
function sketchEditPayloadMessage(input: Record<string, unknown>): string {
  const lists: readonly [string, number][] = [["removeEntityIds", WORKBENCH_LIMITS.maxEntities], ["updateEntities", WORKBENCH_LIMITS.maxEntities], ["addEntities", WORKBENCH_LIMITS.maxEntities], ["addConstraints", WORKBENCH_LIMITS.maxConstraints], ["removeConstraintIds", WORKBENCH_LIMITS.maxConstraints]];
  for (const [name, maximum] of lists) {
    const list = input[name];
    if (Object.hasOwn(input, name) && !Array.isArray(list)) return `The sketch edit field ${name} must be a list.`;
    if (Array.isArray(list) && list.length > maximum) return `The sketch edit lists ${list.length} items in ${name}; one edit may carry at most ${maximum}. Split it into several edits.`;
  }
  if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80) return "The sketch edit needs a label of 1 to 80 characters.";
  if (Object.hasOwn(input, "objects")) {
    const problem = sketchObjectsProblem(input.objects);
    if (problem !== undefined) return problem;
  }
  for (const field of ["removeEntityIds", "removeConstraintIds"] as const) {
    const list = input[field];
    if (!Array.isArray(list)) continue;
    const bad = Array.from(list).findIndex((id) => !stableId(id));
    if (bad >= 0) return `The sketch edit's ${field} entry ${bad + 1} must be a stable id like "entity:l1", but it is ${describeGivenValue(list[bad])}.`;
  }
  for (const field of ["updateEntities", "addEntities", "addConstraints"] as const) {
    const list = input[field];
    if (!Array.isArray(list)) continue;
    const bad = Array.from(list).findIndex((item) => !isRecord(item));
    if (bad >= 0) return `The sketch edit's ${field} entry ${bad + 1} must be an object, but it is ${describeGivenValue(list[bad])}.`;
  }
  const unknownField = Object.keys(input).find((key) => !["operationId", "expectedRevision", "kind", "removeEntityIds", "updateEntities", "addEntities", "addConstraints", "removeConstraintIds", "label", "objects"].includes(key));
  if (unknownField !== undefined) return `The sketch edit has a field "${unknownField}" that it does not take (it takes removeEntityIds, updateEntities, addEntities, addConstraints, removeConstraintIds, label and objects).`;
  for (const field of ["removeEntityIds", "updateEntities", "addEntities", "addConstraints"] as const) {
    if (!Object.hasOwn(input, field)) return `The sketch edit is missing its ${field} list (use an empty list when there is nothing to put in it).`;
  }
  return "The sketch edit payload is invalid: check removeEntityIds, updateEntities, addEntities, addConstraints and label.";
}

function envelopeFailure(problem: EnvelopeProblem): WorkbenchResult<never> {
  return failure(problem.code, problem.message, problem.entityId === undefined ? [] : [problem.entityId], problem.code === "OUTSIDE_SUPPORTED_ENVELOPE" || problem.code === "DEGENERATE_GEOMETRY"
    ? `Keep sketch geometry between ${MODEL_ENVELOPE.minGeometryMm} mm and ${MODEL_ENVELOPE.maxSketchCoordinateMm.toLocaleString("en-US")} mm.` : "Use an exact bounded operation schema from the capability list.");
}

/** The whole-body modifiers that have a timeline step of their own: on a body the timeline builds, they must be recorded as steps. */
const TIMELINE_ONLY_MODIFIERS: ReadonlySet<string> = new Set(["hole", "shell", "chamfer", "fillet", "counterbore", "countersink", "tapped-hole"]);

function invalidOperation(message: string): WorkbenchResult<never> {
  return failure("INVALID_OPERATION", message, [], "Use an exact bounded operation schema from the capability list.");
}

function broken(id: string, message: string): WorkbenchResult<never> {
  // The message names the thing that is missing, not just its kind ("The sketch entity does not exist (entity:l9).").
  const named = message.includes(id) || !message.endsWith(".") ? message : `${message.slice(0, -1)} (${id}).`;
  return failure("BROKEN_REFERENCE", named, [id], "Refresh the project and select an existing stable ID.");
}

function partFeatureFailure(result: Extract<PartFeatureResult<unknown>, { readonly ok: false }>): WorkbenchResult<never> {
  return failure("UNSUPPORTED_CAPABILITY", result.message, result.relatedIds, result.recovery);
}

function findPartBody(project: WorkbenchProject, bodyId: string): PartPreviewBody | undefined {
  return (project.part.previewBodies ?? []).find((body) => body.id === bodyId);
}

function replacePartBody(project: WorkbenchProject, replacement: PartPreviewBody): WorkbenchProject {
  return {
    ...project,
    part: {
      ...project.part,
      previewBodies: (project.part.previewBodies ?? []).map((body) => body.id === replacement.id ? replacement : body)
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedList<T>(value: unknown, max: number, guard: (item: unknown) => item is T): value is readonly T[] {
  // Array.from reads a hole in a sparse list as undefined, which every() would skip.
  return Array.isArray(value) && value.length <= max && Array.from(value).every(guard);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function keysWithOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && actual.every((key) => required.includes(key) || optional.includes(key));
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
}

/** The shared payload of the two operations that place a sketch: a datum plane with an optional offset, tilt or (instead of both) frame. */
function validSketchPlacementInput(input: Record<string, unknown>, common: readonly string[]): boolean {
  const optional = ["offsetMm", "tilt", "frame", "face"].filter((key) => Object.hasOwn(input, key));
  const hasConvention = Object.hasOwn(input, "convention");
  if (!keys(input, [...common, "plane", ...optional, ...(hasConvention ? ["convention"] : [])]) || !(SKETCH_DATUM_PLANES as readonly unknown[]).includes(input.plane)) return false;
  if (hasConvention && input.convention !== "z-up" && input.convention !== "legacy") return false;
  if (Object.hasOwn(input, "offsetMm") && !(typeof input.offsetMm === "number" && Number.isFinite(input.offsetMm) && Math.abs(input.offsetMm) <= MODEL_ENVELOPE.maxPlaneOffsetMm)) return false;
  if (Object.hasOwn(input, "tilt") && !validSketchPlaneTilt(input.tilt)) return false;
  if (Object.hasOwn(input, "frame") && (!validSketchPlaneFrame(input.frame) || input.plane !== "datum:xy" || optional.length > 1)) return false;
  // A face reference rides along with the face's own offset (and nothing else): it is how the sketch finds that face again.
  if (Object.hasOwn(input, "face") && (!validSketchPlaneFace(input.face) || Object.hasOwn(input, "tilt") || Object.hasOwn(input, "frame"))) return false;
  return true;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return finite(value) && value >= minimum && value <= maximum;
}

function partFace(value: unknown): boolean {
  return ["x-negative", "x-positive", "y-negative", "y-positive", "z-negative", "z-positive"].includes(String(value));
}

function vec3(value: unknown, maximum: number, positive = false): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && value.every((coordinate) => finiteRange(coordinate, positive ? WORKBENCH_LIMITS.minGeometryMm : -maximum, maximum));
}

function partPreviewSize(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3
    && finiteRange(value[0], WORKBENCH_LIMITS.minGeometryMm, 10_000)
    && finiteRange(value[1], 0, 10_000)
    && finiteRange(value[2], WORKBENCH_LIMITS.minGeometryMm, 10_000);
}

function validPartPreviewBodyPayload(value: unknown): value is PartPreviewBody {
  const required = ["id", "name", "shape", "visible", "color", "translationMm", "rotationDeg", "sizeMm"];
  const optional = ["boreDiameterMm", "edgeTreatment", "shellThicknessMm", "draftAngleDeg", "revolveAngleDeg", "featureTrace", "primitiveParams"];
  if (!isRecord(value)
    || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120)
    || !["block", "cylinder", "cone", "sphere", "torus", "revolved", ...NEW_PRIMITIVE_SHAPES].includes(String(value.shape))
    || typeof value.visible !== "boolean" || typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)
    || !vec3(value.translationMm, WORKBENCH_LIMITS.maxCoordinateMm) || !vec3(value.rotationDeg, 360)
    || !partPreviewSize(value.sizeMm)) return false;
  const [x, y] = value.sizeMm;
  if ((value.shape === "cylinder" || value.shape === "sphere") && Math.abs(x - y) > 1e-9) return false;
  if (value.shape === "sphere" && Math.abs(x - value.sizeMm[2]) > 1e-9) return false;
  if (value.shape === "revolved" && (!((value.revolveAngleDeg as number) > 0) || !finiteRange(value.revolveAngleDeg, 0.001, 360) || y <= 0 || y >= x)) return false;
  if (value.shape !== "revolved" && Object.hasOwn(value, "revolveAngleDeg")) return false;
  if (Object.hasOwn(value, "boreDiameterMm") && !finiteRange(value.boreDiameterMm, WORKBENCH_LIMITS.minGeometryMm, 9_999)) return false;
  if (Object.hasOwn(value, "shellThicknessMm") && !finiteRange(value.shellThicknessMm, WORKBENCH_LIMITS.minGeometryMm, 5_000)) return false;
  if (Object.hasOwn(value, "draftAngleDeg") && !finiteRange(value.draftAngleDeg, 0.001, 20)) return false;
  if (Object.hasOwn(value, "edgeTreatment") && !validPartEdgeTreatment(value.edgeTreatment)) return false;
  if (Object.hasOwn(value, "featureTrace") && !validPartFeatureTrace(value.featureTrace)) return false;
  if (!validPrimitiveBody(value as unknown as PartPreviewBody)) return false;
  return validatePartFeatureStack(value as unknown as PartPreviewBody).ok;
}

function vec3Mm(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component) && Math.abs(component) <= 100_000);
}

function validConstructionAxisPayload(value: unknown): value is import("./types.js").ConstructionAxis {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean"
    || !isRecord(value.definition) || Object.keys(value).some((key) => !["id", "name", "visible", "definition"].includes(key))) return false;
  const def = value.definition;
  if (def.kind === "two-points") {
    return vec3Mm(def.a) && vec3Mm(def.b)
      && (def.a[0] !== def.b[0] || def.a[1] !== def.b[1] || def.a[2] !== def.b[2])
      && Object.keys(def).every((key) => ["kind", "a", "b"].includes(key));
  }
  if (def.kind === "point-and-direction") {
    return vec3Mm(def.origin) && vec3Mm(def.direction)
      && Math.hypot(def.direction[0], def.direction[1], def.direction[2]) > 1e-6
      && Object.keys(def).every((key) => ["kind", "origin", "direction"].includes(key));
  }
  if (def.kind === "plane-intersection") {
    return SKETCH_DATUM_PLANES.includes(def.planeA as never) && SKETCH_DATUM_PLANES.includes(def.planeB as never)
      && def.planeA !== def.planeB
      && Object.keys(def).every((key) => ["kind", "planeA", "planeB"].includes(key));
  }
  if (def.kind === "perpendicular-to-plane") {
    return SKETCH_DATUM_PLANES.includes(def.plane as never) && vec3Mm(def.point)
      && Object.keys(def).every((key) => ["kind", "plane", "point"].includes(key));
  }
  if (def.kind === "cylinder-axis") {
    return stableId(def.bodyId) && Object.keys(def).every((key) => ["kind", "bodyId"].includes(key));
  }
  return false;
}

function validConstructionUcsPayload(value: unknown): value is import("./types.js").ConstructionUcs {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean") return false;
  if (!vec3Mm(value.origin) || !vec3Mm(value.xAxis) || !vec3Mm(value.yAxis)) return false;
  if (Object.keys(value).some((key) => !["id", "name", "visible", "origin", "xAxis", "yAxis"].includes(key))) return false;
  // Reject a zero X or Y axis — the UCS cannot build an orthonormal basis.
  const xLength = Math.hypot((value.xAxis as readonly number[])[0]!, (value.xAxis as readonly number[])[1]!, (value.xAxis as readonly number[])[2]!);
  const yLength = Math.hypot((value.yAxis as readonly number[])[0]!, (value.yAxis as readonly number[])[1]!, (value.yAxis as readonly number[])[2]!);
  return xLength > 1e-9 && yLength > 1e-9;
}

function validConstructionPointPayload(value: unknown): value is import("./types.js").ConstructionPoint {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean"
    || !isRecord(value.definition) || Object.keys(value).some((key) => !["id", "name", "visible", "definition"].includes(key))) return false;
  const def = value.definition;
  if (def.kind === "xyz") {
    return vec3Mm(def.position) && Object.keys(def).every((key) => ["kind", "position"].includes(key));
  }
  if (def.kind === "midpoint") {
    return vec3Mm(def.a) && vec3Mm(def.b) && Object.keys(def).every((key) => ["kind", "a", "b"].includes(key));
  }
  if (def.kind === "axis-plane-intersection") {
    return stableId(def.axisId) && SKETCH_DATUM_PLANES.includes(def.plane as never)
      && Object.keys(def).every((key) => ["kind", "axisId", "plane"].includes(key));
  }
  return false;
}

function validConstructionPlanePayload(value: unknown): value is import("./types.js").ConstructionPlane {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || typeof value.visible !== "boolean"
    || !isRecord(value.definition) || Object.keys(value).some((key) => !["id", "name", "visible", "definition"].includes(key))) return false;
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
    return stableId(def.axisId) && vec3Mm(def.point) && Object.keys(def).every((key) => ["kind", "axisId", "point"].includes(key));
  }
  return validNewPlaneDefinition(def) ?? false;
}

function validGeneralSolidBodyPayload(value: unknown): value is GeneralSolidBody {
  const required = ["id", "name", "visible", "color", "positionsMm", "indices"];
  const optional = ["feature", "brep", "subd"];
  if (!isRecord(value)
    || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120)
    || typeof value.visible !== "boolean" || typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)) return false;
  const positions = value.positionsMm;
  if (!Array.isArray(positions) || positions.length < 12 || positions.length % 3 !== 0 || positions.length > MAX_BODY_MESH_NUMBERS
    || positions.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > MODEL_ENVELOPE.maxBodyCoordinateMm)) return false;
  const vertexCount = positions.length / 3;
  const indices = value.indices;
  if (!Array.isArray(indices) || indices.length < 3 || indices.length % 3 !== 0 || indices.length > MAX_BODY_MESH_NUMBERS
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
    if (["vertices", "edges", "faces"].some((key) => typeof (brep.topology as Record<string, unknown>)[key] !== "number")) return false;
    if (brep.faces.some((face) => !isRecord(face) || typeof face.role !== "string" || typeof face.key !== "string" || typeof face.areaMm2 !== "number")) return false;
    const faceCount = brep.faces.length;
    if (brep.faceTriangles.length !== indices.length / 3 || brep.faceTriangles.some((face) => typeof face !== "number" || !Number.isInteger(face) || face < -1 || face >= faceCount)) return false;
  }
  return true;
}

function normalizePartPreviewSize(shape: PartPreviewBody["shape"], size: readonly [number, number, number]): readonly [number, number, number] | undefined {
  if (!partPreviewSize(size)) return undefined;
  if (shape === "cylinder") return [size[0], size[0], size[2]];
  if (shape === "sphere") return [size[0], size[0], size[0]];
  if (isNewPrimitiveShape(shape)) return normalizePrimitiveSize(shape, size);
  if (shape === "cone" && size[0] <= 0 && size[1] <= 0) return undefined;
  if (shape === "revolved" && (size[1] <= 0 || size[1] >= size[0])) return undefined;
  return [size[0], size[1], size[2]];
}

function validPartEdgeTreatment(value: unknown): boolean {
  return isRecord(value) && keys(value, ["kind", "sizeMm"])
    && ["blend", "chamfer"].includes(String(value.kind)) && finiteRange(value.sizeMm, WORKBENCH_LIMITS.minGeometryMm, 5_000);
}

function validPartFeatureTrace(value: unknown): boolean {
  return isRecord(value) && keys(value, ["kind", "operationId", "parentIds"])
    && ["primitive", "revolve", "pattern", "mirror", "unite", "subtract", "trim", "face-edit", "edge-treatment", "draft", "shell", "heal"].includes(String(value.kind))
    && stableId(value.operationId) && Array.isArray(value.parentIds) && value.parentIds.length > 0 && value.parentIds.length <= 8
    && value.parentIds.every((id) => stableId(id));
}

function validComponentPayload(value: unknown): value is ComponentInstance {
  const required = ["id", "name", "shape", "grounded", "visible", "color", "translationMm", "rotationDeg", "sizeMm", "explosionDirection"];
  const optional = ["featureCount", "masterCart", "sourceElectricalComponentId", "catalogPartId", "mesh"];
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120) || !COMPONENT_SHAPES.includes(value.shape as ComponentInstance["shape"])
    || typeof value.grounded !== "boolean" || typeof value.visible !== "boolean" || typeof value.color !== "string" || !COLOR_PATTERN.test(value.color)
    || !vec3(value.translationMm, WORKBENCH_LIMITS.maxCoordinateMm) || !vec3(value.rotationDeg, 360) || !vec3(value.sizeMm, 20_000, true) || !vec3(value.explosionDirection, 1)
    || (Object.hasOwn(value, "sourceElectricalComponentId") && !stableId(value.sourceElectricalComponentId))
    || (Object.hasOwn(value, "catalogPartId") && !stableId(value.catalogPartId))) return false;
  const [first, second, third] = value.sizeMm as readonly number[];
  if (["cylinder", "sphere", "hex-prism"].includes(String(value.shape)) && Math.abs(first! - second!) > 1e-9) return false;
  if (value.shape === "sphere" && Math.abs(first! - third!) > 1e-9) return false;
  if (value.shape === "cone" && (second! <= 0 || second! > first!)) return false;
  if (["ring", "gear"].includes(String(value.shape)) && (second! <= 0 || second! >= first!)) return false;
  if (value.shape === "torus" && (second! >= first! || Math.abs(second! - third!) > 1e-9)) return false;
  if (Object.hasOwn(value, "featureCount") && (!Number.isSafeInteger(value.featureCount) || (value.featureCount as number) < 3 || (value.featureCount as number) > 240 || value.shape !== "gear")) return false;
  if (Object.hasOwn(value, "masterCart") && !validMasterCartTrace(value.masterCart)) return false;
  if ((value.shape === "mesh") !== Object.hasOwn(value, "mesh") || (value.shape === "mesh" && !validComponentMeshPayload(value.mesh))) return false;
  return true;
}

function validComponentMeshPayload(value: unknown): boolean {
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

function validAssemblyMatePayload(value: unknown): value is AssemblyMate {
  if (!isRecord(value) || !stableId(value.id) || !shortText(value.name, 1, 120) || !["fixed", "coincident-origin", "aligned-axis"].includes(String(value.kind))
    || !Array.isArray(value.componentIds) || value.componentIds.some((id) => !stableId(id)) || !["satisfied", "redundant", "conflict"].includes(String(value.status))) return false;
  const requiredCount = value.kind === "fixed" ? 1 : 2;
  if (value.componentIds.length !== requiredCount) return false;
  if (value.kind === "aligned-axis") return keys(value, ["id", "name", "kind", "componentIds", "axis", "status"]) && ["x", "y", "z"].includes(String(value.axis));
  return keys(value, ["id", "name", "kind", "componentIds", "status"]);
}

function validMasterCartTrace(value: unknown): boolean {
  return isRecord(value)
    && keys(value, ["instanceId", "templateId", "role", "sizeLabel", "materialLabel", "finishLabel", "parameterSummary", "provenance"])
    && stableId(value.instanceId)
    && MASTER_CART_TEMPLATE_IDS.includes(value.templateId as never)
    && shortText(value.role, 1, 80) && shortText(value.sizeLabel, 1, 100) && shortText(value.materialLabel, 1, 100)
    && shortText(value.finishLabel, 1, 100) && shortText(value.parameterSummary, 1, 240)
    && value.provenance === "original-ps3d-parametric-preview";
}

function validElectricalComponentPayload(value: unknown): value is ElectricalComponent {
  const kinds = ["battery", "fuse", "disconnect", "contactor", "inverter", "transformer", "breaker", "load", "motor", "ground", "terminal", "sensor", "hvac"];
  return isRecord(value)
    && keys(value, ["id", "kind", "reference", "label", "value", "position", "rotationDeg", "terminals"])
    && stableId(value.id) && kinds.includes(String(value.kind))
    && shortText(value.reference, 1, 24) && shortText(value.label, 1, 80) && shortText(value.value, 0, 100)
    && electricalSheetPosition(value.position) && finiteRange(value.rotationDeg, -360, 360)
    && Array.isArray(value.terminals) && value.terminals.length >= 1 && value.terminals.length <= 8
    && value.terminals.every((terminal) => shortText(terminal, 1, 24))
    && new Set(value.terminals).size === value.terminals.length;
}

function validElectricalNetPayload(value: unknown): value is ElectricalNet {
  return isRecord(value)
    && keys(value, ["id", "name", "class", "endpoints"])
    && stableId(value.id) && shortText(value.name, 1, 80)
    && ["power-dc", "power-ac", "control", "ground"].includes(String(value.class))
    && Array.isArray(value.endpoints) && value.endpoints.length >= 2 && value.endpoints.length <= 16
    && value.endpoints.every((endpoint) => isRecord(endpoint) && keys(endpoint, ["componentId", "terminal"])
      && stableId(endpoint.componentId) && shortText(endpoint.terminal, 1, 24));
}

function vec2(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((coordinate) => finiteRange(coordinate, -WORKBENCH_LIMITS.maxCoordinateMm, WORKBENCH_LIMITS.maxCoordinateMm));
}

function electricalSheetPosition(value: unknown): value is readonly [number, number] {
  return vec2(value)
    && value[0] >= ELECTRICAL_SHEET_BOUNDS.minX && value[0] <= ELECTRICAL_SHEET_BOUNDS.maxX
    && value[1] >= ELECTRICAL_SHEET_BOUNDS.minY && value[1] <= ELECTRICAL_SHEET_BOUNDS.maxY;
}

function shortText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

function workspaceLabel(value: WorkspaceId): string {
  return value === "automate" ? "Automate" : value[0]!.toUpperCase() + value.slice(1);
}

function humanize(value: string): string {
  return value.replace(/Mm$/u, " mm").replace(/Deg$/u, "°").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}
