import type { ConstructionBinder, GeneralSolidBody, Vec3 } from "../../workbench-core/src/index.js";
import { resolveBinder } from "./construction-binders.js";
import { constructionPlaneCorners } from "./construction-geometry.js";
import type { PreviewPrimitive } from "./types.js";

const BINDER_COLOR = "#ffb454";

/** What a visible binder draws: a tinted quad over its face, a line along its edge, or a box around its body. An unresolvable binder draws nothing. */
export function binderPrimitives(binder: ConstructionBinder, bodies: readonly GeneralSolidBody[]): { readonly primitives: readonly PreviewPrimitive[]; readonly bounds: readonly Vec3[] } {
  const resolved = resolveBinder(binder, bodies);
  if ("error" in resolved) return { primitives: [], bounds: [] };
  const flat = (points: readonly Vec3[]): number[] => points.flatMap((point) => [point[0], point[1], point[2]]);
  if (resolved.kind === "edge") {
    return {
      primitives: [{ id: binder.id, name: `${binder.name} · edge binder`, color: BINDER_COLOR, opacity: 1, selectable: true, kind: "line", pointsMm: flat([resolved.a, resolved.b]), dashed: false }],
      bounds: [resolved.a, resolved.b]
    };
  }
  if (resolved.kind === "face") {
    if (resolved.frame === undefined) return { primitives: [], bounds: [resolved.centroidMm] };
    const corners = constructionPlaneCorners(resolved.frame);
    return {
      primitives: [
        { id: binder.id, name: `${binder.name} · face binder`, color: BINDER_COLOR, opacity: 0.3, selectable: true, kind: "mesh", positionsMm: flat(corners), indices: [0, 1, 2, 0, 2, 3], wireframe: false, doubleSided: true },
        { id: `${binder.id}:border`, name: `${binder.name} · face binder border`, color: BINDER_COLOR, opacity: 1, selectable: false, kind: "line", pointsMm: flat([...corners, corners[0]]), dashed: true }
      ],
      bounds: corners
    };
  }
  const { min, max } = resolved.boundsMm;
  const corner = (x: 0 | 1, y: 0 | 1, z: 0 | 1): Vec3 => [x === 0 ? min[0] : max[0], y === 0 ? min[1] : max[1], z === 0 ? min[2] : max[2]];
  const loop = (z: 0 | 1): Vec3[] => [corner(0, 0, z), corner(1, 0, z), corner(1, 1, z), corner(0, 1, z), corner(0, 0, z)];
  const posts: readonly (readonly [Vec3, Vec3])[] = [[corner(0, 0, 0), corner(0, 0, 1)], [corner(1, 0, 0), corner(1, 0, 1)], [corner(1, 1, 0), corner(1, 1, 1)], [corner(0, 1, 0), corner(0, 1, 1)]];
  return {
    primitives: [
      { id: binder.id, name: `${binder.name} · shape binder`, color: BINDER_COLOR, opacity: 1, selectable: true, kind: "line", pointsMm: flat([...loop(0), ...loop(1)]), dashed: true },
      ...posts.map((post, index): PreviewPrimitive => ({ id: `${binder.id}:post-${index}`, name: `${binder.name} · shape binder`, color: BINDER_COLOR, opacity: 1, selectable: false, kind: "line", pointsMm: flat(post), dashed: true }))
    ],
    bounds: [min, max]
  };
}
