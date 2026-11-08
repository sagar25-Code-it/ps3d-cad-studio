import { useEffect, useMemo, useState } from "react";
import { partAnalysisBodies } from "../../../../packages/workbench-geometry/src/index.js";
import type { PartIntent } from "../../../../packages/workbench-core/src/index.js";
import type { ThreeViewportAdapter } from "../../../../packages/viewport-three/src/index.js";
import {
  ANALYSIS_MODE_LABELS,
  DEFAULT_ANALYSIS_SETTINGS,
  PULL_AXES,
  runAnalysis,
  type AnalysisMode,
  type AnalysisOutcome,
  type AnalysisSettings,
  type PullAxis
} from "./analysis-session.js";

interface AnalysisLayerProps {
  readonly part: PartIntent;
  readonly viewportRef: { readonly current: ThreeViewportAdapter | undefined };
  readonly mode: AnalysisMode;
  /** Changes every time a ribbon button asks for a mode, so asking for the same mode again re-opens the panel. */
  readonly nonce: number;
  readonly onClose: () => void;
  readonly onMessage: (text: string) => void;
}

const MODES = Object.keys(ANALYSIS_MODE_LABELS) as AnalysisMode[];

/**
 * The analysis panel of the Part workspace: runs the selected analysis over the solid bodies, draws its overlay on the
 * viewport and lists the result. The overlay is removed when the panel closes.
 */
export function AnalysisLayer(props: AnalysisLayerProps): React.JSX.Element {
  const [settings, setSettings] = useState<AnalysisSettings>({ ...DEFAULT_ANALYSIS_SETTINGS, mode: props.mode });
  useEffect(() => { setSettings((current) => ({ ...current, mode: props.mode })); }, [props.mode, props.nonce]);

  const bodies = useMemo(() => partAnalysisBodies(props.part), [props.part.generalBodies, props.part.previewBodies]);
  const choices = bodies.map((body) => ({ id: body.id, name: body.name }));
  const effective = settings.bodyId !== null && !choices.some((choice) => choice.id === settings.bodyId) ? { ...settings, bodyId: null } : settings;

  const outcome: AnalysisOutcome = useMemo(() => {
    try {
      return runAnalysis(bodies, effective);
    } catch (error) {
      return { mode: effective.mode, title: ANALYSIS_MODE_LABELS[effective.mode], overlay: { meshes: [], lines: [] }, legend: null, headline: `The analysis failed: ${error instanceof Error ? error.message : String(error)}`, tone: "bad", rows: [], empty: true };
    }
  }, [bodies, effective.mode, effective.bodyId, effective.pullAxis, effective.requiredDraftDeg, effective.thinThresholdMm, effective.sectionPlane, effective.sectionOffsetMm]);

  const viewport = props.viewportRef.current;
  useEffect(() => {
    viewport?.setAnalysisOverlay(outcome.overlay);
    return () => viewport?.setAnalysisOverlay(null);
  }, [viewport, outcome]);
  useEffect(() => { props.onMessage(`${outcome.title}: ${outcome.headline}`); }, [outcome]);

  const patch = (next: Partial<AnalysisSettings>): void => setSettings((current) => ({ ...current, ...next }));
  const number = (text: string, fallback: number, min: number, max: number): number => {
    const value = Number.parseFloat(text.replace(",", "."));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };

  return <aside className="analysis-panel" role="region" aria-label="Analysis">
    <header>
      <strong>Analysis</strong>
      <button type="button" className="analysis-close" onClick={props.onClose} aria-label="Close analysis">&times;</button>
    </header>
    <div className="analysis-modes" role="tablist" aria-label="Analysis type">
      {MODES.map((mode) => <button key={mode} type="button" role="tab" aria-selected={effective.mode === mode} className={effective.mode === mode ? "active" : ""} onClick={() => patch({ mode })}>{ANALYSIS_MODE_LABELS[mode]}</button>)}
    </div>
    <div className="analysis-controls">
      <label><span>Body</span>
        <select value={effective.bodyId ?? ""} onChange={(event) => patch({ bodyId: event.target.value === "" ? null : event.target.value })}>
          <option value="">All solid bodies</option>
          {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select>
      </label>
      {effective.mode === "draft" && <>
        <label><span>Pull direction</span>
          <select value={effective.pullAxis} onChange={(event) => patch({ pullAxis: event.target.value as PullAxis })}>{PULL_AXES.map((axis) => <option key={axis} value={axis}>{axis.toUpperCase()}</option>)}</select>
        </label>
        <label><span>Required draft (deg)</span>
          <input type="number" min={0} max={45} step={0.5} value={effective.requiredDraftDeg} onChange={(event) => patch({ requiredDraftDeg: number(event.target.value, 1, 0, 45) })} />
        </label>
      </>}
      {effective.mode === "wall-thickness" && <label><span>Thin below (mm)</span>
        <input type="number" min={0.05} step={0.1} value={effective.thinThresholdMm} onChange={(event) => patch({ thinThresholdMm: number(event.target.value, 1, 0.05, 1000) })} />
      </label>}
      {effective.mode === "section-comb" && <>
        <label><span>Section plane</span>
          <select value={effective.sectionPlane} onChange={(event) => patch({ sectionPlane: event.target.value as AnalysisSettings["sectionPlane"] })}><option value="xy">XY (cut across Z)</option><option value="xz">XZ (cut across Y)</option><option value="yz">YZ (cut across X)</option></select>
        </label>
        <label><span>Offset (mm)</span>
          <input type="number" step={1} value={effective.sectionOffsetMm} onChange={(event) => patch({ sectionOffsetMm: number(event.target.value, 0, -100000, 100000) })} />
        </label>
      </>}
    </div>
    <p className={`analysis-headline ${outcome.tone}`} role="status">{outcome.headline}</p>
    {outcome.legend !== null && <div className="analysis-legend" aria-label={`${outcome.legend.title} legend`}>
      <strong>{outcome.legend.title}{outcome.legend.unit === "" ? "" : ` (${outcome.legend.unit})`}</strong>
      <ul>{outcome.legend.entries.map((entry) => <li key={entry.label}><i style={{ background: entry.color }} />{entry.label}</li>)}</ul>
      {outcome.legend.note !== undefined && <small>{outcome.legend.note}</small>}
    </div>}
    {outcome.rows.length > 0 && <ul className="analysis-rows">
      {outcome.rows.map((row) => <li key={row.id} className={row.tone}><strong>{row.label}</strong><span>{row.detail}</span></li>)}
    </ul>}
  </aside>;
}
