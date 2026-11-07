import type { GeneralSolidBody, PartPreviewBody, SketchEntity, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { designOf, solidMetrics } from "../../../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../../../packages/workbench-sketch/src/index.js";

/** What the status bar shows, one short line per metric, for whatever is selected. Pure. */
export interface SelectionMetricsReading {
  /** Headline label: "Line", "Circle", "Cut 1", "Mounting plate". */
  readonly title: string;
  /** One or two metric strings, each about "Label: value unit". */
  readonly metrics: readonly string[];
}

const sigFigs = (value: number): string => {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  const digits = magnitude >= 100 ? 1 : magnitude >= 10 ? 2 : 3;
  return value.toFixed(digits);
};

const lineLength = (entity: Extract<SketchEntity, { kind: "line" }>): number => Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
const arcSweepDeg = (entity: Extract<SketchEntity, { kind: "arc" }>): { readonly radius: number; readonly angleDeg: number } => {
  // Radius and sweep of a 3-point arc: the circumcircle through start, mid, end.
  const [sx, sy] = entity.start; const [mx, my] = entity.mid; const [ex, ey] = entity.end;
  const d = 2 * (sx * (my - ey) + mx * (ey - sy) + ex * (sy - my));
  if (Math.abs(d) < 1e-12) return { radius: 0, angleDeg: 0 };
  const sq = (a: number, b: number): number => a * a + b * b;
  const cx = (sq(sx, sy) * (my - ey) + sq(mx, my) * (ey - sy) + sq(ex, ey) * (sy - my)) / d;
  const cy = (sq(sx, sy) * (ex - mx) + sq(mx, my) * (sx - ex) + sq(ex, ey) * (mx - sx)) / d;
  const radius = Math.hypot(sx - cx, sy - cy);
  const angleAt = (x: number, y: number): number => Math.atan2(y - cy, x - cx);
  let sweep = Math.abs(angleAt(ex, ey) - angleAt(sx, sy));
  if (sweep > Math.PI) sweep = 2 * Math.PI - sweep;
  return { radius, angleDeg: sweep * 180 / Math.PI };
};
const splineLength = (entity: Extract<SketchEntity, { kind: "spline" }>): number => {
  // Piecewise-linear fallback over the fit points: a lower bound, not exact, but useful at a glance.
  let total = 0;
  for (let index = 1; index < entity.fitPoints.length; index += 1) total += Math.hypot(entity.fitPoints[index]![0] - entity.fitPoints[index - 1]![0], entity.fitPoints[index]![1] - entity.fitPoints[index - 1]![1]);
  return total;
};

function sketchEntityMetrics(entity: SketchEntity): SelectionMetricsReading | undefined {
  if (entity.kind === "line") return { title: "Line", metrics: [`Length: ${sigFigs(lineLength(entity))} mm`] };
  if (entity.kind === "rectangle") return { title: "Rectangle", metrics: [`Size: ${sigFigs(entity.widthMm)} × ${sigFigs(entity.heightMm)} mm`, `Area: ${sigFigs(entity.widthMm * entity.heightMm)} mm²`] };
  if (entity.kind === "circle") return { title: "Circle", metrics: [`Radius: ${sigFigs(entity.radiusMm)} mm · Ø ${sigFigs(entity.radiusMm * 2)} mm`, `Area: ${sigFigs(Math.PI * entity.radiusMm * entity.radiusMm)} mm²`] };
  if (entity.kind === "arc") { const { radius, angleDeg } = arcSweepDeg(entity); return { title: "Arc", metrics: [`Radius: ${sigFigs(radius)} mm`, `Sweep: ${sigFigs(angleDeg)}°`] }; }
  if (entity.kind === "spline") return { title: `Spline (${entity.fitPoints.length} fit points)`, metrics: [`Piecewise length: ~${sigFigs(splineLength(entity))} mm`] };
  if (entity.kind === "point") return { title: "Point", metrics: [`At: ${sigFigs(entity.point[0])}, ${sigFigs(entity.point[1])} mm`] };
  return undefined;
}

function previewBodyMetrics(body: PartPreviewBody): SelectionMetricsReading {
  const [sx, sy, sz] = body.sizeMm;
  if (body.shape === "torus") {
    // The torus uses sizeMm[0] for the major diameter, sizeMm[2] for the tube diameter; sizeMm[1] is unused.
    const R = sx / 2; const r = sz / 2;
    const volume = 2 * Math.PI * Math.PI * R * r * r;
    const area = 4 * Math.PI * Math.PI * R * r;
    return { title: `${body.name} · torus`, metrics: [`Major Ø ${sigFigs(sx)} mm · tube Ø ${sigFigs(sz)} mm`, `Volume ${sigFigs(volume)} mm³ · surface ${sigFigs(area)} mm²`] };
  }
  if (body.shape === "sphere") {
    const r = sx / 2;
    return { title: `${body.name} · sphere`, metrics: [`Diameter ${sigFigs(sx)} mm`, `Volume ${sigFigs(4 / 3 * Math.PI * r * r * r)} mm³`] };
  }
  if (body.shape === "cylinder") {
    const r = sx / 2;
    return { title: `${body.name} · cylinder`, metrics: [`Diameter ${sigFigs(sx)} mm · height ${sigFigs(sz)} mm`, `Volume ${sigFigs(Math.PI * r * r * sz)} mm³`] };
  }
  if (body.shape === "cone") {
    const r1 = sx / 2; const r2 = sy / 2;
    return { title: `${body.name} · cone`, metrics: [`Base Ø ${sigFigs(sx)} mm · top Ø ${sigFigs(sy)} mm · height ${sigFigs(sz)} mm`, `Volume ${sigFigs(Math.PI * sz * (r1 * r1 + r1 * r2 + r2 * r2) / 3)} mm³`] };
  }
  return { title: `${body.name} · ${body.shape}`, metrics: [`Size ${sigFigs(sx)} × ${sigFigs(sy)} × ${sigFigs(sz)} mm`, `Volume ${sigFigs(sx * sy * sz)} mm³`] };
}

function solidMetricsReading(body: GeneralSolidBody): SelectionMetricsReading {
  const metrics = solidMetrics(body.positionsMm, body.indices);
  const volumeCm3 = metrics.volumeMm3 / 1000;
  const [sx, sy, sz] = metrics.sizeMm;
  return { title: body.name, metrics: [
    `Volume: ${sigFigs(metrics.volumeMm3)} mm³ (${sigFigs(volumeCm3)} cm³)`,
    `Surface area: ${sigFigs(metrics.surfaceAreaMm2)} mm² · Size: ${sigFigs(sx)} × ${sigFigs(sy)} × ${sigFigs(sz)} mm`
  ] };
}

/** Looks at everything the selection could refer to in the project and returns a short metric line, or undefined. */
export function selectionMetrics(project: WorkbenchProject, selectedId: string | null): SelectionMetricsReading | undefined {
  if (selectedId === null) return undefined;
  const entity = project.sketch.entities.find((candidate) => candidate.id === selectedId);
  if (entity !== undefined) return sketchEntityMetrics(entity);
  const generalBody = (project.part.generalBodies ?? []).find((body) => body.id === selectedId);
  if (generalBody !== undefined) return solidMetricsReading(generalBody);
  // A preview body (Block, Cylinder, Torus, …) reports its own dimensions, since it is parametric rather than meshed through the kernel.
  const previewBody = (project.part.previewBodies ?? []).find((body) => body.id === selectedId);
  if (previewBody !== undefined) return previewBodyMetrics(previewBody);
  const profile = detectSketchProfiles(project.sketch).find((candidate) => candidate.id === selectedId);
  if (profile !== undefined) return { title: `Profile (${profile.boundary.kind.replaceAll("-", " ")})`, metrics: [`Area: ${sigFigs(profile.areaMm2)} mm²`] };
  const design = designOf(project);
  const feature = design.features.find((candidate) => candidate.id === selectedId);
  if (feature !== undefined) return { title: feature.name, metrics: [feature.kind === "sketch" ? `${feature.sketch.entities.length} entities` : `${feature.kind} · ${feature.valueMm} ${feature.kind === "revolve" ? "°" : "mm"}`] };
  return undefined;
}
