import { applyWorkbenchOperation, dependentsOf, designOf, type DeleteImpact, type DeleteImpactItem, type DesignFeature, type DesignHistory, type WorkbenchOperation, type WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { TimelineGroup } from "./timeline-groups.js";

/**
 * A folded pattern group is one chip that stands for every copy the pattern made. Its right-click menu used to act on the first copy only
 * while the chip stood for all of them, and opening the menu unfolded the group. These are the pure parts of the group menu: what each
 * entry is called, which steps it acts on, and the confirmation for deleting the whole group.
 */

export interface GroupMenuModel {
  readonly count: number;
  readonly members: readonly DesignFeature[];
  readonly editLabel: string;
  /** Suppress every copy, or (when every copy is already suppressed) bring them all back. */
  readonly suppressTo: boolean;
  readonly suppressLabel: string;
  readonly showLabel: string;
  readonly deleteLabel: string;
  /** The rollback marker goes right after the last copy. */
  readonly rollbackIndex: number;
  readonly menuLabel: string;
}

export function groupMenuModel(history: DesignHistory, group: TimelineGroup): GroupMenuModel {
  const members = group.ids.map((id) => history.features.find((feature) => feature.id === id)).filter((feature): feature is DesignFeature => feature !== undefined);
  const count = members.length;
  const allSuppressed = count > 0 && members.every((member) => member.suppressed);
  return {
    count,
    members,
    editLabel: `Edit pattern (${count} copies)`,
    suppressTo: !allSuppressed,
    suppressLabel: allSuppressed ? `Unsuppress all ${count} copies` : `Suppress all ${count} copies`,
    showLabel: `Show the ${count} copies`,
    deleteLabel: `Delete all ${count} copies`,
    rollbackIndex: group.lastIndex + 1,
    menuLabel: `${group.label} actions`
  };
}

/** The suppress operations for a whole group: one per copy that is not already in the wanted state. */
export function groupSuppressIntents(members: readonly DesignFeature[], suppressed: boolean): readonly { readonly kind: "set-design-feature-suppressed"; readonly featureId: string; readonly suppressed: boolean }[] {
  return members.filter((member) => member.suppressed !== suppressed).map((member) => ({ kind: "set-design-feature-suppressed" as const, featureId: member.id, suppressed }));
}

/**
 * The confirmation for deleting a whole group: the copies themselves (the first is the headline step, the others are listed first), then
 * every other step that depends on any copy. One Undo brings all of it back.
 */
export function groupDeleteImpact(project: WorkbenchProject, group: TimelineGroup): DeleteImpact | undefined {
  const history = designOf(project);
  const members = group.ids.map((id) => history.features.find((feature) => feature.id === id)).filter((feature): feature is DesignFeature => feature !== undefined);
  if (members.length === 0) return undefined;
  const memberIds = new Set(members.map((member) => member.id));
  const seen = new Set<string>();
  const outside: DeleteImpactItem[] = [];
  for (const member of members) {
    for (const dependent of dependentsOf(history, member.id)) {
      if (memberIds.has(dependent.id) || seen.has(dependent.id)) continue;
      seen.add(dependent.id);
      outside.push({ id: dependent.id, name: dependent.name, kind: dependent.kind, reason: `depends on ${member.name}` });
    }
  }
  outside.sort((left, right) => history.features.findIndex((feature) => feature.id === left.id) - history.features.findIndex((feature) => feature.id === right.id));
  const copies: DeleteImpactItem[] = members.slice(1).map((member) => ({ id: member.id, name: member.name, kind: member.kind, reason: "a copy made by the same pattern" }));
  const removedBodyNames = (project.part.generalBodies ?? []).filter((body) => members.some((member) => member.kind !== "sketch" && member.bodyId === body.id)).map((body) => body.name);
  return { featureId: members[0]!.id, featureName: group.label, featureKind: members[0]!.kind, dependents: [...copies, ...outside], removedBodyNames, kept: { featureId: members[0]!.id, featureName: group.label, marks: [], removedBodyNames: [] } };
}

/** The headline of the group delete confirmation (the single-step headline would call the copies dependants of the first one). */
export function groupDeleteHeadline(impact: DeleteImpact, group: TimelineGroup): string {
  const outside = impact.dependents.length - (group.ids.length - 1);
  return outside <= 0
    ? `Delete all ${group.ids.length} copies of ${group.label.replace(/\s*×\d+$/u, "")}.`
    : `Delete all ${group.ids.length} copies of ${group.label.replace(/\s*×\d+$/u, "")} and ${outside} other step${outside === 1 ? "" : "s"} that depend${outside === 1 ? "s" : ""} on them.`;
}

/**
 * The delete operations for a group, without the copies a delete already takes with it (deleting one step also deletes what is built on
 * it): each remaining copy is deleted once, in timeline order.
 */
export function groupDeleteIntents(history: DesignHistory, group: TimelineGroup): readonly { readonly kind: "delete-design-feature"; readonly featureId: string }[] {
  const gone = new Set<string>();
  const intents: { readonly kind: "delete-design-feature"; readonly featureId: string }[] = [];
  for (const id of group.ids) {
    if (gone.has(id)) continue;
    intents.push({ kind: "delete-design-feature", featureId: id });
    gone.add(id);
    for (const dependent of dependentsOf(history, id)) gone.add(dependent.id);
  }
  return intents;
}

/**
 * Applies a list of operations one after another on a project without recording anything, so a command that is several operations
 * can be recorded as one project (one Undo step). Returns the project after all but the last, and the last operation for the caller to
 * commit (it rebuilds the timeline), or the first refusal.
 */
export function chainAllButLast<T extends { readonly kind: string }>(
  project: WorkbenchProject,
  intents: readonly T[]
): { readonly ok: true; readonly project: WorkbenchProject; readonly last: T } | { readonly ok: false; readonly message: string } {
  if (intents.length === 0) return { ok: false, message: "There is nothing to apply." };
  let current = project;
  for (const intent of intents.slice(0, -1)) {
    const applied = applyWorkbenchOperation(current, { ...intent, operationId: `operation:ui-chain-${current.revision}-${globalThis.crypto.randomUUID()}`, expectedRevision: current.revision } as unknown as WorkbenchOperation);
    if (!applied.ok) return { ok: false, message: applied.diagnostics[0]?.message ?? "The project operation was rejected." };
    current = applied.value.project;
  }
  return { ok: true, project: current, last: intents[intents.length - 1]! };
}
