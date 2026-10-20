import type { AssemblyIntent, AssemblyMate, ComponentInstance, Vec3 } from "./types.js";

export interface MateSolveResult {
  /** Components with solved translations; unchanged components keep their identity. */
  readonly components: readonly ComponentInstance[];
  /** Mates with freshly derived statuses. */
  readonly mates: readonly AssemblyMate[];
  readonly movedIds: readonly string[];
  /** Short human-readable lines describing what moved. */
  readonly notes: readonly string[];
}

const TOLERANCE_MM = 1e-6;

/**
 * Translation-level mate solver.
 *
 * Each mate says that some coordinates of two components are equal: a coincident-origin mate equalises
 * X, Y and Z, an aligned-axis mate puts both origins on one line parallel to its axis (the two other
 * coordinates are equal, so a pin stays coaxial with its base whatever its height), and a fixed mate pins
 * its component where it is.
 * Every axis is solved on its own. Grounded and fixed components are anchors and never move; the other
 * components in a connected group take the anchor's coordinate, or the first-listed component's when
 * the group has no anchor. Two anchors that disagree make every mate in that group a conflict and nothing
 * in the group moves. This is not a kinematic solver: there are no rotations, joint limits or motion.
 *
 * With `move: false` only the statuses are derived from the current positions.
 */
export function solveAssemblyMates(assembly: AssemblyIntent, options: { readonly move: boolean }): MateSolveResult {
  const positions = new Map<string, [number, number, number]>(assembly.components.map((component) => [component.id, [...component.translationMm] as [number, number, number]]));
  const anchored = new Set(assembly.components.filter((component) => component.grounded).map((component) => component.id));
  for (const mate of assembly.mates) if (mate.kind === "fixed") for (const id of mate.componentIds) anchored.add(id);

  const edges = assembly.mates.flatMap((mate, mateIndex) => {
    if (mate.kind === "fixed" || mate.componentIds.length !== 2) return [];
    const [first, second] = mate.componentIds as readonly [string, string];
    if (!positions.has(first) || !positions.has(second)) return [];
    return mateAxes(mate).map((axis) => ({ mateIndex, first, second, axis }));
  });

  const conflictedMates = new Set<number>();
  for (let axis = 0; axis < 3; axis += 1) {
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let root = id;
      while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
      parent.set(id, root);
      return root;
    };
    const axisEdges = edges.filter((edge) => edge.axis === axis);
    for (const edge of axisEdges) parent.set(find(edge.first), find(edge.second));
    const groups = new Map<string, { members: Set<string>; leader: string; edgeMates: number[] }>();
    for (const edge of axisEdges) {
      const root = find(edge.first);
      const group = groups.get(root) ?? { members: new Set<string>(), leader: edge.first, edgeMates: [] };
      group.members.add(edge.first).add(edge.second);
      group.edgeMates.push(edge.mateIndex);
      groups.set(root, group);
    }
    for (const group of groups.values()) {
      const anchors = [...group.members].filter((id) => anchored.has(id));
      const anchorValues = anchors.map((id) => positions.get(id)![axis]!);
      if (anchorValues.some((value) => Math.abs(value - anchorValues[0]!) > TOLERANCE_MM)) {
        for (const mateIndex of group.edgeMates) conflictedMates.add(mateIndex);
        continue;
      }
      if (!options.move) continue;
      const target = anchors.length > 0 ? anchorValues[0]! : positions.get(group.leader)![axis]!;
      for (const id of group.members) if (!anchored.has(id)) positions.get(id)![axis] = target;
    }
  }

  const movedIds: string[] = [];
  const notes: string[] = [];
  const components = assembly.components.map((component) => {
    const next = positions.get(component.id)!;
    if (next.every((value, axis) => Math.abs(value - component.translationMm[axis]!) <= TOLERANCE_MM)) return component;
    movedIds.push(component.id);
    notes.push(`Moved ${component.name} to ${next.map((value) => String(Math.round(value * 1000) / 1000)).join(", ")} mm`);
    return { ...component, translationMm: next as unknown as Vec3 };
  });

  const seen = new Set<string>();
  const mates = assembly.mates.map((mate, mateIndex): AssemblyMate => {
    const key = `${mate.kind}|${mate.axis ?? ""}|${[...mate.componentIds].sort().join("|")}`;
    const duplicate = seen.has(key);
    seen.add(key);
    let satisfied = !conflictedMates.has(mateIndex);
    if (satisfied && mate.kind !== "fixed" && mate.componentIds.length === 2) {
      const first = positions.get(mate.componentIds[0]!);
      const second = positions.get(mate.componentIds[1]!);
      if (first === undefined || second === undefined) satisfied = false;
      else {
        satisfied = mateAxes(mate).every((axis) => Math.abs(first[axis]! - second[axis]!) <= TOLERANCE_MM);
      }
    }
    const status: AssemblyMate["status"] = !satisfied ? "conflict" : duplicate ? "redundant" : "satisfied";
    return mate.status === status ? mate : { ...mate, status };
  });
  return { components, mates, movedIds, notes };
}

/** The coordinate indices a mate forces to be equal between its two components. */
export function mateAxes(mate: AssemblyMate): readonly number[] {
  if (mate.kind === "coincident-origin") return [0, 1, 2];
  if (mate.kind === "fixed") return [];
  return mate.axis === "x" ? [1, 2] : mate.axis === "y" ? [0, 2] : [0, 1];
}
