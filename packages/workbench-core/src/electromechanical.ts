import {
  ELECTROMECHANICAL_CATALOG_REVISION,
  type AssemblyIntent,
  type AssemblyMate,
  type ComponentInstance,
  type ElectricalComponent,
  type ElectricalComponentKind,
  type ElectricalIntent,
  type ElectricalNetClass,
  type ElectricalTerminalRole,
  type ElectromechanicalCatalogPart,
  type ElectromechanicalDeviceLink,
  type ElectromechanicalLayoutPreset,
  type ElectromechanicalMapping,
  type ElectromechanicalReadiness,
  type ElectromechanicalRouteIntent,
  type Vec3,
  type WorkbenchResult
} from "./types.js";
import { createElectricalRoutePlan, type ElectricalRoutePlan } from "./electrical-routing.js";

const CATALOG = [
  part("battery", "Battery field-interface module", "box", [110, 90, 120], "#36b58c", "panel", [["P", [-34, 29, 70]], ["N", [34, 29, 70]]]),
  part("fuse", "DIN fuse holder", "box", [32, 70, 90], "#e6b94b", "din-rail", [["1", [-10, 24, 55]], ["2", [10, 24, 55]]]),
  part("disconnect", "Panel disconnect operator", "box", [90, 90, 115], "#e08a36", "panel", [["1", [-28, 30, 67.5]], ["2", [28, 30, 67.5]]]),
  part("contactor", "DIN contactor", "box", [70, 90, 105], "#8f6ad8", "din-rail", [["1", [-22, 30, 62.5]], ["2", [22, 30, 62.5]]]),
  part("inverter", "PCS controller / field interface", "box", [180, 110, 150], "#6c63df", "panel", [["DC", [-55, 37, 85]], ["AC", [55, 37, 85]], ["PE", [0, -37, 85]]]),
  part("transformer", "Transformer field-interface module", "box", [150, 110, 140], "#3d8fcb", "panel", [["PRI", [-45, 37, 80]], ["SEC", [45, 37, 80]], ["PE", [0, -37, 80]]]),
  part("breaker", "DIN circuit breaker", "box", [54, 80, 100], "#df5c5c", "din-rail", [["1", [-16, 27, 60]], ["2", [16, 27, 60]]]),
  part("load", "Auxiliary load interface", "box", [100, 80, 100], "#78909c", "panel", [["1", [-30, 27, 60]], ["2", [30, 27, 60]]]),
  part("motor", "Motor field-interface module", "box", [110, 100, 120], "#2c9ab7", "panel", [["L", [-32, 34, 70]], ["PE", [32, 34, 70]]]),
  part("ground", "Protective-earth terminal", "box", [22, 58, 65], "#2eaa74", "din-rail", [["PE", [0, 0, 42.5]]]),
  part("terminal", "Feed-through terminal", "box", [18, 58, 65], "#c6d0d7", "din-rail", [["1", [0, 0, 42.5]]]),
  part("sensor", "Sensor interface module", "box", [80, 70, 90], "#25a7a0", "panel", [["1", [-24, 24, 55]], ["2", [24, 24, 55]]]),
  part("hvac", "HVAC controller interface", "box", [140, 100, 125], "#3895d3", "panel", [["1", [-42, 34, 72.5]], ["2", [42, 34, 72.5]]])
] as const satisfies readonly ElectromechanicalCatalogPart[];

const MAX_ASSEMBLY_COMPONENTS = 100;
const MAX_AUDIT_CHANGED_IDS = 201;
const PANEL_PLATE_THICKNESS_MM = 12;
const PANEL_RAIL_THICKNESS_MM = 8;
const PANEL_DUCT_HEIGHT_MM = 30;
const PANEL_COLUMNS = 4;
const PANEL_MAX_DEVICES = 16;
const PANEL_MAX_CONDUCTOR_PATHS = 8;
const PANEL_MAX_CONDUCTOR_RADIUS_MM = 6;
const PANEL_CONDUCTOR_CLEARANCE_MM = 2;
const PANEL_CONDUCTOR_LANE_PITCH_MM = 14;
const PANEL_CONDUCTOR_FIRST_LANE_Z_MM = PANEL_PLATE_THICKNESS_MM
  + PANEL_DUCT_HEIGHT_MM
  + PANEL_MAX_CONDUCTOR_RADIUS_MM
  + PANEL_CONDUCTOR_CLEARANCE_MM;

export const ELECTROMECHANICAL_CATALOG: readonly ElectromechanicalCatalogPart[] = CATALOG;

export function catalogPartForKind(kind: ElectricalComponentKind): ElectromechanicalCatalogPart {
  return CATALOG.find((item) => item.kind === kind)!;
}

export function defaultElectromechanicalMappings(intent: ElectricalIntent): readonly ElectromechanicalMapping[] {
  return [...intent.components]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((component) => ({ electricalComponentId: component.id, catalogPartId: catalogPartForKind(component.kind).id }));
}

export function preferredElectromechanicalLayout(intent: ElectricalIntent): ElectromechanicalLayoutPreset {
  void intent;
  return "panel-backplate";
}

export function analyzeElectromechanicalReadiness(
  intent: ElectricalIntent,
  layoutPreset: ElectromechanicalLayoutPreset = preferredElectromechanicalLayout(intent),
  mappings: readonly ElectromechanicalMapping[] = defaultElectromechanicalMappings(intent),
  routePlan: ElectricalRoutePlan = createElectricalRoutePlan(intent)
): ElectromechanicalReadiness {
  const errors: string[] = [];
  const warnings: string[] = [];
  const target = layoutEnvelope(layoutPreset);
  if (layoutPreset === "panel-backplate" && intent.components.length > PANEL_MAX_DEVICES) {
    errors.push(`A single automatic mounting plate supports at most ${PANEL_MAX_DEVICES} devices; split this design across coordinated subpanels before physical realization.`);
  }
  if (layoutPreset === "panel-backplate" && intent.nets.length > PANEL_MAX_CONDUCTOR_PATHS) {
    errors.push(`A single automatic mounting plate supports at most ${PANEL_MAX_CONDUCTOR_PATHS} collision-separated conductor paths; consolidate through terminal blocks or split the design across coordinated subpanels.`);
  }
  const blockedRouteIds = new Set(routePlan.blockedNetIds);
  const budgetExceededRouteIds = new Set(routePlan.budgetExceededNetIds);
  const byComponent = new Map(intent.components.map((component) => [component.id, component]));
  const byCatalog = new Map(CATALOG.map((item) => [item.id, item]));
  const mappingByComponent = new Map(mappings.map((mapping) => [mapping.electricalComponentId, mapping.catalogPartId]));
  const seenComponents = new Set<string>();
  let mappedComponents = 0;
  for (const mapping of mappings) {
    const component = byComponent.get(mapping.electricalComponentId);
    const catalog = byCatalog.get(mapping.catalogPartId);
    if (seenComponents.has(mapping.electricalComponentId)) errors.push(`Duplicate mapping for ${mapping.electricalComponentId}.`);
    seenComponents.add(mapping.electricalComponentId);
    if (component === undefined) errors.push(`Mapping references missing electrical component ${mapping.electricalComponentId}.`);
    else if (catalog === undefined) errors.push(`Unknown local catalog part ${mapping.catalogPartId}.`);
    else if (catalog.kind !== component.kind) errors.push(`${component.reference} requires ${component.kind}, but ${catalog.id} is ${catalog.kind}.`);
    else {
      const catalogTerminals = new Set(catalog.terminals.map((terminal) => terminal.name));
      const componentTerminals = new Set(component.terminals);
      const missing = component.terminals.filter((terminal) => !catalogTerminals.has(terminal));
      const omitted = catalog.terminals.map((terminal) => terminal.name).filter((terminal) => !componentTerminals.has(terminal));
      if (missing.length > 0 || omitted.length > 0) errors.push(`${component.reference} terminal declarations must exactly match ${catalog.id}; unexpected ${missing.join(", ") || "none"}, omitted ${omitted.join(", ") || "none"}.`);
      else mappedComponents += 1;
    }
  }
  for (const component of intent.components) if (!seenComponents.has(component.id)) errors.push(`${component.reference} has no physical package mapping.`);
  const referenceOwners = new Map<string, string[]>();
  for (const component of intent.components) {
    const key = component.reference.toUpperCase();
    referenceOwners.set(key, [...(referenceOwners.get(key) ?? []), component.id]);
  }
  for (const [reference, owners] of referenceOwners) if (owners.length > 1) errors.push(`Reference designator ${reference} is used by ${owners.length} components.`);
  const terminalKeys = new Set(intent.components.flatMap((component) => component.terminals.map((terminal) => `${component.id}:${terminal}`)));
  const terminalNetOwner = new Map<string, string>();
  let routableNets = 0;
  for (const net of intent.nets) {
    const broken = net.endpoints.filter((endpoint) => !terminalKeys.has(`${endpoint.componentId}:${endpoint.terminal}`));
    if (broken.length > 0) errors.push(`${net.name} contains ${broken.length} unresolved endpoint(s).`);
    else {
      const endpointComponents = new Set<string>();
      let netBlocked = false;
      if (net.endpoints.length > 31) {
        errors.push(`${net.name} has ${net.endpoints.length} endpoints; split it into terminal-block branches before panel realization.`);
        netBlocked = true;
      }
      for (const endpoint of net.endpoints) {
        if (endpointComponents.has(endpoint.componentId)) {
          errors.push(`${net.name} directly joins more than one terminal on the same component.`);
          netBlocked = true;
        }
        endpointComponents.add(endpoint.componentId);
        const component = byComponent.get(endpoint.componentId)!;
        const role = electricalTerminalRole(component.kind, endpoint.terminal);
        if (!electricalTerminalRoleSupportsNetClass(role, net.class)) {
          errors.push(`${component.reference}.${endpoint.terminal} (${role}) is incompatible with ${net.class}.`);
          netBlocked = true;
        }
      }
      if (blockedRouteIds.has(net.id)) {
        errors.push(budgetExceededRouteIds.has(net.id)
          ? `${net.name} exceeded the bounded automatic-routing work budget; split or simplify the dense schematic before 3D realization.`
          : `${net.name} has no clear orthogonal sheet route around devices, fixed panels, and previously routed nets.`);
        netBlocked = true;
      }
      if (!netBlocked) routableNets += 1;
      for (const endpoint of net.endpoints) {
        const key = `${endpoint.componentId}:${endpoint.terminal}`;
        const prior = terminalNetOwner.get(key);
        if (prior !== undefined && prior !== net.id) errors.push(`${key} is assigned to more than one named net.`);
        terminalNetOwner.set(key, net.id);
      }
    }
  }
  const generatedComponentIds = intent.components.map((component) => `component:em-${safeId(component.id)}`);
  const generatedRouteIds = intent.nets.map((net) => `route:em-${safeId(net.id)}`);
  if (new Set(generatedComponentIds).size !== generatedComponentIds.length) errors.push("Electrical component IDs collide after deterministic physical-ID encoding.");
  if (new Set(generatedRouteIds).size !== generatedRouteIds.length) errors.push("Electrical net IDs collide after deterministic route-ID encoding.");
  const projectedComponents = projectedGeneratedComponentCount(intent, layoutPreset);
  if (projectedComponents > MAX_ASSEMBLY_COMPONENTS) errors.push(`The detailed realization requires ${projectedComponents} assembly components, above the ${MAX_ASSEMBLY_COMPONENTS}-component limit.`);
  if (1 + 2 * projectedComponents + intent.nets.length > MAX_AUDIT_CHANGED_IDS) errors.push("The detailed realization change set exceeds the bounded audit-entry limit.");
  if (errors.length === 0) {
    const baseThickness = layoutPreset === "panel-backplate" ? PANEL_PLATE_THICKNESS_MM : 80;
    const positioned = positionComponents(intent.components, target, baseThickness, layoutPreset).map((item) => ({
      ...item,
      catalog: byCatalog.get(mappingByComponent.get(item.source.id)!)!
    }));
    for (const item of positioned) {
      const half = item.catalog.sizeMm.map((size) => size / 2) as Vec3;
      const clearance = item.catalog.planningClearanceMm;
      if (Math.abs(item.position[0]) + half[0] + clearance[0] > target[0] / 2
        || Math.abs(item.position[1]) + half[1] + clearance[1] > target[1] / 2
        || item.position[2] + item.catalog.sizeMm[2] + clearance[2] > target[2]) {
        errors.push(`${item.source.reference} exceeds the ${layoutPreset.replaceAll("-", " ")} planning envelope or clearance boundary.`);
      }
    }
    for (let left = 0; left < positioned.length; left += 1) {
      for (let right = left + 1; right < positioned.length; right += 1) {
        const a = positioned[left]!;
        const b = positioned[right]!;
        if (clearanceOverlap(a.position, a.catalog, b.position, b.catalog)) errors.push(`${a.source.reference} and ${b.source.reference} overlap their generic planning clearances.`);
      }
    }
  }
  if (intent.components.some((component) => /USER DEFINE|USER VERIFY/u.test(component.value))) {
    warnings.push("Generic panel packages do not resolve manufacturer, rating, heat loss, mass, or procurement data.");
  }
  warnings.push("Generated conductors are unsized orthogonal panel-routing guides; gauge, ferrules, duct fill, segregation, bend radius, EMC, thermal, and code checks are not performed.");
  return {
    status: errors.length === 0 ? "ready" : "blocked",
    mappedComponents,
    totalComponents: intent.components.length,
    routableNets,
    totalNets: intent.nets.length,
    targetEnvelopeMm: target,
    blockingErrors: errors,
    warnings
  };
}

export function createElectromechanicalAssembly(
  intent: ElectricalIntent,
  layoutPreset: ElectromechanicalLayoutPreset,
  mappings: readonly ElectromechanicalMapping[],
  sourceProjectRevision = 0,
  routePlan: ElectricalRoutePlan = createElectricalRoutePlan(intent)
): WorkbenchResult<AssemblyIntent> {
  const readiness = analyzeElectromechanicalReadiness(intent, layoutPreset, mappings, routePlan);
  if (readiness.status === "blocked") return blocked(readiness.blockingErrors[0] ?? "The electromechanical mapping is incomplete.");
  const target = readiness.targetEnvelopeMm;
  const baseThickness = layoutPreset === "panel-backplate" ? PANEL_PLATE_THICKNESS_MM : 80;
  const support = component(
    "component:em-support",
    layoutPreset === "panel-backplate" ? "Galvanized electrical mounting plate" : "Equipment lineup foundation",
    "box",
    true,
    layoutPreset === "panel-backplate" ? "#7f8b94" : "#44515c",
    [0, 0, baseThickness / 2],
    [target[0], target[1], baseThickness],
    [0, 0, -0.3]
  );
  const byMapping = new Map(mappings.map((mapping) => [mapping.electricalComponentId, mapping.catalogPartId]));
  const positioned = positionComponents(intent.components, target, baseThickness, layoutPreset);
  const panelRows = layoutPreset === "panel-backplate" ? panelRowYs(intent.components.length, target) : [];
  const panelDucts = layoutPreset === "panel-backplate" ? panelDuctYs(panelRows, target) : [];
  const generated: ComponentInstance[] = [support, ...(layoutPreset === "panel-backplate" ? createPanelInfrastructure(target, baseThickness, panelRows, panelDucts) : [])];
  const links: ElectromechanicalDeviceLink[] = [];
  const terminalWorld = new Map<string, Vec3>();
  for (const item of positioned) {
    const catalog = CATALOG.find((entry) => entry.id === byMapping.get(item.source.id))!;
    const assemblyComponentId = `component:em-${safeId(item.source.id)}`;
    const body = component(
      assemblyComponentId,
      `${item.source.reference} · ${item.source.label}`,
      catalog.shape,
      false,
      catalog.color,
      [item.position[0], item.position[1], item.position[2] + catalog.sizeMm[2] / 2],
      catalog.sizeMm,
      explosionDirection(item.position, target)
    );
    generated.push({ ...body, sourceElectricalComponentId: item.source.id, catalogPartId: catalog.id });
    const terminalMap = item.source.terminals.map((terminal) => ({ electricalTerminal: terminal, catalogTerminal: terminal }));
    links.push({
      electricalComponentId: item.source.id,
      electricalReference: item.source.reference,
      assemblyComponentId,
      catalogPartId: catalog.id,
      terminalMap,
      status: "mapped-generic"
    });
    const generatedBody = generated.at(-1)!;
    for (const terminal of catalog.terminals) {
      terminalWorld.set(`${item.source.id}:${terminal.name}`, electromechanicalTerminalWorldPoint(generatedBody, catalog, terminal.name)!);
    }
  }
  const routeHeight = Math.min(target[2] - 20, baseThickness + Math.max(...positioned.map((item) => CATALOG.find((entry) => entry.id === byMapping.get(item.source.id))!.sizeMm[2])) + 28);
  const routes = [...intent.nets].sort((left, right) => left.id.localeCompare(right.id)).map((net, index) => layoutPreset === "panel-backplate"
    ? routePanelNet(net, terminalWorld, target, panelDucts, index)
    : routeNet(net, terminalWorld, Math.min(target[2] - 20, routeHeight + index % 12 * 4)));
  const mates: AssemblyMate[] = generated.map((item) => ({
    id: `mate:${safeId(item.id)}-fixed`,
    name: `${item.name} fixed in generated layout`,
    kind: "fixed",
    componentIds: [item.id],
    status: "satisfied"
  }));
  return { ok: true, value: {
    id: "assembly:fixture-demo",
    name: layoutPreset === "panel-backplate" ? `${intent.title} · wired mounting plate` : `${intent.title} · linked 3D layout`,
    explodeMm: 0,
    template: "electrical-panel",
    nominalEnvelopeMm: target,
    designStatus: "electromechanical-layout",
    safetyNotes: [
      layoutPreset === "panel-backplate"
        ? "ORIGINAL GENERIC MULTI-BODY PANEL VISUALIZATION — NOT MANUFACTURER-ACCURATE DEVICE GEOMETRY."
        : "CATALOG-BACKED GENERIC EQUIPMENT LAYOUT PREVIEW — NOT MANUFACTURER-ACCURATE GEOMETRY.",
      layoutPreset === "panel-backplate"
        ? "ONE MOUNTING PLATE, DIN RAILS, WIRING DUCTS, TERMINAL STUDS, AND COLORED CONDUCTOR PATHS ARE DETERMINISTIC VISUALIZATION GEOMETRY."
        : "SCHEMATIC REFERENCES AND TERMINALS ARE TRACEABLE; ROUTES ARE UNSIZED PLANNING GUIDES ONLY.",
      "VERIFY MANUFACTURER DIMENSIONS, RATINGS, MASS, HEAT LOSS, CLEARANCES, WIRE GAUGE, FERRULES, DUCT FILL, SEGREGATION, GROUNDING, PROTECTION, ACCESS, AND REGULATIONS.",
      "PS3D ROUTE COLORS IDENTIFY NET CLASSES ONLY; THEY DO NOT CLAIM IEC, NEC, OR PROJECT INSULATION-COLOR COMPLIANCE.",
      "NOT FOR CONSTRUCTION, PROCUREMENT, FABRICATION, ENERGIZATION, OR SAFETY APPROVAL."
    ],
    components: generated,
    mates,
    electricalLinks: links,
    electricalRoutes: routes,
    electromechanicalSource: {
      catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION,
      electricalTitle: intent.title,
      electricalSignature: electricalSignature(intent),
      sourceElectricalId: intent.id,
      sourceProjectRevision,
      layoutPreset,
      status: "current"
    }
  } };
}

export function electricalSignature(intent: ElectricalIntent): string {
  const canonical = JSON.stringify({
    id: intent.id,
    title: intent.title,
    standard: intent.standard,
    template: intent.template,
    notes: intent.notes,
    components: [...intent.components].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({
      id: item.id,
      kind: item.kind,
      reference: item.reference,
      label: item.label,
      value: item.value,
      position: item.position,
      rotationDeg: item.rotationDeg,
      terminals: item.terminals
    })),
    nets: [...intent.nets].sort((a, b) => a.id.localeCompare(b.id)).map((net) => ({ id: net.id, name: net.name, class: net.class, endpoints: net.endpoints }))
  });
  return `fnv1a64:${hash64(canonical)}`;
}

export function electricalTerminalRole(kind: ElectricalComponentKind, terminal: string): ElectricalTerminalRole {
  if (terminal === "PE" || kind === "ground") return "protective-earth";
  if (kind === "battery") return terminal === "P" ? "positive" : terminal === "N" ? "negative" : "unspecified";
  if (kind === "inverter" || kind === "transformer" || kind === "motor") return terminal === "DC" ? "positive" : "ac";
  if (kind === "sensor") return "signal";
  if (terminal === "1" || terminal === "PRI") return "line";
  if (terminal === "2" || terminal === "SEC") return "load";
  return "unspecified";
}

export function electricalTerminalRoleSupportsNetClass(role: ElectricalTerminalRole, netClass: ElectricalNetClass): boolean {
  if (role === "protective-earth") return netClass === "ground";
  if (role === "ac") return netClass === "power-ac";
  if (role === "signal") return netClass === "control";
  if (role === "positive") return netClass === "power-dc" || netClass === "control";
  if (role === "negative") return netClass === "power-dc" || netClass === "control" || netClass === "ground";
  return true;
}

function part(
  kind: ElectricalComponentKind,
  label: string,
  shape: "box" | "cylinder",
  sizeMm: Vec3,
  color: string,
  mounting: ElectromechanicalCatalogPart["mounting"],
  terminals: readonly (readonly [string, Vec3])[]
): ElectromechanicalCatalogPart {
  return {
    id: `catalog:ps3d-generic-${kind}`,
    revision: ELECTROMECHANICAL_CATALOG_REVISION,
    kind,
    label,
    classification: "generic-envelope",
    provenance: "original-ps3d-mit",
    shape,
    sizeMm,
    color,
    mounting,
    planningClearanceMm: [25, 25, 25],
    terminals: terminals.map(([name, positionMm]) => ({ name, role: electricalTerminalRole(kind, name), positionMm, direction: [0, 0, 1] }))
  };
}

function projectedGeneratedComponentCount(intent: ElectricalIntent, layoutPreset: ElectromechanicalLayoutPreset): number {
  if (layoutPreset !== "panel-backplate") return intent.components.length + 1;
  const rowCount = Math.max(1, Math.ceil(intent.components.length / PANEL_COLUMNS));
  // source packages + mounting plate + rails + horizontal ducts + two vertical ducts + PE bar + four standoffs
  return intent.components.length + 1 + rowCount + rowCount + 2 + 1 + 4;
}

function positionComponents(
  components: readonly ElectricalComponent[],
  target: Vec3,
  baseThickness: number,
  layoutPreset: ElectromechanicalLayoutPreset
): readonly { source: ElectricalComponent; position: Vec3 }[] {
  if (layoutPreset === "panel-backplate") {
    const ordered = [...components].sort((left, right) =>
      left.position[1] - right.position[1]
      || left.position[0] - right.position[0]
      || left.id.localeCompare(right.id));
    const rowYs = panelRowYs(ordered.length, target);
    const positioned: { source: ElectricalComponent; position: Vec3 }[] = [];
    for (let rowIndex = 0; rowIndex < rowYs.length; rowIndex += 1) {
      const row = ordered.slice(rowIndex * PANEL_COLUMNS, (rowIndex + 1) * PANEL_COLUMNS);
      const columnPitch = 260;
      row.forEach((source, columnIndex) => {
        positioned.push({
          source,
          position: [
            (columnIndex - (row.length - 1) / 2) * columnPitch,
            rowYs[rowIndex]!,
            baseThickness + PANEL_RAIL_THICKNESS_MM
          ]
        });
      });
    }
    return positioned;
  }
  const xs = components.map((item) => item.position[0]);
  const ys = components.map((item) => item.position[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const marginX = Math.max(...components.map((item) => { const catalog = catalogPartForKind(item.kind); return catalog.sizeMm[0] / 2 + catalog.planningClearanceMm[0]; }));
  const marginY = Math.max(...components.map((item) => { const catalog = catalogPartForKind(item.kind); return catalog.sizeMm[1] / 2 + catalog.planningClearanceMm[1]; }));
  const usableX = target[0] - marginX * 2;
  const usableY = target[1] - marginY * 2;
  return [...components].sort((left, right) => left.id.localeCompare(right.id)).map((source) => ({
    source,
    position: [
      maxX === minX ? 0 : ((source.position[0] - minX) / (maxX - minX) - 0.5) * usableX,
      maxY === minY ? 0 : (0.5 - (source.position[1] - minY) / (maxY - minY)) * usableY,
      baseThickness
    ]
  }));
}

function panelRowYs(componentCount: number, target: Vec3): readonly number[] {
  const rowCount = Math.max(1, Math.ceil(componentCount / PANEL_COLUMNS));
  if (rowCount === 1) return [105];
  const totalSpread = Math.min(540, (rowCount - 1) * 210);
  const step = totalSpread / (rowCount - 1);
  return Array.from({ length: rowCount }, (_, index) => totalSpread / 2 - index * step)
    .map((value) => Math.max(-target[1] / 2 + 120, Math.min(target[1] / 2 - 120, value)));
}

function panelDuctYs(rowYs: readonly number[], target: Vec3): readonly number[] {
  const between = rowYs.slice(0, -1).map((value, index) => (value + rowYs[index + 1]!) / 2);
  const bottom = Math.max(-target[1] / 2 + 75, rowYs.at(-1)! - 105);
  return [...between, bottom];
}

function createPanelInfrastructure(
  target: Vec3,
  baseThickness: number,
  rowYs: readonly number[],
  ductYs: readonly number[]
): readonly ComponentInstance[] {
  const railWidth = target[0] - 280;
  const verticalDuctX = target[0] / 2 - 60;
  const horizontalDuctWidth = 2 * (verticalDuctX - 25);
  const infrastructure: ComponentInstance[] = [];
  rowYs.forEach((y, index) => {
    infrastructure.push(component(
      `component:em-din-rail-${String(index + 1).padStart(2, "0")}`,
      `DIN mounting rail ${index + 1}`,
      "box",
      true,
      "#aeb9c2",
      [0, y, baseThickness + PANEL_RAIL_THICKNESS_MM / 2],
      [railWidth, 28, PANEL_RAIL_THICKNESS_MM],
      [0, y >= 0 ? 0.2 : -0.2, 0.15]
    ));
  });
  ductYs.forEach((y, index) => {
    infrastructure.push(component(
      `component:em-wire-duct-h-${String(index + 1).padStart(2, "0")}`,
      `Slotted horizontal wiring duct ${index + 1}`,
      "box",
      false,
      "#d4dbe0",
      [0, y, baseThickness + PANEL_DUCT_HEIGHT_MM / 2],
      [horizontalDuctWidth, 50, PANEL_DUCT_HEIGHT_MM],
      [0, y >= 0 ? 0.18 : -0.18, 0.35]
    ));
  });
  ([[-1, "left"], [1, "right"]] as const).forEach(([side, name]) => {
    infrastructure.push(component(
      `component:em-wire-duct-v-${name}`,
      `Slotted vertical wiring duct · ${name}`,
      "box",
      false,
      "#d4dbe0",
      [side * verticalDuctX, 0, baseThickness + PANEL_DUCT_HEIGHT_MM / 2],
      [50, target[1] - 150, PANEL_DUCT_HEIGHT_MM],
      [side * 0.2, 0, 0.35]
    ));
  });
  infrastructure.push(component(
    "component:em-protective-earth-bar",
    "Protective-earth bonding bar",
    "box",
    true,
    "#c9922e",
    [0, -target[1] / 2 + 28, baseThickness + 8],
    [900, 18, 16],
    [0, -0.35, 0.2]
  ));
  const fastenerX = target[0] / 2 - 45;
  const fastenerY = target[1] / 2 - 45;
  ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).forEach(([xSide, ySide], index) => {
    infrastructure.push(component(
      `component:em-panel-standoff-${String(index + 1).padStart(2, "0")}`,
      `Mounting-plate standoff ${index + 1}`,
      "cylinder",
      true,
      "#77838c",
      [xSide * fastenerX, ySide * fastenerY, baseThickness + 6],
      [18, 18, 12],
      [xSide * 0.25, ySide * 0.25, 0.15]
    ));
  });
  return infrastructure;
}

export function electromechanicalTerminalWorldPoint(
  body: ComponentInstance,
  catalog: ElectromechanicalCatalogPart,
  terminalName: string
): Vec3 | undefined {
  const terminal = catalog.terminals.find((item) => item.name === terminalName);
  if (terminal === undefined) return undefined;
  const [rx, ry, rz] = body.rotationDeg.map((value) => value * Math.PI / 180) as Vec3;
  const [x0, y0, z0] = terminal.positionMm;
  const x1 = x0;
  const y1 = y0 * Math.cos(rx) - z0 * Math.sin(rx);
  const z1 = y0 * Math.sin(rx) + z0 * Math.cos(rx);
  const x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
  const y2 = y1;
  const z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
  const rotated: Vec3 = [
    x2 * Math.cos(rz) - y2 * Math.sin(rz),
    x2 * Math.sin(rz) + y2 * Math.cos(rz),
    z2
  ];
  return [
    body.translationMm[0] + rotated[0],
    body.translationMm[1] + rotated[1],
    body.translationMm[2] + rotated[2]
  ];
}

function routeNet(net: ElectricalIntent["nets"][number], terminalWorld: ReadonlyMap<string, Vec3>, height: number): ElectromechanicalRouteIntent {
  const endpoints = net.endpoints.map((endpoint) => terminalWorld.get(`${endpoint.componentId}:${endpoint.terminal}`)!).filter(Boolean);
  const points: Vec3[] = [endpoints[0]!];
  for (let index = 1; index < endpoints.length; index += 1) {
    const from = endpoints[index - 1]!;
    const to = endpoints[index]!;
    const midX = (from[0] + to[0]) / 2;
    points.push([from[0], from[1], height], [midX, from[1], height], [midX, to[1], height], [to[0], to[1], height], to);
  }
  return { id: `route:em-${safeId(net.id)}`, electricalNetId: net.id, name: net.name, class: net.class, endpoints: net.endpoints.map((endpoint) => ({ ...endpoint })), pointsMm: points, status: "routed-preview" };
}

function routePanelNet(
  net: ElectricalIntent["nets"][number],
  terminalWorld: ReadonlyMap<string, Vec3>,
  target: Vec3,
  ductYs: readonly number[],
  routeIndex: number
): ElectromechanicalRouteIntent {
  const endpoints = net.endpoints.map((endpoint) => terminalWorld.get(`${endpoint.componentId}:${endpoint.terminal}`)!).filter(Boolean);
  const ductPlaneZ = PANEL_CONDUCTOR_FIRST_LANE_Z_MM + routeIndex * PANEL_CONDUCTOR_LANE_PITCH_MM;
  const trunkX = (routeIndex % 2 === 0 ? -1 : 1) * (target[0] / 2 - 60);
  const nearestDuctY = (point: Vec3): number => ductYs.reduce(
    (nearest, candidate) => Math.abs(candidate - point[1]) < Math.abs(nearest - point[1]) ? candidate : nearest,
    ductYs[0] ?? 0
  );
  const points: Vec3[] = [endpoints[0]!];
  if (endpoints.length > 16) {
    for (let index = 1; index < endpoints.length; index += 1) {
      const from = endpoints[index - 1]!;
      const to = endpoints[index]!;
      points.push(
        [from[0], from[1], ductPlaneZ],
        [to[0], from[1], ductPlaneZ],
        [to[0], to[1], ductPlaneZ],
        to
      );
    }
  } else {
    const firstDuctY = nearestDuctY(endpoints[0]!);
    points.push(
      [endpoints[0]![0], firstDuctY, endpoints[0]![2]],
      [endpoints[0]![0], firstDuctY, ductPlaneZ],
      [trunkX, firstDuctY, ductPlaneZ]
    );
    for (let index = 1; index < endpoints.length; index += 1) {
      const previous = endpoints[index - 1]!;
      const next = endpoints[index]!;
      const previousDuctY = nearestDuctY(previous);
      const nextDuctY = nearestDuctY(next);
      if (index > 1) {
        points.push(
          [previous[0], previousDuctY, previous[2]],
          [previous[0], previousDuctY, ductPlaneZ],
          [trunkX, previousDuctY, ductPlaneZ]
        );
      }
      points.push(
        [trunkX, nextDuctY, ductPlaneZ],
        [next[0], nextDuctY, ductPlaneZ],
        [next[0], nextDuctY, next[2]],
        next
      );
    }
  }
  return {
    id: `route:em-${safeId(net.id)}`,
    electricalNetId: net.id,
    name: net.name,
    class: net.class,
    endpoints: net.endpoints.map((endpoint) => ({ ...endpoint })),
    pointsMm: points,
    status: "routed-preview"
  };
}

function clearanceOverlap(leftPosition: Vec3, left: ElectromechanicalCatalogPart, rightPosition: Vec3, right: ElectromechanicalCatalogPart): boolean {
  const separatedX = Math.abs(leftPosition[0] - rightPosition[0]) >= left.sizeMm[0] / 2 + right.sizeMm[0] / 2 + Math.max(left.planningClearanceMm[0], right.planningClearanceMm[0]);
  const separatedY = Math.abs(leftPosition[1] - rightPosition[1]) >= left.sizeMm[1] / 2 + right.sizeMm[1] / 2 + Math.max(left.planningClearanceMm[1], right.planningClearanceMm[1]);
  return !separatedX && !separatedY;
}

function layoutEnvelope(layout: ElectromechanicalLayoutPreset): Vec3 {
  return layout === "equipment-lineup" ? [4_200, 1_600, 2_200] : [1_400, 900, 260];
}

function component(id: string, name: string, shape: "box" | "cylinder", grounded: boolean, color: string, translationMm: Vec3, sizeMm: Vec3, explosion: Vec3): ComponentInstance {
  return { id, name, shape, grounded, visible: true, color, translationMm, rotationDeg: [0, 0, 0], sizeMm, explosionDirection: explosion };
}

function explosionDirection(position: Vec3, target: Vec3): Vec3 {
  return [Math.max(-1, Math.min(1, position[0] / (target[0] / 2))), Math.max(-1, Math.min(1, position[1] / (target[1] / 2))), 0.35];
}

function safeId(value: string): string {
  const stem = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 62) || "item";
  return `${stem}-${hash64(value).slice(0, 16)}`;
}

function hash64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function blocked(message: string): WorkbenchResult<never> {
  return { ok: false, diagnostics: [{
    code: "INVALID_OPERATION",
    message,
    relatedIds: ["electrical:main"],
    recovery: "Resolve every catalog and terminal mapping, then preview the electromechanical realization again."
  }] };
}
