import type { SketchEntity } from "../../../../packages/workbench-core/src/index.js";
import type { ProfileSegmentMode } from "../../../../packages/workbench-sketch/src/blend-profile.js";
import { BLEND_TENSION_MAX, BLEND_TENSION_MIN } from "../../../../packages/workbench-sketch/src/blend-profile.js";
import { CONIC_RHO_MAX, CONIC_RHO_MIN } from "../../../../packages/workbench-sketch/src/conic-curves.js";
import type { SketchBlock } from "../../../../packages/workbench-sketch/src/sketch-blocks.js";
import { DEFAULT_CURVE_TOOL_OPTIONS, type CurveToolOptions } from "../../../../packages/workbench-sketch/src/curve-tools.js";
import { TEXT_MAX_CHARACTERS } from "../../../../packages/workbench-sketch/src/stroke-text.js";
import type { SketchTool } from "../../../../packages/workbench-sketch/src/index.js";
import { SPLINE_PARAMETERIZATION_LABELS, type SplineParameterization } from "../../../../packages/workbench-sketch/src/spline-fit.js";

/**
 * The numbers the extra curve tools read from the Sketch palette, kept as the text the user typed so a half-typed value
 * never disturbs the canvas, and turned into the typed options the builders take only when a shape is built.
 */
export interface CurveOptionFields {
  readonly cornerRadius: string;
  readonly rho: string;
  readonly tension: string;
  readonly text: string;
  readonly textHeight: string;
  readonly textRotation: string;
  readonly profileMode: ProfileSegmentMode;
  /** Fit-point spline: how the curve is spaced between uneven clicks. */
  readonly splineMode: SplineParameterization;
  readonly keepPolygon: boolean;
  /** Insert block: which saved block, the angle and scale to insert it at, and the name to save the selection under. */
  readonly blockChoice: string;
  readonly blockRotation: string;
  readonly blockScale: string;
  readonly blockName: string;
}

export const DEFAULT_CURVE_OPTION_FIELDS: CurveOptionFields = {
  cornerRadius: String(DEFAULT_CURVE_TOOL_OPTIONS.cornerRadiusMm),
  rho: String(DEFAULT_CURVE_TOOL_OPTIONS.rho),
  tension: String(DEFAULT_CURVE_TOOL_OPTIONS.blendTension),
  text: DEFAULT_CURVE_TOOL_OPTIONS.text,
  textHeight: String(DEFAULT_CURVE_TOOL_OPTIONS.textHeightMm),
  textRotation: String(DEFAULT_CURVE_TOOL_OPTIONS.textRotationDeg),
  profileMode: "line",
  splineMode: "uniform",
  keepPolygon: DEFAULT_CURVE_TOOL_OPTIONS.keepControlPolygon,
  blockChoice: "",
  blockRotation: "0",
  blockScale: "1",
  blockName: "Block 1"
};

/** What the canvas knows that the typed fields do not: the existing curves, the view's reach and how close a click must be to a curve end. */
export interface CurveContext {
  readonly entities: readonly SketchEntity[];
  readonly centerlineReachMm: number;
  readonly pickReachMm: number;
  readonly block: SketchBlock | undefined;
}

export function curveOptionsFromFields(fields: CurveOptionFields, context: CurveContext): CurveToolOptions {
  const number = (text: string, fallback: number): number => {
    const value = Number(text.trim().replace(",", "."));
    return text.trim() === "" || !Number.isFinite(value) ? fallback : value;
  };
  return {
    cornerRadiusMm: number(fields.cornerRadius, Number.NaN),
    rho: number(fields.rho, Number.NaN),
    blendTension: number(fields.tension, Number.NaN),
    text: fields.text,
    textHeightMm: number(fields.textHeight, Number.NaN),
    textRotationDeg: number(fields.textRotation, 0),
    centerlineReachMm: context.centerlineReachMm,
    entities: context.entities,
    pickReachMm: context.pickReachMm,
    keepControlPolygon: fields.keepPolygon,
    block: context.block,
    blockRotationDeg: number(fields.blockRotation, Number.NaN),
    blockScale: number(fields.blockScale, Number.NaN)
  };
}

interface PanelProps {
  readonly tool: SketchTool;
  readonly fields: CurveOptionFields;
  readonly onChange: (next: CurveOptionFields) => void;
  /** Insert block: the names of the saved blocks, how many curves are selected, and the action that saves the selection. */
  readonly blockNames: readonly string[];
  readonly selectedCount: number;
  readonly onSaveBlock: (name: string) => void;
}

/** The palette controls of whichever extra curve tool is active; nothing for the other tools. */
export function SketchCurveOptionsPanel({ tool, fields, onChange, blockNames, selectedCount, onSaveBlock }: PanelProps): React.JSX.Element | null {
  const set = <K extends keyof CurveOptionFields>(key: K, value: CurveOptionFields[K]): void => onChange({ ...fields, [key]: value });
  const numberField = (label: string, key: "cornerRadius" | "rho" | "tension" | "textHeight" | "textRotation" | "blockRotation" | "blockScale", step: number, min?: number, max?: number): React.JSX.Element => (
    <label className="palette-number"><span>{label}</span><input type="number" {...(min === undefined ? {} : { min })} {...(max === undefined ? {} : { max })} step={step} value={fields[key]} aria-label={label} onChange={(event) => set(key, event.target.value)} /></label>
  );
  switch (tool) {
    case "block": return (
      <>
        <label className="palette-number"><span>Block</span>
          <select aria-label="Saved block" value={fields.blockChoice} onChange={(event) => set("blockChoice", event.target.value)}>
            <option value="">{blockNames.length === 0 ? "No blocks saved" : "Choose a block"}</option>
            {blockNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {numberField("Block angle (deg)", "blockRotation", 15, -360, 360)}
        {numberField("Block scale", "blockScale", 0.1, 0.01, 100)}
        <label className="palette-number"><span>Save as</span><input type="text" maxLength={40} value={fields.blockName} aria-label="Name for the new block" onChange={(event) => set("blockName", event.target.value)} /></label>
        <button className="palette-action" disabled={selectedCount === 0} title="Save the selected curves as a reusable block" onClick={() => onSaveBlock(fields.blockName)}>Save {selectedCount} selected as block</button>
      </>
    );
    case "rectangle-rounded": return numberField("Corner radius (mm)", "cornerRadius", 0.5, 0.01);
    case "circle-tangent-2": return numberField("Circle radius (mm)", "cornerRadius", 0.5, 0.01);
    case "conic": return numberField("Rho (0.5 = parabola)", "rho", 0.05, CONIC_RHO_MIN, CONIC_RHO_MAX);
    case "blend": return numberField("Blend tension", "tension", 0.1, BLEND_TENSION_MIN, BLEND_TENSION_MAX);
    case "spline-control": return <label className="palette-number"><span>Keep control polygon</span><input type="checkbox" checked={fields.keepPolygon} aria-label="Keep the control polygon as construction lines" onChange={(event) => set("keepPolygon", event.target.checked)} /></label>;
    case "spline": return (
      <label className="palette-number"><span>Spline spacing</span>
        <select aria-label="Fit-point spline parameterisation" value={fields.splineMode} onChange={(event) => set("splineMode", event.target.value === "centripetal" ? "centripetal" : event.target.value === "chord-length" ? "chord-length" : "uniform")}>
          {(Object.keys(SPLINE_PARAMETERIZATION_LABELS) as SplineParameterization[]).map((mode) => <option key={mode} value={mode}>{SPLINE_PARAMETERIZATION_LABELS[mode]}</option>)}
        </select>
      </label>
    );
    case "profile": return (
      <label className="palette-number"><span>Next segment</span>
        <select aria-label="Profile segment type" value={fields.profileMode} onChange={(event) => set("profileMode", event.target.value === "tangent-arc" ? "tangent-arc" : "line")}>
          <option value="line">Line</option>
          <option value="tangent-arc">Tangent arc</option>
        </select>
      </label>
    );
    case "text": return (
      <>
        <label className="palette-number"><span>Text</span><input type="text" maxLength={TEXT_MAX_CHARACTERS} value={fields.text} aria-label="Sketch text" onChange={(event) => set("text", event.target.value)} /></label>
        {numberField("Text height (mm)", "textHeight", 1, 0.5, 1000)}
        {numberField("Text angle (deg)", "textRotation", 5, -360, 360)}
      </>
    );
    default: return null;
  }
}
