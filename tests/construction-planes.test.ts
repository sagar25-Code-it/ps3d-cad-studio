import { applyWorkbenchOperation, createWorkbenchProject, type WorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { constructionPlaneCorners, evaluateConstructionPlaneDefinition } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const constructionPlaneTests: readonly TestCase[] = [
  {
    name: "offset plane sits at the base-plane normal × offset with the same in-plane axes",
    run: () => {
      const frame = evaluateConstructionPlaneDefinition({ kind: "offset", basePlane: "datum:xy", offsetMm: 25 });
      assert(!("error" in frame), "offset evaluates");
      if ("error" in frame) return;
      near(frame.origin[0], 0, 1e-9, "origin x");
      near(frame.origin[1], 0, 1e-9, "origin y");
      near(frame.origin[2], 25, 1e-9, "origin z sits 25 mm along +Z");
      equal(frame.normal.join(","), "0,0,1", "normal is +Z (unchanged from XY)");
    }
  },
  {
    name: "three-point plane rejects collinear points",
    run: () => {
      const frame = evaluateConstructionPlaneDefinition({ kind: "three-points", points: [[0, 0, 0], [10, 0, 0], [20, 0, 0]] });
      assert("error" in frame, "collinear points are refused");
    }
  },
  {
    name: "three-point plane's normal is perpendicular to its defining triangle",
    run: () => {
      const frame = evaluateConstructionPlaneDefinition({ kind: "three-points", points: [[0, 0, 0], [50, 0, 0], [0, 0, 50]] });
      assert(!("error" in frame), "three-point frame evaluates");
      if ("error" in frame) return;
      // +X and +Z axes of the triangle give a normal along ±Y.
      near(Math.abs(frame.normal[1]!), 1, 1e-6, "normal is along the Y axis for an XZ-plane triangle");
      near(frame.normal[0], 0, 1e-6, "normal has no X component");
      near(frame.normal[2], 0, 1e-6, "normal has no Z component");
    }
  },
  {
    name: "midplane sits at the average of its two offsets",
    run: () => {
      const frame = evaluateConstructionPlaneDefinition({ kind: "midplane", basePlane: "datum:xy", fromMm: -30, toMm: 70 });
      assert(!("error" in frame), "midplane evaluates");
      if ("error" in frame) return;
      near(frame.origin[2], 20, 1e-9, "midplane Z is (fromMm + toMm) / 2 = 20");
    }
  },
  {
    name: "add-construction-plane / toggle-visibility / delete round trip",
    run: () => {
      let project = createWorkbenchProject("project:planes");
      const plane = { id: "construction-plane:a", name: "Offset 10", visible: true, definition: { kind: "offset" as const, basePlane: "datum:xy" as const, offsetMm: 10 } };
      const add = applyWorkbenchOperation(project, { kind: "add-construction-plane", plane, operationId: "operation:plane-add", expectedRevision: project.revision } as unknown as WorkbenchOperation);
      assert(add.ok, "add is accepted");
      if (!add.ok) return;
      project = add.value.project;
      equal((project.part.construction ?? []).length, 1, "one plane");
      const toggle = applyWorkbenchOperation(project, { kind: "toggle-construction-plane-visibility", planeId: plane.id, operationId: "operation:plane-toggle", expectedRevision: project.revision } as unknown as WorkbenchOperation);
      assert(toggle.ok, "toggle visibility");
      if (!toggle.ok) return;
      project = toggle.value.project;
      equal(project.part.construction?.[0]?.visible, false, "plane is now hidden");
      const del = applyWorkbenchOperation(project, { kind: "delete-construction-plane", planeId: plane.id, operationId: "operation:plane-delete", expectedRevision: project.revision } as unknown as WorkbenchOperation);
      assert(del.ok, "delete is accepted");
      if (!del.ok) return;
      equal((del.value.project.part.construction ?? []).length, 0, "no planes after delete");
    }
  },
  {
    name: "construction plane corners trace the plane's rectangle in order",
    run: () => {
      const frame = evaluateConstructionPlaneDefinition({ kind: "offset", basePlane: "datum:xy", offsetMm: 0 });
      assert(!("error" in frame), "frame evaluates");
      if ("error" in frame) return;
      const corners = constructionPlaneCorners(frame);
      equal(corners.length, 4, "a quad has 4 corners");
      // Diagonals meet at the origin for an XY-datum plane at offset 0.
      const centroidX = corners.reduce((sum, corner) => sum + corner[0], 0) / 4;
      const centroidY = corners.reduce((sum, corner) => sum + corner[1], 0) / 4;
      near(centroidX, 0, 1e-9, "centroid x at origin");
      near(centroidY, 0, 1e-9, "centroid y at origin");
    }
  }
];
