import type {
  DrawingAnnotation,
  DrawingChangeSet,
  DrawingDiagnostic,
  DrawingDocument,
  DrawingView,
  ViewId
} from "./types.js";

export interface DrawingInvalidationResult {
  readonly document: DrawingDocument;
  readonly invalidatedViewIds: readonly ViewId[];
  readonly invalidatedAnnotationIds: readonly string[];
  readonly diagnostics: readonly DrawingDiagnostic[];
}

export function invalidateDrawing(document: DrawingDocument, changes: DrawingChangeSet): DrawingInvalidationResult {
  if (changes.fromModelRevision !== document.modelRevision || changes.toModelRevision <= changes.fromModelRevision) {
    const diagnostic: DrawingDiagnostic = {
      code: "STALE_MODEL_REVISION",
      severity: "error",
      message: `Drawing revision ${document.modelRevision} cannot consume model change ${changes.fromModelRevision} -> ${changes.toModelRevision}.`,
      relatedIds: [document.id],
      recovery: "Reload the current model and regenerate the drawing from its recorded source revision."
    };
    return { document, invalidatedViewIds: [], invalidatedAnnotationIds: [], diagnostics: [diagnostic] };
  }

  const changedEntities = new Set<string>(changes.changedEntityIds);
  const changedTopology = new Set(changes.changedTopologyKeys);
  const directlyInvalid = new Set<ViewId>();
  for (const view of Object.values(document.views)) {
    if (view.sourceEntityIds.some((id) => changedEntities.has(id))
      || view.sourceTopologyKeys.some((key) => changedTopology.has(key))) directlyInvalid.add(view.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const view of Object.values(document.views)) {
      if (view.parentViewId !== undefined && directlyInvalid.has(view.parentViewId) && !directlyInvalid.has(view.id)) {
        directlyInvalid.add(view.id);
        grew = true;
      }
    }
  }

  const views: Record<ViewId, DrawingView> = { ...document.views };
  for (const id of directlyInvalid) {
    const view = views[id];
    if (view === undefined) continue;
    views[id] = {
      ...view,
      state: "stale",
      sourceModelRevision: changes.toModelRevision,
      diagnostics: [...view.diagnostics, staleDiagnostic(id)]
    };
  }

  const invalidatedAnnotations: string[] = [];
  const annotations = { ...document.annotations };
  for (const annotation of Object.values(document.annotations)) {
    if (!annotationDependsOnViews(annotation, directlyInvalid)) continue;
    invalidatedAnnotations.push(annotation.id);
    annotations[annotation.id] = {
      ...annotation,
      state: "stale",
      diagnostics: [...annotation.diagnostics, {
        code: "ANNOTATION_UNRESOLVED",
        severity: "warning",
        message: `Annotation '${annotation.id}' depends on a stale drawing view.`,
        relatedIds: [annotation.id],
        recovery: "Regenerate the source view, then re-resolve its stable geometry associations."
      }]
    };
  }

  return {
    document: {
      ...document,
      modelRevision: changes.toModelRevision,
      views,
      annotations,
      revision: document.revision + 1
    },
    invalidatedViewIds: [...directlyInvalid].sort(),
    invalidatedAnnotationIds: invalidatedAnnotations.sort(),
    diagnostics: []
  };
}

function annotationDependsOnViews(annotation: DrawingAnnotation, invalid: ReadonlySet<ViewId>): boolean {
  if (annotation.value.kind === "parts-list") return false;
  return annotation.value.associations.some((association) => invalid.has(association.viewId));
}

function staleDiagnostic(id: ViewId): DrawingDiagnostic {
  return {
    code: "STALE_MODEL_REVISION",
    severity: "warning",
    message: `View '${id}' must be regenerated from the new model revision.`,
    relatedIds: [id],
    recovery: "Run the qualified projection backend and update dependent annotations."
  };
}
