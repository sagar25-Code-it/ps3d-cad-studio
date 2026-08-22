import {
  analyzeElectromechanicalReadiness,
  createElectricalRoutePlan,
  electricalTerminalRole,
  electricalTerminalRoleSupportsNetClass,
  preferredElectromechanicalLayout,
  type ElectricalComponent,
  type ElectricalIntent,
  type ElectricalNet,
  type ElectricalNetEndpoint,
  type ElectricalRoutePlan,
  type ElectricalSheetRoute,
  type ElectromechanicalLayoutPreset,
  type ElectromechanicalReadiness,
  type Vec2
} from "../../workbench-core/src/index.js";

export interface ElectricalErcIssue {
  readonly id: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export interface ElectricalBomRow {
  readonly item: number;
  readonly kind: ElectricalComponent["kind"];
  readonly description: string;
  readonly value: string;
  readonly references: readonly string[];
  readonly quantity: number;
}

export interface ElectricalArtifact {
  readonly svg: string;
  readonly width: 1600;
  readonly height: 900;
  readonly componentCount: number;
  readonly netCount: number;
  readonly erc: {
    readonly status: "pass" | "review" | "error";
    readonly errors: number;
    readonly warnings: number;
    readonly issues: readonly ElectricalErcIssue[];
  };
  readonly bom: readonly ElectricalBomRow[];
  readonly routing: ElectricalRoutePlan;
  readonly physicalization: ElectromechanicalReadiness & { readonly layoutPreset: ElectromechanicalLayoutPreset };
}

export function createElectricalSchematic(intent: ElectricalIntent): ElectricalArtifact {
  const routePlan = createElectricalRoutePlan(intent);
  const issues = runElectricalRuleCheckWithRoutes(intent, routePlan);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  const erc = { status: errors > 0 ? "error" as const : warnings > 0 ? "review" as const : "pass" as const, errors, warnings, issues };
  const bom = createElectricalBom(intent.components);
  const layoutPreset = preferredElectromechanicalLayout(intent);
  const physicalization = { ...analyzeElectromechanicalReadiness(intent, layoutPreset, undefined, routePlan), layoutPreset };
  return {
    svg: renderSheet(intent, erc, bom, routePlan),
    width: 1600,
    height: 900,
    componentCount: intent.components.length,
    netCount: intent.nets.length,
    erc,
    bom,
    routing: routePlan,
    physicalization
  };
}

export function runElectricalRuleCheck(intent: ElectricalIntent): readonly ElectricalErcIssue[] {
  return runElectricalRuleCheckWithRoutes(intent, createElectricalRoutePlan(intent));
}

function runElectricalRuleCheckWithRoutes(intent: ElectricalIntent, routePlan: ElectricalRoutePlan): readonly ElectricalErcIssue[] {
  const issues: ElectricalErcIssue[] = [];
  const components = new Map(intent.components.map((component) => [component.id, component]));
  const referenceOwners = new Map<string, string[]>();
  const connected = new Set<string>();
  const terminalNetOwner = new Map<string, string>();
  for (const component of intent.components) {
    const owners = referenceOwners.get(component.reference) ?? [];
    owners.push(component.id);
    referenceOwners.set(component.reference, owners);
  }
  for (const [reference, ids] of referenceOwners) {
    if (ids.length > 1) issues.push({
      id: `erc:duplicate-${safeId(reference)}`,
      severity: "error",
      message: `Reference designator ${reference} is used by ${ids.length} components.`,
      relatedIds: ids,
      recovery: "Assign a unique reference designator before release."
    });
  }
  for (const net of intent.nets) {
    const endpointComponents = new Set<string>();
    for (const endpoint of net.endpoints) {
      if (endpointComponents.has(endpoint.componentId)) issues.push({
        id: `erc:self-short-${safeId(net.id)}-${safeId(endpoint.componentId)}`,
        severity: "error",
        message: `${net.name} directly joins multiple terminals on the same component.`,
        relatedIds: [net.id, endpoint.componentId],
        recovery: "Separate the terminals onto independently reviewed nets; this bounded editor does not model intentional internal commoning."
      });
      endpointComponents.add(endpoint.componentId);
    }
    for (const endpoint of net.endpoints) {
      const component = components.get(endpoint.componentId);
      if (component === undefined) {
        issues.push({ id: `erc:missing-${safeId(net.id)}-${safeId(endpoint.componentId)}`, severity: "error", message: `${net.name} references a missing component.`, relatedIds: [net.id, endpoint.componentId], recovery: "Repair or delete the broken net endpoint." });
        continue;
      }
      if (!component.terminals.includes(endpoint.terminal)) {
        issues.push({ id: `erc:terminal-${safeId(net.id)}-${safeId(endpoint.terminal)}`, severity: "error", message: `${net.name} references missing terminal ${endpoint.terminal} on ${component.reference}.`, relatedIds: [net.id, component.id], recovery: "Select a terminal declared by the component." });
        continue;
      }
      const role = electricalTerminalRole(component.kind, endpoint.terminal);
      if (!electricalTerminalRoleSupportsNetClass(role, net.class)) issues.push({
        id: `erc:role-${safeId(net.id)}-${safeId(component.id)}-${safeId(endpoint.terminal)}`,
        severity: "error",
        message: `${component.reference}.${endpoint.terminal} (${role}) is incompatible with ${net.class}.`,
        relatedIds: [net.id, component.id],
        recovery: "Choose a terminal whose declared role matches the reviewed net class. Protective earth is restricted to ground nets."
      });
      const key = endpointKey(endpoint);
      const priorNet = terminalNetOwner.get(key);
      if (priorNet !== undefined && priorNet !== net.id) issues.push({
        id: `erc:multiple-net-${safeId(key)}-${safeId(net.id)}`,
        severity: "error",
        message: `${component.reference}.${endpoint.terminal} is assigned to more than one named net.`,
        relatedIds: [component.id, priorNet, net.id],
        recovery: "Merge the intended connectivity into one net or move the endpoint to the correct terminal."
      });
      terminalNetOwner.set(key, net.id);
      connected.add(key);
    }
  }
  for (const component of intent.components) {
    for (const terminal of component.terminals) {
      if (!connected.has(`${component.id}:${terminal}`)) issues.push({
        id: `erc:open-${safeId(component.id)}-${safeId(terminal)}`,
        severity: "warning",
        message: `${component.reference}.${terminal} is not connected.`,
        relatedIds: [component.id],
        recovery: "Connect the terminal or document it as intentionally spare."
      });
    }
  }
  const hasPower = intent.nets.some((net) => net.class === "power-ac" || net.class === "power-dc");
  const hasProtectiveDevice = intent.components.some((component) => component.kind === "fuse" || component.kind === "breaker" || component.kind === "disconnect");
  if (hasPower && !hasProtectiveDevice) issues.push({
    id: "erc:protection-review",
    severity: "warning",
    message: "Power nets exist without a fuse, breaker, or disconnect symbol in the concept.",
    relatedIds: [intent.id],
    recovery: "Add the intended protective/isolation device and complete project-specific coordination."
  });
  if (!intent.nets.some((net) => net.class === "ground") || !intent.components.some((component) => component.kind === "ground")) issues.push({
    id: "erc:ground-reference",
    severity: "warning",
    message: "No protective-earth/reference network is shown.",
    relatedIds: [intent.id],
    recovery: "Define the project grounding/bonding concept under licensed engineering review."
  });
  for (const net of intent.nets.filter((item) => item.class === "ground")) {
    const includesPe = net.endpoints.some((endpoint) => endpoint.terminal === "PE" || components.get(endpoint.componentId)?.kind === "ground");
    if (!includesPe) issues.push({ id: `erc:ground-class-${safeId(net.id)}`, severity: "warning", message: `${net.name} is classified as ground but has no PE or ground-reference endpoint.`, relatedIds: [net.id], recovery: "Connect the intended protective/reference terminal or change the net class." });
  }
  for (const net of intent.nets) {
    const endpointsAreValid = net.endpoints.every((endpoint) => components.get(endpoint.componentId)?.terminals.includes(endpoint.terminal) === true);
    if (endpointsAreValid && routePlan.blockedNetIds.includes(net.id)) {
      const budgetExceeded = routePlan.budgetExceededNetIds.includes(net.id);
      issues.push({
      id: `erc:route-${safeId(net.id)}`,
      severity: "error",
      message: budgetExceeded
        ? `${net.name} exceeded the bounded automatic-routing work budget.`
        : `${net.name} has no clear orthogonal sheet route around the current components and fixed panels.`,
      relatedIds: [net.id],
      recovery: budgetExceeded
        ? "Split the dense circuit across reviewed sheets or reduce congestion before retrying; PS3D fails closed instead of monopolizing the UI."
        : "Move one or more symbols to open a route corridor; PS3D will not draw a line through an unrelated device."
      });
    }
  }
  return issues.sort((left, right) => left.id.localeCompare(right.id));
}

export function createElectricalBom(components: readonly ElectricalComponent[]): readonly ElectricalBomRow[] {
  const groups = new Map<string, { kind: ElectricalComponent["kind"]; description: string; value: string; references: string[] }>();
  for (const component of components) {
    if (component.kind === "ground" || component.kind === "terminal") continue;
    const key = `${component.kind}\u0000${component.label}\u0000${component.value}`;
    const group = groups.get(key) ?? { kind: component.kind, description: component.label, value: component.value, references: [] };
    group.references.push(component.reference);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.references[0]!.localeCompare(right.references[0]!)).map((group, index) => ({
    item: index + 1,
    kind: group.kind,
    description: group.description,
    value: group.value,
    references: [...group.references].sort(),
    quantity: group.references.length
  }));
}

function renderSheet(
  intent: ElectricalIntent,
  erc: ElectricalArtifact["erc"],
  bom: readonly ElectricalBomRow[],
  routePlan: ElectricalRoutePlan
): string {
  const routes = new Map(routePlan.routes.map((route) => [route.netId, route]));
  const nets = intent.nets.map((net) => renderNet(net, routes.get(net.id))).join("");
  const components = intent.components.map(renderComponent).join("");
  const visibleBomCount = Math.min(8, bom.length);
  const bomRows = bom.slice(0, visibleBomCount).map((row, index) => `<g transform="translate(1170 ${128 + index * 16})"><text class="bom item" x="0" y="0">${row.item}</text><text class="bom" x="36" y="0">${escapeXml(row.references.join(", "))}</text><text class="bom" x="150" y="0">${escapeXml(row.description)}</text><text class="bom qty" x="365" y="0">${row.quantity}</text></g>`).join("");
  const bomOverflow = bom.length > visibleBomCount ? `<text class="title-small" x="1170" y="264">COMPLETE ${bom.length}-ROW INDEX IN SVG METADATA</text>` : "";
  const visibleIssueCount = Math.min(erc.issues.length > 5 ? 4 : 5, erc.issues.length);
  const issueRows = erc.issues.slice(0, visibleIssueCount).map((issue, index) => `<g transform="translate(80 ${690 + index * 30})"><circle class="erc-${issue.severity}" cx="0" cy="-5" r="6"/><text class="erc-text" x="16" y="0">${escapeXml(issue.message)}</text></g>`).join("");
  const issueOverflow = erc.issues.length > visibleIssueCount ? `<text class="title-small" x="80" y="810">COMPLETE ${erc.issues.length}-ISSUE RECORD IN SVG METADATA</text>` : "";
  const exportMetadata = escapeXml(JSON.stringify({ schema: "ps3d-electrical-export/1", bom, erc }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${escapeXml(intent.title)}">
  <metadata id="ps3d-electrical-export-data">${exportMetadata}</metadata>
  <style>
    .sheet{fill:#f5f8fa}.border{fill:none;stroke:#143246;stroke-width:2}.zone{font:600 11px ui-monospace,monospace;fill:#557080}.title{font:700 22px Inter,Arial,sans-serif;fill:#102d3f}.subtitle{font:600 12px Inter,Arial,sans-serif;fill:#496676;letter-spacing:.08em}.symbol{fill:#fff;stroke:#163b50;stroke-width:3}.symbol-fill{fill:#e9f2f5;stroke:#163b50;stroke-width:3}.symbol-accent{fill:none;stroke:#00a59b;stroke-width:3}.pin{fill:#fff;stroke:#17384b;stroke-width:2}.ref{font:700 16px ui-monospace,monospace;fill:#123247}.label{font:600 12px Inter,Arial,sans-serif;fill:#31566b}.value{font:500 10px Inter,Arial,sans-serif;fill:#6a7e88}.net{fill:none;stroke-width:4;stroke-linejoin:round}.power-dc{stroke:#e15454}.power-ac{stroke:#2d78c4}.control{stroke:#8a5bd2}.ground{stroke:#168b68;stroke-dasharray:10 5}.net-label{font:700 10px ui-monospace,monospace;paint-order:stroke;stroke:#f5f8fa;stroke-width:5;fill:#37576a}.panel{fill:#e9f0f3;stroke:#b5c8d1}.panel-title{font:700 12px Inter,Arial,sans-serif;fill:#17394d;letter-spacing:.08em}.bom{font:600 10px Inter,Arial,sans-serif;fill:#294b5e}.bom.item,.bom.qty{font-family:ui-monospace,monospace;font-weight:700}.erc-error{fill:#d54f58}.erc-warning{fill:#dc9b2f}.erc-text{font:600 11px Inter,Arial,sans-serif;fill:#294b5e}.note{font:600 11px Inter,Arial,sans-serif;fill:#7a3d3d}.stamp{font:800 13px Inter,Arial,sans-serif;fill:#b6434b;letter-spacing:.08em}.title-small{font:600 10px Inter,Arial,sans-serif;fill:#466473}.title-value{font:700 12px Inter,Arial,sans-serif;fill:#17394d}
  </style>
  <rect class="sheet" width="1600" height="900"/><rect class="border" x="28" y="28" width="1544" height="844"/>
  ${zoneMarkers()}
  <text class="title" x="72" y="80">${escapeXml(intent.title)}</text><text class="subtitle" x="72" y="105">PS3D ELECTRICAL · ${escapeXml(intent.standard)} SYMBOL BASIS · ${escapeXml(intent.template.replaceAll("-", " ").toUpperCase())}</text>
  <g aria-label="electrical nets">${nets}</g><g aria-label="electrical components">${components}</g>
  <rect class="panel" x="1140" y="82" width="395" height="190" rx="5"/><text class="panel-title" x="1170" y="108">CONCEPT BOM / DEVICE INDEX${bom.length > visibleBomCount ? ` · ${visibleBomCount}/${bom.length} SHOWN` : ""}</text>${bomRows}${bomOverflow}
  <rect class="panel" x="55" y="632" width="630" height="190" rx="5"/><text class="panel-title" x="80" y="660">ELECTRICAL RULE CHECK · ${erc.status.toUpperCase()} · ${erc.errors} ERROR · ${erc.warnings} WARNING</text>${issueRows || `<text class="erc-text" x="80" y="700">No structural connectivity issues found in this bounded concept. Engineering review is still required.</text>`}${issueOverflow}
  <g transform="translate(1140 650)"><rect class="panel" width="395" height="172" rx="5"/><text class="stamp" x="20" y="34">NOT FOR CONSTRUCTION</text><text class="note" x="20" y="62">${escapeXml(wrapText(intent.notes, 54)[0] ?? "")}</text><text class="note" x="20" y="82">${escapeXml(wrapText(intent.notes, 54)[1] ?? "")}</text><text class="note" x="20" y="102">${escapeXml(wrapText(intent.notes, 54)[2] ?? "")}</text><text class="title-small" x="20" y="134">AUTO-GENERATED</text><text class="title-value" x="140" y="134">REVIEW / VERIFY / APPROVE</text><text class="title-small" x="20" y="155">SHEET</text><text class="title-value" x="140" y="155">E-001 · REV PREVIEW</text></g>
  </svg>`;
}

function renderNet(net: ElectricalNet, routed: ElectricalSheetRoute | undefined): string {
  if (routed === undefined) return `<g data-net-id="${escapeXml(net.id)}" data-route-status="blocked"><title>${escapeXml(`${net.name} — no clear orthogonal route`)}</title></g>`;
  const { path, label } = routed;
  const displayName = truncateSchematicText(net.name, 24);
  return `<g data-net-id="${escapeXml(net.id)}"><title>${escapeXml(net.name)}</title><path class="net ${escapeXml(net.class)}" d="${path}"/><text class="net-label" text-anchor="middle" x="${label[0]}" y="${label[1]}"${textFitAttributes(displayName, 168, 7.5)}>${escapeXml(displayName)}</text></g>`;
}

function renderComponent(component: ElectricalComponent): string {
  const [x, y] = component.position;
  const referenceText = truncateSchematicText(component.reference, 12);
  const labelText = truncateSchematicText(component.label, 22);
  const valueText = truncateSchematicText(component.value, 22);
  const pins = component.terminals.map((terminal) => {
    const point = terminalLocalPoint(component, terminal);
    return `<circle class="pin" cx="${point[0] - x}" cy="${point[1] - y}" r="5"><title>${escapeXml(`${component.reference}.${terminal} · ${electricalTerminalRole(component.kind, terminal)}`)}</title></circle>`;
  }).join("");
  return `<g data-component-id="${escapeXml(component.id)}" transform="translate(${x} ${y}) rotate(${component.rotationDeg})"><title>${escapeXml(`${component.reference} ${component.label} ${component.value}`)}</title>${symbolGeometry(component)}${pins}<text class="ref" text-anchor="middle" x="0" y="76"${textFitAttributes(referenceText, 132, 10)}>${escapeXml(referenceText)}</text><text class="label" text-anchor="middle" x="0" y="94"${textFitAttributes(labelText, 132, 12)}>${escapeXml(labelText)}</text><text class="value" text-anchor="middle" x="0" y="110"${textFitAttributes(valueText, 132, 10)}>${escapeXml(valueText)}</text></g>`;
}

function truncateSchematicText(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters - 1)}…`;
}

function textFitAttributes(value: string, maximumWidth: number, conservativeCharacterWidth: number): string {
  return value.length * conservativeCharacterWidth > maximumWidth ? ` textLength="${maximumWidth}" lengthAdjust="spacingAndGlyphs"` : "";
}

function symbolGeometry(component: ElectricalComponent): string {
  switch (component.kind) {
    case "battery": return `<path class="symbol" d="M-20-34V34M10-24V24M-55 0h35M10 0h45"/><text class="ref" x="-32" y="-40">+</text><text class="ref" x="4" y="-40">−</text>`;
    case "fuse": return `<path class="symbol" d="M-55 0h18M37 0h18"/><rect class="symbol-fill" x="-37" y="-18" width="74" height="36" rx="5"/><path class="symbol-accent" d="m-25 10 50-20"/>`;
    case "disconnect": return `<path class="symbol" d="M-55 0h22M33 0h22M-27 0 25-27"/><circle class="symbol-fill" cx="-27" cy="0" r="6"/><circle class="symbol-fill" cx="27" cy="0" r="6"/>`;
    case "contactor": return `<path class="symbol" d="M-55 0h20M35 0h20M-28 0 22-22"/><rect class="symbol-fill" x="-24" y="18" width="48" height="24" rx="12"/><path class="symbol-accent" d="M0 18V8"/>`;
    case "inverter": return `<rect class="symbol-fill" x="-50" y="-42" width="100" height="84" rx="6"/><text class="ref" text-anchor="middle" x="0" y="-8">DC</text><path class="symbol-accent" d="M-32 12h20m12 0c7-11 14-11 22 0s15 11 22 0"/>`;
    case "transformer": return `<path class="symbol" d="M-55 0h18M37 0h18M-8-38v76M8-38v76"/><path class="symbol-accent" d="M-30-30c-18 8-18 16 0 24-18 8-18 16 0 24-18 8-18 16 0 24M30-30c18 8 18 16 0 24 18 8 18 16 0 24 18 8 18 16 0 24"/>`;
    case "breaker": return `<path class="symbol" d="M-55 0h18M37 0h18"/><rect class="symbol-fill" x="-37" y="-34" width="74" height="68" rx="6"/><path class="symbol-accent" d="M-20 16 18-18M-20-18v34h38"/>`;
    case "load": return `<path class="symbol" d="M-55 0h18M37 0h18"/><circle class="symbol-fill" cx="0" cy="0" r="37"/><path class="symbol-accent" d="m-24-24 48 48m0-48-48 48"/>`;
    case "motor": return `<path class="symbol" d="M-55 0h18"/><circle class="symbol-fill" cx="0" cy="0" r="38"/><text class="ref" text-anchor="middle" x="0" y="7">M</text>`;
    case "ground": return `<path class="symbol" d="M0-48v22M-30-26h60M-20-14h40M-9-2H9"/>`;
    case "terminal": return `<path class="symbol" d="M-55 0h42"/><circle class="symbol-fill" cx="0" cy="0" r="13"/>`;
    case "sensor": return `<path class="symbol" d="M-55 0h20M35 0h20"/><path class="symbol-fill" d="M0-38 35 0 0 38-35 0z"/><circle class="symbol-accent" cx="0" cy="0" r="10"/>`;
    case "hvac": return `<rect class="symbol-fill" x="-42" y="-42" width="84" height="84" rx="5"/><circle class="symbol-accent" cx="0" cy="0" r="27"/><path class="symbol-accent" d="M0-27c15 5 18 15 8 28M24 13C12 24 2 22-7 9M-23 14c-3-16 4-24 18-28"/>`;
  }
}

function terminalLocalPoint(component: ElectricalComponent, terminal: string): Vec2 {
  const [x, y] = component.position;
  if (component.kind === "ground") return [x, y - 48];
  if (component.terminals.length === 1) return [x - 55, y];
  const index = component.terminals.indexOf(terminal);
  if (index <= 0) return [x - 55, y];
  if (index === 1) return [x + 55, y];
  return [x, y + 50 + (index - 2) * 12];
}

function endpointKey(endpoint: ElectricalNetEndpoint): string {
  return `${endpoint.componentId}:${endpoint.terminal}`;
}

function zoneMarkers(): string {
  const top = ["A", "B", "C", "D", "E", "F", "G", "H"].map((zone, index) => `<text class="zone" x="${125 + index * 193}" y="22">${zone}</text>`).join("");
  const sides = ["1", "2", "3", "4"].map((zone, index) => `<text class="zone" x="10" y="${145 + index * 205}">${zone}</text><text class="zone" x="1580" y="${145 + index * 205}">${zone}</text>`).join("");
  return top + sides;
}

function wrapText(value: string, width: number): readonly string[] {
  const words = value.split(/\s+/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line.length === 0 ? word : `${line} ${word}`;
    if (next.length > width && line.length > 0) { lines.push(line); line = word; }
    else line = next;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "record";
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
