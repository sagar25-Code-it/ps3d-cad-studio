import {
  applyWorkbenchOperation,
  CAD_COMMANDS,
  commandsForWorkspace,
  createWorkbenchProject,
  validateWorkbenchProject,
  type WorkbenchOperation
} from "../packages/workbench-core/src/index.js";
import {
  analyzeWorkbenchSketch,
  buildSketchEntity,
  snapSketchPoint
} from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const workbenchCoreTests: readonly TestCase[] = [
  {
    name: "default broad workbench project validates",
    run: () => {
      const project = createWorkbenchProject("project:test-default");
      const result = validateWorkbenchProject(project);
      assert(result.ok, "the project factory must produce a valid project");
      equal(result.value.revision, 0, "new projects begin at revision zero");
      equal(result.value.assembly.components.length, 5, "fixture preview has a bounded component set");
    }
  },
  {
    name: "workbench operations are revision checked and exactly idempotent",
    run: () => {
      const project = createWorkbenchProject("project:test-operation");
      const operation: WorkbenchOperation = {
        kind: "set-part-parameter",
        operationId: "operation:test-width",
        expectedRevision: 0,
        parameter: "widthMm",
        value: 92
      };
      const first = applyWorkbenchOperation(project, operation);
      assert(first.ok, "valid operation should apply");
      equal(first.value.project.part.widthMm, 92, "the intended value should be stored");
      equal(first.value.project.revision, 1, "one operation should create one revision");
      equal(first.value.exactRetry, false, "first application is not a retry");

      const retry = applyWorkbenchOperation(first.value.project, operation);
      assert(retry.ok, "an exact operation retry should succeed");
      equal(retry.value.exactRetry, true, "retry must be explicitly classified");
      equal(retry.value.project.revision, 1, "an exact retry must not add a revision");

      const conflict = applyWorkbenchOperation(first.value.project, { ...operation, value: 93 });
      assert(!conflict.ok, "reusing an operation ID for different intent must fail");
      equal(conflict.diagnostics[0]?.code, "IDEMPOTENCY_CONFLICT", "the conflict should be typed");

      const stale = applyWorkbenchOperation(first.value.project, {
        kind: "select-workspace",
        operationId: "operation:test-stale",
        expectedRevision: 0,
        workspace: "surface"
      });
      assert(!stale.ok, "a stale revision should fail");
      equal(stale.diagnostics[0]?.code, "REVISION_CONFLICT", "stale intent should report its revision conflict");
    }
  },
  {
    name: "invalid bore edit rolls back without a partial project",
    run: () => {
      const project = createWorkbenchProject("project:test-rollback");
      const result = applyWorkbenchOperation(project, {
        kind: "set-part-parameter",
        operationId: "operation:test-invalid-bore",
        expectedRevision: 0,
        parameter: "holeDiameterMm",
        value: 39
      });
      assert(!result.ok, "a bore leaving less than the wall allowance must fail");
      equal(result.diagnostics[0]?.code, "DEGENERATE_GEOMETRY", "the geometric failure should be typed");
      equal(project.revision, 0, "the input project must remain unchanged");
      equal(project.part.holeDiameterMm, 10, "the original part intent must remain unchanged");
    }
  },
  {
    name: "general sketch tools build entities and snap deterministically",
    run: () => {
      const project = createWorkbenchProject("project:test-sketch-tools");
      const line = buildSketchEntity("line", [[0, 0], [12, 0]], "entity:test-line");
      assert(line.ok, "two distinct points should build a line");
      equal(line.value.kind, "line", "line tool should return a line entity");

      const snap = snapSketchPoint([-26.6, 0.2], project.sketch);
      assert(snap.snapped, "a point inside endpoint tolerance should snap");
      equal(snap.kind, "endpoint", "entity points take precedence over the grid");
      equal(snap.targetId, "entity:left-mount", "the nearest stable entity should be reported");
      near(snap.point[0], -27, 1e-12, "snapped X should be exact");

      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(analysis.classification, "fully-constrained", "the seeded profile should be fully constrained");
      equal(analysis.degreesOfFreedom, 0, "fixed seeded entities should have no remaining DOF");
    }
  },
  {
    name: "sketch diagnostics expose contradictory orientation constraints",
    run: () => {
      const project = createWorkbenchProject("project:test-sketch-conflict");
      const sketch = {
        ...project.sketch,
        entities: [{ id: "entity:test-axis", kind: "line", start: [0, 0], end: [10, 0], construction: false }] as const,
        constraints: [
          { id: "constraint:test-horizontal", kind: "horizontal", entityIds: ["entity:test-axis"] },
          { id: "constraint:test-vertical", kind: "vertical", entityIds: ["entity:test-axis"] }
        ] as const
      };
      const analysis = analyzeWorkbenchSketch(sketch);
      equal(analysis.classification, "conflict", "contradictory orientation intent should be visible");
      assert(analysis.conflicts.some((message) => message.includes("both horizontal and vertical")), "conflict should explain the contradiction");
    }
  },
  {
    name: "assembly component editing is bounded, audited, and reversible by operation",
    run: () => {
      const project = createWorkbenchProject("project:test-assembly-editing");
      const component = {
        id: "component:test-box",
        name: "Test box",
        shape: "box",
        grounded: false,
        visible: true,
        color: "#55c3d8",
        translationMm: [10, 20, 30],
        rotationDeg: [0, 0, 0],
        sizeMm: [20, 15, 8],
        explosionDirection: [0.25, 0.5, 0.75]
      } as const;
      const inserted = applyWorkbenchOperation(project, { kind: "add-assembly-component", operationId: "operation:test-insert-box", expectedRevision: 0, component });
      assert(inserted.ok, "a bounded box component should insert");
      equal(inserted.value.project.assembly.components.length, 6, "insertion should add exactly one component");

      const moved = applyWorkbenchOperation(inserted.value.project, { kind: "set-component-translation", operationId: "operation:test-move-box", expectedRevision: 1, componentId: component.id, translationMm: [40, -12, 9] });
      assert(moved.ok, "a bounded translation should apply");
      equal(moved.value.project.assembly.components.find((item) => item.id === component.id)?.translationMm[0], 40, "the X translation should be stored");

      const hidden = applyWorkbenchOperation(moved.value.project, { kind: "toggle-component-visibility", operationId: "operation:test-hide-box", expectedRevision: 2, componentId: component.id });
      assert(hidden.ok, "visibility should toggle");
      equal(hidden.value.project.assembly.components.find((item) => item.id === component.id)?.visible, false, "the component should be hidden");

      const deleted = applyWorkbenchOperation(hidden.value.project, { kind: "delete-assembly-component", operationId: "operation:test-delete-box", expectedRevision: 3, componentId: component.id });
      assert(deleted.ok, "an unreferenced inserted component should delete");
      equal(deleted.value.project.assembly.components.length, 5, "deletion should restore the original component count");
      equal(deleted.value.project.revision, 4, "the four edits should create four audit revisions");

      const outside = applyWorkbenchOperation(project, { kind: "set-component-translation", operationId: "operation:test-move-outside", expectedRevision: 0, componentId: "component:base", translationMm: [10_001, 0, 0] });
      assert(!outside.ok, "translation outside the preview envelope must fail");
      equal(outside.diagnostics[0]?.code, "INVALID_OPERATION", "an invalid operation payload should be typed");
    }
  },
  {
    name: "driving sketch dimensions update bounded geometry and records atomically",
    run: () => {
      const project = createWorkbenchProject("project:test-driving-dimension");
      const dimensioned = applyWorkbenchOperation(project, {
        kind: "set-sketch-dimension",
        operationId: "operation:test-outline-width",
        expectedRevision: 0,
        entityId: "entity:mounting-outline",
        dimension: "width",
        valueMm: 92
      });
      assert(dimensioned.ok, "a supported rectangle width should apply");
      const outline = dimensioned.value.project.sketch.entities.find((entity) => entity.id === "entity:mounting-outline");
      assert(outline?.kind === "rectangle", "the mounting outline should remain a rectangle");
      equal(outline.widthMm, 92, "the rectangle geometry should be resized");
      const dimension = dimensioned.value.project.sketch.constraints.find((constraint) => constraint.dimension === "width");
      equal(dimension?.valueMm, 92, "the driving dimension record should match the geometry");
      equal(dimensioned.value.project.revision, 1, "dimensioning should create one audit revision");

      const construction = applyWorkbenchOperation(dimensioned.value.project, {
        kind: "toggle-sketch-construction",
        operationId: "operation:test-outline-construction",
        expectedRevision: 1,
        entityId: "entity:mounting-outline"
      });
      assert(construction.ok, "profile geometry should toggle to construction geometry");
      equal(construction.value.project.sketch.entities.find((entity) => entity.id === "entity:mounting-outline")?.construction, true, "construction state should persist");

      const incompatible = applyWorkbenchOperation(project, {
        kind: "set-sketch-dimension",
        operationId: "operation:test-invalid-radius",
        expectedRevision: 0,
        entityId: "entity:center-guide",
        dimension: "radius",
        valueMm: 5
      });
      assert(!incompatible.ok, "a line cannot accept a radius dimension");
      equal(incompatible.diagnostics[0]?.code, "INVALID_OPERATION", "incompatible dimension intent should be typed");
    }
  },
  {
    name: "professional command registry is unique and truth labeled",
    run: () => {
      const ids = new Set(CAD_COMMANDS.map((command) => command.id));
      equal(ids.size, CAD_COMMANDS.length, "command IDs must be unique");
      assert(CAD_COMMANDS.length >= 70, "the cross-workspace catalog should expose a substantial command surface");
      assert(commandsForWorkspace("assembly").some((command) => command.action.kind === "insert-component"), "assembly should expose functional insertion commands");
      assert(CAD_COMMANDS.some((command) => command.action.kind === "set-view-orientation"), "named viewport orientations should be searchable commands");
      assert(CAD_COMMANDS.some((command) => command.action.kind === "set-navigation-mode" && command.action.mode === "measure"), "measurement should be a searchable viewport command");
      assert(commandsForWorkspace("automate").some((command) => command.name === "Python SDK" && command.level === "preview"), "Python linking should be explicit and preview labeled");
      assert(CAD_COMMANDS.some((command) => command.level === "qualified"), "qualified commands should remain distinguishable");
      assert(CAD_COMMANDS.some((command) => command.level === "unavailable"), "planned exact-kernel commands should remain visibly unavailable");
    }
  }
];
