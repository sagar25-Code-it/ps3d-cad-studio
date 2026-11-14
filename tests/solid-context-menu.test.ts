import { resolveWorkbenchContextCommands, type WorkbenchContextCommand } from "../packages/workbench-core/src/index.js";
import { buildMarkingMenu } from "../apps/studio-web/src/ui/marking-menu.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-18: right-click and the marking menu on a solid offer the modelling commands (Edit Feature, Fillet, Chamfer,
 * Shell, Hole, Combine, Pattern), live on a sketch-built solid, instead of a wall of entries disabled with a stale
 * "mesh solids support visibility and delete here" reason.
 */

function flat(commands: readonly WorkbenchContextCommand[]): readonly WorkbenchContextCommand[] {
  return commands.flatMap((entry) => [entry, ...(entry.children ?? [])]);
}

export const solidContextMenuTests: readonly TestCase[] = [
  {
    name: "Right-click on a sketch-built solid offers Edit Feature, Fillet (F), Chamfer, Shell, Hole (H), Combine and Pattern, all live",
    run: () => {
      const commands = flat(resolveWorkbenchContextCommands({ workspace: "part", selectionId: "general-body:block", selectionKind: "body" }));
      const byId = new Map(commands.map((entry) => [entry.id, entry]));
      for (const id of ["feature.edit", "modify.fillet", "modify.chamfer", "modify.shell", "modify.hole", "modify.combine", "modify.pattern"]) {
        const entry = byId.get(id);
        assert(entry !== undefined && entry.enabled, `${id} is offered and live on a general solid`);
      }
      assert(byId.get("modify.fillet")?.shortcut === "F" && byId.get("modify.hole")?.shortcut === "H", "the Fusion letters ride on the menu entries");
      assert(!commands.some((entry) => entry.disabledReason?.includes("General mesh solids support visibility and delete here") === true), "the stale mesh-solid reason is gone");
      const isolate = byId.get("selection.isolate");
      assert(isolate !== undefined && !isolate.enabled && /hide the other bodies/.test(isolate.disabledReason ?? ""), "Isolate stays honest: disabled with a current reason and a workaround");
    }
  },
  {
    name: "The same commands on an analytic preview body are disabled naming what to select instead",
    run: () => {
      const commands = flat(resolveWorkbenchContextCommands({ workspace: "part", selectionId: "part-body:plate", selectionKind: "body" }));
      const fillet = commands.find((entry) => entry.id === "modify.fillet");
      assert(fillet !== undefined && !fillet.enabled && /Extrude or Revolve/.test(fillet.disabledReason ?? ""), "Fillet on an analytic body says what kind of solid it needs");
    }
  },
  {
    name: "The radial marking menu on a body leads with Fillet, Hole and Shell; on a face, Create Sketch comes first",
    run: () => {
      const body = buildMarkingMenu({ workspace: "part", selectionId: "general-body:block", selectionKind: "body", bodyCount: 1 });
      const bodyIds = body.items.map((item) => item.id);
      assert(bodyIds[0] === "modify.fillet" && bodyIds[1] === "modify.hole" && bodyIds[2] === "modify.shell", `the body menu leads with the modelling commands: ${bodyIds.join(", ")}`);
      assert(bodyIds.includes("feature.edit"), "Edit Feature is one flick away on a body");
      assert(body.items.length === 8 && body.items.every((item) => item.enabled), "all eight slots hold live commands on a sketch-built solid");
      const face = buildMarkingMenu({ workspace: "part", selectionId: "general-body:block", selectionKind: "body", faceSelected: true, bodyCount: 1 });
      assert(face.items[0]?.id === "sketch.create", `the face menu leads with Create Sketch: ${face.items.map((item) => item.id).join(", ")}`);
      assert(face.items.some((item) => item.id === "modify.hole"), "Hole is on the face menu");
    }
  }
];
