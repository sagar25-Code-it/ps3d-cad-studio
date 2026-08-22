import { createRoot } from "react-dom/client";
import {
  createVehicleTemplate,
  type VehicleSimulationState,
  type VehicleTemplateId
} from "../../../packages/workbench-core/src/index.js";
import { buildVehiclePreview } from "../../../packages/workbench-vehicle/src/index.js";
import { VehicleOrthographicDrawing, type VehicleDrawingView } from "./workspaces/VehicleWorkspace.js";
import "./styles.css";
import "./styles/evidence.css";

const templates: readonly VehicleTemplateId[] = [
  "ice-road-motorcycle",
  "step-through-scooter",
  "ev-street-motorcycle",
  "delta-cargo-three-wheeler",
  "tadpole-geometry-three-wheeler"
];
const states: readonly VehicleSimulationState[] = ["full-droop", "design-ride", "full-bump"];
const query = new URLSearchParams(window.location.search);
const requestedTemplate = query.get("template") as VehicleTemplateId | null;
const requestedState = query.get("state") as VehicleSimulationState | null;
const requestedView = query.get("view") as VehicleDrawingView | null;
const template = requestedTemplate !== null && templates.includes(requestedTemplate) ? requestedTemplate : "ice-road-motorcycle";
const state = requestedState !== null && states.includes(requestedState) ? requestedState : "design-ride";
const view: VehicleDrawingView = requestedView !== null && ["side", "top", "front"].includes(requestedView) ? requestedView : template === "tadpole-geometry-three-wheeler" ? "front" : "side";
const intent = { ...createVehicleTemplate(template), state };
const preview = buildVehiclePreview(intent);

const root = document.getElementById("root");
if (root === null) throw new Error("Evidence renderer root is missing.");
createRoot(root).render(<main className="vehicle-evidence-renderer">
  <header>
    <div><span>PS3D VEHICLE · SCHEMA 2</span><h1>{intent.name}</h1><p>{intent.layout} · {intent.state} · {view} projection</p></div>
    <strong>{preview.analysis.status.toUpperCase()}</strong>
  </header>
  <VehicleOrthographicDrawing intent={intent} analysis={preview.analysis} geometry={preview.geometry} initialView={view} />
  <section className="vehicle-evidence-metrics">
    <article><small>Hardpoints / members</small><b>{preview.geometry.hardpoints.length} / {preview.geometry.members.length}</b><span>authoritative graph</span></article>
    <article><small>Invariant gate</small><b>{preview.geometry.checks.filter((check) => check.status === "pass").length} pass</b><span>{preview.geometry.checks.filter((check) => check.status !== "pass").length} unresolved</span></article>
    <article><small>Mass / achieved brake</small><b>{preview.analysis.totalMassKg.toFixed(1)} kg / {preview.analysis.predictedBrakeDecelerationMps2.toFixed(2)} m/s²</b><span>concept screen</span></article>
    <article><small>Evidence status</small><b>{intent.inputStatus}</b><span>DO NOT FABRICATE</span></article>
  </section>
  <footer>Rendered from solveVehicleGeometry() · no OEM geometry · no roadworthiness or fabrication approval · vehicle gate 6/6</footer>
</main>);
