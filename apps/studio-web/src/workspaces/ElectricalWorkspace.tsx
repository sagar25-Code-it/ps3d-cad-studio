import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ELECTRICAL_SHEET_BOUNDS, constrainElectricalSheetPosition, electricalTerminalRole, electricalTerminalRoleSupportsNetClass } from "../../../../packages/workbench-core/src/index.js";
import type {
  ElectricalComponentKind,
  ElectricalIntent,
  ElectricalNetClass,
  ElectricalStandard,
  ElectricalTemplateId,
  Vec2
} from "../../../../packages/workbench-core/src/index.js";
import type { ElectricalArtifact } from "../../../../packages/workbench-electrical/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

const LIBRARY: readonly { kind: ElectricalComponentKind; label: string; prefix: string }[] = [
  { kind: "battery", label: "Battery", prefix: "BAT" }, { kind: "fuse", label: "Fuse", prefix: "F" },
  { kind: "disconnect", label: "Disconnect", prefix: "QS" }, { kind: "breaker", label: "Breaker", prefix: "QF" },
  { kind: "contactor", label: "Contactor", prefix: "K" }, { kind: "inverter", label: "Inverter / PCS", prefix: "PCS" },
  { kind: "transformer", label: "Transformer", prefix: "T" }, { kind: "motor", label: "Motor", prefix: "M" },
  { kind: "load", label: "Load", prefix: "Y" }, { kind: "sensor", label: "Sensor", prefix: "B" },
  { kind: "hvac", label: "HVAC", prefix: "HV" }, { kind: "terminal", label: "Terminal", prefix: "X" },
  { kind: "ground", label: "Earth", prefix: "PE" }
] as const;

interface ElectricalWorkspaceProps {
  readonly intent: ElectricalIntent;
  readonly artifact: ElectricalArtifact;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onTemplate: (template: ElectricalTemplateId) => void;
  readonly onStandard: (standard: ElectricalStandard) => void;
  readonly onInsertComponent: (kind: ElectricalComponentKind) => void;
  readonly onMoveComponent: (componentId: string, position: Vec2) => void;
  readonly onDeleteComponent: (componentId: string) => void;
  readonly onAddNet: (from: string, to: string, name: string, netClass: ElectricalNetClass) => void;
  readonly onDeleteNet: (netId: string) => void;
  readonly onNotes: (notes: string) => void;
  readonly onPhysicalize: () => void;
  readonly onDownload: () => void;
}

interface DragState {
  readonly id: string;
  readonly pointerId: number;
  readonly offset: Vec2;
  readonly start: Vec2;
  moved: boolean;
}

export function ElectricalWorkspace(props: ElectricalWorkspaceProps): React.JSX.Element {
  const [notes, setNotes] = useState(props.intent.notes);
  const [zoom, setZoom] = useState(1.25);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const endpointOptions = useMemo(() => props.intent.components.flatMap((component) => component.terminals.map((terminal) => ({
    key: `${component.id}|${terminal}`,
    label: `${component.reference}.${terminal} — ${component.label}`
  }))), [props.intent.components]);
  const initialFrom = endpointOptions[0]?.key ?? "";
  const initialTo = endpointOptions.find((option) => option.key.split("|")[0] !== initialFrom.split("|")[0])?.key ?? endpointOptions[1]?.key ?? "";
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [netName, setNetName] = useState("NEW NET");
  const [netClass, setNetClass] = useState<ElectricalNetClass>("control");
  const sameComponentConnection = from.split("|")[0] === to.split("|")[0];
  const incompatibleRoleConnection = [from, to].some((key) => {
    const [componentId, terminal] = key.split("|");
    const component = props.intent.components.find((item) => item.id === componentId);
    return component !== undefined && terminal !== undefined && !electricalTerminalRoleSupportsNetClass(electricalTerminalRole(component.kind, terminal), netClass);
  });
  const selected = props.intent.components.find((component) => component.id === props.selectedId);
  const [positionDraft, setPositionDraft] = useState<Vec2>(selected?.position ?? [0, 0]);
  const physicalBlocked = props.artifact.physicalization.status === "blocked" || props.artifact.erc.errors > 0;
  const warningAcknowledgmentRequired = props.artifact.erc.warnings > 0;

  useEffect(() => setNotes(props.intent.notes), [props.intent.notes]);
  useEffect(() => {
    if (selected !== undefined) setPositionDraft(selected.position);
  }, [selected?.id, selected?.position[0], selected?.position[1]]);
  useEffect(() => {
    if (!endpointOptions.some((option) => option.key === from)) setFrom(endpointOptions[0]?.key ?? "");
    if (!endpointOptions.some((option) => option.key === to) || from.split("|")[0] === to.split("|")[0]) {
      setTo(endpointOptions.find((option) => option.key.split("|")[0] !== from.split("|")[0])?.key ?? "");
    }
  }, [endpointOptions, from, to]);
  useEffect(() => {
    const root = sheetRef.current;
    if (root === null) return;
    root.querySelectorAll<SVGGElement>("[data-component-id],[data-net-id]").forEach((element) => {
      const id = element.dataset["componentId"] ?? element.dataset["netId"];
      element.classList.toggle("ps3d-selected", id === props.selectedId);
    });
  }, [props.artifact.svg, props.selectedId]);

  const sheetPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = event.target instanceof Element ? event.target.closest<SVGGElement>("[data-component-id]") : null;
    const id = element?.dataset["componentId"];
    if (id === undefined) return;
    const component = props.intent.components.find((item) => item.id === id);
    const point = eventToSvgPoint(event, sheetRef.current);
    if (component === undefined || point === undefined) return;
    props.onSelect(id);
    dragRef.current = { id, pointerId: event.pointerId, offset: [component.position[0] - point[0], component.position[1] - point[1]], start: component.position, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const sheetPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const point = eventToSvgPoint(event, sheetRef.current);
    if (drag === undefined || point === undefined || drag.pointerId !== event.pointerId) return;
    const component = props.intent.components.find((item) => item.id === drag.id);
    if (component === undefined) return;
    const position = constrainElectricalSheetPosition([point[0] + drag.offset[0], point[1] + drag.offset[1]], component.rotationDeg);
    drag.moved ||= Math.hypot(position[0] - drag.start[0], position[1] - drag.start[1]) > 2;
    sheetRef.current?.querySelector<SVGGElement>(`[data-component-id="${cssEscape(drag.id)}"]`)?.setAttribute("transform", `translate(${position[0]} ${position[1]}) rotate(${component.rotationDeg})`);
  };
  const sheetPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    const point = eventToSvgPoint(event, sheetRef.current);
    dragRef.current = undefined;
    if (drag === undefined || point === undefined || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved) {
      const component = props.intent.components.find((item) => item.id === drag.id);
      if (component !== undefined) props.onMoveComponent(drag.id, constrainElectricalSheetPosition([point[0] + drag.offset[0], point[1] + drag.offset[1]], component.rotationDeg));
    }
  };
  const sheetKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (selected === undefined) return;
    const step = event.shiftKey ? 1 : 10;
    const delta: Vec2 | undefined = event.key === "ArrowLeft" ? [-step, 0]
      : event.key === "ArrowRight" ? [step, 0]
        : event.key === "ArrowUp" ? [0, -step]
          : event.key === "ArrowDown" ? [0, step]
            : undefined;
    if (delta === undefined) return;
    event.preventDefault();
    props.onMoveComponent(selected.id, constrainElectricalSheetPosition([selected.position[0] + delta[0], selected.position[1] + delta[1]], selected.rotationDeg));
  };

  return <>
    <section className="workspace-canvas electrical-stage" aria-label="Electrical schematic editor">
      <aside className="electrical-library" aria-label="Electrical component library">
        <header><span>IEC / ANSI</span><strong>Component library</strong><small>Original schematic symbols</small></header>
        <div>{LIBRARY.map((item) => <button key={item.kind} onClick={() => props.onInsertComponent(item.kind)} title={`Insert ${item.label}`}><CommandIcon name={item.kind} /><span><strong>{item.label}</strong><small>{item.prefix} · generic package</small></span><b aria-hidden="true">+</b></button>)}</div>
      </aside>
      <div className="sheet-view-toolbar" role="toolbar" aria-label="Schematic view controls">
        <button onClick={() => setZoom((value) => clamp(value - 0.25, 0.75, 2))} aria-label="Zoom schematic out">−</button>
        <button onClick={() => setZoom(1)} aria-label="Fit schematic sheet">Fit</button>
        <output>{Math.round(zoom * 100)}%</output>
        <button onClick={() => setZoom((value) => clamp(value + 0.25, 0.75, 2))} aria-label="Zoom schematic in">+</button>
        <span>Drag symbols · arrow-key nudge · select nets</span>
      </div>
      <div className="electrical-sheet-viewport" role="group" aria-label="Interactive schematic sheet; select a device from the model browser, then use arrow keys to move it by 10 sheet units or Shift plus arrow for one unit" tabIndex={0} onKeyDown={sheetKeyDown} onPointerDown={sheetPointerDown} onPointerMove={sheetPointerMove} onPointerUp={sheetPointerUp} onPointerCancel={() => { dragRef.current = undefined; }} onClick={(event) => {
        const target = event.target instanceof Element ? event.target.closest<SVGGElement>("[data-component-id],[data-net-id]") : null;
        props.onSelect(target?.dataset["componentId"] ?? target?.dataset["netId"] ?? null);
      }}>
        <div ref={sheetRef} className="electrical-sheet-frame" style={{ width: `${zoom * 100}%` }} dangerouslySetInnerHTML={{ __html: props.artifact.svg }} />
      </div>
      <div className="electrical-hud">
        <span><small>Devices</small><strong>{props.artifact.componentCount}</strong></span><span><small>Nets</small><strong>{props.artifact.netCount}</strong></span>
        <span className={`erc-${props.artifact.erc.status}`}><small>ERC</small><strong>{props.artifact.erc.status}</strong></span><span><small>Generic 3D mapping</small><strong>{props.artifact.physicalization.mappedComponents}/{props.artifact.physicalization.totalComponents}</strong></span>
      </div>
      <div className="electrical-scope-banner"><CommandIcon name="shield" /><span><strong>Concept editor</strong><small>No conductor sizing, protection coordination, arc-flash, safety integrity, code compliance, or construction release.</small></span></div>
    </section>
    <aside className="inspector-panel electrical-inspector" aria-label="Electrical schematic inspector">
      <div className="inspector-title sticky-inspector-title"><div><p>Electrical design</p><h2>{props.intent.title}</h2></div><CapabilityBadge level="preview" /></div>

      {selected !== undefined && <section className="selection-card electrical-selection priority-selection"><header><strong>{selected.reference}</strong><span>{selected.kind}</span></header><dl className="compact-facts"><div><dt>Description</dt><dd>{selected.label}</dd></div><div><dt>Value</dt><dd>{selected.value}</dd></div><div><dt>Terminals</dt><dd>{selected.terminals.join(", ")}</dd></div></dl><div className="electrical-position-editor"><strong>Sheet position</strong><label><span>X</span><input aria-label={`${selected.reference} sheet X position`} type="number" min={ELECTRICAL_SHEET_BOUNDS.minX} max={ELECTRICAL_SHEET_BOUNDS.maxX} value={positionDraft[0]} onChange={(event) => setPositionDraft([Number(event.target.value), positionDraft[1]])} /></label><label><span>Y</span><input aria-label={`${selected.reference} sheet Y position`} type="number" min={ELECTRICAL_SHEET_BOUNDS.minY} max={ELECTRICAL_SHEET_BOUNDS.maxY} value={positionDraft[1]} onChange={(event) => setPositionDraft([positionDraft[0], Number(event.target.value)])} /></label><button className="primary" onClick={() => { const position = constrainElectricalSheetPosition(positionDraft, selected.rotationDeg); setPositionDraft(position); props.onMoveComponent(selected.id, position); }}>Apply position</button></div><button className="danger" onClick={() => props.onDeleteComponent(selected.id)}>Delete component and dependent nets</button></section>}

      <section className={`electromechanical-review-card ${physicalBlocked ? "blocked" : "ready"}`}>
        <header><strong>Circuit → wired mounting plate</strong><span>{physicalBlocked ? "blocked" : warningAcknowledgmentRequired ? "ERC warning review" : "ready to review"}</span></header>
        <div className="realization-facts"><span><small>Mapped devices</small><strong>{props.artifact.physicalization.mappedComponents}/{props.artifact.physicalization.totalComponents}</strong></span><span><small>Routable nets</small><strong>{props.artifact.physicalization.routableNets}/{props.artifact.physicalization.totalNets}</strong></span><span><small>Layout</small><strong>{props.artifact.physicalization.layoutPreset.replaceAll("-", " ")}</strong></span></div>
        <button className="primary full" onClick={props.onPhysicalize}><CommandIcon name="circuit-3d" />Review wired panel candidate</button>
        <small className="property-help">Generates one mounting plate with generic device packages, DIN rails, ducts, terminal studs, and unsized conductor visualization. ERC errors block generation.</small>
      </section>

      <section className="electrical-template-section"><header><strong>Automatic circuit templates</strong><span>review before replace</span></header><div>
        <TemplateButton id="bess-single-line" label="BESS single-line" detail="Battery → PCS → transformer → PCC" active={props.intent.template === "bess-single-line"} onClick={props.onTemplate} />
        <TemplateButton id="dc-control" label="DC auxiliary" detail="Fused permissive / auxiliary chain" active={props.intent.template === "dc-control"} onClick={props.onTemplate} />
        <TemplateButton id="motor-starter" label="Motor starter" detail="Protected DOL power concept" active={props.intent.template === "motor-starter"} onClick={props.onTemplate} />
      </div></section>
      <section className="inspector-section"><header><strong>Symbol basis</strong><span>drafting vocabulary</span></header><div className="segmented-control">{(["IEC", "ANSI"] as const).map((standard) => <button key={standard} className={props.intent.standard === standard ? "active" : ""} onClick={() => props.onStandard(standard)}>{standard}</button>)}</div><small className="property-help">Labels and sheet metadata change; symbols remain original PS3D preview artwork, not a claimed standards library.</small></section>
      <section className="electrical-wire-card"><header><strong>Create net</strong><span>terminal-to-terminal</span></header><label><span>From terminal</span><select value={from} onChange={(event) => setFrom(event.target.value)}>{endpointOptions.map((option) => <option key={`from:${option.key}`} value={option.key}>{option.label}</option>)}</select></label><label><span>To terminal</span><select value={to} onChange={(event) => setTo(event.target.value)}>{endpointOptions.map((option) => <option key={`to:${option.key}`} value={option.key}>{option.label}</option>)}</select></label><div className="electrical-wire-row"><input aria-label="Net name" value={netName} maxLength={80} onChange={(event) => setNetName(event.target.value)} /><select aria-label="Net class" value={netClass} onChange={(event) => setNetClass(event.target.value as ElectricalNetClass)}><option value="power-dc">DC power</option><option value="power-ac">AC power</option><option value="control">Control</option><option value="ground">Ground</option></select></div>{sameComponentConnection && <small className="property-help">Choose terminals on different components; this bounded editor rejects direct self-shorts.</small>}{incompatibleRoleConnection && <small className="property-help">The selected terminal role does not match this net class. AC, DC, signal, and protective-earth roles remain explicitly separated.</small>}<button className="primary" disabled={from.length === 0 || to.length === 0 || from === to || sameComponentConnection || incompatibleRoleConnection || netName.trim().length === 0} onClick={() => props.onAddNet(from, to, netName.trim(), netClass)}>Connect terminals</button></section>
      <section className="inspector-section"><header><strong>Netlist</strong><span>{props.intent.nets.length}</span></header><div className="electrical-net-list">{props.intent.nets.map((net) => <div className="electrical-net-row" key={net.id}><button className={net.id === props.selectedId ? "selected" : ""} onClick={() => props.onSelect(net.id)}><i className={net.class} /><span><strong>{net.name}</strong><small>{net.class} · {net.endpoints.length} terminals</small></span></button><button className="net-delete" onClick={() => props.onDeleteNet(net.id)} aria-label={`Delete net ${net.name}`} title={`Delete net ${net.name}`}>×</button></div>)}</div></section>
      <section className={`electrical-erc-card ${props.artifact.erc.status}`}><header><strong>Electrical rule check</strong><span>{props.artifact.erc.errors} error · {props.artifact.erc.warnings} warning</span></header>{props.artifact.erc.issues.length === 0 ? <p>No structural connectivity issues. Engineering review is still required.</p> : props.artifact.erc.issues.slice(0, 8).map((issue) => <button key={issue.id} onClick={() => props.onSelect(issue.relatedIds[0] ?? null)}><i className={issue.severity} /><span><strong>{issue.message}</strong><small>{issue.recovery}</small></span></button>)}</section>
      <section className="inspector-section"><header><strong>Design notes</strong><span>title block</span></header><label className="textarea-label" htmlFor="electrical-design-notes">Engineering boundary notes</label><textarea id="electrical-design-notes" value={notes} maxLength={800} onChange={(event) => setNotes(event.target.value)} /><div className="drawing-action-row"><button onClick={() => setNotes(props.intent.notes)}>Reset</button><button className="primary" onClick={() => props.onNotes(notes)}>Apply notes</button></div></section>
      <button className="primary full electrical-download" onClick={props.onDownload}><CommandIcon name="download" />Download schematic SVG</button>
      <div className="scope-note"><strong>Professional boundary</strong><p>Connectivity, references, terminal reuse, catalog compatibility and deterministic traceability are checked. Ratings, fault duty, selectivity, cables, grounding, thermal performance, safety and regulations are not calculated.</p></div>
    </aside>
  </>;
}

function TemplateButton(props: { readonly id: ElectricalTemplateId; readonly label: string; readonly detail: string; readonly active: boolean; readonly onClick: (id: ElectricalTemplateId) => void }): React.JSX.Element {
  return <button className={props.active ? "active" : ""} onClick={() => props.onClick(props.id)}><CommandIcon name={props.id === "bess-single-line" ? "battery" : props.id === "motor-starter" ? "motor" : "contactor"} /><span><strong>{props.label}</strong><small>{props.detail}</small></span><b>{props.active ? "ACTIVE" : "REVIEW"}</b></button>;
}

function eventToSvgPoint(event: ReactPointerEvent<HTMLDivElement>, root: HTMLDivElement | null): Vec2 | undefined {
  const svg = root?.querySelector<SVGSVGElement>("svg");
  const matrix = svg?.getScreenCTM()?.inverse();
  if (matrix === undefined) return undefined;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
  return [point.x, point.y];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/gu, (character) => `\\${character}`);
}
