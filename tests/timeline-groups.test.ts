import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineBar } from "../apps/studio-web/src/ui/TimelineBar.js";
import { groupBaseName, groupIsOpen, timelineGroups } from "../apps/studio-web/src/ui/timeline-groups.js";
import { designOf, type DesignHistory, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { plateHoleFillet, stepOf } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-19: the copies one pattern made are folded into one timeline item that opens to its steps. */

const copy = (groupId: string, index: number, of: number, name = "Rectangular pattern"): DesignSolidFeature => stepOf(`feature:${groupId}-${index}`, `${name} (${index} of ${of})`, "pattern", {
  bodyId: `general-body:${groupId}-${index}`, operation: "new-body",
  pattern: { type: "rectangular", result: "new-bodies", groupId: `pattern:${groupId}`, sourceBodyId: "general-body:plate", copyIndex: index, countA: of, spacingAMm: 20, directionA: [1, 0, 0], countB: 1, spacingBMm: 0, directionB: [0, 1, 0], sizing: "spacing" }
});

/** s1, extrude, cut, join, then three copies of one pattern and two of another, then a plain join. */
function withPatterns(): WorkbenchProject {
  const project = plateHoleFillet();
  const history = designOf(project);
  const features = [...history.features, copy("a", 1, 3), copy("a", 2, 3), copy("a", 3, 3), copy("b", 1, 2, "Circular pattern"), copy("b", 2, 2, "Circular pattern"), stepOf("feature:join-2", "Join 2", "extrude", { operation: "join" })];
  return { ...project, design: { ...history, features, rollbackIndex: features.length } };
}

const noop = (): void => undefined;
const bar = (history: DesignHistory, selectedFeatureId: string | null = null): string => renderToStaticMarkup(createElement(TimelineBar, { history, selectedFeatureId, busy: false, onSelect: noop, onEdit: noop, onRollback: noop, onSuppress: noop, onDelete: noop, onRename: noop, onMove: noop }));
const chipIds = (html: string): readonly string[] => [...html.matchAll(/data-chip-id="([^"]+)"/gu)].map((match) => match[1]!);

export const timelineGroupTests: readonly TestCase[] = [
  {
    name: "Neighbouring copies of one pattern command are one group, two commands are two groups, a lone pattern step is none",
    run: () => {
      const history = designOf(withPatterns());
      const groups = timelineGroups(history);
      equal(groups.map((group) => group.label).join(" | "), "Rectangular pattern ×3 | Circular pattern ×2", "two groups, named without the copy numbers");
      equal(groups[0]!.ids.join(","), "feature:a-1,feature:a-2,feature:a-3", "in timeline order");
      equal(`${groups[0]!.firstIndex}-${groups[0]!.lastIndex}`, "4-6", "with their places");
      equal(timelineGroups(designOf(plateHoleFillet())).length, 0, "a timeline with no pattern has no group");
      const single = { ...history, features: history.features.filter((feature) => feature.id !== "feature:a-2" && feature.id !== "feature:a-3") };
      assert(!timelineGroups(single).some((group) => group.ids.includes("feature:a-1")), "one copy alone is not a group");
      equal(groupBaseName("Rectangular pattern (12 of 40)"), "Rectangular pattern", "the copy number is taken off the name");
      equal(groupBaseName("Join 1"), "Join 1", "another name is left alone");
    }
  },
  {
    name: "A group opens when the person opened it, when the marker is inside it, or when one of its steps is in use",
    run: () => {
      const history = designOf(withPatterns());
      const group = timelineGroups(history)[0]!;
      assert(!groupIsOpen(history, group, new Set(), []), "folded by default");
      assert(groupIsOpen(history, group, new Set([group.groupId]), []), "open when the person opened it");
      assert(groupIsOpen({ ...history, rollbackIndex: 5 }, group, new Set(), []), "open when the marker sits between its steps");
      assert(!groupIsOpen({ ...history, rollbackIndex: 4 }, group, new Set(), []) && !groupIsOpen({ ...history, rollbackIndex: 7 }, group, new Set(), []), "a marker just before or after the group does not open it");
      assert(groupIsOpen(history, group, new Set(), [undefined, "feature:a-2"]), "open while one of its steps is being renamed, dragged or has its menu open");
    }
  },
  {
    name: "The strip shows a folded group as one chip that stands for all its steps, and the steps again once the marker is inside it",
    run: () => {
      const history = designOf(withPatterns());
      const folded = bar(history);
      equal(chipIds(folded).join(","), "feature:s1,feature:extrude-1,feature:cut-1,feature:join-1,feature:a-1,feature:b-1,feature:join-2", "one chip per group, first step's id, 7 chips for 11 steps");
      assert(folded.includes('data-group-id="pattern:a"') && folded.includes('data-chip-count="3"') && folded.includes('aria-expanded="false"'), "the folded chip is marked as a group of 3");
      assert(folded.includes("Rectangular pattern ×3") && folded.includes("Circular pattern ×2"), "and named for the pattern");
      assert(!folded.includes("Rectangular pattern (2 of 3)"), "its other steps are not drawn");
      equal([...folded.matchAll(/class="timeline-marker/gu)].length, 8, "a marker slot before every item and one at the end (the steps inside a folded group have none)");
      const inside = bar({ ...history, rollbackIndex: 5 });
      assert(inside.includes("Rectangular pattern (2 of 3)") && inside.includes("Fold Rectangular pattern ×3") && inside.includes('aria-expanded="true"'), "with the marker inside the group its steps show, with a button to fold it");
      equal(chipIds(inside).filter((id) => id.startsWith("feature:a-")).length, 3, "all three copies are chips again");
      assert(bar(history, "feature:a-2").includes("timeline-chip group selected"), "a folded group is marked selected when one of its steps is");
    }
  },
];
