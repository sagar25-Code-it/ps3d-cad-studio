import type { SelectOtherCandidate } from "../../../../../packages/workbench-sketch/src/select-other.js";

/**
 * The list that opens when several curves lie under the pointer (Alt-click or Tab): each one by kind and size, the current
 * one marked. Picking a row selects that curve; Alt-click again or Tab cycles to the next.
 */
export function SelectOtherPopup(props: {
  readonly candidates: readonly SelectOtherCandidate[];
  readonly selectedId: string | null;
  readonly position: readonly [number, number];
  readonly onPick: (id: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  return <div className="select-other" role="listbox" aria-label="Curves under the pointer" style={{ left: props.position[0], top: props.position[1] }} onPointerDown={(event) => event.stopPropagation()}>
    <header><strong>Select other</strong><button type="button" onClick={props.onClose} aria-label="Close the list">×</button></header>
    {props.candidates.map((candidate, index) => <button
      key={candidate.id}
      type="button"
      role="option"
      aria-selected={candidate.id === props.selectedId}
      className={candidate.id === props.selectedId ? "current" : ""}
      onClick={() => props.onPick(candidate.id)}
    ><b>{index + 1}</b><span>{candidate.label}</span></button>)}
    <em>Tab or Alt-click for the next</em>
  </div>;
}
