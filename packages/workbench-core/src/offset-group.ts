import type { WorkbenchSketchConstraint } from "./types.js";

/**
 * One Offset of a chain of curves makes one distance per curve: a line-to-line distance for each straight piece and the gap between
 * the two arcs for each round one. They are one dimension to the person who drew the offset, so they carry the same `offsetGroup`
 * id: setting any of them sets them all, and the canvas shows the first one only. A group shrinks when a member is deleted and
 * needs no upkeep; a distance with no group stands alone, as every distance did before groups existed.
 */

const OFFSET_GROUP_PATTERN = /^offset:[a-z0-9][a-z0-9._-]*$/u;

/** True for a well-formed offset group id (`offset:name`, at most 128 characters). */
export function isOffsetGroupId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && OFFSET_GROUP_PATTERN.test(value);
}

function isMember(constraint: WorkbenchSketchConstraint, group: string): boolean {
  return constraint.kind === "distance" && constraint.offsetGroup === group && constraint.driven !== true && constraint.valueMm !== undefined;
}

/** The driving distances that share the offset group of `of` (itself included), in sketch order; just `of` when it has no group. */
export function offsetGroupMembers(constraints: readonly WorkbenchSketchConstraint[], of: WorkbenchSketchConstraint): readonly WorkbenchSketchConstraint[] {
  const group = of.offsetGroup;
  if (group === undefined) return [of];
  return constraints.filter((constraint) => constraint.id === of.id || isMember(constraint, group));
}

/**
 * The constraints with every other member of the leader's offset group brought to the leader's value. A follower never keeps an
 * expression of its own: the group has one value, and it is the leader's.
 */
export function withOffsetGroupValue(constraints: readonly WorkbenchSketchConstraint[], leader: WorkbenchSketchConstraint): readonly WorkbenchSketchConstraint[] {
  const group = leader.offsetGroup;
  if (group === undefined || leader.valueMm === undefined) return constraints;
  const value = leader.valueMm;
  let changed = false;
  const next = constraints.map((constraint): WorkbenchSketchConstraint => {
    if (constraint.id === leader.id || !isMember(constraint, group)) return constraint;
    if (constraint.valueMm === value && constraint.expression === undefined) return constraint;
    changed = true;
    const { expression: _expression, ...rest } = constraint;
    return { ...rest, valueMm: value };
  });
  return changed ? next : constraints;
}

/**
 * The ids of the dimensions the canvas leaves out because another member of their offset group is already shown: every member of a
 * group but its first one that is not relaxed (the first of all when every member is relaxed).
 */
export function offsetGroupFollowerIds(constraints: readonly WorkbenchSketchConstraint[]): ReadonlySet<string> {
  const leaders = new Map<string, WorkbenchSketchConstraint>();
  for (const constraint of constraints) {
    const group = constraint.offsetGroup;
    if (group === undefined || !isMember(constraint, group)) continue;
    const current = leaders.get(group);
    if (current === undefined || (current.suppressed === true && constraint.suppressed !== true)) leaders.set(group, constraint);
  }
  const followers = new Set<string>();
  for (const constraint of constraints) {
    const group = constraint.offsetGroup;
    if (group === undefined || !isMember(constraint, group)) continue;
    if (leaders.get(group)?.id !== constraint.id) followers.add(constraint.id);
  }
  return followers;
}
