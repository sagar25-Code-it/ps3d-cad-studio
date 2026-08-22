import { useEffect, useMemo, useState } from "react";
import type { SketchEntity, SketchConstraintKind, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch, buildSketchEntity, requiredSketchPoints, snapSketchPoint, type SketchTool } from "../../../../packages/workbench-sketch/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

type DrivingDimension = "length" | "width" | "height" | "radius";

interface SketchWorkspaceProps {
  readonly sketch: WorkbenchSketch;
  readonly tool: SketchTool;
  readonly cancelVersion: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onAddEntity: (entity: SketchEntity) => void;
  readonly onDeleteEntity: (id: string) => void;
  readonly onAddConstraint: (constraint: WorkbenchSketchConstraint) => void;
  readonly onDeleteConstraint: (id: string) => void;
  readonly onSetDimension: (entityId: string, dimension: DrivingDimension, valueMm: number) => void;
  readonly onToggleConstruction: (entityId: string) => void;
  readonly onMessage: (message: string) => void;
}

export function SketchWorkspace(props: SketchWorkspaceProps): React.JSX.Element {
  const [pending, setPending] = useState<readonly Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2>([0, 0]);
  const [selectionIds, setSelectionIds] = useState<readonly string[]>(props.selectedId === null ? [] : [props.selectedId]);
  const [gridVisible, setGridVisible] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showProfiles, setShowProfiles] = useState(true);
  const [showDimensions, setShowDimensions] = useState(true);
  const [showConstraints, setShowConstraints] = useState(true);
  const analysis = useMemo(() => analyzeWorkbenchSketch(props.sketch), [props.sketch]);
  const view = expandedView(analysis.boundsMm.min, analysis.boundsMm.size);
  const selectedEntity = props.sketch.entities.find((entity) => entity.id === selectionIds.at(-1));
  const selectedEntities = selectionIds.map((id) => props.sketch.entities.find((entity) => entity.id === id)).filter((entity): entity is SketchEntity => entity !== undefined);
  const selectedConstraints = props.sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => selectionIds.includes(id)));

  useEffect(() => setPending([]), [props.tool, props.cancelVersion]);
  useEffect(() => {
    if (props.selectedId === null) setSelectionIds([]);
    else setSelectionIds((current) => current.includes(props.selectedId!) ? current : [props.selectedId!]);
  }, [props.selectedId]);

  const pointer = (event: React.PointerEvent<SVGSVGElement>, commit: boolean): void => {
    const point = eventPoint(event, view);
    const snapped = snapEnabled ? snapSketchPoint(point, props.sketch) : { point, snapped: false, kind: "none" as const };
    setCursor(snapped.point);
    if (!commit) return;
    if (props.tool === "select") {
      setSelectionIds([]);
      props.onSelect(null);
      return;
    }
    const points = [...pending, snapped.point];
    if (points.length < requiredSketchPoints(props.tool)) {
      setPending(points);
      props.onMessage(`${props.tool}: point ${points.length} accepted${snapped.snapped ? ` (${snapped.kind} snap)` : ""}.`);
      return;
    }
    const built = buildSketchEntity(props.tool, points, `entity:user-${crypto.randomUUID()}`);
    if (!built.ok) {
      props.onMessage(built.diagnostics[0]?.message ?? "Sketch entity rejected.");
      setPending([]);
      return;
    }
    props.onAddEntity(built.value);
    setPending([]);
    props.onMessage(`Added ${props.tool} with stable ID ${built.value.id}.`);
  };

  const selectEntity = (id: string, additive: boolean): void => {
    if (!additive) {
      setSelectionIds([id]);
      props.onSelect(id);
      return;
    }
    setSelectionIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current.slice(-1), id]);
    props.onMessage("Multi-selection updated. Pair constraints accept up to two entities.");
  };

  const constrain = (kind: SketchConstraintKind): void => {
    if (selectedEntities.length === 0) return;
    const pairKinds: readonly SketchConstraintKind[] = ["parallel", "perpendicular", "tangent", "collinear", "coincident", "concentric", "equal", "midpoint", "symmetry"];
    const entityIds = pairKinds.includes(kind) ? selectionIds.slice(-2) : [selectedEntities.at(-1)!.id];
    if (pairKinds.includes(kind) && entityIds.length !== 2) {
      props.onMessage(`${kind} needs two entities. Shift-click the second entity.`);
      return;
    }
    props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, kind, entityIds });
  };

  const twoLines = selectedEntities.length === 2 && selectedEntities.every((entity) => entity.kind === "line");
  const twoCircles = selectedEntities.length === 2 && selectedEntities.every((entity) => entity.kind === "circle");
  const twoCompatible = selectedEntities.length === 2 && selectedEntities[0]!.kind === selectedEntities[1]!.kind;

  return <>
    <section className="workspace-canvas sketch-stage" aria-label="Interactive XY sketch">
      <svg
        className={`sketch-canvas ${showProfiles ? "show-profiles" : "hide-profiles"}`}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        role="img"
        aria-label={`XY sketch with ${props.sketch.entities.length} entities and ${analysis.degreesOfFreedom} estimated degrees of freedom`}
        onPointerMove={(event) => pointer(event, false)}
        onPointerDown={(event) => pointer(event, true)}
      >
        <defs><pattern id="minor-grid" width={props.sketch.gridMm} height={props.sketch.gridMm} patternUnits="userSpaceOnUse"><path d={`M ${props.sketch.gridMm} 0 L 0 0 0 ${props.sketch.gridMm}`} fill="none" stroke="#1d3c58" strokeWidth="0.18" /></pattern></defs>
        {gridVisible && <rect x={view.x} y={view.y} width={view.width} height={view.height} fill="url(#minor-grid)" />}
        <g transform="scale(1,-1)">
          <line x1={view.x} y1="0" x2={view.x + view.width} y2="0" className="sketch-axis x" />
          <line x1="0" y1={-view.y - view.height} x2="0" y2={-view.y} className="sketch-axis y" />
          {props.sketch.entities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} selected={selectionIds.includes(entity.id)} onSelect={(additive) => selectEntity(entity.id, additive)} />)}
          {pending.map((point, index) => <circle key={index} cx={point[0]} cy={-point[1]} r="1.1" className="pending-point" />)}
          {props.tool !== "select" && <circle cx={cursor[0]} cy={-cursor[1]} r="0.8" className="cursor-point" />}
        </g>
        {showDimensions && props.sketch.entities.map((entity) => <SketchDimensionGlyph key={`dimension:${entity.id}`} entity={entity} />)}
        {showConstraints && props.sketch.constraints.map((constraint) => <ConstraintGlyph key={constraint.id} constraint={constraint} entities={props.sketch.entities} />)}
      </svg>

      <div className="sketch-palette" aria-label="Sketch palette">
        <header><div><span>SKETCH</span><strong>Palette</strong></div><button onClick={() => props.onMessage("The active sketch is already normal to the XY plane.")}><CommandIcon name="view" />Look at</button></header>
        <PaletteToggle label="Sketch grid" active={gridVisible} onToggle={setGridVisible} />
        <PaletteToggle label="Snap" active={snapEnabled} onToggle={setSnapEnabled} />
        <PaletteToggle label="Profiles" active={showProfiles} onToggle={setShowProfiles} />
        <PaletteToggle label="Dimensions" active={showDimensions} onToggle={setShowDimensions} />
        <PaletteToggle label="Constraints" active={showConstraints} onToggle={setShowConstraints} />
        <button className="palette-action" disabled={selectedEntity === undefined} onClick={() => selectedEntity !== undefined && props.onToggleConstruction(selectedEntity.id)}><CommandIcon name={selectedEntity?.construction === true ? "rectangle" : "construction"} />{selectedEntity?.construction === true ? "Profile geometry" : "Construction"}</button>
      </div>

      <div className="canvas-hud"><span>XY plane</span><span>Tool {props.tool}</span><span>Grid {gridVisible ? `${props.sketch.gridMm} mm` : "off"}</span><span>Snap {snapEnabled ? `${props.sketch.snapToleranceMm} mm` : "off"}</span><strong>{analysis.classification.replace("-", " ")}</strong></div>
    </section>

    <aside className="inspector-panel" aria-label="Sketch inspector">
      <div className="inspector-title"><div><p>Sketch intelligence</p><h2>{props.sketch.name}</h2></div><CapabilityBadge level="preview" /></div>
      <section className={`solver-card ${analysis.classification}`}>
        <span className="solver-number">{analysis.degreesOfFreedom}</span>
        <div><strong>{analysis.classification === "fully-constrained" ? "Fully constrained" : analysis.classification === "conflict" ? "Constraint conflict" : "Degrees of freedom"}</strong><small>{analysis.appliedConstraints} supported constraints evaluated</small></div>
      </section>
      {analysis.conflicts.length > 0 && <div className="inline-warning">{analysis.conflicts[0]}</div>}

      <section className="inspector-section"><header><strong>Selection controller</strong><span>{selectionIds.length} selected</span></header>
        {selectedEntity === undefined ? <p className="empty-copy">Select an entity. Shift-click adds a second entity for pair constraints.</p> : <>
          <dl className="compact-facts"><div><dt>Primary</dt><dd>{selectedEntity.kind}</dd></div><div><dt>Freedom</dt><dd>{analysis.entityFreedom[selectedEntity.id] ?? 0}</dd></div><div><dt>Stable ID</dt><dd>{shortId(selectedEntity.id)}</dd></div><div><dt>Constraints</dt><dd>{selectedConstraints.length}</dd></div></dl>
          <div className="selection-chips">{selectedEntities.map((entity, index) => <span key={entity.id}><b>{index + 1}</b>{entity.kind}</span>)}</div>
          <div className="constraint-buttons">
            <button disabled={selectedEntities.length !== 1 || selectedEntity.kind !== "line"} onClick={() => constrain("horizontal")}><CommandIcon name="horizontal" />Horizontal</button>
            <button disabled={selectedEntities.length !== 1 || selectedEntity.kind !== "line"} onClick={() => constrain("vertical")}><CommandIcon name="vertical" />Vertical</button>
            <button disabled={!twoLines} onClick={() => constrain("parallel")}><CommandIcon name="parallel" />Parallel</button>
            <button disabled={!twoLines} onClick={() => constrain("perpendicular")}><CommandIcon name="perpendicular" />Perpendicular</button>
            <button disabled={!twoLines} onClick={() => constrain("collinear")}><CommandIcon name="collinear" />Collinear</button>
            <button disabled={!twoCircles} onClick={() => constrain("concentric")}><CommandIcon name="concentric" />Concentric</button>
            <button disabled={!twoCompatible} onClick={() => constrain("equal")}><CommandIcon name="equal" />Equal</button>
            <button disabled={selectedEntities.length !== 2} onClick={() => constrain("tangent")}><CommandIcon name="tangent" />Tangent</button>
            <button onClick={() => constrain("fixed")}><CommandIcon name="fixed" />Fix primary</button>
            <button onClick={() => props.onToggleConstruction(selectedEntity.id)}><CommandIcon name={selectedEntity.construction ? "rectangle" : "construction"} />{selectedEntity.construction ? "Profile" : "Construction"}</button>
            <button className="danger" onClick={() => props.onDeleteEntity(selectedEntity.id)}><CommandIcon name="trash" />Delete primary</button>
          </div>
        </>}
      </section>

      {selectedEntity !== undefined && <section className="inspector-section dimension-controller"><header><strong>Driving dimensions</strong><span>mm</span></header><EntityDimensions entity={selectedEntity} onApply={(dimension, value) => props.onSetDimension(selectedEntity.id, dimension, value)} /></section>}

      <section className="inspector-section"><header><strong>Constraint records</strong><span>{props.sketch.constraints.length}</span></header>
        <div className="record-list">{props.sketch.constraints.slice(-10).reverse().map((constraint) => <button key={constraint.id} onClick={() => props.onDeleteConstraint(constraint.id)} title="Delete this constraint"><CommandIcon name={constraint.dimension === undefined ? constraint.kind : "dimension"} /><span>{constraint.kind}{constraint.dimension === undefined ? "" : ` · ${constraint.dimension}`}</span><small>{constraint.valueMm === undefined ? shortId(constraint.id) : `${format(constraint.valueMm)} mm`}</small></button>)}</div>
      </section>
      <div className="scope-note"><strong>Preview solver boundary</strong><p>Dimension edits update bounded geometry and constraint records atomically. Pair constraints currently provide validated intent and freedom accounting, not a general nonlinear solve.</p></div>
    </aside>
  </>;
}

function PaletteToggle({ label, active, onToggle }: { readonly label: string; readonly active: boolean; readonly onToggle: (active: boolean) => void }): React.JSX.Element {
  return <label><span>{label}</span><input type="checkbox" checked={active} onChange={(event) => onToggle(event.target.checked)} /></label>;
}

function EntityDimensions({ entity, onApply }: { readonly entity: SketchEntity; readonly onApply: (dimension: DrivingDimension, value: number) => void }): React.JSX.Element {
  if (entity.kind === "line") return <DimensionField label="Length" dimension="length" value={Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1])} onApply={onApply} />;
  if (entity.kind === "rectangle") return <div className="dimension-stack"><DimensionField label="Width" dimension="width" value={entity.widthMm} onApply={onApply} /><DimensionField label="Height" dimension="height" value={entity.heightMm} onApply={onApply} /></div>;
  if (entity.kind === "circle") return <><DimensionField label="Radius" dimension="radius" value={entity.radiusMm} onApply={onApply} /><div className="derived-dimension"><span>Diameter</span><strong>{format(entity.radiusMm * 2)} mm</strong></div></>;
  return <div className="derived-dimension"><span>Three-point arc</span><strong>reference only</strong></div>;
}

function DimensionField({ label, dimension, value, onApply }: { readonly label: string; readonly dimension: DrivingDimension; readonly value: number; readonly onApply: (dimension: DrivingDimension, value: number) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  return <form className="dimension-field" onSubmit={(event) => { event.preventDefault(); const next = Number(draft); if (Number.isFinite(next)) onApply(dimension, next); }}>
    <label><span>{label}</span><div><input aria-label={`${label} in millimeters`} inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)} /><small>mm</small><button type="submit"><CommandIcon name="dimension" />Apply</button></div></label>
  </form>;
}

function SketchEntityShape({ entity, selected, onSelect }: { readonly entity: SketchEntity; readonly selected: boolean; readonly onSelect: (additive: boolean) => void }): React.JSX.Element {
  const className = `sketch-entity ${entity.construction ? "construction" : ""} ${selected ? "selected" : ""}`;
  const common = { className, onPointerDown: (event: React.PointerEvent) => { event.stopPropagation(); onSelect(event.shiftKey || event.ctrlKey || event.metaKey); } };
  if (entity.kind === "line") return <line {...common} x1={entity.start[0]} y1={-entity.start[1]} x2={entity.end[0]} y2={-entity.end[1]} />;
  if (entity.kind === "rectangle") return <rect {...common} x={entity.center[0] - entity.widthMm / 2} y={-entity.center[1] - entity.heightMm / 2} width={entity.widthMm} height={entity.heightMm} transform={`rotate(${-entity.rotationDeg} ${entity.center[0]} ${-entity.center[1]})`} />;
  if (entity.kind === "circle") return <circle {...common} cx={entity.center[0]} cy={-entity.center[1]} r={entity.radiusMm} />;
  return <path {...common} d={`M ${entity.start[0]} ${-entity.start[1]} Q ${entity.mid[0]} ${-entity.mid[1]} ${entity.end[0]} ${-entity.end[1]}`} />;
}

function SketchDimensionGlyph({ entity }: { readonly entity: SketchEntity }): React.JSX.Element {
  if (entity.kind === "line") {
    const x = (entity.start[0] + entity.end[0]) / 2;
    const y = -(entity.start[1] + entity.end[1]) / 2 - 3;
    return <text x={x} y={y} className="sketch-dimension-glyph">{format(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))}</text>;
  }
  if (entity.kind === "rectangle") return <><text x={entity.center[0]} y={-entity.center[1] + entity.heightMm / 2 + 4} className="sketch-dimension-glyph">{format(entity.widthMm)}</text><text x={entity.center[0] + entity.widthMm / 2 + 3} y={-entity.center[1]} className="sketch-dimension-glyph vertical">{format(entity.heightMm)}</text></>;
  if (entity.kind === "circle") return <text x={entity.center[0] + entity.radiusMm * 0.35} y={-entity.center[1] - 2} className="sketch-dimension-glyph">R {format(entity.radiusMm)}</text>;
  return <></>;
}

function ConstraintGlyph({ constraint, entities }: { readonly constraint: WorkbenchSketchConstraint; readonly entities: readonly SketchEntity[] }): React.JSX.Element {
  const entity = entities.find((candidate) => candidate.id === constraint.entityIds[0]);
  if (entity === undefined) return <></>;
  const point = entityAnchor(entity);
  const label = constraint.kind === "horizontal" ? "H" : constraint.kind === "vertical" ? "V" : constraint.kind === "parallel" ? "∥" : constraint.kind === "perpendicular" ? "⊥" : constraint.kind === "fixed" ? "F" : constraint.kind === "concentric" ? "◎" : constraint.kind === "equal" ? "=" : constraint.kind.slice(0, 1).toUpperCase();
  return <g className="constraint-glyph"><circle cx={point[0] + 2.4} cy={-point[1] - 2.4} r="1.75" /><text x={point[0] + 2.4} y={-point[1] - 1.9}>{label}</text></g>;
}

function entityAnchor(entity: SketchEntity): Vec2 {
  if (entity.kind === "line") return [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
  if (entity.kind === "rectangle" || entity.kind === "circle") return entity.center;
  return entity.mid;
}

function expandedView(min: Vec2, size: Vec2): { x: number; y: number; width: number; height: number } {
  const margin = Math.max(12, Math.max(...size) * 0.18);
  return { x: min[0] - margin, y: -(min[1] + size[1] + margin), width: size[0] + margin * 2, height: size[1] + margin * 2 };
}

function eventPoint(event: React.PointerEvent<SVGSVGElement>, view: { x: number; y: number; width: number; height: number }): Vec2 {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = view.x + (event.clientX - rect.left) / rect.width * view.width;
  const svgY = view.y + (event.clientY - rect.top) / rect.height * view.height;
  return [x, -svgY];
}

function shortId(id: string): string {
  return id.length < 28 ? id : `${id.slice(0, 18)}…${id.slice(-7)}`;
}

function format(value: number): string {
  return String(Number(value.toFixed(3)));
}
