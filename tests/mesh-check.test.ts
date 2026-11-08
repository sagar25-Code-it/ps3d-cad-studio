import { createGeneralSolidBody } from "../apps/studio-web/src/general-modeling.js";
import { applyWorkbenchOperation, createWorkbenchProject, type GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { booleanMeshes, checkMesh, meshFillet } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { boxMeshAt, concatMeshes, flipWinding, icosphere, unweldedBox } from "./analysis-meshes.js";

export const meshCheckTests: readonly TestCase[] = [
  {
    name: "geometry checker passes a clean box and a clean sphere with the right topology numbers",
    run: () => {
      const box = boxMeshAt([0, 0, 0], [10, 20, 30]);
      const report = checkMesh(box.positionsMm, box.indices);
      equal(report.status, "pass", "a clean box passes");
      equal(report.issues.length, 0, "and has no issues");
      equal(report.closed, true, "closed");
      equal(report.manifold, true, "manifold");
      equal(report.components, 1, "one shell");
      equal(report.eulerCharacteristic, 2, "a box is a sphere topologically: V - E + F = 2");
      equal(report.edgeCount, 18, "12 box edges plus 6 face diagonals");
      near(report.volumeMm3, 6000, 1e-9, "volume");
      equal(report.selfIntersectionChecked, true, "the self-intersection test ran");
      const sphere = icosphere(20, 2);
      const sphereReport = checkMesh(sphere.positionsMm, sphere.indices);
      equal(sphereReport.status, "pass", "a subdivided icosahedron passes");
      equal(sphereReport.eulerCharacteristic, 2, "genus 0");
      assert(sphereReport.volumeMm3 > 0 && sphereReport.volumeMm3 < (4 / 3) * Math.PI * 8000, "volume is below the true sphere");
    }
  },
  {
    name: "geometry checker finds the open edges of a box with a missing triangle and highlights them",
    run: () => {
      const box = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const indices = box.indices.slice(0, 3 * 3).concat(box.indices.slice(4 * 3));
      const report = checkMesh(box.positionsMm, indices);
      equal(report.status, "fail", "an open mesh fails");
      equal(report.closed, false, "not closed");
      equal(report.counts.openEdges, 3, "removing one triangle opens exactly its three edges");
      equal(report.highlight.openEdgeSegmentsMm.length, 3 * 6, "three highlight segments of six numbers");
      assert(report.issues.some((issue) => issue.kind === "open-edges" && issue.severity === "error"), "reported as an error");
      // Every highlighted segment lies on the removed triangle's corners.
      const corners = new Set<string>();
      for (const vertex of [box.indices[9]!, box.indices[10]!, box.indices[11]!]) corners.add(`${box.positionsMm[vertex * 3]},${box.positionsMm[vertex * 3 + 1]},${box.positionsMm[vertex * 3 + 2]}`);
      for (let segment = 0; segment < 3; segment += 1) {
        const a = report.highlight.openEdgeSegmentsMm.slice(segment * 6, segment * 6 + 3).join(",");
        const b = report.highlight.openEdgeSegmentsMm.slice(segment * 6 + 3, segment * 6 + 6).join(",");
        assert(corners.has(a) && corners.has(b), `segment ${segment} joins corners of the missing triangle`);
      }
    }
  },
  {
    name: "geometry checker reports non-manifold edges, flipped faces and an inverted solid",
    run: () => {
      const box = boxMeshAt([0, 0, 0], [10, 10, 10]);
      // A fin: a third triangle hung on the edge between vertices 0 and 2 (the bottom diagonal).
      const extraPositions = [...box.positionsMm, 5, 5, -10];
      const finned = checkMesh(extraPositions, [...box.indices, 0, 2, 8]);
      equal(finned.counts.nonManifoldEdges, 1, "the diagonal now has three triangles");
      equal(finned.manifold, false, "not manifold");
      equal(finned.highlight.nonManifoldSegmentsMm.length, 6, "and highlighted");

      const flipOne = [...box.indices];
      flipOne.splice(0, 3, box.indices[0]!, box.indices[2]!, box.indices[1]!);
      const flipped = checkMesh(box.positionsMm, flipOne);
      equal(flipped.counts.inconsistentWindingEdges, 3, "one reversed triangle disagrees with its three neighbours");
      assert(flipped.issues.some((issue) => issue.kind === "inconsistent-winding"), "reported");

      const inside = flipWinding(box);
      const inverted = checkMesh(inside.positionsMm, inside.indices);
      equal(inverted.status, "fail", "an inside-out box fails");
      assert(inverted.issues.some((issue) => issue.kind === "inverted-solid"), "as an inverted solid");
      near(inverted.volumeMm3, -1000, 1e-9, "with negative volume");
      equal(inverted.counts.openEdges, 0, "and no open edges");
    }
  },
  {
    name: "geometry checker treats duplicate seam vertices as a note and degenerate triangles as a warning",
    run: () => {
      const seamed = unweldedBox([0, 0, 0], [10, 10, 10]);
      const report = checkMesh(seamed.positionsMm, seamed.indices);
      equal(report.vertexCount, 24, "four vertices per face");
      equal(report.counts.duplicateVertices, 16, "24 vertices are 8 places");
      equal(report.closed, true, "welding closes the seams");
      equal(report.status, "pass", "a note, not a failure");
      assert(report.issues.some((issue) => issue.kind === "duplicate-vertices" && issue.severity === "info"), "listed as information");

      const box = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const sliver = checkMesh([...box.positionsMm, 3, 3, 10], [...box.indices, 4, 4, 8, 4, 5, 5]);
      equal(sliver.counts.degenerateTriangles, 2, "repeated corners are degenerate");
      equal(sliver.status, "warning", "a warning");
      equal(sliver.highlight.degenerateTriangles.join(","), "12,13", "the degenerate triangles are named");
      equal(sliver.counts.unreferencedVertices, 0, "the extra vertex is used, if only by a degenerate triangle");
    }
  },
  {
    name: "geometry checker finds surfaces that cross each other and passes bodies that merely sit apart",
    run: () => {
      const a = boxMeshAt([0, 0, 0], [10, 10, 10]);
      // Offsets are chosen so that no piercing point falls exactly on a face diagonal, which the strict interior test cannot see.
      const crossing = concatMeshes(a, boxMeshAt([4, 3, 6], [14, 13, 16]));
      const bad = checkMesh(crossing.positionsMm, crossing.indices);
      equal(bad.status, "fail", "two overlapping shells in one mesh fail");
      assert(bad.counts.selfIntersectingPairs > 0, "triangle pairs cross");
      assert(bad.highlight.selfIntersectingTriangles.length > 0, "and are highlighted");
      assert(bad.issues.some((issue) => issue.kind === "self-intersection"), "reported");
      const apart = concatMeshes(a, boxMeshAt([20, 0, 0], [30, 10, 10]));
      const good = checkMesh(apart.positionsMm, apart.indices);
      equal(good.counts.selfIntersectingPairs, 0, "separate shells do not intersect");
      equal(good.components, 2, "two shells");
      equal(good.status, "pass", "still a clean mesh");
      const skipped = checkMesh(crossing.positionsMm, crossing.indices, { maxSelfIntersectionTriangles: 5 });
      equal(skipped.selfIntersectionChecked, false, "the test can be limited");
      equal(skipped.counts.selfIntersectingPairs, 0, "and then reports nothing about it");
    }
  },
  {
    name: "geometry checker rejects non-finite input and indices that name missing vertices without throwing",
    run: () => {
      const box = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const broken = checkMesh([...box.positionsMm.slice(0, 5), Number.NaN, ...box.positionsMm.slice(6)], [...box.indices, 0, 1, 99]);
      equal(broken.status, "fail", "fails");
      equal(broken.counts.nonFiniteVertices, 1, "one NaN coordinate");
      assert(broken.counts.invalidIndexTriangles >= 1, "triangles using it or a missing vertex are invalid");
      equal(checkMesh([], []).status, "fail", "an empty mesh fails");
    }
  },
  {
    name: "geometry checker passes the real bodies the modeler builds (kernel extrude, Boolean, fillet) and flags a corrupted copy",
    run: async () => {
      const base = createWorkbenchProject("project:check-real");
      const profileA = detectSketchProfiles({ ...base.sketch, entities: [{ id: "entity:r", kind: "rectangle", center: [15, 10], widthMm: 30, heightMm: 20, rotationDeg: 0, construction: false }] as never, constraints: [] })[0]!;
      const made = await createGeneralSolidBody({ profile: profileA, plane: "xy", operation: "extrude", valueMm: 12, bodyId: "general-body:a", name: "Block", color: "#8899aa" });
      assert(made.ok, made.ok ? "" : made.message);
      const clean = checkMesh(made.body.positionsMm, made.body.indices);
      equal(clean.status, "pass", `a kernel extrude is clean: ${clean.issues.map((issue) => issue.message).join(" | ")}`);
      near(clean.volumeMm3, 30 * 20 * 12, 1e-6, "volume of the block");

      const filleted = meshFillet({ positionsMm: made.body.positionsMm, indices: made.body.indices }, { sizeMm: 2 });
      assert(filleted.ok, filleted.ok ? "" : filleted.message);
      const rounded = checkMesh(filleted.positionsMm, filleted.indices);
      equal(rounded.counts.openEdges + rounded.counts.nonManifoldEdges + rounded.counts.inconsistentWindingEdges, 0, "the filleted body is a closed manifold");

      const tool = boxMeshAt([5, 5, 4], [15, 15, 20]);
      const cut = booleanMeshes({ positionsMm: made.body.positionsMm, indices: made.body.indices }, tool, "cut");
      assert(cut.ok, cut.ok ? "" : cut.message);
      const pocketed = checkMesh(cut.value.positionsMm, cut.value.indices);
      equal(pocketed.counts.openEdges, 0, "a Boolean result has no open edges");
      equal(pocketed.counts.selfIntersectingPairs, 0, "and does not cross itself");

      // Corrupt a copy: drop the last 5 triangles of the Boolean result.
      const damaged = checkMesh(cut.value.positionsMm, cut.value.indices.slice(0, cut.value.indices.length - 15));
      equal(damaged.status, "fail", "the damaged copy fails");
      assert(damaged.counts.openEdges > 0, "with open edges");
    }
  },
  {
    name: "design health report lists geometry-check findings and Part interference for the project's solid bodies",
    run: () => {
      const base = createWorkbenchProject("project:health-geometry");
      const bad = boxMeshAt([0, 0, 0], [10, 10, 10]);
      const openBody: GeneralSolidBody = { id: "general-body:open", name: "Open", visible: true, color: "#aaaaaa", positionsMm: bad.positionsMm, indices: bad.indices.slice(3) };
      const goodMesh = boxMeshAt([0, 0, 0], [20, 20, 20]);
      const goodBody: GeneralSolidBody = { id: "general-body:good", name: "Good", visible: true, color: "#bbbbbb", positionsMm: goodMesh.positionsMm, indices: goodMesh.indices };
      const second = boxMeshAt([10, 10, 10], [30, 30, 30]);
      const overlapBody: GeneralSolidBody = { id: "general-body:overlap", name: "Overlap", visible: true, color: "#cccccc", positionsMm: second.positionsMm, indices: second.indices };
      let project = base;
      for (const body of [openBody, goodBody, overlapBody]) {
        const applied = applyWorkbenchOperation(project, { kind: "add-general-body", operationId: `operation:add-geometry-${body.name.toLowerCase()}`, expectedRevision: project.revision, body });
        assert(applied.ok, applied.ok ? "" : `adding ${body.name}: ${applied.diagnostics[0]?.message ?? ""}`);
        project = applied.value.project;
      }
      const report = buildDesignHealthReport(project);
      const check = report.findings.find((finding) => finding.id === "health:part-geometry-check");
      assert(check !== undefined && check.severity === "error", "the open body is an error finding");
      assert(check.relatedIds.includes("general-body:open") && !check.relatedIds.includes("general-body:good"), "it names only the broken body");
      const interference = report.findings.find((finding) => finding.id === "health:part-interference");
      assert(interference !== undefined && interference.severity === "warning", "overlapping solids are a warning");
      assert(interference.evidence.includes("1000"), `the evidence carries the 10 x 10 x 10 mm overlap: ${interference.evidence}`);
      assert(interference.relatedIds.includes("general-body:good") && interference.relatedIds.includes("general-body:overlap"), "and names the pair");
      const clean = buildDesignHealthReport(createWorkbenchProject("project:health-geometry-clean"));
      assert(!clean.findings.some((finding) => finding.id === "health:part-geometry-check" || finding.id === "health:part-interference"), "a project with no solids has neither finding");
    }
  }
];
