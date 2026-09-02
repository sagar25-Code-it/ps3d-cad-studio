import { deepFreeze } from "../../cad-document-core/src/index.js";
import { CadDocumentStoreError, type MigrationTrace } from "./types.js";

export interface DocumentMigration {
  readonly id: string;
  readonly fromSchemaVersion: number;
  readonly toSchemaVersion: number;
  migrate(document: unknown): unknown | Promise<unknown>;
}

export interface MigrationResult {
  readonly document: unknown;
  readonly trace: MigrationTrace;
}

export class CadDocumentMigrationRegistry {
  readonly #steps = new Map<number, DocumentMigration>();

  register(migration: DocumentMigration): this {
    if (!Number.isSafeInteger(migration.fromSchemaVersion)
      || !Number.isSafeInteger(migration.toSchemaVersion)
      || migration.fromSchemaVersion < 0
      || migration.toSchemaVersion <= migration.fromSchemaVersion
      || migration.id.trim().length === 0) {
      throw new TypeError("A migration requires a stable ID and increasing non-negative schema versions.");
    }
    if (this.#steps.has(migration.fromSchemaVersion)) {
      throw new TypeError(`A migration from schema ${migration.fromSchemaVersion} is already registered.`);
    }
    this.#steps.set(migration.fromSchemaVersion, migration);
    return this;
  }

  async migrate(document: unknown, sourceSchemaVersion: number, targetSchemaVersion: number): Promise<MigrationResult> {
    if (!Number.isSafeInteger(sourceSchemaVersion) || sourceSchemaVersion < 0
      || !Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 0) {
      throw new CadDocumentStoreError("MIGRATION_INVALID", "Migration schema versions must be non-negative safe integers.");
    }
    if (sourceSchemaVersion > targetSchemaVersion) {
      throw new CadDocumentStoreError("MIGRATION_INVALID", "Downgrade migrations are not supported.");
    }
    assertEmbeddedSchemaVersion(document, sourceSchemaVersion, "source document");
    let version = sourceSchemaVersion;
    let current = structuredClone(document);
    const appliedSteps: string[] = [];
    while (version < targetSchemaVersion) {
      const step = this.#steps.get(version);
      if (step === undefined || step.toSchemaVersion > targetSchemaVersion) {
        throw new CadDocumentStoreError(
          "MIGRATION_MISSING",
          `No complete migration path exists from schema ${version} to ${targetSchemaVersion}.`
        );
      }
      current = await step.migrate(structuredClone(current));
      assertEmbeddedSchemaVersion(current, step.toSchemaVersion, `migration '${step.id}' output`);
      version = step.toSchemaVersion;
      appliedSteps.push(step.id);
    }
    return deepFreeze({
      document: structuredClone(current),
      trace: { sourceSchemaVersion, targetSchemaVersion, appliedSteps }
    });
  }
}

function assertEmbeddedSchemaVersion(document: unknown, expected: number, label: string): void {
  if (typeof document !== "object" || document === null
    || (document as { readonly schemaVersion?: unknown }).schemaVersion !== expected) {
    throw new CadDocumentStoreError("MIGRATION_INVALID", `${label} does not declare schema version ${expected}.`);
  }
}
