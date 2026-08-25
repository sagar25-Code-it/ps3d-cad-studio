import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildMasterCartItem,
  createMasterCartConfiguration,
  MASTER_CART_CATEGORIES,
  MASTER_CART_TEMPLATES,
  masterCartTemplate,
  type MasterCartCategoryId,
  type MasterCartConfiguration,
  type MasterCartTemplateId,
  type MasterCartUnitSystem
} from "../../../../packages/workbench-core/src/index.js";
import { buildAssemblyPreview } from "../../../../packages/workbench-geometry/src/index.js";
import { ThreeViewportAdapter, type NavigationMode } from "../../../../packages/viewport-three/src/index.js";
import { PS3D_BRAND } from "../brand.js";
import { BrandLogo } from "../ui/BrandLogo.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";

interface MasterCartWorkspaceProps {
  readonly assemblyComponentCount: number;
  readonly onAdd: (templateId: MasterCartTemplateId, configuration: MasterCartConfiguration, designation: string) => void;
  readonly onMessage: (message: string) => void;
}

type UnitFilter = Exclude<MasterCartUnitSystem, "universal"> | "all";

export function MasterCartWorkspace(props: MasterCartWorkspaceProps): React.JSX.Element {
  const [categoryId, setCategoryId] = useState<MasterCartCategoryId>("fasteners");
  const [templateId, setTemplateId] = useState<MasterCartTemplateId>("socket-head-cap-screw");
  const [configuration, setConfiguration] = useState<MasterCartConfiguration>(() => createMasterCartConfiguration("socket-head-cap-screw"));
  const [unitFilter, setUnitFilter] = useState<UnitFilter>("metric");
  const [query, setQuery] = useState("");
  const [navigationMode, setNavigationMode] = useState<NavigationMode>("orbit");
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<ThreeViewportAdapter | undefined>(undefined);
  const selectedTemplate = masterCartTemplate(templateId);
  const preview = useMemo(() => buildMasterCartItem(templateId, configuration, "master-cart:preview"), [configuration, templateId]);
  const previewScene = useMemo(() => buildAssemblyPreview({
    id: "assembly:fixture-demo",
    name: preview.designation,
    explodeMm: 0,
    template: "custom",
    designStatus: "editable-preview",
    components: preview.components,
    mates: []
  }), [preview]);

  useEffect(() => {
    if (canvasRef.current === null) return;
    const viewport = new ThreeViewportAdapter(canvasRef.current, { onSelectBody: setSelectedPreviewId });
    viewport.setNavigationMode("orbit");
    viewport.setSelectionFilter("component");
    viewport.setShadingMode("shaded-edges");
    viewport.setBackgroundTone("light-gray");
    viewportRef.current = viewport;
    return () => { viewport.dispose(); viewportRef.current = undefined; };
  }, []);

  useEffect(() => {
    viewportRef.current?.setScene(previewScene);
    viewportRef.current?.setSelectedId(selectedPreviewId);
  }, [previewScene, selectedPreviewId]);

  const visibleTemplates = MASTER_CART_TEMPLATES.filter((item) => item.categoryId === categoryId)
    .filter((item) => `${item.name} ${item.family} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const sizeOptions = selectedTemplate.sizeOptions.filter((option) => unitFilter === "all" || option.system === unitFilter || option.system === "universal");
  const selectedRole = preview.components.find((component) => component.id === selectedPreviewId)?.masterCart?.role;

  const chooseCategory = (next: MasterCartCategoryId): void => {
    const first = MASTER_CART_TEMPLATES.find((item) => item.categoryId === next);
    if (first === undefined) return;
    setCategoryId(next);
    setQuery("");
    chooseTemplate(first.id);
  };

  const chooseTemplate = (next: MasterCartTemplateId): void => {
    const nextTemplate = masterCartTemplate(next);
    const nextConfiguration = createMasterCartConfiguration(next);
    const system = nextTemplate.sizeOptions.find((option) => option.id === nextConfiguration.sizeId)?.system;
    setTemplateId(next);
    setConfiguration(nextConfiguration);
    setUnitFilter(system === "inch" ? "inch" : "metric");
    setSelectedPreviewId(null);
    props.onMessage(`${nextTemplate.name} opened as an original PS3D parametric preview.`);
  };

  const chooseUnit = (next: UnitFilter): void => {
    setUnitFilter(next);
    if (next === "all") return;
    const first = selectedTemplate.sizeOptions.find((option) => option.system === next || option.system === "universal");
    if (first !== undefined) setConfiguration((current) => ({ ...current, sizeId: first.id }));
  };

  const setNavigation = (mode: NavigationMode): void => {
    setNavigationMode(mode);
    viewportRef.current?.setNavigationMode(mode);
  };

  return <section className="master-cart-workspace" aria-label="PS3D Master Cart parametric component catalog" data-testid="master-cart-workspace">
    <aside className="master-cart-categories">
      <header><BrandLogo /><div><small>{PS3D_BRAND.name}</small><strong>Master Cart</strong><span>Parametric component studio</span></div></header>
      <nav aria-label="Master Cart categories">{MASTER_CART_CATEGORIES.map((category) => <button key={category.id} className={categoryId === category.id ? "active" : ""} onClick={() => chooseCategory(category.id)} data-testid={`master-cart-category-${category.id}`}><CommandIcon name={category.icon} /><span><strong>{category.label}</strong><small>{MASTER_CART_TEMPLATES.filter((item) => item.categoryId === category.id).length} ready families</small></span></button>)}</nav>
      <section className="master-cart-origin-note"><CommandIcon name="shield" /><div><strong>Original PS3D geometry</strong><p>No supplier images, page design, SKU database, availability, or pricing is copied into this project.</p></div></section>
      <footer><span>{MASTER_CART_TEMPLATES.length} templates</span><span>{props.assemblyComponentCount} assembly bodies</span></footer>
    </aside>

    <section className="master-cart-library">
      <header className="master-cart-search"><div><span>COMPONENT LIBRARY</span><strong>{MASTER_CART_CATEGORIES.find((category) => category.id === categoryId)?.label}</strong></div><label><CommandIcon name="inspect" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this category" aria-label="Search Master Cart templates" /></label></header>
      <div className="master-cart-template-grid" data-testid="master-cart-template-grid">{visibleTemplates.map((item) => <button key={item.id} className={templateId === item.id ? "selected" : ""} onClick={() => chooseTemplate(item.id)} data-testid={`master-cart-template-${item.id}`}><span className="master-cart-template-icon"><CommandIcon name={item.icon} /></span><span><strong>{item.name}</strong><small>{item.family}</small><em>{item.sizeOptions.length} standard-oriented sizes</em></span><CapabilityBadge level="preview" /></button>)}</div>
      {visibleTemplates.length === 0 && <div className="master-cart-empty"><CommandIcon name="inspect" /><strong>No matching template</strong><p>Clear the category search to restore the complete curated family list.</p></div>}
    </section>

    <section className="master-cart-preview" aria-label={`${preview.designation} interactive preview`}>
      <header><div><span>LIVE 3D PREVIEW</span><strong>{preview.designation}</strong><small>{selectedRole === undefined ? `${preview.components.length} grouped preview bodies` : `Selected detail · ${selectedRole}`}</small></div><CapabilityBadge level="preview" /></header>
      <div className="master-cart-canvas-shell">
        <canvas ref={canvasRef} className="master-cart-canvas" role="img" aria-label={`Interactive 3D preview of ${preview.designation}`} data-testid="master-cart-preview-canvas" />
        <div className="master-cart-view-controls" aria-label="Catalog preview navigation">
          <button className={navigationMode === "orbit" ? "active" : ""} onClick={() => setNavigation("orbit")}><CommandIcon name="orbit" />Orbit</button>
          <button className={navigationMode === "pan" ? "active" : ""} onClick={() => setNavigation("pan")}><CommandIcon name="pan" />Pan</button>
          <button className={navigationMode === "select" ? "active" : ""} onClick={() => setNavigation("select")}><CommandIcon name="select" />Select</button>
          <button onClick={() => viewportRef.current?.fitPreview(previewScene.boundsMm)}><CommandIcon name="fit" />Fit</button>
          <button onClick={() => viewportRef.current?.setOrientation("isometric")}><CommandIcon name="home" />Iso</button>
          <button onClick={() => viewportRef.current?.setOrientation("front")}><CommandIcon name="projection" />Front</button>
          <button onClick={() => viewportRef.current?.setOrientation("top")}><CommandIcon name="projection" />Top</button>
        </div>
        <div className="master-cart-axis"><i /><b>X</b><em>Y</em><strong>Z</strong><span>WCS</span></div>
        <div className="master-cart-preview-facts"><span><small>Geometry</small><strong>original parametric</strong></span><span><small>Units</small><strong>mm internal</strong></span><span><small>Assembly</small><strong>grouped insert</strong></span></div>
      </div>
      <footer><CommandIcon name="appearance" /><span>Neutral CAD gray and material cues are display-only. MMB pan · Shift+MMB / right drag orbit · wheel zoom.</span></footer>
    </section>

    <aside className="master-cart-config" aria-label="Master Cart configuration inspector">
      <header><div><span>CONFIGURE COMPONENT</span><strong>{selectedTemplate.name}</strong><small>{selectedTemplate.standardBasis}</small></div><CommandIcon name={selectedTemplate.icon} /></header>
      <fieldset className="master-cart-unit-toggle"><legend>Unit system</legend>{(["metric", "inch", "all"] as const).map((system) => <button key={system} className={unitFilter === system ? "active" : ""} disabled={system !== "all" && !selectedTemplate.sizeOptions.some((option) => option.system === system || option.system === "universal")} onClick={() => chooseUnit(system)}>{system === "all" ? "All sizes" : system}</button>)}</fieldset>
      <label className="master-cart-field"><span>Nominal size / series</span><select value={configuration.sizeId} onChange={(event) => setConfiguration((current) => ({ ...current, sizeId: event.target.value }))} data-testid="master-cart-size">{!sizeOptions.some((option) => option.id === configuration.sizeId) ? <option value={configuration.sizeId}>{selectedTemplate.sizeOptions.find((option) => option.id === configuration.sizeId)?.label}</option> : null}{sizeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label className="master-cart-field"><span>Material</span><select value={configuration.materialId} onChange={(event) => setConfiguration((current) => ({ ...current, materialId: event.target.value }))} data-testid="master-cart-material">{selectedTemplate.materialOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label className="master-cart-field"><span>Finish</span><select value={configuration.finishId} onChange={(event) => setConfiguration((current) => ({ ...current, finishId: event.target.value }))}>{selectedTemplate.finishOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      {selectedTemplate.editableFields.length > 0 && <section className="master-cart-editable"><header><strong>Editable geometry</strong><span>bounded</span></header><div>{selectedTemplate.editableFields.map((editable) => <label key={editable.id}><span>{editable.label}</span><span><input type="number" min={editable.minimum} max={editable.maximum} step={editable.step} value={configuration.values[editable.id] ?? editable.defaultValue} onChange={(event) => setConfiguration((current) => ({ ...current, values: { ...current.values, [editable.id]: Number(event.target.value) } }))} data-testid={`master-cart-field-${editable.id}`} /><small>{editable.unit === "count" ? "qty" : editable.unit}</small></span></label>)}</div></section>}
      <section className="master-cart-dimensions"><header><strong>Resulting dimensions</strong><span>{preview.dimensions.length}</span></header><table><tbody>{preview.dimensions.map((dimension) => <tr key={dimension.key}><th>{dimension.symbol}</th><td>{dimension.label}</td><td>{formatDimension(dimension.value, dimension.unit)}{dimension.unit === "mm" ? " mm" : dimension.unit === "deg" ? "°" : ""}</td></tr>)}</tbody></table></section>
      <section className="master-cart-source"><header><CommandIcon name="link-file" /><strong>Selection reference</strong></header><p>{selectedTemplate.description}</p><a href={preview.sourceUrl} target="_blank" rel="noreferrer">Open related McMaster category <CommandIcon name="arrow-right" /></a><small>Reference link only · PS3D is not affiliated with or endorsed by McMaster-Carr.</small></section>
      <button className="master-cart-add" onClick={() => props.onAdd(templateId, configuration, preview.designation)} data-testid="master-cart-add-to-assembly"><CommandIcon name="assemble" /><span><strong>Add to Assembly</strong><small>One undoable grouped insertion · {preview.components.length} preview bodies</small></span><CommandIcon name="arrow-right" /></button>
      <section className="master-cart-boundary"><CommandIcon name="shield" /><p>{preview.boundary}</p></section>
    </aside>
  </section>;
}

function formatDimension(value: number, unit: "mm" | "count" | "deg"): string {
  if (unit === "count") return String(Math.round(value));
  return Number(value.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
