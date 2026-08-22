import { useEffect, useState } from "react";
import type { ModelSuccessResponse } from "../../../../packages/worker-protocol/src/index.js";
import type { PartIntent } from "../../../../packages/workbench-core/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";

type PartParameter = "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm" | "edgeTreatmentMm" | "patternCount" | "revolveAngleDeg";

const PARAMETERS: readonly { key: PartParameter; label: string; minimum: number; maximum: number; step: number; unit: string; level: "qualified" | "preview" }[] = [
  { key: "widthMm", label: "Plate width", minimum: 5, maximum: 500, step: 1, unit: "mm", level: "qualified" },
  { key: "heightMm", label: "Plate height", minimum: 5, maximum: 500, step: 1, unit: "mm", level: "qualified" },
  { key: "thicknessMm", label: "Thickness", minimum: 1, maximum: 100, step: 0.5, unit: "mm", level: "qualified" },
  { key: "holeDiameterMm", label: "Bore diameter", minimum: 1, maximum: 250, step: 0.5, unit: "mm", level: "qualified" },
  { key: "edgeTreatmentMm", label: "Edge treatment", minimum: 0, maximum: 10, step: 0.25, unit: "mm", level: "preview" },
  { key: "patternCount", label: "Pattern instances", minimum: 1, maximum: 12, step: 1, unit: "×", level: "preview" },
  { key: "revolveAngleDeg", label: "Revolve study", minimum: 30, maximum: 360, step: 5, unit: "°", level: "preview" }
];

interface PartInspectorProps {
  readonly part: PartIntent;
  readonly model: ModelSuccessResponse | undefined;
  readonly working: boolean;
  readonly onCommit: (parameter: PartParameter, value: number) => void;
}

export function PartInspector(props: PartInspectorProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<PartParameter, string>>(() => values(props.part));
  useEffect(() => setDrafts(values(props.part)), [props.part]);
  const measurements = props.model?.render.measurements;
  return <aside className="inspector-panel" aria-label="Part inspector">
    <div className="inspector-title"><div><p>Part intent</p><h2>{props.part.name}</h2></div><CapabilityBadge level="qualified" /></div>
    <section className="parameter-stack">
      {PARAMETERS.map((parameter) => <div className="parameter-control" key={parameter.key}>
        <label htmlFor={`part-${parameter.key}`}><span>{parameter.label}<small>{parameter.level}</small></span><CapabilityBadge level={parameter.level} /></label>
        <div><input id={`part-${parameter.key}`} type="number" min={parameter.minimum} max={parameter.maximum} step={parameter.step} value={drafts[parameter.key]} onChange={(event) => setDrafts((current) => ({ ...current, [parameter.key]: event.target.value }))} /><span>{parameter.unit}</span><button disabled={props.working} onClick={() => props.onCommit(parameter.key, Number(drafts[parameter.key]))}>Apply</button></div>
      </div>)}
    </section>
    <section className="inspector-section metrics-section"><header><strong>Validated body</strong><span>{props.model?.render.topology.triangles ?? "—"} triangles</span></header>
      <dl className="metric-grid">
        <div><dt>Topology</dt><dd>{props.model === undefined ? "pending" : `closed · genus ${props.model.render.topology.genus}`}</dd></div>
        <div><dt>Volume</dt><dd>{measurements === undefined ? "—" : `${(measurements.volumeCubicMeters * 1e9).toFixed(1)} mm³`}</dd></div>
        <div><dt>Semantic hash</dt><dd title={props.model?.evidence.semanticHash}>{shortHash(props.model?.evidence.semanticHash)}</dd></div>
        <div><dt>Mesh hash</dt><dd title={props.model?.evidence.body.canonicalMeshHash}>{shortHash(props.model?.evidence.body.canonicalMeshHash)}</dd></div>
      </dl>
    </section>
    <div className="scope-note qualified"><strong>Qualified path</strong><p>Width, height, thickness, and bore regenerate in the isolated f64 worker and must pass independent closed-mesh and evidence checks.</p></div>
  </aside>;
}

function values(part: PartIntent): Record<PartParameter, string> {
  return {
    widthMm: String(part.widthMm),
    heightMm: String(part.heightMm),
    thicknessMm: String(part.thicknessMm),
    holeDiameterMm: String(part.holeDiameterMm),
    edgeTreatmentMm: String(part.edgeTreatmentMm),
    patternCount: String(part.patternCount),
    revolveAngleDeg: String(part.revolveAngleDeg)
  };
}

function shortHash(hash: string | undefined): string {
  return hash === undefined ? "pending" : `${hash.slice(0, 8)}…${hash.slice(-5)}`;
}
