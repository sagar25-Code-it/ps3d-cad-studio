import type {
  AppliedWorkbenchOperation,
  AssemblyMate,
  ComponentInstance,
  ElectricalComponent,
  ElectricalIntent,
  ElectricalNet,
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
import { ELECTRICAL_SHEET_BOUNDS, ELECTROMECHANICAL_CATALOG_REVISION } from "./types.js";
import { createBessContainerAssembly, createCargoContainerAssembly, createElectricalTemplate } from "./templates.js";
import { createElectromechanicalAssembly, electricalSignature } from "./electromechanical.js";
import { createVehicleTemplate, vehicleHardPoints, VEHICLE_PARAMETER_RANGES } from "./vehicle.js";
import { MASTER_CART_TEMPLATE_IDS } from "./master-cart.js";
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
import { failure, validateWorkbenchProject, WORKBENCH_LIMITS } from "./validation.js";

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const WORKSPACES: readonly WorkspaceId[] = ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"];
const COMPONENT_SHAPES: readonly ComponentInstance["shape"][] = ["plate", "spacer", "pin", "cap", "box", "cylinder", "cone", "sphere", "hex-prism", "ring", "torus", "gear"];
const PART_PARAMETERS: readonly (keyof Pick<PartIntent, "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm" | "edgeTreatmentMm" | "patternCount" | "revolveAngleDeg">)[] = [
  "widthMm", "heightMm", "thicknessMm", "holeDiameterMm", "edgeTreatmentMm", "patternCount", "revolveAngleDeg"
];
const SURFACE_PARAMETERS: readonly (keyof Omit<SurfaceIntent, "id" | "name" | "mode">)[] = [
  "widthMm", "depthMm", "crownMm", "twistDeg", "uSegments", "vSegments"
];
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

export function applyWorkbenchOperation(
  projectInput: WorkbenchProject,
  operationInput: WorkbenchOperation
): WorkbenchResult<AppliedWorkbenchOperation> {
  const current = validateWorkbenchProject(projectInput);
  if (!current.ok) return current;
  const operationResult = validateWorkbenchOperation(operationInput);
  if (!operationResult.ok) return operationResult;
  const operation = operationResult.value;
  const intentKey = canonicalizeJson(operation);
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
  if (current.value.audit.length >= WORKBENCH_LIMITS.maxAuditEntries) {
    return failure("RESOURCE_LIMIT", "The preview audit reached its 500-entry limit.", [current.value.id], "Export the project and start a compacted revision lineage.");
  }

  const changed = applyIntent(current.value, operation);
  if (!changed.ok) return changed;
  const nextRevision = current.value.revision + 1;
  const next: WorkbenchProject = {
    ...changed.value.project,
    revision: nextRevision,
    audit: [...current.value.audit, {
      revision: nextRevision,
      operationId: operation.operationId,
      kind: operation.kind,
      intentKey,
      summary: changed.value.summary,
      changedIds: changed.value.changedIds
    }]
  };
  const validated = validateWorkbenchProject(next);
  if (!validated.ok) return validated;
  return { ok: true, value: { project: validated.value, changedIds: changed.value.changedIds, summary: changed.value.summary, exactRetry: false } };
}

export function validateWorkbenchOperation(input: unknown): WorkbenchResult<WorkbenchOperation> {
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
      break;
    case "delete-sketch-entity":
      if (!keys(input, [...common, "entityId"]) || !stableId(input.entityId)) return invalidOperation("The sketch entity ID is invalid.");
      break;
    case "add-sketch-constraint":
      if (!keys(input, [...common, "constraint"]) || !isRecord(input.constraint)) return invalidOperation("The sketch constraint payload is invalid.");
      break;
    case "delete-sketch-constraint":
      if (!keys(input, [...common, "constraintId"]) || !stableId(input.constraintId)) return invalidOperation("The sketch constraint ID is invalid.");
      break;
    case "set-sketch-dimension":
      if (!keys(input, [...common, "entityId", "dimension", "valueMm"]) || !stableId(input.entityId)
        || !["length", "width", "height", "radius"].includes(String(input.dimension)) || !finite(input.valueMm)) {
        return invalidOperation("The sketch dimension edit is invalid.");
      }
      break;
    case "toggle-sketch-construction":
      if (!keys(input, [...common, "entityId"]) || !stableId(input.entityId)) return invalidOperation("The sketch entity ID is invalid.");
      break;
    case "toggle-sketch-entity-visibility":
      if (!keys(input, [...common, "entityId"]) || !stableId(input.entityId)) return invalidOperation("The sketch entity ID is invalid.");
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
      if (!keys(input, [...common, "bodyId", "sizeMm"]) || !stableId(input.bodyId) || !partPreviewSize(input.sizeMm)) return invalidOperation("The preview-body size is invalid.");
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
    case "delete-assembly-mate":
      if (!keys(input, [...common, "mateId"]) || !stableId(input.mateId)) return invalidOperation("The mate ID is invalid.");
      break;
    case "set-surface-mode":
      if (!keys(input, [...common, "mode"]) || !["bezier", "loft"].includes(String(input.mode))) return invalidOperation("The surface mode is invalid.");
      break;
    case "set-surface-parameter":
      if (!keys(input, [...common, "parameter", "value"]) || !SURFACE_PARAMETERS.includes(input.parameter as never) || !finite(input.value)) return invalidOperation("The surface parameter edit is invalid.");
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
      return changed({ ...project, sketch: { ...project.sketch, entities: [...project.sketch.entities, operation.entity] } }, [operation.entity.id], `Added ${operation.entity.kind} ${operation.entity.id}.`);
    }
    case "delete-sketch-entity": {
      if (!project.sketch.entities.some((entity) => entity.id === operation.entityId)) return broken(operation.entityId, "The sketch entity does not exist.");
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
    case "add-sketch-constraint":
      if (project.sketch.constraints.some((constraint) => constraint.id === operation.constraint.id)) return invalidOperation("The sketch constraint ID already exists.");
      return changed({ ...project, sketch: { ...project.sketch, constraints: [...project.sketch.constraints, operation.constraint] } }, [operation.constraint.id], `Added ${operation.constraint.kind} constraint.`);
    case "delete-sketch-constraint":
      if (!project.sketch.constraints.some((constraint) => constraint.id === operation.constraintId)) return broken(operation.constraintId, "The sketch constraint does not exist.");
      return changed({ ...project, sketch: { ...project.sketch, constraints: project.sketch.constraints.filter((constraint) => constraint.id !== operation.constraintId) } }, [operation.constraintId], `Deleted constraint ${operation.constraintId}.`);
    case "set-sketch-dimension": {
      const target = project.sketch.entities.find((entity) => entity.id === operation.entityId);
      if (target === undefined) return broken(operation.entityId, "The sketch entity does not exist.");
      if (operation.valueMm < WORKBENCH_LIMITS.minGeometryMm || operation.valueMm > 10_000) {
        return failure("OUTSIDE_SUPPORTED_ENVELOPE", "The driving dimension is outside the 0.01–10,000 mm preview envelope.", [operation.entityId], "Enter a positive bounded millimeter value.");
      }
      const resized = resizeSketchEntity(target, operation.dimension, operation.valueMm);
      if (resized === undefined) return invalidOperation(`${operation.dimension} is not a supported driving dimension for a ${target.kind}.`);
      const existing = project.sketch.constraints.find((constraint) => constraint.entityIds.length === 1
        && constraint.entityIds[0] === operation.entityId
        && (constraint.dimension === operation.dimension || (constraint.dimension === undefined && constraint.kind === "radius" && operation.dimension === "radius")));
      if (existing === undefined && project.sketch.constraints.length >= WORKBENCH_LIMITS.maxConstraints) {
        return failure("RESOURCE_LIMIT", "The sketch reached its constraint record limit.", [project.sketch.id], "Delete a constraint before adding another driving dimension.");
      }
      const dimensionId = existing?.id ?? `constraint:dimension-${operation.dimension}-${operation.entityId.replaceAll(":", "-")}`;
      const dimensionConstraint = {
        id: dimensionId,
        kind: operation.dimension === "radius" ? "radius" as const : "distance" as const,
        entityIds: [operation.entityId],
        valueMm: operation.valueMm,
        dimension: operation.dimension
      };
      const constraints = existing === undefined
        ? [...project.sketch.constraints, dimensionConstraint]
        : project.sketch.constraints.map((constraint) => constraint.id === existing.id ? dimensionConstraint : constraint);
      return changed({
        ...project,
        sketch: { ...project.sketch, entities: project.sketch.entities.map((entity) => entity.id === target.id ? resized : entity), constraints }
      }, [target.id, dimensionId], `Set ${operation.dimension} of ${target.id} to ${formatNumber(operation.valueMm)} mm.`);
    }
    case "toggle-sketch-construction": {
      const target = project.sketch.entities.find((entity) => entity.id === operation.entityId);
      if (target === undefined) return broken(operation.entityId, "The sketch entity does not exist.");
      return changed({
        ...project,
        sketch: { ...project.sketch, entities: project.sketch.entities.map((entity) => entity.id === target.id ? { ...entity, construction: !entity.construction } : entity) }
      }, [target.id], `${target.construction ? "Returned" : "Converted"} ${target.id} ${target.construction ? "to profile geometry" : "to construction geometry"}.`);
    }
    case "toggle-sketch-entity-visibility": {
      const target = project.sketch.entities.find((entity) => entity.id === operation.entityId);
      if (target === undefined) return broken(operation.entityId, "The sketch entity does not exist.");
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
      return changed({
        ...project,
        part: { ...project.part, previewBodies: currentBodies.map((body) => body.id === target.id ? { ...body, sizeMm: resized } : body) }
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
      return changed({
        ...project,
        assembly: { ...project.assembly, components: [...project.assembly.components, operation.component] }
      }, [operation.component.id], `Inserted ${operation.component.name}.`);
    }
    case "add-assembly-components": {
      if (project.assembly.components.length + operation.components.length > WORKBENCH_LIMITS.maxComponents) {
        return failure("RESOURCE_LIMIT", `This grouped item needs ${operation.components.length} preview bodies, but the assembly limit is ${WORKBENCH_LIMITS.maxComponents}.`, [project.assembly.id], "Delete unused components or choose a simpler catalog item before inserting it.");
      }
      const existingIds = new Set(project.assembly.components.map((component) => component.id));
      if (operation.components.some((component) => existingIds.has(component.id))) return invalidOperation("A grouped assembly component ID already exists.");
      const label = operation.components[0]?.masterCart?.templateId.replaceAll("-", " ") ?? `${operation.components.length}-body item`;
      return changed({
        ...project,
        assembly: { ...project.assembly, components: [...project.assembly.components, ...operation.components] }
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
      const groupedIds = project.assembly.components.filter((component) => target.masterCart === undefined ? component.id === target.id : component.masterCart?.instanceId === target.masterCart.instanceId).map((component) => component.id);
      return changed({
        ...project,
        assembly: { ...project.assembly, components: project.assembly.components.map((component) => groupedIds.includes(component.id) ? { ...component, grounded: !target.grounded } : component) }
      }, groupedIds, `${target.grounded ? "Released" : "Grounded"} ${target.masterCart === undefined ? target.name : `${target.masterCart.templateId.replaceAll("-", " ")} grouped item`}.`);
    }
    case "toggle-component-visibility": {
      const target = project.assembly.components.find((component) => component.id === operation.componentId);
      if (target === undefined) return broken(operation.componentId, "The assembly component does not exist.");
      const groupedIds = project.assembly.components.filter((component) => target.masterCart === undefined ? component.id === target.id : component.masterCart?.instanceId === target.masterCart.instanceId).map((component) => component.id);
      return changed({
        ...project,
        assembly: { ...project.assembly, components: project.assembly.components.map((component) => groupedIds.includes(component.id) ? { ...component, visible: !target.visible } : component) }
      }, groupedIds, `${target.visible ? "Hid" : "Showed"} ${target.masterCart === undefined ? target.name : `${target.masterCart.templateId.replaceAll("-", " ")} grouped item`}.`);
    }
    case "add-assembly-mate": {
      if (project.assembly.mates.length >= WORKBENCH_LIMITS.maxMates) return failure("RESOURCE_LIMIT", "The assembly reached its mate-record limit.", [project.assembly.id], "Delete an unused mate before creating another one.");
      if (project.assembly.mates.some((mate) => mate.id === operation.mate.id)) return invalidOperation("The assembly mate ID already exists.");
      const componentIds = new Set(project.assembly.components.map((component) => component.id));
      if (operation.mate.componentIds.some((componentId) => !componentIds.has(componentId))) return invalidOperation("The assembly mate references a missing component.");
      if (new Set(operation.mate.componentIds).size !== operation.mate.componentIds.length) return invalidOperation("A mate cannot reference the same component twice.");
      return changed({ ...project, assembly: { ...project.assembly, mates: [...project.assembly.mates, operation.mate] } }, [operation.mate.id, ...operation.mate.componentIds], `Created ${operation.mate.name} as a validated direct-mate record.`);
    }
    case "delete-assembly-mate": {
      const target = project.assembly.mates.find((mate) => mate.id === operation.mateId);
      if (target === undefined) return broken(operation.mateId, "The assembly mate does not exist.");
      if (project.assembly.electromechanicalSource !== undefined && target.id.startsWith("mate:em-")) return invalidOperation("Generated electromechanical mates must be replaced through the reviewed realization workflow.");
      return changed({ ...project, assembly: { ...project.assembly, mates: project.assembly.mates.filter((mate) => mate.id !== target.id) } }, [target.id], `Deleted mate ${target.name}.`);
    }
    case "set-surface-mode":
      return changed({ ...project, surface: { ...project.surface, mode: operation.mode } }, [project.surface.id], `Switched to ${operation.mode === "bezier" ? "bicubic Bézier" : "ruled loft"} preview.`);
    case "set-surface-parameter":
      return changed({ ...project, surface: { ...project.surface, [operation.parameter]: operation.value } }, [project.surface.id], `Set ${humanize(operation.parameter)} to ${formatNumber(operation.value)}.`);
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
    case "set-drawing-datum-scheme":
      return changed({ ...project, drawing: { ...project.drawing, datumScheme: operation.scheme } }, [project.drawing.id], `Set datum scheme to ${operation.scheme === "none" ? "none" : "plate 3-2-1 draft"}.`);
    case "set-drawing-gdt-specification":
      return changed({ ...project, drawing: { ...project.drawing, gdtPositionToleranceMm: operation.positionMm, gdtFlatnessToleranceMm: operation.flatnessMm, gdtPerpendicularityToleranceMm: operation.perpendicularityMm } }, [project.drawing.id], "Updated explicit GD&T values without changing the general tolerance.");
    case "set-drawing-general-tolerance":
      return changed({ ...project, drawing: { ...project.drawing, generalToleranceLinearMm: operation.linearMm, generalToleranceAngularDeg: operation.angularDeg } }, [project.drawing.id], `Set the general tolerance to ±${formatNumber(operation.linearMm)} mm and ±${formatNumber(operation.angularDeg)}°.`);
    case "set-drawing-notes":
      return changed({ ...project, drawing: { ...project.drawing, notes: operation.notes } }, [project.drawing.id], "Updated drawing notes.");
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
      return changed({ ...project, vehicle: { ...project.vehicle, parameters: { ...project.vehicle.parameters, [operation.parameter]: operation.value }, inputStatus: "illustrative-unvalidated", tireDataStatus, brakeDataStatus } }, [project.vehicle.id], `Set vehicle ${humanize(operation.parameter)} to ${formatNumber(operation.value)} SI.`);
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

function resizeSketchEntity(entity: SketchEntity, dimension: "length" | "width" | "height" | "radius", valueMm: number): SketchEntity | undefined {
  if (entity.kind === "line" && dimension === "length") {
    const dx = entity.end[0] - entity.start[0];
    const dy = entity.end[1] - entity.start[1];
    const current = Math.hypot(dx, dy);
    return { ...entity, end: [entity.start[0] + dx / current * valueMm, entity.start[1] + dy / current * valueMm] as const };
  }
  if (entity.kind === "circle" && dimension === "radius") return { ...entity, radiusMm: valueMm };
  if (entity.kind === "rectangle" && dimension === "width") return { ...entity, widthMm: valueMm };
  if (entity.kind === "rectangle" && dimension === "height") return { ...entity, heightMm: valueMm };
  return undefined;
}

function changed(project: WorkbenchProject, changedIds: readonly string[], summary: string): WorkbenchResult<{ readonly project: WorkbenchProject; readonly changedIds: readonly string[]; readonly summary: string }> {
  return { ok: true, value: { project, changedIds, summary } };
}

function invalidOperation(message: string): WorkbenchResult<never> {
  return failure("INVALID_OPERATION", message, [], "Use an exact bounded operation schema from the capability list.");
}

function broken(id: string, message: string): WorkbenchResult<never> {
  return failure("BROKEN_REFERENCE", message, [id], "Refresh the project and select an existing stable ID.");
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

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
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
  const optional = ["boreDiameterMm", "edgeTreatment", "shellThicknessMm", "draftAngleDeg", "revolveAngleDeg", "featureTrace"];
  if (!isRecord(value)
    || !required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    || !stableId(value.id) || !shortText(value.name, 1, 120)
    || !["block", "cylinder", "cone", "sphere", "revolved"].includes(String(value.shape))
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
  return validatePartFeatureStack(value as unknown as PartPreviewBody).ok;
}

function normalizePartPreviewSize(shape: PartPreviewBody["shape"], size: readonly [number, number, number]): readonly [number, number, number] | undefined {
  if (!partPreviewSize(size)) return undefined;
  if (shape === "cylinder") return [size[0], size[0], size[2]];
  if (shape === "sphere") return [size[0], size[0], size[0]];
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
  const optional = ["featureCount", "masterCart", "sourceElectricalComponentId", "catalogPartId"];
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
