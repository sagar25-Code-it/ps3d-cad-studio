import type {
  AssemblyIntent,
  AssemblyMate,
  ComponentInstance,
  ElectricalComponent,
  ElectricalComponentKind,
  ElectricalIntent,
  ElectricalNet,
  ElectricalTemplateId,
  Vec2,
  Vec3
} from "./types.js";

const CARGO_20_ENVELOPE: Vec3 = [6_058, 2_438, 2_591];
const CARGO_40_HC_ENVELOPE: Vec3 = [12_192, 2_438, 2_896];
const BESS_20_HC_ENVELOPE: Vec3 = [6_058, 2_438, 2_896];

export function createCargoContainerAssembly(template: "cargo-20ft" | "cargo-40ft-hc"): AssemblyIntent {
  const envelope = template === "cargo-20ft" ? CARGO_20_ENVELOPE : CARGO_40_HC_ENVELOPE;
  const prefix = template;
  const frame = containerFrame(prefix, envelope, "#4f7695", "#84a8bd");
  const lengthLabel = template === "cargo-20ft" ? "20 ft nominal cargo planning frame" : "40 ft high-cube nominal cargo planning frame";
  return {
    id: "assembly:fixture-demo",
    name: lengthLabel,
    explodeMm: 0,
    template,
    nominalEnvelopeMm: envelope,
    designStatus: "arrangement-study",
    safetyNotes: [
      "NOMINAL ISO SERIES 1 EXTERNAL ENVELOPE — VERIFY THE SELECTED MANUFACTURER DATA SHEET.",
      "ORIGINAL PLANNING GEOMETRY ONLY; CORNER FITTINGS, STRUCTURAL DETAILS, DOORS, RATINGS, AND TOLERANCES ARE NOT CERTIFIED.",
      "NOT FOR FABRICATION, LIFTING, STACKING, TRANSPORT APPROVAL, OR CONSTRUCTION RELEASE."
    ],
    components: frame.components,
    mates: frame.mates
  };
}

export function createBessContainerAssembly(): AssemblyIntent {
  const frame = containerFrame("bess-20ft-hc", BESS_20_HC_ENVELOPE, "#324f68", "#6b93ad");
  const equipment: ComponentInstance[] = [];
  const rackXs = [-2_050, -700, 700, 2_050] as const;
  for (const side of [-1, 1] as const) {
    for (let index = 0; index < rackXs.length; index += 1) {
      const x = rackXs[index]!;
      const sideName = side < 0 ? "A" : "B";
      equipment.push(box(
        `component:bess-rack-${sideName.toLowerCase()}${index + 1}`,
        `Battery rack ${sideName}${index + 1}`,
        "#30b38c",
        [x, side * 820, 1_150],
        [850, 520, 2_000],
        false,
        [x / 3_000, side * 0.55, 0.25]
      ));
    }
  }
  equipment.push(
    box("component:bess-pcs", "PCS / bidirectional inverter", "#6957d8", [2_350, 0, 1_060], [720, 720, 1_820], false, [0.8, 0, 0.25]),
    box("component:bess-switchgear", "AC switchgear", "#e18b36", [-2_350, 0, 1_050], [650, 720, 1_800], false, [-0.8, 0, 0.25]),
    box("component:bess-dc-combiner", "DC combiner and disconnect", "#ddbd42", [1_520, 0, 1_950], [620, 360, 620], false, [0.55, 0, 0.65]),
    box("component:bess-hvac-a", "HVAC module A", "#3c91d1", [-1_350, 0, 2_460], [760, 650, 420], false, [-0.45, 0, 0.75]),
    box("component:bess-hvac-b", "HVAC module B", "#3c91d1", [450, 0, 2_460], [760, 650, 420], false, [0.2, 0, 0.75]),
    box("component:bess-fire-panel", "Fire detection / release interface placeholder", "#d85858", [-2_260, 880, 2_480], [430, 220, 520], false, [-0.7, 0.55, 0.7]),
    box("component:bess-aux-panel", "Auxiliary control panel", "#8f9eac", [2_280, -880, 2_500], [480, 220, 600], false, [0.75, -0.55, 0.7]),
    box("component:bess-cable-tray", "Overhead cable tray route", "#c7d2dc", [0, 0, 2_750], [4_900, 240, 120], false, [0, 0, 0.9]),
    { ...box("component:bess-service-aisle", "Service aisle keep-clear zone", "#2d6671", [0, 0, 1_050], [4_800, 760, 1_900], false, [0, 0, 0]), visible: false }
  );
  const all = [...frame.components, ...equipment];
  const equipmentMates: AssemblyMate[] = equipment
    .filter((component) => component.id !== "component:bess-service-aisle")
    .map((component) => ({
      id: `mate:${component.id.slice("component:".length)}-layout`,
      name: `${component.name} layout position`,
      kind: "fixed",
      componentIds: [component.id],
      status: "satisfied"
    }));
  return {
    id: "assembly:fixture-demo",
    name: "20 ft high-cube BESS arrangement study",
    explodeMm: 0,
    template: "bess-20ft-hc",
    nominalEnvelopeMm: BESS_20_HC_ENVELOPE,
    designStatus: "arrangement-study",
    safetyNotes: [
      "CONCEPTUAL EQUIPMENT ARRANGEMENT ONLY — NOT A SAFETY, CODE, THERMAL, STRUCTURAL, OR FIRE-PROPAGATION ANALYSIS.",
      "USER MUST SUPPLY CELL/MODULE/RACK MANUFACTURER DATA, LISTINGS, UL 9540A EVIDENCE, VENTILATION AND FIRE-PROTECTION DESIGN.",
      "CLEARANCES, EGRESS, ACCESS, SEPARATION, CABLES, GROUNDING, PROTECTION, HVAC, AND AHJ REQUIREMENTS REQUIRE LICENSED ENGINEERING REVIEW.",
      "NOT FOR CONSTRUCTION, PROCUREMENT, ENERGIZATION, OR PERMIT SUBMITTAL."
    ],
    components: all,
    mates: [...frame.mates, ...equipmentMates]
  };
}

export function createElectricalTemplate(template: ElectricalTemplateId, standard: ElectricalIntent["standard"] = "IEC"): ElectricalIntent {
  if (template === "dc-control") return dcControlTemplate(standard);
  if (template === "motor-starter") return motorStarterTemplate(standard);
  return bessSingleLineTemplate(standard);
}

export function createElectricalComponentInstance(
  kind: ElectricalComponentKind,
  id: string,
  reference: string,
  position: Vec2
): ElectricalComponent {
  const spec = componentSpec(kind);
  return {
    id,
    kind,
    reference,
    label: spec.label,
    value: "USER DEFINE",
    position,
    rotationDeg: 0,
    terminals: spec.terminals
  };
}

function containerFrame(prefix: string, envelope: Vec3, structureColor: string, panelColor: string): { components: readonly ComponentInstance[]; mates: readonly AssemblyMate[] } {
  const [length, width, height] = envelope;
  const x = length / 2 - 65;
  const y = width / 2 - 65;
  const z = height / 2;
  const components: ComponentInstance[] = [
    box(`component:${prefix}-floor`, "Floor planning slab", panelColor, [0, 0, 65], [length - 170, width - 170, 80], true, [0, 0, -0.35]),
    box(`component:${prefix}-roof`, "Roof planning panel", panelColor, [0, 0, height - 45], [length - 170, width - 170, 55], true, [0, 0, 0.6])
  ];
  for (const sx of [-1, 1] as const) for (const sy of [-1, 1] as const) {
    components.push(box(
      `component:${prefix}-corner-${sx < 0 ? "left" : "right"}-${sy < 0 ? "near" : "far"}`,
      `${sx < 0 ? "Left" : "Right"} ${sy < 0 ? "near" : "far"} corner post`,
      structureColor,
      [sx * x, sy * y, z],
      [120, 120, height - 130],
      true,
      [sx * 0.5, sy * 0.5, 0.25]
    ));
  }
  for (const sy of [-1, 1] as const) for (const top of [false, true]) {
    components.push(box(
      `component:${prefix}-${top ? "top" : "bottom"}-${sy < 0 ? "near" : "far"}-rail`,
      `${top ? "Top" : "Bottom"} ${sy < 0 ? "near" : "far"} side rail`,
      structureColor,
      [0, sy * y, top ? height - 65 : 65],
      [length - 160, 105, 105],
      true,
      [0, sy * 0.65, top ? 0.55 : -0.35]
    ));
  }
  for (const sx of [-1, 1] as const) for (const top of [false, true]) {
    components.push(box(
      `component:${prefix}-${sx < 0 ? "front" : "rear"}-${top ? "header" : "sill"}`,
      `${sx < 0 ? "Front" : "Rear"} ${top ? "header" : "sill"}`,
      structureColor,
      [sx * x, 0, top ? height - 65 : 65],
      [105, width - 160, 105],
      true,
      [sx * 0.65, 0, top ? 0.55 : -0.35]
    ));
  }
  components.push(
    box(`component:${prefix}-door-left`, "Planning door leaf left", "#355f7a", [x - 25, -width / 4, z], [45, width / 2 - 125, height - 250], true, [0.75, -0.35, 0]),
    box(`component:${prefix}-door-right`, "Planning door leaf right", "#355f7a", [x - 25, width / 4, z], [45, width / 2 - 125, height - 250], true, [0.75, 0.35, 0])
  );
  const mates: AssemblyMate[] = components.map((component) => ({
    id: `mate:${component.id.slice("component:".length)}-fixed`,
    name: `${component.name} fixed in planning frame`,
    kind: "fixed",
    componentIds: [component.id],
    status: "satisfied"
  }));
  return { components, mates };
}

function bessSingleLineTemplate(standard: ElectricalIntent["standard"]): ElectricalIntent {
  const components = [
    electrical("electrical-component:bess-battery", "battery", "BAT1", "Battery string", "USER DEFINE V / kWh", [170, 330]),
    electrical("electrical-component:bess-fuse", "fuse", "F1", "String fuse", "USER DEFINE A", [360, 330]),
    electrical("electrical-component:bess-disconnect", "disconnect", "QS1", "DC disconnect", "USER DEFINE V/A", [560, 330]),
    electrical("electrical-component:bess-inverter", "inverter", "PCS1", "Bidirectional PCS", "USER DEFINE kVA", [790, 330]),
    electrical("electrical-component:bess-breaker", "breaker", "QF1", "AC breaker", "USER DEFINE A/kA", [1_020, 330]),
    electrical("electrical-component:bess-transformer", "transformer", "T1", "Isolation transformer", "USER DEFINE ratio/kVA", [1_240, 350]),
    electrical("electrical-component:bess-pcc", "terminal", "X1", "PCC / grid interface", "USER DEFINE", [1_450, 350]),
    electrical("electrical-component:bess-ground", "ground", "PE1", "Protective earth reference", "SITE DESIGN", [900, 570], 180)
  ] as const;
  const nets: ElectricalNet[] = [
    net("electrical-net:bess-dc-1", "DC STRING +", "power-dc", [endpoint(components[0], "P"), endpoint(components[1], "1")]),
    net("electrical-net:bess-dc-2", "FUSED DC", "power-dc", [endpoint(components[1], "2"), endpoint(components[2], "1")]),
    net("electrical-net:bess-dc-bus", "DC BUS", "power-dc", [endpoint(components[2], "2"), endpoint(components[3], "DC")]),
    net("electrical-net:bess-ac-1", "PCS AC", "power-ac", [endpoint(components[3], "AC"), endpoint(components[4], "1")]),
    net("electrical-net:bess-ac-2", "PROTECTED AC", "power-ac", [endpoint(components[4], "2"), endpoint(components[5], "PRI")]),
    net("electrical-net:bess-pcc", "PCC", "power-ac", [endpoint(components[5], "SEC"), endpoint(components[6], "1")]),
    net("electrical-net:bess-pe", "PE", "ground", [endpoint(components[3], "PE"), endpoint(components[5], "PE"), endpoint(components[7], "PE")])
  ];
  return electricalIntent("BESS conceptual single-line diagram", standard, "bess-single-line", components, nets,
    "CONCEPT ONLY — protection settings, short-circuit duty, conductor sizing, grounding, controls, isolation, arc-flash, utility interconnection, and code compliance require project-specific licensed engineering.");
}

function dcControlTemplate(standard: ElectricalIntent["standard"]): ElectricalIntent {
  const components = [
    electrical("electrical-component:dc-source", "terminal", "X1", "24 VDC source", "24 VDC USER VERIFY", [180, 330]),
    electrical("electrical-component:dc-fuse", "fuse", "F1", "Control fuse", "USER DEFINE A", [400, 330]),
    electrical("electrical-component:dc-disconnect", "disconnect", "S1", "Maintenance disconnect", "USER DEFINE", [620, 330]),
    electrical("electrical-component:dc-contactor", "contactor", "K1", "Control relay contact", "USER DEFINE", [850, 330]),
    electrical("electrical-component:dc-sensor", "sensor", "B1", "Permissive sensor", "USER DEFINE", [1_070, 350]),
    electrical("electrical-component:dc-load", "load", "Y1", "Auxiliary load", "USER DEFINE W", [1_300, 380]),
    electrical("electrical-component:dc-ground", "ground", "PE1", "Reference / return", "SITE DESIGN", [800, 570], 180)
  ] as const;
  const nets = [
    net("electrical-net:dc-source", "+24 VDC", "control", [endpoint(components[0], "1"), endpoint(components[1], "1")]),
    net("electrical-net:dc-fused", "FUSED +24 VDC", "control", [endpoint(components[1], "2"), endpoint(components[2], "1")]),
    net("electrical-net:dc-switched", "SWITCHED +24 VDC", "control", [endpoint(components[2], "2"), endpoint(components[3], "1")]),
    net("electrical-net:dc-permissive", "PERMISSIVE", "control", [endpoint(components[3], "2"), endpoint(components[4], "1")]),
    net("electrical-net:dc-load", "LOAD FEED", "control", [endpoint(components[4], "2"), endpoint(components[5], "1")]),
    net("electrical-net:dc-return", "0 V / REFERENCE", "ground", [endpoint(components[5], "2"), endpoint(components[6], "PE")])
  ];
  return electricalIntent("DC auxiliary control concept", standard, "dc-control", components, nets,
    "FUNCTIONAL CONCEPT ONLY — determine segregation, fail-safe state, device ratings, wire sizes, terminal plans, protection, grounding, and safety integrity from the approved project requirements.");
}

function motorStarterTemplate(standard: ElectricalIntent["standard"]): ElectricalIntent {
  const components = [
    electrical("electrical-component:motor-source", "terminal", "X1", "3-phase supply", "USER DEFINE V/Hz", [210, 330]),
    electrical("electrical-component:motor-breaker", "breaker", "QF1", "Motor circuit breaker", "USER DEFINE A/kA", [480, 330]),
    electrical("electrical-component:motor-contactor", "contactor", "KM1", "Motor contactor", "USER DEFINE AC duty", [760, 330]),
    electrical("electrical-component:motor-load", "motor", "M1", "Three-phase motor", "USER DEFINE kW", [1_060, 350]),
    electrical("electrical-component:motor-ground", "ground", "PE1", "Protective earth", "SITE DESIGN", [910, 570], 180)
  ] as const;
  const nets = [
    net("electrical-net:motor-line", "LINE", "power-ac", [endpoint(components[0], "1"), endpoint(components[1], "1")]),
    net("electrical-net:motor-protected", "PROTECTED LINE", "power-ac", [endpoint(components[1], "2"), endpoint(components[2], "1")]),
    net("electrical-net:motor-switched", "MOTOR FEED", "power-ac", [endpoint(components[2], "2"), endpoint(components[3], "L")]),
    net("electrical-net:motor-pe", "PE", "ground", [endpoint(components[3], "PE"), endpoint(components[4], "PE")])
  ];
  return electricalIntent("Direct-on-line motor starter concept", standard, "motor-starter", components, nets,
    "FUNCTIONAL SINGLE-LINE ONLY — overload selection, coordination, conductor sizing, fault duty, controls, interlocks, emergency stop, machinery safety, and field wiring remain outside this preview.");
}

function electricalIntent(
  title: string,
  standard: ElectricalIntent["standard"],
  template: ElectricalTemplateId,
  components: readonly ElectricalComponent[],
  nets: readonly ElectricalNet[],
  notes: string
): ElectricalIntent {
  return { id: "electrical:main", title, standard, template, components, nets, notes };
}

function electrical(id: string, kind: ElectricalComponentKind, reference: string, label: string, value: string, position: Vec2, rotationDeg = 0): ElectricalComponent {
  return { id, kind, reference, label, value, position, rotationDeg, terminals: componentSpec(kind).terminals };
}

function componentSpec(kind: ElectricalComponentKind): { label: string; terminals: readonly string[] } {
  switch (kind) {
    case "battery": return { label: "Battery", terminals: ["P", "N"] };
    case "inverter": return { label: "Inverter / PCS", terminals: ["DC", "AC", "PE"] };
    case "transformer": return { label: "Transformer", terminals: ["PRI", "SEC", "PE"] };
    case "motor": return { label: "Motor", terminals: ["L", "PE"] };
    case "ground": return { label: "Protective earth", terminals: ["PE"] };
    case "terminal": return { label: "Terminal", terminals: ["1"] };
    default: return { label: kind[0]!.toUpperCase() + kind.slice(1), terminals: ["1", "2"] };
  }
}

function endpoint(component: ElectricalComponent, terminal: string): { componentId: string; terminal: string } {
  return { componentId: component.id, terminal };
}

function net(id: string, name: string, netClass: ElectricalNet["class"], endpoints: readonly { componentId: string; terminal: string }[]): ElectricalNet {
  return { id, name, class: netClass, endpoints };
}

function box(
  id: string,
  name: string,
  color: string,
  translationMm: Vec3,
  sizeMm: Vec3,
  grounded: boolean,
  explosionDirection: Vec3
): ComponentInstance {
  return { id, name, shape: "box", grounded, visible: true, color, translationMm, rotationDeg: [0, 0, 0], sizeMm, explosionDirection };
}
