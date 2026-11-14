import { useEffect, useRef } from "react";
import { panelFields, panelSelectionRow, panelTitle, type CommandPanelState } from "../command-panel.js";
import { CommandIcon } from "./CommandIcon.js";

/**
 * PT-06: the shared modeless command panel. It floats over the right side of the canvas with no backdrop, so the model
 * stays live for picking and orbiting while it is open. One selection row shows what is picked (with a clear button),
 * the value fields take numbers, units, arithmetic and parameter names, Enter commits, Esc cancels, and the same panel
 * opens filled when the step is edited later from the timeline.
 */
interface CommandPanelProps {
  readonly state: CommandPanelState;
  readonly busy: boolean;
  readonly onValue: (fieldId: string, text: string) => void;
  readonly onClearSelection: () => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  /** Live preview (optional): the one line about the ghost the 3D view shows for the current values. */
  readonly previewNote?: string | undefined;
}

export function CommandPanel({ state, busy, onValue, onClearSelection, onCommit, onCancel, previewNote }: CommandPanelProps): React.JSX.Element {
  const firstField = useRef<HTMLInputElement | null>(null);
  // The first value field takes the keyboard when the panel opens, like a Fusion dialog; the canvas stays live for picks.
  useEffect(() => { firstField.current?.focus(); firstField.current?.select(); }, [state.command, state.editFeatureId]);
  const selection = panelSelectionRow(state);
  const fields = panelFields(state);
  return <aside
    className="command-panel"
    role="form"
    aria-label={panelTitle(state)}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !busy) { event.preventDefault(); event.stopPropagation(); onCommit(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}
  >
    <header>
      <div><span>{state.mode === "edit" ? "EDIT FEATURE" : "COMMAND"}</span><strong>{panelTitle(state)}</strong></div>
      <button type="button" onClick={onCancel} aria-label={`Cancel ${panelTitle(state)}`}><CommandIcon name="cancel" /></button>
    </header>
    <div className="command-panel-row command-panel-selection" data-active="true">
      <span className="command-panel-label">{selection.label}</span>
      <span className="command-panel-chip" data-empty={selection.count === 0}>{selection.status}</span>
      {selection.clearable && <button type="button" className="command-panel-clear" onClick={onClearSelection} aria-label={`Clear ${selection.label}`}>×</button>}
    </div>
    {state.bodyName !== undefined && <p className="command-panel-body-line">On {state.bodyName}</p>}
    {fields.map((field, index) => <label key={field.id} className="command-panel-row">
      <span className="command-panel-label">{field.label}{field.unit === "" ? "" : ` (${field.unit})`}</span>
      {field.kind === "select"
        ? <select value={state.values[field.id] ?? ""} onChange={(event) => onValue(field.id, event.target.value)}>
            {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        : <input
            ref={index === 0 ? firstField : undefined}
            type="text"
            inputMode="decimal"
            value={state.values[field.id] ?? ""}
            title={field.hint}
            placeholder={field.hint}
            onChange={(event) => onValue(field.id, event.target.value)}
          />}
    </label>)}
    {previewNote !== undefined && <p className="command-panel-preview" role="status">{previewNote}</p>}
    {state.error !== undefined && <p className="command-panel-error" role="alert">{state.error}</p>}
    <footer>
      <button type="button" className="command-panel-ok" onClick={onCommit} disabled={busy}>OK</button>
      <button type="button" onClick={onCancel}>Cancel</button>
      <small>Enter commits · Esc cancels</small>
    </footer>
  </aside>;
}
