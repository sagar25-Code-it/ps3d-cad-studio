import type { JointId, Transform3 } from "./canonical.js";
import { isFiniteNumber, isFiniteVec3, normalizeQuaternion } from "./math.js";
import type {
  AssemblyDefinition,
  AssemblyDiagnostic,
  AssemblyJoint,
  AssemblyResult,
  MotionCoordinate,
  ScalarLimit
} from "./types.js";

function error(
  code: AssemblyDiagnostic["code"],
  message: string,
  relatedIds: readonly string[],
  recovery: string
): AssemblyDiagnostic {
  return { code, severity: "error", message, relatedIds, recovery };
}

export function validateRigidTransform(transform: Transform3, relatedId: string): readonly AssemblyDiagnostic[] {
  const diagnostics: AssemblyDiagnostic[] = [];
  const quaternionMagnitude = Math.hypot(...transform.rotation);
  if (!isFiniteVec3(transform.translationMeters)
    || !isFiniteVec3(transform.scale)
    || normalizeQuaternion(transform.rotation) === null
    || Math.abs(quaternionMagnitude - 1) > 1e-9) {
    diagnostics.push(error(
      "INVALID_TRANSFORM",
      "Assembly transforms require finite translation, scale, and a non-zero quaternion.",
      [relatedId],
      "Replace non-finite transform values and supply a normalized rigid rotation."
    ));
  }
  if (transform.scale.some((value) => Math.abs(value - 1) > 1e-12)) {
    diagnostics.push(error(
      "INVALID_TRANSFORM",
      "Assembly kinematics accept rigid transforms only; occurrence scale must be [1, 1, 1].",
      [relatedId],
      "Bake scale into component geometry before assembly evaluation."
    ));
  }
  return diagnostics;
}

function validateLimit(limit: ScalarLimit | null, jointId: JointId, label: string): readonly AssemblyDiagnostic[] {
  if (limit === null) return [];
  const values = [limit.minimum, limit.maximum, limit.rest].filter((value): value is number => value !== null);
  if (!values.every(isFiniteNumber)
    || (limit.minimum !== null && limit.maximum !== null && limit.minimum > limit.maximum)
    || (limit.minimum !== null && limit.rest < limit.minimum)
    || (limit.maximum !== null && limit.rest > limit.maximum)) {
    return [error(
      "INVALID_LIMIT",
      `${label} limit is non-finite, inverted, or does not contain its rest value.`,
      [jointId],
      "Use finite values with minimum <= rest <= maximum."
    )];
  }
  return [];
}

export function jointSupportsCoordinate(joint: AssemblyJoint, coordinate: MotionCoordinate): boolean {
  switch (coordinate) {
    case "angleRadians":
      return joint.type === "revolute" || joint.type === "cylindrical" || joint.type === "pin-slot" || joint.type === "planar";
    case "offsetMeters":
      return joint.type === "slider" || joint.type === "cylindrical";
    case "slotPositionMeters":
      return joint.type === "pin-slot";
    case "planarXMeters":
    case "planarYMeters":
      return joint.type === "planar";
    case "swingRadians":
    case "twistRadians":
      return joint.type === "ball";
  }
}

function jointLimits(joint: AssemblyJoint): readonly (readonly [string, ScalarLimit | null])[] {
  switch (joint.type) {
    case "rigid": return [];
    case "revolute": return [["angular", joint.angularLimit]];
    case "slider": return [["linear", joint.linearLimit]];
    case "cylindrical": return [["angular", joint.angularLimit], ["linear", joint.linearLimit]];
    case "pin-slot": return [["slot", joint.slotLimit], ["angular", joint.angularLimit]];
    case "planar": return [["x", joint.xLimit], ["y", joint.yLimit], ["angular", joint.angularLimit]];
    case "ball": return [["swing", joint.swingLimit], ["twist", joint.twistLimit]];
  }
}

function findMotionLinkCycles(assembly: AssemblyDefinition): readonly JointId[] {
  const adjacency = new Map<JointId, JointId[]>();
  for (const link of assembly.motionLinks.filter((candidate) => candidate.enabled)) {
    const targets = adjacency.get(link.sourceJointId) ?? [];
    targets.push(link.targetJointId);
    adjacency.set(link.sourceJointId, targets);
  }
  const state = new Map<JointId, "visiting" | "visited">();
  const cyclic = new Set<JointId>();
  const visit = (jointId: JointId, path: readonly JointId[]): void => {
    const current = state.get(jointId);
    if (current === "visiting") {
      const start = path.indexOf(jointId);
      for (const id of path.slice(Math.max(0, start))) cyclic.add(id);
      cyclic.add(jointId);
      return;
    }
    if (current === "visited") return;
    state.set(jointId, "visiting");
    for (const target of (adjacency.get(jointId) ?? []).toSorted()) visit(target, [...path, jointId]);
    state.set(jointId, "visited");
  };
  for (const jointId of [...adjacency.keys()].toSorted()) visit(jointId, []);
  return [...cyclic].toSorted();
}

export function validateAssemblyDefinition(assembly: AssemblyDefinition): AssemblyResult<AssemblyDefinition> {
  const diagnostics: AssemblyDiagnostic[] = [];
  const allIds = [
    ...assembly.components.map(({ id }) => id),
    ...assembly.occurrences.map(({ id }) => id),
    ...assembly.rigidGroups.map(({ id }) => id),
    ...assembly.jointOrigins.map(({ id }) => id),
    ...assembly.joints.map(({ id }) => id),
    ...assembly.motionLinks.map(({ id }) => id)
  ];
  const seen = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) diagnostics.push(error("DUPLICATE_ID", `Duplicate assembly ID '${id}'.`, [id], "Assign globally unique stable IDs."));
    seen.add(id);
  }

  const components = new Map(assembly.components.map((component) => [component.id, component]));
  const occurrences = new Map(assembly.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const origins = new Map(assembly.jointOrigins.map((origin) => [origin.id, origin]));
  const joints = new Map(assembly.joints.map((joint) => [joint.id, joint]));
  if (!components.has(assembly.rootComponentId)) {
    diagnostics.push(error("MISSING_COMPONENT", "The root component definition does not exist.", [assembly.rootComponentId], "Add the root component definition."));
  }

  for (const occurrence of assembly.occurrences) {
    if (!components.has(occurrence.ownerComponentId) || !components.has(occurrence.componentDefinitionId)) {
      diagnostics.push(error(
        "MISSING_COMPONENT",
        `Occurrence '${occurrence.id}' refers to a missing owner or reusable component definition.`,
        [occurrence.id, occurrence.ownerComponentId, occurrence.componentDefinitionId],
        "Create the definitions or repair the occurrence references."
      ));
    }
    if (occurrence.parentOccurrenceId !== null && !occurrences.has(occurrence.parentOccurrenceId)) {
      diagnostics.push(error("MISSING_OCCURRENCE", `Occurrence '${occurrence.id}' has a missing parent.`, [occurrence.id, occurrence.parentOccurrenceId], "Repair or clear the parent occurrence reference."));
    }
    diagnostics.push(...validateRigidTransform(occurrence.initialTransform, occurrence.id));
  }
  const occurrenceState = new Map<string, "visiting" | "visited">();
  const visitOccurrence = (occurrenceId: string, path: readonly string[]): void => {
    if (occurrenceState.get(occurrenceId) === "visiting") {
      const cycleStart = path.indexOf(occurrenceId);
      diagnostics.push(error(
        "DEPENDENCY_CYCLE",
        "Occurrence parent references contain a cycle.",
        [...path.slice(Math.max(0, cycleStart)), occurrenceId],
        "Repair the parentOccurrenceId chain so every path terminates."
      ));
      return;
    }
    if (occurrenceState.get(occurrenceId) === "visited") return;
    occurrenceState.set(occurrenceId, "visiting");
    const occurrence = assembly.occurrences.find(({ id }) => id === occurrenceId);
    if (occurrence?.parentOccurrenceId !== null && occurrence?.parentOccurrenceId !== undefined) {
      visitOccurrence(occurrence.parentOccurrenceId, [...path, occurrenceId]);
    }
    occurrenceState.set(occurrenceId, "visited");
  };
  for (const occurrence of assembly.occurrences.toSorted((a, b) => a.id.localeCompare(b.id))) visitOccurrence(occurrence.id, []);

  for (const origin of assembly.jointOrigins) {
    if (!occurrences.has(origin.occurrenceId)) {
      diagnostics.push(error("MISSING_OCCURRENCE", `Joint origin '${origin.id}' refers to a missing occurrence.`, [origin.id, origin.occurrenceId], "Repair the joint origin occurrence reference."));
    }
    diagnostics.push(...validateRigidTransform(origin.localTransform, origin.id));
    if (origin.geometry !== null && (origin.geometry.bodyId.length === 0
      || origin.geometry.persistentTopologyName.length === 0
      || !Number.isSafeInteger(origin.geometry.topologyRevision)
      || origin.geometry.topologyRevision < 0)) {
      diagnostics.push(error("STALE_GEOMETRY_REFERENCE", `Joint origin '${origin.id}' has an invalid exact-geometry association.`, [origin.id], "Resolve a current persistent topology name and non-negative topology revision."));
    }
  }

  const rigidGroupMembership = new Map<string, string>();
  for (const group of assembly.rigidGroups.filter((candidate) => !candidate.suppressed)) {
    if (!components.has(group.ownerComponentId)) {
      diagnostics.push(error("MISSING_COMPONENT", `Rigid group '${group.id}' has a missing owner component.`, [group.id, group.ownerComponentId], "Repair the owner component reference."));
    }
    if (group.occurrenceIds.length < 2 || new Set(group.occurrenceIds).size !== group.occurrenceIds.length) {
      diagnostics.push(error("RIGID_GROUP_CONFLICT", `Rigid group '${group.id}' must contain at least two unique occurrences.`, [group.id], "Use two or more unique occurrence IDs."));
    }
    for (const occurrenceId of group.occurrenceIds) {
      if (!occurrences.has(occurrenceId)) {
        diagnostics.push(error("MISSING_OCCURRENCE", `Rigid group '${group.id}' refers to a missing occurrence.`, [group.id, occurrenceId], "Repair the rigid-group membership."));
      }
      const existing = rigidGroupMembership.get(occurrenceId);
      if (existing !== undefined) {
        diagnostics.push(error("RIGID_GROUP_CONFLICT", `Occurrence '${occurrenceId}' belongs to multiple active rigid groups.`, [occurrenceId, existing, group.id], "Merge the rigid groups or suppress one."));
      }
      rigidGroupMembership.set(occurrenceId, group.id);
    }
  }

  for (const joint of assembly.joints) {
    if (!components.has(joint.ownerComponentId)) {
      diagnostics.push(error("MISSING_COMPONENT", `Joint '${joint.id}' has a missing owner component.`, [joint.id, joint.ownerComponentId], "Repair the owner component reference."));
    }
    const first = origins.get(joint.firstOriginId);
    const second = origins.get(joint.secondOriginId);
    if (first === undefined || second === undefined) {
      diagnostics.push(error("MISSING_JOINT_ORIGIN", `Joint '${joint.id}' has a missing origin.`, [joint.id, joint.firstOriginId, joint.secondOriginId], "Create or repair both joint origins."));
    } else if (first.occurrenceId === second.occurrenceId) {
      diagnostics.push(error("INVALID_AXIS", `Joint '${joint.id}' constrains one occurrence to itself.`, [joint.id, first.occurrenceId], "Select origins on two distinct occurrences."));
    }
    for (const [label, limit] of jointLimits(joint)) diagnostics.push(...validateLimit(limit, joint.id, label));
  }

  for (const link of assembly.motionLinks.filter((candidate) => candidate.enabled)) {
    const source = joints.get(link.sourceJointId);
    const target = joints.get(link.targetJointId);
    if (source === undefined || target === undefined) {
      diagnostics.push(error("MISSING_JOINT", `Motion link '${link.id}' refers to a missing joint.`, [link.id, link.sourceJointId, link.targetJointId], "Repair the motion-link joint references."));
      continue;
    }
    if (!jointSupportsCoordinate(source, link.sourceCoordinate)
      || !jointSupportsCoordinate(target, link.targetCoordinate)
      || !isFiniteNumber(link.ratio)
      || !isFiniteNumber(link.offset)) {
      diagnostics.push(error("INVALID_MOTION_LINK", `Motion link '${link.id}' uses an unsupported coordinate or non-finite mapping.`, [link.id], "Choose coordinates supported by both joint types and finite ratio/offset values."));
    }
  }
  const cyclicJoints = findMotionLinkCycles(assembly);
  if (cyclicJoints.length > 0) diagnostics.push(error("MOTION_LINK_CYCLE", "Motion links contain a dependency cycle.", cyclicJoints, "Remove one link from the cycle."));

  return diagnostics.some(({ severity }) => severity === "error")
    ? { ok: false, diagnostics }
    : { ok: true, value: assembly, diagnostics };
}
