/**
 * The Part workspace's analysis tools as one pure function: given the solid bodies and the chosen settings it returns
 * what to draw (a viewport overlay), a legend, a short summary and one row per body or pair. The UI only displays this;
 * all of the maths lives in workbench-geometry and is tested there.
 */

import {
  analyzeCurvature,
  analyzeDraft,
  analyzeWallThickness,
  checkMesh,
  curvatureLegend,
  divergingColor,
  draftColor,
  draftLegend,
  findBodyInterferences,
  sectionCurvatureComb,
  thicknessColor,
  thicknessLegend,
  type AnalysisBodyMesh,
  type AnalysisLegend,
  type MeshCheckReport
} from "../../../../packages/workbench-geometry/src/index.js";
import type { OverlayRgb, ViewportAnalysisLines, ViewportAnalysisMesh, ViewportAnalysisOverlay } from "../../../../packages/viewport-three/src/analysis-overlay.js";

export type AnalysisMode = "geometry-check" | "interference" | "draft" | "wall-thickness" | "gaussian-curvature" | "mean-curvature" | "section-comb";
export type PullAxis = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";

export interface AnalysisSettings {
  readonly mode: AnalysisMode;
  /** A single body id, or null for every visible solid body. */
  readonly bodyId: string | null;
  readonly pullAxis: PullAxis;
  readonly requiredDraftDeg: number;
  readonly thinThresholdMm: number;
  readonly sectionPlane: "xy" | "xz" | "yz";
  readonly sectionOffsetMm: number;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  mode: "geometry-check",
  bodyId: null,
  pullAxis: "+z",
  requiredDraftDeg: 1,
  thinThresholdMm: 1,
  sectionPlane: "xy",
  sectionOffsetMm: 0
};

export const ANALYSIS_MODE_LABELS: Readonly<Record<AnalysisMode, string>> = {
  "geometry-check": "Geometry check",
  interference: "Interference",
  draft: "Draft angle",
  "wall-thickness": "Wall thickness",
  "gaussian-curvature": "Gaussian curvature",
  "mean-curvature": "Mean curvature",
  "section-comb": "Section curvature comb"
};

export const PULL_AXES: readonly PullAxis[] = ["+z", "-z", "+x", "-x", "+y", "-y"];

export type AnalysisTone = "ok" | "warn" | "bad" | "info";

export interface AnalysisRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: AnalysisTone;
}

export interface AnalysisOutcome {
  readonly mode: AnalysisMode;
  readonly title: string;
  readonly overlay: ViewportAnalysisOverlay;
  readonly legend: AnalysisLegend | null;
  /** One-line headline. */
  readonly headline: string;
  readonly tone: AnalysisTone;
  readonly rows: readonly AnalysisRow[];
  /** True when the tool had nothing to analyse. */
  readonly empty: boolean;
}

const RED: OverlayRgb = [0.9, 0.16, 0.14];
const ORANGE: OverlayRgb = [0.98, 0.55, 0.1];

export function pullDirectionOf(axis: PullAxis): readonly [number, number, number] {
  const sign = axis.startsWith("-") ? -1 : 1;
  return axis.endsWith("x") ? [sign, 0, 0] : axis.endsWith("y") ? [0, sign, 0] : [0, 0, sign];
}

export function runAnalysis(allBodies: readonly AnalysisBodyMesh[], settings: AnalysisSettings): AnalysisOutcome {
  const bodies = settings.bodyId === null ? allBodies : allBodies.filter((body) => body.id === settings.bodyId);
  const title = ANALYSIS_MODE_LABELS[settings.mode];
  if (bodies.length === 0) {
    return { mode: settings.mode, title, overlay: { meshes: [], lines: [] }, legend: null, headline: settings.bodyId === null ? "There are no solid bodies to analyse. Create or show a body first." : "The selected body is not available.", tone: "info", rows: [], empty: true };
  }
  switch (settings.mode) {
    case "geometry-check": return geometryCheck(bodies, title);
    case "interference": return interference(allBodies, bodies, title);
    case "draft": return draft(bodies, settings, title);
    case "wall-thickness": return wallThickness(bodies, settings, title);
    case "gaussian-curvature": return curvature(bodies, "gaussian", title);
    case "mean-curvature": return curvature(bodies, "mean", title);
    case "section-comb": return sectionComb(bodies, settings, title);
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// -- geometry check ---------------------------------------------------------------------------

function geometryCheck(bodies: readonly AnalysisBodyMesh[], title: string): AnalysisOutcome {
  const meshes: ViewportAnalysisMesh[] = [];
  const lines: ViewportAnalysisLines[] = [];
  const rows: AnalysisRow[] = [];
  let failed = 0;
  let warned = 0;
  for (const body of bodies) {
    const report: MeshCheckReport = checkMesh(body.positionsMm, body.indices);
    if (report.status === "fail") failed += 1; else if (report.status === "warning") warned += 1;
    const problems = report.issues.filter((issue) => issue.severity !== "info");
    rows.push({
      id: body.id,
      label: body.name,
      tone: report.status === "fail" ? "bad" : report.status === "warning" ? "warn" : "ok",
      detail: problems.length === 0
        ? `Clean: closed, manifold, consistently wound${report.selfIntersectionChecked ? ", no self-intersection" : ""}. ${report.triangleCount} triangles, ${report.components} shell${report.components === 1 ? "" : "s"}.${report.selfIntersectionChecked ? "" : " Self-intersection was not tested (too many triangles)."}`
        : problems.map((issue) => issue.message).join(" ")
    });
    if (report.highlight.openEdgeSegmentsMm.length > 0) lines.push({ id: `${body.id}:open`, segmentsMm: report.highlight.openEdgeSegmentsMm, color: "#ff3b30" });
    if (report.highlight.nonManifoldSegmentsMm.length > 0) lines.push({ id: `${body.id}:non-manifold`, segmentsMm: report.highlight.nonManifoldSegmentsMm, color: "#ff2dd1" });
    if (report.highlight.windingSegmentsMm.length > 0) lines.push({ id: `${body.id}:winding`, segmentsMm: report.highlight.windingSegmentsMm, color: "#ff9500" });
    const faces = [...new Set([...report.highlight.degenerateTriangles, ...report.highlight.selfIntersectingTriangles])];
    if (faces.length > 0) {
      const indices = faces.flatMap((triangle) => [body.indices[triangle * 3]!, body.indices[triangle * 3 + 1]!, body.indices[triangle * 3 + 2]!]);
      meshes.push({ id: `${body.id}:faces`, positionsMm: body.positionsMm, indices, color: report.highlight.selfIntersectingTriangles.length > 0 ? RED : ORANGE });
    }
  }
  const headline = failed > 0 ? `${plural(failed, "body")} failed the geometry check${warned > 0 ? `, ${plural(warned, "body")} have warnings` : ""}.`
    : warned > 0 ? `${plural(warned, "body")} have warnings; the rest pass.`
      : `${bodies.length === 1 ? "The body passes" : `All ${bodies.length} bodies pass`} the geometry check.`;
  return { mode: "geometry-check", title, overlay: { meshes, lines }, legend: failed + warned === 0 ? null : {
    title: "Problems",
    unit: "",
    entries: [
      { label: "Open edge (hole in the surface)", color: "#ff3b30" },
      { label: "Non-manifold edge (more than two faces)", color: "#ff2dd1" },
      { label: "Flipped face (inconsistent winding)", color: "#ff9500" },
      { label: "Faces crossing each other", color: "#e5291f" },
      { label: "Degenerate triangles", color: "#fa8c1a" }
    ]
  }, headline, tone: failed > 0 ? "bad" : warned > 0 ? "warn" : "ok", rows, empty: false };
}

// -- interference -----------------------------------------------------------------------------

function interference(allBodies: readonly AnalysisBodyMesh[], selected: readonly AnalysisBodyMesh[], title: string): AnalysisOutcome {
  // A single chosen body is tested against all the others; with no choice every pair is tested.
  const report = findBodyInterferences(selected.length === allBodies.length ? allBodies : allBodies);
  const wanted = selected.length === allBodies.length ? null : new Set(selected.map((body) => body.id));
  const found = report.interferences.filter((entry) => wanted === null || entry.ids.some((id) => wanted.has(id)));
  const meshes: ViewportAnalysisMesh[] = [];
  const lines: ViewportAnalysisLines[] = [];
  const rows: AnalysisRow[] = found.map((entry) => ({
    id: entry.ids.join("|"),
    label: `${entry.names[0]} ∩ ${entry.names[1]}`,
    tone: "bad",
    detail: `${entry.volumeMm3.toFixed(2)} mm³ shared${entry.method === "sampled" ? " (estimated from ray columns; the Boolean could not return the overlap as one solid)" : ""}${entry.containment === "none" ? "" : entry.containment === "first-in-second" ? `; ${entry.names[0]} lies inside ${entry.names[1]}` : `; ${entry.names[1]} lies inside ${entry.names[0]}`}.`
  }));
  for (const entry of found) {
    if (entry.commonMesh !== undefined) meshes.push({ id: `${entry.ids.join("|")}:common`, positionsMm: entry.commonMesh.positionsMm, indices: entry.commonMesh.indices, color: RED });
    else lines.push({ id: `${entry.ids.join("|")}:box`, segmentsMm: boxOutline(entry.overlapBoundsMm.min, entry.overlapBoundsMm.max), color: "#ff3b30" });
  }
  for (const skipped of report.skipped.filter((entry) => wanted === null || entry.ids.some((id) => wanted.has(id)))) {
    rows.push({ id: `skip:${skipped.ids.join("|")}`, label: `${skipped.ids[0]} / ${skipped.ids[1]}`, tone: "warn", detail: `Not tested: ${skipped.reason}` });
  }
  const total = found.reduce((sum, entry) => sum + entry.volumeMm3, 0);
  return {
    mode: "interference", title, overlay: { meshes, lines }, legend: found.length === 0 ? null : { title: "Interference", unit: "mm³", entries: [{ label: "Common volume of the pair", color: "#e5291f" }] },
    headline: found.length === 0
      ? `No interference among ${report.bodiesTested} bod${report.bodiesTested === 1 ? "y" : "ies"} (${plural(report.pairsTested, "pair")} tested; touching faces do not count).`
      : `${plural(found.length, "pair")} interfere, ${total.toFixed(2)} mm³ in all.`,
    tone: found.length > 0 ? "bad" : report.skipped.length > 0 ? "warn" : "ok", rows, empty: false
  };
}

function boxOutline(min: readonly [number, number, number], max: readonly [number, number, number]): number[] {
  const c = (x: number, y: number, z: number): [number, number, number] => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]];
  const pairs: readonly (readonly [[number, number, number], [number, number, number]])[] = [
    [c(0, 0, 0), c(1, 0, 0)], [c(0, 1, 0), c(1, 1, 0)], [c(0, 0, 1), c(1, 0, 1)], [c(0, 1, 1), c(1, 1, 1)],
    [c(0, 0, 0), c(0, 1, 0)], [c(1, 0, 0), c(1, 1, 0)], [c(0, 0, 1), c(0, 1, 1)], [c(1, 0, 1), c(1, 1, 1)],
    [c(0, 0, 0), c(0, 0, 1)], [c(1, 0, 0), c(1, 0, 1)], [c(0, 1, 0), c(0, 1, 1)], [c(1, 1, 0), c(1, 1, 1)]
  ];
  return pairs.flatMap(([a, b]) => [...a, ...b]);
}

// -- draft ------------------------------------------------------------------------------------

function draft(bodies: readonly AnalysisBodyMesh[], settings: AnalysisSettings, title: string): AnalysisOutcome {
  const meshes: ViewportAnalysisMesh[] = [];
  const rows: AnalysisRow[] = [];
  let positive = 0; let needs = 0; let negative = 0;
  for (const body of bodies) {
    const analysis = analyzeDraft(body.positionsMm, body.indices, { pullDirection: pullDirectionOf(settings.pullAxis), requiredDraftDeg: settings.requiredDraftDeg });
    meshes.push({ id: `${body.id}:draft`, positionsMm: body.positionsMm, indices: body.indices, triangleColors: analysis.triangleAngleDeg.map((angle) => draftColor(angle, settings.requiredDraftDeg)) });
    positive += analysis.areaMm2.positive; needs += analysis.areaMm2.needsDraft; negative += analysis.areaMm2.negative;
    const total = Math.max(analysis.areaMm2.total, 1e-12);
    rows.push({
      id: body.id, label: body.name, tone: analysis.areaMm2.negative > 0 ? "bad" : analysis.areaMm2.needsDraft > 0 ? "warn" : "ok",
      detail: `${(100 * analysis.areaMm2.positive / total).toFixed(0)}% has enough draft, ${(100 * analysis.areaMm2.needsDraft / total).toFixed(0)}% needs draft, ${(100 * analysis.areaMm2.negative / total).toFixed(0)}% is an undercut. Draft runs from ${analysis.minAngleDeg.toFixed(1)}° to ${analysis.maxAngleDeg.toFixed(1)}°.`
    });
  }
  const all = Math.max(positive + needs + negative, 1e-12);
  return {
    mode: "draft", title, overlay: { meshes, lines: [] }, legend: draftLegend(settings.requiredDraftDeg),
    headline: `Pull ${settings.pullAxis.toUpperCase()}, ${settings.requiredDraftDeg}° required: ${(100 * positive / all).toFixed(0)}% released, ${(100 * needs / all).toFixed(0)}% needs draft, ${(100 * negative / all).toFixed(0)}% undercut.`,
    tone: negative > 0 ? "bad" : needs > 0 ? "warn" : "ok", rows, empty: false
  };
}

// -- wall thickness ---------------------------------------------------------------------------

function wallThickness(bodies: readonly AnalysisBodyMesh[], settings: AnalysisSettings, title: string): AnalysisOutcome {
  const results = bodies.map((body) => ({ body, analysis: analyzeWallThickness(body.positionsMm, body.indices, { thinThresholdMm: settings.thinThresholdMm }) }));
  const maxThickness = Math.max(settings.thinThresholdMm * 3, ...results.map(({ analysis }) => analysis.maxThicknessMm));
  const meshes: ViewportAnalysisMesh[] = [];
  const lines: ViewportAnalysisLines[] = [];
  const rows: AnalysisRow[] = [];
  let worst = Infinity;
  let thin = 0;
  for (const { body, analysis } of results) {
    if (!analysis.analysed) { rows.push({ id: body.id, label: body.name, tone: "warn", detail: analysis.message ?? "Not analysed." }); continue; }
    meshes.push({ id: `${body.id}:thickness`, positionsMm: body.positionsMm, indices: body.indices, triangleColors: analysis.triangleThicknessMm.map((value) => thicknessColor(value, settings.thinThresholdMm, maxThickness)) });
    worst = Math.min(worst, analysis.minThicknessMm);
    const isThin = analysis.minThicknessMm < settings.thinThresholdMm;
    if (isThin) thin += 1;
    if (isThin && analysis.minLocationMm !== undefined) lines.push({ id: `${body.id}:min`, segmentsMm: crossAt(analysis.minLocationMm, Math.max(1, analysis.maxThicknessMm / 4)), color: "#e5291f" });
    rows.push({
      id: body.id, label: body.name, tone: isThin ? "bad" : "ok",
      detail: `Thinnest ${analysis.minThicknessMm.toFixed(3)} mm${analysis.minLocationMm === undefined ? "" : ` at (${analysis.minLocationMm.map((value) => value.toFixed(1)).join(", ")})`}, mean ${analysis.meanThicknessMm.toFixed(2)} mm, thickest ${analysis.maxThicknessMm.toFixed(2)} mm. ${(100 * analysis.thinAreaMm2 / Math.max(analysis.totalAreaMm2, 1e-12)).toFixed(0)}% of the surface is under ${settings.thinThresholdMm} mm.${analysis.unmeasuredTriangles > 0 ? ` ${plural(analysis.unmeasuredTriangles, "triangle")} found nothing behind them.` : ""}`
    });
  }
  const measured = meshes.length > 0;
  return {
    mode: "wall-thickness", title, overlay: { meshes, lines }, legend: measured ? thicknessLegend(settings.thinThresholdMm, maxThickness) : null,
    headline: !measured ? "No body could be analysed." : thin > 0 ? `Thinnest wall ${worst.toFixed(3)} mm, below the ${settings.thinThresholdMm} mm limit.` : `Thinnest wall ${worst.toFixed(3)} mm; nothing is under ${settings.thinThresholdMm} mm.`,
    tone: !measured ? "warn" : thin > 0 ? "bad" : "ok", rows, empty: false
  };
}

function crossAt(point: readonly [number, number, number], arm: number): number[] {
  return [
    point[0] - arm, point[1], point[2], point[0] + arm, point[1], point[2],
    point[0], point[1] - arm, point[2], point[0], point[1] + arm, point[2],
    point[0], point[1], point[2] - arm, point[0], point[1], point[2] + arm
  ];
}

// -- curvature --------------------------------------------------------------------------------

function curvature(bodies: readonly AnalysisBodyMesh[], kind: "gaussian" | "mean", title: string): AnalysisOutcome {
  const results = bodies.map((body) => ({ body, analysis: analyzeCurvature(body.positionsMm, body.indices) }));
  const statsOf = (entry: (typeof results)[number]) => kind === "gaussian" ? entry.analysis.gaussianStats : entry.analysis.meanStats;
  // One shared range so bodies compare: the largest 95th-percentile magnitude.
  const range = Math.max(1e-9, ...results.map((entry) => statsOf(entry).p95Abs));
  const meshes: ViewportAnalysisMesh[] = [];
  const rows: AnalysisRow[] = [];
  for (const entry of results) {
    const values = kind === "gaussian" ? entry.analysis.gaussian : entry.analysis.mean;
    const vertexCount = Math.floor(entry.body.positionsMm.length / 3);
    const colors: OverlayRgb[] = [];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const welded = entry.analysis.weldedIndexOfVertex[vertex] ?? -1;
      colors.push(welded < 0 ? divergingColor(Number.NaN, range) : divergingColor(values[welded] ?? Number.NaN, range));
    }
    meshes.push({ id: `${entry.body.id}:${kind}`, positionsMm: entry.body.positionsMm, indices: entry.body.indices, vertexColors: colors });
    const stats = statsOf(entry);
    const unit = kind === "gaussian" ? "mm⁻²" : "mm⁻¹";
    rows.push({ id: entry.body.id, label: entry.body.name, tone: "info", detail: `${kind === "gaussian" ? "Gaussian" : "Mean"} curvature from ${stats.min.toExponential(2)} to ${stats.max.toExponential(2)} ${unit} (median ${stats.median.toExponential(2)}). The colour scale is ±${range.toExponential(2)}.` });
  }
  return { mode: kind === "gaussian" ? "gaussian-curvature" : "mean-curvature", title, overlay: { meshes, lines: [] }, legend: curvatureLegend(kind, range), headline: `${title} map of ${plural(bodies.length, "body")}; vertices on open boundaries are grey.`, tone: "info", rows, empty: false };
}

// -- section curvature comb -------------------------------------------------------------------

function sectionComb(bodies: readonly AnalysisBodyMesh[], settings: AnalysisSettings, title: string): AnalysisOutcome {
  const lines: ViewportAnalysisLines[] = [];
  const rows: AnalysisRow[] = [];
  let curves = 0;
  for (const body of bodies) {
    const comb = sectionCurvatureComb(body.positionsMm, body.indices, settings.sectionPlane, settings.sectionOffsetMm);
    curves += comb.curves.length;
    if (comb.curves.length === 0) { rows.push({ id: body.id, label: body.name, tone: "info", detail: "The plane does not cut this body." }); continue; }
    lines.push({ id: `${body.id}:section`, segmentsMm: comb.curves.flatMap((curve) => curve.points.flatMap((point, index) => {
      const next = curve.points[(index + 1) % curve.points.length]!;
      return index + 1 === curve.points.length && !curve.closed ? [] : [...point, ...next];
    })), color: "#6b7a86", onTop: true });
    if (comb.teethMm.length > 0) lines.push({ id: `${body.id}:teeth`, segmentsMm: comb.teethMm, color: "#f08c00", onTop: true });
    if (comb.envelopeMm.length > 0) lines.push({ id: `${body.id}:envelope`, segmentsMm: comb.envelopeMm, color: "#c2410c", onTop: true });
    rows.push({ id: body.id, label: body.name, tone: "info", detail: `${plural(comb.curves.length, "section curve")}, tightest radius ${Number.isFinite(comb.minRadiusMm) ? `${comb.minRadiusMm.toFixed(2)} mm` : "none (straight)"}. Teeth point away from the centre of curvature; long teeth mark tight bends.` });
  }
  return {
    mode: "section-comb", title, overlay: { meshes: [], lines },
    legend: curves === 0 ? null : { title: "Curvature comb", unit: "", entries: [{ label: "Section curve", color: "#6b7a86" }, { label: "Tooth: length proportional to curvature", color: "#f08c00" }, { label: "Envelope of the tooth tips", color: "#c2410c" }] },
    headline: curves === 0 ? `The ${settings.sectionPlane.toUpperCase()} plane at ${settings.sectionOffsetMm} mm does not cut the selected bodies.` : `${plural(curves, "section curve")} on the ${settings.sectionPlane.toUpperCase()} plane at ${settings.sectionOffsetMm} mm.`,
    tone: curves === 0 ? "warn" : "info", rows, empty: curves === 0
  };
}
