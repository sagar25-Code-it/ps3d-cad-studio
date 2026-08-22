import {
  convertLength,
  createBracketDocument,
  formatMeters,
  validateCadDocument,
  type CadDocument
} from "../packages/model-schema/src/index.js";
import { CommandSession, applyCommandAtomic, classifyHistoryRetry } from "../packages/commands/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const modelAndCommandTests: readonly TestCase[] = [
  {
    name: "unit conversion keeps physical length across mm and inches",
    run: () => {
      near(convertLength(25.4, "mm", "in"), 1, 1e-12, "25.4 mm must equal one inch");
      near(convertLength(2, "in", "mm"), 50.8, 1e-12, "two inches must equal 50.8 mm");
      equal(formatMeters(0.0254, "in"), "1", "display formatting must not add false precision");
      near(Number(formatMeters(0.06, "in")) * 0.0254, 0.06, 3e-10, "an unchanged converted field must preserve physical length at display precision");
    }
  },
  {
    name: "schema validation accepts the canonical bracket and rejects altered SI values",
    run: () => {
      const document = createBracketDocument("document:test-schema");
      assert(validateCadDocument(document).ok, "canonical bracket should validate");
      const corrupt = structuredClone(document) as CadDocument;
      const mutable = corrupt.parameters as unknown as Array<{ valueMeters: number }>;
      mutable[0] = { ...mutable[0]!, valueMeters: 60 };
      const result = validateCadDocument(corrupt);
      assert(!result.ok, "expression/value mismatch must be rejected");
      equal(result.diagnostics[0]?.code, "UNSUPPORTED_OR_CORRUPT_FILE", "schema error must be typed");
    }
  },
  {
    name: "native validation rejects out-of-envelope values and semantically corrupted canonical graphs",
    run: async () => {
      type MutableNative = {
        engineProfile: string;
        parameters: Array<{ key: string; expression: { decimal: string; unit: "mm" | "in" }; valueMeters: number }>;
        sketches: Array<{
          entities: Array<Record<string, unknown>>;
          constraints: Array<Record<string, unknown>>;
          acceptedConstraintState: Record<string, unknown>;
        }>;
        features: Array<Record<string, unknown>>;
        bodies: Array<Record<string, unknown>>;
        commandJournal: Array<Record<string, unknown>>;
      };
      const outside = structuredClone(createBracketDocument("document:test-native-envelope")) as unknown as MutableNative;
      const width = outside.parameters.find((parameter) => parameter.key === "width")!;
      width.expression = { decimal: "600", unit: "mm" };
      width.valueMeters = 0.6;
      const outsideResult = validateCadDocument(outside);
      assert(!outsideResult.ok, "native documents must obey the same parameter envelope as commands");
      equal(outsideResult.diagnostics[0]?.code, "OUTSIDE_SUPPORTED_ENVELOPE", "native envelope failure must be typed");

      const corruptions: Array<(document: MutableNative) => void> = [
        (document) => { document.sketches[0]!.entities[1]!.diameterParameterId = "parameter:plate-width"; },
        (document) => { document.sketches[0]!.acceptedConstraintState.degreesOfFreedom = 1; },
        (document) => { document.sketches[0]!.constraints[2]!.entityIds = ["entity:plate-rectangle"]; },
        (document) => { document.features[1]!.kind = "plate-extrusion"; },
        (document) => { document.features[0]!.outputBodyId = "body:other"; },
        (document) => { document.bodies[0]!.name = "Ignored body name"; },
        (document) => { document.engineProfile = "unqualified-engine"; }
      ];
      for (const corrupt of corruptions) {
        const candidate = structuredClone(createBracketDocument("document:test-native-graph")) as unknown as MutableNative;
        corrupt(candidate);
        assert(!validateCadDocument(candidate).ok, "ignored or contradictory semantic fields must be rejected");
      }

      const extraExpressionField = structuredClone(createBracketDocument("document:test-expression-shape")) as unknown as MutableNative;
      (extraExpressionField.parameters[0]!.expression as unknown as Record<string, unknown>).ignored = true;
      assert(!validateCadDocument(extraExpressionField).ok, "unit expressions with ignored fields must be rejected");

      const session = new CommandSession(createBracketDocument("document:test-journal-reconciliation"));
      const committed = await session.execute({
        protocolVersion: 1,
        kind: "set-parameter",
        commandId: "command:journal-width",
        expectedRevision: 0,
        parameterKey: "width",
        expression: { decimal: "70", unit: "mm" }
      }, () => ({ ok: true, value: undefined }));
      assert(committed.ok, "fixture command should commit");
      const forgedJournal = structuredClone(committed.value) as unknown as MutableNative;
      forgedJournal.commandJournal[1]!.expression = { decimal: "65", unit: "mm" };
      assert(!validateCadDocument(forgedJournal).ok, "the current semantic state must reconcile with the complete journal prefix");

      const forgedHistory = structuredClone(committed.value) as unknown as MutableNative & { revision: number; parentRevision: number | null; commandId: string };
      forgedHistory.revision = 2;
      forgedHistory.parentRevision = 1;
      forgedHistory.commandId = "command:forged-undo";
      forgedHistory.commandJournal.push({ revision: 2, parentRevision: 1, commandId: "command:forged-undo", kind: "undo", targetRevision: 1 });
      assert(!validateCadDocument(forgedHistory).ok, "journal history operations must follow the legal undo/redo stacks");
    }
  },
  {
    name: "stale revision command is rejected without changing the source",
    run: async () => {
      const document = createBracketDocument("document:test-conflict");
      const before = JSON.stringify(document);
      const result = await applyCommandAtomic(document, {
        protocolVersion: 1,
        kind: "set-parameter",
        commandId: "command:stale-width",
        expectedRevision: 9,
        parameterKey: "width",
        expression: { decimal: "70", unit: "mm" }
      }, () => ({ ok: true, value: undefined }));
      assert(!result.ok, "stale command must fail");
      equal(result.diagnostics[0]?.code, "REVISION_CONFLICT", "revision failure must be explicit");
      equal(JSON.stringify(document), before, "failed command must not mutate the document");
    }
  },
  {
    name: "failed validation does not commit or enter undo history",
    run: async () => {
      const document = createBracketDocument("document:test-atomic");
      const session = new CommandSession(document);
      const result = await session.execute({
        protocolVersion: 1,
        kind: "set-parameter",
        commandId: "command:rejected-width",
        expectedRevision: 0,
        parameterKey: "width",
        expression: { decimal: "70", unit: "mm" }
      }, () => ({
        ok: false,
        diagnostics: [{
          code: "INVALID_SOLID_OUTPUT",
          severity: "error",
          message: "Synthetic qualification failure.",
          relatedIds: ["body:bracket"],
          recovery: "Use the previous dimensions."
        }]
      }));
      assert(!result.ok, "candidate validation should fail");
      equal(session.current.revision, 0, "failed command must not advance revision");
      equal(session.canUndo, false, "failed command must not enter history");
    }
  },
  {
    name: "a durable candidate is the recovery commit point even when acknowledgement is lost",
    run: async () => {
      const session = new CommandSession(createBracketDocument("document:test-durable-commit"));
      let durable: CadDocument | undefined;
      const result = await session.execute({
        protocolVersion: 1,
        kind: "set-parameter",
        commandId: "command:durable-width",
        expectedRevision: 0,
        parameterKey: "width",
        expression: { decimal: "70", unit: "mm" }
      }, (candidate) => {
        durable = structuredClone(candidate);
        return { ok: true, value: undefined };
      });
      assert(result.ok, "durable write should establish the command commit point");
      assert(durable !== undefined, "the candidate must be durable before acknowledgement");
      const recovered = validateCadDocument(durable);
      assert(recovered.ok, "a simulated lost acknowledgement must recover the durable revision");
      equal(recovered.value.revision, 1, "recovery must not fall back behind the durable revision");
      equal(recovered.value.commandId, "command:durable-width", "the stable command ID must identify the recovered commit");
    }
  },
  {
    name: "successful command plus undo and redo preserve stable semantic IDs",
    run: async () => {
      const session = new CommandSession(createBracketDocument("document:test-history"));
      const result = await session.execute({
        protocolVersion: 1,
        kind: "set-parameter",
        commandId: "command:accepted-width",
        expectedRevision: 0,
        parameterKey: "width",
        expression: { decimal: "70", unit: "mm" }
      }, () => ({ ok: true, value: undefined }));
      assert(result.ok, "valid command should commit");
      const ids = result.value.parameters.map((parameter) => parameter.id).join("|");
      const undone = await session.undo("command:undo-width");
      assert(undone.ok, "undo should succeed");
      equal(undone.value.parameters.map((parameter) => parameter.id).join("|"), ids, "undo must preserve IDs");
      const redone = await session.redo("command:redo-width");
      assert(redone.ok, "redo should succeed");
      equal(redone.value.parameters.map((parameter) => parameter.id).join("|"), ids, "redo must preserve IDs");
      equal(redone.value.revision, 3, "history operations must keep revisions monotonic");
      assert(validateCadDocument(redone.value).ok, "rebased history must retain a replayable canonical journal");
    }
  },
  {
    name: "recovered sessions reconstruct coherent authoritative undo and redo stacks",
    run: async () => {
      const original = new CommandSession(createBracketDocument("document:test-restart-history"));
      const accept = () => ({ ok: true as const, value: undefined });
      let result = await original.execute({
        protocolVersion: 1, kind: "set-parameter", commandId: "command:restart-width", expectedRevision: 0,
        parameterKey: "width", expression: { decimal: "70", unit: "mm" }
      }, accept);
      assert(result.ok, "first edit should commit");
      result = await original.execute({
        protocolVersion: 1, kind: "set-parameter", commandId: "command:restart-height", expectedRevision: 1,
        parameterKey: "height", expression: { decimal: "50", unit: "mm" }
      }, accept);
      assert(result.ok, "second edit should commit");
      const undone = await original.undo("command:restart-undo", accept);
      assert(undone.ok, "fixture undo should commit");

      const recovered = new CommandSession(structuredClone(undone.value));
      equal(recovered.undoDepth, 1, "restart must recover the legal undo depth");
      equal(recovered.redoDepth, 1, "restart must recover the legal redo depth");
      equal(classifyHistoryRetry(recovered.current, "undo", "command:restart-undo", 2), "exact-retry", "lost history acknowledgement must classify as an exact retry");
      const redone = await recovered.redo("command:restart-redo", accept);
      assert(redone.ok, "redo after restart should succeed");
      const undoAgain = await recovered.undo("command:restart-undo-again", accept);
      assert(undoAgain.ok, "first post-redo undo should succeed");
      const initial = await recovered.undo("command:restart-undo-initial", accept);
      assert(initial.ok, "second post-redo undo should reach the initial state");
      equal(initial.value.parameters.map((parameter) => parameter.expression.decimal).join("|"), "60|40|10|10", "replayed history must recover initial parameter intent");
      equal(initial.value.revision, 6, "recovered history revisions must remain monotonic");

      const branched = new CommandSession(structuredClone(undone.value));
      const branch = await branched.execute({
        protocolVersion: 1, kind: "set-parameter", commandId: "command:restart-branch", expectedRevision: 3,
        parameterKey: "thickness", expression: { decimal: "12", unit: "mm" }
      }, accept);
      assert(branch.ok, "new edit after recovered undo should commit");
      equal(branched.redoDepth, 0, "new edit must clear the recovered redo branch");
    }
  },
  {
    name: "exact command retries are no-op successes and reused IDs with different intent fail first",
    run: async () => {
      const session = new CommandSession(createBracketDocument("document:test-idempotency"));
      const command = {
        protocolVersion: 1 as const, kind: "set-parameter" as const, commandId: "command:idempotent-width",
        expectedRevision: 0, parameterKey: "width" as const, expression: { decimal: "70", unit: "mm" as const }
      };
      let validations = 0;
      const committed = await session.execute(command, () => { validations += 1; return { ok: true, value: undefined }; });
      assert(committed.ok, "first command should commit");
      const recovered = new CommandSession(structuredClone(committed.value));
      const retry = await recovered.execute(command, () => { validations += 1; return { ok: true, value: undefined }; });
      assert(retry.ok, "exact retry should succeed after recovery");
      equal(retry.value.revision, 1, "exact retry must not advance revision");
      equal(retry.value.commandJournal.length, 2, "exact retry must not append history");
      equal(validations, 1, "exact retry must not reevaluate or repersist geometry");

      const conflict = await recovered.execute({ ...command, expression: { decimal: "75", unit: "mm" } }, () => ({ ok: true, value: undefined }));
      assert(!conflict.ok, "same command ID with changed intent must fail");
      equal(conflict.diagnostics[0]?.code, "IDEMPOTENCY_CONFLICT", "ID reuse must fail before stale-revision handling");
      const stale = await recovered.execute({ ...command, commandId: "command:unseen-stale" }, () => ({ ok: true, value: undefined }));
      assert(!stale.ok, "unseen stale command must fail");
      equal(stale.diagnostics[0]?.code, "REVISION_CONFLICT", "unseen stale command remains a revision conflict");
    }
  }
];
