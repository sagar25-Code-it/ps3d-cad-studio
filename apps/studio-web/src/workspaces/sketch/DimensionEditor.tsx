import { useEffect, useId, useRef } from "react";

/**
 * The inline value editor for a driving dimension: it opens at the dimension (Fusion's D tool: click a curve, type, Enter), starts
 * from the exact stored value, applies on Enter and closes on Esc. A checkbox makes the dimension a reference one (measured, it never
 * moves the geometry) or a driving one again.
 */
export interface DimensionEditorProps {
  readonly label: string;
  readonly text: string;
  readonly unitLabel: string;
  /** The unit spelled out for assistive technology ("inches", "degrees"); the label above is the short symbol. */
  readonly unitName?: string;
  readonly position: readonly [number, number];
  /** Whether the dimension is a reference dimension; undefined hides the toggle (angles, arc lengths and perimeters are always driving here). */
  readonly reference?: boolean | undefined;
  readonly hint?: string;
  readonly onChange: (text: string) => void;
  readonly onReferenceChange?: (reference: boolean) => void;
  readonly onCommit: () => void;
  /** Closes the editor. `escape` when the person pressed Esc, `blur` when the focus left it (a click elsewhere). */
  readonly onCancel: (reason: "escape" | "blur") => void;
}

export function DimensionEditor(props: DimensionEditorProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  useEffect(() => {
    // The editor takes the keyboard while it is open and gives it back to whatever had it (the canvas) when it closes, so a keyboard
    // user is not left on the page body with every sketch key dead.
    const before = globalThis.document.activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      const now = globalThis.document.activeElement;
      const stranded = now === null || now === globalThis.document.body || groupRef.current?.contains(now) === true;
      if (stranded && before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return <div
    ref={groupRef}
    className="dimension-editor"
    style={{ left: props.position[0], top: props.position[1] }}
    role="group"
    aria-label={`Edit ${props.label.toLowerCase()}`}
    // Moving focus to the checkbox must not close the editor; leaving the editor entirely does.
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onCancel("blur"); }}
  >
    <label><span>{props.label}</span>
      <input
        ref={inputRef}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hintId}
        aria-label={`${props.label} in ${props.unitName ?? props.unitLabel}`}
        value={props.text}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); props.onCommit(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel("escape"); }
        }}
      />
      <small>{props.unitLabel}</small>
    </label>
    {props.reference !== undefined && <label className="dimension-reference-toggle">
      <input type="checkbox" checked={props.reference} onChange={(event) => props.onReferenceChange?.(event.target.checked)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel("escape"); } }} />
      <span>Reference (measured, does not drive)</span>
    </label>}
    <em id={hintId}>{props.hint ?? "A number, or a parameter such as plate_w / 4 · Enter applies · Esc closes"}</em>
  </div>;
}
