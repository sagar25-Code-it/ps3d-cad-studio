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
}

interface CommandPanelFrameProps {
  /** The small label above the title: COMMAND, or EDIT FEATURE. */
  readonly kicker: string;
  readonly title: string;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly children: React.ReactNode;
}

/**
 * The frame every command panel shares: header with the title and a cancel button, the rows, an error line, and the OK and
 * Cancel footer. Enter commits and Esc cancels from any control inside it. Fillet, Chamfer, Shell, Hole and the Extrude /
 * Revolve panel all draw their rows inside this one frame.
 */
export function CommandPanelFrame({ kicker, title, busy, error, onCommit, onCancel, children }: CommandPanelFrameProps): React.JSX.Element {
  return <aside
    className="command-panel"
    role="form"
    aria-label={title}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !busy) { event.preventDefault(); event.stopPropagation(); onCommit(); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}
  >
    <header>
      <div><span>{kicker}</span><strong>{title}</strong></div>
      <button type="button" onClick={onCancel} aria-label={`Cancel ${title}`}><CommandIcon name="cancel" /></button>
    </header>
    {children}
    {error !== undefined && <p className="command-panel-error" role="alert">{error}</p>}
    <footer>
      <button type="button" className="command-panel-ok" onClick={onCommit} disabled={busy}>OK</button>
      <button type="button" onClick={onCancel}>Cancel</button>
      <small>Enter commits · Esc cancels</small>
    </footer>
  </aside>;
}

export function CommandPanel({ state, busy, onValue, onClearSelection, onCommit, onCancel }: CommandPanelProps): React.JSX.Element {
  const firstField = useRef<HTMLInputElement | null>(null);
  // The first value field takes the keyboard when the panel opens, like a Fusion dialog; the canvas stays live for picks.
  useEffect(() => { firstField.current?.focus(); firstField.current?.select(); }, [state.command, state.editFeatureId]);
  const selection = panelSelectionRow(state);
  const fields = panelFields(state);
  return <CommandPanelFrame kicker={state.mode === "edit" ? "EDIT FEATURE" : "COMMAND"} title={panelTitle(state)} busy={busy} error={state.error} onCommit={onCommit} onCancel={onCancel}>
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
  </CommandPanelFrame>;
}
