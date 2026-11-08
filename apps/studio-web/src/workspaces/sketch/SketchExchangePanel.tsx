import { useEffect, useMemo, useState } from "react";
import type { SketchUnderlay, Vec2, WorkbenchSketch } from "../../../../../packages/workbench-core/src/index.js";
import { defaultConstructionLayers, parseDxf, writeSketchDxf, type DxfUnits } from "../../../../../packages/workbench-sketch/src/dxf.js";
import { parseSvg, writeSketchSvg } from "../../../../../packages/workbench-sketch/src/svg.js";
import { COMMON_IMPORT_SCALES, planDrawingImport, type ImportPlacement, type ParsedDrawing } from "../../../../../packages/workbench-sketch/src/sketch-exchange.js";
import type { SketchEditPlan } from "../../../../../packages/workbench-sketch/src/edit-tools.js";
import { calibrateUnderlay, createUnderlay, imageIdOf, moveUnderlay, planUnderlay, readImageInfo, rotateUnderlay, setUnderlayOpacity } from "../../../../../packages/workbench-sketch/src/underlay.js";
import { safeFileStem } from "../../file-names.js";
import { browserImageStore } from "../../underlay-store.js";
import { CommandIcon } from "../../ui/CommandIcon.js";

/**
 * The right-hand panels of the sketch Insert group: Import (DXF or SVG into the sketch), Export (DXF or SVG of the sketch) and
 * Picture (an image underlay to trace, calibrated by two clicked points). Every change goes through the same `apply-sketch-edit`
 * path as any other sketch edit, so it is undoable and validated.
 */

const MAX_FILE_BYTES = 12 * 1024 * 1024;

interface CommonProps {
  readonly sketch: WorkbenchSketch;
  /** Applies a plan through the operation layer; false means it was refused (the reason is already shown). */
  readonly onApply: (plan: SketchEditPlan) => boolean | void;
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
}

const newId = (prefix: "entity"): string => `${prefix}:user-${crypto.randomUUID()}`;

function numberField(label: string, value: string, onChange: (next: string) => void, unit?: string): React.JSX.Element {
  return <label><span>{label}</span><div className="distance-entry"><input aria-label={label} inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />{unit !== undefined && <small>{unit}</small>}</div></label>;
}

function parseNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text.trim().replace(",", "."));
}

function download(text: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------------------------

export function SketchImportPanel(props: CommonProps): React.JSX.Element {
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState<string | undefined>(undefined);
  const [tolerance, setTolerance] = useState("0.02");
  const [problem, setProblem] = useState("");
  const [scaleChoice, setScaleChoice] = useState("file");
  const [customScale, setCustomScale] = useState("1");
  const [confirmed, setConfirmed] = useState(false);
  const [placement, setPlacement] = useState<ImportPlacement>("as-is");
  const [weld, setWeld] = useState("0.005");
  const [asConstruction, setAsConstruction] = useState(false);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [construction, setConstruction] = useState<readonly string[]>([]);

  const outcome = useMemo<{ readonly drawing?: ParsedDrawing; readonly error?: string }>(() => {
    if (text === undefined) return {};
    const curveToleranceMm = parseNumber(tolerance);
    const options = Number.isFinite(curveToleranceMm) ? { curveToleranceMm } : {};
    const trimmed = text.trimStart();
    const result = /^<\?xml|^<svg|^<!DOCTYPE svg|^<!--/iu.test(trimmed) || /<svg[\s>]/iu.test(trimmed.slice(0, 4096)) ? parseSvg(text, options) : parseDxf(text, options);
    return result.ok ? { drawing: result.value } : { error: result.diagnostics[0]?.message ?? "The file could not be read." };
  }, [text, tolerance]);
  const parsed = outcome.drawing;

  useEffect(() => {
    if (parsed === undefined) return;
    setSkipped([]);
    setConstruction(parsed.format === "dxf" ? defaultConstructionLayers(parsed.layers) : []);
    setScaleChoice("file");
    setConfirmed(parsed.units.source === "file");
  }, [parsed]);

  const mmPerUnit = parsed === undefined ? 1 : scaleChoice === "file" ? parsed.units.mmPerUnit : scaleChoice === "custom" ? parseNumber(customScale) : Number(scaleChoice);
  const planned = useMemo(() => {
    if (parsed === undefined) return undefined;
    const weldMm = parseNumber(weld);
    return planDrawingImport(parsed, props.sketch, { mmPerUnit, placement, skipLayers: skipped, constructionLayers: construction, allConstruction: asConstruction, newId, ...(Number.isFinite(weldMm) && weldMm >= 0 ? { weldMm } : {}) });
  }, [parsed, props.sketch, mmPerUnit, placement, skipped, construction, asConstruction, weld]);

  const choose = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setProblem("");
    setText(undefined);
    setFileName(file.name);
    if (/\.dwg$/iu.test(file.name)) { setProblem("DWG files cannot be read. In your CAD program use Save As or Export and choose DXF, then open that file here."); return; }
    if (file.size > MAX_FILE_BYTES) { setProblem(`The file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / (1024 * 1024)} MB.`); return; }
    try {
      setText(await file.text());
    } catch {
      setProblem("The file could not be read.");
    }
  };

  const importNow = (): void => {
    if (planned === undefined || !planned.ok) return;
    let done = 0;
    for (const plan of planned.value.plans) {
      if (props.onApply(plan) === false) {
        props.onMessage(`Import stopped after ${done} of ${planned.value.plans.length} edits; the edit that failed was refused (see the message above). Use Undo to remove the part already imported.`);
        return;
      }
      done += 1;
    }
    const summary = planned.value.summary;
    props.onMessage(`Imported ${summary.entityCount} curve${summary.entityCount === 1 ? "" : "s"} from ${fileName} (${Object.entries(summary.byKind).map(([kind, count]) => `${count} ${kind}`).join(", ")}) at ${mmPerUnit} mm per unit; ${Math.round(summary.widthMm * 100) / 100} x ${Math.round(summary.heightMm * 100) / 100} mm.${summary.droppedDuplicates + summary.droppedTiny > 0 ? ` Left out ${summary.droppedDuplicates} duplicate and ${summary.droppedTiny} too small curves.` : ""}`);
    props.onClose();
  };

  const toggle = (list: readonly string[], set: (next: readonly string[]) => void, name: string): void => set(list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name]);

  return <section className="inspector-section sketch-edit-panel" aria-label="Import a DXF or SVG drawing">
    <header><strong>Import DXF / SVG</strong><span>{props.sketch.entities.length} curves in the sketch</span></header>
    <p className="profile-help">Choose a DXF (lines, arcs, circles, ellipses, polylines, splines, points) or an SVG (paths and shapes). The curves become normal sketch curves. DWG is not supported: save it as DXF first. Nothing is uploaded.</p>
    <label><span>File</span><input type="file" aria-label="Drawing file" accept=".dxf,.svg,image/svg+xml,.dwg" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} /></label>
    {(problem !== "" || outcome.error !== undefined) && <p className="profile-help" role="alert">{problem !== "" ? problem : outcome.error}</p>}
    {parsed !== undefined && <>
      <p className="profile-help">{fileName}: {parsed.curves.length} curve{parsed.curves.length === 1 ? "" : "s"} read{parsed.format === "dxf" ? " from the DXF" : " from the SVG"}.</p>
      {parsed.warnings.length > 0 && <ul className="sketch-check-list">{parsed.warnings.map((warning, index) => <li key={index} className="check-warning"><b>Note</b><span>{warning}</span></li>)}</ul>}
      <label><span>Scale</span><select aria-label="Import scale" value={scaleChoice} onChange={(event) => { setScaleChoice(event.target.value); setConfirmed(event.target.value === "file" && parsed.units.source === "file"); }}>
        <option value="file">{parsed.units.name} ({Math.round(parsed.units.mmPerUnit * 1e6) / 1e6} mm per unit){parsed.units.source === "file" ? " - from the file" : " - assumed"}</option>
        {COMMON_IMPORT_SCALES.map((scale) => <option key={scale.label} value={String(scale.mmPerUnit)}>{scale.label} ({Math.round(scale.mmPerUnit * 1e6) / 1e6} mm per unit)</option>)}
        <option value="custom">Other...</option>
      </select></label>
      {scaleChoice === "custom" && numberField("Millimetres per unit", customScale, setCustomScale, "mm")}
      {!(scaleChoice === "file" && parsed.units.source === "file") && <label className="check-row"><input type="checkbox" aria-label="Confirm the scale" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>Yes, 1 drawing unit is {Math.round(mmPerUnit * 1e6) / 1e6} mm</span></label>}
      <label><span>Position</span><select aria-label="Import position" value={placement} onChange={(event) => setPlacement(event.target.value as ImportPlacement)}>
        <option value="as-is">As in the file</option><option value="center">Centre on the origin</option><option value="corner">Lower left corner on the origin</option>
      </select></label>
      {parsed.layers.length > 1 && <div className="record-list" aria-label="Layers">
        {parsed.layers.map((layer) => <div key={layer.name} className="check-row">
          <label><input type="checkbox" aria-label={`Import layer ${layer.name}`} checked={!skipped.includes(layer.name)} onChange={() => toggle(skipped, setSkipped, layer.name)} /> <span>{layer.name} ({layer.count})</span></label>
          <label><input type="checkbox" aria-label={`Layer ${layer.name} as construction`} checked={construction.includes(layer.name)} disabled={skipped.includes(layer.name)} onChange={() => toggle(construction, setConstruction, layer.name)} /> <small>construction</small></label>
        </div>)}
      </div>}
      <label className="check-row"><input type="checkbox" aria-label="Import everything as construction" checked={asConstruction} onChange={(event) => setAsConstruction(event.target.checked)} /><span>Everything as construction (a tracing guide)</span></label>
      {numberField("Join ends closer than", weld, setWeld, "mm")}
      {numberField("Curve fit tolerance", tolerance, setTolerance, "mm")}
      {planned !== undefined && !planned.ok && <p className="profile-help" role="alert">{planned.diagnostics[0]?.message} {planned.diagnostics[0]?.recovery}</p>}
      {planned?.ok === true && <p className="profile-help">{planned.value.summary.entityCount} curves ({Object.entries(planned.value.summary.byKind).map(([kind, count]) => `${count} ${kind}`).join(", ")}), {Math.round(planned.value.summary.widthMm * 100) / 100} x {Math.round(planned.value.summary.heightMm * 100) / 100} mm{planned.value.plans.length > 1 ? `, in ${planned.value.plans.length} edits` : ""}.</p>}
      <button className="palette-action primary" disabled={planned === undefined || !planned.ok || !confirmed} onClick={importNow}><CommandIcon name="open" />Import at {Math.round(mmPerUnit * 1e6) / 1e6} mm per unit</button>
    </>}
    <button className="palette-action" onClick={props.onClose}><CommandIcon name="cancel" />Done</button>
  </section>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------------------------

export function SketchExportPanel(props: CommonProps): React.JSX.Element {
  const [format, setFormat] = useState<"dxf" | "svg">("dxf");
  const [units, setUnits] = useState<DxfUnits>("mm");
  const [construction, setConstruction] = useState(true);
  const visible = props.sketch.entities.filter((entity) => entity.visible !== false && (construction || !entity.construction)).length;
  const run = (): void => {
    if (visible === 0) { props.onMessage("There is nothing to export: the sketch has no visible curves."); return; }
    const stem = safeFileStem(props.sketch.name);
    if (format === "dxf") download(writeSketchDxf(props.sketch, { units, includeConstruction: construction, title: `PS3D CAD Studio: ${props.sketch.name}` }), `${stem}.dxf`, "application/dxf");
    else download(writeSketchSvg(props.sketch, { includeConstruction: construction, title: props.sketch.name }), `${stem}.svg`, "image/svg+xml");
    props.onMessage(`Exported ${visible} curve${visible === 1 ? "" : "s"} of ${props.sketch.name} as ${format.toUpperCase()}${format === "dxf" ? ` in ${units === "mm" ? "millimetres" : "inches"}` : " in millimetres"}${construction ? ", construction curves on their own layer" : ""}.`);
  };
  return <section className="inspector-section sketch-edit-panel" aria-label="Export the sketch as DXF or SVG">
    <header><strong>Export DXF / SVG</strong><span>{visible} visible curves</span></header>
    <p className="profile-help">DXF is R2000 with the profile on layer 0 and construction curves on their own CONSTRUCTION layer. Lines, arcs, circles, ellipses and points keep their type, rectangles become closed polylines, splines become cubic splines. SVG is in millimetres, upright.</p>
    <label><span>Format</span><select aria-label="Export format" value={format} onChange={(event) => setFormat(event.target.value as "dxf" | "svg")}><option value="dxf">DXF (R2000)</option><option value="svg">SVG</option></select></label>
    {format === "dxf" && <label><span>Units</span><select aria-label="DXF units" value={units} onChange={(event) => setUnits(event.target.value as DxfUnits)}><option value="mm">Millimetres</option><option value="in">Inches</option></select></label>}
    <label className="check-row"><input type="checkbox" aria-label="Include construction curves" checked={construction} onChange={(event) => setConstruction(event.target.checked)} /><span>Include construction curves</span></label>
    <button className="palette-action primary" disabled={visible === 0} onClick={run}><CommandIcon name="export" />Download {format.toUpperCase()}</button>
    <button className="palette-action" onClick={props.onClose}><CommandIcon name="cancel" />Done</button>
  </section>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Picture underlay
// ---------------------------------------------------------------------------------------------------------------------

export interface UnderlayPickState {
  readonly active: boolean;
  readonly points: readonly Vec2[];
}

export function SketchUnderlayPanel(props: CommonProps & { readonly pick: UnderlayPickState; readonly onPickStart: () => void; readonly onPickCancel: () => void }): React.JSX.Element {
  const underlay: SketchUnderlay | undefined = props.sketch.underlay;
  const [distance, setDistance] = useState("100");
  const [opacity, setOpacity] = useState(String(Math.round((underlay?.opacity ?? 0.5) * 100)));
  const [moveX, setMoveX] = useState("0");
  const [moveY, setMoveY] = useState("0");
  const [angle, setAngle] = useState("0");
  const [stored, setStored] = useState<boolean | undefined>(undefined);
  useEffect(() => { setOpacity(String(Math.round((underlay?.opacity ?? 0.5) * 100))); }, [underlay?.opacity]);
  useEffect(() => {
    let alive = true;
    if (underlay === undefined) { setStored(undefined); return; }
    void browserImageStore.get(underlay.imageId).then((found) => { if (alive) setStored(found !== undefined); });
    return () => { alive = false; };
  }, [underlay?.imageId]);

  const load = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = readImageInfo(bytes);
      if (!info.ok) { props.onMessage(info.diagnostics[0]?.message ?? "The picture could not be read."); return; }
      const imageId = imageIdOf(bytes);
      await browserImageStore.put(imageId, bytes, info.value.format === "png" ? "image/png" : "image/jpeg");
      setStored(true);
      // Re-attaching the same picture keeps the placement the sketch already has.
      const next = underlay !== undefined && underlay.imageId === imageId ? underlay : createUnderlay(info.value, imageId, file.name);
      if (props.onApply(planUnderlay(next, underlay === undefined ? `Added picture ${file.name}` : `Replaced the picture with ${file.name}`)) === false) return;
      props.onMessage(`Loaded ${file.name} (${info.value.widthPx} x ${info.value.heightPx} pixels) as a locked background, 200 mm wide until you calibrate it. Pick two points on the picture and enter their real distance to set the scale.`);
    } catch {
      props.onMessage("The picture could not be read.");
    }
  };

  const apply = (result: { readonly ok: true; readonly value: SketchUnderlay } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }, label: string): void => {
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "That change was refused."); return; }
    props.onApply(planUnderlay(result.value, label));
  };

  const calibrate = (): void => {
    if (underlay === undefined) return;
    if (props.pick.points.length < 2) { props.onMessage("Pick two points on the picture first."); return; }
    const known = parseNumber(distance);
    const result = calibrateUnderlay(underlay, props.pick.points[0]!, props.pick.points[1]!, known);
    apply(result, `Calibrated the picture: ${distance} mm`);
    if (result.ok) { props.onPickCancel(); props.onMessage(`Calibrated: one pixel is now ${Math.round(result.value.mmPerPixel * 1e5) / 1e5} mm, so the picture is ${Math.round(result.value.widthPx * result.value.mmPerPixel * 10) / 10} mm wide.`); }
  };

  return <section className="inspector-section sketch-edit-panel" aria-label="Picture underlay for tracing">
    <header><strong>Picture to trace</strong><span>{underlay === undefined ? "none" : underlay.name}</span></header>
    <p className="profile-help">Load a PNG or JPEG from this computer. It sits behind the sketch, locked, and is never uploaded. Calibrate it by picking two points on the picture and typing their real distance, then trace over it with the sketch tools.</p>
    <label><span>{underlay === undefined ? "Picture" : "Replace picture"}</span><input type="file" aria-label="Picture file" accept="image/png,image/jpeg" onChange={(event) => { void load(event.target.files?.[0]); event.target.value = ""; }} /></label>
    {underlay !== undefined && <>
      {stored === false && <p className="profile-help" role="alert">The pixels of {underlay.name} are not stored in this browser (the project was opened elsewhere). Load the same picture again to see it; the scale and position are kept.</p>}
      <p className="profile-help">{underlay.widthPx} x {underlay.heightPx} pixels, {Math.round(underlay.mmPerPixel * 1e5) / 1e5} mm per pixel, {Math.round(underlay.widthPx * underlay.mmPerPixel * 10) / 10} x {Math.round(underlay.heightPx * underlay.mmPerPixel * 10) / 10} mm. Locked.</p>
      <label><span>Opacity</span><div className="distance-entry"><input type="range" aria-label="Picture opacity" min={5} max={100} step={5} value={opacity} onChange={(event) => setOpacity(event.target.value)} onPointerUp={() => apply(setUnderlayOpacity(underlay, Number(opacity) / 100), `Picture opacity ${opacity} percent`)} onKeyUp={() => apply(setUnderlayOpacity(underlay, Number(opacity) / 100), `Picture opacity ${opacity} percent`)} /><small>{opacity}%</small></div></label>
      <div className="make-solid-row">
        <button className={`palette-action${props.pick.active ? " primary" : ""}`} onClick={props.pick.active ? props.onPickCancel : props.onPickStart}><CommandIcon name="measure" />{props.pick.active ? `Picking: ${props.pick.points.length} of 2 (click to cancel)` : "Pick two points"}</button>
      </div>
      {numberField("Real distance between them", distance, setDistance, "mm")}
      <button className="palette-action primary" disabled={props.pick.points.length < 2} onClick={calibrate}><CommandIcon name="cube-check" />Calibrate scale</button>
      {numberField("Move X", moveX, setMoveX, "mm")}{numberField("Move Y", moveY, setMoveY, "mm")}
      <button className="palette-action" onClick={() => apply(moveUnderlay(underlay, parseNumber(moveX), parseNumber(moveY)), `Moved the picture by ${moveX}, ${moveY} mm`)}><CommandIcon name="move" />Move picture</button>
      {numberField("Turn by", angle, setAngle, "°")}
      <button className="palette-action" onClick={() => apply(rotateUnderlay(underlay, parseNumber(angle)), `Turned the picture by ${angle} degrees`)}><CommandIcon name="revolve" />Turn picture</button>
      <button className="palette-action" onClick={() => props.onApply(planUnderlay({ ...underlay, visible: !underlay.visible }, underlay.visible ? "Hid the picture" : "Showed the picture"))}><CommandIcon name={underlay.visible ? "eye-off" : "eye"} />{underlay.visible ? "Hide picture" : "Show picture"}</button>
      <button className="palette-action" onClick={() => { props.onApply(planUnderlay(null, "Removed the picture")); props.onPickCancel(); }}><CommandIcon name="trash" />Remove picture</button>
    </>}
    <button className="palette-action" onClick={() => { props.onPickCancel(); props.onClose(); }}><CommandIcon name="cancel" />Done</button>
  </section>;
}
