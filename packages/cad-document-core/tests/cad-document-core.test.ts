import {
  appendFeature,
  createCadId,
  createDefaultCadDocument,
  deterministicFeatureOrder,
  planFeatureRebuild,
  setComponentRollback,
  setFeatureSuppressed,
  updateFeature,
  validateCadDocument,
  type BodyId,
  type CadBody,
  type CadDocument,
  type CadFeature,
  type FeatureId
} from "../src/index.js";
import { assert, deepEqual, equal } from "./test-kit.js";

interface TestCase {
  readonly name: string;
  readonly run: () => void;
}

function feature(id: FeatureId, dependencies: readonly FeatureId[], outputs: readonly BodyId[]): CadFeature {
  return {
    id,
    componentId: createCadId("component", "root"),
    name: id,
    kind: "custom",
    dependencies,
    inputs: [],
    parameters: [],
    outputBodyIds: outputs,
    suppressed: false,
    status: "dirty",
    evaluationRevision: null,
    diagnostics: []
  };
}

function body(id: BodyId, generatedByFeatureId: FeatureId): CadBody {
  return {
    id,
    componentId: createCadId("component", "root"),
    name: id,
    representation: "empty",
    geometryHandle: null,
    generatedByFeatureId,
    topologyRevision: 0,
    visible: true,
    suppressed: false,
    materialId: null,
    status: "dirty",
    diagnostics: []
  };
}

function populatedDocument(): CadDocument {
  const baseId = createCadId("feature", "base");
  const boreId = createCadId("feature", "bore");
  const finishId = createCadId("feature", "finish");
  const bodyId = createCadId("body", "main");
  let document = createDefaultCadDocument();
  document = appendFeature(document, "operation:add-base", feature(baseId, [], [bodyId]), [body(bodyId, baseId)]);
  document = appendFeature(document, "operation:add-bore", feature(boreId, [baseId], [bodyId]));
  document = appendFeature(document, "operation:add-finish", feature(finishId, [boreId], [bodyId]));
  return document;
}

export const cadDocumentCoreTests: readonly TestCase[] = [
  {
    name: "creates a deeply immutable canonical root document",
    run: () => {
      const document = createDefaultCadDocument("Fixture");
      equal(document.project.components.length, 1, "root component exists");
      equal(document.project.origins.length, 1, "root origin exists");
      assert(Object.isFrozen(document), "document is frozen");
      assert(Object.isFrozen(document.project.components), "nested collections are frozen");
      const validated = validateCadDocument(document);
      assert(validated.ok, "empty canonical document validates");
    }
  },
  {
    name: "returns new revisions without mutating prior documents",
    run: () => {
      const first = createDefaultCadDocument();
      const baseId = createCadId("feature", "base");
      const bodyId = createCadId("body", "main");
      const second = appendFeature(first, "operation:add-base", feature(baseId, [], [bodyId]), [body(bodyId, baseId)]);
      equal(first.revision, 0, "prior revision remains unchanged");
      equal(first.project.features.length, 0, "prior feature collection remains unchanged");
      equal(second.revision, 1, "new revision increments");
      equal(second.parentRevision, 0, "new revision identifies its parent");
    }
  },
  {
    name: "produces deterministic dependency-first rebuild plans",
    run: () => {
      const document = populatedDocument();
      const ordered = deterministicFeatureOrder(document);
      assert(ordered.ok, "valid graph sorts");
      deepEqual(ordered.value, ["feature:base", "feature:bore", "feature:finish"], "dependency order is stable");
      const plan = planFeatureRebuild(document, { changedFeatureIds: [createCadId("feature", "bore")] });
      assert(plan.ok, "changed-feature plan succeeds");
      deepEqual(plan.value.steps.map((step) => step.featureId), ["feature:bore", "feature:finish"], "only changed feature and descendants rebuild");
    }
  },
  {
    name: "honors feature suppression and blocks active dependents",
    run: () => {
      const document = setFeatureSuppressed(populatedDocument(), "operation:suppress-bore", createCadId("feature", "bore"), true);
      const plan = planFeatureRebuild(document);
      assert(plan.ok, "suppressed graph produces a plan");
      deepEqual(plan.value.skipped.map((item) => item.featureId), ["feature:bore"], "suppressed feature is skipped");
      deepEqual(plan.value.blocked.map((item) => item.featureId), ["feature:finish"], "downstream feature is blocked");
      deepEqual(plan.value.steps.map((item) => item.featureId), ["feature:base"], "unrelated active work remains schedulable");
    }
  },
  {
    name: "honors per-component rollback points",
    run: () => {
      const document = setComponentRollback(
        populatedDocument(),
        "operation:rollback-base",
        createCadId("component", "root"),
        createCadId("feature", "base")
      );
      const plan = planFeatureRebuild(document);
      assert(plan.ok, "rollback graph produces a plan");
      deepEqual(plan.value.steps.map((step) => step.featureId), ["feature:base"], "only timeline through rollback point rebuilds");
      deepEqual(plan.value.skipped.map((step) => step.featureId), ["feature:bore", "feature:finish"], "later timeline features are rolled back");
    }
  },
  {
    name: "rejects cyclic feature dependencies with stable diagnostics",
    run: () => {
      const document = updateFeature(
        populatedDocument(),
        "operation:create-cycle",
        createCadId("feature", "base"),
        (candidate) => ({ ...candidate, dependencies: [createCadId("feature", "finish")] })
      );
      const order = deterministicFeatureOrder(document);
      assert(!order.ok, "cyclic graph is rejected");
      equal(order.diagnostics[0]?.code, "FEATURE_CYCLE", "cycle has a machine-readable diagnostic");
      const validation = validateCadDocument(document);
      assert(!validation.ok, "cyclic document fails validation");
    }
  },
  {
    name: "detects reciprocal ownership corruption",
    run: () => {
      const document = populatedDocument();
      const corrupt = structuredClone(document) as CadDocument;
      const component = corrupt.project.components[0]!;
      (component as { bodyIds: readonly BodyId[] }).bodyIds = [];
      const validation = validateCadDocument(corrupt);
      assert(!validation.ok, "corrupt document is rejected");
      assert(validation.diagnostics.some((item) => item.code === "OWNERSHIP_MISMATCH"), "ownership diagnostic is returned");
    }
  },
  {
    name: "rejects topology references whose source feature does not own the referenced body output",
    run: () => {
      const markerId = createCadId("feature", "marker");
      const finishId = createCadId("feature", "finish");
      const bodyId = createCadId("body", "main");
      let document = appendFeature(populatedDocument(), "operation:add-marker", feature(markerId, [], []));
      document = updateFeature(document, "operation:cross-bind-topology", finishId, (candidate) => ({
        ...candidate,
        inputs: [{
          kind: "topology",
          bodyId,
          subshape: "face",
          persistentName: "face:wrong-source",
          sourceFeatureId: markerId,
          expectedGeometry: "planar"
        }]
      }));
      const validation = validateCadDocument(document);
      assert(!validation.ok, "cross-bound topology reference is rejected");
      assert(validation.diagnostics.some((item) => item.code === "INVALID_REFERENCE" && item.relatedIds.includes(markerId)), "source feature mismatch is diagnosed");
    }
  }
];
