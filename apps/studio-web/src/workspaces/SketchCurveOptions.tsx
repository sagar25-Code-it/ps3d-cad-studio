import type { SketchEntity } from "../../../../packages/workbench-core/src/index.js";
import type { ProfileSegmentMode } from "../../../../packages/workbench-sketch/src/blend-profile.js";
import { BLEND_TENSION_MAX, BLEND_TENSION_MIN } from "../../../../packages/workbench-sketch/src/blend-profile.js";
import { CONIC_RHO_MAX, CONIC_RHO_MIN } from "../../../../packages/workbench-sketch/src/conic-curves.js";
import { DEFAULT_CURVE_TOOL_OPTIONS, type CurveToolOptions } from "../../../../packages/workbench-sketch/src/curve-tools.js";
import { TEXT_MAX_CHARACTERS } from "../../../../packages/workbench-sketch/src/stroke-text.js";
import type { SketchTool } from "../../../../packages/workbench-sketch/src/index.js";

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
  readonly keepPolygon: boolean;
}

export const DEFAULT_CURVE_OPTION_FIELDS: CurveOptionFields = {
  cornerRadius: String(DEFAULT_CURVE_TOOL_OPTIONS.cornerRadiusMm),
  rho: String(DEFAULT_CURVE_TOOL_OPTIONS.rho),
  tension: String(DEFAULT_CURVE_TOOL_OPTIONS.blendTension),
  text: DEFAULT_CURVE_TOOL_OPTIONS.text,
  textHeight: String(DEFAULT_CURVE_TOOL_OPTIONS.textHeightMm),
  textRotation: String(DEFAULT_CURVE_TOOL_OPTIONS.textRotationDeg),
  profileMode: "line",
  keepPolygon: DEFAULT_CURVE_TOOL_OPTIONS.keepControlPolygon
};

/** What the canvas knows that the typed fields do not: the existing curves, the view's reach and how close a click must be to a curve end. */
export interface CurveContext {
  readonly entities: readonly SketchEntity[];
  readonly centerlineReachMm: number;
  readonly pickReachMm: number;
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
    keepControlPolygon: fields.keepPolygon
  };
}

interface PanelProps {
  readonly tool: SketchTool;
  readonly fields: CurveOptionFields;
  readonly onChange: (next: CurveOptionFields) => void;
}

/** The palette controls of whichever extra curve tool is active; nothing for the other tools. */
export function SketchCurveOptionsPanel({ tool, fields, onChange }: PanelProps): React.JSX.Element | null {
  const set = <K extends keyof CurveOptionFields>(key: K, value: CurveOptionFields[K]): void => onChange({ ...fields, [key]: value });
  const numberField = (label: string, key: "cornerRadius" | "rho" | "tension" | "textHeight" | "textRotation", step: number, min?: number, max?: number): React.JSX.Element => (
    <label className="palette-number"><span>{label}</span><input type="number" {...(min === undefined ? {} : { min })} {...(max === undefined ? {} : { max })} step={step} value={fields[key]} aria-label={label} onChange={(event) => set(key, event.target.value)} /></label>
  );
  switch (tool) {
    case "rectangle-rounded": return numberField("Corner radius (mm)", "cornerRadius", 0.5, 0.01);
    case "conic": return numberField("Rho (0.5 = parabola)", "rho", 0.05, CONIC_RHO_MIN, CONIC_RHO_MAX);
    case "blend": return numberField("Blend tension", "tension", 0.1, BLEND_TENSION_MIN, BLEND_TENSION_MAX);
    case "spline-control": return <label className="palette-number"><span>Keep control polygon</span><input type="checkbox" checked={fields.keepPolygon} aria-label="Keep the control polygon as construction lines" onChange={(event) => set("keepPolygon", event.target.checked)} /></label>;
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
