import type { SketchEntity, Vec2, WorkbenchOperation, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  DEFAULT_CAMERA,
  MAX_VIEW_WIDTH_MM,
  MIN_VIEW_WIDTH_MM,
  cameraViewBox,
  fitCamera,
  fitCameraToViewport,
  gridSteps,
  mmPerPixel,
  panCamera,
  screenToSketch,
  sketchToScreen,
  zoomCamera,
  type ScreenRect,
  type SketchCamera
} from "../packages/workbench-sketch/src/camera.js";
import { detectSketchProfiles, entityExtents, sketchBounds } from "../packages/workbench-sketch/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const rect: ScreenRect = { left: 120, top: 80, width: 800, height: 500 };
const camera: SketchCamera = { centerMm: [10, 5], widthMm: 100 };

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-camera").sketch, entities, constraints: [] };
}

export const sketchCameraTests: readonly TestCase[] = [
  {
    name: "screen and sketch coordinates convert back and forth without drift and keep y pointing up",
    run: () => {
      for (const point of [[0, 0], [37.5, -12.25], [-48, 31]] as const) {
        const screen = sketchToScreen(point, rect, camera);
        const back = screenToSketch(screen[0], screen[1], rect, camera);
        near(back[0], point[0], 1e-9, "x round-trips");
        near(back[1], point[1], 1e-9, "y round-trips");
      }
      const centre = screenToSketch(rect.left + rect.width / 2, rect.top + rect.height / 2, rect, camera);
      near(centre[0], 10, 1e-9, "the canvas centre is the camera centre (x)");
      near(centre[1], 5, 1e-9, "the canvas centre is the camera centre (y)");
      const upper = screenToSketch(rect.left + rect.width / 2, rect.top + 10, rect, camera);
      assert(upper[1] > centre[1], "moving up the screen increases sketch y");
    }
  },
  {
    name: "zooming about the cursor keeps the point under the cursor fixed, including at the zoom limits",
    run: () => {
      const anchor = screenToSketch(rect.left + 610, rect.top + 140, rect, camera);
      const before = sketchToScreen(anchor, rect, camera);
      for (const factor of [0.5, 0.8, 1.25, 4, 1e-9, 1e9]) {
        const zoomed = zoomCamera(camera, anchor, factor);
        const after = sketchToScreen(anchor, rect, zoomed);
        near(after[0], before[0], 1e-6, `anchor x stays put for factor ${factor}`);
        near(after[1], before[1], 1e-6, `anchor y stays put for factor ${factor}`);
      }
      equal(zoomCamera(camera, anchor, 1e-9).widthMm, MIN_VIEW_WIDTH_MM, "zooming in stops at the minimum width");
      equal(zoomCamera(camera, anchor, 1e9).widthMm, MAX_VIEW_WIDTH_MM, "zooming out stops at the maximum width");
      near(zoomCamera(camera, anchor, 0.5).widthMm, 50, 1e-9, "a factor below one zooms in");
    }
  },
  {
    name: "panning moves the scene with the pointer: the point grabbed stays under the pointer",
    run: () => {
      const grabbed = screenToSketch(rect.left + 300, rect.top + 200, rect, camera);
      const panned = panCamera(camera, 75, -40, rect.width);
      const moved = sketchToScreen(grabbed, rect, panned);
      near(moved[0], rect.left + 300 + 75, 1e-9, "dragging right moves the scene right");
      near(moved[1], rect.top + 200 - 40, 1e-9, "dragging up moves the scene up");
      equal(panned.widthMm, camera.widthMm, "panning never changes the zoom");
    }
  },
  {
    name: "fit shows the whole drawing with a margin, never tighter than 10 mm, and falls back to a default",
    run: () => {
      const extents = { min: [-50, -20] as const, max: [150, 60] as const };
      for (const aspect of [1.6, 0.6, 3]) {
        const fitted = fitCamera(extents, aspect);
        const box = cameraViewBox(fitted, aspect);
        assert(box.x <= -50 && box.x + box.width >= 150, `all of the width is visible at aspect ${aspect}`);
        assert(-(box.y + box.height) <= -20 && -box.y >= 60, `all of the height is visible at aspect ${aspect}`);
      }
      const point = fitCamera({ min: [5, 5], max: [5, 5] }, 1.6);
      assert(point.widthMm >= 10, "a single point does not zoom in to nothing");
      near(point.centerMm[0], 5, 1e-9, "a single point is centred");
      equal(fitCamera(undefined, 1.6), DEFAULT_CAMERA, "an empty sketch uses the default camera");
      near(mmPerPixel({ centerMm: [0, 0], widthMm: 200 }, 1000), 0.2, 1e-12, "millimetres per pixel follows the visible width");
    }
  },
  {
    name: "viewport-aware fit keeps the drawing inside the area that floating panels leave free and centres it there",
    run: () => {
      const size = { width: 900, height: 620 };
      const insets = { left: 0, top: 54, right: 190, bottom: 120 };
      const screen = { left: 0, top: 0, width: size.width, height: size.height };
      const freeCentre: Vec2 = [insets.left + (size.width - insets.left - insets.right) / 2, insets.top + (size.height - insets.top - insets.bottom) / 2];
      const fitted = fitCameraToViewport({ min: [-30, -20], max: [30, 20] }, size, insets, 36);
      for (const corner of [[-30, -20], [30, -20], [30, 20], [-30, 20]] as const) {
        const point = sketchToScreen(corner, screen, fitted);
        assert(point[0] >= insets.left + 35 && point[0] <= size.width - insets.right - 35, `corner x ${point[0]} stays inside the free area`);
        assert(point[1] >= insets.top + 35 && point[1] <= size.height - insets.bottom - 35, `corner y ${point[1]} stays inside the free area`);
      }
      const centre = sketchToScreen([0, 0], screen, fitted);
      near(centre[0], freeCentre[0], 1e-6, "the drawing is centred horizontally in the free area");
      near(centre[1], freeCentre[1], 1e-6, "the drawing is centred vertically in the free area");
      const empty = sketchToScreen([0, 0], screen, fitCameraToViewport(undefined, size, insets));
      near(empty[0], freeCentre[0], 1e-6, "an empty sketch puts the origin at the centre of the free area (x)");
      near(empty[1], freeCentre[1], 1e-6, "an empty sketch puts the origin at the centre of the free area (y)");
      const bare = fitCameraToViewport({ min: [-30, -20], max: [30, 20] }, size, { left: 0, top: 0, right: 0, bottom: 0 }, 36);
      near(bare.centerMm[0], 0, 1e-9, "with nothing covering the canvas the drawing is simply centred");
      const speck = fitCameraToViewport({ min: [5, 5], max: [5, 5] }, size, insets);
      assert(speck.widthMm >= 10, "a single point never zooms in to nothing");
    }
  },
  {
    name: "the adaptive grid keeps lines at least 14 px apart and steps in decimal 1-2-5 style with a major line at each power of ten",
    run: () => {
      for (const mmPerPx of [0.001, 0.02, 0.1, 0.37, 1, 4.2, 50, 900]) {
        const { minorMm, majorMm } = gridSteps(5, mmPerPx);
        assert(minorMm / mmPerPx >= 14 - 1e-9, `minor spacing is readable at ${mmPerPx} mm/px`);
        assert(minorMm / mmPerPx < 14 * 2.5 + 1e-9, `minor spacing is not wastefully coarse at ${mmPerPx} mm/px`);
        const mantissa = minorMm / 10 ** Math.floor(Math.log10(minorMm) + 1e-12);
        assert([1, 2, 5].some((allowed) => Math.abs(mantissa - allowed) < 1e-9), `the minor step ${minorMm} is a 1, 2 or 5 multiple of a power of ten`);
        const ratio = majorMm / minorMm;
        assert([2, 5, 10].some((allowed) => Math.abs(ratio - allowed) < 1e-9), `the major step ${majorMm} is a whole multiple of the minor step`);
      }
      // A base that is not a 1-2-5 number keeps its own proportions and puts a major line every fifth minor line.
      const odd = gridSteps(4, 0.25);
      near(odd.majorMm, odd.minorMm * 5, 1e-9, "a non-decimal base nests five minors per major");
      assert(odd.minorMm / 0.25 >= 14 - 1e-9, "a non-decimal base still keeps lines readable");
      equal(gridSteps(0, 0.1).minorMm > 0, true, "a zero base falls back to a positive step");
    }
  },
  {
    name: "true extents: a circle reaches centre plus or minus its radius, an arc follows its curve, a rotated rectangle its corners",
    run: () => {
      const circle = entityExtents({ id: "e:c", kind: "circle", center: [10, 5], radiusMm: 20, construction: false });
      near(circle.min[0], -10, 1e-9, "circle min x");
      near(circle.max[1], 25, 1e-9, "circle max y");
      // Arc from -60 deg through 30 deg to 120 deg on radius 10: it passes angles 0 and 90, which are not defining points.
      const r = 10;
      const at = (deg: number): readonly [number, number] => [r * Math.cos(deg * Math.PI / 180), r * Math.sin(deg * Math.PI / 180)];
      const arc = entityExtents({ id: "e:a", kind: "arc", start: at(-60), mid: at(30), end: at(120), construction: false });
      near(arc.max[0], 10, 0.05, "the arc bulges out to its rightmost point");
      near(arc.max[1], 10, 0.05, "the arc bulges up to its topmost point");
      const turned = entityExtents({ id: "e:r", kind: "rectangle", center: [0, 0], widthMm: 40, heightMm: 20, rotationDeg: 90, construction: false });
      near(turned.max[0], 10, 1e-9, "a 90 degree rectangle is 20 wide");
      near(turned.max[1], 20, 1e-9, "a 90 degree rectangle is 40 tall");
      const spline = entityExtents({ id: "e:s", kind: "spline", fitPoints: [[0, 0], [10, 10], [20, 0]], construction: false });
      near(spline.min[0], 0, 1e-9, "spline starts at its first fit point");
      near(spline.max[0], 20, 1e-9, "spline ends at its last fit point");
      assert(spline.max[1] >= 9.99, "spline reaches its apex fit point");
    }
  },
  {
    name: "sketch bounds grow to contain circles, so a lone circle is framed instead of collapsing to its centre",
    run: () => {
      const bounds = sketchBounds([{ id: "e:c", kind: "circle", center: [0, 0], radiusMm: 30, construction: false }]);
      assert(bounds !== undefined, "a circle has bounds");
      near(bounds.min[0], -30, 1e-9, "bounds min x");
      near(bounds.max[0], 30, 1e-9, "bounds max x");
      near(bounds.min[1], -30, 1e-9, "bounds min y");
      near(bounds.max[1], 30, 1e-9, "bounds max y");
    }
  },
  {
    name: "hidden sketch entities never become solid profiles",
    run: () => {
      const visibleCircle: SketchEntity = { id: "e:vis", kind: "circle", center: [0, 0], radiusMm: 10, construction: false };
      const hiddenCircle: SketchEntity = { id: "e:hid", kind: "circle", center: [50, 0], radiusMm: 10, construction: false, visible: false };
      const hiddenRectangle: SketchEntity = { id: "e:hrect", kind: "rectangle", center: [0, 50], widthMm: 20, heightMm: 10, rotationDeg: 0, construction: false, visible: false };
      const profiles = detectSketchProfiles(sketchOf([visibleCircle, hiddenCircle, hiddenRectangle]));
      equal(profiles.length, 1, "only the visible circle is a profile");
      assert(profiles[0]!.entityIds.includes("e:vis"), "the visible circle is the profile");
      const shown = detectSketchProfiles(sketchOf([visibleCircle, { ...hiddenCircle, visible: true }]));
      equal(shown.length, 2, "showing the entity again restores its profile");
    }
  },
  {
    name: "the sketch plane is a persisted, validated property of the sketch and survives a save and reload",
    run: () => {
      const project = createWorkbenchProject("project:test-plane");
      equal(project.sketch.plane, "datum:xy", "a new sketch starts on the XY plane");
      const moved = applyWorkbenchOperation(project, { kind: "set-sketch-plane", operationId: "operation:test-plane-xz", expectedRevision: 0, plane: "datum:xz" });
      assert(moved.ok, "moving the sketch to XZ is accepted");
      equal(moved.value.project.sketch.plane, "datum:xz", "the plane is stored on the sketch");
      equal(moved.value.project.revision, 1, "the change is one audited revision");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(moved.value.project)));
      assert(reloaded.ok, "a project whose sketch is on XZ validates after a JSON round trip");
      equal(reloaded.value.sketch.plane, "datum:xz", "the plane is still XZ after reload");
      const refused = applyWorkbenchOperation(project, { kind: "set-sketch-plane", operationId: "operation:test-plane-bad", expectedRevision: 0, plane: "datum:diagonal" } as unknown as WorkbenchOperation);
      assert(!refused.ok, "an unknown plane is refused");
      const bad = validateWorkbenchProject({ ...JSON.parse(JSON.stringify(project)), sketch: { ...JSON.parse(JSON.stringify(project.sketch)), plane: "datum:diagonal" } });
      assert(!bad.ok, "a saved project with an unknown plane is refused on load");
    }
  },
  {
    name: "constraint solving and dimension edits work the same on every datum plane",
    run: () => {
      for (const plane of ["datum:xy", "datum:xz", "datum:yz"] as const) {
        const slug = plane.replace(":", "-");
        const base = createWorkbenchProject(`project:test-solve-${slug}`);
        const moved = applyWorkbenchOperation(base, { kind: "set-sketch-plane", operationId: `operation:test-solve-plane-${slug}`, expectedRevision: 0, plane });
        assert(moved.ok, `the sketch moves to ${plane}`);
        const resized = applyWorkbenchOperation(moved.value.project, {
          kind: "set-sketch-dimension",
          operationId: `operation:test-solve-dimension-${slug}`,
          expectedRevision: moved.value.project.revision,
          entityId: "entity:mounting-outline",
          dimension: "width",
          valueMm: 72
        });
        assert(resized.ok, `a driving width solves on ${plane}: ${resized.ok ? "" : resized.diagnostics[0]?.message ?? ""}`);
        const outline = resized.value.project.sketch.entities.find((entity) => entity.id === "entity:mounting-outline");
        equal(outline?.kind === "rectangle" ? outline.widthMm : -1, 72, `the width changed on ${plane}`);
        equal(resized.value.project.sketch.plane, plane, `the plane is untouched by the edit on ${plane}`);
        // A relation goes through the live constraint solver, which receives the sketch plane as its reference frame.
        const withLine = applyWorkbenchOperation(resized.value.project, { kind: "add-sketch-entity", operationId: `operation:test-solve-line-${slug}`, expectedRevision: resized.value.project.revision, entity: { id: "entity:test-slanted", kind: "line", start: [0, 10], end: [20, 14], construction: false } });
        assert(withLine.ok, `a line is added on ${plane}`);
        const levelled = applyWorkbenchOperation(withLine.value.project, { kind: "add-sketch-constraint", operationId: `operation:test-solve-horizontal-${slug}`, expectedRevision: withLine.value.project.revision, constraint: { id: "constraint:test-horizontal", kind: "horizontal", entityIds: ["entity:test-slanted"] } });
        assert(levelled.ok, `a horizontal relation solves on ${plane}: ${levelled.ok ? "" : levelled.diagnostics[0]?.message ?? ""}`);
        const line = levelled.value.project.sketch.entities.find((entity) => entity.id === "entity:test-slanted");
        assert(line?.kind === "line" && Math.abs(line.start[1] - line.end[1]) < 1e-6, `the solver levelled the line on ${plane}`);
      }
    }
  }
];
