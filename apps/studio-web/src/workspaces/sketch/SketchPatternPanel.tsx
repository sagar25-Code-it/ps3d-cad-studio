import { useEffect, useMemo, useState } from "react";
import { sketchPatternInstanceCount, type SketchPatternObject, type WorkbenchSketch } from "../../../../../packages/workbench-core/src/index.js";
import { patternEntities, type SketchEditPlan } from "../../../../../packages/workbench-sketch/src/edit-tools.js";
import {
  DEFAULT_PATTERN_FIELDS,
  describePatternSpec,
  findPatternOf,
  patternFieldsFromSpec,
  patternInstances,
  patternPathLengthMm,
  patternSpecFromFields,
  planPattern,
  planPatternDissolve,
  planPatternEdit,
  planPatternRemoveCopies,
  planPatternSuppress,
  type PatternFields
} from "../../../../../packages/workbench-sketch/src/pattern-path.js";
import { CommandIcon } from "../../ui/CommandIcon.js";

interface Props {
  readonly sketch: WorkbenchSketch;
  readonly selectionIds: readonly string[];
  readonly onApply: (plan: SketchEditPlan) => boolean | void;
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
}

const newId = (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}`;

/**
 * The Sketch Pattern panel. A new pattern is associative by default: it keeps its source curves and layout (rectangular at any
 * angle, circular, or along a path curve), the copies follow the source and the layout, single copies can be suppressed, and the
 * whole pattern can be re-edited by selecting any of its curves. "Static copies" makes ordinary one-off copies as before.
 */
export function SketchPatternPanel(props: Props): React.JSX.Element {
  const [fields, setFields] = useState<PatternFields>(DEFAULT_PATTERN_FIELDS);
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
      setFields(patternFieldsFromSpec(existing.spec));
      setLoadedFor(existing.id);
    }
  }, [existing, loadedFor]);

  const set = <K extends keyof PatternFields>(key: K, value: PatternFields[K]): void => setFields((current) => ({ ...current, [key]: value }));
  const field = (label: string, key: keyof PatternFields, unit?: string): React.JSX.Element => (
    <label><span>{label}</span><div className="distance-entry"><input aria-label={label} inputMode="decimal" value={String(fields[key])} onChange={(event) => set(key, event.target.value as never)} />{unit !== undefined && <small>{unit}</small>}</div></label>
  );
  const check = (label: string, key: "extent" | "rotate" | "fit" | "follow"): React.JSX.Element => (
    <label className="check-row"><input type="checkbox" aria-label={label} checked={fields[key]} onChange={(event) => set(key, event.target.checked)} /><span>{label}</span></label>
  );

  // For a path pattern the last selected curve is the path and the ones before it are repeated.
  const pathMode = fields.kind === "path";
  const sources = pathMode ? props.selectionIds.slice(0, -1) : props.selectionIds;
  const pathId = pathMode ? (existing !== undefined && props.selectionIds.length === 0 ? fields.pathEntityId : props.selectionIds.at(-1) ?? fields.pathEntityId) : "";
  const pathLength = pathMode && pathId !== "" ? patternPathLengthMm(props.sketch, pathId) : undefined;

  const specResult = () => patternSpecFromFields(pathMode ? { ...fields, pathEntityId: pathId } : fields);

  const create = (): void => {
    const spec = specResult();
    if (!spec.ok) { props.onMessage(spec.diagnostics[0]?.message ?? "Check the pattern values."); return; }
    if (!associative) {
      if (spec.value.kind === "path") { props.onMessage("A path pattern is always associative: tick Associative, or choose a rectangular or circular layout for static copies."); return; }
      const result = spec.value.kind === "rectangular"
        ? patternEntities({ sketch: props.sketch, newId }, props.selectionIds, { kind: "rectangular", countX: spec.value.countX, countY: spec.value.countY, dxMm: spec.value.dxMm, dyMm: spec.value.dyMm })
        : patternEntities({ sketch: props.sketch, newId }, props.selectionIds, { kind: "circular", count: spec.value.count, angleDeg: spec.value.angleDeg, center: spec.value.center });
      if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The pattern was refused."); return; }
      props.onApply(result.value);
      return;
    }
    const plan = planPattern({ sketch: props.sketch, newId }, sources, spec.value);
    if (!plan.ok) { props.onMessage(plan.diagnostics[0]?.message ?? "The pattern was refused."); return; }
    props.onApply(plan.value);
  };

  const update = (pattern: SketchPatternObject): void => {
    const spec = patternSpecFromFields(pathMode ? { ...fields, pathEntityId: fields.pathEntityId } : fields);
    if (!spec.ok) { props.onMessage(spec.diagnostics[0]?.message ?? "Check the pattern values."); return; }
    const plan = planPatternEdit(props.sketch, pattern.id, spec.value);
    if (!plan.ok) { props.onMessage(plan.diagnostics[0]?.message ?? "The pattern change was refused."); return; }
    props.onApply(plan.value);
  };

  const run = (result: ReturnType<typeof planPatternDissolve>): void => {
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "That change was refused."); return; }
    props.onApply(result.value);
  };

  const instances = existing === undefined ? undefined : patternInstances(props.sketch, existing);
  const count = existing === undefined ? 0 : sketchPatternInstanceCount(existing.spec);

  return <section className="inspector-section sketch-edit-panel" aria-label="Pattern options">
    <header><strong>Pattern</strong><span>{props.selectionIds.length} selected</span></header>
    {existing === undefined ? <>
      <p className="profile-help">Select the curves to repeat, choose a layout, then Apply. For a path pattern select the curves to repeat and then, last, the line, arc, circle or spline to follow. {associative ? "The copies stay linked: edit the source or re-open the pattern by selecting any of its curves." : "Static copies are ordinary curves with no link back."}</p>
      <label className="check-row"><input type="checkbox" aria-label="Associative pattern" checked={associative} onChange={(event) => setAssociative(event.target.checked)} /><span>Associative (editable, copies follow the source)</span></label>
    </> : <p className="profile-help">Editing a pattern of {existing.sourceIds.length} curve{existing.sourceIds.length === 1 ? "" : "s"}: {describePatternSpec(existing.spec)}. Change the values and press Update, or switch single copies off below.</p>}
    <label><span>Layout</span><select aria-label="Pattern layout" value={fields.kind} onChange={(event) => set("kind", event.target.value as PatternFields["kind"])}>
      <option value="rectangular">Rectangular (any angle)</option><option value="circular">Circular</option>{(associative || existing !== undefined) && <option value="path">Along a path</option>}
    </select></label>
    {fields.kind === "rectangular" && <>
      {field("Count along the first direction", "countX")}{field(fields.extent ? "Total distance, first direction" : "Spacing, first direction", "dx", "mm")}
      {field("Count along the second direction", "countY")}{field(fields.extent ? "Total distance, second direction" : "Spacing, second direction", "dy", "mm")}
      {(associative || existing !== undefined) && <>{field("Direction angle", "angle", "°")}{check("Distances are the total span", "extent")}</>}
    </>}
    {fields.kind === "circular" && <>
      {field("Count", "count")}{field("Total angle", "totalAngle", "°")}{field("Centre X", "centerX", "mm")}{field("Centre Y", "centerY", "mm")}
      {(associative || existing !== undefined) && check("Copies turn with the pattern", "rotate")}
    </>}
    {fields.kind === "path" && <>
      <p className="profile-help">{pathId === "" ? "Select the path curve last." : `Path: ${pathId.replace(/^entity:/u, "")}${pathLength === undefined ? " (not usable as a path)" : `, ${Math.round(pathLength * 100) / 100} mm long`}.`}</p>
      {field("Count", "count")}{check("Fit to the whole path", "fit")}{!fields.fit && field("Spacing along the path", "spacing", "mm")}{field("Start distance", "start", "mm")}{check("Copies follow the path direction", "follow")}
    </>}
    {existing === undefined
      ? <button className="palette-action primary" onClick={create}><CommandIcon name="pattern" />Apply {associative ? "associative " : ""}pattern</button>
      : <>
        <button className="palette-action primary" onClick={() => update(existing)}><CommandIcon name="cube-check" />Update pattern</button>
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
