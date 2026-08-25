import type { CSSProperties } from "react";
import type { ViewportShadingMode } from "../../../../packages/viewport-three/src/index.js";
import { CommandIcon } from "./CommandIcon.js";

interface PartAppearanceControlsProps {
  readonly bodyColor: string;
  readonly shadingMode: ViewportShadingMode;
  readonly compact?: boolean;
  readonly onBodyColor: (color: string) => void;
  readonly onShadingMode: (mode: ViewportShadingMode) => void;
}

const DISPLAY_MODES: readonly { readonly id: ViewportShadingMode; readonly label: string; readonly icon: string; readonly title: string }[] = [
  { id: "shaded", label: "Shaded", icon: "shaded", title: "Shaded faces without explicit edge overlay" },
  { id: "shaded-edges", label: "Edges", icon: "shaded-edges", title: "Shaded faces with visible feature edges" },
  { id: "wireframe", label: "Wireframe", icon: "wireframe", title: "Visible and hidden feature-edge display" }
];

const COLOR_PRESETS: readonly { readonly color: string; readonly label: string }[] = [
  { color: "#aeb3b8", label: "CAD gray" },
  { color: "#d9dcdf", label: "Light gray" },
  { color: "#f1f2f3", label: "White" },
  { color: "#5c6268", label: "Graphite" },
  { color: "#b8323e", label: "PS3D red" },
  { color: "#3f6f93", label: "Steel blue" }
];

export function PartAppearanceControls(props: PartAppearanceControlsProps): React.JSX.Element {
  return <div className={`part-appearance-controls ${props.compact === true ? "compact" : ""}`}>
    <div className="appearance-modes" role="group" aria-label="Part shading style">
      {DISPLAY_MODES.map((mode) => <button
        key={mode.id}
        className={props.shadingMode === mode.id ? "active" : ""}
        aria-pressed={props.shadingMode === mode.id}
        onClick={() => props.onShadingMode(mode.id)}
        title={mode.title}
      ><CommandIcon name={mode.icon} /><span>{mode.label}</span></button>)}
    </div>
    <div className="appearance-color-row">
      <label className="body-color-picker">
        <span>Custom body color</span>
        <input type="color" value={props.bodyColor} aria-label="Choose custom part body color" onChange={(event) => props.onBodyColor(event.target.value)} />
        <code>{props.bodyColor.toUpperCase()}</code>
      </label>
      <div className="appearance-swatches" role="group" aria-label="Body color presets">
        {COLOR_PRESETS.map((preset) => <button
          key={preset.color}
          className={props.bodyColor.toLowerCase() === preset.color ? "active" : ""}
          style={{ "--swatch-color": preset.color } as CSSProperties}
          aria-label={`Set body color to ${preset.label}`}
          aria-pressed={props.bodyColor.toLowerCase() === preset.color}
          onClick={() => props.onBodyColor(preset.color)}
          title={preset.label}
        />)}
      </div>
    </div>
  </div>;
}
