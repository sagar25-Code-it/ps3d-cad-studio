/**
 * HS-23: the named views the model browser lists: the three standard views and Home (the isometric view the model opens in). A row
 * goes to the view, nothing more; saved views of the person's own are not kept yet.
 */
export type NamedViewId = "front" | "top" | "right" | "home";

export interface NamedView {
  readonly id: NamedViewId;
  readonly label: string;
  /** The viewport orientation it goes to. */
  readonly orientation: "front" | "top" | "right" | "isometric";
  readonly hint: string;
}

export const NAMED_VIEWS: readonly NamedView[] = [
  { id: "front", label: "Front", orientation: "front", hint: "Look at the model from the front" },
  { id: "top", label: "Top", orientation: "top", hint: "Look at the model from above" },
  { id: "right", label: "Right", orientation: "right", hint: "Look at the model from the right" },
  { id: "home", label: "Home", orientation: "isometric", hint: "Go back to the isometric view" }
];

export function namedViewById(id: string): NamedView | undefined {
  return NAMED_VIEWS.find((view) => view.id === id);
}
