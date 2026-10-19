import {
  expressionToMeters,
  fail,
  hasExactKeys,
  isDisplayUnit,
  isParameterKey,
  isRecord,
  isUnitExpression,
  PARAMETER_IDS,
  replayCommandJournal,
  validateCadDocument,
  validateParameterEnvelope,
  type CadDocument,
  type CommandJournalEntry,
  type DisplayUnit,
  type ParameterKey,
  type Result,
  type UnitExpression
} from "../../model-schema/src/index.js";

export interface SetParameterCommand {
  readonly protocolVersion: 1;
  readonly kind: "set-parameter";
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly parameterKey: ParameterKey;
  readonly expression: UnitExpression;
}

export interface SetDisplayUnitCommand {
  readonly protocolVersion: 1;
  readonly kind: "set-display-unit";
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly displayUnit: DisplayUnit;
}

export type DocumentCommand = SetParameterCommand | SetDisplayUnitCommand;
export type CandidateValidator = (candidate: CadDocument) => Result<unknown> | Promise<Result<unknown>>;
export type RetryDisposition = "new" | "exact-retry" | "conflict";

export function isDocumentCommand(value: unknown): value is DocumentCommand {
  if (!isRecord(value) || value.protocolVersion !== 1 || !isCommandId(value.commandId)
    || !isRevision(value.expectedRevision)) return false;
  if (value.kind === "set-parameter") {
    return hasExactKeys(value, ["protocolVersion", "kind", "commandId", "expectedRevision", "parameterKey", "expression"])
      && isParameterKey(value.parameterKey) && isUnitExpression(value.expression);
  }
  return value.kind === "set-display-unit"
    && hasExactKeys(value, ["protocolVersion", "kind", "commandId", "expectedRevision", "displayUnit"])
    && isDisplayUnit(value.displayUnit);
}

export function classifyCommandRetry(document: CadDocument, command: DocumentCommand): RetryDisposition {
  const existing = document.commandJournal.find((entry) => entry.commandId === command.commandId);
  if (existing === undefined) return "new";
  if (command.kind === "set-parameter" && existing.kind === "set-parameter") {
    return existing.parentRevision === command.expectedRevision
      && existing.parameterKey === command.parameterKey
      && existing.expression.decimal === command.expression.decimal
      && existing.expression.unit === command.expression.unit ? "exact-retry" : "conflict";
  }
  if (command.kind === "set-display-unit" && existing.kind === "set-display-unit") {
    return existing.parentRevision === command.expectedRevision && existing.displayUnit === command.displayUnit
      ? "exact-retry" : "conflict";
  }
  return "conflict";
}

export function classifyHistoryRetry(
  document: CadDocument,
  direction: "undo" | "redo",
  commandId: string,
  baseRevision: number
): RetryDisposition {
  const existing = document.commandJournal.find((entry) => entry.commandId === commandId);
  if (existing === undefined) return "new";
  return existing.kind === direction && existing.parentRevision === baseRevision ? "exact-retry" : "conflict";
}

export async function applyCommandAtomic(
  current: CadDocument,
  command: DocumentCommand,
  validateCandidate: CandidateValidator
): Promise<Result<CadDocument>> {
  if (!isDocumentCommand(command)) {
    return fail("INVALID_GRAPH", "The command envelope is invalid.", [], "Retry with one exact version 1 command.");
  }
  const retry = classifyCommandRetry(current, command);
  if (retry === "exact-retry") return { ok: true, value: structuredClone(current) };
  if (retry === "conflict") return idempotencyConflict(command.commandId);
  if (command.expectedRevision !== current.revision) {
    return fail(
      "REVISION_CONFLICT",
      `Revision ${command.expectedRevision} is stale; the current revision is ${current.revision}.`,
      [current.id],
      "Reload the current revision and reapply the intended change."
    );
  }

  let candidate: CadDocument;
  if (command.kind === "set-display-unit") {
    candidate = nextRevision(current, command.commandId, { displayUnit: command.displayUnit }, { kind: "set-display-unit", displayUnit: command.displayUnit });
  } else {
    const evaluated = expressionToMeters(command.expression);
    if (!evaluated.ok) return evaluated;
    const envelope = validateParameterEnvelope(command.parameterKey, evaluated.value);
    if (!envelope.ok) return envelope;
    candidate = nextRevision(current, command.commandId, {
      parameters: current.parameters.map((parameter) => parameter.id === PARAMETER_IDS[command.parameterKey]
        ? { ...parameter, expression: structuredClone(command.expression), valueMeters: evaluated.value }
        : parameter)
    }, { kind: "set-parameter", parameterKey: command.parameterKey, expression: structuredClone(command.expression) });
  }
  const schema = validateCadDocument(candidate);
  if (!schema.ok) return schema;
  const validation = await validateCandidate(schema.value);
  return validation.ok ? { ok: true, value: schema.value } : validation;
}

export class CommandSession {
  #current: CadDocument;
  readonly #undo: HistoryTarget[];
  readonly #redo: HistoryTarget[];

  constructor(initial: CadDocument) {
    const valid = validateCadDocument(initial);
    if (!valid.ok) throw new TypeError("CommandSession requires a validated canonical document.");
    const restored = restoreHistory(valid.value);
    this.#current = restored.current;
    this.#undo = restored.undo;
    this.#redo = restored.redo;
  }

  get current(): CadDocument { return this.#current; }
  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }
  get undoDepth(): number { return this.#undo.length; }
  get redoDepth(): number { return this.#redo.length; }

  async execute(command: DocumentCommand, validateCandidate: CandidateValidator): Promise<Result<CadDocument>> {
    const result = await applyCommandAtomic(this.#current, command, validateCandidate);
    if (!result.ok || result.value.revision === this.#current.revision) return result;
    this.#undo.push(historyTarget(this.#current));
    this.#current = result.value;
    this.#redo.length = 0;
    return result;
  }

  async undo(commandId: string, validateCandidate?: CandidateValidator): Promise<Result<CadDocument>> {
    return this.#move("undo", commandId, validateCandidate);
  }

  async redo(commandId: string, validateCandidate?: CandidateValidator): Promise<Result<CadDocument>> {
    return this.#move("redo", commandId, validateCandidate);
  }

  async #move(kind: "undo" | "redo", commandId: string, validateCandidate?: CandidateValidator): Promise<Result<CadDocument>> {
    if (!isCommandId(commandId)) return fail("INVALID_GRAPH", "The history command ID is invalid.", [], "Retry with a stable command ID.");
    if (this.#current.commandJournal.some((entry) => entry.commandId === commandId)) return idempotencyConflict(commandId);
    const source = kind === "undo" ? this.#undo : this.#redo;
    const destination = kind === "undo" ? this.#redo : this.#undo;
    const target = source.at(-1);
    if (target === undefined) {
      return fail("INVALID_GRAPH", `There is no committed command to ${kind}.`, [], kind === "undo" ? "Make a successful edit first." : "Undo a successful edit first.");
    }
    const candidate = rebaseTarget(target, this.#current, commandId, kind);
    if (validateCandidate !== undefined) {
      const validation = await validateCandidate(candidate);
      if (!validation.ok) return validation;
    }
    source.pop();
    destination.push(historyTarget(this.#current));
    this.#current = candidate;
    return { ok: true, value: this.#current };
  }
}

function restoreHistory(document: CadDocument): { current: CadDocument; undo: HistoryTarget[]; redo: HistoryTarget[] } {
  const replay = replayCommandJournal(document.commandJournal, document.revision, document.commandId);
  if (!replay.ok) throw new TypeError("Validated command journal could not be replayed.");
  const target = (revision: number): HistoryTarget => ({
    revision,
    displayUnit: replay.value.states[revision]!.displayUnit,
    expressions: structuredClone(replay.value.states[revision]!.expressions)
  });
  return {
    current: structuredClone(document),
    undo: replay.value.undoRevisions.map(target),
    redo: replay.value.redoRevisions.map(target)
  };
}

function nextRevision(
  current: CadDocument,
  commandId: string,
  change: Partial<Pick<CadDocument, "displayUnit" | "parameters">>,
  journalAction: JournalAction
): CadDocument {
  const revision = current.revision + 1;
  return {
    ...current,
    ...change,
    revision,
    parentRevision: current.revision,
    commandId,
    commandJournal: [...current.commandJournal, { revision, parentRevision: current.revision, commandId, ...journalAction } as CommandJournalEntry]
  };
}

function rebaseTarget(target: HistoryTarget, current: CadDocument, commandId: string, kind: "undo" | "redo"): CadDocument {
  const revision = current.revision + 1;
  return {
    ...structuredClone(current),
    revision,
    parentRevision: current.revision,
    commandId,
    commandJournal: [...current.commandJournal, { revision, parentRevision: current.revision, commandId, kind, targetRevision: target.revision }],
    displayUnit: target.displayUnit,
    parameters: current.parameters.map((parameter) => {
      const expression = structuredClone(target.expressions[parameter.key]);
      const evaluated = expressionToMeters(expression);
      if (!evaluated.ok) throw new TypeError("Validated history target could not be evaluated.");
      return { ...structuredClone(parameter), expression, valueMeters: evaluated.value };
    })
  };
}

interface HistoryTarget {
  readonly revision: number;
  readonly displayUnit: DisplayUnit;
  readonly expressions: Readonly<Record<ParameterKey, UnitExpression>>;
}

function historyTarget(document: CadDocument): HistoryTarget {
  return {
    revision: document.revision,
    displayUnit: document.displayUnit,
    expressions: Object.fromEntries(document.parameters.map((parameter) => [parameter.key, structuredClone(parameter.expression)])) as Record<ParameterKey, UnitExpression>
  };
}

type JournalAction =
  | { readonly kind: "set-parameter"; readonly parameterKey: ParameterKey; readonly expression: UnitExpression }
  | { readonly kind: "set-display-unit"; readonly displayUnit: DisplayUnit };

function isCommandId(value: unknown): value is string {
  return typeof value === "string" && /^command:[a-z0-9][a-z0-9._-]{0,100}$/.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function idempotencyConflict(commandId: string): Result<never> {
  return fail(
    "IDEMPOTENCY_CONFLICT",
    `Command ID ${commandId} was already committed with different intent.`,
    [commandId],
    "Generate a new command ID for a different operation."
  );
}
