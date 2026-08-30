import type { CapabilityLevel, WorkspaceId } from "./types.js";

export const ENGINEERING_INTENT_SCHEMA = "ps3d-engineering-intent-plan/1" as const;

export type EngineeringIntentScope = "part" | "assembly" | "part-and-assembly" | "drawing";
export type EngineeringPlanStatus = "needs-input" | "partially-plannable" | "ready-for-review";
export type EngineeringItemKind = "manufactured-part" | "standard-part" | "subassembly";
export type EngineeringPartClassification =
  | "prismatic-profile"
  | "extruded-profile"
  | "revolved-profile"
  | "machined-prismatic"
  | "sheet-metal"
  | "surface-driven"
  | "standard-purchased"
  | "custom";
export type EngineeringQuestionBoundary = "geometry" | "assembly" | "release";
export type EngineeringTargetCad = "ps3d" | "fusion-360" | "solidworks" | "nx" | "creo" | "catia-v5";
export type EngineeringPortabilityLevel = "native-editable" | "editable-approximation" | "positioned-assembly" | "geometry-fallback" | "unsupported";

export interface EngineeringIntentRequest {
  readonly request: string;
  readonly unit?: "mm" | "in";
  readonly workspace?: WorkspaceId;
  readonly experienceLevel?: "child" | "beginner" | "engineer" | "advanced" | "phd";
  readonly projectRevision?: number;
  readonly targetCad?: readonly EngineeringTargetCad[];
  readonly evidence?: readonly string[];
}

export interface EngineeringDimensionFact {
  readonly id: string;
  readonly label: string;
  readonly valueMm: number;
  readonly sourceValue: number;
  readonly sourceUnit: "mm" | "in";
  readonly sourceText: string;
  readonly status: "stated-by-user";
}

export interface EngineeringQuestion {
  readonly id: string;
  readonly code: string;
  readonly blocks: EngineeringQuestionBoundary;
  readonly prompt: string;
  readonly reason: string;
  readonly acceptedEvidence: readonly string[];
  readonly relatedDefinitionIds: readonly string[];
}

export interface EngineeringFeaturePlan {
  readonly id: string;
  readonly order: number;
  readonly kind: string;
  readonly purpose: string;
  readonly constructionMethod: string;
  readonly semanticReferences: readonly string[];
  readonly ps3dCapability: CapabilityLevel;
  readonly executionRoute: string | null;
  readonly portabilityIntent: EngineeringPortabilityLevel;
}

export interface EngineeringPartDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind: Exclude<EngineeringItemKind, "subassembly">;
  readonly classification: EngineeringPartClassification;
  readonly quantity: number | null;
  readonly quantityStatus: "stated" | "proposed" | "missing";
  readonly reuseKey: string;
  readonly reusePolicy: string;
  readonly baseStrategy: string;
  readonly dimensions: readonly EngineeringDimensionFact[];
  readonly features: readonly EngineeringFeaturePlan[];
  readonly interfaces: readonly string[];
  readonly governingReference: string | null;
  readonly definitionStatus: "blocked" | "planned" | "standard-evidence-required";
}

export interface EngineeringMatePlan {
  readonly id: string;
  readonly childDefinitionIds: readonly string[];
  readonly intent: string;
  readonly referenceStrategy: string;
  readonly ps3dCapability: CapabilityLevel;
  readonly status: "needs-interface-input" | "planned";
}

export interface EngineeringAssemblyPackage {
  readonly id: string;
  readonly name: string;
  readonly sequence: number;
  readonly source: "user-request" | "planner-proposal";
  readonly dependencyPackageIds: readonly string[];
  readonly childDefinitionIds: readonly string[];
  readonly occurrenceCount: number | null;
  readonly mates: readonly EngineeringMatePlan[];
  readonly status: "blocked" | "ready-for-review";
  readonly approvalGate: string;
}

export interface EngineeringPortabilityAssessment {
  readonly target: EngineeringTargetCad;
  readonly level: EngineeringPortabilityLevel;
  readonly reason: string;
  readonly generatedPackageAvailable: boolean;
}

export interface EngineeringIntentPlan {
  readonly schema: typeof ENGINEERING_INTENT_SCHEMA;
  readonly planId: string;
  readonly input: {
    readonly request: string;
    readonly unit: "mm" | "in";
    readonly workspace: WorkspaceId | null;
    readonly projectRevision: number | null;
  };
  readonly interpretation: {
    readonly scope: EngineeringIntentScope;
    readonly primaryObject: string;
    readonly confidence: number;
    readonly method: "deterministic-engineering-intent-compiler";
    readonly executionPerformed: false;
  };
  readonly status: EngineeringPlanStatus;
  readonly dimensionFacts: readonly EngineeringDimensionFact[];
  readonly partDefinitions: readonly EngineeringPartDefinition[];
  readonly commonDefinitionIds: readonly string[];
  readonly assemblyPackages: readonly EngineeringAssemblyPackage[];
  readonly questions: readonly EngineeringQuestion[];
  readonly warnings: readonly string[];
  readonly execution: {
    readonly canCreateCandidateNow: boolean;
    readonly planningOnly: true;
    readonly blockedByQuestionIds: readonly string[];
    readonly unavailableFeatureIds: readonly string[];
    readonly requiredSequence: readonly string[];
    readonly nextAction: string;
  };
  readonly portability: readonly EngineeringPortabilityAssessment[];
}

interface PartPattern {
  readonly key: string;
  readonly name: string;
  readonly expression: RegExp;
  readonly kind: Exclude<EngineeringItemKind, "subassembly">;
  readonly classification: EngineeringPartClassification;
  readonly baseStrategy: string;
  readonly interfaceHint: string;
  readonly standardFamily: string | null;
}

interface FeaturePattern {
  readonly kind: string;
  readonly expression: RegExp;
  readonly order: number;
  readonly purpose: string;
  readonly method: string;
  readonly references: readonly string[];
  readonly capability: CapabilityLevel;
  readonly route: string | null;
  readonly portability: EngineeringPortabilityLevel;
}

const PART_PATTERNS: readonly PartPattern[] = [
  partPattern("corner-fitting", "Container corner fitting", /\b(?:container\s+)?corner\s+(?:blocks?|castings?|fittings?)\b/u, "standard-part", "standard-purchased", "Insert an approved standard or supplier definition; do not reverse-engineer a placeholder.", "Three orthogonal mounting interfaces and certified load-path references", "ISO container corner fitting"),
  partPattern("side-rail", "Side rail", /\b(?:side|longitudinal)\s+rails?\b/u, "manufactured-part", "prismatic-profile", "Create the approved section as concentric closed sketch loops, then extrude to the controlled member length.", "End planes, member centerline, and outward section faces", null),
  partPattern("cross-member", "Cross-member", /\bcross[ -]?members?\b/u, "manufactured-part", "prismatic-profile", "Create one reusable section-driven definition and control every occurrence from one length parameter.", "End planes, member centerline, and top support face", null),
  partPattern("top-rail", "Top rail", /\btop\s+rails?\b/u, "manufactured-part", "prismatic-profile", "Create the approved section and extrude it from a stable end datum.", "End planes and roof-side interface", null),
  partPattern("post", "Structural post", /\b(?:corner|vertical|structural)?\s*posts?\b/u, "manufactured-part", "prismatic-profile", "Create the approved section and extrude it along the local member axis.", "End planes and member centerline", null),
  partPattern("tube", "Tube or hollow section", /\b(?:rhs|shs|hollow\s+section|rectangular\s+tube|square\s+tube|tubes?)\b/u, "manufactured-part", "prismatic-profile", "Sketch outer and inner closed profiles with wall thickness, constrain them, then extrude to length.", "End planes, section centerline, and outer faces", null),
  partPattern("plate", "Plate", /\b(?:mounting\s+)?plates?\b/u, "manufactured-part", "extruded-profile", "Sketch the primary outline on a datum plane and extrude the controlled thickness.", "Primary face, opposite face, perimeter, and datum axes", null),
  partPattern("bracket", "Bracket", /\bbrackets?\b/u, "manufactured-part", "machined-prismatic", "Create the load-bearing base profile first, then add or remove material from stable datum faces.", "Mounting face, locating holes, and load interface", null),
  partPattern("gusset", "Gusset", /\bgussets?\b/u, "manufactured-part", "extruded-profile", "Sketch the bounded support profile and extrude its thickness before edge finishing.", "Attachment edges and support face", null),
  partPattern("shaft", "Shaft or axle", /\b(?:shafts?|axles?)\b/u, "manufactured-part", "revolved-profile", "Sketch the axial half-section with diameters and shoulders, then revolve about a named centerline.", "Axis, shoulders, end faces, and bearing seats", null),
  partPattern("pin", "Pin", /\bpins?\b/u, "manufactured-part", "revolved-profile", "Sketch a controlled axial section and revolve about the pin axis.", "Axis and end faces", null),
  partPattern("housing", "Housing or manifold", /\b(?:housings?|manifolds?)\b/u, "manufactured-part", "machined-prismatic", "Create a datum-driven base volume, then machine pockets, bores, and interfaces in dependency order.", "Mounting datum, bore axes, sealing faces, and ports", null),
  partPattern("panel", "Panel or cover", /\b(?:panels?|covers?|enclosures?)\b/u, "manufactured-part", "sheet-metal", "Create the flat boundary and thickness, then add bends, cutouts, and formed details from stable datums.", "Mounting plane, bend lines, and perimeter", null),
  partPattern("bearing", "Bearing", /\bbearings?\b/u, "standard-part", "standard-purchased", "Insert an approved catalog definition using bore, outside diameter, width, clearance, and load-rating evidence.", "Bearing axis, midplane, and locating shoulders", "Bearing designation and supplier data"),
  partPattern("bushing", "Bushing", /\bbush(?:ing|ings|es)?\b/u, "standard-part", "standard-purchased", "Insert an approved catalog or drawing-controlled definition.", "Bore axis, flange face, and press-fit surface", "Bushing designation and supplier data"),
  partPattern("fastener", "Fastener", /\b(?:bolts?|screws?|fasteners?|studs?|nuts?|washers?)\b/u, "standard-part", "standard-purchased", "Select a standard, size, property class, material, finish, and engagement rule before insertion.", "Fastener axis, seating face, and thread engagement", "Fastener standard and edition"),
  partPattern("seal", "Seal or O-ring", /\b(?:o[ -]?rings?|seals?)\b/u, "standard-part", "standard-purchased", "Select a standard size and material from approved sealing requirements.", "Seal centerline, gland surfaces, and squeeze direction", "Seal standard and material specification"),
  partPattern("gear", "Gear or sprocket", /\b(?:gears?|sprockets?)\b/u, "standard-part", "standard-purchased", "Select tooth system, module or pitch, tooth count, bore, hub, material, and quality grade.", "Rotation axis, pitch reference, and mounting face", "Power-transmission standard or approved drawing"),
  partPattern("chain-belt", "Chain or belt", /\b(?:chains?|timing\s+belts?|belts?)\b/u, "standard-part", "standard-purchased", "Select the approved pitch/profile, length, width or strand count, and supplier definition.", "Pitch path and engaged sprocket or pulley references", "Power-transmission standard or supplier definition"),
  partPattern("fitting", "Hose or tube fitting", /\b(?:(?:hydraulic\s+)?hose|tube)\s+fittings?\b/u, "standard-part", "standard-purchased", "Select end standards, nominal size, pressure class, material, seal, and approved supplier definition.", "Port axes, seating faces, and clocking datum", "Fluid fitting standard and supplier definition"),
  partPattern("wheel", "Wheel or tire", /\b(?:wheels?|tires?|tyres?)\b/u, "standard-part", "standard-purchased", "Use an approved wheel/tire envelope or drawing with load, speed, rim, and interface evidence.", "Rotation axis, center plane, hub interface, and rolling radius", "Wheel/tire drawing and rating evidence"),
  partPattern("motor", "Motor or actuator", /\b(?:motors?|actuators?|gearboxes?)\b/u, "standard-part", "standard-purchased", "Insert an approved supplier envelope with shaft, mounting, mass, thermal, and rating data.", "Output axis, mounting face, connector locations, and CG", "Supplier model and data sheet"),
  partPattern("battery", "Battery module", /\b(?:battery|batteries|modules?|packs?)\b/u, "standard-part", "standard-purchased", "Insert an approved supplier envelope with interfaces, mass, CG, electrical ratings, and safety boundaries.", "Mounting datums, connector locations, service envelope, and CG", "Supplier model, data sheet, and safety specification")
] as const;

const FEATURE_PATTERNS: readonly FeaturePattern[] = [
  featurePattern("pocket", /\b(?:pockets?|cavities?|recess(?:es)?|cutouts?)\b/u, 30, "Remove a bounded internal volume.", "Sketch the closed removal profile on a stable datum face and use a controlled cut extent.", ["support face", "closed cut profile"], "unavailable", null, "unsupported"),
  featurePattern("slot", /\bslots?\b/u, 32, "Create an elongated controlled opening.", "Drive the slot from centerline, width, end-radius, and locating dimensions; cut from a named face.", ["slot centerline", "support face"], "unavailable", null, "unsupported"),
  featurePattern("hole", /\b(?:holes?|bores?|drill(?:ed|ing)?)\b/u, 40, "Create a located circular opening.", "Locate the hole center from datums, then control diameter, extent, countersink/counterbore, and thread intent.", ["hole axis", "support face", "locating datums"], "preview", "ps3d_preview_operation:add-sketch-entity + set-sketch-dimension; qualified solid removal remains limited to the bounded centered-bore route", "editable-approximation"),
  featurePattern("thread", /\bthreads?|tapped|tapping\b/u, 44, "Create or annotate a threaded interface.", "Use designation, class, depth, handedness, and cosmetic-versus-modeled policy from an approved standard.", ["hole or shaft axis", "thread start face"], "unavailable", null, "unsupported"),
  featurePattern("linear-pattern", /\b(?:linear\s+)?patterns?|arrays?|equally\s+spaced\b/u, 50, "Reuse one seed feature with controlled count and spacing.", "Pattern a stable seed feature along a named direction; never duplicate fragile face selections.", ["seed feature", "pattern direction", "spacing parameter"], "preview", "ps3d_preview_operation:set-part-parameter(patternCount)", "editable-approximation"),
  featurePattern("mirror", /\bmirrors?|symmetric(?:al|ally)?\b/u, 52, "Reuse geometry across a stable symmetry datum.", "Mirror the selected feature or body about a named construction plane.", ["seed feature or body", "symmetry plane"], "unavailable", null, "unsupported"),
  featurePattern("rib", /\bribs?\b/u, 55, "Add a thin reinforcing feature.", "Drive the rib from an open sketch, thickness direction, extent, and merge intent.", ["rib center sketch", "support faces"], "unavailable", null, "unsupported"),
  featurePattern("draft", /\bdrafts?|draft\s+angle\b/u, 60, "Apply a manufacturing pull angle.", "Select a neutral plane or parting reference and direction before applying the angle.", ["neutral plane", "pull direction", "draft faces"], "unavailable", null, "unsupported"),
  featurePattern("shell", /\bshells?|hollow(?:ing)?\b/u, 62, "Create controlled wall thickness.", "Choose removable faces, inward/outward policy, wall thickness, and corner treatment.", ["body", "removed faces"], "unavailable", null, "unsupported"),
  featurePattern("chamfer", /\bchamfers?|bevels?\b/u, 70, "Break a selected edge with a controlled bevel.", "Reference semantic edges and use distance-angle or equal-distance definition.", ["semantic edge", "adjacent faces"], "preview", "ps3d_preview_operation:set-part-parameter(edgeTreatmentMm)", "editable-approximation"),
  featurePattern("fillet", /\bfillets?|blends?|rounds?\b/u, 72, "Apply controlled edge radii after functional features.", "Reference semantic edges and verify tangent propagation and minimum local thickness.", ["semantic edge chain", "adjacent faces"], "preview", "ps3d_preview_operation:set-part-parameter(edgeTreatmentMm)", "editable-approximation"),
  featurePattern("split-trim", /\b(?:split|trim|divide)\s+(?:body|face|geometry)\b/u, 75, "Partition or remove geometry using a controlled tool.", "Use an explicit plane, surface, or body tool and preserve both-result policy.", ["target body", "splitting tool"], "unavailable", null, "unsupported"),
  featurePattern("boolean", /\b(?:unite|union|join|subtract|intersect|combine)\b/u, 76, "Combine bodies with explicit Boolean intent.", "Validate body overlap and preserve new-body, join, cut, or intersect intent.", ["target body", "tool body"], "unavailable", null, "unsupported")
] as const;

const ASSEMBLY_PACKAGE_PATTERNS = [
  { key: "bottom", name: "Bottom assembly", expression: /\b(?:bottom|base|floor)\s+(?:frame\s+)?assembly\b|\bbottom\s+frame\b/u },
  { key: "left-side", name: "Left-side assembly", expression: /\bleft[ -]?side\s+(?:frame\s+)?assembly\b/u },
  { key: "right-side", name: "Right-side assembly", expression: /\bright[ -]?side\s+(?:frame\s+)?assembly\b/u },
  { key: "side", name: "Side assembly", expression: /\bside\s+(?:frame\s+)?assembly\b/u },
  { key: "top", name: "Top assembly", expression: /\b(?:top|roof)\s+(?:frame\s+)?assembly\b|\broof\s+frame\b/u },
  { key: "front", name: "Front assembly", expression: /\bfront\s+(?:end\s+)?assembly\b/u },
  { key: "rear", name: "Rear assembly", expression: /\brear\s+(?:end\s+)?assembly\b/u },
  { key: "inner", name: "Inner structure assembly", expression: /\b(?:inner|internal)\s+(?:structure\s+)?assembly\b/u },
  { key: "final", name: "Final integration assembly", expression: /\b(?:final|main|complete)\s+assembly\b/u }
] as const;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, sixteen: 16, twenty: 20
};

const MATERIAL_EXPRESSION = /\b(?:steel|stainless|aluminium|aluminum|titanium|brass|bronze|copper|plastic|polymer|composite|rubber|cast\s+iron)\b/u;
const STANDARD_EXPRESSION = /\b(?:iso|din|jis|asme|astm|iec|en)\s*[- ]?\d+(?:[-:]\d+)*(?::\d{4})?\b/iu;

export function planEngineeringIntent(input: EngineeringIntentRequest): EngineeringIntentPlan {
  const request = input.request.trim();
  const normalized = normalize(request);
  const unit = input.unit ?? inferUnit(normalized) ?? "mm";
  const scope = inferScope(normalized, input.workspace);
  const dimensions = extractDimensions(request, unit);
  const matchedParts = matchPartDefinitions(normalized, dimensions, scope, input.evidence ?? []);
  const partDefinitions = matchedParts.length > 0
    ? matchedParts
    : [createFallbackDefinition(normalized, dimensions, scope)];
  const questions = buildQuestions(normalized, unit, scope, partDefinitions, dimensions, input.evidence ?? []);
  const assemblyPackages = buildAssemblyPackages(normalized, scope, partDefinitions, questions);
  const unavailableFeatureIds = partDefinitions.flatMap((part) => part.features.filter((feature) => feature.ps3dCapability === "unavailable").map((feature) => feature.id));
  const blockedByQuestionIds = questions.filter((question) => question.blocks !== "release").map((question) => question.id);
  const status: EngineeringPlanStatus = blockedByQuestionIds.length > 0
    ? "needs-input"
    : unavailableFeatureIds.length > 0 ? "partially-plannable" : "ready-for-review";
  const targets: readonly EngineeringTargetCad[] = unique(input.targetCad === undefined || input.targetCad.length === 0 ? ["ps3d" as const] : input.targetCad);
  const confidence = intentConfidence(scope, partDefinitions, dimensions, questions);
  const primaryObject = inferPrimaryObject(scope, partDefinitions, normalized);
  const planId = `engineering-plan:${stableHash(`${normalized}|${unit}|${input.projectRevision ?? "none"}|${targets.join(",")}`)}`;
  const canCreateCandidateNow = status === "ready-for-review" && unavailableFeatureIds.length === 0;
  const nextAction = firstNextAction(questions, assemblyPackages, partDefinitions, unavailableFeatureIds);
  return {
    schema: ENGINEERING_INTENT_SCHEMA,
    planId,
    input: {
      request,
      unit,
      workspace: input.workspace ?? null,
      projectRevision: input.projectRevision ?? null
    },
    interpretation: {
      scope,
      primaryObject,
      confidence,
      method: "deterministic-engineering-intent-compiler",
      executionPerformed: false
    },
    status,
    dimensionFacts: dimensions,
    partDefinitions,
    commonDefinitionIds: partDefinitions.filter((part) => (part.quantity ?? 0) > 1).map((part) => part.id),
    assemblyPackages,
    questions,
    warnings: buildWarnings(normalized, partDefinitions, unavailableFeatureIds),
    execution: {
      canCreateCandidateNow,
      planningOnly: true,
      blockedByQuestionIds,
      unavailableFeatureIds,
      requiredSequence: [
        "Resolve geometry- and assembly-blocking questions",
        "Review one reusable child definition and its ordered feature history at a time",
        "Preview and approve one complete subassembly package at a time",
        "Integrate approved subassemblies into the final assembly",
        "Run design health and drawing/release checks before export"
      ],
      nextAction
    },
    portability: targets.map((target) => assessPortability(target, scope, partDefinitions, unavailableFeatureIds))
  };
}

function partPattern(
  key: string,
  name: string,
  expression: RegExp,
  kind: PartPattern["kind"],
  classification: EngineeringPartClassification,
  baseStrategy: string,
  interfaceHint: string,
  standardFamily: string | null
): PartPattern {
  return { key, name, expression, kind, classification, baseStrategy, interfaceHint, standardFamily };
}

function featurePattern(
  kind: string,
  expression: RegExp,
  order: number,
  purpose: string,
  method: string,
  references: readonly string[],
  capability: CapabilityLevel,
  route: string | null,
  portability: EngineeringPortabilityLevel
): FeaturePattern {
  return { kind, expression, order, purpose, method, references, capability, route, portability };
}

function inferScope(normalized: string, workspace?: WorkspaceId): EngineeringIntentScope {
  const drawing = /\b(?:drawing|drafting|sheet|gdt|gd&t)\b/u.test(normalized) || workspace === "drawing";
  const assembly = /\b(?:assembly|assemble|container|frame|chassis|machine|system|rack|vehicle|product)\b/u.test(normalized) || workspace === "assembly";
  const part = /\b(?:part|component|plate|bracket|tube|shaft|housing|panel|gear|bearing)\b/u.test(normalized) || workspace === "part" || workspace === "sketch";
  if (drawing && !assembly && !part) return "drawing";
  if (assembly && part) return "part-and-assembly";
  return assembly ? "assembly" : "part";
}

function matchPartDefinitions(
  normalized: string,
  dimensions: readonly EngineeringDimensionFact[],
  scope: EngineeringIntentScope,
  evidence: readonly string[]
): readonly EngineeringPartDefinition[] {
  const definitions: EngineeringPartDefinition[] = [];
  for (const pattern of PART_PATTERNS) {
    const match = normalized.match(pattern.expression);
    if (match?.index === undefined) continue;
    const statedQuantity = quantityBefore(normalized, match.index);
    const quantity = statedQuantity ?? (scope === "part" ? 1 : null);
    const standardReference = pattern.kind === "standard-part" ? standardReferenceNear(normalized, match.index) : null;
    const relatedEvidence = evidence.filter((item) => {
      const normalizedItem = normalize(item);
      return pattern.key.split("-").some((term) => term.length >= 4 && normalizedItem.includes(term));
    });
    const features = pattern.kind === "standard-part" ? [] : buildFeaturePlan(normalized, pattern.classification, pattern.key);
    const id = `definition:${pattern.key}`;
    definitions.push({
      id,
      name: pattern.name,
      kind: pattern.kind,
      classification: pattern.classification,
      quantity,
      quantityStatus: statedQuantity !== null ? "stated" : scope === "part" ? "proposed" : "missing",
      reuseKey: `${pattern.classification}:${pattern.key}:${dimensionSignature(dimensions)}`,
      reusePolicy: "Create one definition and reuse it only when section, material, dimensions, interfaces, and feature fingerprint are identical.",
      baseStrategy: pattern.baseStrategy,
      dimensions,
      features,
      interfaces: [pattern.interfaceHint],
      governingReference: standardReference,
      definitionStatus: pattern.kind === "standard-part" && !hasEditionOrEvidence(standardReference, relatedEvidence)
        ? "standard-evidence-required"
        : features.some((feature) => feature.ps3dCapability === "unavailable") ? "blocked" : "planned"
    });
  }
  return definitions;
}

function createFallbackDefinition(normalized: string, dimensions: readonly EngineeringDimensionFact[], scope: EngineeringIntentScope): EngineeringPartDefinition {
  const classification = inferFallbackClassification(normalized);
  const name = inferFallbackName(normalized, scope, classification);
  const features = buildFeaturePlan(normalized, classification, "primary");
  return {
    id: "definition:primary",
    name,
    kind: "manufactured-part",
    classification,
    quantity: scope === "part" ? 1 : null,
    quantityStatus: scope === "part" ? "proposed" : "missing",
    reuseKey: `${classification}:primary:${dimensionSignature(dimensions)}`,
    reusePolicy: "Create one controlled definition; create a derived definition instead of reusing it when any geometry, interface, material, or feature differs.",
    baseStrategy: baseStrategyFor(classification),
    dimensions,
    features,
    interfaces: ["Define functional mounting, locating, load, motion, sealing, and service interfaces before assembly placement."],
    governingReference: null,
    definitionStatus: dimensions.length === 0 || features.some((feature) => feature.ps3dCapability === "unavailable") ? "blocked" : "planned"
  };
}

function inferFallbackClassification(normalized: string): EngineeringPartClassification {
  if (/\b(?:fairing|canopy|surface|loft|sweep|organic)\b/u.test(normalized)) return "surface-driven";
  if (/\b(?:sheet\s+metal|bent|bend|flange)\b/u.test(normalized)) return "sheet-metal";
  if (/\b(?:shaft|axisymmetric|turned|lathe|revolve)\b/u.test(normalized)) return "revolved-profile";
  if (/\b(?:block|pocket|machined|milled)\b/u.test(normalized)) return "machined-prismatic";
  if (/\b(?:tube|pipe|channel|angle|beam|profile)\b/u.test(normalized)) return "prismatic-profile";
  if (/\b(?:plate|bracket|extrude)\b/u.test(normalized)) return "extruded-profile";
  return "custom";
}

function inferFallbackName(normalized: string, scope: EngineeringIntentScope, classification: EngineeringPartClassification): string {
  if (scope === "assembly" || scope === "part-and-assembly") return "Unresolved child definition";
  const labels: Readonly<Record<EngineeringPartClassification, string>> = {
    "prismatic-profile": "Profile-driven part",
    "extruded-profile": "Extruded part",
    "revolved-profile": "Revolved part",
    "machined-prismatic": "Machined part",
    "sheet-metal": "Sheet-metal part",
    "surface-driven": "Surface-driven part",
    "standard-purchased": "Standard part",
    custom: /\bpart\b/u.test(normalized) ? "Requested part" : "Custom part"
  };
  return labels[classification];
}

function baseStrategyFor(classification: EngineeringPartClassification): string {
  const strategies: Readonly<Record<EngineeringPartClassification, string>> = {
    "prismatic-profile": "Constrain a closed section sketch and extrude it along a named member axis.",
    "extruded-profile": "Constrain the dominant outline on the datum that exposes the most design intent, then extrude thickness or depth.",
    "revolved-profile": "Constrain an axial half-section and revolve it about a named construction axis.",
    "machined-prismatic": "Create the simplest enclosing datum-driven volume, then add and remove material by functional interface.",
    "sheet-metal": "Create the base face and thickness, then add bends, flanges, and cutouts while preserving flat-pattern intent.",
    "surface-driven": "Build and validate section/guide curves, create controlled surfaces, then trim, join, and thicken only when supported.",
    "standard-purchased": "Use an approved standard or supplier definition.",
    custom: "Identify the dominant manufacturing envelope and functional datums before selecting a base feature."
  };
  return strategies[classification];
}

function buildFeaturePlan(normalized: string, classification: EngineeringPartClassification, ownerKey: string): readonly EngineeringFeaturePlan[] {
  const features: EngineeringFeaturePlan[] = [];
  pushFeature(features, ownerKey, "datum", 5, "Create stable local WCS, origin, principal datums, and named functional references.", "Select datums from function and manufacturing setup; never use transient screen orientation.", ["local WCS", "principal datum planes"], "preview", null, "native-editable");
  pushFeature(features, ownerKey, "sketch", 10, "Capture the controlled base profile with driving dimensions and constraints.", "Choose the view with the clearest profile, use closed regions for solids, and fully constrain intentional degrees of freedom.", ["datum plane", "origin", "construction axes"], "preview", "ps3d_preview_operation:add-sketch-entity + add-sketch-constraint + set-sketch-dimension", "native-editable");
  if (classification === "revolved-profile") {
    pushFeature(features, ownerKey, "revolve", 20, "Create the axisymmetric base body.", "Revolve the closed axial profile around its named construction centerline.", ["base sketch", "revolve axis"], "preview", "ps3d_preview_operation:set-part-parameter(revolveAngleDeg)", "editable-approximation");
  } else if (classification === "surface-driven") {
    pushFeature(features, ownerKey, "loft-surface", 20, "Create the primary controlled surface.", "Use ordered section curves, explicit guide continuity, and surface-quality checks before trim or thicken.", ["section sketches", "guide curves"], "preview", "ps3d_preview_operation:set-surface-mode", "editable-approximation");
  } else if (classification === "sheet-metal") {
    pushFeature(features, ownerKey, "sheet-base", 20, "Create the primary sheet-metal base.", "Control thickness, bend allowance, bend radius, and stationary face from an approved rule.", ["base sketch", "sheet-metal rule"], "unavailable", null, "unsupported");
  } else {
    pushFeature(features, ownerKey, "extrude", 20, "Create the primary prismatic body.", "Extrude the closed base region with explicit new-body, join, cut, or intersect intent.", ["base sketch region", "start and end conditions"], "preview", "ps3d_preview_operation:set-part-parameter; qualified geometry remains limited to the bounded PS3D part envelope", "editable-approximation");
  }
  for (const pattern of FEATURE_PATTERNS) {
    if (!pattern.expression.test(normalized)) continue;
    pushFeature(features, ownerKey, pattern.kind, pattern.order, pattern.purpose, pattern.method, pattern.references, pattern.capability, pattern.route, pattern.portability);
  }
  if (/\b(?:two|three|four|five|six|\d+)\s+(?:identical\s+)?(?:(?:diameter|dia|ø|⌀)\s*\d+(?:\.\d+)?\s*(?:mm|in)?\s*)?holes?\b/u.test(normalized) && !features.some((feature) => feature.kind === "linear-pattern")) {
    pushFeature(features, ownerKey, "linear-pattern", 50, "Reuse one validated hole definition for the stated count.", "Pattern the seed hole from a stable axis or direction and control end conditions or spacing explicitly.", ["seed hole", "pattern direction", "count and spacing"], "preview", "ps3d_preview_operation:set-part-parameter(patternCount)", "editable-approximation");
  }
  pushFeature(features, ownerKey, "verify", 95, "Verify rebuild, body count, dimensions, mass-property inputs, clearances, and feature references.", "Rebuild after each dependency package; compare measured results with stated requirements and evidence.", ["completed definition", "acceptance criteria"], "preview", "ps3d_design_health", "native-editable");
  return features.sort((left, right) => left.order - right.order || left.kind.localeCompare(right.kind));
}

function pushFeature(
  features: EngineeringFeaturePlan[], ownerKey: string, kind: string, order: number, purpose: string, constructionMethod: string,
  semanticReferences: readonly string[], ps3dCapability: CapabilityLevel, executionRoute: string | null, portabilityIntent: EngineeringPortabilityLevel
): void {
  if (features.some((feature) => feature.kind === kind)) return;
  features.push({ id: `feature:${ownerKey}:${kind}`, order, kind, purpose, constructionMethod, semanticReferences, ps3dCapability, executionRoute, portabilityIntent });
}

function buildQuestions(
  normalized: string,
  unit: "mm" | "in",
  scope: EngineeringIntentScope,
  parts: readonly EngineeringPartDefinition[],
  dimensions: readonly EngineeringDimensionFact[],
  evidence: readonly string[]
): readonly EngineeringQuestion[] {
  const questions: EngineeringQuestion[] = [];
  const add = (question: EngineeringQuestion): void => {
    if (!questions.some((entry) => entry.id === question.id)) questions.push(question);
  };
  if (dimensions.length === 0 && parts.some((part) => part.kind === "manufactured-part")) {
    add(question("dimensions", "PRIMARY_DIMENSIONS_REQUIRED", "geometry", `Provide the controlling dimensions in ${unit}, including the base envelope, wall/thickness, feature sizes, and feature locations.`, "No manufactured definition can be executed from an unscaled shape description.", ["dimensioned drawing", "dimensioned sketch", "approved parameter table"], parts.filter((part) => part.kind === "manufactured-part").map((part) => part.id)));
  }
  const unresolvedDefinitions = parts.filter((part) => part.classification === "custom" || part.name === "Unresolved child definition");
  if (unresolvedDefinitions.length > 0) {
    add(question("design-definition", "DESIGN_DEFINITION_REQUIRED", "geometry", "Define the dominant base shape and manufacturing approach, then provide dimensioned orthographic sections or an approved reference model for each unresolved part.", "An envelope or unfamiliar part name does not establish its profiles, topology, functional interfaces, or ordered features.", ["dimensioned multi-view drawing", "approved reference CAD", "section and detail sketches", "manufacturing and interface definition"], unresolvedDefinitions.map((part) => part.id)));
  }
  const manufactured = parts.filter((part) => part.kind === "manufactured-part");
  if (manufactured.length > 1 && dimensions.length > 0) {
    add(question("dimension-ownership", "DIMENSION_OWNERSHIP_REQUIRED", "geometry", "Assign every stated dimension to a named child definition, feature, interface, or assembly offset.", "One unscoped dimension list cannot safely drive several different child definitions.", ["part-numbered dimension table", "dimensioned child drawings", "parameter-to-definition mapping"], manufactured.map((part) => part.id)));
  }
  for (const part of parts.filter((entry) => entry.kind === "standard-part")) {
    const evidenceMatches = evidence.some((item) => normalize(item).includes(normalize(part.name).split(" ")[0] ?? ""));
    if (!hasEditionOrEvidence(part.governingReference, evidenceMatches ? evidence : [])) {
      add(question(`standard-${slug(part.name)}`, "STANDARD_DEFINITION_REQUIRED", "geometry", `Select the governing standard and edition for ${part.name}, or attach an approved supplier/engineering drawing and part number.`, "Standard geometry, interfaces, ratings, and tolerances must not be inferred from a generic visual placeholder.", ["standard number and edition", "approved drawing PDF or image", "supplier part number and data sheet", "approved neutral CAD model"], [part.id]));
    }
  }
  if (manufactured.length > 0 && !MATERIAL_EXPRESSION.test(normalized)) {
    add(question("material", "MATERIAL_REQUIRED_FOR_RELEASE", "release", "Specify material, condition/grade, and any finish or heat treatment for manufactured definitions.", "Geometry may be planned without material, but mass, strength, fits, finishing, and release checks cannot be approved.", ["material specification", "BOM material field", "approved engineering note"], manufactured.map((part) => part.id)));
  }
  if ((scope === "assembly" || scope === "part-and-assembly") && parts.some((part) => part.quantity === null)) {
    add(question("quantities", "CHILD_QUANTITIES_REQUIRED", "assembly", "Confirm the quantity of every child definition and identify which occurrences are truly identical.", "A reusable definition and an occurrence are different objects; an assembly tree cannot be verified without quantities.", ["BOM", "assembly sketch", "occurrence list"], parts.filter((part) => part.quantity === null).map((part) => part.id)));
  }
  if ((scope === "assembly" || scope === "part-and-assembly") && !/\b(?:mate|joint|coincident|concentric|align|fixed|grounded|position|distance|angle|transform|datum)\b/u.test(normalized)) {
    add(question("assembly-interfaces", "ASSEMBLY_REFERENCE_SCHEME_REQUIRED", "assembly", "Identify the grounded child and define locating datums, axes, offsets, orientations, and mate/joint intent for each interface.", "Visual placement alone does not preserve an editable or testable assembly relationship.", ["assembly datum scheme", "interface control drawing", "mate/joint table", "approved transforms"], parts.map((part) => part.id)));
  }
  if (parts.some((part) => part.classification === "surface-driven") && evidence.length === 0) {
    add(question("surface-evidence", "SURFACE_REFERENCE_REQUIRED", "geometry", "Provide section curves, guide curves, scan/reference data, or dimensioned silhouette views plus continuity requirements.", "A controlled freeform surface cannot be reconstructed reliably from its name alone.", ["section/guide curve data", "reference CAD", "scan data", "dimensioned orthographic images"], parts.filter((part) => part.classification === "surface-driven").map((part) => part.id)));
  }
  if (scope === "drawing" || /\b(?:drawing|drafting|sheet|gdt|gd&t)\b/u.test(normalized)) {
    add(question("drawing-standard", "DRAWING_CONVENTION_REQUIRED", "release", "Confirm drafting standard and edition, projection method, sheet/template, units, general tolerance policy, and required GD&T datum scheme.", "A professional drawing cannot choose release conventions from geometry alone.", ["drawing template", "company drafting standard", "approved title-block and tolerance note"], parts.map((part) => part.id)));
  }
  if (/(?:\+\s*\/\s*-|±|\bplus(?:\s+or)?[ /-]*minus)\s*5(?:\.0+)?\b/u.test(normalized)) {
    add(question("fit-adjustment", "FIT_ADJUSTMENT_SCOPE_REQUIRED", "geometry", "Name each member allowed to change by ±5 and identify its controlled direction, nominal value, interface gap target, and approval owner.", "A fit-up allowance is a controlled parameter on named members, not a general dimensional tolerance.", ["fit-up table", "interface sketch", "approved nominal and adjustment limits"], manufactured.map((part) => part.id)));
  }
  return questions;
}

function question(
  id: string, code: string, blocks: EngineeringQuestionBoundary, prompt: string, reason: string,
  acceptedEvidence: readonly string[], relatedDefinitionIds: readonly string[]
): EngineeringQuestion {
  return { id: `question:${id}`, code, blocks, prompt, reason, acceptedEvidence, relatedDefinitionIds };
}

function buildAssemblyPackages(
  normalized: string,
  scope: EngineeringIntentScope,
  parts: readonly EngineeringPartDefinition[],
  questions: readonly EngineeringQuestion[]
): readonly EngineeringAssemblyPackage[] {
  if (scope === "part" || scope === "drawing") return [];
  const matches = ASSEMBLY_PACKAGE_PATTERNS.filter((pattern) => pattern.expression.test(normalized));
  const container = /\bcontainer\b/u.test(normalized);
  const proposals = matches.length > 0 ? matches.map((match) => ({ ...match, source: "user-request" as const }))
    : container ? [
      { key: "bottom", name: "Bottom assembly", source: "planner-proposal" as const },
      { key: "side", name: "Side-frame assemblies", source: "planner-proposal" as const },
      { key: "top", name: "Top assembly", source: "planner-proposal" as const },
      { key: "ends", name: "Front and rear assemblies", source: "planner-proposal" as const },
      { key: "final", name: "Final integration assembly", source: "planner-proposal" as const }
    ] : [{ key: "primary", name: "Primary assembly", source: "user-request" as const }];
  const packages: EngineeringAssemblyPackage[] = [];
  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index]!;
    const final = proposal.key === "final" || index === proposals.length - 1 && proposals.length > 1;
    const dependencies = final ? packages.map((entry) => entry.id) : [];
    const children = final ? [] : assignChildren(proposal.key, parts);
    const relevantChildren = children.length > 0 ? children : final ? [] : parts.map((part) => part.id);
    const packageBlocked = questions.some((questionEntry) => questionEntry.blocks !== "release" && (
      questionEntry.relatedDefinitionIds.length === 0 || questionEntry.relatedDefinitionIds.some((id) => relevantChildren.includes(id))
    ));
    const mates = createMatePlans(proposal.key, relevantChildren, packageBlocked);
    const occurrenceCount = relevantChildren.length === 0 ? null : relevantChildren.reduce((total, id) => total + (parts.find((part) => part.id === id)?.quantity ?? 0), 0);
    packages.push({
      id: `assembly-package:${proposal.key}`,
      name: proposal.name,
      sequence: index + 1,
      source: proposal.source,
      dependencyPackageIds: dependencies,
      childDefinitionIds: relevantChildren,
      occurrenceCount,
      mates,
      status: packageBlocked || (final && dependencies.some((id) => packages.find((entry) => entry.id === id)?.status === "blocked")) ? "blocked" : "ready-for-review",
      approvalGate: final
        ? "Approve only after every dependency package is approved and final transforms, mates, interferences, service clearances, and design health are reviewed."
        : "Approve this complete subassembly only after child definitions, quantities, dimensions, interfaces, feature history, transforms, mates, and checks are visible."
    });
  }
  return packages;
}

function assignChildren(packageKey: string, parts: readonly EngineeringPartDefinition[]): readonly string[] {
  const mapping: Readonly<Record<string, readonly string[]>> = {
    bottom: ["side-rail", "cross-member", "corner-fitting", "plate", "gusset"],
    "left-side": ["post", "side-rail", "panel", "corner-fitting"],
    "right-side": ["post", "side-rail", "panel", "corner-fitting"],
    side: ["post", "side-rail", "panel", "corner-fitting"],
    top: ["top-rail", "cross-member", "panel", "corner-fitting"],
    ends: ["post", "panel", "corner-fitting"],
    front: ["post", "panel", "corner-fitting"],
    rear: ["post", "panel", "corner-fitting"],
    inner: ["plate", "bracket", "panel", "battery", "motor"]
  };
  const keys = mapping[packageKey];
  if (keys === undefined) return parts.map((part) => part.id);
  return parts.filter((part) => keys.some((key) => part.id === `definition:${key}`)).map((part) => part.id);
}

function createMatePlans(packageKey: string, childIds: readonly string[], blocked: boolean): readonly EngineeringMatePlan[] {
  if (childIds.length === 0) return [];
  const anchor = childIds[0]!;
  return childIds.slice(1).map((childId, index) => ({
    id: `mate-plan:${packageKey}:${index + 1}`,
    childDefinitionIds: [anchor, childId],
    intent: "Locate the child from functional datums; add only enough constraints to remove intended degrees of freedom.",
    referenceStrategy: "Use named planes, axes, points, and semantic interfaces rather than transient face or edge numbers.",
    ps3dCapability: "preview",
    status: blocked ? "needs-interface-input" : "planned"
  }));
}

function extractDimensions(request: string, defaultUnit: "mm" | "in"): readonly EngineeringDimensionFact[] {
  const normalizedSymbols = request.replace(/[×X]/gu, "x");
  const facts: EngineeringDimensionFact[] = [];
  const add = (label: string, rawValue: string, rawUnit: string | undefined, sourceText: string): void => {
    const sourceValue = Number(rawValue);
    if (!Number.isFinite(sourceValue) || sourceValue <= 0) return;
    const sourceUnit = rawUnit?.toLowerCase().startsWith("in") === true || rawUnit === '"' ? "in" : defaultUnit;
    const valueMm = sourceUnit === "in" ? sourceValue * 25.4 : sourceValue;
    const rounded = Math.round(valueMm * 1_000_000) / 1_000_000;
    const key = `${normalize(label)}:${rounded}`;
    if (facts.some((fact) => `${normalize(fact.label)}:${fact.valueMm}` === key)) return;
    facts.push({ id: `dimension:${slug(label)}-${facts.length + 1}`, label, valueMm: rounded, sourceValue, sourceUnit, sourceText, status: "stated-by-user" });
  };
  const stackExpression = /\b(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\s*(mm|millimet(?:er|re)s?|in|inch(?:es)?|")?/giu;
  for (const match of normalizedSymbols.matchAll(stackExpression)) {
    add("section dimension 1", match[1]!, match[4], match[0]);
    add("section dimension 2", match[2]!, match[4], match[0]);
    if (match[3] !== undefined) add("section dimension 3 / wall or thickness", match[3], match[4], match[0]);
  }
  const namedExpression = /\b(length|width|height|depth|thickness|wall|diameter|radius|bore|spacing|pitch|wheelbase|offset|distance)\s*(?:=|:|of)?\s*(\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|in|inch(?:es)?|")?/giu;
  for (const match of normalizedSymbols.matchAll(namedExpression)) add(match[1]!.toLowerCase(), match[2]!, match[3], match[0]);
  const diameterExpression = /(?:ø|⌀|\bdia(?:meter)?\.?\s*)(\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|in|inch(?:es)?|")?/giu;
  for (const match of normalizedSymbols.matchAll(diameterExpression)) add("diameter", match[1]!, match[2], match[0]);
  const endOffsetExpression = /\b(\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|in|inch(?:es)?|")?\s+from\s+(?:each|the)\s+end\b/giu;
  for (const match of normalizedSymbols.matchAll(endOffsetExpression)) add("end offset", match[1]!, match[2], match[0]);
  const trailingDescriptorExpression = /\b(\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|in|inch(?:es)?|")?\s*(long|wide|high|tall|thick)\b/giu;
  const trailingLabels: Readonly<Record<string, string>> = { long: "length", wide: "width", high: "height", tall: "height", thick: "thickness" };
  for (const match of normalizedSymbols.matchAll(trailingDescriptorExpression)) add(trailingLabels[match[3]!.toLowerCase()] ?? match[3]!, match[1]!, match[2], match[0]);
  return facts;
}

function quantityBefore(normalized: string, matchIndex: number): number | null {
  const prefix = normalized.slice(Math.max(0, matchIndex - 45), matchIndex);
  const match = prefix.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|sixteen|twenty)\s+(?:identical\s+)?$/u);
  if (match?.[1] === undefined) return null;
  const numeric = Number(match[1]);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : NUMBER_WORDS[match[1]] ?? null;
}

function inferUnit(normalized: string): "mm" | "in" | null {
  if (/\b(?:inch|inches|in)\b|"/u.test(normalized)) return "in";
  if (/\b(?:mm|millimeter|millimetre|millimeters|millimetres)\b/u.test(normalized)) return "mm";
  return null;
}

function standardReferenceNear(normalized: string, itemIndex: number): string | null {
  const windowStart = Math.max(0, itemIndex - 96);
  const windowEnd = Math.min(normalized.length, itemIndex + 160);
  const nearby = normalized.slice(windowStart, windowEnd).match(STANDARD_EXPRESSION)?.[0] ?? null;
  if (nearby !== null) return nearby;
  const references = [...normalized.matchAll(new RegExp(STANDARD_EXPRESSION.source, "giu"))].map((match) => match[0]);
  return references.length === 1 ? references[0] ?? null : null;
}

function hasEditionOrEvidence(reference: string | null, evidence: readonly string[]): boolean {
  if (evidence.length > 0) return true;
  return reference !== null && /(?:19|20)\d{2}\b/u.test(reference);
}

function dimensionSignature(dimensions: readonly EngineeringDimensionFact[]): string {
  return dimensions.map((dimension) => `${slug(dimension.label)}=${dimension.valueMm}`).join(";") || "unresolved";
}

function inferPrimaryObject(scope: EngineeringIntentScope, parts: readonly EngineeringPartDefinition[], normalized: string): string {
  if (/\bcontainer\b/u.test(normalized)) return "Container product assembly";
  if (scope === "drawing") return "Engineering drawing";
  if (parts.length === 1) return parts[0]!.name;
  return scope === "assembly" || scope === "part-and-assembly" ? "Multi-level assembly" : "Multi-feature part";
}

function intentConfidence(
  scope: EngineeringIntentScope,
  parts: readonly EngineeringPartDefinition[],
  dimensions: readonly EngineeringDimensionFact[],
  questions: readonly EngineeringQuestion[]
): number {
  let value = 0.42;
  if (scope !== "part" || parts[0]?.classification !== "custom") value += 0.14;
  if (parts.every((part) => part.name !== "Unresolved child definition")) value += 0.14;
  if (dimensions.length > 0) value += 0.14;
  if (parts.some((part) => (part.quantity ?? 0) > 0)) value += 0.08;
  value -= Math.min(0.22, questions.filter((questionEntry) => questionEntry.blocks !== "release").length * 0.04);
  return Math.max(0.1, Math.min(0.92, Math.round(value * 100) / 100));
}

function firstNextAction(
  questions: readonly EngineeringQuestion[],
  packages: readonly EngineeringAssemblyPackage[],
  parts: readonly EngineeringPartDefinition[],
  unavailableFeatureIds: readonly string[]
): string {
  const blocker = questions.find((questionEntry) => questionEntry.blocks !== "release");
  if (blocker !== undefined) return blocker.prompt;
  if (unavailableFeatureIds.length > 0) return `Review the ${unavailableFeatureIds.length} feature intent(s) without a qualified PS3D execution route and choose an approved alternative or adapter.`;
  const firstPackage = packages[0];
  if (firstPackage !== undefined) return `Review and approve ${firstPackage.name} before any dependent assembly package.`;
  return `Review ${parts[0]?.name ?? "the first part"}, its dimensions, semantic references, and ordered feature plan before creating a candidate.`;
}

function assessPortability(
  target: EngineeringTargetCad,
  scope: EngineeringIntentScope,
  parts: readonly EngineeringPartDefinition[],
  unavailableFeatureIds: readonly string[]
): EngineeringPortabilityAssessment {
  if (target === "ps3d") {
    if (unavailableFeatureIds.length > 0) return { target, level: "unsupported", reason: `${unavailableFeatureIds.length} planned feature intent(s) have no qualified PS3D execution route; the plan remains reviewable but cannot be called completed geometry.`, generatedPackageAvailable: false };
    return { target, level: scope === "assembly" || scope === "part-and-assembly" ? "positioned-assembly" : "native-editable", reason: "Every planned step has a bounded PS3D route, subject to question resolution, preview, and exact revision approval.", generatedPackageAvailable: false };
  }
  const hasStandard = parts.some((part) => part.kind === "standard-part");
  return {
    target,
    level: "unsupported",
    reason: `The vendor-neutral design intent is recorded${hasStandard ? " with standard-part evidence gates" : ""}, but a reviewed ${target} source-code adapter and installed licensed CAD application are still required before native editable output can be claimed.`,
    generatedPackageAvailable: false
  };
}

function buildWarnings(normalized: string, parts: readonly EngineeringPartDefinition[], unavailableFeatureIds: readonly string[]): readonly string[] {
  const warnings = [
    "This result is a read-only engineering decomposition, not generated geometry, a simulation result, or manufacturing approval.",
    "All downstream selections must use stable datums, axes, sketches, features, interfaces, and definition/occurrence IDs rather than screen position or transient edge numbers."
  ];
  if (unavailableFeatureIds.length > 0) warnings.push("At least one requested feature has no qualified execution route in the current PS3D kernel and must remain blocked or use an explicitly approved external adapter/fallback.");
  if (parts.some((part) => part.kind === "standard-part")) warnings.push("Standard and supplier parts remain evidence-gated; generic preview envelopes are not approved production definitions.");
  if (/\b(?:strength|load|pressure|thermal|crash|fatigue|safety|certif|homolog)\w*\b/u.test(normalized)) warnings.push("Analysis, compliance, and safety claims require separate qualified engineering methods, inputs, evidence, and review.");
  return warnings;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[–—]/gu, "-").replace(/[^a-z0-9+\-/±ø⌀".]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function slug(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "item";
}
