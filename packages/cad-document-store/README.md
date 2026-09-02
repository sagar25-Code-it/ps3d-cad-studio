# PS3D canonical document store

This package provides an externally authorized, revision-safe persistence
boundary for canonical `CadDocument` records. It stores immutable snapshots
and append-only audit events, binds every mutation to an optimistic
compare-and-swap, and returns SHA-256 receipts suitable for later verification.

`preview()` is deliberately non-mutating. It validates and hashes a candidate
against the current snapshot. `apply()` accepts only that exact preview,
re-checks the live revision, and atomically appends both the snapshot and event.
Every create, preview, apply, state-head read, and commit read is checked through
the required `DocumentStoreAuthority`; preview authorization is signed and
verified again at apply. Preview payloads contain no process-local timestamp, and
the authority contract requires deterministic authorization, so identical
requests produce the same receipt across application nodes and restarts.

The store verifies the hash chain but does not, by
itself, prevent an attacker who can rewrite the entire storage history from
rolling it back. Production hosts therefore must anchor authorized heads in an
independent trusted system.

The stateless preview path does not reserve an idempotency key. It gives
deterministic replay for identical inputs, while an authority-backed registry is
required if a deployment must reject reuse of one preview idempotency key for a
different candidate before apply. Apply/create idempotency remains durable in
the project state. A preview is effectively single-head-use because its signed
base snapshot and revision must still be current when apply performs its CAS.

The package includes an in-memory adapter. `IndexedDbDocumentStoragePort` and
`ServerDocumentStoragePort` are contracts only: host applications must provide
their own durable implementations and enforce the same CAS, append-only
semantics, authority checks, and external head anchoring. No authentication
credentials, API keys, or other secrets belong in store keys, events, receipts,
or adapter configuration.

Migration functions are explicitly registered by source and target schema
version. Unknown or incomplete migration paths fail closed before persistence.
Each migration step is also checked to ensure its returned source and target
schema versions match the registered edge.
