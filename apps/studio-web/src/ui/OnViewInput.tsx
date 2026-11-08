import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  evaluateOnViewText,
  formatOnViewValue,
  onViewLimitMessage,
  placeNearCursor,
  stepOnViewValue,
  unitLabel,
  type OnViewRequest
} from "./on-view-input.js";

interface Pending {
  readonly request: OnViewRequest;
  readonly cursor: { readonly x: number; readonly y: number };
  readonly resolve: (value: number | null) => void;
}

export interface OnViewInputApi {
  /** Asks for one number beside the cursor. Resolves with the value, or null when cancelled with Esc or a click elsewhere. */
  readonly ask: (request: OnViewRequest) => Promise<number | null>;
  /** Render once, anywhere in the tree. */
  readonly element: React.JSX.Element | null;
}

/**
 * On-view parameters: a small floating field at the cursor that a tool uses instead of a browser prompt. Type a value
 * (arithmetic and units are accepted), step with the arrow keys, Enter to accept, Esc to cancel.
 */
export function useOnViewInput(): OnViewInputApi {
  const cursor = useRef({ x: 240, y: 200 });
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    const track = (event: PointerEvent): void => { cursor.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", track, { passive: true, capture: true });
    return () => { window.removeEventListener("pointermove", track); window.removeEventListener("pointerdown", track, true); };
  }, []);

  const ask = useCallback((request: OnViewRequest): Promise<number | null> => new Promise((resolve) => {
    // Only one field at a time: a new request cancels the one still open.
    pendingRef.current?.resolve(null);
    setPending({ request, cursor: { ...cursor.current }, resolve });
  }), []);

  const finish = useCallback((value: number | null): void => {
    const current = pendingRef.current;
    if (current === null) return;
    setPending(null);
    current.resolve(value);
  }, []);

  const element = pending === null ? null : <OnViewField key={`${pending.request.label}:${pending.cursor.x}:${pending.cursor.y}`} pending={pending} onFinish={finish} />;
  return { ask, element };
}

function OnViewField({ pending, onFinish }: { readonly pending: Pending; readonly onFinish: (value: number | null) => void }): React.JSX.Element {
  const { request } = pending;
  const [text, setText] = useState(formatOnViewValue(request.defaultValue));
  const [error, setError] = useState<string | undefined>(undefined);
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [placed, setPlaced] = useState(() => placeNearCursor(pending.cursor, { width: 190, height: 52 }, { width: window.innerWidth, height: window.innerHeight }));

  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (rect !== undefined) setPlaced(placeNearCursor(pending.cursor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
    input.current?.focus();
    input.current?.select();
  }, [pending.cursor]);

  useEffect(() => {
    const outside = (event: PointerEvent): void => { if (box.current?.contains(event.target as Node) !== true) onFinish(null); };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [onFinish]);

  const evaluate = (value: string): { readonly ok: true; readonly value: number } | { readonly ok: false } => {
    const parsed = evaluateOnViewText(value, request.quantity, request.variables ?? {});
    if (!parsed.ok) { setError(parsed.message); return { ok: false }; }
    const limit = onViewLimitMessage(request, parsed.value);
    if (limit !== undefined) { setError(limit); return { ok: false }; }
    setError(undefined);
    return { ok: true, value: parsed.value };
  };

  const unit = unitLabel(request.quantity);
  return <form
    ref={box}
    className="on-view-input"
    style={{ left: placed.left, top: placed.top }}
    role="dialog"
    aria-label={request.label}
    onSubmit={(event) => { event.preventDefault(); const result = evaluate(text); if (result.ok) onFinish(result.value); }}
  >
    <label>
      <span>{request.label}</span>
      <input
        ref={input}
        className={error === undefined ? "" : "invalid"}
        inputMode="decimal"
        aria-label={`${request.label}${unit === "" ? "" : ` in ${unit}`}`}
        aria-invalid={error !== undefined}
        value={text}
        onChange={(event) => { setText(event.target.value); setError(undefined); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onFinish(null); return; }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const parsed = evaluateOnViewText(text, request.quantity, request.variables ?? {});
            const base = parsed.ok ? parsed.value : request.defaultValue;
            const next = stepOnViewValue(base, event.key === "ArrowUp" ? 1 : -1, request.step ?? (request.quantity === "count" ? 1 : request.quantity === "angle" ? 1 : 0.5), { shift: event.shiftKey, alt: event.altKey });
            setText(formatOnViewValue(next));
            setError(undefined);
          }
        }}
      />
      {unit !== "" && <em>{unit}</em>}
    </label>
    {error !== undefined && <span className="on-view-error" role="alert">{error}</span>}
    <em>Enter accept · Esc cancel · arrows step</em>
  </form>;
}
