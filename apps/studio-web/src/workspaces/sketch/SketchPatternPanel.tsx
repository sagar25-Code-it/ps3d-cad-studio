import { useEffect, useMemo, useState } from "react";
import { sketchPatternInstanceCount, type SketchEntity, type SketchPatternObject, type WorkbenchSketch } from "../../../../../packages/workbench-core/src/index.js";
import type { SketchEditPlan } from "../../../../../packages/workbench-sketch/src/edit-tools.js";
import {
  describePatternSpec,
  defaultPatternFields,
  findPatternOf,
  patternFieldsFromSpec,
  patternInstances,
  patternPathLengthMm,
  planPatternDissolve,
  planPatternRemoveCopies,
  planPatternSuppress,
  type PatternFields
} from "../../../../../packages/workbench-sketch/src/pattern-path.js";
import { patternPanelKey, patternSelection, planPatternPanel } from "../../../../../packages/workbench-sketch/src/pattern-panel-model.js";
import { formatLengthField } from "../../../../../packages/workbench-sketch/src/edit-fields.js";
import type { SketchLengthUnit } from "../../../../../packages/workbench-sketch/src/sketch-units.js";
import { CommandIcon } from "../../ui/CommandIcon.js";

interface Props {
  readonly sketch: WorkbenchSketch;
  readonly selectionIds: readonly string[];
  readonly onApply: (plan: SketchEditPlan) => boolean | void;
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
  /** The ghost of the copies the values typed now would make, drawn on the canvas (empty clears it). */
  readonly onPreview?: (entities: readonly SketchEntity[]) => void;
  /** The unit lengths are typed and shown in. The sketch itself is millimetres. Default millimetres. */
  readonly unit?: SketchLengthUnit;
}

const previewId = (): ((prefix: "entity" | "constraint") => string) => {
  let serial = 0;
  return (prefix) => `${prefix}:preview-${(serial += 1)}`;
};
const newId = (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}`;

/**
 * The one Sketch Pattern panel: rectangular (at any angle), circular and along-a-path layouts, associative copies that follow the source
 * and the layout (or static copies), a ghost of the copies on the canvas while the values are typed, Enter to apply and Esc to close.
 * A pattern is re-edited by selecting any of its curves; single copies can be suppressed.
 */
export function SketchPatternPanel(props: Props): React.JSX.Element {
  const unit: SketchLengthUnit = props.unit ?? "mm";
  const [fields, setFields] = useState<PatternFields>(() => defaultPatternFields(unit));
  const [associative, setAssociative] = useState(true);
  const existing = useMemo(() => {
    for (const id of [...props.selectionIds].reverse()) {
      const found = findPatternOf(props.sketch, id);
      if (found !== undefined) return found.pattern;
    }
    return undefined;
  }, [props.selectionIds, props.sketch]);
  const [loadedFor, setLoadedFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (existing === undefined) { setLoadedFor(undefined); return; }
    if (loadedFor !== existing.id) {
      setFields(patternFieldsFromSpec(existing.spec, unit));
      setLoadedFor(existing.id);
    }
  }, [existing, loadedFor, unit]);

  const set = <K extends keyof PatternFields>(key: K, value: PatternFields[K]): void => setFields((current) => ({ ...current, [key]: value }));
  const { pathId } = patternSelection({ selectionIds: props.selectionIds, fields, existing });
  const pathMode = fields.kind === "path";
  const pathLength = pathMode && pathId !== "" ? patternPathLengthMm(props.sketch, pathId) : undefined;

  // The plan for the values typed now: the ghost on the canvas and Apply both come from it.
  const planned = useMemo(
    () => planPatternPanel({ sketch: props.sketch, selectionIds: props.selectionIds, fields, associative, unit, existing }, previewId()),
    [props.sketch, props.selectionIds, fields, associative, unit, existing]
  );
  const onPreview = props.onPreview;
  useEffect(() => {
    if (onPreview === undefined) return;
    onPreview(planned?.ok === true ? planned.ghost : []);
  }, [planned, onPreview]);
  useEffect(() => () => { onPreview?.([]); }, [onPreview]);

  const apply = (): void => {
    const result = planPatternPanel({ sketch: props.sketch, selectionIds: props.selectionIds, fields, associative, unit, existing }, newId);
    if (result === undefined) { props.onMessage("Select the curves to repeat first, then choose a layout."); return; }
    if (!result.ok) { props.onMessage(result.message); return; }
    props.onApply(result.plan);
  };
  const keys = (event: React.KeyboardEvent): void => {
    const action = patternPanelKey(event.key);
    if (action === "apply") { event.preventDefault(); apply(); }
    else if (action === "close") { event.preventDefault(); props.onClose(); }
  };

  const field = (label: string, key: keyof PatternFields, kind: "length" | "number" | "angle" = "number"): React.JSX.Element => (
    <label><span>{label}</span><div className="distance-entry"><input aria-label={kind === "length" ? `${label} (${unit})` : label} inputMode="text" value={String(fields[key])} onChange={(event) => set(key, event.target.value as never)} onKeyDown={keys} />{kind !== "number" && <small>{kind === "length" ? unit : "°"}</small>}</div></label>
  );
  const check = (label: string, key: "extent" | "rotate" | "fit" | "follow"): React.JSX.Element => (
    <label className="check-row"><input type="checkbox" aria-label={label} checked={fields[key]} onChange={(event) => set(key, event.target.checked)} onKeyDown={keys} /><span>{label}</span></label>
  );

  const run = (result: ReturnType<typeof planPatternDissolve>): void => {
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "That change was refused."); return; }
    props.onApply(result.value);
  };

  const instances = existing === undefined ? undefined : patternInstances(props.sketch, existing);
  const count = existing === undefined ? 0 : sketchPatternInstanceCount(existing.spec);

  return <section className="inspector-section sketch-edit-panel" aria-label="Pattern options" onKeyDown={(event) => { if (event.key === "Escape" && event.target === event.currentTarget) props.onClose(); }}>
    <header><strong>Pattern</strong><span>{props.selectionIds.length} selected</span></header>
    {existing === undefined ? <>
      <p className="profile-help">Select the curves to repeat, choose a layout, then Apply (or press Enter). For a path pattern select the curves to repeat and then, last, the line, arc, circle or spline to follow. The ghost shows the copies. {associative ? "The copies stay linked: edit the source or re-open the pattern by selecting any of its curves." : "Static copies are ordinary curves with no link back."}</p>
      <label className="check-row"><input type="checkbox" aria-label="Associative pattern" checked={associative} onChange={(event) => setAssociative(event.target.checked)} /><span>Associative (editable, copies follow the source)</span></label>
    </> : <p className="profile-help">Editing a pattern of {existing.sourceIds.length} curve{existing.sourceIds.length === 1 ? "" : "s"}: {describePatternSpec(existing.spec)}. Change the values and press Update (or Enter), or switch single copies off below.</p>}
    <label><span>Layout</span><select aria-label="Pattern layout" value={fields.kind} onChange={(event) => set("kind", event.target.value as PatternFields["kind"])}>
      <option value="rectangular">Rectangular (any angle)</option><option value="circular">Circular</option>{(associative || existing !== undefined) && <option value="path">Along a path</option>}
    </select></label>
    {fields.kind === "rectangular" && <>
      {field("Count along the first direction", "countX")}{field(fields.extent ? "Total distance, first direction" : "Spacing, first direction", "dx", "length")}
      {field("Count along the second direction", "countY")}{field(fields.extent ? "Total distance, second direction" : "Spacing, second direction", "dy", "length")}
      {(associative || existing !== undefined) && <>{field("Direction angle", "angle", "angle")}{check("Distances are the total span", "extent")}</>}
    </>}
    {fields.kind === "circular" && <>
      {field("Count", "count")}{field("Total angle", "totalAngle", "angle")}{field("Centre X", "centerX", "length")}{field("Centre Y", "centerY", "length")}
      <div className="palette-row">
        <button className="palette-action" title="Put the centre at the sketch origin" onClick={() => { set("centerX", formatLengthField(0, unit)); set("centerY", formatLengthField(0, unit)); }}><CommandIcon name="coincident" />Origin</button>
      </div>
      {(associative || existing !== undefined) && check("Copies turn with the pattern", "rotate")}
    </>}
    {fields.kind === "path" && <>
      <p className="profile-help">{pathId === "" ? "Select the path curve last." : `Path: ${pathId.replace(/^entity:/u, "")}${pathLength === undefined ? " (not usable as a path)" : `, ${formatLengthField(pathLength, unit)} ${unit} long`}.`}</p>
      {field("Count", "count")}{check("Fit to the whole path", "fit")}{!fields.fit && field("Spacing along the path", "spacing", "length")}{field("Start distance", "start", "length")}{check("Copies follow the path direction", "follow")}
    </>}
    {planned !== undefined && <p className={`profile-help edit-preview ${planned.ok ? "" : "edit-preview-error"}`} role="status" aria-live="polite">{planned.ok ? planned.summary : planned.message}</p>}
    {existing === undefined
      ? <button className="palette-action primary" onClick={apply}><CommandIcon name="pattern" />Apply {associative ? "associative " : ""}pattern</button>
      : <>
        <button className="palette-action primary" onClick={apply}><CommandIcon name="cube-check" />Update pattern</button>
        {count > 1 && instances !== undefined && <div className="record-list" aria-label="Pattern instances">
          {Array.from({ length: count - 1 }, (_, index) => index + 1).map((instance) => {
            const off = existing.suppressed.includes(instance);
            return <button key={instance} className={off ? "relaxed" : ""} title={off ? "Bring this copy back" : "Switch this copy off"} onClick={() => run(planPatternSuppress(props.sketch, existing.id, [instance], !off))}>
              <CommandIcon name={off ? "eye-off" : "eye"} /><span>Copy {instance}</span><small>{off ? "suppressed · restore" : "on · suppress"}</small>
            </button>;
          })}
        </div>}
        <button className="palette-action" onClick={() => run(planPatternDissolve(props.sketch, existing.id))}><CommandIcon name="coincident" />Make the copies plain curves</button>
        <button className="palette-action" onClick={() => run(planPatternRemoveCopies(props.sketch, existing.id))}><CommandIcon name="trash" />Remove the copies</button>
      </>}
    <button className="palette-action" onClick={props.onClose}><CommandIcon name="cancel" />Done</button>
  </section>;
}
