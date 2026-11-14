import { createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, type WorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { applyOp, PLATE_BODY, plateHoleFillet, refusedOp, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-04: a hole, fillet, chamfer or shell cannot be swapped into the mesh of a body the timeline builds: it would vanish at the next rebuild. */

const MODIFIERS = ["hole", "shell", "chamfer", "fillet", "counterbore", "countersink", "tapped-hole"] as const;

export const oneShotGuardTests: readonly TestCase[] = [
  {
    name: "modify-general-body refuses a hole, fillet, chamfer or shell on a body the timeline builds, naming the body and the step, and saying to use the step command",
    run: () => {
      const project = plateHoleFillet();
      const owner = designOf(project).features.find((feature) => feature.kind !== "sketch" && feature.bodyId === PLATE_BODY)!;
      for (const modifier of MODIFIERS) {
        const message = refusedOp(project, { kind: "modify-general-body", targetBodyId: PLATE_BODY, modifier, label: `${modifier} test`, body: tetra(PLATE_BODY) });
        assert(message.includes(PLATE_BODY) && message.includes(owner.name), `${modifier}: names the body and its step: ${message}`);
        assert(message.includes("lost at the next rebuild"), `${modifier}: says why: ${message}`);
      }
      const result = applyWorkbenchOperation(project, { kind: "modify-general-body", targetBodyId: PLATE_BODY, modifier: "fillet", label: "x", body: tetra(PLATE_BODY), operationId: "operation:test-guard", expectedRevision: project.revision } as WorkbenchOperation);
      assert(!result.ok && result.diagnostics[0]!.recovery.includes("timeline step"), "the recovery tells the person which command records it as a step");
    }
  },
  {
    name: "A body with no timeline step of its own still takes the in-place modifiers, and surface and form edits are not affected",
    run: () => {
      let project = createWorkbenchProject("project:test-one-shot-guard");
      project = applyOp(project, { kind: "add-general-body", body: tetra("general-body:loose") });
      equal(designOf(project).features.length, 0, "the body has no step");
      for (const modifier of MODIFIERS) {
        const after = applyOp(project, { kind: "modify-general-body", targetBodyId: "general-body:loose", modifier, label: `${modifier} ok`, body: tetra("general-body:loose") });
        assert((after.part.generalBodies ?? []).some((body) => body.id === "general-body:loose"), `${modifier} applies in place to a body with no steps`);
      }
      const timeline = plateHoleFillet();
      const surface = applyOp(timeline, { kind: "modify-general-body", targetBodyId: PLATE_BODY, modifier: "surface-edit", label: "Trim", body: tetra(PLATE_BODY) });
      assert((surface.part.generalBodies ?? []).length === 1, "the surface family keeps its own flow (those bodies never have timeline steps)");
    }
  },
];
