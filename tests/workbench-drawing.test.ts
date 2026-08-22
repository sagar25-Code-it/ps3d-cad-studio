import { applyWorkbenchOperation, createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { createAutomaticDrawingPlan, createDrawingSvg } from "../packages/workbench-drawing/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const workbenchDrawingTests: readonly TestCase[] = [
  {
    name: "drawing generator emits a base-project-section chain with engineering sheet evidence",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing");
      const first = createDrawingSvg(project.part, project.drawing);
      const second = createDrawingSvg(project.part, project.drawing);
      equal(first.svg, second.svg, "same drawing intent should produce identical SVG");
      equal(first.widthMm, 420, "A3 landscape width should be explicit");
      equal(first.heightMm, 297, "A3 landscape height should be explicit");
      equal(first.viewCount, 5, "default layout should contain a base, two projections, a section, and an isometric reference");
      equal(first.dimensionCount, 6, "selective dimensions should cover overall size, thickness, bore, and basic position");
      equal(first.datumCount, 3, "the explicitly selected plate datum template should expose A, B, and C");
      equal(first.gdtFrameCount, 3, "the explicit template should contain position, flatness, and perpendicularity frames");
      assert(first.svg.includes('data-view-id="front" data-view-role="base"'), "front must be the parent base view");
      assert(first.svg.includes('data-view-id="top" data-view-role="projected"'), "top must be a projected child view");
      assert(first.svg.includes('data-parent-view="front"'), "projected and section views should retain their parent relationship");
      assert(first.svg.includes('data-view-id="section-a"'), "section A-A should be model-derived");
      assert(first.svg.includes("section-hatch"), "cut material should be hatched");
      assert(first.svg.includes("REVISION HISTORY"), "engineering sheet should include revision history");
      assert(first.svg.includes("NOT RELEASED"), "preview release status should be unambiguous");
      assert(first.svg.includes("UNLESS OTHERWISE SPECIFIED: LINEAR ±0.20 mm"), "general tolerance note should appear in the title block");
    }
  },
  {
    name: "first- and third-angle projection choices place aligned views on opposite sides",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing-projection");
      const third = createDrawingSvg(project.part, { ...project.drawing, projection: "third-angle" });
      const first = createDrawingSvg(project.part, { ...project.drawing, projection: "first-angle" });
      const thirdFront = viewCenter(third.svg, "front");
      const thirdTop = viewCenter(third.svg, "top");
      const thirdRight = viewCenter(third.svg, "right");
      const firstFront = viewCenter(first.svg, "front");
      const firstTop = viewCenter(first.svg, "top");
      const firstRight = viewCenter(first.svg, "right");
      near(thirdTop.x, thirdFront.x, 1e-9, "third-angle top should remain vertically aligned to the base");
      assert(thirdTop.y < thirdFront.y, "third-angle top should be above the base view");
      assert(thirdRight.x > thirdFront.x, "third-angle right view should be to the right of the base");
      near(firstTop.x, firstFront.x, 1e-9, "first-angle top should remain vertically aligned to the base");
      assert(firstTop.y > firstFront.y, "first-angle top should be below the base view");
      assert(firstRight.x < firstFront.x, "first-angle right-side view should be placed left of the base");
    }
  },
  {
    name: "edge display and full-section settings change only their intended drawing evidence",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing-visibility");
      const hiddenShown = createDrawingSvg(project.part, project.drawing);
      const hiddenRemoved = createDrawingSvg(project.part, { ...project.drawing, displayStyle: "visible-edges", showSectionView: false });
      assert(hiddenShown.svg.includes('class="hidden-edge"'), "visible-and-hidden style should show projected bore edges");
      assert(hiddenShown.svg.includes('class="cutting-plane"'), "enabled section should include its parent cutting plane");
      assert(!hiddenRemoved.svg.includes('class="hidden-edge"'), "visible-edge style should remove hidden edges");
      assert(!hiddenRemoved.svg.includes('data-view-id="section-a"'), "disabled section should remove the section view");
      assert(!hiddenRemoved.svg.includes('class="cutting-plane"'), "disabled section should remove the cutting plane");
    }
  },
  {
    name: "general tolerance is independent from explicitly authored GD&T values",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing-tolerance");
      const applied = applyWorkbenchOperation(project, {
        kind: "set-drawing-general-tolerance",
        operationId: "operation:test-drawing-general-tolerance",
        expectedRevision: 0,
        linearMm: 0.15,
        angularDeg: 0.75
      });
      assert(applied.ok, "bounded general tolerance should apply");
      const plan = createAutomaticDrawingPlan(applied.value.project.part, applied.value.project.drawing);
      near(plan.generalTolerance.linearMm, 0.15, 1e-12, "linear general tolerance should be retained exactly");
      near(plan.gdtFrames.find((frame) => frame.characteristic === "position")?.toleranceMm ?? 0, 0.2, 1e-12, "position tolerance must not be derived from the general tolerance");
      const explicit = applyWorkbenchOperation(project, {
        kind: "set-drawing-gdt-specification",
        operationId: "operation:test-explicit-gdt",
        expectedRevision: 0,
        positionMm: 0.12,
        flatnessMm: 0.04,
        perpendicularityMm: 0.06
      });
      assert(explicit.ok, "bounded explicit GD&T values should apply");
      const explicitPlan = createAutomaticDrawingPlan(explicit.value.project.part, explicit.value.project.drawing);
      near(explicitPlan.gdtFrames.find((frame) => frame.characteristic === "position")?.toleranceMm ?? 0, 0.12, 1e-12, "position should use the explicit drawing specification");
      near(explicitPlan.generalTolerance.linearMm, 0.2, 1e-12, "editing GD&T must not change the general tolerance");
    }
  },
  {
    name: "datum-free mode removes datum-referenced frames and basic location dimensions",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing-no-datums");
      const artifact = createDrawingSvg(project.part, { ...project.drawing, datumScheme: "none", showGdt: true });
      equal(artifact.datumCount, 0, "no datum scheme should emit no datum labels");
      equal(artifact.gdtFrameCount, 1, "datum-free GD&T should retain only the flatness form control");
      equal(artifact.dimensionCount, 4, "basic hole location dimensions should be absent without position control");
      assert(!artifact.svg.includes('data-tolerance-source="basic"'), "basic dimensions must not be invented without a position frame");
      assert(!artifact.svg.includes('data-gdt-id="gdt:position-centered-bore"'), "position frame must be absent without a datum reference frame");
    }
  },
  {
    name: "front-only view does not claim thickness or inaccessible datum evidence",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing-front-only");
      const artifact = createDrawingSvg(project.part, { ...project.drawing, viewPreset: "front-only", showSectionView: true });
      equal(artifact.viewCount, 1, "front-only preset should emit only the descriptive base view");
      equal(artifact.dimensionCount, 3, "front-only dimensions should remain limited to visible width, height, and bore");
      equal(artifact.datumCount, 0, "front-only sheet should not pretend the primary broad datum is identified edge-on");
      assert(!artifact.svg.includes('data-dimension-id="dimension:thickness"'), "thickness must not be dimensioned in a view where it is not visible");
    }
  },
  {
    name: "drawing notes and titles are XML escaped",
    run: () => {
      const project = createWorkbenchProject("project:test-drawing-escape");
      const artifact = createDrawingSvg(project.part, { ...project.drawing, title: "A&B <PLATE>", notes: "VERIFY </text><script>alert(1)</script>" });
      assert(artifact.svg.includes("A&amp;B &lt;PLATE&gt;"), "title should be escaped");
      assert(artifact.svg.includes("&lt;/text&gt;&lt;script&gt;"), "notes must not inject SVG elements");
      assert(!artifact.svg.includes("<script>"), "unsafe script markup must not appear");
    }
  }
];

function viewCenter(svg: string, viewId: string): { readonly x: number; readonly y: number } {
  const match = new RegExp(`data-view-id="${viewId}"[^>]*data-center-x="([^"]+)"[^>]*data-center-y="([^"]+)"`, "u").exec(svg);
  if (match === null) throw new Error(`Missing drawing view ${viewId}.`);
  return { x: Number(match[1]), y: Number(match[2]) };
}
