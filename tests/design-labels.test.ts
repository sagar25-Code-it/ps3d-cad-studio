import type { DesignFeature, DesignHistory, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { describeFeature, featureOfBody, featureStatus, featureStatusText, sketchPlaneName } from "../packages/workbench-core/src/index.js";
import { equal, type TestCase } from "./test-kit.js";

const sketch = (plane: string, curves: number): WorkbenchSketch => ({
  id: "sketch:test",
  name: "Test",
  plane,
  entities: Array.from({ length: curves }, (_, index) => ({ id: `entity:${index}`, kind: "point" as const, position: [index, 0] as const, construction: false })),
  constraints: []
} as unknown as WorkbenchSketch);

const features: readonly DesignFeature[] = [
  { id: "feature:s1", name: "Base sketch", kind: "sketch", suppressed: false, sketch: sketch("datum:xz", 3) },
  { id: "feature:e1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s1", profileIds: [], valueMm: 12.5, bodyId: "general-body:a", direction: "symmetric" },
  { id: "feature:r1", name: "Revolve 1", kind: "revolve", suppressed: true, sketchFeatureId: "feature:s1", profileIds: [], valueMm: 180, bodyId: "general-body:b" },
  { id: "feature:e2", name: "Extrude 2", kind: "extrude", suppressed: false, sketchFeatureId: "feature:gone", profileIds: [], valueMm: 4, bodyId: "general-body:c", health: { message: "No closed profile" } }
];
const history = (rollbackIndex: number): DesignHistory => ({ features, rollbackIndex, editingSketchId: null });

export const designLabelTests: readonly TestCase[] = [
  {
    name: "steps are described in the words a user would use",
    run() {
      equal(describeFeature(history(4), features[0]!), "XZ plane · 3 curves", "sketch");
      equal(describeFeature(history(4), features[1]!), "12.5 mm symmetric · from Base sketch", "extrude with a direction");
      equal(describeFeature(history(4), features[2]!), "180° · from Base sketch", "revolve");
      equal(describeFeature(history(4), features[3]!), "4 mm · from a deleted sketch", "a step whose sketch is gone says so");
    }
  },
  {
    name: "the plane name follows the datum plane",
    run() {
      equal(sketchPlaneName("datum:xy"), "XY", "xy");
      equal(sketchPlaneName("datum:yz"), "YZ", "yz");
      equal(sketchPlaneName("datum:xz"), "XZ", "xz");
    }
  },
  {
    name: "a body is traced back to the step that owns it, and a body without a step has none",
    run() {
      equal(featureOfBody(history(4), "general-body:a")?.id, "feature:e1", "owner found");
      equal(featureOfBody(history(4), "general-body:combined"), undefined, "no owner");
    }
  },
  {
    name: "status reports an error first, then suppression, then rollback",
    run() {
      equal(featureStatus(history(4), features[3]!), "error", "health wins");
      equal(featureStatus(history(4), features[2]!), "suppressed", "suppressed");
      equal(featureStatus(history(1), features[1]!), "rolled-back", "after the marker");
      equal(featureStatus(history(4), features[1]!), "active", "on");
      equal(featureStatusText("active"), "", "an active step needs no words");
      equal(featureStatusText("rolled-back"), "rolled back", "words for rollback");
    }
  }
];
