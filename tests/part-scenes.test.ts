import { readFileSync } from "node:fs";
import { partScenes } from "../apps/studio-web/src/part-scenes.js";
import { buildPartPreview } from "../packages/workbench-geometry/src/index.js";
import { designOf, type DesignFeature, type SketchEntity, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyOp, PLATE_BODY, plateHoleFillet } from "./history-kit.js";
import { assert, type TestCase } from "./test-kit.js";

/** Review: sketch guides and the out-of-date look are editing aids of the Part view; Render Studio draws the model without them. */

const circle: SketchEntity = { id: "entity:spare", kind: "circle", center: [0, 0], radiusMm: 5, construction: false };

/** The plate with a spare finished sketch (nothing is built on it, so it is shown by default) and its Cut 1 failing to rebuild. */
function projectWithAids(): WorkbenchProject {
  let project = plateHoleFillet();
  project = applyOp(project, { kind: "new-design-sketch", plane: "datum:xy" });
  project = applyOp(project, { kind: "add-sketch-entity", entity: circle });
  project = applyOp(project, { kind: "commit-design-sketch", featureId: "feature:spare", name: "Spare sketch" });
  const history = designOf(project);
  return { ...project, design: { ...history, features: history.features.map((feature): DesignFeature => feature.id === "feature:cut-1" ? { ...feature, health: { message: "The hole is wider than the plate." } } : feature) } };
}

export const partSceneTests: readonly TestCase[] = [
  {
    name: "The Part view carries the shown sketches' guide lines and the out-of-date look; the model scene Render Studio draws carries neither",
    run: () => {
      const project = projectWithAids();
      const base = buildPartPreview(project.part);
      const { model, view } = partScenes(base, project);
      assert(model === base, "the model scene is the part itself");
      const guides = (scene: typeof model): number => scene.primitives.filter((primitive) => primitive.kind === "line" && primitive.id.includes(":curve:")).length;
      assert(guides(view) > 0, "the Part view draws the spare sketch's curve");
      assert(guides(model) === 0, "the model has no sketch lines");
      const body = (scene: typeof model) => scene.primitives.find((primitive) => primitive.id === PLATE_BODY)!;
      assert(body(view).opacity < 1 && body(view).name.includes("out of date"), "the Part view shows the failed solid out of date");
      assert(body(model).opacity === base.primitives.find((primitive) => primitive.id === PLATE_BODY)!.opacity && !body(model).name.includes("out of date"), "the rendered model draws it as the last good shape, unmarked");
    }
  },
  {
    name: "Render Studio and its fit use the model scene, and only the Part workspace uses the view scene",
    run: () => {
      const source = readFileSync("apps/studio-web/src/App.tsx", "utf8");
      assert(/const partSceneSet = useMemo\(\(\) => partScenes\(/u.test(source), "App builds both scenes from one place");
      const renderLines = source.split("\n").filter((line) => /renderSettings\.source === "part"/u.test(line) && /part(?:Model)?Scene/u.test(line));
      assert(renderLines.length >= 4, `the render paths were found: ${renderLines.length}`);
      for (const line of renderLines) assert(!/\bpartScene\b/u.test(line) && /partModelScene/u.test(line), `a Render Studio path uses the model scene: ${line.trim().slice(0, 90)}`);
    }
  },
];
