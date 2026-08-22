import { useMemo, useState, type ChangeEvent, type DragEvent } from "react";
import {
  EXCHANGE_FORMATS,
  formatForFileName,
  type ExchangeExportFormat,
  type ExchangeImportResult,
  type ExchangeSupport,
  type ExchangeUnit
} from "../../../../packages/exchange-3d/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

type ExchangeTab = "import" | "export" | "pdf" | "formats";

interface ExchangeCenterProps {
  readonly open: boolean;
  readonly busy: boolean;
  readonly hasScene: boolean;
  readonly activeImport: ExchangeImportResult | undefined;
  readonly feedback: string;
  readonly onClose: () => void;
  readonly onImport: (files: readonly File[], unit: ExchangeUnit) => void;
  readonly onExport: (format: ExchangeExportFormat, unit: Exclude<ExchangeUnit, "auto">) => void;
  readonly onPdfPackage: () => void;
  readonly onInteractivePdf: (file: File) => void;
  readonly onClearImport: () => void;
}

const IMPORT_ACCEPT = EXCHANGE_FORMATS
  .filter((format) => format.support === "local" && (format.direction === "import" || format.direction === "both"))
  .flatMap((format) => format.extensions)
  .join(",");

const EXPORT_FORMATS: readonly { id: ExchangeExportFormat; name: string; tag: string; icon: string; description: string; unitless: boolean }[] = [
  { id: "glb", name: "GLB", tag: "recommended", icon: "cube-file", description: "One compact binary glTF scene with embedded materials and images.", unitless: false },
  { id: "gltf", name: "glTF", tag: "web scene", icon: "scene-file", description: "Readable JSON runtime scene with embedded data resources.", unitless: false },
  { id: "obj", name: "OBJ", tag: "mesh", icon: "mesh-file", description: "Portable polygon geometry; receiving tools need the selected unit.", unitless: true },
  { id: "stl", name: "STL", tag: "fabrication", icon: "triangle-file", description: "Binary triangle surface for slicers and manufacturing reference.", unitless: true },
  { id: "ply", name: "PLY", tag: "mesh / color", icon: "points-file", description: "Binary polygon data with supported vertex attributes.", unitless: true },
  { id: "usdz", name: "USDZ", tag: "scene package", icon: "package-file", description: "Packaged runtime scene for compatible USD and quick-look viewers.", unitless: false }
];

export function ExchangeCenter(props: ExchangeCenterProps): React.JSX.Element | null {
  const [tab, setTab] = useState<ExchangeTab>("import");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [sourceUnit, setSourceUnit] = useState<ExchangeUnit>("auto");
  const [exportUnit, setExportUnit] = useState<Exclude<ExchangeUnit, "auto">>("mm");
  const [interactivePayload, setInteractivePayload] = useState<File>();
  const [formatFilter, setFormatFilter] = useState<"all" | ExchangeSupport>("all");
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);
  const primaryFormat = useMemo(() => files.map((file) => formatForFileName(file.name)).find((format) => format !== undefined), [files]);
  const visibleFormats = useMemo(() => EXCHANGE_FORMATS.filter((format) => formatFilter === "all" || format.support === formatFilter), [formatFilter]);

  if (!props.open) return null;

  const acceptFiles = (next: FileList | readonly File[]): void => {
    setFiles(Array.from(next).slice(0, 64));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (!props.busy) acceptFiles(event.dataTransfer.files);
  };

  return <div className="exchange-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}>
    <section ref={dialogRef} tabIndex={-1} className="exchange-center" role="dialog" aria-modal="true" aria-labelledby="exchange-title">
      <header className="exchange-header">
        <div className="exchange-emblem" aria-hidden="true"><CommandIcon name="exchange" /><i /></div>
        <div>
          <span>LOCAL 3D INTEROPERABILITY</span>
          <h2 id="exchange-title">3D Exchange Center</h2>
          <p>Reference import, tessellated export, and audited PDF delivery without uploading model data.</p>
        </div>
        <div className="exchange-header-facts">
          <span><i className="safe" />local files only</span>
          <span><i />200 MB bounded</span>
          <span><i />remote URLs blocked</span>
        </div>
        <button data-dialog-initial-focus className="exchange-close" onClick={props.onClose} aria-label="Close 3D Exchange Center"><CommandIcon name="cancel" /></button>
      </header>

      <nav className="exchange-tabs" aria-label="Exchange workflows">
        <Tab id="import" active={tab === "import"} icon="import" label="Import" note="14 local families" onClick={setTab} />
        <Tab id="export" active={tab === "export"} icon="export" label="Export" note="6 scene / mesh" onClick={setTab} />
        <Tab id="pdf" active={tab === "pdf"} icon="pdf-3d" label="3D PDF" note="package + pass-through" onClick={setTab} />
        <Tab id="formats" active={tab === "formats"} icon="matrix" label="Format matrix" note="truthful support" onClick={setTab} />
      </nav>

      <div className="exchange-body">
        {tab === "import" && <div className="exchange-import-layout">
          <section className="exchange-primary-panel">
            <div className="exchange-section-heading">
              <div><span>01 / SELECT</span><h3>Open a reference model</h3></div>
              <span className="exchange-badge local"><i />IN-BROWSER</span>
            </div>
            <div className={`exchange-dropzone ${files.length > 0 ? "has-files" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
              <input id="exchange-files" type="file" multiple accept={IMPORT_ACCEPT} disabled={props.busy} onChange={(event: ChangeEvent<HTMLInputElement>) => acceptFiles(event.target.files ?? [])} />
              <label htmlFor="exchange-files">
                <span className="dropzone-icon"><CommandIcon name="import" /></span>
                <strong>{files.length === 0 ? "Choose model + companions" : `${files.length} local file${files.length === 1 ? "" : "s"} selected`}</strong>
                <small>Drop here or browse · GLB, glTF, OBJ, STL, PLY, 3MF, DAE, FBX, AMF, 3DS, VRML, VTK, USD family, G-code, XYZ</small>
              </label>
              {files.length > 0 && <div className="exchange-file-list">
                {files.slice(0, 6).map((file, index) => <div key={`${file.name}:${index}`}>
                  <CommandIcon name={index === 0 ? "cube-file" : "link-file"} />
                  <span><strong>{file.name}</strong><small>{formatBytes(file.size)}{index === 0 ? " · primary candidate" : " · companion"}</small></span>
                </div>)}
                {files.length > 6 && <small>+ {files.length - 6} additional companion files</small>}
              </div>}
            </div>
            <div className="exchange-import-controls">
              <label><span>Source units</span><select value={sourceUnit} onChange={(event) => setSourceUnit(event.target.value as ExchangeUnit)}>
                <option value="auto">Auto by format</option><option value="mm">Millimeter</option><option value="cm">Centimeter</option><option value="m">Meter</option><option value="in">Inch</option>
              </select></label>
              <div className="detected-format"><span>Detected</span><strong>{primaryFormat?.name ?? "waiting for file"}</strong><small>{primaryFormat?.fidelity ?? "Companion textures and buffers may be selected together."}</small></div>
              <button className="exchange-action primary" disabled={props.busy || files.length === 0 || primaryFormat?.support !== "local"} onClick={() => props.onImport(files, sourceUnit)}><CommandIcon name="import" /><span><strong>{props.busy ? "Parsing locally…" : "Import reference"}</strong><small>No upload · fit after load</small></span></button>
            </div>
            <div className="exchange-truth-note"><CommandIcon name="inspect" /><p><strong>Reference geometry, not feature recovery.</strong> Imported meshes and scenes can be viewed, measured, selected, and re-exported. They do not become editable sketches, constraints, B-rep faces, or Fusion-style history features.</p></div>
          </section>

          <aside className="exchange-result-panel">
            <div className="exchange-section-heading"><div><span>02 / REVIEW</span><h3>Model audit</h3></div>{props.activeImport !== undefined && <span className="exchange-badge ready"><i />READY</span>}</div>
            {props.activeImport === undefined ? <div className="exchange-empty-audit"><span><CommandIcon name="scan" /></span><strong>No imported reference</strong><p>The parser will report scale, scene bounds, meshes, vertices, triangles, points, and fidelity warnings before you work with the model.</p><div className="audit-skeleton"><i /><i /><i /><i /></div></div> : <ImportAudit result={props.activeImport} onClear={props.onClearImport} />}
          </aside>
        </div>}

        {tab === "export" && <div className="exchange-export-layout">
          <section className="exchange-primary-panel">
            <div className="exchange-section-heading"><div><span>VISIBLE SCENE</span><h3>Export runtime geometry</h3></div><span className={`exchange-badge ${props.hasScene ? "ready" : ""}`}><i />{props.hasScene ? "SCENE READY" : "NO SCENE"}</span></div>
            <div className="exchange-export-toolbar">
              <p>The active viewport scene is exported. Hidden objects stay out. GLB/glTF use meters; unitless mesh formats use your coordinate-unit choice.</p>
              <label><span>Mesh coordinate unit</span><select value={exportUnit} onChange={(event) => setExportUnit(event.target.value as Exclude<ExchangeUnit, "auto">)}><option value="mm">mm</option><option value="cm">cm</option><option value="m">m</option><option value="in">in</option></select></label>
            </div>
            <div className="exchange-export-grid">
              {EXPORT_FORMATS.map((format) => <article key={format.id} data-format={format.id} className={format.id === "glb" ? "recommended" : ""}>
                <header><span><CommandIcon name={format.icon} /></span><em>{format.tag}</em></header>
                <h4>{format.name}</h4><p>{format.description}</p>
                <footer><small>{format.unitless ? `coordinates: ${exportUnit}` : "meters / embedded scene"}</small><button data-testid={`export-${format.id}`} disabled={!props.hasScene || props.busy} onClick={() => props.onExport(format.id, exportUnit)}>Export <CommandIcon name="arrow-right" /></button></footer>
              </article>)}
            </div>
          </section>
          <aside className="exchange-side-note">
            <span className="side-note-icon"><CommandIcon name="layers" /></span><h3>Fidelity boundary</h3>
            <dl><div><dt>Included</dt><dd>Visible triangle geometry, transforms, and supported runtime materials.</dd></div><div><dt>Not included</dt><dd>Sketch constraints, exact faces, mates, parametric feature definitions, or licensed native-CAD records.</dd></div><div><dt>Best handoff</dt><dd>Use GLB for web/MCP pipelines; STL for fabrication mesh; upstream neutral exact CAD remains a future kernel track.</dd></div></dl>
          </aside>
        </div>}

        {tab === "pdf" && <div className="exchange-pdf-layout">
          <section className="pdf-hero-card package">
            <header><span><CommandIcon name="pdf-package" /></span><div><em>WORKS FROM ANY VISIBLE MODEL</em><h3>PDF model package</h3></div></header>
            <p>A polished engineering audit page plus the current model attached as GLB inside the PDF. It is portable and useful, but it is intentionally not mislabeled as an interactive U3D/PRC annotation.</p>
            <div className="pdf-flow"><span>viewport preview</span><b>+</b><span>model metrics</span><b>+</b><span>attached GLB</span><b>→</b><strong>PDF</strong></div>
            <button className="exchange-action primary" disabled={!props.hasScene || props.busy} onClick={props.onPdfPackage}><CommandIcon name="pdf-package" /><span><strong>Export PDF model package</strong><small>Report page + embedded ps3d-model.glb</small></span></button>
          </section>
          <section className="pdf-hero-card interactive">
            <header><span><CommandIcon name="pdf-3d" /></span><div><em>ADVANCED PASS-THROUGH</em><h3>True interactive 3D PDF</h3></div></header>
            <p>Adobe-style interactive 3D annotations require an already encoded U3D or PRC stream. PS3D can embed that payload without altering it; this free browser build does not claim to convert GLB, STL, or CAD solids into U3D/PRC.</p>
            <label className="interactive-file"><input type="file" accept=".u3d,.prc" disabled={props.busy} onChange={(event) => setInteractivePayload(event.target.files?.[0])} /><span><CommandIcon name="open" /></span><div><strong>{interactivePayload?.name ?? "Choose .u3d or .prc payload"}</strong><small>{interactivePayload === undefined ? "Maximum 200 MB · payload is embedded unchanged" : formatBytes(interactivePayload.size)}</small></div></label>
            <button className="exchange-action amber" disabled={interactivePayload === undefined || props.busy} onClick={() => { if (interactivePayload !== undefined) props.onInteractivePdf(interactivePayload); }}><CommandIcon name="pdf-3d" /><span><strong>Build interactive PDF</strong><small>Viewer trust prompt may be required</small></span></button>
          </section>
          <div className="pdf-security-note"><CommandIcon name="shield" /><div><strong>Playback is viewer-dependent.</strong><p>Many PDF viewers do not render 3D annotations, and Acrobat disables automatic 3D playback by default for security. The model-package PDF remains readable everywhere even when its GLB attachment needs a separate viewer.</p></div></div>
        </div>}

        {tab === "formats" && <div className="format-matrix-panel">
          <div className="exchange-section-heading"><div><span>CAPABILITY TRUTH TABLE</span><h3>Every cataloged 3D family</h3></div><span className="matrix-count">{visibleFormats.length} / {EXCHANGE_FORMATS.length}</span></div>
          <div className="matrix-filters">
            {(["all", "local", "pdf-pass-through", "converter-required", "kernel-required"] as const).map((filter) => <button key={filter} className={formatFilter === filter ? "active" : ""} onClick={() => setFormatFilter(filter)}>{supportLabel(filter)}</button>)}
          </div>
          <div className="format-table" role="table" aria-label="3D exchange support matrix">
            <div className="format-table-head" role="row"><span>Format family</span><span>Direction</span><span>Availability</span><span>Fidelity</span></div>
            {visibleFormats.map((format) => <div className="format-row" role="row" key={format.id}>
              <div><span className={`format-glyph ${format.category}`}><CommandIcon name={format.category === "exact-cad" ? "kernel" : format.category === "pdf-payload" ? "pdf-3d" : "cube-file"} /></span><span><strong>{format.name}</strong><small>{format.extensions.join(" · ")}</small></span></div>
              <span className="direction-cell">{format.direction}</span>
              <span className={`support-pill ${format.support}`}>{supportLabel(format.support)}</span>
              <span className="fidelity-cell"><strong>{format.summary}</strong><small>{format.fidelity}</small></span>
            </div>)}
          </div>
        </div>}
      </div>

      <footer className="exchange-footer"><div className={props.feedback.toLowerCase().includes("failed") || props.feedback.toLowerCase().includes("error") ? "error" : ""}><i />{props.feedback || "Ready for a bounded local exchange operation."}</div><span>PS3D original exchange stack · no cloud converter configured</span></footer>
    </section>
  </div>;
}

function Tab(props: { id: ExchangeTab; active: boolean; icon: string; label: string; note: string; onClick: (tab: ExchangeTab) => void }): React.JSX.Element {
  return <button className={props.active ? "active" : ""} aria-current={props.active ? "page" : undefined} onClick={() => props.onClick(props.id)}><span><CommandIcon name={props.icon} /></span><div><strong>{props.label}</strong><small>{props.note}</small></div></button>;
}

function ImportAudit({ result, onClear }: { result: ExchangeImportResult; onClear: () => void }): React.JSX.Element {
  const bounds = result.metrics.bounds.sizeMeters.map((value) => value * 1000);
  return <div className="import-audit">
    <div className="audit-model-title"><span><CommandIcon name="cube-check" /></span><div><strong>{result.primaryFileName}</strong><small>{result.format.name} · source unit {result.sourceUnit}</small></div></div>
    <div className="audit-metrics">
      <Metric label="Meshes" value={result.metrics.meshCount.toLocaleString()} tone="cyan" />
      <Metric label="Triangles" value={result.metrics.triangleCount.toLocaleString()} tone="violet" />
      <Metric label="Vertices" value={result.metrics.vertexCount.toLocaleString()} tone="amber" />
      <Metric label="Points" value={result.metrics.pointCount.toLocaleString()} tone="green" />
    </div>
    <div className="audit-bounds"><span>Model envelope</span><strong>{bounds.map((value) => value.toFixed(2)).join(" × ")} mm</strong><small>{result.metrics.objectCount} scene objects · {result.metrics.materialCount} materials · {result.companionFileNames.length} companions</small></div>
    <div className="audit-warnings"><span>Fidelity notes</span>{result.warnings.map((warning, index) => <p key={index}><i />{warning}</p>)}</div>
    <button className="audit-clear" onClick={onClear}><CommandIcon name="return" />Return to native PS3D body</button>
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }): React.JSX.Element {
  return <div className={tone}><span>{label}</span><strong>{value}</strong></div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function supportLabel(value: "all" | ExchangeSupport): string {
  if (value === "all") return "All families";
  if (value === "local") return "Local now";
  if (value === "pdf-pass-through") return "PDF pass-through";
  if (value === "converter-required") return "Converter required";
  return "Kernel required";
}
