import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { buildArrangement, clusterPoints } from "./arrangement.js";
import { isClosedFitSpline } from "./curve-sampling.js";
import type { SketchProfile } from "./index.js";
import { profilesOfArrangement } from "./profile-regions.js";

/**
 * The closed "shapes" a sketch draws: each rectangle, circle, ellipse and closed spline, and each loop of lines, arcs and splines
 * that joins end to end with exactly two curves at every joint. A shape is the closed outline as drawn, whatever else crosses it.
 *
 * Regions (the faces of the arrangement) are what the sketch encloses; shapes are what was drawn. They are the same thing for
 * geometry that does not touch, and differ where curves cross: a rectangle crossed by a circle is one shape but several regions.
 * The shape is what an older profile id (`profile:<entity>`, `profile:loop-<hash>`) and an empty profile selection mean: "the
 * outermost outline, with the outlines inside it as holes".
 */
export function detectShapes(entities: readonly SketchEntity[], toleranceMm: number): readonly SketchProfile[] {
  const sorted = [...entities].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const sets: (readonly SketchEntity[])[] = [];
  const opens: Extract<SketchEntity, { kind: "line" | "arc" | "spline" }>[] = [];
  for (const entity of sorted) {
    if (entity.kind === "rectangle" || entity.kind === "circle" || entity.kind === "ellipse") sets.push([entity]);
    else if (entity.kind === "spline") {
      if (isClosedFitSpline(entity.fitPoints, toleranceMm)) sets.push([entity]);
      else opens.push(entity);
    } else if (entity.kind === "line" || entity.kind === "arc") opens.push(entity);
  }
  const endsOf = (entity: (typeof opens)[number]): readonly [Vec2, Vec2] =>
    entity.kind === "spline" ? [entity.fitPoints[0]!, entity.fitPoints[entity.fitPoints.length - 1]!] : [entity.start, entity.end];
  const points: Vec2[] = [];
  for (const entity of opens) points.push(...endsOf(entity));
  const clusters = clusterPoints(points, toleranceMm);
  const incidence = new Map<number, number>();
  for (const cluster of clusters) incidence.set(cluster, (incidence.get(cluster) ?? 0) + 1);
  const parent = opens.map((_, index) => index);
  const find = (x: number): number => { let r = x; while (parent[r] !== r) r = parent[r]!; return r; };
  const firstOfCluster = new Map<number, number>();
  opens.forEach((_, index) => {
    for (const side of [0, 1]) {
      const cluster = clusters[index * 2 + side]!;
      const seen = firstOfCluster.get(cluster);
      if (seen === undefined) firstOfCluster.set(cluster, index);
      else { const a = find(seen); const b = find(index); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    }
  });
  const components = new Map<number, number[]>();
  opens.forEach((_, index) => {
    const root = find(index);
    const list = components.get(root);
    if (list === undefined) components.set(root, [index]); else list.push(index);
  });
  for (const members of components.values()) {
    const joints = members.flatMap((index) => [clusters[index * 2]!, clusters[index * 2 + 1]!]);
    if (!joints.every((cluster) => incidence.get(cluster) === 2)) continue;
    const curved = members.some((index) => opens[index]!.kind !== "line");
    if (members.length < (curved ? 2 : 3)) continue;
    sets.push(members.map((index) => opens[index]!));
  }
  const shapes: SketchProfile[] = [];
  for (const set of sets) {
    const arrangement = buildArrangement(set, { gapToleranceMm: toleranceMm });
    if (arrangement.faces.length !== 1) continue;
    const profiles = profilesOfArrangement(arrangement, set);
    const profile = profiles[0];
    // A drawn outline says nothing about what lies inside it, so its id carries no hole list: it always takes the outlines inside it as holes.
    if (profile !== undefined && profile.holes === undefined) shapes.push({ ...profile, id: profile.id.replace(/_h[0-9a-f.]*$/u, ""), ref: profile.id.replace(/_h[0-9a-f.]*$/u, "") + "_e" });
  }
  return shapes.sort((left, right) => right.areaMm2 - left.areaMm2 || left.id.localeCompare(right.id));
}
