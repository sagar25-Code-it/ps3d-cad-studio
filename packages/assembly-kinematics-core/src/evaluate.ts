import type { JointId, OccurrenceId, Transform3 } from "./canonical.js";
import { buildAssemblyDependencyGraph } from "./graph.js";
import {
  composeTransforms,
  inverseRigidTransform,
  transformDifference,
  zAxisMotionTransform
} from "./math.js";
import type {
  AssemblyDiagnostic,
  AssemblyEvaluation,
  AssemblyEvaluationRequest,
  AssemblyJoint,
  AssemblyResult,
  JointCoordinates,
  MotionCoordinate,
  ScalarLimit
} from "./types.js";
import { jointSupportsCoordinate, validateAssemblyDefinition } from "./validation.js";

const MOTION_COORDINATES: readonly MotionCoordinate[] = [
  "angleRadians",
  "offsetMeters",
  "slotPositionMeters",
  "planarXMeters",
  "planarYMeters",
  "swingRadians",
  "twistRadians"
];

function failure(
  code: AssemblyDiagnostic["code"],
  message: string,
  relatedIds: readonly string[],
  recovery: string
): AssemblyDiagnostic {
  return { code, severity: "error", message, relatedIds, recovery };
}

function defaultCoordinates(joint: AssemblyJoint): JointCoordinates {
  switch (joint.type) {
    case "rigid": return {};
    case "revolute": return { angleRadians: joint.angularLimit?.rest ?? 0 };
    case "slider": return { offsetMeters: joint.linearLimit?.rest ?? 0 };
    case "cylindrical": return {
      angleRadians: joint.angularLimit?.rest ?? 0,
      offsetMeters: joint.linearLimit?.rest ?? 0
    };
    case "pin-slot": return {
      angleRadians: joint.angularLimit?.rest ?? 0,
      slotPositionMeters: joint.slotLimit?.rest ?? 0
    };
    case "planar": return {
      planarXMeters: joint.xLimit?.rest ?? 0,
      planarYMeters: joint.yLimit?.rest ?? 0,
      angleRadians: joint.angularLimit?.rest ?? 0
    };
    case "ball": return {
      swingRadians: joint.swingLimit?.rest ?? 0,
      twistRadians: joint.twistLimit?.rest ?? 0
    };
  }
}

function readCoordinate(coordinates: JointCoordinates, coordinate: MotionCoordinate): number {
  return coordinates[coordinate] ?? 0;
}

function writeCoordinate(coordinates: JointCoordinates, coordinate: MotionCoordinate, value: number): JointCoordinates {
  return { ...coordinates, [coordinate]: value };
}

function coordinateLimit(joint: AssemblyJoint, coordinate: MotionCoordinate): ScalarLimit | null {
  switch (coordinate) {
    case "angleRadians":
      switch (joint.type) {
        case "revolute":
        case "cylindrical":
        case "pin-slot": return joint.angularLimit;
        default: return null;
      }
    case "offsetMeters":
      switch (joint.type) {
        case "slider":
        case "cylindrical": return joint.linearLimit;
        default: return null;
      }
    case "slotPositionMeters": return joint.type === "pin-slot" ? joint.slotLimit : null;
    case "planarXMeters": return joint.type === "planar" ? joint.xLimit : null;
    case "planarYMeters": return joint.type === "planar" ? joint.yLimit : null;
    case "swingRadians": return joint.type === "ball" ? joint.swingLimit : null;
    case "twistRadians": return joint.type === "ball" ? joint.twistLimit : null;
  }
}

function limitDiagnostics(joint: AssemblyJoint, coordinates: JointCoordinates): readonly AssemblyDiagnostic[] {
  const checked: readonly MotionCoordinate[] = [
    "angleRadians",
    "offsetMeters",
    "slotPositionMeters",
    "planarXMeters",
    "planarYMeters",
    "swingRadians",
    "twistRadians"
  ];
  const diagnostics: AssemblyDiagnostic[] = [];
  for (const coordinate of checked) {
    const value = coordinates[coordinate];
    if (value === undefined) continue;
    const limit = coordinateLimit(joint, coordinate);
    if (!Number.isFinite(value)
      || (limit?.minimum !== null && limit?.minimum !== undefined && value < limit.minimum)
      || (limit?.maximum !== null && limit?.maximum !== undefined && value > limit.maximum)) {
      diagnostics.push(failure(
        "COORDINATE_OUT_OF_RANGE",
        `Coordinate '${coordinate}' for joint '${joint.id}' is non-finite or outside its configured limits.`,
        [joint.id],
        "Provide a finite coordinate within the joint limits; the evaluator does not silently clamp engineering inputs."
      ));
    }
  }
  return diagnostics;
}

function jointMotion(joint: AssemblyJoint, coordinates: JointCoordinates): Transform3 | null {
  switch (joint.type) {
    case "rigid": return zAxisMotionTransform(0, 0);
    case "revolute": return zAxisMotionTransform(coordinates.angleRadians ?? 0, 0);
    case "slider": return zAxisMotionTransform(0, coordinates.offsetMeters ?? 0);
    case "cylindrical": return zAxisMotionTransform(coordinates.angleRadians ?? 0, coordinates.offsetMeters ?? 0);
    case "pin-slot":
    case "planar":
    case "ball": return null;
  }
}

export function evaluateAssemblyKinematics(request: AssemblyEvaluationRequest): AssemblyResult<AssemblyEvaluation> {
  const validated = validateAssemblyDefinition(request.assembly);
  if (!validated.ok) return validated;
  const diagnostics: AssemblyDiagnostic[] = [...validated.diagnostics];
  if (!(request.tolerance.translationMeters >= 0) || !(request.tolerance.rotationRadians >= 0)
    || !Number.isFinite(request.tolerance.translationMeters) || !Number.isFinite(request.tolerance.rotationRadians)) {
    return {
      ok: false,
      diagnostics: [failure("INVALID_TRANSFORM", "Evaluation tolerances must be finite and non-negative.", [], "Supply finite translation and rotation tolerances.")]
    };
  }

  const assembly = request.assembly;
  const activeOccurrences = assembly.occurrences.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id));
  const activeIds = new Set(activeOccurrences.map(({ id }) => id));
  const joints = new Map(assembly.joints.map((joint) => [joint.id, joint]));
  const origins = new Map(assembly.jointOrigins.map((origin) => [origin.id, origin]));
  const coordinates: Record<string, JointCoordinates> = {};
  for (const joint of assembly.joints.toSorted((a, b) => a.id.localeCompare(b.id))) coordinates[joint.id] = defaultCoordinates(joint);
  const supplied = new Set<JointId>();
  for (const input of request.coordinates) {
    if (supplied.has(input.jointId)) {
      diagnostics.push(failure("INVALID_LIMIT", `Joint '${input.jointId}' has duplicate coordinate inputs.`, [input.jointId], "Provide one coordinate record per joint."));
      continue;
    }
    supplied.add(input.jointId);
    const joint = joints.get(input.jointId);
    if (joint === undefined) {
      diagnostics.push(failure("MISSING_JOINT", `Coordinate input refers to missing joint '${input.jointId}'.`, [input.jointId], "Remove or repair the coordinate input."));
      continue;
    }
    const invalidCoordinates = Object.keys(input.coordinates).filter((coordinate) =>
      !(MOTION_COORDINATES as readonly string[]).includes(coordinate)
      || !jointSupportsCoordinate(joint, coordinate as MotionCoordinate));
    if (invalidCoordinates.length > 0) {
      diagnostics.push(failure(
        "COORDINATE_OUT_OF_RANGE",
        `Joint '${input.jointId}' does not support coordinate(s): ${invalidCoordinates.join(", ")}.`,
        [input.jointId],
        "Provide only coordinates defined by the selected joint type."
      ));
      continue;
    }
    coordinates[input.jointId] = { ...defaultCoordinates(joint), ...input.coordinates };
  }

  const links = assembly.motionLinks.filter(({ enabled }) => enabled).toSorted((a, b) => a.id.localeCompare(b.id));
  for (let pass = 0; pass <= links.length; pass += 1) {
    for (const link of links) {
      const source = coordinates[link.sourceJointId];
      const target = coordinates[link.targetJointId];
      if (source === undefined || target === undefined) continue;
      const value = readCoordinate(source, link.sourceCoordinate) * link.ratio + link.offset;
      coordinates[link.targetJointId] = writeCoordinate(target, link.targetCoordinate, value);
    }
  }
  for (const joint of assembly.joints) diagnostics.push(...limitDiagnostics(joint, coordinates[joint.id] ?? {}));

  const unsupported = assembly.joints.filter(({ suppressed, type }) => !suppressed && (type === "pin-slot" || type === "planar" || type === "ball"));
  for (const joint of unsupported) {
    diagnostics.push(failure(
      "UNSUPPORTED_JOINT_EVALUATION",
      `Joint '${joint.id}' has '${joint.type}' semantics but its nonlinear analytic evaluator is not qualified.`,
      [joint.id],
      "Use a qualified constraint solver adapter; the core will not approximate this joint."
    ));
  }

  const transforms = new Map<OccurrenceId, Transform3>();
  const dependencyOrder: OccurrenceId[] = [];
  const assign = (occurrenceId: OccurrenceId, candidate: Transform3, sourceId: string): boolean => {
    const existing = transforms.get(occurrenceId);
    if (existing === undefined) {
      transforms.set(occurrenceId, candidate);
      dependencyOrder.push(occurrenceId);
      return true;
    }
    const difference = transformDifference(existing, candidate);
    if (difference.translationMeters > request.tolerance.translationMeters
      || difference.rotationRadians > request.tolerance.rotationRadians) {
      diagnostics.push(failure(
        "INCONSISTENT_LOOP",
        `Occurrence '${occurrenceId}' receives inconsistent transforms through '${sourceId}'.`,
        [occurrenceId, sourceId],
        "Inspect redundant joints, rigid groups, joint-origin orientation, and grounded placements."
      ));
    }
    return false;
  };

  for (const occurrence of activeOccurrences.filter(({ grounded }) => grounded)) {
    assign(occurrence.id, occurrence.initialTransform, occurrence.id);
  }
  if (transforms.size === 0 && activeOccurrences.length > 0) {
    diagnostics.push(failure(
      "UNANCHORED_ASSEMBLY",
      "No active occurrence is grounded, so an absolute assembly solution is indeterminate.",
      activeOccurrences.map(({ id }) => id),
      "Ground one occurrence or provide a separately qualified floating-frame policy."
    ));
  }

  const occurrenceMap = new Map(activeOccurrences.map((occurrence) => [occurrence.id, occurrence]));
  const groups = assembly.rigidGroups.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id));
  const activeJoints = assembly.joints.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id));
  let changed = true;
  const maximumPasses = Math.max(1, activeOccurrences.length * (groups.length + activeJoints.length + 1));
  for (let pass = 0; pass < maximumPasses && changed; pass += 1) {
    changed = false;
    for (const group of groups) {
      const members = group.occurrenceIds.filter((id) => activeIds.has(id)).toSorted();
      const solvedMember = members.find((id) => transforms.has(id));
      if (solvedMember === undefined) continue;
      const solvedOccurrence = occurrenceMap.get(solvedMember);
      const solvedTransform = transforms.get(solvedMember);
      if (solvedOccurrence === undefined || solvedTransform === undefined) continue;
      for (const memberId of members) {
        const member = occurrenceMap.get(memberId);
        if (member === undefined) continue;
        const relative = composeTransforms(inverseRigidTransform(solvedOccurrence.initialTransform), member.initialTransform);
        changed = assign(memberId, composeTransforms(solvedTransform, relative), group.id) || changed;
      }
    }

    for (const joint of activeJoints) {
      const firstOrigin = origins.get(joint.firstOriginId);
      const secondOrigin = origins.get(joint.secondOriginId);
      if (firstOrigin === undefined || secondOrigin === undefined || !activeIds.has(firstOrigin.occurrenceId) || !activeIds.has(secondOrigin.occurrenceId)) continue;
      const motion = jointMotion(joint, coordinates[joint.id] ?? {});
      if (motion === null) continue;
      const firstOccurrenceTransform = transforms.get(firstOrigin.occurrenceId);
      const secondOccurrenceTransform = transforms.get(secondOrigin.occurrenceId);
      if (firstOccurrenceTransform !== undefined) {
        const firstWorldOrigin = composeTransforms(firstOccurrenceTransform, firstOrigin.localTransform);
        const secondWorldOrigin = composeTransforms(firstWorldOrigin, motion);
        const secondCandidate = composeTransforms(secondWorldOrigin, inverseRigidTransform(secondOrigin.localTransform));
        changed = assign(secondOrigin.occurrenceId, secondCandidate, joint.id) || changed;
      } else if (secondOccurrenceTransform !== undefined) {
        const secondWorldOrigin = composeTransforms(secondOccurrenceTransform, secondOrigin.localTransform);
        const firstWorldOrigin = composeTransforms(secondWorldOrigin, inverseRigidTransform(motion));
        const firstCandidate = composeTransforms(firstWorldOrigin, inverseRigidTransform(firstOrigin.localTransform));
        changed = assign(firstOrigin.occurrenceId, firstCandidate, joint.id) || changed;
      }
    }
  }

  const unresolved = activeOccurrences.filter(({ id }) => !transforms.has(id));
  for (const occurrence of unresolved) {
    diagnostics.push(failure(
      "DISCONNECTED_OCCURRENCE",
      `Occurrence '${occurrence.id}' is not reachable from a grounded occurrence through qualified constraints.`,
      [occurrence.id],
      "Add a qualified joint or rigid-group path to a grounded occurrence."
    ));
  }

  const graph = buildAssemblyDependencyGraph(assembly);
  if (graph.cycleJointIds.length > 0) {
    diagnostics.push({
      code: "DEPENDENCY_CYCLE",
      severity: "info",
      message: "The assembly contains a closed joint loop; every solved path was checked against the configured tolerances.",
      relatedIds: graph.cycleJointIds,
      recovery: "No action is required when loop transforms agree; otherwise inspect INCONSISTENT_LOOP diagnostics."
    });
  }

  if (diagnostics.some(({ severity }) => severity === "error")) return { ok: false, diagnostics };
  return {
    ok: true,
    value: {
      occurrenceTransforms: Object.fromEntries([...transforms.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
      resolvedCoordinates: Object.fromEntries(Object.entries(coordinates).toSorted(([a], [b]) => a.localeCompare(b))),
      dependencyOrder,
      diagnostics
    },
    diagnostics
  };
}
