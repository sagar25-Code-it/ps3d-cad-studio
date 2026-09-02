import { createCadId, type ComponentId, type FeatureId, type OriginId, type ProjectId } from "./ids.js";
import {
  CAD_DOCUMENT_FORMAT,
  CAD_DOCUMENT_SCHEMA_VERSION,
  IDENTITY_TRANSFORM,
  type CadBody,
  type CadComponent,
  type CadDiagnostic,
  type CadDocument,
  type CadFeature,
  type CadOrigin,
  type CadProject,
  type EvaluationStatus,
  type UnitSystem
} from "./types.js";

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]{0,95}$/u;

export interface EmptyCadDocumentOptions {
  readonly projectId: ProjectId;
  readonly rootComponentId: ComponentId;
  readonly rootOriginId: OriginId;
  readonly name: string;
  readonly description: string;
  readonly applicationVersion: string;
  readonly operationId: string;
  readonly units: UnitSystem;
}

export function createEmptyCadDocument(options: EmptyCadDocumentOptions): CadDocument {
  assertOperationId(options.operationId);
  assertName(options.name, "project");
  const origin = createOrigin(options.rootOriginId, options.rootComponentId);
  const component = createComponent(options.rootComponentId, options.rootOriginId, options.name, null);
  return deepFreeze({
    format: CAD_DOCUMENT_FORMAT,
    schemaVersion: CAD_DOCUMENT_SCHEMA_VERSION,
    applicationVersion: options.applicationVersion,
    revision: 0,
    parentRevision: null,
    lastOperationId: options.operationId,
    project: {
      id: options.projectId,
      name: options.name,
      description: options.description,
      units: structuredClone(options.units) as UnitSystem,
      rootComponentId: options.rootComponentId,
      components: [component],
      origins: [origin],
      sketches: [],
      bodies: [],
      features: [],
      occurrences: [],
      joints: [],
      drawings: [],
      diagnostics: []
    }
  });
}

export function createDefaultCadDocument(name = "Untitled design", applicationVersion = "0.1.0-preview.0"): CadDocument {
  return createEmptyCadDocument({
    projectId: createCadId("project", "untitled"),
    rootComponentId: createCadId("component", "root"),
    rootOriginId: createCadId("origin", "root"),
    name,
    description: "",
    applicationVersion,
    operationId: "operation:create-document",
    units: { length: "mm", angle: "deg", mass: "kg" }
  });
}

export function createOrigin(id: OriginId, componentId: ComponentId): CadOrigin {
  return {
    id,
    componentId,
    transform: IDENTITY_TRANSFORM,
    axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    planes: {
      xy: [[0, 0, 0], [0, 0, 1]],
      yz: [[0, 0, 0], [1, 0, 0]],
      xz: [[0, 0, 0], [0, 1, 0]]
    },
    visible: false
  };
}

export function createComponent(
  id: ComponentId,
  originId: OriginId,
  name: string,
  parentComponentId: ComponentId | null
): CadComponent {
  assertName(name, "component");
  return {
    id,
    parentComponentId,
    name,
    description: "",
    originId,
    childComponentIds: [],
    sketchIds: [],
    bodyIds: [],
    featureIds: [],
    occurrenceIds: [],
    jointIds: [],
    drawingIds: [],
    rollbackAfterFeatureId: null,
    visible: true,
    suppressed: false
  };
}

export function addComponentDefinition(
  document: CadDocument,
  operationId: string,
  component: CadComponent,
  origin: CadOrigin
): CadDocument {
  if (component.originId !== origin.id || origin.componentId !== component.id) {
    throw new Error("The component and origin must own one another.");
  }
  if (document.project.components.some((candidate) => candidate.id === component.id)
    || document.project.origins.some((candidate) => candidate.id === origin.id)) {
    throw new Error("The component or origin ID already exists.");
  }
  return reviseCadDocument(document, operationId, (project) => {
    let components = project.components;
    if (component.parentComponentId !== null) {
      if (!components.some((candidate) => candidate.id === component.parentComponentId)) {
        throw new Error(`Parent component does not exist: ${component.parentComponentId}`);
      }
      components = components.map((candidate) => candidate.id === component.parentComponentId
        ? { ...candidate, childComponentIds: appendUnique(candidate.childComponentIds, component.id) }
        : candidate);
    }
    return {
      ...project,
      components: [...components, structuredClone(component) as CadComponent],
      origins: [...project.origins, structuredClone(origin) as CadOrigin]
    };
  });
}

export function appendFeature(
  document: CadDocument,
  operationId: string,
  feature: CadFeature,
  outputBodies: readonly CadBody[] = []
): CadDocument {
  if (document.project.features.some((candidate) => candidate.id === feature.id)) {
    throw new Error(`Feature already exists: ${feature.id}`);
  }
  const component = requireComponent(document.project, feature.componentId);
  if (outputBodies.some((body) => body.componentId !== feature.componentId || body.generatedByFeatureId !== feature.id)) {
    throw new Error("Every appended output body must be owned by the feature component and generated by the feature.");
  }
  const existingBodyIds = new Set(document.project.bodies.map((body) => body.id));
  if (outputBodies.some((body) => existingBodyIds.has(body.id))) throw new Error("An output body ID already exists.");
  const newBodyIds = new Set(outputBodies.map((body) => body.id));
  if (outputBodies.some((body) => !feature.outputBodyIds.includes(body.id))
    || feature.outputBodyIds.some((id) => !existingBodyIds.has(id) && !newBodyIds.has(id))) {
    throw new Error("Every feature output must identify an existing body or an appended output body.");
  }

  return reviseCadDocument(document, operationId, (project) => ({
    ...project,
    components: project.components.map((candidate) => candidate.id === component.id
      ? {
          ...candidate,
          featureIds: [...candidate.featureIds, feature.id],
          bodyIds: [...candidate.bodyIds, ...outputBodies.map((body) => body.id)]
        }
      : candidate),
    features: [...project.features, structuredClone(feature) as CadFeature],
    bodies: [...project.bodies, ...outputBodies.map((body) => structuredClone(body) as CadBody)]
  }));
}

export function updateFeature(
  document: CadDocument,
  operationId: string,
  featureId: FeatureId,
  update: (feature: CadFeature) => CadFeature
): CadDocument {
  const current = requireFeature(document.project, featureId);
  const replacement = update(structuredClone(current) as CadFeature);
  if (replacement.id !== current.id || replacement.componentId !== current.componentId) {
    throw new Error("A feature update cannot change feature identity or ownership.");
  }
  return reviseCadDocument(document, operationId, (project) => ({
    ...project,
    features: project.features.map((feature) => feature.id === featureId
      ? structuredClone(replacement) as CadFeature
      : feature)
  }));
}

export function setFeatureSuppressed(
  document: CadDocument,
  operationId: string,
  featureId: FeatureId,
  suppressed: boolean
): CadDocument {
  return updateFeature(document, operationId, featureId, (feature) => ({
    ...feature,
    suppressed,
    status: suppressed ? "suppressed" : "dirty",
    evaluationRevision: suppressed ? document.revision + 1 : feature.evaluationRevision,
    diagnostics: suppressed ? [] : feature.diagnostics
  }));
}

export function setFeatureEvaluation(
  document: CadDocument,
  operationId: string,
  featureId: FeatureId,
  status: EvaluationStatus,
  diagnostics: readonly CadDiagnostic[]
): CadDocument {
  const feature = requireFeature(document.project, featureId);
  if (feature.suppressed && status !== "suppressed") throw new Error("A suppressed feature must retain suppressed status.");
  return updateFeature(document, operationId, featureId, (candidate) => ({
    ...candidate,
    status,
    evaluationRevision: document.revision + 1,
    diagnostics: structuredClone(diagnostics) as readonly CadDiagnostic[]
  }));
}

export function setComponentRollback(
  document: CadDocument,
  operationId: string,
  componentId: ComponentId,
  rollbackAfterFeatureId: FeatureId | null
): CadDocument {
  const component = requireComponent(document.project, componentId);
  if (rollbackAfterFeatureId !== null && !component.featureIds.includes(rollbackAfterFeatureId)) {
    throw new Error("The rollback point must be in the component timeline.");
  }
  return reviseCadDocument(document, operationId, (project) => ({
    ...project,
    components: project.components.map((candidate) => candidate.id === componentId
      ? { ...candidate, rollbackAfterFeatureId }
      : candidate)
  }));
}

export function reviseCadDocument(
  document: CadDocument,
  operationId: string,
  update: (project: CadProject) => CadProject
): CadDocument {
  assertOperationId(operationId);
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) throw new Error("Cannot revise an invalid document revision.");
  const project = update(structuredClone(document.project) as CadProject);
  const next: CadDocument = {
    ...document,
    revision: document.revision + 1,
    parentRevision: document.revision,
    lastOperationId: operationId,
    project
  };
  return deepFreeze(next);
}

export function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireComponent(project: CadProject, id: ComponentId): CadComponent {
  const component = project.components.find((candidate) => candidate.id === id);
  if (component === undefined) throw new Error(`Component does not exist: ${id}`);
  return component;
}

function requireFeature(project: CadProject, id: FeatureId): CadFeature {
  const feature = project.features.find((candidate) => candidate.id === id);
  if (feature === undefined) throw new Error(`Feature does not exist: ${id}`);
  return feature;
}

function appendUnique<Value>(values: readonly Value[], value: Value): readonly Value[] {
  return values.includes(value) ? values : [...values, value];
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) throw new TypeError("Operation IDs must be stable lowercase prefixed IDs.");
}

function assertName(name: string, kind: string): void {
  if (name.trim().length === 0 || name.length > 160) throw new TypeError(`A ${kind} name must contain 1-160 characters.`);
}
