import { createWorkbenchProject, type SketchEntity, type WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { chainSelectionFor } from "../packages/workbench-sketch/src/chain-select.js";
import { circ, line } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Double-click on a curve selects the connected chain; Shift adds it to the selection. */

function sketchWith(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...createWorkbenchProject("project:chain").sketch, entities, constraints: [] };
}

const arc = (id: string, start: [number, number], mid: [number, number], end: [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "arc", start, mid, end, construction: false });

export const sketchChainSelectTests: readonly TestCase[] = [
  {
    name: "Double-click chain: every curve joined end to end with the clicked one is selected, and nothing that only lies near it",
    run: () => {
      const sketch = sketchWith([
        line("a", [0, 0], [40, 0]), line("b", [40, 0], [40, 20]), arc("c", [40, 20], [30, 30], [20, 20]), line("d", [20, 20], [0, 0]),
        line("far", [100, 0], [120, 0]), circ("hole", 20, 8, 3)
      ]);
      const chain = chainSelectionFor(sketch, "entity:b", [], false);
      assert(chain !== undefined, "a curve gives a chain");
      equal([...chain.ids].sort().join(), "entity:a,entity:b,entity:c,entity:d", "the closed outline of four curves");
      assert(/chain of 4 connected curves/u.test(chain.message), `the count is reported: ${chain.message}`);
      const alone = chainSelectionFor(sketch, "entity:far", ["entity:a"], false);
      assert(alone !== undefined && alone.ids.join() === "entity:far" && /only it is selected/u.test(alone.message), "a curve that meets nothing is selected alone, replacing the selection");
      const circle = chainSelectionFor(sketch, "entity:hole", [], false);
      assert(circle !== undefined && circle.ids.join() === "entity:hole", "a circle is a chain of one");
      equal(chainSelectionFor(sketch, "entity:gone", [], false), undefined, "a curve that is not there gives nothing");
    }
  },
  {
    name: "Double-click chain: Shift adds the chain to what is selected; construction curves chain among themselves; hidden curves are skipped",
    run: () => {
      const sketch = sketchWith([
        line("a", [0, 0], [40, 0]), line("b", [40, 0], [40, 20]),
        line("c1", [0, 0], [0, 30], true), line("c2", [0, 30], [25, 30], true),
        line("far", [100, 0], [120, 0]),
        { ...line("hidden", [40, 20], [60, 20]), visible: false }
      ]);
      const added = chainSelectionFor(sketch, "entity:a", ["entity:far"], true);
      assert(added !== undefined, "chain");
      equal(added.ids.join(), "entity:far,entity:a,entity:b", "what was selected stays, the chain is added after it");
      equal(added.chainIds.join(), "entity:a,entity:b", "the chain itself is the two profile lines: the construction line at the shared corner and the hidden line are not in it");
      assert(/3 selected in all/u.test(added.message), `the total is reported: ${added.message}`);
      const construction = chainSelectionFor(sketch, "entity:c2", [], false);
      assert(construction !== undefined && construction.ids.join() === "entity:c1,entity:c2", "a construction curve selects the construction chain only");
      equal(chainSelectionFor(sketch, "entity:hidden", [], false), undefined, "a hidden curve cannot be double-clicked");
      const branched = sketchWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 0]), line("c", [10, 0], [10, 10])]);
      const fork = chainSelectionFor(branched, "entity:a", [], false);
      assert(fork !== undefined && fork.ids.length === 3 && /branches/u.test(fork.message), `a branch is disclosed: ${fork?.message}`);
    }
  },
];
