import {
  applyWorkbenchOperation,
  auditCadCommandSurface,
  CAD_COMMANDS,
  commandsForWorkspace,
  createWorkbenchProject,
  REFERENCE_IMAGE_COMMAND_TERMS,
  validateWorkbenchProject,
  type WorkbenchOperation
} from "../packages/workbench-core/src/index.js";
import {
  analyzeWorkbenchSketch,
  buildSketchEntity,
  detectSketchProfiles,
  resolveQualifiedExtrusion,
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
    name: "independent preview bodies are revisioned, editable, and atomically visible",
    run: () => {
      const project = createWorkbenchProject("project:test-preview-bodies");
      const inserted = applyWorkbenchOperation(project, {
        kind: "add-part-preview-bodies",
        operationId: "operation:test-add-preview-bodies",
        expectedRevision: 0,
        bodies: [
          { id: "part-body:test-block", name: "Block 1", shape: "block", visible: true, color: "#b9bec5", translationMm: [70, 0, 10], rotationDeg: [0, 0, 0], sizeMm: [36, 28, 20] },
          { id: "part-body:test-cone", name: "Cone 1", shape: "cone", visible: true, color: "#adb3ba", translationMm: [112, 0, 17], rotationDeg: [0, 0, 0], sizeMm: [28, 14, 34] }
        ]
      });
      assert(inserted.ok, "bounded primitive bodies should insert atomically");
      equal(inserted.value.project.part.previewBodies?.length, 2, "both bodies should share one project revision");
      equal(inserted.value.project.revision, 1, "one body batch should add one revision");

      const hidden = applyWorkbenchOperation(inserted.value.project, {
        kind: "set-part-preview-bodies-visibility",
        operationId: "operation:test-hide-preview-bodies",
        expectedRevision: 1,
        visible: false
      });
      assert(hidden.ok, "the body collection visibility should update atomically");
      assert(hidden.value.project.part.previewBodies?.every((body) => !body.visible) === true, "every independent preview body should be hidden");
      equal(hidden.value.project.revision, 2, "the visibility transaction should be one revision");
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
    name: "Fusion-familiar rectangle and circle variants resolve deterministically",
    run: () => {
      const centerRectangle = buildSketchEntity("rectangle-center", [[10, 5], [16, 9]], "entity:test-center-rectangle");
      assert(centerRectangle.ok && centerRectangle.value.kind === "rectangle", "center rectangle should build from a center and corner");
      equal(centerRectangle.value.widthMm, 12, "center rectangle width should span both sides of its center");
      equal(centerRectangle.value.heightMm, 8, "center rectangle height should span both sides of its center");

      const rotatedRectangle = buildSketchEntity("rectangle-three-point", [[0, 0], [10, 10], [6, 14]], "entity:test-rotated-rectangle");
      assert(rotatedRectangle.ok && rotatedRectangle.value.kind === "rectangle", "three points should build an oriented rectangle");
      near(rotatedRectangle.value.widthMm, Math.sqrt(200), 1e-12, "first edge should drive the rectangle width");
      near(rotatedRectangle.value.rotationDeg, 45, 1e-12, "first edge should drive the rectangle angle");

      const diameterCircle = buildSketchEntity("circle-two-point", [[-5, 0], [5, 0]], "entity:test-diameter-circle");
      assert(diameterCircle.ok && diameterCircle.value.kind === "circle", "two diameter endpoints should build a circle");
      near(diameterCircle.value.center[0], 0, 1e-12, "two-point circle center should be the diameter midpoint");
      near(diameterCircle.value.radiusMm, 5, 1e-12, "two-point circle radius should be half the diameter");

      const circumcircle = buildSketchEntity("circle-three-point", [[5, 0], [0, 5], [-5, 0]], "entity:test-three-point-circle");
      assert(circumcircle.ok && circumcircle.value.kind === "circle", "three non-collinear points should build their unique circle");
      near(circumcircle.value.center[0], 0, 1e-12, "three-point circle should solve its X center");
      near(circumcircle.value.center[1], 0, 1e-12, "three-point circle should solve its Y center");
      near(circumcircle.value.radiusMm, 5, 1e-12, "three-point circle should solve its radius");
    }
  },
  {
    name: "closed sketch profiles drive the qualified extrusion envelope",
    run: () => {
      const project = createWorkbenchProject("project:test-profile-extrusion");
      const profiles = detectSketchProfiles(project.sketch);
      const outline = profiles.find((profile) => profile.entityIds.includes("entity:mounting-outline"));
      const bore = profiles.find((profile) => profile.entityIds.includes("entity:centered-bore-profile"));
      assert(outline !== undefined && bore !== undefined, "the seeded outline and bore should be selectable closed profiles");
      equal(profiles[0]?.id, outline.id, "larger profiles should be ordered behind smaller nested profiles for canvas hit testing");

      const extrusion = resolveQualifiedExtrusion(project.sketch, [outline.id, bore.id], 14);
      assert(extrusion.ok, "one axis-aligned rectangle and concentric bore should enter the qualified evaluator");
      equal(extrusion.value.widthMm, 60, "the selected outline should drive solid width");
      equal(extrusion.value.heightMm, 40, "the selected outline should drive solid height");
      equal(extrusion.value.holeDiameterMm, 10, "the selected circle should drive the through-bore");
      equal(extrusion.value.distanceMm, 14, "the feature distance should drive solid thickness");

      const offCenter = {
        ...project.sketch,
        entities: project.sketch.entities.map((entity) => entity.id === "entity:centered-bore-profile" && entity.kind === "circle" ? { ...entity, center: [2, 0] as const } : entity)
      };
      const invalid = resolveQualifiedExtrusion(offCenter, detectSketchProfiles(offCenter).map((profile) => profile.id), 14);
      assert(!invalid.ok, "an off-center bore must not be presented as a qualified solid");
      equal(invalid.diagnostics[0]?.code, "INVALID_OPERATION", "unsupported profile intent should remain explicitly typed");
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

      const hidden = applyWorkbenchOperation(construction.value.project, {
        kind: "toggle-sketch-entity-visibility",
        operationId: "operation:test-hide-outline",
        expectedRevision: 2,
        entityId: "entity:mounting-outline"
      });
      assert(hidden.ok, "a sketch entity should support persisted visibility");
      equal(hidden.value.project.sketch.entities.find((entity) => entity.id === "entity:mounting-outline")?.visible, false, "the entity should be hidden without deleting geometry");
      equal(hidden.value.project.revision, 3, "visibility should create one audited revision");

      const shown = applyWorkbenchOperation(hidden.value.project, {
        kind: "toggle-sketch-entity-visibility",
        operationId: "operation:test-show-outline",
        expectedRevision: 3,
        entityId: "entity:mounting-outline"
      });
      assert(shown.ok, "a hidden sketch entity should be restorable");
      equal(shown.value.project.sketch.entities.find((entity) => entity.id === "entity:mounting-outline")?.visible, true, "show should restore the same stable entity");

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
      assert(CAD_COMMANDS.length >= 200, "the cross-workspace catalog should expose the audited professional command surface");
      assert(commandsForWorkspace("assembly").some((command) => command.action.kind === "insert-component"), "assembly should expose functional insertion commands");
      assert(CAD_COMMANDS.some((command) => command.action.kind === "set-view-orientation"), "named viewport orientations should be searchable commands");
      assert(CAD_COMMANDS.some((command) => command.action.kind === "set-navigation-mode" && command.action.mode === "measure"), "measurement should be a searchable viewport command");
      assert(CAD_COMMANDS.some((command) => command.action.kind === "insert-current-part-into-assembly"), "the current part should have a searchable downstream assembly command");
      assert(commandsForWorkspace("automate").some((command) => command.name === "Python SDK" && command.level === "preview"), "Python linking should be explicit and preview labeled");
      assert(CAD_COMMANDS.some((command) => command.level === "qualified"), "qualified commands should remain distinguishable");
      assert(CAD_COMMANDS.some((command) => command.level === "unavailable"), "planned exact-kernel commands should remain visibly unavailable");
      const analyticFeatureNames = ["Revolve", "Pattern Feature", "Mirror Feature", "Unite", "Subtract", "Trim Body", "Edge Blend", "Chamfer", "Draft", "Shell", "Move Face", "Offset Face", "Replace Face", "Delete Face", "Resize Blend", "Update Model"];
      analyticFeatureNames.forEach((name) => assert(CAD_COMMANDS.some((command) => command.name === name && command.action.kind === "part-feature-action" && command.level === "preview"), `${name} should be executable through the bounded analytic feature contract`));
      assert(CAD_COMMANDS.every((command) => command.guide.selection.length > 0 && command.guide.steps.length >= 3 && command.guide.boundary.length > 0), "every command should explain selection, workflow, and its verification boundary");
      const audit = auditCadCommandSurface();
      assert(audit.passed, `machine command audit should pass: ${audit.issues.map((issue) => `${issue.commandId}:${issue.code}`).join(", ")}`);
      equal(audit.total, CAD_COMMANDS.length, "audit should cover every catalog entry");
      equal(audit.executable + audit.truthfullyBlocked, CAD_COMMANDS.length, "every command should be either executable or truthfully blocked");
      assert(audit.actionKindsCovered.length >= 25, "the UI dispatcher contract should cover the complete bounded action family");
    }
  },
  {
    name: "every supplied reference-image command term remains discoverable",
    run: () => {
      const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
      const searchableCommands = CAD_COMMANDS.map((command) =>
        normalize(`${command.id} ${command.name} ${command.description} ${command.keywords.join(" ")}`)
      );
      const missing = REFERENCE_IMAGE_COMMAND_TERMS.filter((term) => {
        const needle = normalize(term);
        return !searchableCommands.some((command) => command.includes(needle));
      });
      equal(REFERENCE_IMAGE_COMMAND_TERMS.length, 230, "the screenshot transcription should retain all 230 unique reference terms");
      equal(missing.join(", "), "", "every supplied reference-image command term should remain discoverable without implying execution");
      equal(CAD_COMMANDS.length, 341, "the audited catalog count should remain synchronized with release copy and evidence");
    }
  }
];
