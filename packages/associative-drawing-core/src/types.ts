import type { StableTopologyReference, Vector3 } from "../../exact-kernel-api/src/index.js";

export type DrawingId = `drawing:${string}`;
export type SheetId = `sheet:${string}`;
export type ViewId = `view:${string}`;
export type AnnotationId = `annotation:${string}`;
export type ModelEntityId = `${string}:${string}`;
export type ProjectionStandard = "first-angle" | "third-angle";
export type DrawingViewKind = "base" | "projected" | "section" | "detail" | "auxiliary";
export type DrawingViewState = "current" | "stale" | "failed" | "unresolved";

export interface Point2 {
  readonly xMeters: number;
  readonly yMeters: number;
}

export interface DrawingDocument {
  readonly schemaVersion: 1;
  readonly id: DrawingId;
  readonly name: string;
  readonly modelDocumentId: string;
  readonly modelRevision: number;
  readonly standard: "iso" | "asme";
  readonly projection: ProjectionStandard;
  readonly sheets: Readonly<Record<SheetId, DrawingSheet>>;
  readonly views: Readonly<Record<ViewId, DrawingView>>;
  readonly annotations: Readonly<Record<AnnotationId, DrawingAnnotation>>;
  readonly revision: number;
}

export interface DrawingSheet {
  readonly id: SheetId;
  readonly name: string;
  readonly widthMeters: number;
  readonly heightMeters: number;
  readonly viewIds: readonly ViewId[];
  readonly annotationIds: readonly AnnotationId[];
}

export interface ViewCamera {
  readonly direction: Vector3;
  readonly up: Vector3;
  readonly targetMeters: Vector3;
}

export interface SectionDefinition {
  readonly cuttingLine: readonly Point2[];
  readonly depth: "full" | "half" | "offset" | number;
  readonly label: string;
}

export interface DetailDefinition {
  readonly center: Point2;
  readonly radiusMeters: number;
  readonly label: string;
}

export interface DrawingView {
  readonly id: ViewId;
  readonly sheetId: SheetId;
  readonly kind: DrawingViewKind;
  readonly parentViewId?: ViewId;
  readonly sourceEntityIds: readonly ModelEntityId[];
  readonly sourceTopologyKeys: readonly string[];
  readonly camera: ViewCamera;
  readonly position: Point2;
  readonly scale: number;
  readonly hiddenLines: "visible" | "removed";
  readonly tangentEdges: "full" | "foreshortened" | "off";
  readonly section?: SectionDefinition;
  readonly detail?: DetailDefinition;
  readonly state: DrawingViewState;
  readonly sourceModelRevision: number;
  readonly projectedGeometryDigest?: string;
  readonly diagnostics: readonly DrawingDiagnostic[];
}

export interface GeometryAssociation {
  readonly viewId: ViewId;
  readonly modelEntityId: ModelEntityId;
  readonly topology?: StableTopologyReference;
  readonly projectedEntityIds: readonly string[];
}

export type DimensionMethod = "single" | "baseline" | "chain" | "ordinate";

export interface DrawingDimension {
  readonly kind: "dimension";
  readonly dimensionType: "linear" | "angular" | "radius" | "diameter";
  readonly method: DimensionMethod;
  readonly associations: readonly GeometryAssociation[];
  readonly nominalValue: number;
  readonly tolerance?: { readonly upper: number; readonly lower: number };
  readonly overrideText?: string;
}

export interface DrawingSymbol {
  readonly kind: "centerline" | "centermark" | "hole-note" | "thread-note" | "datum" | "gdt" | "balloon";
  readonly associations: readonly GeometryAssociation[];
  readonly text: string;
  readonly datumLabel?: string;
  readonly featureControlFrame?: readonly string[];
  readonly itemNumber?: string;
}

export interface PartsListAnnotation {
  readonly kind: "parts-list";
  readonly assemblyEntityId: ModelEntityId;
  readonly columns: readonly ("item" | "part-number" | "description" | "quantity" | "material")[];
  readonly rowDigest: string;
}

export interface DrawingAnnotation {
  readonly id: AnnotationId;
  readonly sheetId: SheetId;
  readonly value: DrawingDimension | DrawingSymbol | PartsListAnnotation;
  readonly position: Point2;
  readonly state: "current" | "stale" | "unresolved";
  readonly diagnostics: readonly DrawingDiagnostic[];
}

export type DrawingDiagnosticCode =
  | "INVALID_DRAWING"
  | "MISSING_PARENT_VIEW"
  | "STALE_MODEL_REVISION"
  | "TOPOLOGY_UNRESOLVED"
  | "PROJECTION_FAILED"
  | "ANNOTATION_UNRESOLVED";

export interface DrawingDiagnostic {
  readonly code: DrawingDiagnosticCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export interface DrawingChangeSet {
  readonly fromModelRevision: number;
  readonly toModelRevision: number;
  readonly changedEntityIds: readonly ModelEntityId[];
  readonly changedTopologyKeys: readonly string[];
}
