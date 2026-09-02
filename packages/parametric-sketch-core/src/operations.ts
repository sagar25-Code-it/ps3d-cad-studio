import { analyticSketchSolver } from "./solver.js";
import { validateParametricSketch } from "./validation.js";
import type {
  CircleGeometry,
  DragSolveSession,
  LineGeometry,
  ParametricSketchDocument,
  ParametricSketchSolver,
  SketchDiagnostic,
  SketchEditRequest,
  SketchEditResult,
  SketchGeometry,
  Vec2
} from "./types.js";

/**
 * Executes the exact local edit operations currently qualified by this package.
 * Trim, extend, and B-rep projection remain preserved request contracts and
 * return truthful unsupported diagnostics until a topology backend is present.
 */
export function executeSketchEdit(document: ParametricSketchDocument, request: SketchEditRequest): SketchEditResult {
  const validation = validateParametricSketch(document);
  if (!validation.valid) {
    return { status: "rejected", document, createdEntityIds: [], diagnostics: validation.diagnostics };
  }
  if (request.kind !== "offset") {
    return unsupportedEdit(document, request.requestId, request.kind === "project"
      ? "Associative projection requires a topology resolver supplied by the CAD document/kernel layer."
      : `${request.kind[0]!.toUpperCase()}${request.kind.slice(1)} requires intersection classification that this analytic package does not claim.`);
  }
  if (!Number.isFinite(request.distanceMm) || request.distanceMm <= 0) {
    return rejectedEdit(document, request.requestId, "Offset distance must be a finite positive number.");
  }
  if (request.associative) {
    return unsupportedEdit(
      document,
      request.requestId,
      "Associative offset requires a persistent dependency entity and recompute support; this analytic package does not silently create a detached copy."
    );
  }
  if (request.entityIds.length !== request.resultEntityIds.length || request.entityIds.length === 0) {
    return rejectedEdit(document, request.requestId, "Offset needs one unique result ID for every source entity.");
  }
  if (request.resultEntityIds.some((id) => id.trim().length === 0)) {
    return rejectedEdit(document, request.requestId, "Offset result IDs must be non-empty stable identifiers.");
  }
  const existingIds = new Set(document.geometry.map((geometry) => geometry.id));
  if (new Set(request.resultEntityIds).size !== request.resultEntityIds.length || request.resultEntityIds.some((id) => existingIds.has(id))) {
    return rejectedEdit(document, request.requestId, "Every offset result ID must be unique and unused.");
  }

  const created: SketchGeometry[] = [];
  for (let index = 0; index < request.entityIds.length; index += 1) {
    const source = document.geometry.find((geometry) => geometry.id === request.entityIds[index]);
    const resultId = request.resultEntityIds[index]!;
    if (source?.kind === "line") created.push(offsetLine(source, resultId, request.distanceMm, request.side));
    else if (source?.kind === "circle") {
      const radiusMm = source.radiusMm + (request.side === "left" ? request.distanceMm : -request.distanceMm);
      if (radiusMm <= 1e-9) return rejectedEdit(document, request.requestId, `Offset would collapse circle '${source.id}'.`);
      const { source: _projectedSource, ...localCircle } = source;
      created.push({ ...localCircle, id: resultId, radiusMm } as CircleGeometry);
    } else {
      return unsupportedEdit(document, request.requestId, `Exact offset currently supports independent lines and circles; '${source?.kind ?? "missing"}' is not guessed.`);
    }
  }
  const next: ParametricSketchDocument = { ...document, revision: document.revision + 1, geometry: [...document.geometry, ...created] };
  return { status: "applied", document: next, createdEntityIds: created.map((geometry) => geometry.id), diagnostics: [] };
}

export function beginDragSolveSession(
  document: ParametricSketchDocument,
  target: DragSolveSession["target"],
  sessionId: string,
  solver: ParametricSketchSolver = analyticSketchSolver
): DragSolveSession {
  const latestResult = solver.solve({ document, mode: "validate" });
  return { id: sessionId, target, baseRevision: document.revision, updateSequence: 0, state: "active", baseDocument: document, latestResult };
}

export function updateDragSolveSession(
  session: DragSolveSession,
  positionMm: Vec2,
  solver: ParametricSketchSolver = analyticSketchSolver
): DragSolveSession {
  if (session.state !== "active") return session;
  const latestResult = solver.solve({ document: session.latestResult.document, mode: "drag", dragTarget: { reference: session.target, positionMm } });
  return { ...session, updateSequence: session.updateSequence + 1, latestResult };
}

export function commitDragSolveSession(
  session: DragSolveSession,
  solver: ParametricSketchSolver = analyticSketchSolver
): DragSolveSession {
  if (session.state !== "active" || session.latestResult.status === "failed") return session;
  const changed = !documentsEqualIgnoringRevision(session.latestResult.document, session.baseDocument);
  const candidate: ParametricSketchDocument = {
    ...session.latestResult.document,
    revision: changed ? session.baseRevision + 1 : session.baseRevision
  };
  const verified = solver.solve({ document: candidate, mode: "validate" });
  return verified.status === "failed"
    ? { ...session, latestResult: verified }
    : { ...session, state: "committed", latestResult: verified };
}

export function cancelDragSolveSession(session: DragSolveSession, solver: ParametricSketchSolver = analyticSketchSolver): DragSolveSession {
  if (session.state !== "active") return session;
  return { ...session, state: "cancelled", latestResult: solver.solve({ document: session.baseDocument, mode: "validate" }) };
}

function offsetLine(source: LineGeometry, id: string, distanceMm: number, side: "left" | "right"): LineGeometry {
  const dx = source.end[0] - source.start[0];
  const dy = source.end[1] - source.start[1];
  const length = Math.hypot(dx, dy);
  const sign = side === "left" ? 1 : -1;
  const offset: Vec2 = [-dy / length * distanceMm * sign, dx / length * distanceMm * sign];
  const { source: _projectedSource, ...localLine } = source;
  return {
    ...localLine,
    id,
    start: [source.start[0] + offset[0], source.start[1] + offset[1]],
    end: [source.end[0] + offset[0], source.end[1] + offset[1]]
  };
}

function documentsEqualIgnoringRevision(left: ParametricSketchDocument, right: ParametricSketchDocument): boolean {
  return canonicalJson({ ...left, revision: 0 }) === canonicalJson({ ...right, revision: 0 });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function unsupportedEdit(document: ParametricSketchDocument, requestId: string, message: string): SketchEditResult {
  return { status: "unsupported", document, createdEntityIds: [], diagnostics: [editDiagnostic("UNSUPPORTED_OPERATION", message, requestId, true)] };
}

function rejectedEdit(document: ParametricSketchDocument, requestId: string, message: string): SketchEditResult {
  return { status: "rejected", document, createdEntityIds: [], diagnostics: [editDiagnostic("DEGENERATE_GEOMETRY", message, requestId, false)] };
}

function editDiagnostic(code: SketchDiagnostic["code"], message: string, requestId: string, unsupported: boolean): SketchDiagnostic {
  return {
    code,
    severity: unsupported ? "warning" : "error",
    message,
    relatedIds: [requestId],
    recovery: unsupported ? "Delegate the preserved request to a geometry/topology backend that declares this capability." : "Correct the operation inputs and retry.",
    unsupported
  };
}
