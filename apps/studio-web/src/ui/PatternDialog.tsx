import { useEffect, useMemo, useRef, useState } from "react";
import type { PatternShape } from "../../../../packages/workbench-core/src/index.js";
import type { PatternPreview, PatternRequest } from "../pattern-commit.js";
import { formOfRequest, PATTERN_DIRECTIONS, requestOfForm, type PatternForm } from "../pattern-form.js";

export type PatternKind = PatternShape["type"];

export interface PatternDialogProps {
  readonly kind: PatternKind;
  /** "edit" reopens an existing pattern: what it copies and how it is kept cannot change, its layout can. */
  readonly mode: "new" | "edit";
  readonly sourceBodyId: string;
  readonly sourceName: string;
  /** Holes and cuts of the body that can be repeated instead of the whole body. */
  readonly features: readonly { readonly id: string; readonly name: string }[];
  readonly axes: readonly { readonly id: string; readonly name: string }[];
  readonly planes: readonly { readonly id: string; readonly name: string }[];
  readonly initial?: PatternRequest;
  /** The numbers shown under the fields; recomputed on every change. */
  readonly preview: (request: PatternRequest) => PatternPreview | { readonly ok: false; readonly message: string };
  /** Resolves to a message to show in the dialog, or undefined when the pattern was applied. */
  readonly onApply: (request: PatternRequest) => Promise<string | undefined>;
  readonly onCancel: () => void;
}

const TITLES: Readonly<Record<PatternKind, string>> = { rectangular: "Rectangular pattern", circular: "Circular pattern", mirror: "Mirror" };

const fieldStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "9.5rem 1fr", alignItems: "center", gap: "0.5rem", margin: "0.3rem 0" };
const rowStyle: React.CSSProperties = { display: "flex", gap: "0.5rem", alignItems: "center" };

/** The pattern command's dialog: counts, spacing or extent, angle, axis or plane, what is copied and whether copies become bodies or join. */
export function PatternDialog(props: PatternDialogProps): React.JSX.Element {
  const [form, setForm] = useState<PatternForm>(() => formOfRequest(props.initial));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const dialogRef = useRef<HTMLElement>(null);
  const set = <K extends keyof PatternForm>(key: K, value: PatternForm[K]): void => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    const frame = window.requestAnimationFrame(() => dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
    };
    dialog.addEventListener("keydown", onKey);
    return () => { window.cancelAnimationFrame(frame); dialog.removeEventListener("keydown", onKey); };
  }, []);

  const built = useMemo(() => requestOfForm(props.kind, form, props.sourceBodyId), [props.kind, props.sourceBodyId, form]);
  const preview = useMemo(() => ("request" in built ? props.preview(built.request) : undefined), [built, props.preview]);
  const problem = "message" in built ? built.message : preview !== undefined && !preview.ok ? preview.message : undefined;

  const apply = async (): Promise<void> => {
    if (!("request" in built)) { setError(built.message); return; }
    setWorking(true);
    setError(undefined);
    const message = await props.onApply(built.request);
    setWorking(false);
    if (message !== undefined) setError(message);
  };

  const directionSelect = (value: string, onChange: (next: string) => void, label: string, initialFocus = false): React.JSX.Element =>
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} {...(initialFocus ? { "data-dialog-initial-focus": true } : {})}>{PATTERN_DIRECTIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select>;
  const fixed = props.mode === "edit";
  const datumPlane = form.plane === "xy" || form.plane === "xz" || form.plane === "yz";
  const extent = form.sizing === "extent";

  return <div className="engineering-confirmation-backdrop">
    <section ref={dialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact combine-dialog pattern-dialog" role="dialog" aria-modal="true" aria-labelledby="pattern-title" aria-describedby="pattern-description">
      <header><div><span>PART / PATTERN</span><h2 id="pattern-title">{TITLES[props.kind]}{props.mode === "edit" ? " (edit)" : ""}</h2></div><button onClick={props.onCancel} aria-label="Close pattern">×</button></header>
      <div className="engineering-review-copy" id="pattern-description">
        <div style={fieldStyle}><span>Pattern of</span>
          <span style={rowStyle}>
            <label><input type="radio" name="pattern-target" disabled={fixed} checked={form.target === "body"} onChange={() => set("target", "body")} /> The body {props.sourceName}</label>
            <label><input type="radio" name="pattern-target" disabled={fixed || props.features.length === 0} checked={form.target === "features"} onChange={() => set("target", "features")} /> Its holes and cuts</label>
          </span>
        </div>
        {form.target === "features" && <div style={fieldStyle}><span>Holes and cuts</span>
          <span>{props.features.map((feature) => <label key={feature.id} style={{ display: "block" }}><input type="checkbox" disabled={fixed} checked={form.featureIds.includes(feature.id)} onChange={(event) => set("featureIds", event.target.checked ? [...form.featureIds, feature.id] : form.featureIds.filter((id) => id !== feature.id))} /> {feature.name}</label>)}</span>
        </div>}
        {props.kind === "rectangular" && <>
          <div style={fieldStyle}><span>Direction 1</span><span style={rowStyle}>{directionSelect(form.directionA, (next) => set("directionA", next), "First direction", true)}<input aria-label="Instances in direction 1" inputMode="numeric" size={4} value={form.countA} onChange={(event) => set("countA", event.target.value)} /><span>instances</span></span></div>
          <div style={fieldStyle}><span>{extent ? "Extent 1" : "Spacing 1"}</span><span style={rowStyle}><input aria-label={extent ? "Extent in direction 1" : "Spacing in direction 1"} inputMode="decimal" size={8} value={form.spacingA} onChange={(event) => set("spacingA", event.target.value)} /><span>mm</span></span></div>
          <div style={fieldStyle}><span>Direction 2</span><span style={rowStyle}>{directionSelect(form.directionB, (next) => set("directionB", next), "Second direction")}<input aria-label="Instances in direction 2" inputMode="numeric" size={4} value={form.countB} onChange={(event) => set("countB", event.target.value)} /><span>instances (1 = none)</span></span></div>
          <div style={fieldStyle}><span>{extent ? "Extent 2" : "Spacing 2"}</span><span style={rowStyle}><input aria-label={extent ? "Extent in direction 2" : "Spacing in direction 2"} inputMode="decimal" size={8} value={form.spacingB} disabled={Number(form.countB) <= 1} onChange={(event) => set("spacingB", event.target.value)} /><span>mm</span></span></div>
          <div style={fieldStyle}><span>Distance means</span><select aria-label="Distance type" value={form.sizing} onChange={(event) => set("sizing", event.target.value === "extent" ? "extent" : "spacing")}><option value="spacing">Spacing between neighbours</option><option value="extent">Overall extent, first to last</option></select></div>
        </>}
        {props.kind === "circular" && <>
          <div style={fieldStyle}><span>Axis</span><select data-dialog-initial-focus aria-label="Pattern axis" value={form.axis} onChange={(event) => set("axis", event.target.value)}>
            <option value="x">X axis through the origin</option><option value="y">Y axis through the origin</option><option value="z">Z axis through the origin</option>
            {props.axes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} (construction axis)</option>)}
          </select></div>
          <div style={fieldStyle}><span>Instances</span><span style={rowStyle}><input aria-label="Instances" inputMode="numeric" size={4} value={form.count} onChange={(event) => set("count", event.target.value)} /><span>including the original</span></span></div>
          <div style={fieldStyle}><span>Total angle</span><span style={rowStyle}><input aria-label="Total angle" inputMode="decimal" size={6} value={form.angle} onChange={(event) => set("angle", event.target.value)} /><span>° (360 spreads evenly all round)</span></span></div>
        </>}
        {props.kind === "mirror" && <>
          <div style={fieldStyle}><span>Mirror plane</span><select data-dialog-initial-focus aria-label="Mirror plane" value={form.plane} onChange={(event) => set("plane", event.target.value)}>
            <option value="xy">XY datum plane</option><option value="xz">XZ datum plane</option><option value="yz">YZ datum plane</option>
            {props.planes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} (construction plane)</option>)}
          </select></div>
          {datumPlane && <div style={fieldStyle}><span>Plane position</span><span style={rowStyle}><input aria-label="Plane position" inputMode="decimal" size={8} value={form.offset} onChange={(event) => set("offset", event.target.value)} /><span>mm along {form.plane === "xy" ? "Z" : form.plane === "xz" ? "Y" : "X"}</span></span></div>}
        </>}
        {form.target === "body" && <div style={fieldStyle}><span>Copies become</span><select aria-label="Pattern result" disabled={fixed} value={form.result} onChange={(event) => set("result", event.target.value === "join" ? "join" : "new-bodies")}><option value="new-bodies">New bodies</option><option value="join">Joined into {props.sourceName}</option></select></div>}
        <p className="combine-note" role="status" aria-live="polite" data-testid="pattern-preview">{problem !== undefined ? problem : preview?.ok === true ? preview.text : ""}</p>
        <p className="combine-note">The pattern is a timeline step. Edit the source body and the copies follow. Joining uses the tessellated Boolean: a result that is not a clean closed solid is refused and nothing changes.</p>
        {error !== undefined && <p className="combine-error" role="alert">{error}</p>}
      </div>
      <footer><button onClick={props.onCancel}>Cancel</button><button className="primary" disabled={working || problem !== undefined} onClick={() => void apply()}>{working ? "Building…" : props.mode === "edit" ? "Update pattern" : "Create pattern"}</button></footer>
    </section>
  </div>;
}
