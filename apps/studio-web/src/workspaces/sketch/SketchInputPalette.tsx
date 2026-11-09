import { POLAR_INCREMENT_CHOICES, type SnapAssistSettings } from "../../../../../packages/workbench-sketch/src/snap-assist.js";
import { keyLabelForCommand } from "../../../../../packages/workbench-sketch/src/hotkeys.js";
import { useSketchKeymap } from "./useSketchKeymap.js";
import { labelLength, snapStepChoicesMm } from "../../../../../packages/workbench-sketch/src/unit-defaults.js";
import type { SketchLengthUnit } from "../../../../../packages/workbench-sketch/src/sketch-units.js";

const suffix = (key: string | undefined): string => key === undefined ? "" : ` (${key})`;

/**
 * The palette rows for the input aids: the snap step, polar tracking with its angle increment, the ortho lock, and the way
 * into the shortcut editor. The Snap switch itself stays with the other palette toggles.
 */
export function SketchInputPalette(props: {
  readonly settings: SnapAssistSettings;
  readonly gridMm: number;
  /** The document's unit: the grid and the snap steps are listed in it. */
  readonly unit?: SketchLengthUnit;
  readonly onChange: (patch: Partial<SnapAssistSettings>) => void;
  readonly onOpenShortcuts: () => void;
}): React.JSX.Element {
  const keymap = useSketchKeymap();
  const { settings } = props;
  const unit: SketchLengthUnit = props.unit ?? "mm";
  const steps = snapStepChoicesMm(unit);
  return <>
    <label className="palette-number">
      <span>Snap step</span>
      <select
        aria-label="Snap increment"
        value={settings.snapStepMm === undefined ? "auto" : String(settings.snapStepMm)}
        onChange={(event) => props.onChange({ snapStepMm: event.target.value === "auto" ? undefined : Number(event.target.value) })}
      >
        <option value="auto">Grid ({labelLength(props.gridMm, unit)})</option>
        {steps.map((step) => <option key={step} value={String(step)}>{labelLength(step, unit)}</option>)}
        {settings.snapStepMm !== undefined && !steps.some((step) => Math.abs(step - settings.snapStepMm!) < 1e-9) && <option value={String(settings.snapStepMm)}>{labelLength(settings.snapStepMm, unit)}</option>}
      </select>
    </label>
    <label><span>Polar tracking{suffix(keyLabelForCommand("toggle-polar", keymap))}</span><input type="checkbox" checked={settings.polar} onChange={(event) => props.onChange({ polar: event.target.checked })} /></label>
    {settings.polar && <label className="palette-number">
      <span>Polar angle</span>
      <select aria-label="Polar tracking increment" value={String(settings.polarIncrementDeg)} onChange={(event) => props.onChange({ polarIncrementDeg: Number(event.target.value) })}>
        {POLAR_INCREMENT_CHOICES.map((degrees) => <option key={degrees} value={String(degrees)}>{degrees}°</option>)}
        {!POLAR_INCREMENT_CHOICES.includes(settings.polarIncrementDeg) && <option value={String(settings.polarIncrementDeg)}>{settings.polarIncrementDeg}°</option>}
      </select>
    </label>}
    <label><span>Ortho lock{suffix(keyLabelForCommand("toggle-ortho", keymap))}</span><input type="checkbox" checked={settings.ortho} onChange={(event) => props.onChange({ ortho: event.target.checked })} /></label>
    <label><span>Relation hints</span><input type="checkbox" checked={settings.relationHints} title="While drawing a line: snap parallel, perpendicular and collinear to nearby lines, and add the matching relation" onChange={(event) => props.onChange({ relationHints: event.target.checked })} /></label>
    <label><span>Equal-length hint</span><input type="checkbox" checked={settings.equalHint} title="While drawing a line: snap to the length of a nearby line and make the two Equal. Off by default: a rectangle drawn with lines would get a redundant relation" onChange={(event) => props.onChange({ equalHint: event.target.checked })} /></label>
    <button type="button" className="palette-action" onClick={props.onOpenShortcuts} title="Change the keys for the sketch tools">Shortcuts…</button>
    <small className="palette-hint">Hold Ctrl: no snapping. Hold Shift: constrain.</small>
  </>;
}
