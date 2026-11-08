import type { PartIntent } from "../../workbench-core/src/index.js";
import {
  checkMesh,
  findBodyInterferences,
  partAnalysisBodies,
  type AnalysisBodyMesh,
  type BodyInterference,
  type MeshCheckReport
} from "../../workbench-geometry/src/index.js";
import type { DesignHealthFinding } from "./index.js";

/** The health report re-runs on every revision, so keep the self-intersection test to bodies it finishes quickly on. */
const SELF_INTERSECTION_TRIANGLE_LIMIT = 4000;
/** Bodies above this size are left to the Boolean-based interference command rather than run on every revision. */
const INTERFERENCE_TRIANGLE_LIMIT = 12000;

const checkCache = new WeakMap<readonly number[], WeakMap<readonly number[], MeshCheckReport>>();
const pairCache = new WeakMap<readonly number[], WeakMap<readonly number[], BodyInterference | null>>();

function cachedCheck(body: AnalysisBodyMesh): MeshCheckReport {
  let byIndices = checkCache.get(body.positionsMm);
  if (byIndices === undefined) { byIndices = new WeakMap(); checkCache.set(body.positionsMm, byIndices); }
  let report = byIndices.get(body.indices);
  if (report === undefined) {
    report = checkMesh(body.positionsMm, body.indices, { selfIntersection: body.indices.length / 3 <= SELF_INTERSECTION_TRIANGLE_LIMIT, maxHighlights: 8 });
    byIndices.set(body.indices, report);
  }
  return report;
}

function cachedPair(first: AnalysisBodyMesh, second: AnalysisBodyMesh): BodyInterference | null {
  let inner = pairCache.get(first.positionsMm);
  if (inner === undefined) { inner = new WeakMap(); pairCache.set(first.positionsMm, inner); }
  const cached = inner.get(second.positionsMm);
  if (cached !== undefined) return cached;
  const found = findBodyInterferences([first, second]).interferences[0] ?? null;
  inner.set(second.positionsMm, found);
  return found;
}

/** Health findings for the solid bodies of the Part workspace: the geometry checker and body-to-body interference. */
export function partGeometryFindings(part: PartIntent): readonly DesignHealthFinding[] {
  const bodies = partAnalysisBodies(part);
  if (bodies.length === 0) return [];
  const findings: DesignHealthFinding[] = [];

  const reports = bodies.map((body) => ({ body, report: cachedCheck(body) }));
  const failed = reports.filter(({ report }) => report.status === "fail");
  const warned = reports.filter(({ report }) => report.status === "warning");
  const summarize = (entries: typeof reports): string => entries.map(({ body, report }) => `${body.name}: ${report.issues.filter((issue) => issue.severity !== "info").map((issue) => `${issue.count} ${issue.kind.replace(/-/g, " ")}`).join(", ")}`).join(" | ");
  if (failed.length > 0) {
    findings.push({
      id: "health:part-geometry-check", workspace: "part", severity: "error",
      title: "Solid body fails the geometry check",
      message: `${failed.length} of ${bodies.length} solid bod${bodies.length === 1 ? "y" : "ies"} ${failed.length === 1 ? "has" : "have"} open or non-manifold edges, inconsistent winding, inverted faces or self-intersection.`,
      recovery: "Open Inspect > Geometry check to see and highlight the problem, then rebuild the feature or delete the damaged body before Boolean, export or analysis.",
      relatedIds: failed.map(({ body }) => body.id),
      evidence: summarize(failed)
    });
  } else if (warned.length > 0) {
    findings.push({
      id: "health:part-geometry-check", workspace: "part", severity: "warning",
      title: "Solid body has geometry warnings",
      message: `${warned.length} of ${bodies.length} solid bod${bodies.length === 1 ? "y" : "ies"} contain degenerate triangles.`,
      recovery: "Degenerate triangles are harmless for display but can upset exchange formats and Booleans; rebuild the feature to remove them.",
      relatedIds: warned.map(({ body }) => body.id),
      evidence: summarize(warned)
    });
  } else {
    findings.push({
      id: "health:part-geometry-ok", workspace: "part", severity: "info",
      title: "Solid bodies pass the geometry check",
      message: `${bodies.length} solid bod${bodies.length === 1 ? "y is" : "ies are"} closed, manifold, consistently wound and free of self-intersection.`,
      recovery: "Re-run Inspect > Geometry check after editing.",
      relatedIds: bodies.map((body) => body.id),
      evidence: `${reports.reduce((sum, { report }) => sum + report.triangleCount, 0)} triangles checked`
    });
  }

  // Interference between solid bodies. Damaged or very large bodies are skipped; the geometry checker names them.
  const usable = reports.filter(({ report, body }) => report.closed && report.manifold && body.indices.length / 3 <= INTERFERENCE_TRIANGLE_LIMIT).map(({ body }) => body);
  const found: BodyInterference[] = [];
  for (let first = 0; first < usable.length; first += 1) {
    for (let second = first + 1; second < usable.length; second += 1) {
      const pair = cachedPair(usable[first]!, usable[second]!);
      if (pair !== null) found.push({ ...pair, ids: [usable[first]!.id, usable[second]!.id], names: [usable[first]!.name, usable[second]!.name] });
    }
  }
  if (found.length > 0) {
    findings.push({
      id: "health:part-interference", workspace: "part", severity: "warning",
      title: "Solid bodies interfere",
      message: `${found.length} pair${found.length === 1 ? "" : "s"} of solid bodies share volume.`,
      recovery: "Open Inspect > Interference to see the overlaps; move a body, or combine the pair with Join, Cut or Intersect if the overlap is intended.",
      relatedIds: [...new Set(found.flatMap((entry) => entry.ids))],
      evidence: found.slice(0, 6).map((entry) => `${entry.names[0]} ∩ ${entry.names[1]}: ${Math.round(entry.volumeMm3 * 100) / 100} mm³`).join(" | ")
    });
  }
  return findings;
}
