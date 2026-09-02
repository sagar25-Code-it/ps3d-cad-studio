import {
  appendFeature,
  cadReference,
  createCadId,
  createCadScopedId,
  createEmptyCadDocument,
  reviseCadDocument,
  type CadBody,
  type CadDocument,
  type CadFeature,
  type CadSketch
} from "@ps3d/cad-document-core/src/index.js";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  RecordedExactKernelAdapter,
  createRecordedEvidenceDigest,
  kernelSha256,
  type ExactKernelCapabilities,
  type ExecuteKernelOperationRequest,
  type ExtrudeOperation,
  type FixtureRegistrationResult,
  type KernelIdentity,
  type OperationResultDraft,
  type RecordedOperationFixture,
  type ShapeReference
} from "@ps3d/exact-kernel-api/src/index.js";
import {
  analyticSketchSolver,
  type ParametricSketchDocument,
  type SketchSolveResult
} from "@ps3d/parametric-sketch-core/src/index.js";
import type { FeaturePlan } from "@ps3d/ai-engineering-gateway/src/index.js";

export const PROJECT_ID = createCadId("project", "platform-acceptance");
export const COMPONENT_ID = createCadId("component", "root");
export const ORIGIN_ID = createCadId("origin", "root");
export const SKETCH_ID = createCadId("sketch", "mounting-profile");
export const FEATURE_ID = createCadId("feature", "mounting-plate-extrude");
export const BODY_ID = createCadId("body", "mounting-plate");

export const LINE_BOTTOM_ID = createCadScopedId("sketch-entity", "mounting-bottom");
export const LINE_RIGHT_ID = createCadScopedId("sketch-entity", "mounting-right");
export const LINE_TOP_ID = createCadScopedId("sketch-entity", "mounting-top");
export const LINE_LEFT_ID = createCadScopedId("sketch-entity", "mounting-left");

export const SESSION_ID = "session:platform-acceptance" as const;
export const ENGINE_REQUEST_ID = "acceptance:preview-rebuild" as const;
export const ENGINE_GENERATION = 1;

const PROFILE_BREP_SHA256 = "2ce6429e3041ad0f6f04ea89d1a946cd4e10b1f9308db37850b942ee4e89df3a";
const EXTRUDED_BREP_SHA256 = "5509f468c685a9942193c50708a28aac74c4f7995d05db15e499c26b24f75c6d";

export const RECORDED_ADAPTER_IDENTITY: KernelIdentity = {
  implementation: "ps3d-qualified-record-replay",
  implementationVersion: "1.0.0",
  kernel: "qualified-record-only",
  kernelVersion: "1",
  buildId: "acceptance-record-v1",
  executionTarget: "recorded-reference",
  contractVersion: EXACT_KERNEL_PROTOCOL_VERSION
};

export const SOURCE_KERNEL_IDENTITY: KernelIdentity = {
  implementation: "ps3d-occt-qualification-worker",
  implementationVersion: "0.1.0",
  kernel: "OpenCascade Technology",
  kernelVersion: "7.9-qualification-record",
  buildId: "occt-extrude-100x60x10-v1",
  executionTarget: "native-worker",
  contractVersion: EXACT_KERNEL_PROTOCOL_VERSION
};

export const RECORDED_CAPABILITIES: ExactKernelCapabilities = {
  capabilityVersion: "acceptance-extrude-v1",
  supportedOperations: ["solid.extrude"],
  importFormats: [],
  exportFormats: [],
  supportedContinuity: ["g0"],
  canonicalLengthUnit: "m",
  canonicalAngleUnit: "rad",
  minimumLinearToleranceMeters: 1e-9,
  maximumLinearToleranceMeters: 1e-3,
  minimumAngularToleranceRadians: 1e-10,
  deterministicForIdenticalBuildAndInputs: true,
  supportsPersistentSessions: true,
  supportsCancellation: true,
  resourceLimits: {
    maximumInputShapes: 8,
    maximumOutputShapes: 8,
    maximumTopologyEntities: 10_000,
    maximumExchangeBytes: 1_000_000,
    maximumOperationMilliseconds: 10_000
  }
};

export interface QualifiedFixtureBundle {
  readonly adapter: RecordedExactKernelAdapter;
  readonly fixture: RecordedOperationFixture;
  readonly registration: FixtureRegistrationResult;
  readonly operation: ExtrudeOperation;
  readonly solvedSketch: SketchSolveResult;
}

export function createCanonicalFixtureDocument(): CadDocument {
  let document = createEmptyCadDocument({
    projectId: PROJECT_ID,
    rootComponentId: COMPONENT_ID,
    rootOriginId: ORIGIN_ID,
    name: "Platform acceptance mounting plate",
    description: "A constrained 100 x 60 mm profile extruded to 10 mm.",
    applicationVersion: "acceptance",
    operationId: "operation:create-acceptance-document",
    units: { length: "mm", angle: "deg", mass: "kg" }
  });
  const sketch = canonicalSketch();
  document = reviseCadDocument(document, "operation:add-mounting-sketch", (project) => ({
    ...project,
    sketches: [...project.sketches, sketch],
    components: project.components.map((component) => component.id === COMPONENT_ID
      ? { ...component, sketchIds: [...component.sketchIds, SKETCH_ID] }
      : component)
  }));
  const feature: CadFeature = {
    id: FEATURE_ID,
    componentId: COMPONENT_ID,
    name: "Mounting plate extrusion",
    kind: "extrude",
    dependencies: [],
    inputs: [cadReference("sketch", SKETCH_ID)],
    parameters: [{
      name: "distance",
      label: "Extrusion distance",
      value: { expression: "plateThickness", dimension: "length", value: 0.01 },
      driving: true
    }],
    outputBodyIds: [BODY_ID],
    suppressed: false,
    status: "dirty",
    evaluationRevision: null,
    diagnostics: []
  };
  const body: CadBody = {
    id: BODY_ID,
    componentId: COMPONENT_ID,
    name: "Mounting plate",
    representation: "empty",
    geometryHandle: null,
    generatedByFeatureId: FEATURE_ID,
    topologyRevision: 0,
    visible: true,
    suppressed: false,
    materialId: null,
    status: "dirty",
    diagnostics: []
  };
  return appendFeature(document, "operation:add-mounting-extrude", feature, [body]);
}

export function createSolverSketchDocument(): ParametricSketchDocument {
  return {
    schemaVersion: "1.0",
    id: SKETCH_ID,
    revision: 0,
    plane: {
      kind: "principal",
      referenceId: "origin:root/xy",
      originMm: [0, 0, 0],
      xAxis: [1, 0, 0],
      yAxis: [0, 1, 0],
      normal: [0, 0, 1]
    },
    parameters: { plateWidth: 100, plateHeight: 60 },
    geometry: [
      line(LINE_BOTTOM_ID, [0, 0], [100, 0]),
      line(LINE_RIGHT_ID, [100, 0], [100, 60]),
      line(LINE_TOP_ID, [100, 60], [0, 60]),
      line(LINE_LEFT_ID, [0, 60], [0, 0])
    ],
    constraints: [LINE_BOTTOM_ID, LINE_RIGHT_ID, LINE_TOP_ID, LINE_LEFT_ID].map((id, index) => ({
      id: `constraint:fixed-${index + 1}`,
      kind: "fix" as const,
      target: { entityId: id, selector: "self" as const },
      suppressed: false
    })),
    dimensions: [
      {
        id: "dimension:plate-width",
        kind: "length",
        target: { entityId: LINE_BOTTOM_ID, selector: "curve" },
        unit: "mm",
        mode: "driving",
        suppressed: false,
        value: { value: 100, expression: "plateWidth" }
      },
      {
        id: "dimension:plate-height",
        kind: "length",
        target: { entityId: LINE_RIGHT_ID, selector: "curve" },
        unit: "mm",
        mode: "driving",
        suppressed: false,
        value: { value: 60, expression: "plateHeight" }
      }
    ]
  };
}

export function createStableFeaturePlan(baseRevision: number): FeaturePlan {
  return {
    schemaVersion: "ps3d-feature-plan/1",
    id: "plan:mounting-plate-acceptance",
    projectId: PROJECT_ID,
    baseRevision,
    targetComponentId: COMPONENT_ID,
    title: "Constrained mounting plate",
    engineeringGoal: "Rebuild the constrained mounting profile and create one exact 10 mm extrusion.",
    steps: [
      {
        id: "plan-step:solve-mounting-profile",
        commandId: "command:sketch",
        workspace: "sketch",
        dependsOn: [],
        intent: {
          kind: "sketch.dimension",
          resultEntityIds: [SKETCH_ID],
          references: [{
            documentId: PROJECT_ID,
            documentRevision: baseRevision,
            entityId: SKETCH_ID,
            entityKind: "sketch",
            componentPath: [COMPONENT_ID],
            semanticRole: "closed constrained mounting profile"
          }],
          parameters: [
            { name: "plateWidth", value: 100, unit: "mm", source: "user", expression: "plateWidth" },
            { name: "plateHeight", value: 60, unit: "mm", source: "user", expression: "plateHeight" }
          ],
          rationale: "The exact feature consumes the stable profile owned by this sketch.",
          acceptanceCriteria: ["Four closed lines", "Width is 100 mm", "Height is 60 mm", "Zero reported degrees of freedom"]
        }
      },
      {
        id: "plan-step:extrude-mounting-plate",
        commandId: "command:solid-create",
        workspace: "solid",
        dependsOn: ["plan-step:solve-mounting-profile"],
        intent: {
          kind: "solid.extrude",
          resultEntityIds: [BODY_ID],
          references: [{
            documentId: PROJECT_ID,
            documentRevision: baseRevision,
            entityId: SKETCH_ID,
            entityKind: "profile",
            componentPath: [COMPONENT_ID],
            semanticRole: "closed profile for new body"
          }],
          parameters: [{ name: "distance", value: 10, unit: "mm", source: "user", expression: "plateThickness" }],
          rationale: "Create the plate as one exact B-rep body from the constrained profile.",
          acceptanceCriteria: ["One closed manifold exact solid", "Thickness is 10 mm"]
        }
      }
    ],
    questions: [],
    standardsEvidence: []
  };
}

export function createBlockedFeaturePlan(baseRevision: number): FeaturePlan {
  const base = createStableFeaturePlan(baseRevision);
  return {
    ...base,
    id: "plan:mounting-plate-blocked",
    questions: [{
      id: "question:plate-thickness",
      category: "dimension",
      prompt: "What governed plate thickness is required?",
      whyRequired: "An exact extrusion cannot be created without a driving thickness.",
      relatedStepIds: ["plan-step:extrude-mounting-plate"],
      blocksPreview: true
    }],
    standardsEvidence: [{
      id: "evidence:mounting-interface",
      designation: "USER-MOUNTING-INTERFACE",
      title: "Mounting interface drawing",
      sourceKind: "user-drawing",
      sourceLocator: "awaiting-user-supplied-drawing",
      status: "unresolved",
      requiredForStepIds: ["plan-step:extrude-mounting-plate"]
    }]
  };
}

export async function createQualifiedFixtureBundle(document: CadDocument): Promise<QualifiedFixtureBundle> {
  const solvedSketch = analyticSketchSolver.solve({ document: createSolverSketchDocument(), mode: "regenerate" });
  if (solvedSketch.status !== "solved" || solvedSketch.dof.classification !== "fully-constrained") {
    throw new Error("The acceptance sketch must solve as fully constrained before an exact profile record can be used.");
  }
  const operation = createExtrudeOperation();
  const request = exactRequest(document, operation);
  const result = await recordedExtrudeResult(request);
  const evidenceDigest = await createRecordedEvidenceDigest(SOURCE_KERNEL_IDENTITY, request, result);
  const fixture: RecordedOperationFixture = {
    fixtureVersion: 1,
    request,
    result,
    evidence: {
      source: "recorded-kernel",
      sourceKernel: SOURCE_KERNEL_IDENTITY,
      evidenceDigest,
      description: "Qualified exact extrusion record for a 100 x 60 mm closed wire extruded 10 mm. Replayed only; never recalculated by the adapter."
    }
  };
  const adapter = new RecordedExactKernelAdapter(RECORDED_ADAPTER_IDENTITY, RECORDED_CAPABILITIES);
  const registration = await adapter.registerFixture(fixture);
  return { adapter, fixture, registration, operation, solvedSketch };
}

export function createUnregisteredRecordedAdapter(): RecordedExactKernelAdapter {
  return new RecordedExactKernelAdapter(RECORDED_ADAPTER_IDENTITY, RECORDED_CAPABILITIES);
}

function canonicalSketch(): CadSketch {
  return {
    id: SKETCH_ID,
    componentId: COMPONENT_ID,
    name: "Mounting profile",
    support: { kind: "origin-plane", originId: ORIGIN_ID, plane: "xy" },
    transform: { translationMeters: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    entities: [
      canonicalLine(LINE_BOTTOM_ID, [0, 0], [0.1, 0]),
      canonicalLine(LINE_RIGHT_ID, [0.1, 0], [0.1, 0.06]),
      canonicalLine(LINE_TOP_ID, [0.1, 0.06], [0, 0.06]),
      canonicalLine(LINE_LEFT_ID, [0, 0.06], [0, 0])
    ],
    constraints: [LINE_BOTTOM_ID, LINE_RIGHT_ID, LINE_TOP_ID, LINE_LEFT_ID].map((id, index) => ({
      id: createCadScopedId("sketch-constraint", `fixed-${index + 1}`),
      kind: "fix" as const,
      entityIds: [id],
      enabled: true
    })),
    dimensions: [
      {
        id: createCadScopedId("sketch-dimension", "plate-width"),
        kind: "distance",
        entityIds: [LINE_BOTTOM_ID],
        value: { expression: "plateWidth", dimension: "length", value: 0.1 },
        driving: true,
        placementMeters: [0.05, -0.01]
      },
      {
        id: createCadScopedId("sketch-dimension", "plate-height"),
        kind: "distance",
        entityIds: [LINE_RIGHT_ID],
        value: { expression: "plateHeight", dimension: "length", value: 0.06 },
        driving: true,
        placementMeters: [0.11, 0.03]
      }
    ],
    solveState: { classification: "unknown", degreesOfFreedom: null, diagnostics: [] },
    visible: true,
    suppressed: false
  };
}

function createExtrudeOperation(): ExtrudeOperation {
  const profile: ShapeReference = {
    shape: {
      shapeId: "shape:qualified-mounting-profile-wire",
      sessionId: SESSION_ID,
      revision: 2,
      kind: "wire",
      representation: "exact-brep",
      contentDigest: PROFILE_BREP_SHA256,
      toleranceMeters: 1e-7,
      boundsMeters: { min: [0, 0, 0], max: [0.1, 0.06, 0] },
      topology: { vertices: 4, edges: 4, wires: 1, faces: 0, shells: 0, solids: 0, components: 1, closed: true, manifold: true }
    }
  };
  return {
    operationId: FEATURE_ID,
    kind: "solid.extrude",
    semanticOutputIds: [BODY_ID],
    linearToleranceMeters: 1e-7,
    angularToleranceRadians: 1e-9,
    expectedOutputCount: 1,
    profiles: [profile],
    direction: [0, 0, 1],
    extent: { kind: "distance", distanceMeters: 0.01, symmetric: false },
    taperAngleRadians: 0,
    outputMode: "new-body",
    targets: []
  };
}

function exactRequest(document: CadDocument, operation: ExtrudeOperation): ExecuteKernelOperationRequest {
  return {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "kernel:fixture-registration",
    generation: ENGINE_GENERATION,
    documentId: document.project.id,
    documentRevision: document.revision,
    kind: "execute",
    sessionId: SESSION_ID,
    expectedCapabilityVersion: RECORDED_CAPABILITIES.capabilityVersion,
    operation
  };
}

async function recordedExtrudeResult(request: ExecuteKernelOperationRequest): Promise<OperationResultDraft> {
  const output = {
    shapeId: "shape:qualified-mounting-plate-solid",
    sessionId: request.sessionId,
    revision: request.documentRevision,
    kind: "solid" as const,
    representation: "exact-brep" as const,
    contentDigest: EXTRUDED_BREP_SHA256,
    toleranceMeters: 1e-7,
    boundsMeters: { min: [0, 0, 0] as const, max: [0.1, 0.06, 0.01] as const },
    topology: { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true }
  };
  const inputShapeDigests = [PROFILE_BREP_SHA256];
  const outputShapeDigests = [EXTRUDED_BREP_SHA256];
  return {
    operationId: request.operation.operationId,
    operationKind: request.operation.kind,
    outputs: [output],
    validation: [{
      valid: true,
      exact: true,
      checkedToleranceMeters: 1e-7,
      closed: true,
      manifold: true,
      orientable: true,
      finite: true,
      selfIntersections: 0,
      invalidEntityReferenceKeys: [],
      diagnostics: []
    }],
    provenance: {
      operationId: request.operation.operationId,
      operationKind: request.operation.kind,
      inputShapeDigests,
      outputShapeDigests,
      topologyEntities: [],
      provenanceDigest: await kernelSha256({
        sourceKernel: SOURCE_KERNEL_IDENTITY,
        operationId: request.operation.operationId,
        inputShapeDigests,
        outputShapeDigests
      })
    },
    diagnostics: [],
    exchangeArtifacts: [],
    tessellations: [],
    topologyEntities: []
  };
}

function line(id: string, start: readonly [number, number], end: readonly [number, number]) {
  return { id, kind: "line" as const, start, end, construction: false, suppressed: false };
}

function canonicalLine(
  id: typeof LINE_BOTTOM_ID,
  startMeters: readonly [number, number],
  endMeters: readonly [number, number]
) {
  return { id, type: "line" as const, startMeters, endMeters, construction: false };
}
