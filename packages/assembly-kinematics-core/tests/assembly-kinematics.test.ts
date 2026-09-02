import {
  ASSEMBLY_IDENTITY_TRANSFORM,
  ASSEMBLY_SCHEMA_VERSION,
  accountAssemblyDegreesOfFreedom,
  analyzeClearance,
  analyzeInterference,
  buildAssemblyDependencyGraph,
  evaluateAssemblyKinematics,
  interpolateExplodedRepresentation,
  validateAssemblyDefinition,
  type AssemblyDefinition,
  type AssemblyJoint,
  type ComponentId,
  type CollisionAnalysisAdapter,
  type JointId,
  type JointOrigin,
  type OccurrenceId,
  type Transform3
} from "../src/index.js";
import { assert, equal, near } from "./test-kit.js";

interface TestCase {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

const ROOT = "component:root" as ComponentId;
const PART = "component:part" as ComponentId;
const BASE = "occurrence:base" as OccurrenceId;
const MOVING = "occurrence:moving" as OccurrenceId;
const THIRD = "occurrence:third" as OccurrenceId;

function transform(x = 0, y = 0, z = 0): Transform3 {
  return { translationMeters: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function origin(id: string, occurrenceId: OccurrenceId, localTransform = ASSEMBLY_IDENTITY_TRANSFORM): JointOrigin {
  return { id, occurrenceId, localTransform, geometry: null };
}

function baseAssembly(
  joints: readonly AssemblyJoint[] = [],
  jointOrigins: readonly JointOrigin[] = [],
  occurrenceIds: readonly OccurrenceId[] = [BASE, MOVING]
): AssemblyDefinition {
  return {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    rootComponentId: ROOT,
    components: [
      { id: ROOT, name: "Assembly", revision: 0 },
      { id: PART, name: "Part", revision: 0 }
    ],
    occurrences: occurrenceIds.map((id, index) => ({
      id,
      ownerComponentId: ROOT,
      componentDefinitionId: PART,
      parentOccurrenceId: null,
      name: id,
      initialTransform: transform(index, 0, 0),
      grounded: index === 0,
      suppressed: false
    })),
    rigidGroups: [],
    jointOrigins,
    joints,
    motionLinks: []
  };
}

function twoOriginJoint<Type extends AssemblyJoint["type"]>(
  type: Type,
  extra: Omit<Extract<AssemblyJoint, { readonly type: Type }>, "id" | "ownerComponentId" | "name" | "type" | "firstOriginId" | "secondOriginId" | "suppressed">
): { readonly joint: AssemblyJoint; readonly origins: readonly JointOrigin[] } {
  const id = `joint:${type}` as JointId;
  const joint = {
    id,
    ownerComponentId: ROOT,
    name: type,
    type,
    firstOriginId: `${type}-first`,
    secondOriginId: `${type}-second`,
    suppressed: false,
    ...extra
  } as Extract<AssemblyJoint, { readonly type: Type }>;
  return { joint, origins: [origin(`${type}-first`, BASE), origin(`${type}-second`, MOVING)] };
}

export const assemblyKinematicsTests: readonly TestCase[] = [
  {
    name: "keeps component definitions separate from positioned occurrences",
    run: () => {
      const assembly = baseAssembly();
      const validated = validateAssemblyDefinition(assembly);
      assert(validated.ok, "well-formed definition should validate");
      equal(assembly.components.length, 2, "two reusable definitions");
      equal(assembly.occurrences.length, 2, "two positioned occurrences");
      const broken: AssemblyDefinition = {
        ...assembly,
        occurrences: [{ ...assembly.occurrences[0]!, componentDefinitionId: "component:missing" as ComponentId }]
      };
      const rejected = validateAssemblyDefinition(broken);
      assert(!rejected.ok && rejected.diagnostics.some(({ code }) => code === "MISSING_COMPONENT"), "missing definitions are rejected");
    }
  },
  {
    name: "evaluates rigid, revolute, slider, and cylindrical transforms analytically",
    run: () => {
      const cases = [
        { type: "rigid" as const, extra: {}, input: {}, expectedZ: 0, expectedQuarterTurn: false },
        { type: "revolute" as const, extra: { angularLimit: null }, input: { angleRadians: Math.PI / 2 }, expectedZ: 0, expectedQuarterTurn: true },
        { type: "slider" as const, extra: { linearLimit: null }, input: { offsetMeters: 0.25 }, expectedZ: 0.25, expectedQuarterTurn: false },
        { type: "cylindrical" as const, extra: { angularLimit: null, linearLimit: null }, input: { angleRadians: Math.PI / 2, offsetMeters: 0.4 }, expectedZ: 0.4, expectedQuarterTurn: true }
      ];
      for (const candidate of cases) {
        const pair = twoOriginJoint(candidate.type, candidate.extra as never);
        const assembly = baseAssembly([pair.joint], pair.origins);
        const result = evaluateAssemblyKinematics({
          assembly,
          coordinates: [{ jointId: pair.joint.id, coordinates: candidate.input }],
          tolerance: { translationMeters: 1e-9, rotationRadians: 1e-9 }
        });
        assert(result.ok, `${candidate.type} evaluation should succeed`);
        const moving = result.value.occurrenceTransforms[MOVING];
        assert(moving !== undefined, "moving transform should exist");
        near(moving.translationMeters[2], candidate.expectedZ, 1e-12, `${candidate.type} Z translation`);
        near(Math.abs(moving.rotation[2]), candidate.expectedQuarterTurn ? Math.SQRT1_2 : 0, 1e-12, `${candidate.type} Z rotation`);
      }
    }
  },
  {
    name: "applies deterministic motion links before transform propagation",
    run: () => {
      const sourceId = "joint:source" as JointId;
      const targetId = "joint:target" as JointId;
      const source: AssemblyJoint = { id: sourceId, ownerComponentId: ROOT, name: "source", type: "revolute", firstOriginId: "s1", secondOriginId: "s2", angularLimit: null, suppressed: false };
      const target: AssemblyJoint = { id: targetId, ownerComponentId: ROOT, name: "target", type: "slider", firstOriginId: "t1", secondOriginId: "t2", linearLimit: null, suppressed: false };
      const assembly: AssemblyDefinition = {
        ...baseAssembly([source, target], [origin("s1", BASE), origin("s2", MOVING), origin("t1", MOVING), origin("t2", THIRD)], [BASE, MOVING, THIRD]),
        motionLinks: [{ id: "motion:one", sourceJointId: sourceId, sourceCoordinate: "angleRadians", targetJointId: targetId, targetCoordinate: "offsetMeters", ratio: 0.1, offset: 0.02, enabled: true }]
      };
      const result = evaluateAssemblyKinematics({ assembly, coordinates: [{ jointId: sourceId, coordinates: { angleRadians: 2 } }], tolerance: { translationMeters: 1e-9, rotationRadians: 1e-9 } });
      assert(result.ok, "linked assembly should solve");
      near(result.value.resolvedCoordinates[targetId]?.offsetMeters ?? -1, 0.22, 1e-12, "motion-linked target coordinate");
      near(result.value.occurrenceTransforms[THIRD]?.translationMeters[2] ?? -1, 0.22, 1e-12, "linked slider transform");
    }
  },
  {
    name: "refuses to approximate unqualified nonlinear joints",
    run: () => {
      const pair = twoOriginJoint("planar", { xLimit: null, yLimit: null, angularLimit: null });
      const result = evaluateAssemblyKinematics({ assembly: baseAssembly([pair.joint], pair.origins), coordinates: [], tolerance: { translationMeters: 1e-9, rotationRadians: 1e-9 } });
      assert(!result.ok && result.diagnostics.some(({ code }) => code === "UNSUPPORTED_JOINT_EVALUATION"), "planar evaluator should be refused explicitly");
    }
  },
  {
    name: "builds deterministic graphs and reports nominal degrees of freedom",
    run: () => {
      const pair = twoOriginJoint("revolute", { angularLimit: null });
      const assembly = baseAssembly([pair.joint], pair.origins);
      const graph = buildAssemblyDependencyGraph(assembly);
      equal(graph.connectedComponents.length, 1, "joint joins one connected component");
      equal(graph.cycleJointIds.length, 0, "single edge has no cycle");
      const dof = accountAssemblyDegreesOfFreedom(assembly);
      equal(dof.freeBodyDof, 12, "two free bodies start with 12 DOF");
      equal(dof.groundedReduction, 6, "one ground removes 6 DOF");
      equal(dof.jointConstraintReduction, 5, "revolute removes 5 DOF");
      equal(dof.residualDof, 1, "one revolute coordinate remains");
    }
  },
  {
    name: "caps exploded displacement by supplied assembly envelope",
    run: () => {
      const result = interpolateExplodedRepresentation(
        { [MOVING]: transform() },
        { id: "explode:main", name: "Main", maximumEnvelopeFraction: 0.5, steps: [{ occurrenceId: MOVING, direction: [1, 0, 0], requestedDistanceMeters: 10, startFraction: 0, endFraction: 1 }] },
        { dimensionsMeters: [2, 1, 1] },
        1
      );
      assert(result.ok, "exploded interpolation should succeed");
      near(result.value.appliedDistancesMeters[MOVING] ?? -1, 1, 1e-12, "50% of 2 m envelope cap");
      near(result.value.transforms[MOVING]?.translationMeters[0] ?? -1, 1, 1e-12, "capped transform offset");
    }
  },
  {
    name: "requires measured envelope and exact collision adapters",
    run: async () => {
      const missingEnvelope = interpolateExplodedRepresentation({ [MOVING]: transform() }, { id: "explode:main", name: "Main", maximumEnvelopeFraction: 0.5, steps: [] }, null, 0.5);
      assert(!missingEnvelope.ok && missingEnvelope.diagnostics[0]?.code === "MISSING_ENVELOPE", "missing geometry envelope is not invented");
      const collision = await analyzeInterference({
        requestId: "collision:one",
        geometry: [
          { occurrenceId: BASE, geometryHandle: "brep:a", geometryRevision: 1, transform: transform() },
          { occurrenceId: MOVING, geometryHandle: "brep:b", geometryRevision: 1, transform: transform() }
        ],
        pairs: [{ firstOccurrenceId: BASE, secondOccurrenceId: MOVING }],
        toleranceMeters: 1e-7
      });
      assert(!collision.ok && collision.diagnostics[0]?.code === "COLLISION_ADAPTER_REQUIRED", "collision result is never fabricated");
    }
  },
  {
    name: "rejects unsupported joint coordinates and unrequested collision findings",
    run: async () => {
      const pair = twoOriginJoint("revolute", { angularLimit: null });
      const coordinates = evaluateAssemblyKinematics({
        assembly: baseAssembly([pair.joint], pair.origins),
        coordinates: [{ jointId: pair.joint.id, coordinates: { offsetMeters: 1 } }],
        tolerance: { translationMeters: 1e-9, rotationRadians: 1e-9 }
      });
      assert(!coordinates.ok && coordinates.diagnostics.some(({ code }) => code === "COORDINATE_OUT_OF_RANGE"), "unsupported coordinates fail closed");

      const adapter: CollisionAnalysisAdapter = {
        adapterId: "adapter:unbound-result",
        async analyzeInterference() {
          return { ok: true, value: [{ pair: { firstOccurrenceId: BASE, secondOccurrenceId: THIRD }, volumeCubicMeters: 1e-6, evidenceHandle: "evidence:wrong-pair" }], diagnostics: [] };
        },
        async analyzeClearance() {
          return { ok: true, value: [{ pair: { firstOccurrenceId: BASE, secondOccurrenceId: THIRD }, minimumDistanceMeters: 0.1, firstClosestPointMeters: [0, 0, 0], secondClosestPointMeters: [0, 0, 0], evidenceHandle: "evidence:wrong-pair" }], diagnostics: [] };
        }
      };
      const request = {
        requestId: "collision:bound-pair",
        geometry: [
          { occurrenceId: BASE, geometryHandle: "brep:a", geometryRevision: 1, transform: transform() },
          { occurrenceId: MOVING, geometryHandle: "brep:b", geometryRevision: 1, transform: transform() }
        ],
        pairs: [{ firstOccurrenceId: BASE, secondOccurrenceId: MOVING }],
        toleranceMeters: 1e-7
      };
      const interference = await analyzeInterference(request, adapter);
      assert(!interference.ok && interference.diagnostics.some(({ code }) => code === "STALE_GEOMETRY_REFERENCE"), "unrequested interference pair is rejected");
      const clearance = await analyzeClearance({ ...request, requiredClearanceMeters: 0.01 }, adapter);
      assert(!clearance.ok && clearance.diagnostics.some(({ code }) => code === "STALE_GEOMETRY_REFERENCE"), "unrequested clearance pair is rejected");
    }
  }
];
