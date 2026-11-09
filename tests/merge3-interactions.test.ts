import { applyWorkbenchOperation, type Vec2, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { filletCorners, cornerByClick } from "../packages/workbench-sketch/src/corner-tools.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { applyOk, con, ctx, ids, line, projectWith, rect } from "./edit-test-kit.js";
import { wholeProblem } from "./sketch-shapes3-kit.js";

/**
 * Where two fix3 branches meet: a fillet (edit3) followed by a dimension edit that the outline guard (solver3) and the open-joint guard
 * (shapes3) both look at, and a quarter turn (pipeline3 and solver3) on lines that are joined or pinned.
 */

function setDimension(project: WorkbenchProject, operation: Record<string, unknown>): ReturnType<typeof applyWorkbenchOperation> {
  return applyWorkbenchOperation(project, { operationId: `operation:m3-${Math.random().toString(36).slice(2)}`, expectedRevision: project.revision, kind: "set-sketch-dimension", ...operation } as never);
}

function plate(): WorkbenchProject {
  const lines = [line("b", [0, 0], [80, 0]), line("r", [80, 0], [80, 50]), line("t", [80, 50], [0, 50]), line("l", [0, 50], [0, 0])];
  const joints = [
    con("c1", "coincident", ["b", "r"], { points: ["end", "start"] }), con("c2", "coincident", ["r", "t"], { points: ["end", "start"] }),
    con("c3", "coincident", ["t", "l"], { points: ["end", "start"] }), con("c4", "coincident", ["l", "b"], { points: ["end", "start"] }),
    con("h1", "horizontal", ["b"]), con("h2", "horizontal", ["t"]), con("v1", "vertical", ["r"]), con("v2", "vertical", ["l"]),
    { id: "constraint:pin", kind: "coincident", entityIds: ["sketch:origin", "entity:b"], points: ["self", "start"] } as const,
    con("lb", "distance", ["b"], { valueMm: 80, dimension: "length" }), con("lr", "distance", ["r"], { valueMm: 50, dimension: "length" })
  ];
  return projectWith(lines, joints);
}

export const merge3InteractionTests: readonly TestCase[] = [
  {
    name: "Merge fix3: a size dimension of a filleted plate and of a filleted Rectangle can still be edited (neither the outline guard nor the open-joint guard refuses it) and the outline stays one closed profile",
    run: () => {
      let rounded = plate();
      for (const corner of [[80, 0], [80, 50], [0, 50], [0, 0]] as const) rounded = applyOk(rounded, cornerByClick(ctx(rounded), corner as unknown as Vec2, 0.5, { kind: "fillet", radiusMm: 6, dimension: true }));
      // The fillet turned the 80 mm length into the distance from the line's start to the (virtual) corner, so the part size stays driven: that is the dimension to edit.
      const size = rounded.sketch.constraints.find((constraint) => constraint.kind === "distance" && constraint.valueMm === 80);
      assert(size !== undefined && size.entityIds.length === 2 && size.points !== undefined, "the 80 mm size is kept as a corner-to-corner distance");
      const wider = setDimension(rounded, { entityId: size!.entityIds[0]!, secondEntityId: size!.entityIds[1]!, dimension: "aligned", points: size!.points!, valueMm: 100 });
      assert(wider.ok, `the 80 mm size takes 100 after four fillets: ${wider.ok ? "" : wider.diagnostics[0]?.message}`);
      if (wider.ok) {
        const xs = wider.value.project.sketch.entities.flatMap((entity) => (entity.kind === "line" ? [entity.start[0], entity.end[0]] : entity.kind === "arc" ? [entity.mid[0]] : []));
        near(Math.max(...xs) - Math.min(...xs), 100, 1e-6, "the part is 100 wide");
        assert(wholeProblem(wider.value.project, 1, true) === undefined, `and is still one whole profile: ${wholeProblem(wider.value.project, 1, true)}`);
      }
      const base = projectWith([rect("r", [50, 30], 100, 60)], [
        con("w", "distance", ["r"], { valueMm: 100, dimension: "width" }), con("h", "distance", ["r"], { valueMm: 60, dimension: "height" }),
        { id: "constraint:o", kind: "coincident", entityIds: ["sketch:origin", "entity:r"], points: ["self", "corner-0"] }
      ]);
      const roundedRect = applyOk(base, filletCorners(ctx(base), ids("r"), 8));
      const height = roundedRect.sketch.constraints.find((constraint) => constraint.kind === "distance" && constraint.valueMm === 60);
      assert(height !== undefined && height.entityIds.length === 2 && height.points !== undefined, "the 60 mm height is kept as a corner-to-corner distance");
      const taller = setDimension(roundedRect, { entityId: height!.entityIds[0]!, secondEntityId: height!.entityIds[1]!, dimension: height!.dimension ?? "aligned", points: height!.points!, valueMm: 70 });
      assert(taller.ok, `the rounded rectangle takes a height of 70: ${taller.ok ? "" : taller.diagnostics[0]?.message}`);
      if (taller.ok) assert(wholeProblem(taller.value.project, 1, true) === undefined, `and is still one whole profile: ${wholeProblem(taller.value.project, 1, true)}`);
    }
  },
  {
    name: "Merge fix3: Horizontal on a vertical line pinned to the origin turns about the pin, a Fixed line is not turned, and Perpendicular on parallel lines turns the free one",
    run: () => {
      const pinned = projectWith([line("v", [0, 0], [0, 40])], []);
      const turned = applyWorkbenchOperation(pinned, { operationId: "operation:m3-h", expectedRevision: pinned.revision, kind: "add-sketch-constraint", constraint: con("h", "horizontal", ["v"]) } as never);
      assert(turned.ok, `Horizontal on the vertical line is applied: ${turned.ok ? "" : turned.diagnostics[0]?.message}`);
      if (turned.ok) {
        const turnedLine = turned.value.project.sketch.entities.find((entity) => entity.id === "entity:v");
        assert(turnedLine?.kind === "line" && turnedLine.start[0] === 0 && turnedLine.start[1] === 0 && Math.abs(turnedLine.end[0] - 40) < 1e-9 && Math.abs(turnedLine.end[1]) < 1e-9, `the line swings about the origin end: ${JSON.stringify(turnedLine)}`);
      }
      const fixed = projectWith([line("f", [10, 0], [10, 40])], [con("fx", "fixed", ["f"])]);
      const refused = applyWorkbenchOperation(fixed, { operationId: "operation:m3-f", expectedRevision: fixed.revision, kind: "add-sketch-constraint", constraint: con("h2", "horizontal", ["f"]) } as never);
      assert(!refused.ok, "a Fixed vertical line cannot also be made Horizontal");
      const parallel = projectWith([line("a", [0, 0], [30, 0]), line("b", [0, 10], [30, 10])], []);
      const square = applyWorkbenchOperation(parallel, { operationId: "operation:m3-p", expectedRevision: parallel.revision, kind: "add-sketch-constraint", constraint: con("pp", "perpendicular", ["a", "b"]) } as never);
      assert(square.ok, `Perpendicular on two parallel lines is applied: ${square.ok ? "" : square.diagnostics[0]?.message}`);
    }
  }
];
