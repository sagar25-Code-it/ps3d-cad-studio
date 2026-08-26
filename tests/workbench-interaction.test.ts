import {
  applyWorkbenchOperation,
  classifyWorkbenchSelection,
  createWorkbenchProject,
  resolveWorkbenchContextCommands
} from "../packages/workbench-core/src/index.js";
import {
  selectConnectedSketchEntities,
  selectTangentSketchEntities
} from "../packages/workbench-sketch/src/index.js";
import {
  orbitViewAngles,
  projectWorldAxes,
  viewAnglesForOrientation
} from "../packages/viewport-three/src/index.js";
import { selectWorkbenchHistoryLane } from "../apps/studio-web/src/ui/history-lane.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const workbenchInteractionTests: readonly TestCase[] = [
  {
    name: "ViewCube and WCS share one orthonormal camera convention",
    run: () => {
      const right = viewAnglesForOrientation("right");
      const rightProjection = projectWorldAxes(...right);
      near(rightProjection.x.depth, 1, 1e-12, "right view should look from positive world X");

      const front = viewAnglesForOrientation("front");
      const frontProjection = projectWorldAxes(...front);
      near(frontProjection.y.depth, -1, 1e-12, "front view should look from negative world Y");

      const top = viewAnglesForOrientation("top");
      const topProjection = projectWorldAxes(...top);
      near(topProjection.z.depth, 1, 2e-4, "top view should look from positive world Z");

      for (const projected of [rightProjection, frontProjection, topProjection]) {
        const axes = [projected.x, projected.y, projected.z];
        for (const axis of axes) near(axis.x ** 2 + axis.y ** 2 + axis.depth ** 2, 1, 1e-10, "projected WCS axes should remain unit vectors");
        near(dot(axes[0]!, axes[1]!), 0, 1e-10, "world X and Y should remain orthogonal on the shared camera basis");
        near(dot(axes[1]!, axes[2]!), 0, 1e-10, "world Y and Z should remain orthogonal on the shared camera basis");
      }

      const draggedRight = orbitViewAngles(10, 20, 20, 0);
      assert(draggedRight[0] > 10, "dragging right should increase azimuth instead of reversing the pointer");
      const draggedUp = orbitViewAngles(10, 20, 0, -20);
      assert(draggedUp[1] > 20, "dragging upward should raise camera elevation");
    }
  },
  {
    name: "global Undo and Redo retain broad-project history across workspace switches",
    run: () => {
      equal(selectWorkbenchHistoryLane("sketch", 0, 1), "broad-project", "Sketch edits should use broad-project history");
      equal(selectWorkbenchHistoryLane("part", 0, 1), "broad-project", "a broad edit must remain undoable after switching to Part");
      equal(selectWorkbenchHistoryLane("part", 1, 1), "qualified-part", "a pending qualified Part-worker edit should retain priority while in Part");
      equal(selectWorkbenchHistoryLane("assembly", 4, 0), null, "qualified Part history must not leak into another workspace");
      equal(selectWorkbenchHistoryLane("part", 0, 0), null, "empty histories should disable the global control");
    }
  },
  {
    name: "sketch connected and tangent selection intents preserve topology boundaries",
    run: () => {
      const project = createWorkbenchProject("project:test-selection-intent");
      const sketch = {
        ...project.sketch,
        snapToleranceMm: 0.1,
        entities: [
          { id: "entity:chain-a", kind: "line", start: [0, 0], end: [10, 0], construction: false },
          { id: "entity:chain-b", kind: "line", start: [10, 0], end: [20, 0], construction: false },
          { id: "entity:branch-c", kind: "line", start: [20, 0], end: [20, 10], construction: false },
          { id: "entity:detached", kind: "line", start: [50, 50], end: [60, 50], construction: false }
        ] as const,
        constraints: [],
        dimensions: []
      };
      equal(selectConnectedSketchEntities(sketch, "entity:chain-a").join(","), "entity:branch-c,entity:chain-a,entity:chain-b", "connected intent should traverse the complete endpoint-connected component");
      equal(selectTangentSketchEntities(sketch, "entity:chain-a").join(","), "entity:chain-a,entity:chain-b", "tangent intent should stop at the 90-degree branch");
      equal(selectConnectedSketchEntities(sketch, "entity:missing").length, 0, "an unknown seed should select nothing");
    }
  },
  {
    name: "workspace context menus are selection-aware and truthfully disable unsupported booleans",
    run: () => {
      equal(classifyWorkbenchSelection("profile:mounting"), "profile", "profile IDs should classify deterministically");
      equal(classifyWorkbenchSelection("component:base"), "component", "component IDs should classify deterministically");

      const profileCommands = resolveWorkbenchContextCommands({ workspace: "sketch", selectionId: "profile:mounting", canUndo: true });
      assert(profileCommands.some((command) => command.id === "feature.extrude" && command.enabled), "a selected sketch profile should offer Extrude");

      const bodyCommands = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "body:qualified" });
      assert(bodyCommands.some((command) => command.id === "body.create-component" && command.enabled), "a selected body should offer Create Component");
      assert(bodyCommands.filter((command) => command.id.startsWith("body.boolean-")).every((command) => !command.enabled && command.disabledReason?.includes("B-rep") === true), "unsafe booleans should remain visible with an exact-kernel reason");

      const sketchCanvasCommands = resolveWorkbenchContextCommands({ workspace: "sketch", selectionId: null });
      assert(sketchCanvasCommands.some((command) => command.id === "sketch.select-connected" && command.enabled), "empty sketch canvas should expose connected-curve intent");
      assert(sketchCanvasCommands.some((command) => command.id === "sketch.look-at" && command.enabled), "empty sketch canvas should expose Look At");

      const sketchEntityCommands = resolveWorkbenchContextCommands({ workspace: "sketch", selectionId: "entity:mounting-outline" });
      assert(sketchEntityCommands.some((command) => command.id === "sketch.dimension" && command.enabled), "a selected sketch entity should expose direct dimensioning");
      assert(sketchEntityCommands.some((command) => command.id === "selection.toggle-visibility" && command.enabled), "a selected sketch entity should expose persisted show/hide");
    }
  },
  {
    name: "assembly mates add and delete through revision-checked operations",
    run: () => {
      const project = createWorkbenchProject("project:test-mate-editing");
      const mate = {
        id: "mate:test-base-left-axis",
        name: "Base to left spacer axis",
        kind: "aligned-axis",
        componentIds: ["component:base", "component:spacer-left"],
        axis: "z",
        status: "satisfied"
      } as const;
      const added = applyWorkbenchOperation(project, {
        kind: "add-assembly-mate",
        operationId: "operation:test-add-mate",
        expectedRevision: 0,
        mate
      });
      assert(added.ok, "a mate between two existing components should apply");
      assert(added.value.project.assembly.mates.some((entry) => entry.id === mate.id), "the assembly tree should receive the new mate record");

      const removed = applyWorkbenchOperation(added.value.project, {
        kind: "delete-assembly-mate",
        operationId: "operation:test-delete-mate",
        expectedRevision: 1,
        mateId: mate.id
      });
      assert(removed.ok, "a user-authored mate should be removable");
      assert(!removed.value.project.assembly.mates.some((entry) => entry.id === mate.id), "mate deletion should update the assembly relationship folder");
      equal(removed.value.project.revision, 2, "mate add and delete should create two audited revisions");
    }
  }
];

function dot(left: { readonly x: number; readonly y: number; readonly depth: number }, right: { readonly x: number; readonly y: number; readonly depth: number }): number {
  return left.x * right.x + left.y * right.y + left.depth * right.depth;
}
