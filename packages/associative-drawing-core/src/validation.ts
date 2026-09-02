import type { DrawingDiagnostic, DrawingDocument } from "./types.js";

export function validateDrawing(document: DrawingDocument): readonly DrawingDiagnostic[] {
  const diagnostics: DrawingDiagnostic[] = [];
  if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.modelRevision) || document.modelRevision < 0) {
    diagnostics.push(invalid(document.id, "Drawing schema or model revision is invalid."));
  }
  for (const sheet of Object.values(document.sheets)) {
    if (!(sheet.widthMeters > 0) || !(sheet.heightMeters > 0)) diagnostics.push(invalid(sheet.id, "Sheet dimensions must be positive."));
    for (const viewId of sheet.viewIds) if (document.views[viewId] === undefined) diagnostics.push(invalid(sheet.id, `Sheet references missing view '${viewId}'.`));
    for (const annotationId of sheet.annotationIds) if (document.annotations[annotationId] === undefined) diagnostics.push(invalid(sheet.id, `Sheet references missing annotation '${annotationId}'.`));
  }
  for (const view of Object.values(document.views)) {
    if (document.sheets[view.sheetId] === undefined) diagnostics.push(invalid(view.id, `View references missing sheet '${view.sheetId}'.`));
    if (!(view.scale > 0) || !Number.isFinite(view.scale)) diagnostics.push(invalid(view.id, "View scale must be positive and finite."));
    if (view.kind !== "base" && view.parentViewId === undefined) diagnostics.push({
      code: "MISSING_PARENT_VIEW", severity: "error", message: `View '${view.id}' requires a parent view.`, relatedIds: [view.id], recovery: "Choose an existing source view."
    });
    if (view.parentViewId !== undefined && document.views[view.parentViewId] === undefined) diagnostics.push({
      code: "MISSING_PARENT_VIEW", severity: "error", message: `View '${view.id}' references missing parent '${view.parentViewId}'.`, relatedIds: [view.id], recovery: "Restore or replace the parent view."
    });
  }
  return diagnostics;
}

function invalid(id: string, message: string): DrawingDiagnostic {
  return { code: "INVALID_DRAWING", severity: "error", message, relatedIds: [id], recovery: "Correct the drawing record before projection or release." };
}
