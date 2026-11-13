import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseWorkbenchProjectText, planarFacesOfBody, planeOffsetForCoordinate, serializeWorkbenchProject, type GeneralSolidBody } from "../packages/workbench-core/src/index.js";
import { placementOfPickedPlane, sketchPlaneOfFace } from "../apps/studio-web/src/sketch-face-pick.js";
import { contextSketchAction } from "../apps/studio-web/src/sketch-plane-ui.js";
import { SketchPlaneDialog } from "../apps/studio-web/src/ui/SketchPlaneDialog.js";
import { buildSolid, circ, committedSketch, fresh, line, meshStats, pipelineRun, rect, solidOf } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Create Sketch on a face that is clicked or selected on the model: the face decides the plane, no list is read. A flat face square
 * to an axis gives the same plane the dialog's list would; a slanted flat face gives the sketch its own frame; a curved face is refused.
 */

async function plate(): Promise<GeneralSolidBody> {
  const { sketch } = committedSketch("datum:xy", [rect("plate", 40, 25, 80, 50)]);
  return solidOf(await buildSolid(sketch, "extrude", { valueMm: 6 }));
}

/** The index of the named face of a body that is flat, square to `axis`, and at `coordinate`. */
function faceIndexAt(body: GeneralSolidBody, axis: "x" | "y" | "z", coordinate: number): number {
  const face = planarFacesOfBody(body).find((candidate) => candidate.axis === axis && Math.abs(candidate.coordinateMm - coordinate) < 1e-6);
  assert(face !== undefined, `the body has a flat face at ${axis} = ${coordinate}`);
  const index = body.brep?.faces.findIndex((candidate) => candidate.key === face.faceKey) ?? -1;
  assert(index >= 0, "and it is one of the named faces");
  return index;
}

export const sketchFacePickTests: readonly TestCase[] = [
  {
    name: "Create Sketch on a clicked face: the top of a plate gives the XY plane at its height and the sketch follows the face",
    run: async () => {
      const body = await plate();
      const top = sketchPlaneOfFace(body, { faceIndex: faceIndexAt(body, "z", 6) });
      assert(top.ok, `the top face takes a sketch: ${top.ok ? "" : top.message}`);
      if (!top.ok) return;
      equal(top.plane, "datum:xy", "on the XY plane");
      near(top.offsetMm, 6, 1e-9, "6 mm up");
      assert(top.face !== undefined && top.face.bodyId === body.id && top.follows, "and it is tied to the named face, so it follows it");
      assert(top.label.includes("z = 6 mm"), `the status names the face (${top.label})`);
      const side = sketchPlaneOfFace(body, { faceIndex: faceIndexAt(body, "x", 80) });
      assert(side.ok && side.plane === "datum:yz", "the x = 80 face gives the YZ plane");
      if (side.ok) near(side.offsetMm, planeOffsetForCoordinate("datum:yz", 80), 1e-9, "at the offset that puts it on the face");
      // The same operation the app sends: one new sketch on the face, stored with the face it is on.
      const before = fresh();
      const project = pipelineRun(before, { kind: "new-design-sketch", plane: top.plane, ...placementOfPickedPlane(top) });
      equal(project.revision, before.revision + 1, "one step, so one Undo");
      equal(project.sketch.plane, "datum:xy", "the working sketch is on XY");
      equal(project.sketch.planeOffsetMm, 6, "at 6 mm");
      equal(project.sketch.planeFace?.faceKey, top.face?.faceKey, "and remembers its face");
      equal(project.sketch.entities.length, 0, "it is a new, empty sketch");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok && reloaded.value.sketch.planeFace?.faceKey === top.face?.faceKey, "the face survives save and reload");
    }
  },
  {
    name: "Create Sketch on a clicked face of a body without named faces, on a slanted face and on a curved face",
    run: async () => {
      const body = await plate();
      const { brep: _brep, ...bare } = body;
      const byPoint = sketchPlaneOfFace(bare, { pointMm: [30, 20, 6] });
      assert(byPoint.ok, `a click on the flat top of an unnamed mesh works: ${byPoint.ok ? "" : byPoint.message}`);
      if (byPoint.ok) {
        equal(byPoint.plane, "datum:xy", "XY");
        near(byPoint.offsetMm, 6, 1e-6, "at the face height");
        assert(byPoint.face === undefined && !byPoint.follows, "with no face to follow, and it says so");
      }
      // A wedge: a right triangle on the front plane, 20 deep. Its long face is flat but square to no axis.
      const { sketch } = committedSketch("datum:xz", [line("a", [0, 0], [40, 0]), line("b", [40, 0], [0, 30]), line("c", [0, 30], [0, 0])]);
      const wedge = solidOf(await buildSolid(sketch, "extrude", { valueMm: 20 }));
      const stats = meshStats(wedge);
      const midY = (stats.lo[1] + stats.hi[1]) / 2;
      const slanted = sketchPlaneOfFace(wedge, { pointMm: [20, midY, 15] });
      assert(slanted.ok, `the slanted face takes a sketch: ${slanted.ok ? "" : slanted.message}`);
      if (slanted.ok) {
        assert(slanted.frame !== undefined && slanted.face === undefined && !slanted.follows, "on its own frame, not following");
        const frame = slanted.frame!;
        near(frame.uAxis[0] * frame.normal[0] + frame.uAxis[1] * frame.normal[1] + frame.uAxis[2] * frame.normal[2], 0, 1e-5, "the sketch X axis lies in the face");
        near(Math.hypot(frame.normal[0], frame.normal[1], frame.normal[2]), 1, 1e-5, "the normal is a unit vector");
        // The hypotenuse runs from (40, 0) to (0, 30) in X and Z: points on the face satisfy 3x + 4z = 120.
        near(3 * frame.originMm[0] + 4 * frame.originMm[2], 120, 1e-3, "the sketch origin is on the face");
        assert(frame.normal[0] > 0 && frame.normal[2] > 0, "and the sketch faces out of the solid");
        const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: slanted.plane, ...placementOfPickedPlane(slanted) });
        assert(project.sketch.planeFrame !== undefined, "the new sketch sits on that frame");
      }
      // A cylinder's side is curved: refused with the reason, nothing is started.
      const round = committedSketch("datum:xy", [circ("disc", 0, 0, 10)]);
      const cylinder = solidOf(await buildSolid(round.sketch, "extrude", { valueMm: 12 }));
      const curved = sketchPlaneOfFace(cylinder, { pointMm: [10, 0, 6] });
      assert(!curved.ok && /curved/u.test(curved.message), `a curved face is refused (${curved.ok ? "accepted" : curved.message})`);
      const flatEnd = sketchPlaneOfFace(cylinder, { pointMm: [2, 1, 12] });
      assert(flatEnd.ok && flatEnd.plane === "datum:xy", "the flat end of the cylinder works");
    }
  },
  {
    name: "Create Sketch from a right-click with a face selected starts on that face; the plane dialog offers a click on the model",
    run: () => {
      equal(contextSketchAction("sketch.create", "general-body:b1", [], "general-body:b1").kind, "new-on-face", "a face of the right-clicked solid is selected");
      equal(contextSketchAction("sketch.create", "general-body:b1", [], null).kind, "ask-plane", "a solid with no face selected asks");
      equal(contextSketchAction("sketch.create", "general-body:b1", [], "general-body:other").kind, "ask-plane", "a face of another solid does not count");
      equal(contextSketchAction("sketch.create", "datum:xz", [], "general-body:b1").kind, "new-on-plane", "an origin plane still wins");
      const noop = (): void => undefined;
      const base = { open: true, initialPlane: "xy" as const, initialOffsetMm: 0, faces: [], mode: "new" as const, onConfirm: noop, onClose: noop };
      const withPick = renderToStaticMarkup(createElement(SketchPlaneDialog, { ...base, onPickFace: noop }));
      assert(withPick.includes("Click a face on the model") && withPick.includes("Esc cancels"), "with a solid in the part the dialog offers the click");
      assert(!renderToStaticMarkup(createElement(SketchPlaneDialog, base)).includes("Click a face on the model"), "with no solid it does not");
    }
  },
];
