import { useEffect, useState } from "react";
import type {
  DrawingDatumScheme,
  DrawingDisplayStyle,
  DrawingDraftingStandard,
  DrawingSettings,
  DrawingViewPreset
} from "../../../../packages/workbench-core/src/index.js";
import type { DrawingArtifact, DrawingGdtFrameRecord } from "../../../../packages/workbench-drawing/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

interface DrawingWorkspaceProps {
  readonly settings: DrawingSettings;
  readonly artifact: DrawingArtifact;
  readonly onSheet: (sheet: DrawingSettings["sheet"]) => void;
  readonly onProjection: (projection: DrawingSettings["projection"]) => void;
  readonly onScale: (scale: DrawingSettings["scale"]) => void;
  readonly onDimensions: (show: boolean) => void;
  readonly onViewPreset: (preset: DrawingViewPreset) => void;
  readonly onDisplayStyle: (style: DrawingDisplayStyle) => void;
  readonly onSectionView: (show: boolean) => void;
  readonly onDraftingStandard: (standard: DrawingDraftingStandard) => void;
  readonly onGdt: (show: boolean) => void;
  readonly onDatumScheme: (scheme: DrawingDatumScheme) => void;
  readonly onGdtSpecification: (positionMm: number, flatnessMm: number, perpendicularityMm: number) => void;
  readonly onGeneralTolerance: (linearMm: number, angularDeg: number) => void;
  readonly onNotes: (notes: string) => void;
}

export function DrawingWorkspace(props: DrawingWorkspaceProps): React.JSX.Element {
  const [notes, setNotes] = useState(props.settings.notes);
  const [linearTolerance, setLinearTolerance] = useState(props.artifact.generalTolerance.linearMm);
  const [angularTolerance, setAngularTolerance] = useState(props.artifact.generalTolerance.angularDeg);
  const [positionTolerance, setPositionTolerance] = useState(props.settings.gdtPositionToleranceMm ?? 0.2);
  const [flatnessTolerance, setFlatnessTolerance] = useState(props.settings.gdtFlatnessToleranceMm ?? 0.1);
  const [perpendicularityTolerance, setPerpendicularityTolerance] = useState(props.settings.gdtPerpendicularityToleranceMm ?? 0.1);
  useEffect(() => setNotes(props.settings.notes), [props.settings.notes]);
  useEffect(() => setLinearTolerance(props.artifact.generalTolerance.linearMm), [props.artifact.generalTolerance.linearMm]);
  useEffect(() => setAngularTolerance(props.artifact.generalTolerance.angularDeg), [props.artifact.generalTolerance.angularDeg]);
  useEffect(() => setPositionTolerance(props.settings.gdtPositionToleranceMm ?? 0.2), [props.settings.gdtPositionToleranceMm]);
  useEffect(() => setFlatnessTolerance(props.settings.gdtFlatnessToleranceMm ?? 0.1), [props.settings.gdtFlatnessToleranceMm]);
  useEffect(() => setPerpendicularityTolerance(props.settings.gdtPerpendicularityToleranceMm ?? 0.1), [props.settings.gdtPerpendicularityToleranceMm]);
  const applyTolerance = (): void => {
    if (Number.isFinite(linearTolerance) && Number.isFinite(angularTolerance)) props.onGeneralTolerance(linearTolerance, angularTolerance);
  };
  const applyGdt = (): void => {
    if ([positionTolerance, flatnessTolerance, perpendicularityTolerance].every(Number.isFinite)) props.onGdtSpecification(positionTolerance, flatnessTolerance, perpendicularityTolerance);
  };
  return <>
    <section className="workspace-canvas drawing-stage" aria-label="Standards-aware technical drawing preview">
      <div className="drawing-sheet" dangerouslySetInnerHTML={{ __html: props.artifact.svg }} />
      <div className="canvas-hud drawing-hud">
        <span>{props.settings.sheet}</span>
        <span>{props.artifact.fitAdjusted ? `FIT 1:${formatScale(props.artifact.effectiveScale)}` : `1:${props.settings.scale}`}</span>
        <span>{props.settings.projection}</span>
        <span>{props.artifact.draftingStandard}</span>
        <span>{props.artifact.dimensionCount} DIM</span>
        <span>{props.artifact.gdtFrameCount} FCF</span>
        <strong>{props.artifact.viewCount} linked views</strong>
      </div>
    </section>
    <aside className="inspector-panel drawing-inspector" aria-label="Drawing inspector">
      <div className="inspector-title"><div><p>Engineering drawing</p><h2>{props.settings.title}</h2></div><CapabilityBadge level="preview" /></div>

      <section className="drawing-generation-card" aria-label="Associative generation summary">
        <div className="drawing-generation-icon"><CommandIcon name="auto-view" /></div>
        <div><span>ASSOCIATIVE VIEW CHAIN</span><strong>Base → projected → section</strong><small>{props.artifact.viewCount} views · {props.artifact.dimensionCount} selected dimensions · {props.artifact.datumCount} authored datums</small></div>
        <b aria-label="Generation ready">✓</b>
      </section>

      <section className="inspector-section"><header><strong>Drawing method</strong><span>MODEL LINKED</span></header>
        <label className="field-row"><span>Drafting basis</span><select aria-label="Drafting standard" value={props.artifact.draftingStandard} onChange={(event) => props.onDraftingStandard(event.target.value as DrawingDraftingStandard)}><option value="ASME">ASME basis</option><option value="ISO">ISO basis</option></select></label>
        <label className="field-row"><span>View layout</span><select aria-label="Automatic view layout" value={props.artifact.viewPreset} onChange={(event) => props.onViewPreset(event.target.value as DrawingViewPreset)}><option value="automatic-4-view">Base + 2 projected + iso</option><option value="orthographic-3-view">Base + 2 projected</option><option value="front-only">Base front only</option></select></label>
        <label className="field-row"><span>Projection</span><select value={props.settings.projection} onChange={(event) => props.onProjection(event.target.value as DrawingSettings["projection"])}><option value="third-angle">Third angle</option><option value="first-angle">First angle</option></select></label>
        <label className="field-row"><span>Edge display</span><select aria-label="Drawing edge display" value={props.artifact.displayStyle} onChange={(event) => props.onDisplayStyle(event.target.value as DrawingDisplayStyle)}><option value="visible-hidden-edges">Visible + hidden edges</option><option value="visible-edges">Visible edges only</option></select></label>
        <label className="field-row"><span>Sheet</span><select value={props.settings.sheet} onChange={(event) => props.onSheet(event.target.value as DrawingSettings["sheet"])}><option>A4</option><option>A3</option></select></label>
        <label className="field-row"><span>Preferred scale</span><select value={props.settings.scale} onChange={(event) => props.onScale(Number(event.target.value) as DrawingSettings["scale"])}><option value="1">1:1</option><option value="2">1:2</option><option value="5">1:5</option></select></label>
        <label className="check-row"><input type="checkbox" checked={props.settings.showSectionView ?? false} disabled={props.artifact.viewPreset === "front-only"} onChange={(event) => props.onSectionView(event.target.checked)} /><span><strong>Full section A–A</strong><small>Cut from the base view through the centered bore</small></span></label>
        <label className="check-row"><input type="checkbox" checked={props.settings.showDimensions} onChange={(event) => props.onDimensions(event.target.checked)} /><span><strong>Selected model dimensions</strong><small>Overall size, thickness, hole callout, and basic location only when position is specified</small></span></label>
      </section>

      <section className="inspector-section tolerance-controller"><header><strong>General tolerance</strong><span>NON-GD&amp;T</span></header>
        <p className="tolerance-copy">Applies only to dimensions without an individual tolerance. It never creates datums and never calculates feature-control-frame values.</p>
        <div className="tolerance-grid">
          <label><span>Linear ±</span><div><input aria-label="General linear tolerance in millimeters" type="number" min="0.001" max="10" step="0.01" value={linearTolerance} onChange={(event) => setLinearTolerance(Number(event.target.value))} /><small>mm</small></div></label>
          <label><span>Angular ±</span><div><input aria-label="General angular tolerance in degrees" type="number" min="0.01" max="10" step="0.1" value={angularTolerance} onChange={(event) => setAngularTolerance(Number(event.target.value))} /><small>deg</small></div></label>
        </div>
        <button onClick={applyTolerance}>Apply general tolerance</button>
        <div className="tolerance-note"><CommandIcon name="tolerance" /><span><strong>Unless otherwise specified</strong><small>LINEAR ±{formatTolerance(props.artifact.generalTolerance.linearMm)} mm · ANGULAR ±{formatTolerance(props.artifact.generalTolerance.angularDeg)}°</small></span></div>
      </section>

      <section className="inspector-section gdt-controller"><header><strong>GD&amp;T specification</strong><span>EXPLICIT INPUT</span></header>
        <p className="tolerance-copy">This seeded plate scheme is a reviewable drafting template, not automatic design intent. Confirm datums and values before release.</p>
        <label className="check-row"><input type="checkbox" checked={props.settings.showGdt ?? false} onChange={(event) => props.onGdt(event.target.checked)} /><span><strong>Show authored feature-control frames</strong><small>Flatness is datum-independent; orientation and position require a datum frame</small></span></label>
        <label className="field-row"><span>Datum frame</span><select aria-label="Datum scheme" value={props.settings.datumScheme ?? "none"} onChange={(event) => props.onDatumScheme(event.target.value as DrawingDatumScheme)}><option value="none">None</option><option value="plate-3-2-1">Plate 3-2-1 draft</option></select></label>
        <div className="gdt-spec-grid">
          <label><span>Position ⌀</span><div><input aria-label="Position tolerance in millimeters" type="number" min="0.001" max="10" step="0.01" value={positionTolerance} onChange={(event) => setPositionTolerance(Number(event.target.value))} /><small>mm</small></div></label>
          <label><span>Flatness</span><div><input aria-label="Flatness tolerance in millimeters" type="number" min="0.001" max="10" step="0.01" value={flatnessTolerance} onChange={(event) => setFlatnessTolerance(Number(event.target.value))} /><small>mm</small></div></label>
          <label><span>Perpendicularity</span><div><input aria-label="Perpendicularity tolerance in millimeters" type="number" min="0.001" max="10" step="0.01" value={perpendicularityTolerance} onChange={(event) => setPerpendicularityTolerance(Number(event.target.value))} /><small>mm</small></div></label>
        </div>
        <button onClick={applyGdt}>Apply explicit GD&amp;T values</button>
      </section>

      {props.artifact.gdtFrames.length > 0 && <section className="view-list gdt-list"><header><strong>Feature-control frames</strong><span>{props.artifact.gdtFrameCount} EXPLICIT</span></header>{props.artifact.gdtFrames.map((frame) => <GdtRow key={frame.id} frame={frame} />)}</section>}

      <section className="view-list"><header><strong>Generated view chain</strong><span>{props.artifact.displayStyle.replaceAll("-", " ")}</span></header>{props.artifact.views.map((view) => <div key={view.id}><span className={`view-icon ${view.id}`} aria-hidden="true" /><strong>{view.label}</strong><small>{view.role}{view.parentId === undefined ? "" : ` from ${view.parentId}`} · {view.alignment} alignment</small></div>)}</section>

      <section className="inspector-section"><header><strong>Sheet note</strong><span>{notes.length}/240</span></header><textarea maxLength={240} value={notes} onChange={(event) => setNotes(event.target.value)} /><button onClick={() => props.onNotes(notes)}>Apply note</button></section>
      <div className="scope-note"><strong>Release boundary</strong><p>The sheet is a deterministic drafting preview. A responsible engineer must approve view sufficiency, datum strategy, tolerance values, material, process, inspection method, checker identity, and release status.</p></div>
    </aside>
  </>;
}

function GdtRow({ frame }: { readonly frame: DrawingGdtFrameRecord }): React.JSX.Element {
  const datums = frame.datumReferences.length === 0 ? "NO DATUM" : frame.datumReferences.join(" | ");
  return <div className="gdt-row"><span className={`gdt-characteristic ${frame.characteristic}`} aria-hidden="true"><CommandIcon name={frame.characteristic === "position" ? "gdt-position" : frame.characteristic} /></span><strong>{titleCase(frame.characteristic)}</strong><small>{frame.diameterZone ? "⌀" : ""}{formatTolerance(frame.toleranceMm)} · {datums} · explicit</small></div>;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatTolerance(value: number): string {
  return value < 0.1 ? value.toFixed(3) : value.toFixed(2);
}

function formatScale(value: number): string {
  return value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}
