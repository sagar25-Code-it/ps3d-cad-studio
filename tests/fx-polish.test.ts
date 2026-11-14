import { applyIntent } from "../apps/studio-web/src/sketch-session.js";
import { chooseBodyFor } from "../apps/studio-web/src/body-choice.js";
import { blendLimitMm, blendSizeProblem, resizeBlendNext, trimKeptProblem } from "../apps/studio-web/src/part-limits.js";
import { designOf, validateWorkbenchProject, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { PLATE_BODY, plateHoleFillet, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Cosmetic-review polish round (fx-polish): Combine as one project, refusals that name limits and candidates, rename and group menus, layout. */

function stepless(): WorkbenchProject {
  const plate = plateHoleFillet();
  const history = designOf(plate);
  const sketches = history.features.filter((feature) => feature.kind === "sketch");
  return { ...plate, part: { ...plate.part, generalBodies: [tetra("general-body:a"), tetra("general-body:b")] }, design: { ...history, features: sketches, rollbackIndex: sketches.length } };
}

export const fxPolishTests: readonly TestCase[] = [
  {
    name: "Combine on bodies without timeline steps is one operation: target and tool become one body in one project",
    run: () => {
      const before = stepless();
      const result = tetra("general-body:result");
      const done = applyIntent(before, { kind: "boolean-general-bodies", targetBodyId: "general-body:a", toolBodyId: "general-body:b", mode: "join", keepTool: false, body: result });
      assert(done.ok, `the Boolean is accepted as one operation: ${done.ok ? "" : done.message}`);
      if (!done.ok) return;
      const ids = done.value.project.part.generalBodies!.map((body) => body.id);
      equal(ids.join(","), "general-body:result", "both inputs are replaced by the result in the same project, so one Undo restores both");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(done.value.project))).ok, "the result saves and reloads");
      equal(before.part.generalBodies!.length, 2, "the project before the command is untouched");
    }
  },
  {
    name: "Edge Blend / Chamfer size over the limit is refused with the limit named, never clamped",
    run: () => {
      const size: [number, number, number] = [40, 20, 10];
      equal(blendLimitMm(size), 9.5, "limit is half the narrower side less 0.5 mm");
      const refused = blendSizeProblem("Block 1", "Blend radius", 12, size);
      assert(refused !== undefined && refused.includes("9.5 mm") && refused.includes("12 mm") && refused.includes("Block 1"), `names the typed value and the limit: ${refused}`);
      assert(refused.includes("Nothing was applied"), "says nothing was applied");
      equal(blendSizeProblem("Block 1", "Blend radius", 9.5, size), undefined, "exactly the limit is accepted as typed");
      equal(blendSizeProblem("Block 1", "Chamfer distance", 0.3, size), undefined, "a small value is applied as typed (no 0.25 mm floor clamp)");
      assert(blendSizeProblem("Block 1", "Blend radius", 0, size) !== undefined, "zero is refused");
      assert(blendSizeProblem("Thin", "Blend radius", 0.2, [1, 1, 5])?.includes("too narrow") === true, "a body too narrow for any blend says so");
    }
  },
  {
    name: "Resize Blend at the limit refuses instead of repeating the clamped value",
    run: () => {
      const size: [number, number, number] = [40, 20, 10];
      const grown = resizeBlendNext("Block 1", 3, size);
      assert(grown.ok && grown.sizeMm === 3.5, "grows by half a millimetre inside the limit");
      const stuck = resizeBlendNext("Block 1", 9.2, size);
      assert(!stuck.ok && stuck.message.includes("9.5 mm") && stuck.message.includes("Nothing was changed"), "past the limit it names the limit");
    }
  },
  {
    name: "Trim Body keeps exactly the typed length or refuses naming the height",
    run: () => {
      equal(trimKeptProblem("Block 1", 0.25, 10), undefined, "0.25 mm is applied as typed (no 0.5 mm floor clamp)");
      const tooLong = trimKeptProblem("Block 1", 14, 10);
      assert(tooLong !== undefined && tooLong.includes("10 mm") && tooLong.includes("14 mm"), `names both numbers: ${tooLong}`);
      assert(trimKeptProblem("Block 1", 10, 10) !== undefined, "keeping the whole height removes nothing and is refused");
      assert(trimKeptProblem("Block 1", -1, 10) !== undefined, "a negative length is refused");
    }
  },
  {
    name: "Hole / Fillet All / Chamfer All name the candidate bodies and never pick among several",
    run: () => {
      const solids = [{ id: "a", name: "Body 1" }, { id: "b", name: "Body 2" }, { id: "c", name: "Body 3" }];
      const several = chooseBodyFor("Hole", solids, null, "a solid made with Extrude or Revolve");
      assert(!several.ok && several.message.includes("Body 1, Body 2, Body 3") && several.message.includes("run Hole again"), "several and none selected: names them all");
      const chosen = chooseBodyFor("Hole", solids, "b", "a solid");
      assert(chosen.ok && chosen.body.id === "b", "the selected body is used");
      const only = chooseBodyFor("Fillet All", [solids[0]!], null, "a solid");
      assert(only.ok && only.body.id === "a", "the only candidate is used");
      const wrong = chooseBodyFor("Chamfer All", solids, "x", "a solid made with Extrude or Revolve", "Block 7");
      assert(!wrong.ok && wrong.message.includes("Block 7 is not a solid made with Extrude or Revolve") && wrong.message.includes("Body 2"), "a selection of the wrong kind is explained and the candidates named");
      const wrongOne = chooseBodyFor("Chamfer All", [solids[0]!], "x", "a solid", "Block 7");
      assert(!wrongOne.ok, "one candidate but a different body selected: not picked silently");
      const none = chooseBodyFor("Hole", [], null, "a solid");
      assert(!none.ok && none.message.includes("none yet"), "no candidates: says to create one");
      const many = chooseBodyFor("Hole", Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `Body ${index + 1}` })), null, "a solid");
      assert(!many.ok && many.message.includes("and 3 more"), "a long list is shortened");
    }
  },
];

void PLATE_BODY;
