import { useEffect, useState } from "react";
import type { AssemblyIntent, AssemblyTemplateId } from "../../../../packages/workbench-core/src/index.js";
import type { InterferenceCandidate } from "../../../../packages/workbench-geometry/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";

interface AssemblyInspectorProps {
  readonly assembly: AssemblyIntent;
  readonly selectedId: string | null;
  readonly interferences: readonly InterferenceCandidate[];
  readonly onTemplate: (template: Exclude<AssemblyTemplateId, "custom" | "electrical-panel">) => void;
  readonly onExplode: (value: number) => void;
  readonly onMove: (id: string, translationMm: readonly [number, number, number]) => void;
  readonly onToggleGrounded: (id: string) => void;
  readonly onToggleVisible: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onSelect: (id: string | null) => void;
  readonly onOpenElectricalSource: (componentId?: string) => void;
}

export function AssemblyInspector(props: AssemblyInspectorProps): React.JSX.Element {
  const [explode, setExplode] = useState(props.assembly.explodeMm);
  useEffect(() => setExplode(props.assembly.explodeMm), [props.assembly.explodeMm]);
  const selected = props.assembly.components.find((component) => component.id === props.selectedId);
  const [position, setPosition] = useState<[number, number, number]>([0, 0, 0]);
  useEffect(() => {
    if (selected !== undefined) setPosition([selected.translationMm[0], selected.translationMm[1], selected.translationMm[2]]);
  }, [selected?.id, selected?.translationMm[0], selected?.translationMm[1], selected?.translationMm[2]]);
  const satisfied = props.assembly.mates.filter((mate) => mate.status === "satisfied").length;
  const linkedDevices = props.assembly.electricalLinks?.length ?? 0;
  const installationHardware = Math.max(0, props.assembly.components.length - linkedDevices);
  return <aside className="inspector-panel" aria-label="Assembly inspector">
    <div className="inspector-title"><div><p>Assembly intent</p><h2>{props.assembly.name}</h2></div><CapabilityBadge level="preview" /></div>
    {selected !== undefined && <section className="selection-card priority-selection"><header><strong>{selected.name}</strong><span>{selected.shape}</span></header><dl className="compact-facts"><div><dt>Size</dt><dd>{selected.sizeMm.join(" × ")} mm</dd></div><div><dt>State</dt><dd>{selected.grounded ? "grounded" : "movable"} · {selected.visible ? "shown" : "hidden"}</dd></div></dl><div className="component-position-editor"><strong>Position · mm</strong><div>{(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input aria-label={`${selected.name} ${axis} position in millimeters`} type="number" min="-10000" max="10000" step="1" value={position[index]} onChange={(event) => setPosition((current) => current.map((value, axisIndex) => axisIndex === index ? Number(event.target.value) : value) as [number, number, number])} /></label>)}</div><button className="primary" onClick={() => props.onMove(selected.id, position)}>Apply position</button></div><div className="component-actions"><button onClick={() => props.onToggleGrounded(selected.id)}>{selected.grounded ? "Release" : "Ground"}</button><button onClick={() => props.onToggleVisible(selected.id)}>{selected.visible ? "Hide" : "Show"}</button><button className="danger" onClick={() => props.onDelete(selected.id)}>Delete</button></div></section>}
    {props.assembly.safetyNotes !== undefined && <section className="assembly-safety-notes priority-boundary"><header><strong>{props.assembly.template === "bess-20ft-hc" ? "BESS engineering boundary" : props.assembly.template === "electrical-panel" ? "Wired-panel realization boundary" : "Template boundary"}</strong><span>review first</span></header>{props.assembly.safetyNotes.map((note) => <p key={note}><i />{note}</p>)}</section>}
    {props.assembly.electromechanicalSource !== undefined && <section className={`electromechanical-source-card ${props.assembly.electromechanicalSource.status}`}><header><strong>ECAD ↔ panel trace</strong><span>{props.assembly.electromechanicalSource.status}</span></header><dl className="compact-facts"><div><dt>Catalog</dt><dd>{props.assembly.electromechanicalSource.catalogRevision}</dd></div><div><dt>Layout</dt><dd>{props.assembly.electromechanicalSource.layoutPreset.replaceAll("-", " ")}</dd></div><div><dt>Devices</dt><dd>{linkedDevices} linked</dd></div><div><dt>Hardware</dt><dd>{installationHardware} generated</dd></div><div><dt>Conductors</dt><dd>{props.assembly.electricalRoutes?.length ?? 0} unsized</dd></div></dl>{props.assembly.electromechanicalSource.status === "stale" && <p>The schematic or linked package layout changed after conductor generation. Regenerate before relying on traceability.</p>}<button className="primary full" onClick={() => props.onOpenElectricalSource(selected?.sourceElectricalComponentId)}>Open {selected?.sourceElectricalComponentId === undefined ? "source schematic" : "selected source device"}</button></section>}
    <section className="assembly-template-card"><header><strong>{props.assembly.template === "electrical-panel" ? "Wired mounting-plate realization" : "Editable planning template"}</strong><span>{props.assembly.designStatus ?? "editable-preview"}</span></header><div><button className={props.assembly.template === "cargo-20ft" ? "active" : ""} onClick={() => props.onTemplate("cargo-20ft")}><strong>20 ft cargo</strong><small>6058 × 2438 × 2591 mm nominal</small></button><button className={props.assembly.template === "cargo-40ft-hc" ? "active" : ""} onClick={() => props.onTemplate("cargo-40ft-hc")}><strong>40 ft high cube</strong><small>12192 × 2438 × 2896 mm nominal</small></button><button className={props.assembly.template === "bess-20ft-hc" ? "active warning" : "warning"} onClick={() => props.onTemplate("bess-20ft-hc")}><strong>BESS arrangement</strong><small>20 ft HC · equipment + aisle study</small></button></div>{props.assembly.nominalEnvelopeMm !== undefined && <dl className="compact-facts"><div><dt>Nominal envelope</dt><dd>{props.assembly.nominalEnvelopeMm.join(" × ")} mm</dd></div><div><dt>Template</dt><dd>{(props.assembly.template ?? "custom").replaceAll("-", " ")}</dd></div></dl>}</section>
    <section className="explode-card"><header><strong>Exploded distance</strong><output>{explode.toFixed(0)} mm</output></header><input type="range" min="0" max="80" step="1" value={explode} onChange={(event) => setExplode(Number(event.target.value))} onPointerUp={() => props.onExplode(explode)} onKeyUp={() => props.onExplode(explode)} /><small className="property-help">Use Assemble, Explode, and Fit all from the top ribbon.</small></section>
    <section className="inspector-section"><header><strong>Components</strong><span>{props.assembly.components.length}</span></header><div className="component-list">{props.assembly.components.map((component) => <button key={component.id} className={`${component.id === props.selectedId ? "selected" : ""} ${component.visible ? "" : "hidden-component"}`} onClick={() => props.onSelect(component.id === props.selectedId ? null : component.id)}><i style={{ background: component.color }} /><span><strong>{component.name}</strong><small>{component.shape} · {component.grounded ? "grounded" : "free"} · {component.visible ? "shown" : "hidden"}</small></span></button>)}</div></section>
    <section className="inspector-section"><header><strong>Direct mates</strong><span>{satisfied}/{props.assembly.mates.length} satisfied</span></header><div className="mate-list">{props.assembly.mates.map((mate) => <button key={mate.id} onClick={() => props.onSelect(mate.id)} className={mate.id === props.selectedId ? "selected" : ""}><span className={`mate-status ${mate.status}`} aria-label={mate.status} /><span><strong>{mate.name}</strong><small>{mate.kind}{mate.axis === undefined ? "" : ` · ${mate.axis.toUpperCase()} axis`}</small></span></button>)}</div></section>
    <section className={`interference-card ${props.interferences.length === 0 ? "clear" : "warning"}`}><header><strong>AABB interference</strong><span>{props.interferences.length} candidate{props.interferences.length === 1 ? "" : "s"}</span></header><p>{props.interferences.length === 0 ? "No conservative overlap at this exploded distance." : `${names(props.interferences[0]!)} overlap by approximately ${props.interferences[0]!.volumeCubicMm.toFixed(1)} mm³.`}</p></section>
    <div className="scope-note"><strong>Preview boundary</strong><p>{props.assembly.template === "electrical-panel" ? "Device bodies are generic panel-scale proxies; conductor diameter and color are visualization only. Mates use deterministic direct transforms and interference uses conservative axis-aligned boxes." : "Mates use ordered direct transforms. Interference uses conservative axis-aligned boxes, not exact collision geometry."}</p></div>
  </aside>;
}

function names(candidate: InterferenceCandidate): string {
  return candidate.componentIds.map((id) => id.split(":")[1]).join(" / ");
}
