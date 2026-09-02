import type { JointId, OccurrenceId } from "./canonical.js";
import type {
  AssemblyDefinition,
  AssemblyDependencyGraph,
  AssemblyDiagnostic,
  AssemblyJointType,
  DofBreakdown
} from "./types.js";

class DisjointSet {
  readonly #parent = new Map<OccurrenceId, OccurrenceId>();

  constructor(ids: readonly OccurrenceId[]) {
    for (const id of ids) this.#parent.set(id, id);
  }

  find(id: OccurrenceId): OccurrenceId {
    const parent = this.#parent.get(id);
    if (parent === undefined) throw new TypeError(`Unknown occurrence '${id}'.`);
    if (parent === id) return id;
    const root = this.find(parent);
    this.#parent.set(id, root);
    return root;
  }

  union(first: OccurrenceId, second: OccurrenceId): boolean {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) return false;
    const [parent, child] = [firstRoot, secondRoot].toSorted() as [OccurrenceId, OccurrenceId];
    this.#parent.set(child, parent);
    return true;
  }
}

export function jointDegreesOfFreedom(type: AssemblyJointType): number {
  switch (type) {
    case "rigid": return 0;
    case "revolute": return 1;
    case "slider": return 1;
    case "cylindrical": return 2;
    case "pin-slot": return 2;
    case "planar": return 3;
    case "ball": return 3;
  }
}

export function buildAssemblyDependencyGraph(assembly: AssemblyDefinition): AssemblyDependencyGraph {
  const activeOccurrenceIds = assembly.occurrences
    .filter(({ suppressed }) => !suppressed)
    .map(({ id }) => id)
    .toSorted();
  const active = new Set(activeOccurrenceIds);
  const originOccurrences = new Map(assembly.jointOrigins.map((origin) => [origin.id, origin.occurrenceId]));
  const edges: AssemblyDependencyGraph["edges"][number][] = [];

  for (const group of assembly.rigidGroups.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id))) {
    const members = group.occurrenceIds.filter((id) => active.has(id)).toSorted();
    const anchor = members[0];
    if (anchor === undefined) continue;
    for (const member of members.slice(1)) {
      edges.push({ jointId: null, firstOccurrenceId: anchor, secondOccurrenceId: member, kind: "rigid-group" });
    }
  }
  for (const joint of assembly.joints.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id))) {
    const firstOccurrenceId = originOccurrences.get(joint.firstOriginId);
    const secondOccurrenceId = originOccurrences.get(joint.secondOriginId);
    if (firstOccurrenceId === undefined || secondOccurrenceId === undefined
      || !active.has(firstOccurrenceId) || !active.has(secondOccurrenceId)) continue;
    edges.push({ jointId: joint.id, firstOccurrenceId, secondOccurrenceId, kind: joint.type });
  }

  const adjacency = new Map<OccurrenceId, OccurrenceId[]>(activeOccurrenceIds.map((id) => [id, []]));
  for (const edge of edges) {
    adjacency.get(edge.firstOccurrenceId)?.push(edge.secondOccurrenceId);
    adjacency.get(edge.secondOccurrenceId)?.push(edge.firstOccurrenceId);
  }
  const visited = new Set<OccurrenceId>();
  const connectedComponents: OccurrenceId[][] = [];
  for (const start of activeOccurrenceIds) {
    if (visited.has(start)) continue;
    const component: OccurrenceId[] = [];
    const queue: OccurrenceId[] = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      component.push(current);
      for (const adjacent of (adjacency.get(current) ?? []).toSorted()) {
        if (!visited.has(adjacent)) {
          visited.add(adjacent);
          queue.push(adjacent);
        }
      }
    }
    connectedComponents.push(component.toSorted());
  }

  const jointCycles: JointId[] = [];
  const disjoint = new DisjointSet(activeOccurrenceIds);
  for (const edge of edges.filter(({ kind }) => kind === "rigid-group")) {
    disjoint.union(edge.firstOccurrenceId, edge.secondOccurrenceId);
  }
  for (const edge of edges.filter(({ jointId }) => jointId !== null)) {
    if (!disjoint.union(edge.firstOccurrenceId, edge.secondOccurrenceId) && edge.jointId !== null) jointCycles.push(edge.jointId);
  }

  return {
    occurrenceIds: activeOccurrenceIds,
    edges,
    connectedComponents,
    cycleJointIds: jointCycles.toSorted()
  };
}

export function accountAssemblyDegreesOfFreedom(assembly: AssemblyDefinition): DofBreakdown {
  const activeOccurrences = assembly.occurrences.filter(({ suppressed }) => !suppressed);
  const activeOccurrenceIds = new Set(activeOccurrences.map(({ id }) => id));
  const freeBodyDof = activeOccurrences.length * 6;
  const groundedReduction = activeOccurrences.filter(({ grounded }) => grounded).length * 6;

  const rigidSet = new DisjointSet([...activeOccurrenceIds].toSorted());
  let rigidGroupReduction = 0;
  for (const group of assembly.rigidGroups.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id))) {
    const members = group.occurrenceIds.filter((id) => activeOccurrenceIds.has(id)).toSorted();
    const anchor = members[0];
    if (anchor === undefined) continue;
    for (const member of members.slice(1)) {
      if (rigidSet.union(anchor, member)) rigidGroupReduction += 6;
    }
  }

  const jointDof: Record<string, number> = {};
  let jointConstraintReduction = 0;
  for (const joint of assembly.joints.filter(({ suppressed }) => !suppressed).toSorted((a, b) => a.id.localeCompare(b.id))) {
    const dof = jointDegreesOfFreedom(joint.type);
    jointDof[joint.id] = dof;
    jointConstraintReduction += 6 - dof;
  }
  const unconstrained = freeBodyDof - groundedReduction - rigidGroupReduction - jointConstraintReduction;
  const diagnostics: AssemblyDiagnostic[] = [];
  if (unconstrained < 0) {
    diagnostics.push({
      code: "INCONSISTENT_LOOP",
      severity: "warning",
      message: "Nominal constraint rank exceeds available free-body degrees of freedom; loop Jacobian analysis is required for an exact mobility result.",
      relatedIds: assembly.joints.filter(({ suppressed }) => !suppressed).map(({ id }) => id),
      recovery: "Run a qualified constraint-Jacobian rank analysis and inspect redundant or conflicting joints."
    });
  }
  return {
    freeBodyDof,
    groundedReduction,
    rigidGroupReduction,
    jointConstraintReduction,
    residualDof: Math.max(0, unconstrained),
    jointDof,
    diagnostics
  };
}
