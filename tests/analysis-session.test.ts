import { DEFAULT_ANALYSIS_SETTINGS, runAnalysis, pullDirectionOf, type AnalysisSettings } from "../apps/studio-web/src/analysis/analysis-session.js";
import type { AnalysisBodyMesh } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { boxMeshAt, draftedBlock, hollowBox, icosphere } from "./analysis-meshes.js";

const body = (id: string, mesh: { positionsMm: readonly number[]; indices: readonly number[] }): AnalysisBodyMesh => ({ id, name: id.toUpperCase(), positionsMm: mesh.positionsMm, indices: mesh.indices });
const settings = (patch: Partial<AnalysisSettings>): AnalysisSettings => ({ ...DEFAULT_ANALYSIS_SETTINGS, ...patch });

export const analysisSessionTests: readonly TestCase[] = [
  {
    name: "analysis session: geometry check draws the open edges of a broken body and passes a clean one",
    run: () => {
      const clean = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const broken = boxMeshAt([20, 0, 0], [30, 10, 10]);
      const bodies = [body("clean", clean), body("broken", { positionsMm: broken.positionsMm, indices: broken.indices.slice(3) })];
      const outcome = runAnalysis(bodies, settings({ mode: "geometry-check" }));
      equal(outcome.tone, "bad", "one failing body makes the headline bad");
      assert(outcome.headline.includes("1 body failed"), outcome.headline);
      equal(outcome.rows.find((row) => row.id === "clean")?.tone, "ok", "the clean body is ok");
      equal(outcome.rows.find((row) => row.id === "broken")?.tone, "bad", "the broken body is bad");
      const open = outcome.overlay.lines.find((line) => line.id === "broken:open");
      assert(open !== undefined && open.segmentsMm.length === 3 * 6, "three open edges are drawn on the broken body");
      assert(!outcome.overlay.lines.some((line) => line.id.startsWith("clean")), "nothing is drawn on the clean body");
      const only = runAnalysis(bodies, settings({ mode: "geometry-check", bodyId: "clean" }));
      equal(only.tone, "ok", "restricting to the clean body passes");
      equal(only.overlay.lines.length, 0, "with nothing to draw");
      equal(runAnalysis([], settings({ mode: "geometry-check" })).empty, true, "no bodies is an empty result, not a pass");
    }
  },
  {
    name: "analysis session: interference outlines the overlap, restricts to a chosen body and reports clear results",
    run: () => {
      const bodies = [body("a", boxMeshAt([0, 0, 0], [20, 20, 20])), body("b", boxMeshAt([10, 10, 10], [30, 30, 30])), body("c", boxMeshAt([100, 0, 0], [110, 10, 10]))];
      const all = runAnalysis(bodies, settings({ mode: "interference" }));
      equal(all.tone, "bad", "an overlap is bad");
      equal(all.rows.length, 1, "one pair");
      assert(all.rows[0]!.detail.startsWith("1000.00 mm"), all.rows[0]!.detail);
      equal(all.overlay.meshes.length, 1, "the common solid is drawn");
      assert(all.overlay.meshes[0]!.positionsMm.length > 0, "with geometry");
      const forC = runAnalysis(bodies, settings({ mode: "interference", bodyId: "c" }));
      equal(forC.tone, "ok", "c touches nothing");
      assert(forC.headline.startsWith("No interference"), forC.headline);
      const forA = runAnalysis(bodies, settings({ mode: "interference", bodyId: "a" }));
      equal(forA.rows.length, 1, "a is in one overlapping pair");
    }
  },
  {
    name: "analysis session: draft colours the faces and its headline matches the geometry",
    run: () => {
      const block = draftedBlock(40, 20, 5);
      const ok = runAnalysis([body("mould", block)], settings({ mode: "draft", requiredDraftDeg: 2 }));
      assert(ok.legend !== null && ok.legend.title === "Draft angle", "has the draft legend");
      equal(ok.overlay.meshes[0]!.triangleColors!.length, 12, "one colour per triangle");
      assert(ok.headline.includes("undercut"), ok.headline);
      equal(ok.tone, "bad", "the flat bottom is an undercut for a +Z pull");
      const flipped = runAnalysis([body("mould", block)], settings({ mode: "draft", pullAxis: "-z" }));
      assert(flipped.rows[0]!.detail.includes("-90"), "the pull direction flips the angles: " + flipped.rows[0]!.detail);
      const straight = runAnalysis([body("box", boxMeshAt([0, 0, 0], [10, 10, 10]))], settings({ mode: "draft", requiredDraftDeg: 1 }));
      assert(straight.rows[0]!.tone === "bad", "a straight box has undercut faces on the bottom");
      assert(straight.rows[0]!.detail.includes("needs draft"), "and walls that need draft");
      equal(pullDirectionOf("-y").join(","), "0,-1,0", "axis names map to unit vectors");
    }
  },
  {
    name: "analysis session: wall thickness reports the wall and marks a thin spot",
    run: () => {
      const outcome = runAnalysis([body("cup", hollowBox(40, 3))], settings({ mode: "wall-thickness", thinThresholdMm: 4 }));
      assert(outcome.headline.includes("3.000 mm") && outcome.headline.includes("below"), outcome.headline);
      equal(outcome.tone, "bad", "3 mm is under the 4 mm limit");
      assert(outcome.overlay.lines.some((line) => line.id === "cup:min"), "the thinnest place is marked with a cross");
      assert(outcome.legend !== null && outcome.legend.title === "Wall thickness", "legend");
      const fine = runAnalysis([body("cup", hollowBox(40, 3))], settings({ mode: "wall-thickness", thinThresholdMm: 2 }));
      equal(fine.tone, "ok", "3 mm passes a 2 mm limit");
      equal(fine.overlay.lines.length, 0, "and nothing is marked");
    }
  },
  {
    name: "analysis session: curvature maps share one scale across bodies, and the section comb draws teeth",
    run: () => {
      const small = icosphere(10, 2); const large = icosphere(40, 2, [100, 0, 0]);
      const gaussian = runAnalysis([body("small", small), body("large", large)], settings({ mode: "gaussian-curvature" }));
      equal(gaussian.overlay.meshes.length, 2, "both bodies are mapped");
      const smallColour = gaussian.overlay.meshes[0]!.vertexColors![0]!; const largeColour = gaussian.overlay.meshes[1]!.vertexColors![0]!;
      // The tighter sphere is a stronger red: less green and blue than the large sphere, which sits near white on the same scale.
      assert(smallColour[1] < largeColour[1], "the tighter sphere is a stronger red than the large one on the same scale");
      assert(gaussian.legend !== null && gaussian.legend.unit === "1/mm2", "Gaussian legend");
      const mean = runAnalysis([body("small", small)], settings({ mode: "mean-curvature" }));
      assert(mean.legend !== null && mean.legend.unit === "1/mm", "mean legend");
      const comb = runAnalysis([body("ball", icosphere(15, 3))], settings({ mode: "section-comb", sectionPlane: "xy", sectionOffsetMm: 2 }));
      assert(comb.overlay.lines.some((line) => line.id === "ball:teeth" && line.segmentsMm.length > 0), "teeth are drawn on the section of a sphere");
      const miss = runAnalysis([body("ball", icosphere(15, 3))], settings({ mode: "section-comb", sectionOffsetMm: 500 }));
      equal(miss.empty, true, "a plane that misses the body says so");
    }
  }
];
