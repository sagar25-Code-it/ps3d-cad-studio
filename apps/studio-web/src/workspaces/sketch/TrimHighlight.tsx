import type { TrimPreview } from "../../../../../packages/workbench-sketch/src/trim-preview.js";

/**
 * The part of the curve under the pointer that Trim would remove, drawn on the canvas while the Trim tool is active. It is a preview
 * only (no pointer events): the click that follows does exactly this.
 */
export function TrimHighlight(props: { readonly preview: TrimPreview | undefined; readonly px: number }): React.JSX.Element | null {
  if (props.preview === undefined) return null;
  return <g className="trim-highlight" pointerEvents="none" aria-hidden="true" data-trim-target={props.preview.targetId}>
    {props.preview.removed.map((run, index) => <polyline key={index} points={run.map((point) => `${point[0]},${-point[1]}`).join(" ")} />)}
  </g>;
}
