import { useEffect, useRef } from "react";
import {
  directionOptions, operationOptions, partCreateFields, partCreateTitle, profileSelectionRow, resolveTargetId, effectiveOperation,
  touchNote, valueToNotify,
  type CreateBodyChoice, type CreateSketchChoice, type CreateValueParse, type PartCreateAction, type PartCreateDirection,
  type PartCreateOperation, type PartCreateState
} from "../part-create-panel.js";
import { CommandPanelFrame } from "./CommandPanel.js";

/**
 * The Extrude / Revolve command panel for the Part environment. It is the shared command-panel frame with a Profile row
 * (which sketch, which profiles, with the area of each), the Distance or Angle, the Direction and the Operation. It is
 * modeless: nothing here uses the viewport's pick mode, so the model stays free to orbit, and it never opens a browser prompt.
 * Finished sketches are not drawn in the 3D view, so the profiles are a check list in the panel, not clicks on the canvas.
 *
 * `onValueChange` is called with the resolved size (mm, or degrees for a revolve) whenever it changes, so a live preview can
 * attach to the value later; nothing in the app needs it yet.
 */
export interface PartCreatePanelProps {
  readonly state: PartCreateState;
  readonly sketches: readonly CreateSketchChoice[];
  readonly bodies: readonly CreateBodyChoice[];
  readonly selectedId: string | null;
  readonly busy: boolean;
  /** Reads the text of the size field or the second-side field the way the commit will. */
  readonly parse: (text: string, field: "value" | "second") => CreateValueParse;
  readonly onAction: (action: PartCreateAction) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly onValueChange?: (value: number) => void;
}

export function PartCreatePanel(props: PartCreatePanelProps): React.JSX.Element {
  const { state, sketches, bodies, selectedId, busy, parse, onAction } = props;
  const firstField = useRef<HTMLInputElement | null>(null);
  const lastNotified = useRef<number | undefined>(undefined);
  const sketch = sketches.find((candidate) => candidate.id === state.sketchId);
  const fields = partCreateFields(state);
  const parsed = parse(state.value, "value");
  // The size field takes the keyboard when the panel opens, like a Fusion dialog; the canvas stays live.
  useEffect(() => { firstField.current?.focus(); firstField.current?.select(); }, [state.kind]);
  const resolved = parsed.ok ? parsed.value : undefined;
  useEffect(() => {
    const next = valueToNotify(lastNotified.current, parsed);
    if (next === undefined) return;
    lastNotified.current = next;
    props.onValueChange?.(next);
  }, [resolved]);
  const selection = profileSelectionRow(state, sketch);
  const operation = effectiveOperation(state, bodies, selectedId);
  const targetId = resolveTargetId(state, bodies, selectedId);
  const note = touchNote(state, bodies);
  const operations = operationOptions(bodies.length);
  const title = partCreateTitle(state.kind);

  return <CommandPanelFrame kicker="COMMAND" title={title} busy={busy} error={state.error} onCommit={props.onCommit} onCancel={props.onCancel}>
    {sketches.length > 1 && <label className="command-panel-row">
      <span className="command-panel-label">Sketch</span>
      <select value={state.sketchId} aria-label="Sketch" onChange={(event) => onAction({ type: "sketch", id: event.target.value })}>
        {sketches.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
      </select>
    </label>}
    <div className="command-panel-row command-panel-selection" data-active="true">
      <span className="command-panel-label">{selection.label}</span>
      <span className="command-panel-chip" data-empty={selection.count === 0}>{selection.status}</span>
      {sketch !== undefined && sketch.profiles.length > 1 && selection.count < sketch.profiles.length && <button type="button" className="command-panel-clear" onClick={() => onAction({ type: "all-profiles" })} aria-label="Select every profile">All</button>}
      {selection.clearable && <button type="button" className="command-panel-clear" onClick={() => onAction({ type: "no-profiles" })} aria-label={`Clear ${selection.label}`}>×</button>}
    </div>
    {sketch !== undefined && <ul className="command-panel-profiles" aria-label={`Profiles of ${sketch.name}`}>
      {sketch.profiles.map((profile) => <li key={profile.id}>
        <label>
          <input type="checkbox" checked={state.profileIds.includes(profile.id)} onChange={() => onAction({ type: "toggle-profile", id: profile.id })} />
          <span>{profile.label}</span>
        </label>
      </li>)}
    </ul>}
    {fields.map((field, index) => {
      const text = field.id === "value" ? state.value : state.second;
      const read = field.id === "value" ? parsed : parse(state.second, "second");
      return <div key={field.id} className="command-panel-field">
        <label className="command-panel-row">
          <span className="command-panel-label">{field.label} ({field.unit})</span>
          <input
            ref={index === 0 ? firstField : undefined}
            type="text"
            inputMode="text"
            spellCheck={false}
            value={text}
            aria-label={field.label}
            title={field.hint}
            placeholder={field.hint}
            onChange={(event) => onAction({ type: field.id, text: event.target.value })}
          />
        </label>
        {read.ok
          ? (read.bound || text.trim() !== String(read.value)) && <small className="command-panel-live" role="status">= {Number(read.value.toFixed(6))} {field.unit}</small>
          : <small className="command-panel-live failed" role="alert">{read.message}</small>}
      </div>;
    })}
    <label className="command-panel-row">
      <span className="command-panel-label">Direction</span>
      <select value={state.direction} aria-label={`${title} direction`} onChange={(event) => onAction({ type: "direction", direction: event.target.value as PartCreateDirection })}>
        {directionOptions(state.kind).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {bodies.length === 0
      ? <p className="command-panel-body-line">Operation: New body (there is no solid yet to join or cut).</p>
      : <label className="command-panel-row">
        <span className="command-panel-label">Operation</span>
        <select value={operation} aria-label="Operation" onChange={(event) => onAction({ type: "operation", operation: event.target.value as PartCreateOperation })}>
          {operations.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>}
    {bodies.length > 0 && operation !== "new" && <label className="command-panel-row">
      <span className="command-panel-label">Solid</span>
      <select value={targetId ?? ""} aria-label="Solid to modify" onChange={(event) => onAction({ type: "target", id: event.target.value })}>
        {targetId === undefined && <option value="">Choose a solid</option>}
        {bodies.map((body) => <option key={body.id} value={body.id}>{body.name}{state.touchingIds.includes(body.id) ? " (touched)" : ""}</option>)}
      </select>
    </label>}
    {note !== "" && <p className="command-panel-body-line">{note}</p>}
  </CommandPanelFrame>;
}
