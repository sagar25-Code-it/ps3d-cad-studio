import type { GeneralSolidBody, PartIntent } from "../../../../packages/workbench-core/src/index.js";
import { evaluateConstructionPlane, resolveBinder } from "../../../../packages/workbench-geometry/src/index.js";
import { describeBinderKind } from "../construction-ui.js";
import { CommandIcon } from "../ui/CommandIcon.js";

/**
 * Shows the construction plane or binder that is selected: what it points at, whether it still resolves against the current
 * bodies, and buttons to hide, delete or sketch on it. Renders nothing for any other selection.
 */
export function ConstructionReferenceCard(props: {
  readonly part: PartIntent;
  readonly selectedId: string | null;
  readonly onAction: (id: string, action: "toggle" | "delete" | "sketch") => void;
}): React.JSX.Element | null {
  const bodies: readonly GeneralSolidBody[] = props.part.generalBodies ?? [];
  const binder = (props.part.constructionBinders ?? []).find((candidate) => candidate.id === props.selectedId);
  const plane = (props.part.construction ?? []).find((candidate) => candidate.id === props.selectedId);
  if (binder === undefined && plane === undefined) return null;
  if (binder !== undefined) {
    const resolved = resolveBinder(binder, bodies);
    const body = bodies.find((candidate) => candidate.id === binder.target.bodyId);
    const sketchable = !("error" in resolved) && resolved.kind === "face" && resolved.planar;
    return <section className="inspector-section construction-reference-card" aria-label="Binder">
      <header><strong>{binder.name}</strong><span>{describeBinderKind(binder)}</span></header>
      <p>Follows {binder.target.kind === "body" ? "the whole of" : `a ${binder.target.kind} of`} {body?.name ?? "a body that is no longer in the part"}, and finds it again each time the body is rebuilt.</p>
      <p role="status" className={"error" in resolved ? "error" : undefined}>{"error" in resolved ? resolved.error : resolved.description}</p>
      <div className="solid-actions">
        {binder.target.kind === "face" && <button className="primary" disabled={!sketchable} onClick={() => props.onAction(binder.id, "sketch")}><CommandIcon name="sketch" />Sketch on this face</button>}
        <button onClick={() => props.onAction(binder.id, "toggle")}><CommandIcon name={binder.visible ? "eye-off" : "eye"} />{binder.visible ? "Hide" : "Show"}</button>
        <button className="danger" onClick={() => props.onAction(binder.id, "delete")}><CommandIcon name="trash" />Delete</button>
      </div>
    </section>;
  }
  const frame = evaluateConstructionPlane(plane!, bodies, props.part.constructionAxes ?? [], props.part.constructionBinders ?? []);
  // Any plane that resolves is a sketch plane; the sketch follows the plane when its step is edited.
  const sketchable = !("error" in frame);
  return <section className="inspector-section construction-reference-card" aria-label="Construction plane">
    <header><strong>{plane!.name}</strong><span>construction plane · {plane!.definition.kind.replaceAll("-", " ")}</span></header>
    <p role="status" className={"error" in frame ? "error" : undefined}>{"error" in frame ? frame.error : frame.description}</p>
    <div className="solid-actions">
      {sketchable && <button className="primary" onClick={() => props.onAction(plane!.id, "sketch")}><CommandIcon name="sketch" />Sketch on this plane</button>}
      <button onClick={() => props.onAction(plane!.id, "toggle")}><CommandIcon name={plane!.visible ? "eye-off" : "eye"} />{plane!.visible ? "Hide" : "Show"}</button>
      <button className="danger" onClick={() => props.onAction(plane!.id, "delete")}><CommandIcon name="trash" />Delete</button>
    </div>
  </section>;
}
