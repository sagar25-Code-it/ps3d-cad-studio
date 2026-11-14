import type { DesignHistory, DesignSketchFeature } from "../packages/workbench-core/src/index.js";
import { combineInitialChoice, explicitBody, matchingSketches, sketchByAnswer } from "../apps/studio-web/src/explicit-pick.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-02: commands never choose a body, tool or sketch the user did not pick. The selected thing wins, an only
 * candidate is unambiguous, and anything else is a refusal that names the choices, never a silent first-in-the-list.
 */

const sketchFeature = (id: string, name: string, suppressed = false): DesignSketchFeature =>
  ({ id, name, kind: "sketch", suppressed, sketch: { id: "sketch:primary-profile", name, plane: "datum:xy", gridMm: 5, snapToleranceMm: 0.75, entities: [], constraints: [] } }) as unknown as DesignSketchFeature;

const historyWith = (...features: DesignSketchFeature[]): DesignHistory => ({ features, rollbackIndex: features.length, editingSketchId: undefined }) as unknown as DesignHistory;

export const explicitPickTests: readonly TestCase[] = [
  {
    name: "explicitBody acts on the selected body, takes an only body as unambiguous, and with several and no selection refuses naming them",
    run: () => {
      const bodies = [{ id: "b1", name: "Plate" }, { id: "b2", name: "Boss" }];
      const selected = explicitBody(bodies, "b2", "Indent");
      assert(selected.ok && selected.value.id === "b2", "the selected body wins");
      const only = explicitBody([bodies[0]!], null, "Indent");
      assert(only.ok && only.value.id === "b1", "a single body cannot be ambiguous");
      const none = explicitBody([], null, "Indent");
      assert(!none.ok && /create a solid body first/.test(none.message), "no body: asks for one");
      const several = explicitBody(bodies, null, "Indent");
      assert(!several.ok && /select which solid/.test(several.message) && /Plate, Boss/.test(several.message), `several bodies, none selected: refused with the names: ${several.ok ? "" : several.message}`);
      const stale = explicitBody(bodies, "b9", "Indent");
      assert(!stale.ok, "a selection that no longer exists does not fall back to the first body");
    }
  },
  {
    name: "matchingSketches lists candidates newest first without suppressed ones, and sketchByAnswer resolves a typed name, an id, or Enter for the newest",
    run: () => {
      const a = sketchFeature("feature:s1", "Sketch 1");
      const b = sketchFeature("feature:s2", "Sketch 2");
      const off = sketchFeature("feature:s3", "Sketch 3", true);
      const history = historyWith(a, b, off);
      const found = matchingSketches(history, () => true);
      assert(found.length === 2 && found[0]!.id === "feature:s2" && found[1]!.id === "feature:s1", "newest first, suppressed left out");
      assert(sketchByAnswer(found, "")?.id === "feature:s2", "Enter keeps the newest");
      assert(sketchByAnswer(found, "Sketch 1")?.id === "feature:s1", "a typed name picks that sketch");
      assert(sketchByAnswer(found, "feature:s1")?.id === "feature:s1", "a typed id picks that sketch");
      assert(sketchByAnswer(found, "sketch 1")?.id === "feature:s1", "the name match ignores case");
      assert(sketchByAnswer(found, "nothing") === undefined, "an unknown name picks nothing, never the newest by accident");
      const filtered = matchingSketches(history, (sketch) => sketch.name === "Sketch 1");
      assert(filtered.length === 1 && filtered[0]!.id === "feature:s1", "the predicate narrows the candidates");
    }
  },
  {
    name: "The Combine dialog opens with the user's selected body as target and no tool chosen, so OK stays disabled until the tool is picked",
    run: () => {
      const bodies = [{ id: "b1" }, { id: "b2" }, { id: "b3" }];
      const fromSelection = combineInitialChoice(bodies, "b2");
      assert(fromSelection.targetId === "b2" && fromSelection.toolId === "", "the selected body is the target; the tool is empty");
      const noSelection = combineInitialChoice(bodies, undefined);
      assert(noSelection.targetId === "" && noSelection.toolId === "", "with nothing selected, neither row is pre-filled");
      const staleSelection = combineInitialChoice(bodies, "gone");
      assert(staleSelection.targetId === "" && staleSelection.toolId === "", "a stale selection does not fall back to the first body");
    }
  }
];
