# ADR 0002: Isolate Model Evaluation and Geometry in a Web Worker

**Status:** Proposed  
**Date:** 2026-08-19  
**Decision owners:** Project maintainers, application lead, and geometry lead  
**Related requirements:** F1-10, F1-11, F1-13, F1-15 and the performance,
reliability, and security requirements

## Context

Sketch solving, profile construction, solid Booleans, validation,
tessellation, measurement, hashing, and export can consume unpredictable CPU
time and memory. Running these operations on the browser main thread would
compete with input, accessibility, and rendering and would leave no strong
recovery boundary for a stalled or failed geometry operation.

WASM dependencies also have explicit object lifetimes and linear memory that
must not leak into UI state. Cancellation cannot be treated as a boolean UI
flag if a synchronous kernel call is already executing.

## Decision

Use one dedicated model/geometry Web Worker as the Phase 1 owner of:

- the current semantic document revision used for evaluation;
- parameter and feature-graph evaluation;
- sketch-solver WASM state;
- mesh-solid WASM state and live shape handles;
- profile construction, solid validation, measurement, and STL generation;
- canonical geometry evidence generation; and
- the browser persistence adapter for committed revisions and caches.

The main thread owns presentation, accessible controls, viewport rendering,
and session coordination. It communicates through a project-owned, versioned,
typed message protocol.

No raw kernel object, WASM pointer, dependency-specific exception, mutable
mesh object, or renderer object crosses the boundary. Large immutable render
and export buffers use transferable `ArrayBuffer` ownership. Semantic IDs and
selection maps accompany buffers separately.

## Protocol requirements

Every request includes:

- protocol version;
- request and operation identifiers;
- expected document revision;
- generation token;
- bounded, schema-validated payload; and
- cancellation identifier where applicable.

Every response includes the matching identifiers, completion state, typed
diagnostics, resulting or candidate revision information, changed semantic
IDs, transfer metadata, and evidence reference where applicable.

Responses from an obsolete generation are discarded. Unknown protocol
versions or message kinds fail closed. Error stacks and dependency exceptions
are mapped to stable project diagnostics before reaching ordinary UI state.

## Transaction and cancellation behavior

- Previews evaluate an isolated candidate and never enter undo history or
  persistence.
- Commits advance the document only after semantic, sketch, profile, solid,
  and evidence gates pass.
- The prior valid revision remains authoritative while work is in flight.
- Cooperative cancellation is used only where the qualified dependency and
  operation prove it safe.
- A hard timeout or unresponsive synchronous call causes worker termination.
- After termination, a new worker loads the last complete document/evidence
  record and replays the validated journal to reconstruct history. If the
  atomic transaction completed before acknowledgement was lost, that command
  is committed; retrying its exact ID and intent returns the commit without a
  second evaluation or journal entry.
- Disposable dependency objects are released at operation or evaluation-arena
  boundaries. Memory growth and reconstruction are stress tested.

## Concurrency profile

Phase 1 uses serial geometry evaluation inside one worker. This gives stable
ownership, bounded transaction ordering, a simpler memory model, and a
determinism baseline. The UI remains concurrent because worker computation is
off the main thread.

WASM threads, `SharedArrayBuffer`, cross-origin isolation, worker pools, and
parallel reductions are deferred. They require a new decision with browser
header compatibility, dependency safety, deterministic ordering, cancellation,
memory, and performance evidence. They must not be enabled solely because the
platform supports them.

## Persistence interaction

The worker stores the committed document, evidence, and a domain-separated
evidence-payload hash in one IndexedDB transaction or equivalent atomic
protocol. Transaction completion makes the revision eligible for recovery.
Derived cache writes may fail or be evicted without invalidating canonical
revisions.

The session coordinator can request an explicit native-file snapshot. The
worker returns a validated, bounded binary artifact; the main thread performs
the user-mediated download without interpreting the model.

## Security effects

Worker isolation protects interaction and provides a kill/recovery boundary,
but it is not treated as a complete security sandbox. The worker still
receives untrusted document data and therefore enforces byte, graph, entity,
string, expression, triangle, time, and memory limits. WASM modules receive
only narrow approved host imports.

No document content may direct the worker to fetch code, load a module, open an
arbitrary path, or evaluate a script.

## Consequences

### Positive

- Long geometry work does not directly block browser input and accessibility.
- A failed or stuck kernel can be terminated without accepting partial state.
- WASM lifetimes and dependency APIs are confined to one runtime boundary.
- The same protocol supports deterministic tests, recovery simulation, and a
  later server-side runner.
- Transferable buffers avoid copying large meshes to the viewport.

### Negative

- Every command and result requires an explicit serializable schema.
- Debugging spans two execution contexts.
- Worker startup, WASM initialization, replay, and transfer costs require
  performance budgets.
- Hard cancellation rebuilds worker state and may be visibly slower than
  cooperative cancellation.
- Browser persistence and worker lifecycle differences require a full
  supported-browser matrix.

## Alternatives considered

### Evaluate on the main thread

Rejected. It cannot meet the interaction, failure containment, or hard
cancellation requirements for unpredictable geometry workloads.

### Move only the solid kernel to a worker

Rejected. Splitting parameter, sketch, feature, and solid ownership would
require mutable intermediate state and additional race-prone transactions
across the boundary.

### Use a worker pool in Phase 1

Deferred. Feature dependencies and live kernel-handle ownership make naive
parallel evaluation unsafe. A pool may later process independent documents or
components after stable ordering and memory behavior are proven.

### Require a backend for geometry

Rejected for Phase 1. It conflicts with the no-account local-first requirement
and would make ordinary modeling dependent on network availability and remote
data handling.

## Official sources

- WHATWG HTML living standard, Web Workers:
  <https://html.spec.whatwg.org/multipage/workers.html>
- W3C WebAssembly Core Specification:
  <https://www.w3.org/TR/wasm-core/>
- `wasm-bindgen` official repository and MIT/Apache-2.0 licenses:
  <https://github.com/wasm-bindgen/wasm-bindgen>
- Comlink official repository and Apache-2.0 license; retained as an optional
  protocol-helper candidate rather than an architectural requirement:
  <https://github.com/GoogleChromeLabs/comlink>

Detailed source-use records are in
[`provenance/RESEARCH_SOURCES.md`](../../provenance/RESEARCH_SOURCES.md).
