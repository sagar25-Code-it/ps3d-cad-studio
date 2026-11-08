import type { OperationAuditEntry, WorkbenchProject } from "./types.js";

/**
 * Rolling compaction of the revision audit.
 *
 * Every operation adds one audit entry and the audit is stored in the project file, so it is bounded. Instead of freezing the
 * project when the bound is reached, the oldest entries are folded into one checkpoint entry: it keeps the revision number of the last
 * entry it replaced (so revisions stay consecutive and `revision` still equals the last entry), counts how many operations it stands
 * for, and carries a SHA-256 chain digest over every folded entry in order. A later fold chains onto the earlier checkpoint's digest,
 * so a retained entry cannot be swapped out after the fact without the digests of every later checkpoint no longer matching a replay.
 */
export const AUDIT_CHECKPOINT_KIND = "audit-checkpoint" as const;
/** Entries kept in full after a compaction. */
export const AUDIT_KEEP_FULL = 500;
/** The audit is compacted when it would otherwise pass this many entries (the checkpoint counts as one). */
export const AUDIT_MAX_ENTRIES = 1_000;

export interface AuditCheckpoint {
  readonly firstRevision: number;
  readonly lastRevision: number;
  /** How many operations were folded in all, across every earlier fold. */
  readonly operations: number;
  /** Hex SHA-256 chain digest over the folded entries. */
  readonly digest: string;
}

export interface AuditCapacity {
  /** Entries held in the file right now (a checkpoint counts as one). */
  readonly used: number;
  readonly limit: number;
  /** Operations the checkpoint stands for (0 when the audit was never compacted). */
  readonly foldedOperations: number;
  /** Every operation the project has had. */
  readonly totalOperations: number;
  /** Operations that can still be applied before the next automatic compaction. */
  readonly untilCompaction: number;
  /** used / limit, 0 to 1. */
  readonly fraction: number;
  readonly label: string;
}

export function auditCheckpointOf(entry: OperationAuditEntry | undefined): AuditCheckpoint | undefined {
  return entry !== undefined && entry.kind === AUDIT_CHECKPOINT_KIND ? entry.checkpoint : undefined;
}

/** The visible capacity of a project's audit trail, for the status area and the health panel. */
export function auditCapacity(project: Pick<WorkbenchProject, "audit" | "revision">): AuditCapacity {
  const folded = auditCheckpointOf(project.audit[0])?.operations ?? 0;
  const used = project.audit.length;
  const untilCompaction = Math.max(0, AUDIT_MAX_ENTRIES - used);
  return {
    used,
    limit: AUDIT_MAX_ENTRIES,
    foldedOperations: folded,
    totalOperations: project.revision,
    untilCompaction,
    fraction: Math.min(1, used / AUDIT_MAX_ENTRIES),
    label: folded === 0 ? `${used} of ${AUDIT_MAX_ENTRIES} history entries` : `${used} of ${AUDIT_MAX_ENTRIES} history entries (${folded} older operations compacted)`
  };
}

function canonicalEntry(entry: OperationAuditEntry): string {
  return JSON.stringify([entry.revision, entry.operationId, entry.kind, entry.intentKey, entry.summary, entry.changedIds, entry.checkpoint === undefined ? null : [entry.checkpoint.firstRevision, entry.checkpoint.lastRevision, entry.checkpoint.operations, entry.checkpoint.digest]]);
}

/**
 * Folds every entry except the last `keep` into one checkpoint at the front. Returns the audit unchanged when it already holds `keep`
 * entries or fewer. The revision numbers and the last `keep` entries are untouched.
 */
export function compactAudit(audit: readonly OperationAuditEntry[], keep: number = AUDIT_KEEP_FULL): readonly OperationAuditEntry[] {
  const retained = Math.max(1, Math.floor(keep));
  if (audit.length <= retained) return audit;
  const folding = audit.slice(0, audit.length - retained);
  const rest = audit.slice(audit.length - retained);
  const earlier = auditCheckpointOf(folding[0]);
  let digest = earlier?.digest ?? "0".repeat(64);
  let operations = earlier?.operations ?? 0;
  for (const entry of folding) {
    if (entry === folding[0] && earlier !== undefined) continue;
    digest = sha256Hex(`${digest}\n${canonicalEntry(entry)}`);
    operations += 1;
  }
  const last = folding[folding.length - 1]!;
  const checkpoint: OperationAuditEntry = {
    revision: last.revision,
    operationId: `operation:audit-checkpoint-${last.revision}`,
    kind: AUDIT_CHECKPOINT_KIND,
    intentKey: `checkpoint:${digest}`,
    summary: `Compacted ${operations} earlier operation${operations === 1 ? "" : "s"} (revisions ${earlier?.firstRevision ?? folding[0]!.revision} to ${last.revision}) into this checkpoint.`,
    changedIds: [],
    checkpoint: { firstRevision: earlier?.firstRevision ?? folding[0]!.revision, lastRevision: last.revision, operations, digest }
  };
  return [checkpoint, ...rest];
}

/** Compacts a project's audit on request, keeping the last `keep` entries. The revision does not change. */
export function compactWorkbenchAudit(project: WorkbenchProject, keep: number = AUDIT_KEEP_FULL): WorkbenchProject {
  const audit = compactAudit(project.audit, keep);
  return audit === project.audit ? project : { ...project, audit };
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (synchronous, so the pure reducers can chain digests without WebCrypto)
// ---------------------------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (value: number, amount: number): number => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + choice + K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}
