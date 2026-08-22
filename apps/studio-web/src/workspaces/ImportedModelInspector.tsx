import type { ExchangeImportResult } from "../../../../packages/exchange-3d/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

export function ImportedModelInspector(props: { readonly result: ExchangeImportResult; readonly onExchange: () => void; readonly onClear: () => void }): React.JSX.Element {
  const bounds = props.result.metrics.bounds.sizeMeters.map((value) => value * 1000);
  return <aside className="inspector-panel imported-inspector">
    <div className="inspector-title"><div><span>REFERENCE MODEL</span><h2>{props.result.primaryFileName}</h2><small>{props.result.format.name} · local preview</small></div><CapabilityBadge level="preview" /></div>
    <div className="imported-model-hero"><span><CommandIcon name="cube-check" /></span><div><strong>Exchange reference active</strong><small>Measure, orbit, select, and re-export</small></div></div>
    <section className="inspector-section"><header><strong>Geometry audit</strong><span>runtime mesh</span></header><dl className="imported-metric-list">
      <div><dt>Objects</dt><dd>{props.result.metrics.objectCount}</dd></div><div><dt>Meshes</dt><dd>{props.result.metrics.meshCount}</dd></div><div><dt>Triangles</dt><dd>{props.result.metrics.triangleCount.toLocaleString()}</dd></div><div><dt>Vertices</dt><dd>{props.result.metrics.vertexCount.toLocaleString()}</dd></div><div><dt>Materials</dt><dd>{props.result.metrics.materialCount}</dd></div><div><dt>Source unit</dt><dd>{props.result.sourceUnit}</dd></div>
    </dl></section>
    <section className="inspector-section"><header><strong>Envelope</strong><span>millimeters</span></header><div className="imported-bounds"><span>X <strong>{bounds[0]!.toFixed(2)}</strong></span><span>Y <strong>{bounds[1]!.toFixed(2)}</strong></span><span>Z <strong>{bounds[2]!.toFixed(2)}</strong></span></div></section>
    <section className="inspector-section"><header><strong>Model status</strong><span>{props.result.warnings.length} notes</span></header><div className="imported-notes">{props.result.warnings.map((warning, index) => <p key={index}><i />{warning}</p>)}</div></section>
    <div className="imported-actions"><button className="primary" onClick={props.onExchange}><CommandIcon name="exchange" />Open Exchange Center</button><button onClick={props.onClear}><CommandIcon name="return" />Return to native body</button></div>
  </aside>;
}
