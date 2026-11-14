import { designOf, nextBodyName, resolveWorkbenchContextCommands, splitPieceId, splitPieceName, uniqueBodyName, validateWorkbenchProject, WORKBENCH_OPERATION_KINDS, type GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { applyOp, PLATE_BODY, plateHoleFillet, refusedOp, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-20: bodies have names of their own: rename, persistence, and a rebuild keeps the name. */

const bodyName = (project: ReturnType<typeof plateHoleFillet>, id: string): string | undefined => project.part.generalBodies?.find((body) => body.id === id)?.name;

export const bodyRenameTests: readonly TestCase[] = [
  {
    name: "rename-general-body renames the body, survives save and reload, and is one revision",
    run: () => {
      const project = plateHoleFillet();
      assert((WORKBENCH_OPERATION_KINDS as readonly string[]).includes("rename-general-body"), "the operation is registered");
      const renamed = applyOp(project, { kind: "rename-general-body", bodyId: PLATE_BODY, name: "  Base plate  " });
      equal(bodyName(renamed, PLATE_BODY), "Base plate", "the name is trimmed and stored");
      equal(renamed.revision, project.revision + 1, "one operation, one revision (one Undo)");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(renamed)));
      assert(reloaded.ok, "the renamed project loads again");
      if (reloaded.ok) equal(bodyName(reloaded.value, PLATE_BODY), "Base plate", "and keeps the name");
      equal(designOf(renamed).features.find((feature) => feature.id === "feature:extrude-1")!.name, "Extrude 1", "the step keeps its own name");
    }
  },
  {
    name: "A body name must be non-blank and unique among bodies; a missing body is refused",
    run: () => {
      const base = plateHoleFillet();
      const project = { ...base, part: { ...base.part, generalBodies: [...(base.part.generalBodies ?? []), { ...tetra("general-body:two"), name: "Boss" }] } };
      refusedOp(project, { kind: "rename-general-body", bodyId: PLATE_BODY, name: "   " });
      const taken = refusedOp(project, { kind: "rename-general-body", bodyId: PLATE_BODY, name: "boss" });
      assert(taken.includes("Boss") && taken.includes("cannot share"), `a name another body has is refused and the other body is named: ${taken}`);
      refusedOp(project, { kind: "rename-general-body", bodyId: "general-body:ghost", name: "X" });
      equal(bodyName(applyOp(project, { kind: "rename-general-body", bodyId: PLATE_BODY, name: "Plate" }), PLATE_BODY), "Plate", "a free name works");
      equal(bodyName(applyOp(project, { kind: "rename-general-body", bodyId: PLATE_BODY, name: PLATE_BODY }), PLATE_BODY), PLATE_BODY, "keeping its own name is not a clash");
    }
  },
  {
    name: "A rebuild keeps the name the body has, and a renamed step does not rename the body (and the pieces of a cut follow the body's name)",
    run: () => {
      let project = plateHoleFillet();
      project = applyOp(project, { kind: "rename-general-body", bodyId: PLATE_BODY, name: "Plate" });
      project = applyOp(project, { kind: "rename-design-feature", featureId: "feature:extrude-1", name: "Base extrude" });
      equal(bodyName(project, PLATE_BODY), "Plate", "renaming the step leaves the body's name alone");
      const rebuilt: GeneralSolidBody = { ...tetra(PLATE_BODY), name: "Base extrude" };
      const piece: GeneralSolidBody = { ...tetra(splitPieceId(PLATE_BODY, 2)), name: splitPieceName("Base extrude", 2) };
      const regenerated = applyOp(project, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: rebuilt, pieces: [piece] }] });
      equal(bodyName(regenerated, PLATE_BODY), "Plate", "the rebuilt body keeps its name");
      equal(bodyName(regenerated, splitPieceId(PLATE_BODY, 2)), "Plate (piece 2)", "and the piece it was cut into is named after it");
      const again = applyOp(regenerated, { kind: "regenerate-design", results: [{ featureId: "feature:extrude-1", body: rebuilt, pieces: [piece] }] });
      equal(bodyName(again, PLATE_BODY), "Plate", "a second rebuild changes nothing");
    }
  },
  {
    name: "New bodies are numbered Body 1, Body 2 ... and never take a name that is in use",
    run: () => {
      equal(nextBodyName([]), "Body 1", "the first body");
      equal(nextBodyName(["Body 1", "Body 2"]), "Body 3", "the next number");
      equal(nextBodyName(["Plate", "Body 4"]), "Body 5", "after the highest number in use");
      equal(nextBodyName(["Plate", "Boss"]), "Body 3", "named bodies count, so the number does not repeat after a rename");
      equal(nextBodyName(["body 3", "Body 1", "Body 2"]), "Body 4", "case does not matter");
      equal(uniqueBodyName(["Plate"], "plate"), "plate (2)", "a taken name gets a suffix");
      equal(uniqueBodyName(["Plate"], "Boss"), "Boss", "a free name is kept");
    }
  },
  {
    name: "Rename Body is on a solid's right-click menu (F2) and is off for preview bodies, with a reason",
    run: () => {
      const solid = resolveWorkbenchContextCommands({ workspace: "part", selectionId: PLATE_BODY, selectionKind: "body", featureKind: "solid" });
      const rename = solid.find((entry) => entry.id === "selection.rename");
      assert(rename !== undefined && rename.enabled && rename.shortcut === "F2", "Rename Body is offered on a solid");
      const preview = resolveWorkbenchContextCommands({ workspace: "part", selectionId: "part-body:cyl", selectionKind: "body" });
      const off = preview.find((entry) => entry.id === "selection.rename");
      assert(off !== undefined && !off.enabled && (off.disabledReason ?? "").length > 0, "a preview body cannot be renamed here, and the menu says why");
    }
  },
];
