import {
  APPLICATION_VERSION,
  ENGINE_PROFILE,
  MAX_SCHEMA_NODES,
  NATIVE_FORMAT,
  PARAMETER_IDS,
  PARAMETER_LABELS,
  SCHEMA_VERSION,
  expressionToMeters,
  fail,
  hasExactKeys,
  isDisplayUnit,
  isParameterKey,
  isRecord,
  isStableId,
  isUnitExpression,
  validateParameterEnvelope,
  type CadDocument,
  type DisplayUnit,
  type ParameterKey,
  type Result,
  type UnitExpression
} from "./core.js";

export interface JournalProjection {
  readonly displayUnit: DisplayUnit;
  readonly expressions: Readonly<Record<ParameterKey, UnitExpression>>;
}

export interface JournalReplay {
  readonly states: readonly JournalProjection[];
  readonly undoRevisions: readonly number[];
  readonly redoRevisions: readonly number[];
}

export function validateCadDocument(input: unknown): Result<CadDocument> {
  if (!isRecord(input)) return invalidFile("The document root must be an object.");
  if (countNodes(input, MAX_SCHEMA_NODES + 1) > MAX_SCHEMA_NODES) {
    return fail("RESOURCE_LIMIT", "The native document exceeds the Phase 0 structure limit.", [], "Open a smaller bounded document.");
  }
  if (input.format !== NATIVE_FORMAT || input.schemaVersion !== SCHEMA_VERSION) {
    return invalidFile("This prototype opens only ps3d-native schema version 1.");
  }
  if (!hasExactKeys(input, [
    "format", "schemaVersion", "applicationVersion", "engineProfile", "id", "name", "revision", "parentRevision",
    "commandId", "commandJournal", "displayUnit", "parameters", "sketches", "features", "bodies"
  ])) return invalidFile("The document root contains missing or unsupported fields.");
  if (!isStableId(input.id) || typeof input.name !== "string" || input.name.length < 1 || input.name.length > 120) {
    return invalidFile("The document identity or name is invalid.");
  }
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) return invalidFile("The revision must be a non-negative integer.");
  if (!(input.parentRevision === null || (Number.isSafeInteger(input.parentRevision) && (input.parentRevision as number) >= 0))) {
    return invalidFile("The parent revision is invalid.");
  }
  if (((input.revision as number) === 0 && input.parentRevision !== null)
    || ((input.revision as number) > 0 && input.parentRevision !== (input.revision as number) - 1)) {
    return invalidFile("The parent revision must identify the immediately preceding revision.");
  }
  if (!isStableId(input.commandId) || !isDisplayUnit(input.displayUnit)) return invalidFile("The command identity or display unit is invalid.");
  if (input.applicationVersion !== APPLICATION_VERSION || input.engineProfile !== ENGINE_PROFILE) return invalidFile("The application or engine profile is unsupported.");
  const journal = replayCommandJournal(input.commandJournal, input.revision as number, input.commandId as string);
  if (!journal.ok) return journal;
  const currentProjection = journal.value.states.at(-1)!;
  if (currentProjection.displayUnit !== input.displayUnit) return invalidFile("The current display unit diverges from the command journal.");
  if (!Array.isArray(input.parameters) || input.parameters.length !== 4) return invalidFile("Exactly four bracket parameters are required.");

  const keys = new Set<ParameterKey>();
  const ids = new Set<string>();
  for (const candidate of input.parameters) {
    if (!isRecord(candidate) || !isParameterKey(candidate.key) || !isStableId(candidate.id)) return invalidFile("A parameter record is invalid.");
    if (!hasExactKeys(candidate, ["id", "key", "label", "dimension", "expression", "valueMeters"])) return invalidFile("A parameter contains missing or unsupported fields.");
    if (candidate.id !== PARAMETER_IDS[candidate.key] || ids.has(candidate.id) || keys.has(candidate.key)) return invalidFile("Parameter IDs and keys must be unique and canonical.");
    if (candidate.dimension !== "length" || candidate.label !== PARAMETER_LABELS[candidate.key] || !isUnitExpression(candidate.expression)) return invalidFile("A length parameter is malformed.");
    const evaluated = expressionToMeters(candidate.expression);
    if (!evaluated.ok || !Number.isFinite(candidate.valueMeters) || Math.abs((candidate.valueMeters as number) - evaluated.value) > 1e-12) {
      return invalidFile("A parameter expression does not match its stored SI value.");
    }
    const envelope = validateParameterEnvelope(candidate.key, evaluated.value);
    if (!envelope.ok) return envelope;
    const projected = currentProjection.expressions[candidate.key];
    if (candidate.expression.decimal !== projected.decimal || candidate.expression.unit !== projected.unit) {
      return invalidFile("A current parameter diverges from the command journal.");
    }
    keys.add(candidate.key);
    ids.add(candidate.id);
  }

  if (!Array.isArray(input.sketches) || input.sketches.length !== 1 || !Array.isArray(input.features)
    || input.features.length !== 2 || !Array.isArray(input.bodies) || input.bodies.length !== 1) {
    return invalidFile("The Phase 0 semantic graph must contain one sketch, two features, and one body.");
  }
  const graph = validateSemanticGraph(input);
  return graph.ok ? { ok: true, value: structuredClone(input) as unknown as CadDocument } : graph;
}

export function replayCommandJournal(value: unknown, revision: number, commandId: string): Result<JournalReplay> {
  if (!Array.isArray(value) || value.length !== revision + 1 || value.length === 0) return invalidFile("The command journal is incomplete.");
  const states: JournalProjection[] = [];
  const commandIds = new Set<string>();
  const undoStack: number[] = [];
  const redoStack: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry) || !Number.isSafeInteger(entry.revision) || entry.revision !== index || !isStableId(entry.commandId)) {
      return invalidFile("A command journal entry is invalid.");
    }
    if (commandIds.has(entry.commandId)) return invalidFile("Command journal IDs must be unique.");
    commandIds.add(entry.commandId);
    if (entry.parentRevision !== (index === 0 ? null : index - 1)) return invalidFile("The command journal parent chain is invalid.");
    if (entry.kind === "create-document") {
      if (index !== 0 || entry.commandId !== "command:document-created"
        || !hasExactKeys(entry, ["revision", "parentRevision", "commandId", "kind", "displayUnit"])
        || !isDisplayUnit(entry.displayUnit)) return invalidFile("The create-document journal entry is invalid.");
      states.push({ displayUnit: entry.displayUnit, expressions: defaultExpressions() });
    } else if (entry.kind === "set-parameter") {
      if (index === 0 || !hasExactKeys(entry, ["revision", "parentRevision", "commandId", "kind", "parameterKey", "expression"])
        || !isParameterKey(entry.parameterKey) || !isUnitExpression(entry.expression)) return invalidFile("A parameter journal entry is invalid.");
      const evaluated = expressionToMeters(entry.expression);
      if (!evaluated.ok) return invalidFile("A parameter journal expression is invalid.");
      const envelope = validateParameterEnvelope(entry.parameterKey, evaluated.value);
      if (!envelope.ok) return envelope;
      const previous = states[index - 1]!;
      undoStack.push(index - 1);
      redoStack.length = 0;
      states.push({ ...previous, expressions: { ...previous.expressions, [entry.parameterKey]: structuredClone(entry.expression) as UnitExpression } });
    } else if (entry.kind === "set-display-unit") {
      if (index === 0 || !hasExactKeys(entry, ["revision", "parentRevision", "commandId", "kind", "displayUnit"])
        || !isDisplayUnit(entry.displayUnit)) return invalidFile("A display-unit journal entry is invalid.");
      undoStack.push(index - 1);
      redoStack.length = 0;
      states.push({ ...states[index - 1]!, displayUnit: entry.displayUnit });
    } else if (entry.kind === "undo" || entry.kind === "redo") {
      if (index === 0 || !hasExactKeys(entry, ["revision", "parentRevision", "commandId", "kind", "targetRevision"])
        || !Number.isSafeInteger(entry.targetRevision) || (entry.targetRevision as number) < 0 || (entry.targetRevision as number) >= index) {
        return invalidFile("A history journal entry is invalid.");
      }
      const source = entry.kind === "undo" ? undoStack : redoStack;
      const destination = entry.kind === "undo" ? redoStack : undoStack;
      if (source.pop() !== entry.targetRevision) return invalidFile("A history journal entry does not follow the legal undo/redo stack.");
      destination.push(index - 1);
      states.push(structuredClone(states[entry.targetRevision as number]!) as JournalProjection);
    } else {
      return invalidFile("The command journal contains an unsupported operation.");
    }
  }
  if ((value.at(-1) as Record<string, unknown>).commandId !== commandId) return invalidFile("The current command does not match the journal prefix.");
  return { ok: true, value: { states, undoRevisions: undoStack, redoRevisions: redoStack } };
}

function validateSemanticGraph(input: Record<string, unknown>): Result<CadDocument> {
  const sketch = (input.sketches as unknown[])[0];
  const features = input.features as unknown[];
  const body = (input.bodies as unknown[])[0];
  if (!isRecord(sketch) || !hasExactKeys(sketch, ["id", "name", "planeId", "entities", "constraints", "acceptedConstraintState"])
    || sketch.id !== "sketch:bracket-profile" || sketch.name !== "Bounded bracket profile" || sketch.planeId !== "datum:xy"
    || !Array.isArray(sketch.entities) || sketch.entities.length !== 2 || !Array.isArray(sketch.constraints) || sketch.constraints.length !== 6) {
    return invalidFile("The bounded sketch graph is invalid.");
  }
  const rectangle = sketch.entities[0];
  const circle = sketch.entities[1];
  if (!isRecord(rectangle) || !hasExactKeys(rectangle, ["id", "kind", "centerMeters", "widthParameterId", "heightParameterId", "closed", "construction"])
    || rectangle.kind !== "rectangle-profile" || rectangle.id !== "entity:plate-rectangle" || rectangle.widthParameterId !== PARAMETER_IDS.width
    || rectangle.heightParameterId !== PARAMETER_IDS.height || rectangle.closed !== true || rectangle.construction !== false || !isZeroPair(rectangle.centerMeters)) {
    return invalidFile("The rectangle profile is invalid.");
  }
  if (!isRecord(circle) || !hasExactKeys(circle, ["id", "kind", "centerMeters", "diameterParameterId", "construction"])
    || circle.kind !== "circle-profile" || circle.id !== "entity:center-bore" || circle.diameterParameterId !== PARAMETER_IDS.holeDiameter
    || circle.construction !== false || !isZeroPair(circle.centerMeters)) return invalidFile("The centered circle profile is invalid.");
  const expectedConstraints: readonly Readonly<Record<string, unknown>>[] = [
    { id: "constraint:rectangle-axis-aligned", kind: "axis-aligned", entityIds: ["entity:plate-rectangle"] },
    { id: "constraint:rectangle-centered", kind: "centered-at-origin", entityIds: ["entity:plate-rectangle"] },
    { id: "constraint:bore-centered", kind: "centered-at-origin", entityIds: ["entity:center-bore"] },
    { id: "constraint:width", kind: "driving-dimension", entityIds: ["entity:plate-rectangle"], parameterId: PARAMETER_IDS.width },
    { id: "constraint:height", kind: "driving-dimension", entityIds: ["entity:plate-rectangle"], parameterId: PARAMETER_IDS.height },
    { id: "constraint:bore-diameter", kind: "driving-dimension", entityIds: ["entity:center-bore"], parameterId: PARAMETER_IDS.holeDiameter }
  ];
  if (!sketch.constraints.every((constraint, index) => isExactRecord(constraint, expectedConstraints[index]!))) return invalidFile("The bounded constraint graph is not canonical.");
  if (!isExactRecord(sketch.acceptedConstraintState, { classification: "fully-constrained", degreesOfFreedom: 0 })) return invalidFile("The accepted constraint state is not canonical.");
  const expectedFeatures: readonly Readonly<Record<string, unknown>>[] = [
    { id: "feature:plate-extrusion", name: "Plate rise", kind: "plate-extrusion", order: 10, inputIds: ["sketch:bracket-profile", PARAMETER_IDS.thickness], outputBodyId: "body:bracket" },
    { id: "feature:centered-through-hole", name: "Centered passage", kind: "centered-through-hole", order: 20, inputIds: ["feature:plate-extrusion", "entity:center-bore"], outputBodyId: "body:bracket" }
  ];
  if (!features.every((feature, index) => isExactRecord(feature, expectedFeatures[index]!))) return invalidFile("A feature dependency is invalid.");
  if (!isRecord(body) || !hasExactKeys(body, ["id", "name", "visible"]) || body.id !== "body:bracket" || body.name !== "Bracket body" || body.visible !== true) return invalidFile("The bracket body is invalid.");
  return { ok: true, value: input as unknown as CadDocument };
}

function defaultExpressions(): Readonly<Record<ParameterKey, UnitExpression>> {
  return {
    width: { decimal: "60", unit: "mm" }, height: { decimal: "40", unit: "mm" },
    thickness: { decimal: "10", unit: "mm" }, holeDiameter: { decimal: "10", unit: "mm" }
  };
}

function countNodes(value: unknown, stopAfter: number): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0 && count < stopAfter) {
    const current = stack.pop();
    count += 1;
    const remaining = Math.max(0, stopAfter - count - stack.length);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length && index < remaining; index += 1) stack.push(current[index]);
    } else if (isRecord(current)) {
      const keys = Object.keys(current);
      for (let index = 0; index < keys.length && index < remaining; index += 1) stack.push(current[keys[index]!] as unknown);
    }
  }
  return count;
}

function isZeroPair(value: unknown): value is readonly [0, 0] {
  return Array.isArray(value) && value.length === 2 && value.every((part) => part === 0);
}

function isExactRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actual = value[key];
    return Array.isArray(expectedValue)
      ? Array.isArray(actual) && actual.length === expectedValue.length && actual.every((item, index) => item === expectedValue[index])
      : actual === expectedValue;
  });
}

function invalidFile(message: string): Result<never> {
  return fail("UNSUPPORTED_OR_CORRUPT_FILE", message, [], "Open an unmodified Phase 0 native revision artifact.");
}
