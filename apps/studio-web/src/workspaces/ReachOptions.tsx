import { useMemo } from "react";
import type { GeneralSolidBody } from "../../../../packages/workbench-core/src/index.js";
import { extentChoices, faceChoices, isReachTarget, reachBodyOf, vertexChoices, type ReachDirection, type ReachExtent, type ReachSettings } from "../reach-settings.js";

interface ReachOptionsProps {
  readonly operation: "extrude" | "revolve";
  readonly settings: ReachSettings;
  readonly onChange: (next: ReachSettings) => void;
  readonly bodies: readonly GeneralSolidBody[];
  readonly selectedId: string | null;
  /** The feature adds to or cuts from a solid (through all needs a cut). */
  readonly cutting: boolean;
}

/** The reach controls of the create-solid palette: direction, extent with its target, second side and a revolve's thin wall. */
export function ReachOptions(props: ReachOptionsProps): React.JSX.Element {
  const { operation, settings, bodies } = props;
  const body = reachBodyOf(bodies, settings.targetBodyId, props.selectedId);
  const faces = useMemo(() => (body !== undefined && (settings.extent === "to-face" || settings.extent === "to-first" || settings.extent === "to-last") ? faceChoices(body) : []), [body, settings.extent]);
  const vertices = useMemo(() => (body !== undefined && settings.extent === "to-vertex" ? vertexChoices(body) : []), [body, settings.extent]);
  const set = (change: Partial<ReachSettings>): void => props.onChange({ ...settings, ...change });
  const reaching = isReachTarget(settings.extent);
  const unit = operation === "revolve" ? "°" : "mm";
  const choices = extentChoices(operation, props.cutting);
  const extent = choices.some((choice) => choice.value === settings.extent) ? settings.extent : "distance";
  const sideNoun = operation === "revolve" ? "Turn" : "Direction";
  return <>
    <div className="make-solid-row" aria-label={`${operation === "revolve" ? "Revolve" : "Extrude"} extent`}>
      <select aria-label={props.cutting && operation === "extrude" ? "Cut extent" : "Extent"} value={extent} onChange={(event) => set({ extent: event.target.value as ReachExtent })}>
        {choices.map((choice) => <option key={choice.value} value={choice.value} disabled={isReachTarget(choice.value) && bodies.length === 0}>{choice.label}</option>)}
      </select>
    </div>
    {isReachTarget(extent) && bodies.length > 0 && <div className="make-solid-row" aria-label="Reach target">
      <select aria-label="Reach target solid" value={body?.id ?? ""} onChange={(event) => set({ targetBodyId: event.target.value, faceRole: "", vertexIndex: "0" })}>
        {bodies.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
      {(extent === "to-face" || extent === "to-first" || extent === "to-last") && <select aria-label="Reach target face" value={settings.faceRole} onChange={(event) => set({ faceRole: event.target.value })}>
        {faces.length === 0 && <option value="">(no named faces)</option>}
        {faces.map((face) => <option key={face.role} value={face.role} disabled={operation === "revolve" && !face.planar}>{face.label}</option>)}
      </select>}
      {extent === "to-vertex" && <select aria-label="Reach target vertex" value={settings.vertexIndex} onChange={(event) => set({ vertexIndex: event.target.value })}>
        {vertices.length === 0 && <option value="0">(no corner vertices)</option>}
        {vertices.map((vertex) => <option key={vertex.index} value={String(vertex.index)}>{vertex.label}</option>)}
      </select>}
      <small>The {operation === "revolve" ? "angle" : "distance"} is measured from it each time the model rebuilds.</small>
    </div>}
    <div className="make-solid-row" aria-label={`${operation === "revolve" ? "Revolve" : "Extrude"} direction`}>
      <select aria-label={operation === "revolve" ? "Revolve direction" : "Extrusion direction"} value={settings.direction} onChange={(event) => set({ direction: event.target.value as ReachDirection })}>
        <option value="one-side">One side</option>
        <option value="symmetric" disabled={reaching}>Symmetric</option>
        <option value="flipped">Flipped</option>
        <option value="two-side" disabled={reaching && operation === "revolve"}>Two sides</option>
      </select>
      {settings.direction === "two-side" && !(reaching && operation === "revolve") && <>
        <input aria-label={`Second side ${operation === "revolve" ? "angle" : "distance"}`} type="number" min={operation === "revolve" ? 1 : 0.1} max={operation === "revolve" ? 359 : undefined} step={operation === "revolve" ? 5 : 1} value={settings.second} onChange={(event) => set({ second: event.target.value })} />
        <small>{unit} the other way</small>
      </>}
    </div>
    {operation === "revolve" && <div className="make-solid-row" aria-label="Thin revolve">
      <label className="palette-check"><input type="checkbox" aria-label="Thin wall" checked={settings.thin} onChange={(event) => set({ thin: event.target.checked })} /> Thin wall</label>
      {settings.thin && <>
        <input aria-label="Thin wall thickness in millimetres" type="number" min={0.05} step={0.5} value={settings.thinWall} onChange={(event) => set({ thinWall: event.target.value })} />
        <small>mm</small>
        <select aria-label="Thin wall side" value={settings.thinSide} onChange={(event) => set({ thinSide: event.target.value as ReachSettings["thinSide"] })}>
          <option value="inside">Inside the outline</option>
          <option value="outside">Outside the outline</option>
          <option value="center">Centered on it</option>
        </select>
      </>}
    </div>}
    <small className="make-solid-hint">{sideNoun}: {settings.direction === "symmetric" ? "half each way" : settings.direction === "two-side" ? "two different amounts" : settings.direction === "flipped" ? "against the plane normal" : "along the plane normal"}.</small>
  </>;
}
