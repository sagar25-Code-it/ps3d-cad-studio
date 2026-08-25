import type { ComponentInstance, ComponentShape, MasterCartTemplateId, Vec3 } from "./types.js";

export type MasterCartCategoryId =
  | "fasteners"
  | "bearings-bushings"
  | "gears"
  | "chain-sprockets"
  | "belts-pulleys"
  | "seals"
  | "linear-motion"
  | "hose-fittings"
  | "tube-fittings"
  | "hand-tools";

export type MasterCartUnitSystem = "metric" | "inch" | "universal";

export interface MasterCartCategory {
  readonly id: MasterCartCategoryId;
  readonly label: string;
  readonly icon: string;
  readonly sourceUrl: string;
}

export interface MasterCartSizeOption {
  readonly id: string;
  readonly label: string;
  readonly system: MasterCartUnitSystem;
  readonly values: Readonly<Record<string, number>>;
}

export interface MasterCartChoice {
  readonly id: string;
  readonly label: string;
  readonly color?: string;
}

export interface MasterCartEditableField {
  readonly id: string;
  readonly label: string;
  readonly unit: "mm" | "count" | "deg";
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly defaultValue: number;
}

export interface MasterCartDimensionDefinition {
  readonly key: string;
  readonly symbol: string;
  readonly label: string;
  readonly unit: "mm" | "count" | "deg";
}

export interface MasterCartTemplate {
  readonly id: MasterCartTemplateId;
  readonly categoryId: MasterCartCategoryId;
  readonly name: string;
  readonly family: string;
  readonly icon: string;
  readonly description: string;
  readonly standardBasis: string;
  readonly sourceUrl: string;
  readonly sizeOptions: readonly MasterCartSizeOption[];
  readonly defaultSizeId: string;
  readonly materialOptions: readonly MasterCartChoice[];
  readonly defaultMaterialId: string;
  readonly finishOptions: readonly MasterCartChoice[];
  readonly defaultFinishId: string;
  readonly editableFields: readonly MasterCartEditableField[];
  readonly dimensions: readonly MasterCartDimensionDefinition[];
}

export interface MasterCartConfiguration {
  readonly sizeId: string;
  readonly materialId: string;
  readonly finishId: string;
  readonly values: Readonly<Record<string, number>>;
}

export interface MasterCartDimension {
  readonly key: string;
  readonly symbol: string;
  readonly label: string;
  readonly value: number;
  readonly unit: "mm" | "count" | "deg";
}

export interface MasterCartBuild {
  readonly template: MasterCartTemplate;
  readonly configuration: MasterCartConfiguration;
  readonly designation: string;
  readonly components: readonly ComponentInstance[];
  readonly dimensions: readonly MasterCartDimension[];
  readonly sourceUrl: string;
  readonly boundary: string;
}

const MCMASTER = "https://www.mcmaster.com";

export const MASTER_CART_CATEGORIES: readonly MasterCartCategory[] = [
  { id: "fasteners", label: "Fasteners", icon: "fastener", sourceUrl: `${MCMASTER}/products/screws/` },
  { id: "bearings-bushings", label: "Bearings & bushings", icon: "bearing", sourceUrl: `${MCMASTER}/products/rotary-bearings/` },
  { id: "gears", label: "Gears", icon: "gear", sourceUrl: `${MCMASTER}/products/gears/` },
  { id: "chain-sprockets", label: "Chain & sprockets", icon: "sprocket", sourceUrl: `${MCMASTER}/products/sprockets/` },
  { id: "belts-pulleys", label: "Belts & pulleys", icon: "belt", sourceUrl: `${MCMASTER}/products/drive-belts/` },
  { id: "seals", label: "O-rings & seals", icon: "o-ring", sourceUrl: `${MCMASTER}/products/o-rings/` },
  { id: "linear-motion", label: "Linear motion", icon: "linear-motion", sourceUrl: `${MCMASTER}/products/linear-motion/` },
  { id: "hose-fittings", label: "Hose fittings", icon: "hose-fitting", sourceUrl: `${MCMASTER}/products/hydraulic-hose-fittings/` },
  { id: "tube-fittings", label: "Tube fittings", icon: "tube-fitting", sourceUrl: `${MCMASTER}/products/tube-fittings/` },
  { id: "hand-tools", label: "Hand tools", icon: "hand-tool", sourceUrl: `${MCMASTER}/products/hand-tools/` }
];

const STEEL_MATERIALS: readonly MasterCartChoice[] = [
  { id: "alloy-steel", label: "Alloy steel", color: "#9ca3a8" },
  { id: "stainless-18-8", label: "18-8 stainless steel", color: "#c3c8cc" },
  { id: "stainless-316", label: "316 stainless steel", color: "#b7c1c8" },
  { id: "aluminum-6061", label: "6061 aluminum", color: "#aab8c1" }
];

const BEARING_MATERIALS: readonly MasterCartChoice[] = [
  { id: "bearing-steel", label: "Chrome bearing steel", color: "#b3b8bc" },
  { id: "stainless-bearing", label: "Stainless bearing steel", color: "#c2c9ce" },
  { id: "acetal", label: "Acetal polymer", color: "#e5e1d8" }
];

const BUSHING_MATERIALS: readonly MasterCartChoice[] = [
  { id: "oil-bronze", label: "Oil-embedded bronze", color: "#a96c3e" },
  { id: "sae-660-bronze", label: "SAE 660 bronze", color: "#b87846" },
  { id: "ptfe-composite", label: "PTFE composite", color: "#d7d6ca" },
  { id: "acetal", label: "Acetal polymer", color: "#e5e1d8" }
];

const FITTING_MATERIALS: readonly MasterCartChoice[] = [
  { id: "zinc-steel", label: "Zinc-plated steel", color: "#b6bbc0" },
  { id: "stainless-316", label: "316 stainless steel", color: "#c2c9ce" },
  { id: "brass", label: "Brass", color: "#ba8c3d" }
];

const BLACK_AND_PLAIN: readonly MasterCartChoice[] = [
  { id: "black-oxide", label: "Black oxide" },
  { id: "plain", label: "Plain" },
  { id: "zinc", label: "Zinc plated" }
];

const PLAIN_ONLY: readonly MasterCartChoice[] = [{ id: "plain", label: "Plain / as supplied" }];

const METRIC_THREADS: readonly MasterCartSizeOption[] = [
  thread("m2", "M2 × 0.4", "metric", 2, 0.4), thread("m2-5", "M2.5 × 0.45", "metric", 2.5, 0.45),
  thread("m3", "M3 × 0.5", "metric", 3, 0.5), thread("m4", "M4 × 0.7", "metric", 4, 0.7),
  thread("m5", "M5 × 0.8", "metric", 5, 0.8), thread("m6", "M6 × 1", "metric", 6, 1),
  thread("m8", "M8 × 1.25", "metric", 8, 1.25), thread("m10", "M10 × 1.5", "metric", 10, 1.5),
  thread("m12", "M12 × 1.75", "metric", 12, 1.75), thread("m16", "M16 × 2", "metric", 16, 2),
  thread("m20", "M20 × 2.5", "metric", 20, 2.5), thread("m24", "M24 × 3", "metric", 24, 3)
];

const INCH_THREADS: readonly MasterCartSizeOption[] = [
  thread("no4-40", "#4-40 UNC", "inch", 2.845, 25.4 / 40), thread("no6-32", "#6-32 UNC", "inch", 3.505, 25.4 / 32),
  thread("no8-32", "#8-32 UNC", "inch", 4.166, 25.4 / 32), thread("no10-24", "#10-24 UNC", "inch", 4.826, 25.4 / 24),
  thread("quarter-20", "1/4-20 UNC", "inch", 6.35, 25.4 / 20), thread("five-sixteenths-18", "5/16-18 UNC", "inch", 7.938, 25.4 / 18),
  thread("three-eighths-16", "3/8-16 UNC", "inch", 9.525, 25.4 / 16), thread("half-13", "1/2-13 UNC", "inch", 12.7, 25.4 / 13),
  thread("five-eighths-11", "5/8-11 UNC", "inch", 15.875, 25.4 / 11), thread("three-quarter-10", "3/4-10 UNC", "inch", 19.05, 2.54),
  thread("one-8", "1-8 UNC", "inch", 25.4, 3.175)
];

const ALL_THREADS = [...METRIC_THREADS, ...INCH_THREADS] as const;

const BEARING_SIZES: readonly MasterCartSizeOption[] = [
  size("608", "608 · 8 × 22 × 7 mm", "metric", { boreMm: 8, outsideDiameterMm: 22, widthMm: 7 }),
  size("6000", "6000 · 10 × 26 × 8 mm", "metric", { boreMm: 10, outsideDiameterMm: 26, widthMm: 8 }),
  size("6200", "6200 · 10 × 30 × 9 mm", "metric", { boreMm: 10, outsideDiameterMm: 30, widthMm: 9 }),
  size("6201", "6201 · 12 × 32 × 10 mm", "metric", { boreMm: 12, outsideDiameterMm: 32, widthMm: 10 }),
  size("6202", "6202 · 15 × 35 × 11 mm", "metric", { boreMm: 15, outsideDiameterMm: 35, widthMm: 11 }),
  size("6203", "6203 · 17 × 40 × 12 mm", "metric", { boreMm: 17, outsideDiameterMm: 40, widthMm: 12 }),
  size("6204", "6204 · 20 × 47 × 14 mm", "metric", { boreMm: 20, outsideDiameterMm: 47, widthMm: 14 }),
  size("6205", "6205 · 25 × 52 × 15 mm", "metric", { boreMm: 25, outsideDiameterMm: 52, widthMm: 15 }),
  size("6206", "6206 · 30 × 62 × 16 mm", "metric", { boreMm: 30, outsideDiameterMm: 62, widthMm: 16 }),
  size("r8", "R8 · 1/2 × 1-1/8 × 5/16 in", "inch", { boreMm: 12.7, outsideDiameterMm: 28.575, widthMm: 7.938 })
];

const BUSHING_SIZES: readonly MasterCartSizeOption[] = [
  envelope("6-8-10", "6 × 8 × 10 mm", "metric", 6, 8, 10), envelope("8-10-12", "8 × 10 × 12 mm", "metric", 8, 10, 12),
  envelope("10-12-15", "10 × 12 × 15 mm", "metric", 10, 12, 15), envelope("12-16-20", "12 × 16 × 20 mm", "metric", 12, 16, 20),
  envelope("16-20-20", "16 × 20 × 20 mm", "metric", 16, 20, 20), envelope("20-25-25", "20 × 25 × 25 mm", "metric", 20, 25, 25),
  envelope("quarter-three-eighth-half", "1/4 × 3/8 × 1/2 in", "inch", 6.35, 9.525, 12.7),
  envelope("half-five-eighth-three-quarter", "1/2 × 5/8 × 3/4 in", "inch", 12.7, 15.875, 19.05)
];

const LINEAR_BEARING_SIZES: readonly MasterCartSizeOption[] = [
  envelope("lm6uu", "LM6UU · 6 × 12 × 19 mm", "metric", 6, 12, 19), envelope("lm8uu", "LM8UU · 8 × 15 × 24 mm", "metric", 8, 15, 24),
  envelope("lm10uu", "LM10UU · 10 × 19 × 29 mm", "metric", 10, 19, 29), envelope("lm12uu", "LM12UU · 12 × 21 × 30 mm", "metric", 12, 21, 30),
  envelope("lm16uu", "LM16UU · 16 × 28 × 37 mm", "metric", 16, 28, 37), envelope("lm20uu", "LM20UU · 20 × 32 × 42 mm", "metric", 20, 32, 42)
];

const SHAFT_SIZES: readonly MasterCartSizeOption[] = [6, 8, 10, 12, 16, 20, 25, 30].map((diameter) => size(`d${diameter}`, `Ø${diameter} mm`, "metric", { diameterMm: diameter }));
const GEAR_MODULES: readonly MasterCartSizeOption[] = [0.5, 0.8, 1, 1.5, 2, 2.5, 3].map((moduleMm) => size(`module-${String(moduleMm).replace(".", "-")}`, `Module ${moduleMm}`, "metric", { moduleMm }));
const CHAIN_SIZES: readonly MasterCartSizeOption[] = [
  size("ansi-25", "ANSI #25 · 6.35 mm pitch", "inch", { pitchMm: 6.35, rollerDiameterMm: 3.3 }),
  size("ansi-35", "ANSI #35 · 9.525 mm pitch", "inch", { pitchMm: 9.525, rollerDiameterMm: 5.08 }),
  size("ansi-40", "ANSI #40 · 12.7 mm pitch", "inch", { pitchMm: 12.7, rollerDiameterMm: 7.92 }),
  size("ansi-50", "ANSI #50 · 15.875 mm pitch", "inch", { pitchMm: 15.875, rollerDiameterMm: 10.16 }),
  size("ansi-60", "ANSI #60 · 19.05 mm pitch", "inch", { pitchMm: 19.05, rollerDiameterMm: 11.91 }),
  size("iso-06b", "ISO 06B · 9.525 mm pitch", "metric", { pitchMm: 9.525, rollerDiameterMm: 6.35 }),
  size("iso-08b", "ISO 08B · 12.7 mm pitch", "metric", { pitchMm: 12.7, rollerDiameterMm: 8.51 }),
  size("iso-10b", "ISO 10B · 15.875 mm pitch", "metric", { pitchMm: 15.875, rollerDiameterMm: 10.16 })
];

const TIMING_PITCHES: readonly MasterCartSizeOption[] = [
  size("2gt", "2GT · 2 mm pitch", "metric", { pitchMm: 2 }), size("3gt", "3GT · 3 mm pitch", "metric", { pitchMm: 3 }),
  size("5m", "HTD 5M · 5 mm pitch", "metric", { pitchMm: 5 }), size("8m", "HTD 8M · 8 mm pitch", "metric", { pitchMm: 8 }),
  size("xl", "XL · 0.200 in pitch", "inch", { pitchMm: 5.08 })
];

const O_RING_SIZES: readonly MasterCartSizeOption[] = [
  size("metric-5-1-5", "5 × 1.5 mm", "metric", { insideDiameterMm: 5, crossSectionMm: 1.5 }),
  size("metric-10-2", "10 × 2 mm", "metric", { insideDiameterMm: 10, crossSectionMm: 2 }),
  size("metric-20-2-5", "20 × 2.5 mm", "metric", { insideDiameterMm: 20, crossSectionMm: 2.5 }),
  size("metric-30-3", "30 × 3 mm", "metric", { insideDiameterMm: 30, crossSectionMm: 3 }),
  size("metric-50-3-5", "50 × 3.5 mm", "metric", { insideDiameterMm: 50, crossSectionMm: 3.5 }),
  size("as568-010", "AS568-010 · 0.239 × 0.070 in", "inch", { insideDiameterMm: 6.07, crossSectionMm: 1.78 }),
  size("as568-112", "AS568-112 · 0.487 × 0.103 in", "inch", { insideDiameterMm: 12.37, crossSectionMm: 2.62 }),
  size("as568-214", "AS568-214 · 0.984 × 0.139 in", "inch", { insideDiameterMm: 24.99, crossSectionMm: 3.53 })
];

const FITTING_SIZES: readonly MasterCartSizeOption[] = [
  size("quarter", "1/4 in", "inch", { nominalMm: 6.35, threadDiameterMm: 13.7 }),
  size("three-eighths", "3/8 in", "inch", { nominalMm: 9.525, threadDiameterMm: 17.1 }),
  size("half", "1/2 in", "inch", { nominalMm: 12.7, threadDiameterMm: 21.3 }),
  size("three-quarter", "3/4 in", "inch", { nominalMm: 19.05, threadDiameterMm: 26.7 }),
  size("one", "1 in", "inch", { nominalMm: 25.4, threadDiameterMm: 33.4 }),
  size("m12", "M12", "metric", { nominalMm: 8, threadDiameterMm: 12 }),
  size("m16", "M16", "metric", { nominalMm: 10, threadDiameterMm: 16 }),
  size("m20", "M20", "metric", { nominalMm: 14, threadDiameterMm: 20 })
];

const TUBE_SIZES: readonly MasterCartSizeOption[] = [
  size("tube-4", "4 mm tube OD", "metric", { tubeOutsideDiameterMm: 4 }), size("tube-6", "6 mm tube OD", "metric", { tubeOutsideDiameterMm: 6 }),
  size("tube-8", "8 mm tube OD", "metric", { tubeOutsideDiameterMm: 8 }), size("tube-10", "10 mm tube OD", "metric", { tubeOutsideDiameterMm: 10 }),
  size("tube-12", "12 mm tube OD", "metric", { tubeOutsideDiameterMm: 12 }), size("tube-quarter", "1/4 in tube OD", "inch", { tubeOutsideDiameterMm: 6.35 }),
  size("tube-three-eighths", "3/8 in tube OD", "inch", { tubeOutsideDiameterMm: 9.525 }), size("tube-half", "1/2 in tube OD", "inch", { tubeOutsideDiameterMm: 12.7 })
];

const ACME_SIZES: readonly MasterCartSizeOption[] = [
  size("tr8x2", "Tr8 × 2", "metric", { diameterMm: 8, leadMm: 2 }), size("tr8x8", "Tr8 × 8", "metric", { diameterMm: 8, leadMm: 8 }),
  size("tr10x2", "Tr10 × 2", "metric", { diameterMm: 10, leadMm: 2 }), size("tr12x3", "Tr12 × 3", "metric", { diameterMm: 12, leadMm: 3 }),
  size("tr16x4", "Tr16 × 4", "metric", { diameterMm: 16, leadMm: 4 }), size("half-10-acme", "1/2-10 ACME", "inch", { diameterMm: 12.7, leadMm: 2.54 })
];

const TOOL_SIZES: readonly MasterCartSizeOption[] = [2, 2.5, 3, 4, 5, 6, 8, 10].map((acrossFlatsMm) => size(`tool-${String(acrossFlatsMm).replace(".", "-")}`, `${acrossFlatsMm} mm`, "metric", { acrossFlatsMm }));

const FASTENER_FIELDS: readonly MasterCartEditableField[] = [field("lengthMm", "Length", "mm", 2, 300, 1, 25)];
const FASTENER_DIMS: readonly MasterCartDimensionDefinition[] = [dim("diameterMm", "d", "Nominal thread diameter"), dim("pitchMm", "P", "Thread pitch"), dim("lengthMm", "L", "Length")];

export const MASTER_CART_TEMPLATES: readonly MasterCartTemplate[] = [
  template("socket-head-cap-screw", "fasteners", "Socket-head cap screw", "Allen / socket screw", "fastener", "Cylindrical socket head with editable thread size, length, material, and finish.", "ISO 4762 / ASME B18.3 dimensional basis; generic preview", `${MCMASTER}/products/socket-head-screws/`, ALL_THREADS, "m6", STEEL_MATERIALS, "alloy-steel", BLACK_AND_PLAIN, "black-oxide", FASTENER_FIELDS, [...FASTENER_DIMS, dim("headDiameterMm", "dk", "Head diameter"), dim("headHeightMm", "k", "Head height")]),
  template("hex-head-bolt", "fasteners", "Hex-head bolt", "Hex bolt", "fastener", "Hex-head threaded fastener with common metric and UNC nominal sizes.", "ISO 4014 / ASME B18.2.1 dimensional basis; generic preview", `${MCMASTER}/products/hex-head-screws/`, ALL_THREADS, "m8", STEEL_MATERIALS, "alloy-steel", BLACK_AND_PLAIN, "zinc", FASTENER_FIELDS, [...FASTENER_DIMS, dim("hexAcrossFlatsMm", "s", "Head across flats")]),
  template("flat-head-socket-screw", "fasteners", "Flat-head socket screw", "Countersunk Allen screw", "fastener", "Countersunk socket fastener for flush seating studies.", "ISO 10642 / ASME B18.3 dimensional basis; generic preview", `${MCMASTER}/products/flat-head-socket-cap-screws/`, ALL_THREADS, "m5", STEEL_MATERIALS, "alloy-steel", BLACK_AND_PLAIN, "black-oxide", FASTENER_FIELDS, [...FASTENER_DIMS, dim("countersunkHeadDiameterMm", "dk", "Head diameter")]),
  template("shoulder-screw", "fasteners", "Shoulder screw", "Precision shoulder fastener", "fastener", "Socket shoulder screw with editable shoulder length.", "ISO 7379 / ASME B18.3 shoulder-screw basis; generic preview", `${MCMASTER}/products/shoulder-screws/`, ALL_THREADS, "m6", STEEL_MATERIALS, "alloy-steel", BLACK_AND_PLAIN, "black-oxide", [field("lengthMm", "Shoulder length", "mm", 4, 200, 1, 30)], [...FASTENER_DIMS, dim("shoulderDiameterMm", "ds", "Shoulder diameter")]),
  template("hex-nut", "fasteners", "Hex nut", "General-purpose nut", "fastener", "Hex nut envelope with visible bore and editable material/finish.", "ISO 4032 / ASME B18.2.2 dimensional basis; generic preview", `${MCMASTER}/products/hex-nuts/`, ALL_THREADS, "m8", STEEL_MATERIALS, "stainless-18-8", BLACK_AND_PLAIN, "plain", [], [dim("diameterMm", "d", "Nominal thread diameter"), dim("pitchMm", "P", "Thread pitch"), dim("hexAcrossFlatsMm", "s", "Across flats"), dim("nutHeightMm", "m", "Nut height")]),
  template("flat-washer", "fasteners", "Flat washer", "Plain washer", "fastener", "Annular washer preview sized from the selected nominal thread.", "ISO 7089 / ASME B18.21.1 basis; generic preview", `${MCMASTER}/products/flat-washers/`, ALL_THREADS, "m8", STEEL_MATERIALS, "stainless-18-8", BLACK_AND_PLAIN, "plain", [], [dim("washerInsideDiameterMm", "d1", "Inside diameter"), dim("washerOutsideDiameterMm", "d2", "Outside diameter"), dim("washerThicknessMm", "h", "Thickness")]),
  template("deep-groove-ball-bearing", "bearings-bushings", "Deep-groove ball bearing", "Radial ball bearing", "bearing", "Open radial bearing preview with inner ring, outer ring, and visible rolling elements.", "Common 6000-series envelope selection; verify manufacturer ratings and internal geometry", `${MCMASTER}/products/ball-bearings/`, BEARING_SIZES, "6202", BEARING_MATERIALS, "bearing-steel", PLAIN_ONLY, "plain", [], [dim("boreMm", "d", "Bore"), dim("outsideDiameterMm", "D", "Outside diameter"), dim("widthMm", "B", "Width")]),
  template("sleeve-bushing", "bearings-bushings", "Sleeve bushing", "Plain cylindrical bearing", "bushing", "Annular sleeve bearing envelope for arrangement and fit studies.", "Generic sleeve-bearing envelope; verify running clearance, PV, lubrication, and tolerance", `${MCMASTER}/products/sleeve-bearings/`, BUSHING_SIZES, "12-16-20", BUSHING_MATERIALS, "oil-bronze", PLAIN_ONLY, "plain", [], [dim("boreMm", "d", "Bore"), dim("outsideDiameterMm", "D", "Outside diameter"), dim("widthMm", "L", "Length")]),
  template("flanged-bushing", "bearings-bushings", "Flanged bushing", "Flanged sleeve bearing", "bushing", "Sleeve bushing with an integral locating flange.", "Generic flanged-bushing envelope; verify fits, flange load, PV, and lubrication", `${MCMASTER}/products/flanged-sleeve-bearings/`, BUSHING_SIZES, "12-16-20", BUSHING_MATERIALS, "oil-bronze", PLAIN_ONLY, "plain", [], [dim("boreMm", "d", "Bore"), dim("outsideDiameterMm", "D", "Body OD"), dim("widthMm", "L", "Body length"), dim("flangeDiameterMm", "Df", "Flange OD")]),
  template("spur-gear", "gears", "Spur gear", "Straight-tooth gear", "gear", "Parametric tooth-count, module, bore, and face-width preview.", "ISO metric module geometry approximation; no strength, quality grade, backlash, or contact analysis", `${MCMASTER}/products/spur-gears/`, GEAR_MODULES, "module-1", STEEL_MATERIALS, "alloy-steel", PLAIN_ONLY, "plain", [field("teeth", "Number of teeth", "count", 8, 120, 1, 24), field("boreMm", "Bore", "mm", 1, 80, 0.5, 8), field("faceWidthMm", "Face width", "mm", 2, 80, 0.5, 10)], [dim("moduleMm", "m", "Module"), dimCount("teeth", "z", "Teeth"), dim("pitchDiameterMm", "d", "Pitch diameter"), dim("outsideDiameterMm", "da", "Outside diameter"), dim("boreMm", "db", "Bore"), dim("faceWidthMm", "b", "Face width")]),
  template("roller-chain-sprocket", "chain-sprockets", "Roller-chain sprocket", "Single-strand sprocket", "sprocket", "Parametric sprocket envelope with selectable chain pitch and tooth count.", "ANSI/ISO pitch-circle approximation; verify tooth form, hub, keyway, chain data, and ratings", `${MCMASTER}/products/sprockets/`, CHAIN_SIZES, "ansi-40", STEEL_MATERIALS, "alloy-steel", PLAIN_ONLY, "plain", [field("teeth", "Number of teeth", "count", 9, 100, 1, 20), field("boreMm", "Bore", "mm", 2, 100, 0.5, 12), field("faceWidthMm", "Face width", "mm", 2, 60, 0.5, 8)], [dim("pitchMm", "P", "Chain pitch"), dimCount("teeth", "z", "Teeth"), dim("pitchDiameterMm", "Dp", "Pitch diameter"), dim("outsideDiameterMm", "Do", "Outside diameter"), dim("boreMm", "db", "Bore")]),
  template("roller-chain-link", "chain-sprockets", "Roller-chain link", "Chain planning segment", "chain", "Two-link visual planning segment for chain-routing and clearance studies.", "Visual-only chain envelope; not articulated, rated, or procurement-specific", `${MCMASTER}/products/roller-chain/`, CHAIN_SIZES, "ansi-40", STEEL_MATERIALS, "alloy-steel", PLAIN_ONLY, "plain", [], [dim("pitchMm", "P", "Pitch"), dim("rollerDiameterMm", "Dr", "Roller diameter")]),
  template("timing-belt-pulley", "belts-pulleys", "Timing-belt pulley", "Synchronous pulley", "belt", "Parametric synchronous pulley with pitch, tooth count, bore, and belt width.", "Pitch-diameter approximation; verify profile family, tooth form, flange, cord, and rating", `${MCMASTER}/products/timing-belt-pulleys/`, TIMING_PITCHES, "5m", STEEL_MATERIALS, "aluminum-6061", PLAIN_ONLY, "plain", [field("teeth", "Number of teeth", "count", 10, 120, 1, 24), field("boreMm", "Bore", "mm", 2, 80, 0.5, 8), field("faceWidthMm", "Belt width", "mm", 4, 80, 1, 15)], [dim("pitchMm", "P", "Pitch"), dimCount("teeth", "z", "Teeth"), dim("pitchDiameterMm", "Dp", "Pitch diameter"), dim("outsideDiameterMm", "Do", "Outside diameter"), dim("faceWidthMm", "b", "Belt width")]),
  template("timing-belt-loop", "belts-pulleys", "Timing-belt loop", "Synchronous belt envelope", "belt", "Closed visual belt envelope with selectable tooth pitch and editable tooth count/width.", "Visual-only circularized belt envelope; no cord, tooth, tension, or rating calculation", `${MCMASTER}/products/timing-belts/`, TIMING_PITCHES, "5m", [{ id: "neoprene-fiberglass", label: "Neoprene / fiberglass", color: "#2d3338" }, { id: "polyurethane-steel", label: "Polyurethane / steel", color: "#b8a96a" }], "neoprene-fiberglass", PLAIN_ONLY, "plain", [field("teeth", "Belt tooth count", "count", 20, 400, 1, 60), field("faceWidthMm", "Belt width", "mm", 4, 80, 1, 15)], [dim("pitchMm", "P", "Pitch"), dimCount("teeth", "z", "Teeth"), dim("pitchLengthMm", "Lp", "Pitch length"), dim("faceWidthMm", "b", "Width")]),
  template("o-ring", "seals", "O-ring", "Circular elastomer seal", "o-ring", "Torus preview selected by inside diameter and cross section.", "Generic metric/AS568 nominal envelope; verify material, hardness, squeeze, stretch, gland, fluid, temperature, and tolerances", `${MCMASTER}/products/o-rings/`, O_RING_SIZES, "metric-20-2-5", [{ id: "buna-n", label: "Buna-N / NBR", color: "#25292d" }, { id: "viton", label: "FKM / Viton", color: "#28231d" }, { id: "epdm", label: "EPDM", color: "#303235" }, { id: "silicone", label: "Silicone", color: "#c85b4e" }], "buna-n", PLAIN_ONLY, "plain", [], [dim("insideDiameterMm", "ID", "Inside diameter"), dim("crossSectionMm", "CS", "Cross section"), dim("outsideDiameterMm", "OD", "Outside diameter")]),
  template("linear-bearing", "linear-motion", "Linear ball bearing", "Round-shaft linear bearing", "linear-motion", "Annular linear bearing envelope with end seals and bore.", "Common LM-envelope preview; verify shaft class, preload, load, life, lubrication, and alignment", `${MCMASTER}/products/linear-bearings/`, LINEAR_BEARING_SIZES, "lm12uu", BEARING_MATERIALS, "bearing-steel", PLAIN_ONLY, "plain", [], [dim("boreMm", "d", "Shaft bore"), dim("outsideDiameterMm", "D", "Outside diameter"), dim("widthMm", "L", "Length")]),
  template("linear-shaft", "linear-motion", "Precision linear shaft", "Round linear shaft", "linear-motion", "Straight round shaft with selectable diameter and editable length.", "Generic shaft envelope; verify hardness, straightness, surface finish, tolerance, support span, and loading", `${MCMASTER}/products/linear-shafts/`, SHAFT_SIZES, "d12", [{ id: "hardened-steel", label: "Case-hardened steel", color: "#aeb4b8" }, { id: "stainless", label: "Stainless steel", color: "#c2c9ce" }, { id: "aluminum", label: "Aluminum", color: "#aab8c1" }], "hardened-steel", PLAIN_ONLY, "plain", [field("lengthMm", "Length", "mm", 20, 2000, 5, 300)], [dim("diameterMm", "d", "Diameter"), dim("lengthMm", "L", "Length")]),
  template("acme-lead-screw", "linear-motion", "ACME / trapezoidal lead screw", "Power screw", "linear-motion", "Lead-screw planning envelope with selectable diameter/lead and editable length.", "Generic envelope only; no exact helix, nut fit, efficiency, buckling, critical speed, life, or rating", `${MCMASTER}/products/acme-threaded-rods/`, ACME_SIZES, "tr12x3", STEEL_MATERIALS, "alloy-steel", PLAIN_ONLY, "plain", [field("lengthMm", "Length", "mm", 20, 2000, 5, 300)], [dim("diameterMm", "d", "Major diameter"), dim("leadMm", "L", "Lead"), dim("lengthMm", "Lg", "Overall length")]),
  template("shaft-collar", "linear-motion", "Clamp shaft collar", "Split-collar envelope", "linear-motion", "Annular shaft collar preview with a visible clamping boss.", "Generic collar envelope; verify bore tolerance, screw, clamp load, balance, material, and speed", `${MCMASTER}/products/shaft-collars/`, SHAFT_SIZES, "d12", STEEL_MATERIALS, "aluminum-6061", BLACK_AND_PLAIN, "black-oxide", [field("faceWidthMm", "Width", "mm", 4, 50, 0.5, 10)], [dim("diameterMm", "d", "Bore"), dim("outsideDiameterMm", "D", "Outside diameter"), dim("faceWidthMm", "B", "Width")]),
  template("hydraulic-straight-fitting", "hose-fittings", "Straight hydraulic hose fitting", "Male straight adapter", "hose-fitting", "Straight fitting envelope with threaded end, wrench hex, and hose stem.", "Generic arrangement preview; verify thread form, dash size, pressure, hose series, crimp specification, seal, and material", `${MCMASTER}/products/hydraulic-hose-fittings/`, FITTING_SIZES, "half", FITTING_MATERIALS, "zinc-steel", PLAIN_ONLY, "plain", [], [dim("nominalMm", "DN", "Nominal passage"), dim("threadDiameterMm", "d", "Thread envelope"), dim("overallLengthMm", "L", "Overall length")]),
  template("hydraulic-elbow-fitting", "hose-fittings", "90° hydraulic hose fitting", "Elbow adapter", "hose-fitting", "Right-angle fitting envelope with threaded end and hose stem.", "Generic arrangement preview; verify thread, pressure, swivel/crimp system, bend sweep, seal, and material", `${MCMASTER}/products/hydraulic-hose-fittings/`, FITTING_SIZES, "half", FITTING_MATERIALS, "zinc-steel", PLAIN_ONLY, "plain", [], [dim("nominalMm", "DN", "Nominal passage"), dim("threadDiameterMm", "d", "Thread envelope"), dim("overallLengthMm", "L", "Leg envelope")]),
  template("tube-compression-union", "tube-fittings", "Tube compression union", "Straight tube union", "tube-fitting", "Straight two-ferrule style planning envelope with wrench flats.", "Generic envelope; verify tube material/OD/wall, pressure, ferrule system, preparation, torque, cleanliness, and compatibility", `${MCMASTER}/products/tube-fittings/`, TUBE_SIZES, "tube-8", FITTING_MATERIALS, "stainless-316", PLAIN_ONLY, "plain", [], [dim("tubeOutsideDiameterMm", "OD", "Tube outside diameter"), dim("overallLengthMm", "L", "Overall length"), dim("hexAcrossFlatsMm", "s", "Wrench flats")]),
  template("tube-compression-elbow", "tube-fittings", "Tube compression elbow", "90° tube union", "tube-fitting", "Right-angle tube fitting planning envelope with two compression nuts.", "Generic envelope; verify tube material/OD/wall, pressure, ferrules, bend orientation, torque, and compatibility", `${MCMASTER}/products/tube-fittings/`, TUBE_SIZES, "tube-8", FITTING_MATERIALS, "stainless-316", PLAIN_ONLY, "plain", [], [dim("tubeOutsideDiameterMm", "OD", "Tube outside diameter"), dim("overallLengthMm", "L", "Leg envelope"), dim("hexAcrossFlatsMm", "s", "Wrench flats")]),
  template("hex-key", "hand-tools", "L-key hex wrench", "Allen key", "hand-tool", "L-shaped hex-key envelope sized by across-flats dimension.", "Visual tool envelope; verify actual arm lengths, material, hardness, tip style, and torque rating", `${MCMASTER}/products/hex-keys/`, TOOL_SIZES, "tool-5", [{ id: "tool-steel", label: "Hardened tool steel", color: "#555b60" }, { id: "stainless", label: "Stainless steel", color: "#bdc5ca" }], "tool-steel", BLACK_AND_PLAIN, "black-oxide", [field("lengthMm", "Long arm length", "mm", 20, 300, 1, 90)], [dim("acrossFlatsMm", "s", "Across flats"), dim("lengthMm", "L", "Long arm")]),
  template("combination-wrench", "hand-tools", "Combination wrench", "Open / box-end wrench", "hand-tool", "Simplified combination-wrench envelope selected by fastener size.", "Visual tool envelope; not an exact forged profile or torque-rated tool", `${MCMASTER}/products/combination-wrenches/`, TOOL_SIZES, "tool-10", [{ id: "chrome-vanadium", label: "Chrome-vanadium steel", color: "#b9bec2" }, { id: "stainless", label: "Stainless steel", color: "#c5ccd0" }], "chrome-vanadium", PLAIN_ONLY, "plain", [field("lengthMm", "Overall length", "mm", 60, 600, 5, 180)], [dim("acrossFlatsMm", "s", "Wrench size"), dim("lengthMm", "L", "Overall length")])
];

export const MASTER_CART_TEMPLATE_IDS: readonly MasterCartTemplateId[] = MASTER_CART_TEMPLATES.map((item) => item.id);

export function createMasterCartConfiguration(templateId: MasterCartTemplateId): MasterCartConfiguration {
  const selected = masterCartTemplate(templateId);
  return {
    sizeId: selected.defaultSizeId,
    materialId: selected.defaultMaterialId,
    finishId: selected.defaultFinishId,
    values: Object.fromEntries(selected.editableFields.map((editable) => [editable.id, editable.defaultValue]))
  };
}

export function masterCartTemplate(templateId: MasterCartTemplateId): MasterCartTemplate {
  const selected = MASTER_CART_TEMPLATES.find((item) => item.id === templateId);
  if (selected === undefined) throw new Error(`Unknown Master Cart template: ${templateId}`);
  return selected;
}

export function buildMasterCartItem(templateId: MasterCartTemplateId, input: MasterCartConfiguration, instanceId: string): MasterCartBuild {
  const selected = masterCartTemplate(templateId);
  const configuration = normalizeConfiguration(selected, input);
  const sizeChoice = selected.sizeOptions.find((option) => option.id === configuration.sizeId)!;
  const material = selected.materialOptions.find((option) => option.id === configuration.materialId)!;
  const finish = selected.finishOptions.find((option) => option.id === configuration.finishId)!;
  const values: Record<string, number> = { ...sizeChoice.values, ...configuration.values };
  enrichDerivedValues(selected.id, values);
  const summary = selected.editableFields.map((editable) => `${editable.label} ${format(values[editable.id] ?? editable.defaultValue)} ${editable.unit === "count" ? "" : editable.unit}`.trim()).join(" · ") || "standard envelope";
  const trace = {
    instanceId,
    templateId: selected.id,
    sizeLabel: sizeChoice.label,
    materialLabel: material.label,
    finishLabel: finish.label,
    parameterSummary: summary,
    provenance: "original-ps3d-parametric-preview" as const
  };
  const components = buildComponents(selected.id, values, material.color ?? "#aeb3b8", trace);
  const dimensions = selected.dimensions.flatMap((definition): readonly MasterCartDimension[] => {
    const value = values[definition.key];
    return value === undefined ? [] : [{ ...definition, value }];
  });
  return {
    template: selected,
    configuration,
    designation: `${selected.name} · ${sizeChoice.label}`,
    components,
    dimensions,
    sourceUrl: selected.sourceUrl,
    boundary: "Original PS3D parametric preview. Verify the live supplier record, governing standard, fits, ratings, material, finish, and application before procurement or manufacture."
  };
}

function normalizeConfiguration(selected: MasterCartTemplate, input: MasterCartConfiguration): MasterCartConfiguration {
  const sizeId = selected.sizeOptions.some((option) => option.id === input.sizeId) ? input.sizeId : selected.defaultSizeId;
  const materialId = selected.materialOptions.some((option) => option.id === input.materialId) ? input.materialId : selected.defaultMaterialId;
  const finishId = selected.finishOptions.some((option) => option.id === input.finishId) ? input.finishId : selected.defaultFinishId;
  const values = Object.fromEntries(selected.editableFields.map((editable) => {
    const candidate = input.values[editable.id];
    const bounded = Number.isFinite(candidate) ? Math.min(editable.maximum, Math.max(editable.minimum, candidate!)) : editable.defaultValue;
    return [editable.id, editable.unit === "count" ? Math.round(bounded) : bounded];
  }));
  return { sizeId, materialId, finishId, values };
}

function enrichDerivedValues(templateId: MasterCartTemplateId, values: Record<string, number>): void {
  const d = values["diameterMm"] ?? 8;
  if (templateId === "socket-head-cap-screw" || templateId === "shoulder-screw") {
    values["headDiameterMm"] = d * 1.55;
    values["headHeightMm"] = d;
    values["socketWidthMm"] = d * 0.72;
    values["shoulderDiameterMm"] = d * 1.25;
  }
  if (templateId === "hex-head-bolt" || templateId === "hex-nut") {
    values["hexAcrossFlatsMm"] = d * 1.5;
    values["nutHeightMm"] = d * 0.8;
  }
  if (templateId === "flat-head-socket-screw") values["countersunkHeadDiameterMm"] = d * 2;
  if (templateId === "flat-washer") {
    values["washerInsideDiameterMm"] = d * 1.1;
    values["washerOutsideDiameterMm"] = d * 2.1;
    values["washerThicknessMm"] = Math.max(0.5, d * 0.18);
  }
  if (templateId === "flanged-bushing") values["flangeDiameterMm"] = (values["outsideDiameterMm"] ?? d) * 1.35;
  if (templateId === "spur-gear") {
    values["pitchDiameterMm"] = values["moduleMm"]! * values["teeth"]!;
    values["outsideDiameterMm"] = values["moduleMm"]! * (values["teeth"]! + 2);
  }
  if (templateId === "roller-chain-sprocket") {
    values["pitchDiameterMm"] = values["pitchMm"]! / Math.sin(Math.PI / values["teeth"]!);
    values["outsideDiameterMm"] = values["pitchDiameterMm"]! + values["rollerDiameterMm"]! * 0.8;
  }
  if (templateId === "timing-belt-pulley") {
    values["pitchDiameterMm"] = values["pitchMm"]! * values["teeth"]! / Math.PI;
    values["outsideDiameterMm"] = Math.max(values["boreMm"]! + 4, values["pitchDiameterMm"]! - values["pitchMm"]! * 0.35);
  }
  if (templateId === "timing-belt-loop") values["pitchLengthMm"] = values["pitchMm"]! * values["teeth"]!;
  if (templateId === "o-ring") values["outsideDiameterMm"] = values["insideDiameterMm"]! + 2 * values["crossSectionMm"]!;
  if (templateId === "shaft-collar") values["outsideDiameterMm"] = values["diameterMm"]! * 1.8;
  if (templateId === "hydraulic-straight-fitting" || templateId === "hydraulic-elbow-fitting") values["overallLengthMm"] = values["threadDiameterMm"]! * 3.2;
  if (templateId === "tube-compression-union" || templateId === "tube-compression-elbow") {
    values["hexAcrossFlatsMm"] = values["tubeOutsideDiameterMm"]! * 1.8;
    values["overallLengthMm"] = values["tubeOutsideDiameterMm"]! * 5;
  }
}

function buildComponents(
  templateId: MasterCartTemplateId,
  values: Readonly<Record<string, number>>,
  color: string,
  trace: Omit<NonNullable<ComponentInstance["masterCart"]>, "role">
): readonly ComponentInstance[] {
  const d = values["diameterMm"] ?? values["boreMm"] ?? values["nominalMm"] ?? values["tubeOutsideDiameterMm"] ?? 8;
  const length = values["lengthMm"] ?? 25;
  if (templateId === "socket-head-cap-screw") return [
    part("shank", "Threaded shank", "cylinder", [0, 0, length / 2], [d, d, length], color, trace),
    part("head", "Socket head", "cylinder", [0, 0, length + values["headHeightMm"]! / 2], [values["headDiameterMm"]!, values["headDiameterMm"]!, values["headHeightMm"]!], color, trace),
    part("socket", "Hex socket", "hex-prism", [0, 0, length + values["headHeightMm"]! - 0.35], [values["socketWidthMm"]!, values["socketWidthMm"]!, 0.7], "#30363b", trace)
  ];
  if (templateId === "hex-head-bolt") return [
    part("shank", "Threaded shank", "cylinder", [0, 0, length / 2], [d, d, length], color, trace),
    part("head", "Hex head", "hex-prism", [0, 0, length + d * 0.45], [values["hexAcrossFlatsMm"]! * 1.15, values["hexAcrossFlatsMm"]! * 1.15, d * 0.9], color, trace)
  ];
  if (templateId === "flat-head-socket-screw") return [
    part("shank", "Threaded shank", "cylinder", [0, 0, length / 2], [d, d, length], color, trace),
    part("head", "Countersunk head", "cone", [0, 0, length + d * 0.42], [values["countersunkHeadDiameterMm"]!, d, d * 0.84], color, trace),
    part("socket", "Hex socket", "hex-prism", [0, 0, length + d * 0.82], [d * 0.7, d * 0.7, 0.5], "#30363b", trace)
  ];
  if (templateId === "shoulder-screw") {
    const shoulder = values["shoulderDiameterMm"]!;
    return [
      part("thread", "Threaded end", "cylinder", [0, 0, d * 0.7], [d, d, d * 1.4], color, trace),
      part("shoulder", "Precision shoulder", "cylinder", [0, 0, d * 1.4 + length / 2], [shoulder, shoulder, length], color, trace),
      part("head", "Socket head", "cylinder", [0, 0, d * 1.4 + length + values["headHeightMm"]! / 2], [values["headDiameterMm"]!, values["headDiameterMm"]!, values["headHeightMm"]!], color, trace),
      part("socket", "Hex socket", "hex-prism", [0, 0, d * 1.4 + length + values["headHeightMm"]! - 0.35], [values["socketWidthMm"]!, values["socketWidthMm"]!, 0.7], "#30363b", trace)
    ];
  }
  if (templateId === "hex-nut") return [
    part("nut", "Hex nut body", "hex-prism", [0, 0, values["nutHeightMm"]! / 2], [values["hexAcrossFlatsMm"]! * 1.15, values["hexAcrossFlatsMm"]! * 1.15, values["nutHeightMm"]!], color, trace),
    part("bore", "Thread bore indication", "cylinder", [0, 0, values["nutHeightMm"]! / 2 + 0.05], [d * 0.82, d * 0.82, values["nutHeightMm"]! + 0.1], "#30363b", trace)
  ];
  if (templateId === "flat-washer") return [part("washer", "Flat washer", "ring", [0, 0, values["washerThicknessMm"]! / 2], [values["washerOutsideDiameterMm"]!, values["washerInsideDiameterMm"]!, values["washerThicknessMm"]!], color, trace)];
  if (templateId === "deep-groove-ball-bearing") return bearingComponents(values, color, trace, false);
  if (templateId === "sleeve-bushing") return [part("sleeve", "Sleeve bushing", "ring", [0, 0, values["widthMm"]! / 2], [values["outsideDiameterMm"]!, values["boreMm"]!, values["widthMm"]!], color, trace)];
  if (templateId === "flanged-bushing") return [
    part("sleeve", "Bushing body", "ring", [0, 0, values["widthMm"]! / 2], [values["outsideDiameterMm"]!, values["boreMm"]!, values["widthMm"]!], color, trace),
    part("flange", "Locating flange", "ring", [0, 0, values["widthMm"]! + Math.max(1, values["widthMm"]! * 0.08)], [values["flangeDiameterMm"]!, values["boreMm"]!, Math.max(2, values["widthMm"]! * 0.16)], color, trace)
  ];
  if (templateId === "spur-gear") return [part("gear", "Spur gear", "gear", [0, 0, values["faceWidthMm"]! / 2], [values["outsideDiameterMm"]!, values["boreMm"]!, values["faceWidthMm"]!], color, trace, values["teeth"])];
  if (templateId === "roller-chain-sprocket") return [part("sprocket", "Chain sprocket", "gear", [0, 0, values["faceWidthMm"]! / 2], [values["outsideDiameterMm"]!, values["boreMm"]!, values["faceWidthMm"]!], color, trace, values["teeth"])];
  if (templateId === "roller-chain-link") {
    const pitch = values["pitchMm"]!; const wire = Math.max(1.2, values["rollerDiameterMm"]! * 0.35);
    return [part("link-a", "Chain link A", "torus", [-pitch * 0.34, 0, wire], [pitch, wire, wire], color, trace), part("link-b", "Chain link B", "torus", [pitch * 0.34, 0, wire * 1.8], [pitch, wire, wire], color, trace, undefined, [90, 0, 0])];
  }
  if (templateId === "timing-belt-pulley") {
    const width = values["faceWidthMm"]!; const outside = values["outsideDiameterMm"]!;
    return [
      part("pulley", "Timing pulley teeth", "gear", [0, 0, width / 2 + 1], [outside, values["boreMm"]!, width], color, trace, values["teeth"]),
      part("flange-a", "Lower flange", "ring", [0, 0, 0.75], [outside * 1.12, values["boreMm"]!, 1.5], color, trace),
      part("flange-b", "Upper flange", "ring", [0, 0, width + 1.25], [outside * 1.12, values["boreMm"]!, 1.5], color, trace)
    ];
  }
  if (templateId === "timing-belt-loop") {
    const pitchDiameter = values["pitchLengthMm"]! / Math.PI;
    const wall = Math.max(2, values["pitchMm"]! * 0.8);
    return [part("belt", "Closed belt envelope", "ring", [0, 0, values["faceWidthMm"]! / 2], [pitchDiameter + wall, pitchDiameter - wall, values["faceWidthMm"]!], color, trace)];
  }
  if (templateId === "o-ring") return [part("seal", "O-ring", "torus", [0, 0, values["crossSectionMm"]! / 2], [values["outsideDiameterMm"]!, values["crossSectionMm"]!, values["crossSectionMm"]!], color, trace)];
  if (templateId === "linear-bearing") return bearingComponents(values, color, trace, true);
  if (templateId === "linear-shaft") return [part("shaft", "Linear shaft", "cylinder", [0, 0, values["diameterMm"]! / 2], [values["diameterMm"]!, values["diameterMm"]!, values["lengthMm"]!], color, trace, undefined, [0, 90, 0])];
  if (templateId === "acme-lead-screw") return [
    part("screw", "Lead screw envelope", "cylinder", [0, 0, values["diameterMm"]! / 2], [values["diameterMm"]!, values["diameterMm"]!, values["lengthMm"]!], color, trace, undefined, [0, 90, 0]),
    ...[0.2, 0.4, 0.6, 0.8].map((fraction, index) => part(`lead-${index + 1}`, "Lead indication", "ring", [(fraction - 0.5) * values["lengthMm"]!, 0, values["diameterMm"]! / 2], [values["diameterMm"]! * 1.08, values["diameterMm"]! * 0.96, Math.max(0.5, values["leadMm"]! * 0.15)], "#d4d7d9", trace, undefined, [0, 90, 0]))
  ];
  if (templateId === "shaft-collar") return [
    part("collar", "Shaft collar", "ring", [0, 0, values["faceWidthMm"]! / 2], [values["outsideDiameterMm"]!, values["diameterMm"]!, values["faceWidthMm"]!], color, trace),
    part("clamp", "Clamp boss", "box", [values["outsideDiameterMm"]! * 0.45, 0, values["faceWidthMm"]! / 2], [values["diameterMm"]! * 0.55, values["diameterMm"]! * 0.45, values["faceWidthMm"]!], color, trace)
  ];
  if (templateId === "hydraulic-straight-fitting") return straightFitting(values, color, trace);
  if (templateId === "hydraulic-elbow-fitting") return elbowFitting(values, color, trace, "Hydraulic elbow");
  if (templateId === "tube-compression-union") return tubeUnion(values, color, trace);
  if (templateId === "tube-compression-elbow") return elbowFitting({ nominalMm: values["tubeOutsideDiameterMm"]!, threadDiameterMm: values["hexAcrossFlatsMm"]!, overallLengthMm: values["overallLengthMm"]! }, color, trace, "Compression elbow");
  if (templateId === "hex-key") {
    const key = values["acrossFlatsMm"]!; const long = values["lengthMm"]!; const short = Math.max(long * 0.32, key * 4);
    return [part("long-arm", "Long hex arm", "hex-prism", [0, 0, long / 2], [key * 1.15, key * 1.15, long], color, trace), part("short-arm", "Short hex arm", "hex-prism", [short / 2, 0, long], [key * 1.15, key * 1.15, short], color, trace, undefined, [0, 90, 0])];
  }
  const wrench = values["acrossFlatsMm"]!; const overall = values["lengthMm"]!;
  return [
    part("handle", "Wrench handle", "box", [0, 0, 2], [overall * 0.72, Math.max(5, wrench * 0.55), 4], color, trace),
    part("box-end", "Box end", "ring", [-overall * 0.43, 0, 2], [wrench * 2, wrench * 1.08, 4], color, trace),
    part("open-end", "Open end envelope", "hex-prism", [overall * 0.43, 0, 2], [wrench * 2.1, wrench * 2.1, 4], color, trace),
    part("jaw-gap", "Open jaw indication", "box", [overall * 0.48, 0, 4.05], [wrench * 1.3, wrench * 1.05, 0.2], "#30363b", trace)
  ];
}

function bearingComponents(values: Readonly<Record<string, number>>, color: string, trace: Omit<NonNullable<ComponentInstance["masterCart"]>, "role">, linear: boolean): readonly ComponentInstance[] {
  const bore = values["boreMm"]!; const outside = values["outsideDiameterMm"]!; const width = values["widthMm"]!;
  const outerInner = outside - (outside - bore) * 0.34;
  const innerOuter = bore + (outside - bore) * 0.25;
  const components: ComponentInstance[] = [
    part("outer-ring", linear ? "Linear bearing shell" : "Outer bearing ring", "ring", [0, 0, width / 2], [outside, outerInner, width], color, trace),
    part("inner-ring", linear ? "Linear bearing bore sleeve" : "Inner bearing ring", "ring", [0, 0, width / 2], [innerOuter, bore, width], "#c9cdd0", trace)
  ];
  if (linear) {
    components.push(part("seal-a", "End seal A", "ring", [0, 0, 0.8], [outside * 0.96, bore, 1.6], "#34393d", trace), part("seal-b", "End seal B", "ring", [0, 0, width - 0.8], [outside * 0.96, bore, 1.6], "#34393d", trace));
    return components;
  }
  const ballDiameter = Math.max(1, (outerInner - innerOuter) * 0.72);
  const radius = (outerInner + innerOuter) / 4;
  for (let index = 0; index < 10; index += 1) {
    const angle = index / 10 * Math.PI * 2;
    components.push(part(`ball-${index + 1}`, `Rolling element ${index + 1}`, "sphere", [Math.cos(angle) * radius, Math.sin(angle) * radius, width / 2], [ballDiameter, ballDiameter, ballDiameter], "#d7dadd", trace));
  }
  return components;
}

function straightFitting(values: Readonly<Record<string, number>>, color: string, trace: Omit<NonNullable<ComponentInstance["masterCart"]>, "role">): readonly ComponentInstance[] {
  const passage = values["nominalMm"]!; const thread = values["threadDiameterMm"]!; const length = values["overallLengthMm"]!;
  return [
    part("thread", "Threaded connection envelope", "cylinder", [0, 0, length * 0.2], [thread, thread, length * 0.4], color, trace),
    part("hex", "Wrench hex", "hex-prism", [0, 0, length * 0.5], [thread * 1.35, thread * 1.35, length * 0.22], color, trace),
    part("stem", "Hose stem", "cylinder", [0, 0, length * 0.76], [passage * 1.35, passage * 1.35, length * 0.3], color, trace)
  ];
}

function elbowFitting(values: Readonly<Record<string, number>>, color: string, trace: Omit<NonNullable<ComponentInstance["masterCart"]>, "role">, label: string): readonly ComponentInstance[] {
  const passage = values["nominalMm"]!; const thread = values["threadDiameterMm"]!; const length = values["overallLengthMm"]! * 0.62;
  return [
    part("leg-a", `${label} vertical leg`, "cylinder", [0, 0, length / 2], [thread, thread, length], color, trace),
    part("corner", `${label} corner`, "sphere", [0, 0, length], [thread, thread, thread], color, trace),
    part("leg-b", `${label} horizontal leg`, "cylinder", [length / 2, 0, length], [passage * 1.45, passage * 1.45, length], color, trace, undefined, [0, 90, 0]),
    part("hex", `${label} wrench hex`, "hex-prism", [0, 0, length * 0.32], [thread * 1.3, thread * 1.3, thread * 0.65], color, trace)
  ];
}

function tubeUnion(values: Readonly<Record<string, number>>, color: string, trace: Omit<NonNullable<ComponentInstance["masterCart"]>, "role">): readonly ComponentInstance[] {
  const tube = values["tubeOutsideDiameterMm"]!; const hex = values["hexAcrossFlatsMm"]!; const length = values["overallLengthMm"]!;
  return [
    part("body", "Union body", "cylinder", [0, 0, length / 2], [tube * 1.4, tube * 1.4, length * 0.45], color, trace),
    part("nut-a", "Compression nut A", "hex-prism", [0, 0, length * 0.18], [hex * 1.15, hex * 1.15, length * 0.28], color, trace),
    part("nut-b", "Compression nut B", "hex-prism", [0, 0, length * 0.82], [hex * 1.15, hex * 1.15, length * 0.28], color, trace)
  ];
}

function part(
  role: string,
  name: string,
  shape: ComponentShape,
  translationMm: Vec3,
  sizeMm: Vec3,
  color: string,
  trace: Omit<NonNullable<ComponentInstance["masterCart"]>, "role">,
  featureCount?: number,
  rotationDeg: Vec3 = [0, 0, 0]
): ComponentInstance {
  const safeRole = role.replace(/[^a-z0-9-]/gu, "-");
  return {
    id: `component:${trace.instanceId.split(":").at(-1)}-${safeRole}`,
    name,
    shape,
    grounded: false,
    visible: true,
    color,
    translationMm,
    rotationDeg,
    sizeMm,
    explosionDirection: [0, 0, 0.35],
    ...(featureCount === undefined ? {} : { featureCount }),
    masterCart: { ...trace, role }
  };
}

function template(
  id: MasterCartTemplateId,
  categoryId: MasterCartCategoryId,
  name: string,
  family: string,
  icon: string,
  description: string,
  standardBasis: string,
  sourceUrl: string,
  sizeOptions: readonly MasterCartSizeOption[],
  defaultSizeId: string,
  materialOptions: readonly MasterCartChoice[],
  defaultMaterialId: string,
  finishOptions: readonly MasterCartChoice[],
  defaultFinishId: string,
  editableFields: readonly MasterCartEditableField[],
  dimensions: readonly MasterCartDimensionDefinition[]
): MasterCartTemplate {
  return { id, categoryId, name, family, icon, description, standardBasis, sourceUrl, sizeOptions, defaultSizeId, materialOptions, defaultMaterialId, finishOptions, defaultFinishId, editableFields, dimensions };
}

function thread(id: string, label: string, system: MasterCartUnitSystem, diameterMm: number, pitchMm: number): MasterCartSizeOption {
  return size(id, label, system, { diameterMm, pitchMm });
}

function envelope(id: string, label: string, system: MasterCartUnitSystem, boreMm: number, outsideDiameterMm: number, widthMm: number): MasterCartSizeOption {
  return size(id, label, system, { boreMm, outsideDiameterMm, widthMm });
}

function size(id: string, label: string, system: MasterCartUnitSystem, values: Readonly<Record<string, number>>): MasterCartSizeOption {
  return { id, label, system, values };
}

function field(id: string, label: string, unit: MasterCartEditableField["unit"], minimum: number, maximum: number, step: number, defaultValue: number): MasterCartEditableField {
  return { id, label, unit, minimum, maximum, step, defaultValue };
}

function dim(key: string, symbol: string, label: string): MasterCartDimensionDefinition {
  return { key, symbol, label, unit: "mm" };
}

function dimCount(key: string, symbol: string, label: string): MasterCartDimensionDefinition {
  return { key, symbol, label, unit: "count" };
}

function format(value: number): string {
  return Number(value.toFixed(3)).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
