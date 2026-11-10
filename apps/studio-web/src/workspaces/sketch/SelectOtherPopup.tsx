import { useRef } from "react";
import type { SelectOtherCandidate } from "../../../../../packages/workbench-sketch/src/select-other.js";

/**
 * The list that opens when several curves lie under the pointer (Alt-click or Tab): each one by kind and size, the current
 * one marked. Picking a row selects that curve; Alt-click again or Tab cycles to the next. From the keyboard, the arrow keys move
 * between the rows, Enter picks the focused one and Esc closes the list.
 */
export function SelectOtherPopup(props: {
  readonly candidates: readonly SelectOtherCandidate[];
  readonly selectedId: string | null;
  readonly position: readonly [number, number];
  readonly onPick: (id: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const move = (direction: 1 | -1): void => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row === globalThis.document.activeElement);
    rows[(current + direction + rows.length) % rows.length]?.focus();
  };
  return <div
    className="select-other"
    role="group"
    aria-label="Select other: curves under the pointer"
    style={{ left: props.position[0], top: props.position[1] }}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    }}
  >
    <header><strong>Select other</strong><button type="button" onClick={props.onClose} aria-label="Close the list">×</button></header>
    <div ref={listRef} role="listbox" aria-label="Curves under the pointer">
      {props.candidates.map((candidate, index) => <button
        key={candidate.id}
        type="button"
        role="option"
        aria-selected={candidate.id === props.selectedId}
        className={candidate.id === props.selectedId ? "current" : ""}
        onClick={() => props.onPick(candidate.id)}
      ><b>{index + 1}</b><span>{candidate.label}</span></button>)}
    </div>
    <em>Tab or Alt-click for the next · arrows and Enter from the keyboard</em>
  </div>;
}
