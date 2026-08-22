import type {
  DrawingDatumScheme,
  DrawingDisplayStyle,
  DrawingDraftingStandard,
  DrawingSettings,
  DrawingViewPreset,
  PartIntent
} from "../../workbench-core/src/index.js";

export type DrawingViewId = "front" | "top" | "right" | "section-a" | "isometric";
export type DrawingViewRole = "base" | "projected" | "section" | "pictorial";
export type DrawingDimensionKind = "linear" | "diameter" | "basic";
export type GdtCharacteristic = "position" | "flatness" | "perpendicularity";

export interface DrawingViewRecord {
  readonly id: DrawingViewId;
  readonly label: string;
  readonly kind: "orthographic" | "section" | "pictorial";
  readonly role: DrawingViewRole;
  readonly parentId?: DrawingViewId;
  readonly alignment: "horizontal" | "vertical" | "free";
  readonly sourceIds: readonly string[];
}

export interface DrawingDimensionRecord {
  readonly id: string;
  readonly kind: DrawingDimensionKind;
  readonly label: string;
  readonly nominalMm: number;
  readonly toleranceSource: "general" | "basic";
  readonly sourceId: string;
  readonly viewId: DrawingViewId;
}

export interface DrawingGdtFrameRecord {
  readonly id: string;
  readonly characteristic: GdtCharacteristic;
  readonly toleranceMm: number;
  readonly diameterZone: boolean;
  readonly datumReferences: readonly ("A" | "B" | "C")[];
  readonly sourceId: string;
  readonly valueSource: "explicit-drawing-specification";
}

export interface DrawingDatumRecord {
  readonly id: string;
  readonly label: "A" | "B" | "C";
  readonly sourceId: string;
  readonly description: string;
}

export interface DrawingGenerationPlan {
  readonly viewPreset: DrawingViewPreset;
  readonly draftingStandard: DrawingDraftingStandard;
  readonly displayStyle: DrawingDisplayStyle;
  readonly sectionViewEnabled: boolean;
  readonly datumScheme: DrawingDatumScheme;
  readonly views: readonly DrawingViewRecord[];
  readonly dimensions: readonly DrawingDimensionRecord[];
  readonly gdtFrames: readonly DrawingGdtFrameRecord[];
  readonly datums: readonly DrawingDatumRecord[];
  readonly generalTolerance: {
    readonly linearMm: number;
    readonly angularDeg: number;
    readonly source: "user-defined-general";
  };
}

export interface DrawingArtifact extends DrawingGenerationPlan {
  readonly svg: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly viewCount: number;
  readonly dimensionCount: number;
  readonly gdtFrameCount: number;
  readonly datumCount: number;
  readonly effectiveScale: number;
  readonly fitAdjusted: boolean;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface DrawingGeometry {
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
  readonly radius: number;
}

interface NormalizedDrawingSettings {
  readonly viewPreset: DrawingViewPreset;
  readonly displayStyle: DrawingDisplayStyle;
  readonly showSectionView: boolean;
  readonly draftingStandard: DrawingDraftingStandard;
  readonly showGdt: boolean;
  readonly datumScheme: DrawingDatumScheme;
  readonly positionToleranceMm: number;
  readonly flatnessToleranceMm: number;
  readonly perpendicularityToleranceMm: number;
  readonly linearToleranceMm: number;
  readonly angularToleranceDeg: number;
}

const VIEW_RECORDS: Readonly<Record<DrawingViewId, DrawingViewRecord>> = {
  front: { id: "front", label: "FRONT · BASE", kind: "orthographic", role: "base", alignment: "free", sourceIds: ["part:mounting-plate", "feature:centered-bore"] },
  top: { id: "top", label: "TOP · PROJECTED", kind: "orthographic", role: "projected", parentId: "front", alignment: "vertical", sourceIds: ["part:mounting-plate", "feature:centered-bore"] },
  right: { id: "right", label: "RIGHT · PROJECTED", kind: "orthographic", role: "projected", parentId: "front", alignment: "horizontal", sourceIds: ["part:mounting-plate", "feature:centered-bore"] },
  "section-a": { id: "section-a", label: "SECTION A–A", kind: "section", role: "section", parentId: "front", alignment: "vertical", sourceIds: ["part:mounting-plate", "feature:centered-bore"] },
  isometric: { id: "isometric", label: "ISOMETRIC · REFERENCE", kind: "pictorial", role: "pictorial", alignment: "free", sourceIds: ["part:mounting-plate"] }
};

export function createAutomaticDrawingPlan(part: PartIntent, settings: DrawingSettings): DrawingGenerationPlan {
  const normalized = normalizeSettings(settings);
  const baseViewIds: DrawingViewId[] = normalized.viewPreset === "front-only"
    ? ["front"]
    : normalized.viewPreset === "orthographic-3-view"
      ? ["front", "top", "right"]
      : ["front", "top", "right", "isometric"];
  if (normalized.showSectionView && normalized.viewPreset !== "front-only") baseViewIds.push("section-a");
  const views = baseViewIds.map((id) => VIEW_RECORDS[id]);
  const hasTop = baseViewIds.includes("top");
  const hasDatumFrame = normalized.showGdt && normalized.datumScheme === "plate-3-2-1" && hasTop;
  const dimensions: DrawingDimensionRecord[] = [];
  if (settings.showDimensions) {
    dimensions.push(
      dimension("dimension:overall-width", "linear", part.widthMm, "general", "part:mounting-plate", "front"),
      dimension("dimension:overall-height", "linear", part.heightMm, "general", "part:mounting-plate", "front"),
      dimension("dimension:centered-bore-diameter", "diameter", part.holeDiameterMm, "general", "feature:centered-bore", "front")
    );
    if (hasTop) dimensions.push(dimension("dimension:thickness", "linear", part.thicknessMm, "general", "feature:base-extrusion", "top"));
    if (hasDatumFrame) {
      dimensions.push(
        dimension("dimension:bore-center-x", "basic", part.widthMm / 2, "basic", "feature:centered-bore", "front"),
        dimension("dimension:bore-center-y", "basic", part.heightMm / 2, "basic", "feature:centered-bore", "front")
      );
    }
  }

  const datums: DrawingDatumRecord[] = hasDatumFrame ? [
    { id: "datum:A", label: "A", sourceId: "face:primary-plane", description: "Primary broad planar face" },
    { id: "datum:B", label: "B", sourceId: "face:left-side", description: "Secondary width-side plane" },
    { id: "datum:C", label: "C", sourceId: "face:bottom-side", description: "Tertiary height-side plane" }
  ] : [];
  const gdtFrames: DrawingGdtFrameRecord[] = normalized.showGdt ? [
    gdtFrame("gdt:flatness-primary-face", "flatness", normalized.flatnessToleranceMm, false, [], "face:primary-plane"),
    ...(hasDatumFrame ? [
      gdtFrame("gdt:perpendicularity-width-side", "perpendicularity", normalized.perpendicularityToleranceMm, false, ["A"], "face:left-side"),
      gdtFrame("gdt:position-centered-bore", "position", normalized.positionToleranceMm, true, ["A", "B", "C"], "feature:centered-bore")
    ] : [])
  ] : [];

  return {
    viewPreset: normalized.viewPreset,
    draftingStandard: normalized.draftingStandard,
    displayStyle: normalized.displayStyle,
    sectionViewEnabled: baseViewIds.includes("section-a"),
    datumScheme: hasDatumFrame ? "plate-3-2-1" : "none",
    views,
    dimensions,
    gdtFrames,
    datums,
    generalTolerance: { linearMm: normalized.linearToleranceMm, angularDeg: normalized.angularToleranceDeg, source: "user-defined-general" }
  };
}

export function createDrawingSvg(part: PartIntent, settings: DrawingSettings): DrawingArtifact {
  const plan = createAutomaticDrawingPlan(part, settings);
  const [sheetWidth, sheetHeight] = settings.sheet === "A3" ? [420, 297] : [297, 210];
  const frame = 9;
  const titleWidth = settings.sheet === "A3" ? 166 : 142;
  const titleHeight = settings.sheet === "A3" ? 54 : 52;
  const availableWidth = sheetWidth - frame * 2;
  const availableHeight = sheetHeight - frame * 2 - titleHeight;
  const requestedFactor = 1 / settings.scale;
  const horizontalDemand = plan.viewPreset === "front-only" ? part.widthMm * 1.55 : part.widthMm * 3.4 + part.thicknessMm;
  const verticalDemand = plan.viewPreset === "front-only" ? part.heightMm * 1.65 : part.heightMm * 3.55 + part.thicknessMm;
  const fitFactor = Math.min(availableWidth / horizontalDemand, availableHeight / verticalDemand);
  const factor = Math.max(0.01, Math.min(requestedFactor, fitFactor));
  const effectiveScale = 1 / factor;
  const fitAdjusted = factor < requestedFactor - 1e-9;
  const geometry: DrawingGeometry = {
    width: part.widthMm * factor,
    height: part.heightMm * factor,
    thickness: Math.max(part.thicknessMm * factor, 3),
    radius: part.holeDiameterMm / 2 * factor
  };
  const positions = layoutPositions(settings, plan.viewPreset, frame, availableWidth, availableHeight);
  const viewMarkup = plan.views.map((view) => renderView(view, positions[view.id], geometry, plan.displayStyle, plan.sectionViewEnabled)).join("");
  const dimensionMarkup = renderDimensions(plan, part, factor, positions, geometry);
  const datumMarkup = renderDatums(plan, positions, geometry);
  const gdtMarkup = renderGdt(plan, positions, geometry);
  const titleX = sheetWidth - frame - titleWidth;
  const titleY = sheetHeight - frame - titleHeight;
  const scaleLabel = fitAdjusted ? `FIT 1:${formatValue(effectiveScale)}` : `1:${settings.scale}`;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}mm" height="${sheetHeight}mm" viewBox="0 0 ${sheetWidth} ${sheetHeight}" role="img" aria-labelledby="drawing-title drawing-desc" data-projection="${settings.projection}" data-standard="${plan.draftingStandard}" data-display-style="${plan.displayStyle}" data-view-preset="${plan.viewPreset}">`,
    `<title id="drawing-title">${escapeXml(settings.title)} engineering drawing preview</title>`,
    `<desc id="drawing-desc">Parent base view with aligned projections, ${plan.sectionViewEnabled ? "a full section, " : ""}${plan.dimensions.length} selective dimensions, and ${plan.gdtFrames.length} explicitly specified draft GD&amp;T frames. Not released.</desc>`,
    `<defs><marker id="arrow" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6 z" fill="#173346"/></marker><marker id="leader-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#173346"/></marker><pattern id="section-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#416171" stroke-width="0.35"/></pattern></defs>`,
    `<rect width="${sheetWidth}" height="${sheetHeight}" fill="#f9fbfc"/>`,
    `<text x="${sheetWidth / 2}" y="${sheetHeight / 2}" text-anchor="middle" transform="rotate(-24 ${sheetWidth / 2} ${sheetHeight / 2})" fill="#b24646" fill-opacity="0.075" font-family="Arial,sans-serif" font-weight="700" font-size="26">NOT RELEASED</text>`,
    `<rect x="${frame}" y="${frame}" width="${sheetWidth - frame * 2}" height="${sheetHeight - frame * 2}" fill="none" stroke="#173346" stroke-width="0.7"/>`,
    renderSheetZones(sheetWidth, sheetHeight, frame),
    `<text x="${frame + 4}" y="${frame + 7}" fill="#536a76" font-family="ui-monospace,monospace" font-size="2.7">${escapeXml(plan.draftingStandard)} DRAFTING BASIS · ${escapeXml(settings.projection.toUpperCase())} · BASE / PROJECTED / SECTION WORKFLOW</text>`,
    viewMarkup,
    dimensionMarkup,
    datumMarkup,
    gdtMarkup,
    revisionTable(titleX + titleWidth - 66, titleY - 23, 66, 20),
    titleBlock(titleX, titleY, titleWidth, titleHeight, part, settings, plan, scaleLabel),
    `<text x="${frame + 4}" y="${sheetHeight - frame - 3}" fill="#536a76" font-family="ui-monospace,monospace" font-size="2.6">PS3D ASSOCIATIVE DRAFT PREVIEW · VERIFY DESIGN INTENT, MATERIAL, PROCESS, INSPECTION, AND RELEASE AUTHORITY</text>`,
    `</svg>`
  ].join("");

  return {
    ...plan,
    svg,
    widthMm: sheetWidth,
    heightMm: sheetHeight,
    viewCount: plan.views.length,
    dimensionCount: plan.dimensions.length,
    gdtFrameCount: plan.gdtFrames.length,
    datumCount: plan.datums.length,
    effectiveScale,
    fitAdjusted
  };
}

function normalizeSettings(settings: DrawingSettings): NormalizedDrawingSettings {
  return {
    viewPreset: settings.viewPreset ?? "automatic-4-view",
    displayStyle: settings.displayStyle ?? "visible-hidden-edges",
    showSectionView: settings.showSectionView ?? false,
    draftingStandard: settings.draftingStandard ?? "ASME",
    showGdt: settings.showGdt ?? false,
    datumScheme: settings.datumScheme ?? "none",
    positionToleranceMm: bounded(settings.gdtPositionToleranceMm, 0.001, 10, 0.2),
    flatnessToleranceMm: bounded(settings.gdtFlatnessToleranceMm, 0.001, 10, 0.1),
    perpendicularityToleranceMm: bounded(settings.gdtPerpendicularityToleranceMm, 0.001, 10, 0.1),
    linearToleranceMm: bounded(settings.generalToleranceLinearMm, 0.001, 10, 0.2),
    angularToleranceDeg: bounded(settings.generalToleranceAngularDeg, 0.01, 10, 0.5)
  };
}

function dimension(id: string, kind: DrawingDimensionKind, nominalMm: number, toleranceSource: "general" | "basic", sourceId: string, viewId: DrawingViewId): DrawingDimensionRecord {
  const label = kind === "diameter" ? `⌀${formatValue(nominalMm)} THRU` : formatValue(nominalMm);
  return { id, kind, nominalMm, label, toleranceSource, sourceId, viewId };
}

function gdtFrame(id: string, characteristic: GdtCharacteristic, toleranceMm: number, diameterZone: boolean, datumReferences: readonly ("A" | "B" | "C")[], sourceId: string): DrawingGdtFrameRecord {
  return { id, characteristic, toleranceMm, diameterZone, datumReferences, sourceId, valueSource: "explicit-drawing-specification" };
}

function layoutPositions(settings: DrawingSettings, preset: DrawingViewPreset, frame: number, width: number, height: number): Record<DrawingViewId, Point> {
  if (preset === "front-only") {
    const center = { x: frame + width * 0.43, y: frame + height * 0.48 };
    return { front: center, top: center, right: center, "section-a": center, isometric: center };
  }
  if (settings.projection === "first-angle") {
    return {
      front: { x: frame + width * 0.46, y: frame + height * 0.34 },
      top: { x: frame + width * 0.46, y: frame + height * 0.73 },
      right: { x: frame + width * 0.20, y: frame + height * 0.34 },
      isometric: { x: frame + width * 0.79, y: frame + height * 0.25 },
      "section-a": { x: frame + width * 0.78, y: frame + height * 0.72 }
    };
  }
  return {
    front: { x: frame + width * 0.31, y: frame + height * 0.58 },
    top: { x: frame + width * 0.31, y: frame + height * 0.23 },
    right: { x: frame + width * 0.56, y: frame + height * 0.58 },
    isometric: { x: frame + width * 0.79, y: frame + height * 0.23 },
    "section-a": { x: frame + width * 0.77, y: frame + height * 0.73 }
  };
}

function renderView(view: DrawingViewRecord, center: Point, geometry: DrawingGeometry, style: DrawingDisplayStyle, showSection: boolean): string {
  const { width, height, thickness, radius } = geometry;
  const attributes = `class="drawing-view ${view.id}" data-view-id="${view.id}" data-view-role="${view.role}" data-alignment="${view.alignment}" data-center-x="${n(center.x)}" data-center-y="${n(center.y)}"${view.parentId === undefined ? "" : ` data-parent-view="${view.parentId}"`}`;
  if (view.id === "front") {
    const sectionLine = showSection ? cuttingPlane(center, width) : "";
    return `<g ${attributes} data-source-id="part:mounting-plate">${groupLabel(view.label, center.x, center.y - height / 2 - 8)}<g fill="none" stroke="#173346" stroke-width="0.7"><rect x="${n(center.x - width / 2)}" y="${n(center.y - height / 2)}" width="${n(width)}" height="${n(height)}"/><circle cx="${n(center.x)}" cy="${n(center.y)}" r="${n(radius)}"/>${centerMark(center.x, center.y, Math.max(radius + 5, 8))}</g>${sectionLine}</g>`;
  }
  if (view.id === "top") {
    const hidden = style === "visible-hidden-edges" ? `<path class="hidden-edge" d="M${n(center.x - radius)} ${n(center.y - thickness / 2)}V${n(center.y + thickness / 2)}M${n(center.x + radius)} ${n(center.y - thickness / 2)}V${n(center.y + thickness / 2)}" stroke-dasharray="2 1.5" stroke-width="0.35"/>` : "";
    return `<g ${attributes} data-source-id="feature:base-extrusion">${groupLabel(view.label, center.x, center.y - thickness / 2 - 8)}<g fill="none" stroke="#173346" stroke-width="0.7"><rect x="${n(center.x - width / 2)}" y="${n(center.y - thickness / 2)}" width="${n(width)}" height="${n(thickness)}"/>${hidden}<path class="center-line" d="M${n(center.x)} ${n(center.y - thickness / 2 - 4)}V${n(center.y + thickness / 2 + 4)}" stroke-dasharray="5 1 1 1" stroke-width="0.32"/></g></g>`;
  }
  if (view.id === "right") {
    const hidden = style === "visible-hidden-edges" ? `<path class="hidden-edge" d="M${n(center.x - thickness / 2)} ${n(center.y - radius)}H${n(center.x + thickness / 2)}M${n(center.x - thickness / 2)} ${n(center.y + radius)}H${n(center.x + thickness / 2)}" stroke-dasharray="2 1.5" stroke-width="0.35"/>` : "";
    return `<g ${attributes} data-source-id="feature:base-extrusion">${groupLabel(view.label, center.x, center.y - height / 2 - 8)}<g fill="none" stroke="#173346" stroke-width="0.7"><rect x="${n(center.x - thickness / 2)}" y="${n(center.y - height / 2)}" width="${n(thickness)}" height="${n(height)}"/>${hidden}<path class="center-line" d="M${n(center.x - thickness / 2 - 4)} ${n(center.y)}H${n(center.x + thickness / 2 + 4)}" stroke-dasharray="5 1 1 1" stroke-width="0.32"/></g></g>`;
  }
  if (view.id === "section-a") {
    const leftWidth = Math.max(0, width / 2 - radius);
    return `<g ${attributes} data-source-id="feature:centered-bore">${groupLabel(view.label, center.x, center.y - thickness / 2 - 8)}<g stroke="#173346" stroke-width="0.7"><rect x="${n(center.x - width / 2)}" y="${n(center.y - thickness / 2)}" width="${n(leftWidth)}" height="${n(thickness)}" fill="url(#section-hatch)"/><rect x="${n(center.x + radius)}" y="${n(center.y - thickness / 2)}" width="${n(leftWidth)}" height="${n(thickness)}" fill="url(#section-hatch)"/><path d="M${n(center.x)} ${n(center.y - thickness / 2 - 5)}V${n(center.y + thickness / 2 + 5)}" fill="none" stroke-dasharray="5 1 1 1" stroke-width="0.32"/></g><text x="${n(center.x)}" y="${n(center.y + thickness / 2 + 8)}" text-anchor="middle" fill="#536a76" font-family="ui-monospace,monospace" font-size="2.5">FULL SECTION · MODEL LINKED</text></g>`;
  }
  return `<g ${attributes} data-source-id="part:mounting-plate">${groupLabel(view.label, center.x, center.y - height * 0.36 - 12)}${isometricPlate(center.x, center.y, width * 0.62, height * 0.62, thickness, radius * 0.62)}</g>`;
}

function cuttingPlane(center: Point, width: number): string {
  const left = center.x - width / 2 - 8;
  const right = center.x + width / 2 + 8;
  return `<g class="cutting-plane" data-section-view="section-a" fill="#173346" stroke="#173346"><path d="M${n(left)} ${n(center.y)}H${n(right)}" fill="none" stroke-width="0.45" stroke-dasharray="8 2 1 2"/><path d="M${n(left)} ${n(center.y)}l5 -2.2v4.4zM${n(right)} ${n(center.y)}l-5 -2.2v4.4z"/><text x="${n(left - 2)}" y="${n(center.y - 3.5)}" text-anchor="middle" stroke="none" font-family="ui-monospace,monospace" font-size="3.5">A</text><text x="${n(right + 2)}" y="${n(center.y - 3.5)}" text-anchor="middle" stroke="none" font-family="ui-monospace,monospace" font-size="3.5">A</text></g>`;
}

function renderDimensions(plan: DrawingGenerationPlan, part: PartIntent, factor: number, positions: Record<DrawingViewId, Point>, geometry: DrawingGeometry): string {
  const markup: string[] = [];
  const front = positions.front;
  const top = positions.top;
  const byId = new Map(plan.dimensions.map((record) => [record.id, record]));
  const widthDimension = byId.get("dimension:overall-width");
  if (widthDimension !== undefined) markup.push(horizontalDimension(widthDimension, front.x - geometry.width / 2, front.x + geometry.width / 2, front.y + geometry.height / 2, front.y + geometry.height / 2 + 12));
  const heightDimension = byId.get("dimension:overall-height");
  if (heightDimension !== undefined) markup.push(verticalDimension(heightDimension, front.y - geometry.height / 2, front.y + geometry.height / 2, front.x - geometry.width / 2, front.x - geometry.width / 2 - 12));
  const thicknessDimension = byId.get("dimension:thickness");
  if (thicknessDimension !== undefined) markup.push(verticalDimension(thicknessDimension, top.y - geometry.thickness / 2, top.y + geometry.thickness / 2, top.x + geometry.width / 2, top.x + geometry.width / 2 + 10));
  const diameter = byId.get("dimension:centered-bore-diameter");
  if (diameter !== undefined) {
    const radius = part.holeDiameterMm / 2 * factor;
    markup.push(`<g class="drawing-dimension diameter" data-dimension-id="${diameter.id}" data-view-id="front" data-tolerance-source="general" fill="#173346" font-family="ui-monospace,monospace" font-size="3"><path d="M${n(front.x + radius * 0.7)} ${n(front.y - radius * 0.7)}L${n(front.x + geometry.width / 2 + 17)} ${n(front.y - geometry.height / 2 + 7)}" fill="none" stroke="#173346" stroke-width="0.4" marker-start="url(#leader-arrow)"/><text x="${n(front.x + geometry.width / 2 + 19)}" y="${n(front.y - geometry.height / 2 + 7)}">${escapeXml(diameter.label)}</text></g>`);
  }
  const centerX = byId.get("dimension:bore-center-x");
  if (centerX !== undefined) markup.push(horizontalDimension(centerX, front.x - geometry.width / 2, front.x, front.y - geometry.height / 2, front.y - geometry.height / 2 - 11, true));
  const centerY = byId.get("dimension:bore-center-y");
  if (centerY !== undefined) markup.push(verticalDimension(centerY, front.y, front.y + geometry.height / 2, front.x + geometry.width / 2, front.x + geometry.width / 2 + 12, true));
  return `<g class="drawing-dimensions" data-dimension-strategy="selective-model-derived">${markup.join("")}</g>`;
}

function horizontalDimension(record: DrawingDimensionRecord, x1: number, x2: number, objectY: number, dimensionY: number, basic = false): string {
  const textX = (x1 + x2) / 2;
  const textY = dimensionY - 1.7;
  const basicBox = basicBoxMarkup(record, textX, textY);
  return `<g class="drawing-dimension ${record.kind}" data-dimension-id="${record.id}" data-source-id="${record.sourceId}" data-view-id="${record.viewId}" data-tolerance-source="${record.toleranceSource}" fill="#173346" stroke="#173346" stroke-width="0.35" font-family="ui-monospace,monospace" font-size="3"><path class="extension-line" d="M${n(x1)} ${n(objectY)}V${n(dimensionY + (dimensionY > objectY ? 2 : -2))}M${n(x2)} ${n(objectY)}V${n(dimensionY + (dimensionY > objectY ? 2 : -2))}"/><path class="dimension-line" d="M${n(x1)} ${n(dimensionY)}H${n(x2)}" marker-start="url(#arrow)" marker-end="url(#arrow)"/>${basicBox}<text x="${n(textX)}" y="${n(textY)}" stroke="none" text-anchor="middle">${escapeXml(record.label)}</text></g>`;
}

function verticalDimension(record: DrawingDimensionRecord, y1: number, y2: number, objectX: number, dimensionX: number, basic = false): string {
  const textX = dimensionX + (dimensionX > objectX ? 3.8 : -3.8);
  const textY = (y1 + y2) / 2;
  const basicBox = basicBoxMarkup(record, textX, textY + 1.1);
  return `<g class="drawing-dimension ${record.kind}" data-dimension-id="${record.id}" data-source-id="${record.sourceId}" data-view-id="${record.viewId}" data-tolerance-source="${record.toleranceSource}" fill="#173346" stroke="#173346" stroke-width="0.35" font-family="ui-monospace,monospace" font-size="3"><path class="extension-line" d="M${n(objectX)} ${n(y1)}H${n(dimensionX + (dimensionX > objectX ? 2 : -2))}M${n(objectX)} ${n(y2)}H${n(dimensionX + (dimensionX > objectX ? 2 : -2))}"/><path class="dimension-line" d="M${n(dimensionX)} ${n(y1)}V${n(y2)}" marker-start="url(#arrow)" marker-end="url(#arrow)"/>${basicBox}<text x="${n(textX)}" y="${n(textY + 1.1)}" stroke="none" text-anchor="middle">${escapeXml(record.label)}</text></g>`;
}

function basicBoxMarkup(record: DrawingDimensionRecord, x: number, baselineY: number): string {
  if (record.kind !== "basic") return "";
  const width = Math.max(9, record.label.length * 2 + 3);
  return `<rect class="basic-dimension-box" x="${n(x - width / 2)}" y="${n(baselineY - 3.4)}" width="${n(width)}" height="4.7" fill="#f9fbfc" stroke="#173346" stroke-width="0.35"/>`;
}

function renderDatums(plan: DrawingGenerationPlan, positions: Record<DrawingViewId, Point>, geometry: DrawingGeometry): string {
  if (plan.datums.length === 0) return "";
  const front = positions.front;
  const top = positions.top;
  return `<g class="drawing-datums" data-datum-count="${plan.datums.length}" data-datum-scheme="${plan.datumScheme}">${datumSymbol("A", top.x + geometry.width * 0.26, top.y + geometry.thickness / 2, "down")}${datumSymbol("B", front.x - geometry.width / 2, front.y - geometry.height * 0.18, "left")}${datumSymbol("C", front.x + geometry.width * 0.20, front.y + geometry.height / 2, "down")}</g>`;
}

function datumSymbol(label: "A" | "B" | "C", x: number, y: number, direction: "down" | "left"): string {
  if (direction === "left") return `<g class="datum-symbol" data-datum="${label}" fill="#173346" stroke="#173346" stroke-width="0.4"><path d="M${n(x)} ${n(y)}l-4 -2v4z"/><path d="M${n(x - 4)} ${n(y)}h-6"/><rect x="${n(x - 17)}" y="${n(y - 3.5)}" width="7" height="7" fill="#f9fbfc"/><text x="${n(x - 13.5)}" y="${n(y + 1.5)}" text-anchor="middle" stroke="none" font-family="ui-monospace,monospace" font-size="4">${label}</text></g>`;
  return `<g class="datum-symbol" data-datum="${label}" fill="#173346" stroke="#173346" stroke-width="0.4"><path d="M${n(x)} ${n(y)}l-2 4h4z"/><path d="M${n(x)} ${n(y + 4)}v6"/><rect x="${n(x - 3.5)}" y="${n(y + 10)}" width="7" height="7" fill="#f9fbfc"/><text x="${n(x)}" y="${n(y + 15)}" text-anchor="middle" stroke="none" font-family="ui-monospace,monospace" font-size="4">${label}</text></g>`;
}

function renderGdt(plan: DrawingGenerationPlan, positions: Record<DrawingViewId, Point>, geometry: DrawingGeometry): string {
  if (plan.gdtFrames.length === 0) return "";
  const front = positions.front;
  const top = positions.top;
  const frames: string[] = [];
  for (const record of plan.gdtFrames) {
    if (record.characteristic === "position") {
      const x = front.x + geometry.width / 2 + 19;
      const y = front.y + geometry.height / 2 - 7;
      frames.push(`<g data-gdt-id="${record.id}" data-value-source="${record.valueSource}"><path d="M${n(front.x + geometry.radius * 0.7)} ${n(front.y + geometry.radius * 0.7)}L${n(x - 2)} ${n(y + 3.5)}" fill="none" stroke="#173346" stroke-width="0.4" marker-start="url(#leader-arrow)"/>${featureControlFrame(record, x, y)}</g>`);
    } else if (record.characteristic === "flatness") {
      const x = top.x - geometry.width / 2;
      const y = top.y - geometry.thickness / 2 - 20;
      frames.push(`<g data-gdt-id="${record.id}" data-value-source="${record.valueSource}"><path d="M${n(top.x - geometry.width * 0.18)} ${n(top.y - geometry.thickness / 2)}L${n(x + 8)} ${n(y + 7)}" fill="none" stroke="#173346" stroke-width="0.4"/>${featureControlFrame(record, x, y)}</g>`);
    } else {
      const x = front.x - geometry.width / 2 - 10;
      const y = front.y - geometry.height / 2 - 18;
      frames.push(`<g data-gdt-id="${record.id}" data-value-source="${record.valueSource}"><path d="M${n(front.x - geometry.width / 2)} ${n(front.y - geometry.height * 0.18)}L${n(x + 8)} ${n(y + 7)}" fill="none" stroke="#173346" stroke-width="0.4"/>${featureControlFrame(record, x, y)}</g>`);
    }
  }
  return `<g class="drawing-gdt" data-gdt-count="${plan.gdtFrames.length}" data-tolerance-source="explicit-drawing-specification">${frames.join("")}</g>`;
}

function featureControlFrame(record: DrawingGdtFrameRecord, x: number, y: number): string {
  const symbolWidth = 8;
  const toleranceText = `${record.diameterZone ? "⌀" : ""}${formatTolerance(record.toleranceMm)}`;
  const toleranceWidth = Math.max(18, toleranceText.length * 2.2);
  const datumWidth = 8;
  const totalWidth = symbolWidth + toleranceWidth + record.datumReferences.length * datumWidth;
  const separators = [symbolWidth, symbolWidth + toleranceWidth, ...record.datumReferences.slice(0, -1).map((_, index) => symbolWidth + toleranceWidth + (index + 1) * datumWidth)];
  const datumTexts = record.datumReferences.map((datum, index) => `<text x="${n(x + symbolWidth + toleranceWidth + datumWidth * (index + 0.5))}" y="${n(y + 5)}">${datum}</text>`).join("");
  return `<g class="feature-control-frame" data-characteristic="${record.characteristic}" fill="#f9fbfc" stroke="#173346" stroke-width="0.4"><rect x="${n(x)}" y="${n(y)}" width="${n(totalWidth)}" height="7"/>${separators.map((offset) => `<path d="M${n(x + offset)} ${n(y)}v7"/>`).join("")}${gdtSymbol(record.characteristic, x + symbolWidth / 2, y + 3.5)}<g fill="#173346" stroke="none" font-family="ui-monospace,monospace" font-size="3.2" text-anchor="middle"><text x="${n(x + symbolWidth + toleranceWidth / 2)}" y="${n(y + 5)}">${escapeXml(toleranceText)}</text>${datumTexts}</g></g>`;
}

function gdtSymbol(characteristic: GdtCharacteristic, x: number, y: number): string {
  if (characteristic === "position") return `<g fill="none" stroke="#173346" stroke-width="0.45"><circle cx="${n(x)}" cy="${n(y)}" r="2.1"/><path d="M${n(x - 3)} ${n(y)}h6M${n(x)} ${n(y - 3)}v6"/></g>`;
  if (characteristic === "flatness") return `<path d="M${n(x - 2.6)} ${n(y + 1.7)}h4.4l1.1-3.4h-4.4z" fill="none" stroke="#173346" stroke-width="0.55"/>`;
  return `<path d="M${n(x - 2.4)} ${n(y - 2.4)}v4.8h4.8M${n(x - 0.2)} ${n(y + 2.4)}v-2.2h2.6" fill="none" stroke="#173346" stroke-width="0.55"/>`;
}

function isometricPlate(cx: number, cy: number, width: number, height: number, thickness: number, radius: number): string {
  const x = width / 2;
  const y = height / 2;
  const dz = thickness * 0.8;
  const project = (px: number, py: number, pz: number): readonly [number, number] => [cx + (px - py) * 0.78, cy + (px + py) * 0.38 - pz];
  const top = [[-x, -y], [x, -y], [x, y], [-x, y]].map(([px, py]) => project(px!, py!, dz));
  const bottom = top.map(([px, py]) => [px, py + dz] as const);
  const path = `${polyline(top)} ${polyline(bottom)} M${n(top[1]![0])} ${n(top[1]![1])}L${n(bottom[1]![0])} ${n(bottom[1]![1])} M${n(top[2]![0])} ${n(top[2]![1])}L${n(bottom[2]![0])} ${n(bottom[2]![1])} M${n(top[3]![0])} ${n(top[3]![1])}L${n(bottom[3]![0])} ${n(bottom[3]![1])}`;
  return `<g fill="#dceef2" fill-opacity="0.42" stroke="#173346" stroke-width="0.65"><path d="${path}"/><ellipse cx="${n(cx)}" cy="${n(cy - dz)}" rx="${n(radius)}" ry="${n(radius * 0.48)}" fill="#f9fbfc"/></g>`;
}

function renderSheetZones(sheetWidth: number, sheetHeight: number, frame: number): string {
  const columns = sheetWidth > 300 ? ["A", "B", "C", "D", "E", "F"] : ["A", "B", "C", "D", "E"];
  const rows = ["1", "2", "3", "4"];
  const columnMarkup = columns.map((label, index) => {
    const x = frame + (index + 0.5) * (sheetWidth - frame * 2) / columns.length;
    return `<text x="${n(x)}" y="${n(frame - 2.3)}" text-anchor="middle">${label}</text><text x="${n(x)}" y="${n(sheetHeight - frame + 4.5)}" text-anchor="middle">${label}</text>`;
  }).join("");
  const rowMarkup = rows.map((label, index) => {
    const y = frame + (index + 0.5) * (sheetHeight - frame * 2) / rows.length;
    return `<text x="${n(frame - 3.5)}" y="${n(y + 1)}" text-anchor="middle">${label}</text><text x="${n(sheetWidth - frame + 3.5)}" y="${n(y + 1)}" text-anchor="middle">${label}</text>`;
  }).join("");
  return `<g class="sheet-zones" fill="#536a76" font-family="ui-monospace,monospace" font-size="2.6">${columnMarkup}${rowMarkup}</g>`;
}

function revisionTable(x: number, y: number, width: number, height: number): string {
  return `<g class="revision-table" fill="none" stroke="#173346" stroke-width="0.35" font-family="ui-monospace,monospace"><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}"/><path d="M${n(x)} ${n(y + 6)}H${n(x + width)}M${n(x)} ${n(y + 11)}H${n(x + width)}M${n(x + 10)} ${n(y + 6)}V${n(y + height)}M${n(x + width - 12)} ${n(y + 6)}V${n(y + height)}"/><g fill="#173346" stroke="none" font-size="2.3"><text x="${n(x + 2)}" y="${n(y + 4.2)}" font-weight="700">REVISION HISTORY</text><text x="${n(x + 2)}" y="${n(y + 9.5)}">REV</text><text x="${n(x + 12)}" y="${n(y + 9.5)}">DESCRIPTION</text><text x="${n(x + width - 10)}" y="${n(y + 9.5)}">STATE</text><text x="${n(x + 4)}" y="${n(y + 16)}">A</text><text x="${n(x + 12)}" y="${n(y + 16)}">INITIAL MODEL DRAFT</text><text x="${n(x + width - 10)}" y="${n(y + 16)}">WIP</text></g></g>`;
}

function titleBlock(x: number, y: number, width: number, height: number, part: PartIntent, settings: DrawingSettings, plan: DrawingGenerationPlan, scaleLabel: string): string {
  const tolerance = `UNLESS OTHERWISE SPECIFIED: LINEAR ±${formatTolerance(plan.generalTolerance.linearMm)} mm · ANGULAR ±${formatTolerance(plan.generalTolerance.angularDeg)}°`;
  const drawingNumber = "PS3D-CBP-001";
  const datumNote = plan.datumScheme === "none" ? "DATUM SCHEME: NOT SPECIFIED" : "DATUM SCHEME: PLATE 3-2-1 DRAFT · ENGINEER CONFIRMATION REQUIRED";
  return `<g class="title-block" fill="none" stroke="#173346" stroke-width="0.4" font-family="ui-monospace,monospace"><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}"/><path d="M${n(x)} ${n(y + 12)}H${n(x + width)}M${n(x)} ${n(y + 22)}H${n(x + width)}M${n(x)} ${n(y + 33)}H${n(x + width)}M${n(x)} ${n(y + 45)}H${n(x + width)}M${n(x + width * 0.54)} ${n(y + 12)}V${n(y + 33)}M${n(x + width * 0.73)} ${n(y + 12)}V${n(y + 33)}M${n(x + width * 0.86)} ${n(y + 12)}V${n(y + 33)}"/><text x="${n(x + 3)}" y="${n(y + 8)}" fill="#173346" stroke="none" font-size="5" font-weight="700">${escapeXml(settings.title)}</text><g fill="#173346" stroke="none" font-size="2.45"><text x="${n(x + 3)}" y="${n(y + 17)}">DRAWING NO. ${drawingNumber}</text><text x="${n(x + width * 0.56)}" y="${n(y + 17)}">REV A</text><text x="${n(x + width * 0.75)}" y="${n(y + 17)}">SHEET 1 OF 1</text><text x="${n(x + width * 0.88)}" y="${n(y + 17)}">${escapeXml(settings.sheet)}</text><text x="${n(x + 3)}" y="${n(y + 28)}">PART ${escapeXml(part.name.toUpperCase())}</text><text x="${n(x + width * 0.56)}" y="${n(y + 28)}">SCALE ${escapeXml(scaleLabel)}</text><text x="${n(x + width * 0.75)}" y="${n(y + 28)}">UNITS mm</text><text x="${n(x + width * 0.88)}" y="${n(y + 28)}">${escapeXml(plan.draftingStandard)}</text><text x="${n(x + 3)}" y="${n(y + 38)}">${escapeXml(tolerance)}</text><text x="${n(x + 3)}" y="${n(y + 42.2)}">GD&amp;T VALUES ARE EXPLICIT FCF INPUTS — NOT DERIVED FROM GENERAL TOLERANCE</text><text x="${n(x + 3)}" y="${n(y + 50)}">DRAWN PS3D · CHECKED — · APPROVED — · ${escapeXml(settings.notes)}</text></g>${projectionSymbol(x + width - 25, y + 37, settings.projection)}<text x="${n(x + 3)}" y="${n(y + 32)}" fill="#8a5b20" stroke="none" font-size="2.1">${escapeXml(datumNote)}</text><rect x="${n(x + width - 45)}" y="${n(y + 45)}" width="45" height="${n(height - 45)}" fill="#fff4e5"/><text x="${n(x + width - 22.5)}" y="${n(y + 51)}" text-anchor="middle" fill="#9b3f32" stroke="none" font-size="3.1" font-weight="700">NOT RELEASED</text></g>`;
}

function projectionSymbol(x: number, y: number, projection: DrawingSettings["projection"]): string {
  const circleX = projection === "third-angle" ? x - 8 : x + 8;
  const frustumX = projection === "third-angle" ? x + 3 : x - 13;
  return `<g class="projection-symbol" data-projection-symbol="${projection}" fill="none" stroke="#173346" stroke-width="0.35"><circle cx="${n(circleX)}" cy="${n(y)}" r="4"/><circle cx="${n(circleX)}" cy="${n(y)}" r="1.7"/><path d="M${n(frustumX)} ${n(y - 4)}h9l-2 8h-5z"/><text x="${n(x)}" y="${n(y + 7)}" text-anchor="middle" fill="#173346" stroke="none" font-family="ui-monospace,monospace" font-size="2">${projection === "third-angle" ? "3RD ANGLE" : "1ST ANGLE"}</text></g>`;
}

function centerMark(x: number, y: number, length: number): string {
  return `<path class="center-line" d="M${n(x - length)} ${n(y)}H${n(x + length)}M${n(x)} ${n(y - length)}V${n(y + length)}" stroke-dasharray="5 1 1 1" stroke-width="0.32"/>`;
}

function groupLabel(label: string, x: number, y: number): string {
  return `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" fill="#536a76" font-family="ui-monospace,monospace" font-size="2.8">${label}</text>`;
}

function polyline(points: readonly (readonly [number, number])[]): string {
  return `M${points.map((point) => `${n(point[0])} ${n(point[1])}`).join("L")}Z`;
}

function bounded(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatTolerance(value: number): string {
  return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

function n(value: number): string {
  return value.toFixed(3).replace(/\.?(?:0+)$/u, "");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
