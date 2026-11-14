import type { DesignFeature, DesignHistory } from "../../../../packages/workbench-core/src/index.js";

/**
 * HS-19: the copies a pattern makes are several steps that share one group, and the timeline shows them as one item that opens to the
 * individual steps. This is the small honest version: only the steps a command made together are grouped (the copies of a new-bodies
 * pattern), the grouping is read from the steps themselves (`pattern.groupId`, nothing new is saved), and a group is a display fold:
 * every step in it is still a step with its own place, marker slot, edit and delete once the group is open.
 */
export interface TimelineGroup {
  readonly groupId: string;
  /** The steps of the group, in timeline order. They are next to each other. */
  readonly ids: readonly string[];
  readonly firstIndex: number;
  readonly lastIndex: number;
  /** "Rectangular pattern ×5": the pattern's name without the "(2 of 5)" of a copy, and how many copies. */
  readonly label: string;
}

const groupIdOf = (feature: DesignFeature): string | undefined => feature.kind === "sketch" ? undefined : feature.pattern?.groupId;

/** The name of a step with the copy number taken off: "Rectangular pattern (2 of 5)" is "Rectangular pattern". */
export function groupBaseName(name: string): string {
  return name.replace(/\s*\(\d+ of \d+\)\s*$/u, "").trim();
}

/** Every run of two or more neighbouring steps that one pattern command made, in timeline order. */
export function timelineGroups(history: DesignHistory): readonly TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let index = 0;
  while (index < history.features.length) {
    const id = groupIdOf(history.features[index]!);
    let end = index;
    if (id !== undefined) while (end + 1 < history.features.length && groupIdOf(history.features[end + 1]!) === id) end += 1;
    if (id !== undefined && end > index) {
      const members = history.features.slice(index, end + 1);
      groups.push({ groupId: id, ids: members.map((member) => member.id), firstIndex: index, lastIndex: end, label: `${groupBaseName(members[0]!.name)} ×${members.length}` });
    }
    index = end + 1;
  }
  return groups;
}

/**
 * Whether a group shows its steps. It does when the person opened it, and whenever hiding a step would hide something that is in use:
 * the rollback marker sits inside the group, or one of its steps is being renamed, dragged or has its menu open.
 */
export function groupIsOpen(history: DesignHistory, group: TimelineGroup, expanded: ReadonlySet<string>, busyIds: readonly (string | undefined)[]): boolean {
  if (expanded.has(group.groupId)) return true;
  if (history.rollbackIndex > group.firstIndex && history.rollbackIndex <= group.lastIndex) return true;
  return busyIds.some((id) => id !== undefined && group.ids.includes(id));
}
