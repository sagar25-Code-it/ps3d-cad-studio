import type { FeatureId } from "./ids.js";
import type { CadDiagnostic, CadDocument, CadFeature, CadResult } from "./types.js";

export type RebuildStepReason = "requested" | "dependency-changed" | "dirty" | "failed-retry";
export type SkippedFeatureReason = "suppressed" | "rolled-back" | "component-suppressed";

export interface RebuildStep {
  readonly featureId: FeatureId;
  readonly reason: RebuildStepReason;
  readonly dependencyIds: readonly FeatureId[];
}

export interface SkippedFeature {
  readonly featureId: FeatureId;
  readonly reason: SkippedFeatureReason;
}

export interface BlockedFeature {
  readonly featureId: FeatureId;
  readonly blockingFeatureIds: readonly FeatureId[];
}

export interface FeatureRebuildPlan {
  readonly documentRevision: number;
  readonly steps: readonly RebuildStep[];
  readonly skipped: readonly SkippedFeature[];
  readonly blocked: readonly BlockedFeature[];
  readonly diagnostics: readonly CadDiagnostic[];
}

export interface FeatureRebuildOptions {
  /** Empty or omitted means rebuild all active features. */
  readonly changedFeatureIds?: readonly FeatureId[];
  /** Include dirty, failed, and blocked features even when they are not descendants of a changed feature. */
  readonly includeDirty?: boolean;
}

export function planFeatureRebuild(
  document: CadDocument,
  options: FeatureRebuildOptions = {}
): CadResult<FeatureRebuildPlan> {
  const featuresById = new Map(document.project.features.map((feature) => [feature.id, feature] as const));
  const compare = createTimelineComparator(document);
  const missingDiagnostics = findMissingDependencies(document.project.features, featuresById);
  if (missingDiagnostics.length > 0) return { ok: false, diagnostics: missingDiagnostics };

  const inactive = classifyInactiveFeatures(document);
  const active = document.project.features.filter((feature) => !inactive.has(feature.id));
  const orderResult = topologicalOrder(active, featuresById, compare);
  if (!orderResult.ok) return orderResult;

  const dependents = buildDependents(document.project.features);
  const blockedBy = findBlockedFeatures(active, inactive, featuresById, orderResult.value, compare);
  const requested = options.changedFeatureIds === undefined || options.changedFeatureIds.length === 0
    ? null
    : new Set(options.changedFeatureIds);
  if (requested !== null) {
    const unknown = [...requested].filter((id) => !featuresById.has(id)).sort(compare);
    if (unknown.length > 0) {
      return {
        ok: false,
        diagnostics: [diagnostic(
          "MISSING_REFERENCE",
          "error",
          "A requested rebuild feature does not exist.",
          unknown,
          "Refresh the document and request the rebuild with current feature IDs."
        )]
      };
    }
  }

  const affected = requested === null
    ? new Set(active.map((feature) => feature.id))
    : transitiveDependents(requested, dependents);
  if (options.includeDirty === true) {
    for (const feature of active) {
      if (feature.status === "dirty" || feature.status === "failed" || feature.status === "blocked") affected.add(feature.id);
    }
  }

  const diagnostics: CadDiagnostic[] = [];
  const blocked = [...blockedBy.entries()]
    .filter(([featureId]) => affected.has(featureId))
    .sort(([first], [second]) => compare(first, second))
    .map(([featureId, blockers]): BlockedFeature => {
      const blockingFeatureIds = [...blockers].sort(compare);
      diagnostics.push(diagnostic(
        "DEPENDENCY_BLOCKED",
        "warning",
        `Feature ${featureId} cannot rebuild because an upstream feature is inactive or blocked.`,
        [featureId, ...blockingFeatureIds],
        "Move the rollback point forward or unsuppress and successfully rebuild the upstream feature."
      ));
      return { featureId, blockingFeatureIds };
    });

  const steps = orderResult.value
    .filter((featureId) => affected.has(featureId) && !blockedBy.has(featureId))
    .map((featureId): RebuildStep => {
      const feature = featuresById.get(featureId)!;
      return {
        featureId,
        reason: rebuildReason(feature, requested),
        dependencyIds: [...feature.dependencies].sort(compare)
      };
    });

  const skipped = [...inactive.entries()]
    .sort(([first], [second]) => compare(first, second))
    .map(([featureId, reason]): SkippedFeature => ({ featureId, reason }));

  return {
    ok: true,
    value: {
      documentRevision: document.revision,
      steps,
      skipped,
      blocked,
      diagnostics
    }
  };
}

export function deterministicFeatureOrder(document: CadDocument): CadResult<readonly FeatureId[]> {
  const featuresById = new Map(document.project.features.map((feature) => [feature.id, feature] as const));
  const missing = findMissingDependencies(document.project.features, featuresById);
  if (missing.length > 0) return { ok: false, diagnostics: missing };
  return topologicalOrder(document.project.features, featuresById, createTimelineComparator(document));
}

function findMissingDependencies(
  features: readonly CadFeature[],
  featuresById: ReadonlyMap<FeatureId, CadFeature>
): readonly CadDiagnostic[] {
  const diagnostics: CadDiagnostic[] = [];
  for (const feature of features) {
    const missing = feature.dependencies.filter((dependencyId) => !featuresById.has(dependencyId));
    if (missing.length > 0) {
      diagnostics.push(diagnostic(
        "MISSING_REFERENCE",
        "error",
        `Feature ${feature.id} has missing dependencies.`,
        [feature.id, ...missing],
        "Restore the missing feature or remove the invalid dependency before rebuilding."
      ));
    }
  }
  return diagnostics.sort(compareDiagnostics);
}

function classifyInactiveFeatures(document: CadDocument): ReadonlyMap<FeatureId, SkippedFeatureReason> {
  const inactive = new Map<FeatureId, SkippedFeatureReason>();
  const featuresById = new Map(document.project.features.map((feature) => [feature.id, feature] as const));
  for (const component of document.project.components) {
    if (component.suppressed) {
      for (const featureId of component.featureIds) inactive.set(featureId, "component-suppressed");
      continue;
    }
    if (component.rollbackAfterFeatureId !== null) {
      const rollbackIndex = component.featureIds.indexOf(component.rollbackAfterFeatureId);
      for (let index = rollbackIndex + 1; index < component.featureIds.length; index += 1) {
        inactive.set(component.featureIds[index]!, "rolled-back");
      }
    }
  }
  for (const feature of featuresById.values()) {
    if (feature.suppressed) inactive.set(feature.id, "suppressed");
  }
  return inactive;
}

function topologicalOrder(
  features: readonly CadFeature[],
  featuresById: ReadonlyMap<FeatureId, CadFeature>,
  compare: (first: FeatureId, second: FeatureId) => number
): CadResult<readonly FeatureId[]> {
  const included = new Set(features.map((feature) => feature.id));
  const indegree = new Map<FeatureId, number>();
  const dependents = new Map<FeatureId, FeatureId[]>();
  for (const feature of features) {
    const dependencies = [...new Set(feature.dependencies.filter((id) => included.has(id)))];
    indegree.set(feature.id, dependencies.length);
    for (const dependencyId of dependencies) {
      const children = dependents.get(dependencyId) ?? [];
      children.push(feature.id);
      dependents.set(dependencyId, children);
    }
  }
  const ready = features.filter((feature) => indegree.get(feature.id) === 0).map((feature) => feature.id).sort(compare);
  const ordered: FeatureId[] = [];
  while (ready.length > 0) {
    const featureId = ready.shift()!;
    ordered.push(featureId);
    for (const dependentId of (dependents.get(featureId) ?? []).sort(compare)) {
      const next = indegree.get(dependentId)! - 1;
      indegree.set(dependentId, next);
      if (next === 0) insertSorted(ready, dependentId, compare);
    }
  }
  if (ordered.length !== features.length) {
    const cycleIds = features.map((feature) => feature.id).filter((id) => !ordered.includes(id)).sort(compare);
    return {
      ok: false,
      diagnostics: [diagnostic(
        "FEATURE_CYCLE",
        "error",
        "The feature dependency graph contains a cycle.",
        cycleIds,
        "Remove at least one cyclic feature dependency before rebuilding."
      )]
    };
  }
  void featuresById;
  return { ok: true, value: ordered };
}

function findBlockedFeatures(
  active: readonly CadFeature[],
  inactive: ReadonlyMap<FeatureId, SkippedFeatureReason>,
  featuresById: ReadonlyMap<FeatureId, CadFeature>,
  ordered: readonly FeatureId[],
  compare: (first: FeatureId, second: FeatureId) => number
): ReadonlyMap<FeatureId, ReadonlySet<FeatureId>> {
  const activeIds = new Set(active.map((feature) => feature.id));
  const blocked = new Map<FeatureId, Set<FeatureId>>();
  for (const featureId of ordered) {
    const feature = featuresById.get(featureId)!;
    const blockers = new Set<FeatureId>();
    for (const dependencyId of feature.dependencies) {
      if (inactive.has(dependencyId)) blockers.add(dependencyId);
      for (const transitive of blocked.get(dependencyId) ?? []) blockers.add(transitive);
      if (!activeIds.has(dependencyId) && !inactive.has(dependencyId)) blockers.add(dependencyId);
    }
    if (blockers.size > 0) blocked.set(featureId, new Set([...blockers].sort(compare)));
  }
  return blocked;
}

function buildDependents(features: readonly CadFeature[]): ReadonlyMap<FeatureId, readonly FeatureId[]> {
  const dependents = new Map<FeatureId, FeatureId[]>();
  for (const feature of features) {
    for (const dependencyId of feature.dependencies) {
      const children = dependents.get(dependencyId) ?? [];
      children.push(feature.id);
      dependents.set(dependencyId, children);
    }
  }
  return dependents;
}

function transitiveDependents(
  requested: ReadonlySet<FeatureId>,
  dependents: ReadonlyMap<FeatureId, readonly FeatureId[]>
): Set<FeatureId> {
  const affected = new Set(requested);
  const queue = [...requested];
  while (queue.length > 0) {
    const featureId = queue.shift()!;
    for (const dependentId of dependents.get(featureId) ?? []) {
      if (affected.has(dependentId)) continue;
      affected.add(dependentId);
      queue.push(dependentId);
    }
  }
  return affected;
}

function rebuildReason(feature: CadFeature, requested: ReadonlySet<FeatureId> | null): RebuildStepReason {
  if (requested === null || requested.has(feature.id)) return "requested";
  if (feature.status === "failed") return "failed-retry";
  if (feature.status === "dirty" || feature.status === "blocked") return "dirty";
  return "dependency-changed";
}

function createTimelineComparator(document: CadDocument): (first: FeatureId, second: FeatureId) => number {
  const ranks = new Map<FeatureId, number>();
  document.project.components.forEach((component, componentIndex) => {
    component.featureIds.forEach((featureId, featureIndex) => {
      ranks.set(featureId, componentIndex * 1_000_000 + featureIndex);
    });
  });
  return (first, second) => {
    const byRank = (ranks.get(first) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(second) ?? Number.MAX_SAFE_INTEGER);
    return byRank === 0 ? first.localeCompare(second) : byRank;
  };
}

function insertSorted(values: FeatureId[], value: FeatureId, compare: (first: FeatureId, second: FeatureId) => number): void {
  let index = 0;
  while (index < values.length && compare(values[index]!, value) <= 0) index += 1;
  values.splice(index, 0, value);
}

function diagnostic(
  code: CadDiagnostic["code"],
  severity: CadDiagnostic["severity"],
  message: string,
  relatedIds: readonly string[],
  recovery: string
): CadDiagnostic {
  return { code, severity, message, relatedIds, recovery };
}

function compareDiagnostics(first: CadDiagnostic, second: CadDiagnostic): number {
  return `${first.code}:${first.relatedIds.join(",")}`.localeCompare(`${second.code}:${second.relatedIds.join(",")}`);
}
