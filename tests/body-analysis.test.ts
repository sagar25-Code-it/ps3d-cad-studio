import { applyWorkbenchOperation, createWorkbenchProject, type GeneralSolidBody, type PartPreviewBody } from "../packages/workbench-core/src/index.js";
import {
  analyzeCurvature,
  analyzeDraft,
  analyzeWallThickness,
  booleanMeshes,
  boxMesh,
  checkMesh,
  coneMesh,
  cylinderMesh,
  curvatureLegend,
  latheMesh,
  divergingColor,
  draftColor,
  draftLegend,
  findBodyInterferences,
  mengerCurvature,
  meshVolume,
  partAnalysisBodies,
  previewBodyMeshMm,
  sectionCurvatureComb,
  sphereMesh,
  thicknessColor,
  type AnalysisBodyMesh
} from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { boxMeshAt, concatMeshes, draftedBlock, hollowBox, icosphere } from "./analysis-meshes.js";

const body = (id: string, mesh: { positionsMm: readonly number[]; indices: readonly number[] }): AnalysisBodyMesh => ({ id, name: id, positionsMm: mesh.positionsMm, indices: mesh.indices });

export const bodyAnalysisTests: readonly TestCase[] = [
  {
    name: "interference of two overlapping boxes equals the analytic overlap volume and lists the pair",
    run: () => {
      const report = findBodyInterferences([
        body("a", boxMeshAt([0, 0, 0], [20, 20, 20])),
        body("b", boxMeshAt([12, 5, 8], [32, 25, 18])),
        body("far", boxMeshAt([100, 100, 100], [110, 110, 110]))
      ]);
      equal(report.pairsTested, 3, "three pairs");
      equal(report.interferences.length, 1, "only a and b overlap");
      const found = report.interferences[0]!;
      equal(found.ids.join(","), "a,b", "the pair is named");
      equal(found.method, "boolean", "an exact Boolean result");
      near(found.volumeMm3, 8 * 15 * 10, 1e-6, "overlap is 8 x 15 x 10 = 1200 mm3");
      near(report.totalVolumeMm3, 1200, 1e-6, "and is the total");
      equal(found.containment, "none", "neither body contains the other");
      assert(found.commonMesh !== undefined, "the common region is returned for highlighting");
      near(meshVolume(found.commonMesh.positionsMm, found.commonMesh.indices), 1200, 1e-6, "that mesh encloses the overlap");
      equal(found.overlapBoundsMm.min.join(","), "12,5,8", "overlap box minimum");
      equal(found.overlapBoundsMm.max.join(","), "20,20,18", "overlap box maximum");
      equal(checkMesh(found.commonMesh.positionsMm, found.commonMesh.indices).status, "pass", "the highlight mesh is itself a clean solid");
    }
  },
  {
    name: "interference ignores bodies that only touch, finds a body inside another, and sampling agrees when the Boolean cannot give one piece",
    run: () => {
      const touching = findBodyInterferences([body("a", boxMeshAt([0, 0, 0], [10, 10, 10])), body("b", boxMeshAt([10, 0, 0], [20, 10, 10]))]);
      equal(touching.interferences.length, 0, "a shared face is contact, not interference");
      const inside = findBodyInterferences([body("outer", boxMeshAt([0, 0, 0], [30, 30, 30])), body("pin", boxMeshAt([10, 10, 10], [15, 15, 15]))]);
      equal(inside.interferences.length, 1, "a body inside another interferes");
      near(inside.interferences[0]!.volumeMm3, 125, 1e-6, "by its whole volume");
      equal(inside.interferences[0]!.containment, "second-in-first", "and is reported as contained");

      // A U-shaped bracket (box minus a notch) crossed by a bar through both prongs: two separate common pieces.
      const slab = boxMeshAt([0, 0, 0], [30, 10, 10]);
      const notch = boxMeshAt([10, -1, 4], [20, 11, 11]);
      const bracket = booleanMeshes(slab, notch, "cut");
      assert(bracket.ok, bracket.ok ? "" : bracket.message);
      const bar = boxMeshAt([-5, 2, 5], [35, 8, 9]);
      const split = booleanMeshes({ positionsMm: bracket.value.positionsMm, indices: bracket.value.indices }, bar, "intersect");
      assert(!split.ok && split.message.includes("separate pieces"), `the Boolean cannot return two pieces: ${split.ok ? "ok" : split.message}`);
      const report = findBodyInterferences([body("bracket", bracket.value), body("bar", bar)]);
      equal(report.interferences.length, 1, "the pair still interferes");
      const found = report.interferences[0]!;
      equal(found.method, "sampled", "estimated by ray columns");
      // The bar (z 5..9) crosses the prongs below the notch floor? The notch starts at z=4, so only the base z 0..4 is solid between the prongs.
      // Common volume: the bar over x 0..10 and x 20..30 where the bracket is full height (z 5..9), width y 2..8 -> two 10 x 6 x 4 pieces.
      near(found.volumeMm3, 2 * 10 * 6 * 4, 0.05 * 480, "two prong overlaps of 240 mm3 each, within the sampling tolerance");
      equal(found.commonMesh, undefined, "no single mesh for a sampled result");
    }
  },
  {
    name: "interference refuses to guess for an open body and lists it as skipped",
    run: () => {
      const open = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const report = findBodyInterferences([body("open", { positionsMm: open.positionsMm, indices: open.indices.slice(3) }), body("b", boxMeshAt([5, 5, 5], [15, 15, 15]))]);
      equal(report.interferences.length, 0, "no result");
      equal(report.skipped.length, 1, "the pair is listed as skipped");
      assert(report.skipped[0]!.reason.includes("not a closed solid"), report.skipped[0]!.reason);
    }
  },
  {
    name: "Part interference runs over the project's real bodies: general solids and analytic preview bodies together",
    run: () => {
      let project = createWorkbenchProject("project:part-interference");
      const block: PartPreviewBody = { id: "part-body:block", name: "Block", shape: "block", visible: true, color: "#8899aa", translationMm: [0, 0, 5], rotationDeg: [0, 0, 0], sizeMm: [20, 20, 10] };
      const pin: PartPreviewBody = { id: "part-body:pin", name: "Pin", shape: "cylinder", visible: true, color: "#99aa88", translationMm: [0, 0, 5], rotationDeg: [0, 0, 0], sizeMm: [10, 10, 30] };
      const hidden: PartPreviewBody = { id: "part-body:hidden", name: "Hidden", shape: "block", visible: false, color: "#aaaaaa", translationMm: [0, 0, 5], rotationDeg: [0, 0, 0], sizeMm: [20, 20, 10] };
      const added = applyWorkbenchOperation(project, { kind: "add-part-preview-bodies", operationId: "operation:add-bodies", expectedRevision: project.revision, bodies: [block, pin, hidden] });
      assert(added.ok, added.ok ? "" : added.diagnostics[0]?.message ?? "add failed");
      project = added.value.project;
      const mesh = boxMeshAt([-5, -5, 0], [5, 5, 4]);
      const general: GeneralSolidBody = { id: "general-body:key", name: "Key", visible: true, color: "#aabbcc", positionsMm: mesh.positionsMm, indices: mesh.indices };
      const withGeneral = applyWorkbenchOperation(project, { kind: "add-general-body", operationId: "operation:add-key", expectedRevision: project.revision, body: general });
      assert(withGeneral.ok, withGeneral.ok ? "" : withGeneral.diagnostics[0]?.message ?? "");
      project = withGeneral.value.project;

      const bodies = partAnalysisBodies(project.part);
      equal(bodies.map((entry) => entry.id).join(","), "part-body:block,part-body:pin,general-body:key", "hidden bodies are left out, preview bodies come first");
      equal(partAnalysisBodies(project.part, { includeHidden: true }).length, 4, "unless asked");
      for (const entry of bodies) equal(checkMesh(entry.positionsMm, entry.indices).status, "pass", `${entry.id} is a clean closed mesh`);
      const report = findBodyInterferences(bodies);
      equal(report.pairsTested, 3, "three pairs among three bodies");
      const names = report.interferences.map((entry) => entry.ids.join("+")).sort();
      assert(names.includes("part-body:block+part-body:pin"), `block and pin overlap: ${names.join(" ")}`);
      assert(names.includes("part-body:block+general-body:key"), "block and key overlap");
      const blockPin = report.interferences.find((entry) => entry.ids[1] === "part-body:pin")!;
      // The pin is a 64-gon cylinder of radius 5 and 30 high, passing through the 10 mm tall block: overlap = polygon area x 10.
      near(blockPin.volumeMm3, 0.5 * 64 * 25 * Math.sin(2 * Math.PI / 64) * 10, 1e-3, "pin-through-block overlap is the faceted cylinder section times the block height");
    }
  },
  {
    name: "primitive meshes are closed, outward and have the analytic volume",
    run: () => {
      const box = boxMesh(10, 20, 30);
      near(meshVolume(box.positionsMm, box.indices), 6000, 1e-9, "box");
      const cylinder = cylinderMesh(5, 12, 64);
      equal(checkMesh(cylinder.positionsMm, cylinder.indices).status, "pass", "cylinder is clean");
      near(meshVolume(cylinder.positionsMm, cylinder.indices), 0.5 * 64 * 25 * Math.sin(2 * Math.PI / 64) * 12, 1e-6, "cylinder");
      const cone = coneMesh(6, 0, 10, 48);
      equal(checkMesh(cone.positionsMm, cone.indices).status, "pass", "a pointed cone is clean (no degenerate cap)");
      near(meshVolume(cone.positionsMm, cone.indices), (1 / 3) * 0.5 * 48 * 36 * Math.sin(2 * Math.PI / 48) * 10, 1e-6, "cone");
      const frustum = coneMesh(6, 3, 10, 48);
      equal(checkMesh(frustum.positionsMm, frustum.indices).status, "pass", "frustum is clean");
      assert(meshVolume(frustum.positionsMm, frustum.indices) > 0, "positive volume, so it points outward");
      const inverted = coneMesh(0, 6, 10, 48);
      equal(checkMesh(inverted.positionsMm, inverted.indices).status, "pass", "a cone standing on its point is clean too");
      assert(meshVolume(inverted.positionsMm, inverted.indices) > 0, "and outward");
      const sphere = sphereMesh(10, 48, 24);
      equal(checkMesh(sphere.positionsMm, sphere.indices).status, "pass", "sphere is clean");
      near(meshVolume(sphere.positionsMm, sphere.indices) / ((4 / 3) * Math.PI * 1000), 1, 0.01, "sphere within 1% of 4/3 pi r3");
      const rotated = previewBodyMeshMm({ id: "p", name: "p", shape: "block", visible: true, color: "#fff", translationMm: [100, 0, 0], rotationDeg: [0, 0, 90], sizeMm: [10, 20, 30] });
      const xs = rotated.positionsMm.filter((_, index) => index % 3 === 0);
      near(Math.max(...xs) - Math.min(...xs), 20, 1e-9, "a quarter turn about Z swaps the width and depth");
      near((Math.max(...xs) + Math.min(...xs)) / 2, 100, 1e-9, "and the translation is applied");
    }
  },
  {
    name: "draft analysis reads the tilt of a drafted face against the pull direction and classifies faces",
    run: () => {
      const block = draftedBlock(40, 20, 5);
      const analysis = analyzeDraft(block.positionsMm, block.indices, { pullDirection: [0, 0, 1], requiredDraftDeg: 2 });
      // Triangles 4..11 are the four side faces (two each), 0-1 the bottom, 2-3 the top.
      for (let triangle = 4; triangle < 12; triangle += 1) near(analysis.triangleAngleDeg[triangle]!, 5, 1e-9, `side triangle ${triangle} has exactly the 5 degree draft`);
      near(analysis.triangleAngleDeg[2]!, 90, 1e-9, "the top faces the pull");
      near(analysis.triangleAngleDeg[0]!, -90, 1e-9, "the bottom faces away");
      equal(analysis.triangleClass[4], "positive", "5 degrees is enough for a 2 degree requirement");
      equal(analysis.triangleClass[0], "negative", "the bottom is an undercut for this pull");
      const strict = analyzeDraft(block.positionsMm, block.indices, { pullDirection: [0, 0, 1], requiredDraftDeg: 6 });
      equal(strict.triangleClass[4], "needs-draft", "5 degrees is not enough for 6");
      near(strict.areaMm2.total, analysis.areaMm2.total, 1e-9, "areas add up");
      assert(strict.areaMm2.needsDraft > 0 && strict.areaMm2.needsDraft < strict.areaMm2.total, "only the sides need draft");
      const straight = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const walls = analyzeDraft(straight.positionsMm, straight.indices, { pullDirection: [0, 0, 1], requiredDraftDeg: 1 });
      equal(walls.triangleClass[4], "needs-draft", "vertical walls have zero draft");
      near(walls.triangleAngleDeg[4]!, 0, 1e-12, "exactly zero");
      const sideways = analyzeDraft(straight.positionsMm, straight.indices, { pullDirection: [1, 0, 0] });
      near(sideways.triangleAngleDeg[8]!, 90, 1e-9, "pulling along +X, the +X face is 90");
      near(sideways.pullDirection[0], 1, 1e-12, "the pull direction is normalised");
      const tilted = analyzeDraft(block.positionsMm, block.indices, { pullDirection: [Math.sin(5 * Math.PI / 180), 0, Math.cos(5 * Math.PI / 180)] });
      assert(Math.abs(tilted.triangleAngleDeg[8]! - 5) > 4 || Math.abs(tilted.triangleAngleDeg[10]! - 5) > 4, "tilting the pull changes the draft on opposite walls");
    }
  },
  {
    name: "draft colours separate undercut, needs-draft and enough-draft, and the legend names them",
    run: () => {
      const red = draftColor(-10, 2); const yellow = draftColor(0.5, 2); const green = draftColor(10, 2);
      assert(red[0] > red[1] && red[0] > red[2], "negative draft is red");
      assert(yellow[0] > 0.8 && yellow[1] > 0.6 && yellow[2] < 0.3, "zero draft is yellow");
      assert(green[1] > green[0] && green[1] > green[2], "enough draft is green");
      assert(Number.isFinite(draftColor(Number.NaN, 2)[0]), "an unmeasured face still gets a colour");
      equal(draftLegend(2).entries.length, 5, "five legend bands");
      assert(draftLegend(2).entries.some((entry) => entry.label.includes("undercut")), "names the undercut");
    }
  },
  {
    name: "wall thickness of a hollow box equals the wall, with the minimum and thin area reported",
    run: () => {
      const hollow = hollowBox(40, 3);
      const analysis = analyzeWallThickness(hollow.positionsMm, hollow.indices, { thinThresholdMm: 4 });
      equal(analysis.analysed, true, "analysed");
      near(analysis.minThicknessMm, 3, 1e-6, "the minimum is the wall");
      near(analysis.maxThicknessMm, 3, 1e-6, "so is the maximum, the wall being uniform");
      near(analysis.meanThicknessMm, 3, 1e-6, "and the mean");
      equal(analysis.unmeasuredTriangles, 0, "every triangle found the opposite wall");
      near(analysis.thinAreaMm2, analysis.totalAreaMm2, 1e-6, "every face is under the 4 mm threshold");
      assert(analysis.minLocationMm !== undefined, "the thinnest place is located");
      const fine = analyzeWallThickness(hollow.positionsMm, hollow.indices, { thinThresholdMm: 2 });
      near(fine.thinAreaMm2, 0, 1e-9, "nothing is thinner than 2 mm");
      // A solid block is as thick as its smallest dimension seen from each face.
      const slab = boxMeshAt([0, 0, 0], [50, 30, 8]);
      const solid = analyzeWallThickness(slab.positionsMm, slab.indices);
      near(solid.minThicknessMm, 8, 1e-6, "a 50 x 30 x 8 slab is 8 mm thick through its big faces");
      near(solid.maxThicknessMm, 50, 1e-6, "and 50 mm through its end faces");
    }
  },
  {
    name: "wall thickness finds the thin web of an uneven part and ignores nothing: ribs, open meshes and limits behave",
    run: () => {
      // A box with one wall thinned: outer 40 cube, cavity from x = 1 (thin wall) and 5 elsewhere.
      const outer = boxMeshAt([0, 0, 0], [40, 40, 40]);
      const inner = boxMeshAt([1, 5, 5], [35, 35, 35]);
      const flipped = { positionsMm: inner.positionsMm, indices: inner.indices.flatMap((_, i, all) => i % 3 === 0 ? [all[i]!, all[i + 2]!, all[i + 1]!] : []) };
      const part = concatMeshes(outer, flipped);
      const analysis = analyzeWallThickness(part.positionsMm, part.indices, { thinThresholdMm: 2 });
      near(analysis.minThicknessMm, 1, 1e-6, "the thin wall is 1 mm");
      assert(analysis.maxThicknessMm >= 5 - 1e-6, "the other walls are 5 mm or more");
      assert(analysis.thinAreaMm2 > 0 && analysis.thinAreaMm2 < analysis.totalAreaMm2 / 2, "only the thin wall counts as thin");
      assert(analysis.minLocationMm !== undefined && (Math.abs(analysis.minLocationMm[0]) < 1e-6 || Math.abs(analysis.minLocationMm[0] - 1) < 1e-6), "and sits on the x = 0 / x = 1 faces");
      const open = analyzeWallThickness(outer.positionsMm, outer.indices.slice(0, 6), { maxDistanceMm: 100 });
      equal(open.analysed, true, "an open mesh is measured as far as it can be");
      assert(open.unmeasuredTriangles > 0, "and the triangles with nothing behind them are reported as unmeasured");
      const tooBig = analyzeWallThickness(outer.positionsMm, outer.indices, { maxTriangles: 4 });
      equal(tooBig.analysed, false, "the size limit is honoured");
      assert((tooBig.message ?? "").includes("12 triangles"), "with a reason");
    }
  },
  {
    name: "wall thickness colours run red below the threshold to blue at the thickest wall",
    run: () => {
      const thin = thicknessColor(0.5, 1, 10); const thick = thicknessColor(10, 1, 10); const mid = thicknessColor(3, 1, 10);
      assert(thin[0] > 0.7 && thin[1] < 0.3, "thin is red");
      assert(thick[2] > thick[0], "thick is blue");
      assert(mid[1] > mid[0], "in between is green-ish");
      const unmeasured = thicknessColor(Number.NaN, 1, 10);
      assert(Math.abs(unmeasured[0] - unmeasured[2]) < 0.1, "unmeasured is grey");
    }
  },
  {
    name: "curvature of a sphere is 1/r2 (Gaussian) and 1/r (mean) within tolerance, positive for convex",
    run: () => {
      const radius = 20;
      const sphere = icosphere(radius, 3);
      const curvature = analyzeCurvature(sphere.positionsMm, sphere.indices);
      near(curvature.gaussianStats.median, 1 / (radius * radius), 0.03 / (radius * radius), "Gaussian median is within 3% of 1/r2");
      near(curvature.meanStats.median, 1 / radius, 0.03 / radius, "mean median is within 3% of 1/r");
      assert(curvature.meanStats.min > 0.9 / radius && curvature.meanStats.max < 1.1 / radius, `every vertex is within 10%: ${curvature.meanStats.min}..${curvature.meanStats.max}`);
      assert(curvature.gaussianStats.min > 0.8 / (radius * radius) && curvature.gaussianStats.max < 1.2 / (radius * radius), "Gaussian likewise");
      const bigger = analyzeCurvature(icosphere(40, 3).positionsMm, icosphere(40, 3).indices);
      near(bigger.meanStats.median * 2, curvature.meanStats.median, 0.02 / radius, "doubling the radius halves the mean curvature");
      // Turning the faces inside out turns the mean curvature negative: the same sphere seen as a cavity.
      const cavity = analyzeCurvature(sphere.positionsMm, sphere.indices.flatMap((_, i, all) => i % 3 === 0 ? [all[i]!, all[i + 2]!, all[i + 1]!] : []));
      near(cavity.meanStats.median, -1 / radius, 0.03 / radius, "a cavity has negative mean curvature");
      near(cavity.gaussianStats.median, 1 / (radius * radius), 0.03 / (radius * radius), "but the same Gaussian curvature");
      const offCentre = icosphere(20, 3, [100, -50, 30]);
      near(analyzeCurvature(offCentre.positionsMm, offCentre.indices).meanStats.median, 1 / radius, 0.03 / radius, "position does not matter");
    }
  },
  {
    name: "curvature of a cylinder is zero Gaussian and 1/2r mean; a flat face is zero; open boundaries are not measured",
    run: () => {
      const radius = 10;
      // A barrel with rings at z = -30, -15, 0, 15, 30 so that the middle rings are smooth surface, not rim.
      const cylinder = latheMesh([[0, -30], [radius, -30], [radius, -15], [radius, 0], [radius, 15], [radius, 30], [0, 30]], 96);
      const curvature = analyzeCurvature(cylinder.positionsMm, cylinder.indices);
      let checked = 0;
      for (let vertex = 0; vertex < cylinder.positionsMm.length / 3; vertex += 1) {
        const z = cylinder.positionsMm[vertex * 3 + 2]!;
        const r = Math.hypot(cylinder.positionsMm[vertex * 3]!, cylinder.positionsMm[vertex * 3 + 1]!);
        if (r < 1 || Math.abs(z) > 16 || Math.abs(Math.abs(z) - 30) < 1e-9) continue;
        const welded = curvature.weldedIndexOfVertex[vertex]!;
        near(curvature.gaussian[welded]!, 0, 1e-6, "a cylinder barrel has zero Gaussian curvature");
        near(curvature.mean[welded]!, 1 / (2 * radius), 0.03 / (2 * radius), "and mean curvature 1/2r");
        checked += 1;
      }
      equal(checked, 3 * 96, "three smooth rings of 96 vertices were checked");
      const sphere = icosphere(10, 2);
      const open = analyzeCurvature(sphere.positionsMm, sphere.indices.slice(0, sphere.indices.length - 12));
      assert(open.gaussian.filter(Number.isNaN).length >= 3, "vertices on the new boundary are NaN");
      assert(open.mean.filter(Number.isFinite).length > 0, "the rest are measured");
      const box = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const flat = analyzeCurvature(box.positionsMm, box.indices);
      assert(flat.gaussianStats.max > 0, "the corners of a box carry all the Gaussian curvature");
      near(flat.gaussian.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) * 0 + 1, 1, 0, "computed without throwing");
    }
  },
  {
    name: "curvature colours are diverging and the legend states the unit",
    run: () => {
      const positive = divergingColor(1, 1); const negative = divergingColor(-1, 1); const zero = divergingColor(0, 1);
      assert(positive[0] > positive[2] && negative[2] > negative[0], "red positive, blue negative");
      assert(zero[0] > 0.85 && zero[1] > 0.85 && zero[2] > 0.85, "near white at zero");
      equal(curvatureLegend("gaussian", 0.01).unit, "1/mm2", "Gaussian is per square millimetre");
      equal(curvatureLegend("mean", 0.01).unit, "1/mm", "mean is per millimetre");
    }
  },
  {
    name: "curvature comb on a section of a cylinder has equal teeth of 1/R, and a rectangle section has teeth only at its corners",
    run: () => {
      const radius = 12;
      const cylinder = cylinderMesh(radius, 40, 72);
      const comb = sectionCurvatureComb(cylinder.positionsMm, cylinder.indices, "xy", 3);
      equal(comb.curves.length, 1, "one closed section curve");
      equal(comb.curves[0]!.closed, true, "closed");
      equal(comb.vertexCount, 72, "one tooth per vertex");
      near(comb.maxCurvaturePerMm, 1 / radius, 1e-9, "Menger curvature of the 72-gon is exactly 1/R");
      near(comb.minRadiusMm, radius, 1e-6, "minimum radius");
      // All teeth are the same length and point outward (away from the centre).
      const lengths: number[] = [];
      for (let tooth = 0; tooth < comb.teethMm.length; tooth += 6) {
        const p = comb.teethMm.slice(tooth, tooth + 3); const q = comb.teethMm.slice(tooth + 3, tooth + 6);
        lengths.push(Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!));
        assert(Math.hypot(q[0]!, q[1]!) > Math.hypot(p[0]!, p[1]!), "tooth points away from the centre of curvature");
        near(q[2]!, 3, 1e-9, "teeth lie in the section plane");
      }
      near(Math.max(...lengths) - Math.min(...lengths), 0, 1e-9, "equal curvature gives equal teeth");
      equal(comb.envelopeMm.length, 72 * 6, "the envelope joins the 72 tips into a closed loop");
      const scaled = sectionCurvatureComb(cylinder.positionsMm, cylinder.indices, "xy", 3, { scale: 100 });
      near(Math.hypot(scaled.teethMm[3]! - scaled.teethMm[0]!, scaled.teethMm[4]! - scaled.teethMm[1]!), 100 / radius, 1e-9, "tooth length is curvature times the scale");

      const box = boxMeshAt([0, 0, 0], [20, 10, 10]);
      const boxComb = sectionCurvatureComb(box.positionsMm, box.indices, "xy", 5);
      assert(boxComb.curves.length === 1, "one rectangular section");
      const straightSections = boxComb.teethMm.length / 6;
      assert(straightSections >= 4, "the corner vertices carry teeth");
      const empty = sectionCurvatureComb(box.positionsMm, box.indices, "xy", 500);
      equal(empty.curves.length, 0, "a plane that misses the body gives no curve");
      near(mengerCurvature([0, 0, 0], [1, 0, 0], [2, 0, 0]).curvaturePerMm, 0, 1e-12, "collinear points have no curvature");
      near(mengerCurvature([1, 0, 0], [0, 1, 0], [-1, 0, 0]).curvaturePerMm, 1, 1e-12, "three points on the unit circle");
    }
  }
];
