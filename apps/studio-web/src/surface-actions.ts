import type { GeneralSolidBody, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { isFormBody, isSurfaceBody } from "../../../packages/workbench-core/src/index.js";
import type { PreviewPrimitive, PreviewScene } from "../../../packages/workbench-geometry/src/index.js";
import {
  planBoundaryPatch, planCreateForm, planEditForm, planExtendSurface, planFinishForm, planLoftSurface, planRuledSurface, planStitch, planTrimSurface, sketchCurvesOf, type FormEdit, type Planned
} from "./surface-workflow.js";

/** The buttons of the Surface workspace's mesh-surface and SubD groups. */
export type SurfaceAction = "ruled" | "loft" | "patch" | "extend" | "trim" | "stitch" | "form-new" | "form-edit" | "form-finish";

export interface SurfaceActionEnvironment {
  readonly project: WorkbenchProject;
  readonly selectedId: string | null;
  /** Asks for a line of text; null means cancelled. */
  readonly ask: (label: string, defaultValue: string) => string | null;
}

export type SurfaceActionResult = Planned | { readonly cancelled: true };

const numbers = (text: string): number[] => text.split(/[\s,;]+/u).filter((part) => part !== "").map((part) => Number(part));
const cancelled: SurfaceActionResult = { cancelled: true };
const fail = (message: string): SurfaceActionResult => ({ ok: false, message });

/**
 * Runs one Surface-workspace action: asks for what it needs (curves by their number in the list, sizes, distances), builds the plan with
 * the surface planners and hands it back for the app to apply as one undo step. Curves come from the timeline's sketches; surfaces and
 * forms are the selected body (or the only one of their kind).
 */
export function runSurfaceAction(action: SurfaceAction, env: SurfaceActionEnvironment): SurfaceActionResult {
  const bodies = env.project.part.generalBodies ?? [];
  const curves = sketchCurvesOf(env.project);
  const curveList = curves.map((curve, index) => `${index + 1} ${curve.label}`).join("; ");
  const pickCurves = (label: string, expected: number | undefined): readonly (typeof curves)[number][] | SurfaceActionResult => {
    if (curves.length === 0) return fail("The timeline has no sketch curves to build a surface from. Draw lines, arcs, splines or circles in a sketch and finish it first.");
    const answer = env.ask(`${label} Curve numbers, separated by commas. Available: ${curveList}`, expected === undefined ? "1, 2" : Array.from({ length: expected }, (_, i) => String(i + 1)).join(", "));
    if (answer === null) return cancelled;
    const picked = numbers(answer).map((n) => curves[n - 1]);
    if (picked.length === 0 || picked.some((curve) => curve === undefined)) return fail(`Enter curve numbers from 1 to ${curves.length}.`);
    if (expected !== undefined && picked.length !== expected) return fail(`Enter ${expected} curve numbers.`);
    return picked as (typeof curves)[number][];
  };
  const isFailure = (value: unknown): value is SurfaceActionResult => typeof value === "object" && value !== null && !Array.isArray(value) && ("cancelled" in value || "ok" in value);
  const selected = bodies.find((body) => body.id === env.selectedId);
  const only = (test: (body: GeneralSolidBody) => boolean): GeneralSolidBody | undefined => (selected !== undefined && test(selected) ? selected : bodies.filter(test).length === 1 ? bodies.find(test) : undefined);

  switch (action) {
    case "ruled": {
      const picked = pickCurves("Ruled surface between two curves.", 2);
      if (isFailure(picked)) return picked;
      return planRuledSurface(env.project, picked[0]!.pointsMm, picked[1]!.pointsMm);
    }
    case "loft": {
      const picked = pickCurves("Loft surface through two or more curves, in order.", undefined);
      if (isFailure(picked)) return picked;
      return planLoftSurface(env.project, picked.map((curve) => curve.pointsMm));
    }
    case "patch": {
      const picked = pickCurves("Patch: fill a closed loop of edges. List every edge of the loop.", undefined);
      if (isFailure(picked)) return picked;
      return planBoundaryPatch(env.project, picked.map((curve) => curve.pointsMm));
    }
    case "extend": {
      const target = only(isSurfaceBody);
      if (target === undefined) return fail("Extend: select the surface to extend first.");
      const answer = env.ask(`Extend ${target.name} past its open edge by (mm):`, "10");
      if (answer === null) return cancelled;
      const distance = Number(answer);
      if (!(distance > 0)) return fail("Extend: enter a distance above zero.");
      return planExtendSurface(env.project, target.id, { distanceMm: distance });
    }
    case "trim": {
      const target = only(isSurfaceBody);
      if (target === undefined) return fail("Trim: select the surface to trim first.");
      const mode = (env.ask("Trim by a plane or by a sketch curve? (plane / curve)", "plane") ?? "").trim().toLowerCase();
      if (mode === "") return cancelled;
      if (mode === "plane") {
        const axisText = (env.ask("Plane perpendicular to which axis, and where (for example x 25 keeps the side with larger x; use a minus sign to keep the other side):", "x 0") ?? "").trim().toLowerCase();
        if (axisText === "") return cancelled;
        const [axisName, valueText, sideText] = axisText.split(/\s+/u);
        const axis = ["x", "y", "z"].indexOf(axisName ?? "");
        const value = Number(valueText);
        if (axis < 0 || !Number.isFinite(value)) return fail("Trim: enter an axis (x, y or z) and a position, like x 25.");
        const point: [number, number, number] = [0, 0, 0];
        const normal: [number, number, number] = [0, 0, 0];
        point[axis] = value;
        normal[axis] = 1;
        return planTrimSurface(env.project, target.id, { kind: "plane", pointMm: point, normalMm: normal, keep: sideText === "-" ? "negative" : "positive" });
      }
      if (mode === "curve") {
        const picked = pickCurves("Trim to a closed curve, projected straight along Z onto the surface.", 1);
        if (isFailure(picked)) return picked;
        const keep = (env.ask("Keep the part inside or outside the curve?", "inside") ?? "").trim().toLowerCase();
        if (keep === "") return cancelled;
        if (keep !== "inside" && keep !== "outside") return fail("Trim: enter inside or outside.");
        return planTrimSurface(env.project, target.id, { kind: "loop", loopMm: picked[0]!.pointsMm, directionMm: [0, 0, 1], keep });
      }
      return fail("Trim: enter plane or curve.");
    }
    case "stitch": {
      const surfaces = bodies.filter(isSurfaceBody);
      if (surfaces.length === 0) return fail("Stitch: there are no surfaces to sew. Make ruled, loft or patch surfaces first.");
      const list = surfaces.map((body, index) => `${index + 1} ${body.name}`).join("; ");
      const answer = env.ask(`Stitch surfaces into a solid. Surface numbers, or all. Available: ${list}`, "all");
      if (answer === null) return cancelled;
      const chosen = answer.trim().toLowerCase() === "all" ? surfaces : numbers(answer).map((n) => surfaces[n - 1]);
      if (chosen.length === 0 || chosen.some((body) => body === undefined)) return fail(`Stitch: enter surface numbers from 1 to ${surfaces.length}, or all.`);
      return planStitch(env.project, (chosen as GeneralSolidBody[]).map((body) => body.id));
    }
    case "form-new": {
      const answer = env.ask("New SubD form: a box of width, depth, height (mm):", "40, 40, 30");
      if (answer === null) return cancelled;
      const [width, depth, height] = numbers(answer);
      if (width === undefined || depth === undefined || height === undefined) return fail("Form: enter three sizes, like 40, 40, 30.");
      return planCreateForm(env.project, { kind: "box", widthMm: width, depthMm: depth, heightMm: height });
    }
    case "form-edit": {
      const target = only(isFormBody);
      if (target === undefined) return fail("Edit form: select a SubD form first.");
      const cage = target.subd!;
      const kind = (env.ask(`Edit ${target.name} (${cage.verticesMm.length / 3} cage vertices, ${cage.faces.length} faces): move, extrude, loop, delete or levels?`, "move") ?? "").trim().toLowerCase();
      if (kind === "") return cancelled;
      let edit: FormEdit | undefined;
      if (kind === "move") {
        const ids = env.ask("Cage vertex numbers to move (0 to " + (cage.verticesMm.length / 3 - 1) + "), separated by commas:", "0");
        const delta = ids === null ? null : env.ask("Move by x, y, z (mm):", "0, 0, 5");
        if (ids === null || delta === null) return cancelled;
        const [dx, dy, dz] = numbers(delta);
        if (dx === undefined || dy === undefined || dz === undefined) return fail("Move: enter three numbers.");
        edit = { kind: "move", vertexIds: numbers(ids), deltaMm: [dx, dy, dz] };
      } else if (kind === "extrude") {
        const ids = env.ask("Cage face numbers to extrude (0 to " + (cage.faces.length - 1) + "), separated by commas:", "1");
        const how = ids === null ? null : env.ask("Distance and inset in mm (a negative distance needs an inset):", "10, 0");
        if (ids === null || how === null) return cancelled;
        const [distance, inset] = numbers(how);
        if (distance === undefined) return fail("Extrude: enter a distance.");
        edit = { kind: "extrude", faceIds: numbers(ids), distanceMm: distance, insetMm: inset ?? 0 };
      } else if (kind === "loop") {
        const edge = env.ask("Edge loop across the edge between cage vertices a, b and how far along (0 to 1):", "0, 1, 0.5");
        if (edge === null) return cancelled;
        const [a, b, ratio] = numbers(edge);
        if (a === undefined || b === undefined) return fail("Edge loop: enter the two vertex numbers of the edge.");
        edit = { kind: "edge-loop", a, b, ratio: ratio ?? 0.5 };
      } else if (kind === "delete") {
        const ids = env.ask("Cage face numbers to delete, separated by commas:", "0");
        if (ids === null) return cancelled;
        edit = { kind: "delete-faces", faceIds: numbers(ids) };
      } else if (kind === "levels") {
        const levels = env.ask("Subdivision levels (0 to 5):", String(cage.levels));
        if (levels === null) return cancelled;
        edit = { kind: "levels", levels: Number(levels) };
      } else return fail("Edit form: enter move, extrude, loop, delete or levels.");
      return planEditForm(env.project, target.id, edit);
    }
    case "form-finish": {
      const target = only(isFormBody);
      if (target === undefined) return fail("Finish Form: select a SubD form first.");
      return planFinishForm(env.project, target.id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

/**
 * The cage of every visible SubD form as line loops, drawn over the form so its control points can be read off (the numbers the edit
 * prompts use are the cage's vertex and face numbers).
 */
export function formCagePrimitives(project: WorkbenchProject): readonly PreviewPrimitive[] {
  const primitives: PreviewPrimitive[] = [];
  for (const body of project.part.generalBodies ?? []) {
    if (!body.visible || body.subd === undefined) continue;
    body.subd.faces.forEach((face, index) => {
      const points = [...face, face[0]!].flatMap((vertex) => [body.subd!.verticesMm[vertex * 3]!, body.subd!.verticesMm[vertex * 3 + 1]!, body.subd!.verticesMm[vertex * 3 + 2]!]);
      primitives.push({ id: `${body.id}:cage-${index}`, name: `${body.name} · cage face ${index}`, color: "#ffd479", opacity: 0.9, selectable: false, kind: "line", pointsMm: points, dashed: false });
    });
  }
  return primitives;
}

/** The Surface workspace's scene with the mesh surfaces and SubD forms of the part (and their cages) added to the Bézier preview. */
export function withSurfaceBodies(scene: PreviewScene, project: WorkbenchProject): PreviewScene {
  const bodies = (project.part.generalBodies ?? []).filter((body) => body.visible && (isSurfaceBody(body) || isFormBody(body) || body.feature?.operation === "stitched-solid"));
  if (bodies.length === 0) return scene;
  const meshes = bodies.map((body): PreviewPrimitive => ({
    id: body.id, name: `${body.name} · ${isFormBody(body) ? "SubD form" : isSurfaceBody(body) ? "surface" : "stitched solid"}`, color: body.color, opacity: isSurfaceBody(body) ? 0.9 : 1, selectable: true, kind: "mesh",
    positionsMm: body.positionsMm, indices: body.indices, wireframe: false, doubleSided: true
  }));
  const all = [...bodies.flatMap((body) => body.positionsMm)];
  const min: [number, number, number] = [...scene.boundsMm.min];
  const max: [number, number, number] = [...scene.boundsMm.max];
  for (let i = 0; i < all.length; i += 3) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis]!, all[i + axis]!); max[axis] = Math.max(max[axis]!, all[i + axis]!); }
  return { ...scene, primitives: [...scene.primitives, ...meshes, ...formCagePrimitives(project)], boundsMm: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] } };
}

/** The part scene with every visible SubD form's cage drawn over it. */
export function withFormCages(scene: PreviewScene, project: WorkbenchProject): PreviewScene {
  const cages = formCagePrimitives(project);
  return cages.length === 0 ? scene : { ...scene, primitives: [...scene.primitives, ...cages] };
}
