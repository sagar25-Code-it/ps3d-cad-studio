# Phase 0 Vertical Slice

**Evidence date:** 2026-08-19  
**Application version:** `0.0.1-phase.0`  
**Engine profile:** `phase0-ps3d-bracket-mesh-1-serial-f64`  
**Status:** Implemented feasibility prototype; human provenance and release
review remain open

## What the slice proves

The slice carries one editable semantic part through the complete browser
path: unit-bearing input, constraint analysis, feature evaluation, independent
solid validation, commit, visualization, evidence, persistence, recovery, and
export. The model is a centered rectangle and circle, a plate extrusion, and a
centered subtractive passage. Stable semantic IDs survive regeneration and
history operations.

The semantic JSON is the source of truth. A serial Web Worker owns the
project-owned, bracket-specific f64 evaluator behind the `SolidKernel`
contract. That contract returns model-precision typed arrays, measurements,
and topology facts. The authoritative f64 mesh crosses the worker boundary so
the client can independently verify its evidence; f32 conversion happens only
inside the main-thread Three.js viewport adapter as a disposable render copy.

The production graph deliberately does not contain Manifold, WASM, or dynamic
code generation. Manifold 3.5.1 is retained only as an inventoried,
development-only candidate adapter for the proposed future general kernel ADR;
its official browser loader is incompatible with the strict Phase 0 CSP.

Every edit carries an expected revision and stable command ID. Retry lookup
precedes stale-revision handling: an exact ID-and-intent retry returns the
current committed model without evaluation, persistence, or a journal append;
reuse with different intent returns `IDEMPOTENCY_CONFLICT`. A candidate passes
schema, parameter-envelope, sketch, kernel, independent topology, evidence,
and persistence checks before replacing the current revision. Failed
candidates do not enter undo history.

The successful IndexedDB transaction is the command commit point. It stores a
version 2 record containing the document, evidence, and a domain-separated
evidence-payload hash in one transaction. A worker or message-channel failure
can lose the UI acknowledgement after that point; on restart the client asks
IndexedDB for the newest durable revision before using its in-memory fallback.
The worker replays the journal into bounded semantic projections to reconstruct
the legal undo and redo stacks, reports their authoritative depths, and
re-evaluates the stored evidence before acceptance. Recovery may therefore
surface a committed edit whose acknowledgement was lost without falling behind
durable state.

Opening native JSON uses a version 1 `ps3d-native-revision` envelope containing
the semantic document beside its evidence. Parsing verifies exact keys plus
semantic and journal bindings; a fresh worker then evaluates and compares the
complete evidence under the current build, writes the document and evidence to
IndexedDB, and only then publishes it to the UI. Bare document JSON, changed
evidence, and unsupported build identities fail closed.

Worker requests and responses use exact discriminated schemas. Unknown or
missing keys, malformed diagnostics, documents, evidence, measurements,
topology, render buffers, and export bytes are rejected. The client also binds
each accepted response variant to its pending request, recomputes semantic,
journal, and canonical f64 mesh hashes, and independently derives topology and
measurements from the transferred mesh. Bootstrap fallback and recovery origin
are correlated explicitly, and binary STL responses are checked for their
declared unit, triangle count, finite records, and exact byte length. A
malformed current-worker response terminates and restarts the worker instead
of waiting for a timeout.

## Supported envelope

| Quantity | Supported Phase 0 range |
| --- | ---: |
| Plate width | 5–500 mm |
| Plate height | 5–500 mm |
| Plate thickness | 1–100 mm |
| Bore diameter | 1–250 mm |
| Minimum centered wall | 1 mm |
| Bore tessellation | fixed at 96 segments |
| Native revision JSON | at most 1,000,000 bytes and 5,000 document-schema nodes |
| Evaluated mesh | at most 250,000 triangles |
| Worker request timeout | 15 seconds at the client boundary |

Lengths are evaluated in SI meters as finite binary64 values. Decimal input
always carries `mm` or `in`; display conversion is centralized and does not
alter the stored physical values. STL has no standard encoded unit, so export
requires and records an explicit millimetre or inch choice in its header and
filename.

## Qualification evidence

The default 60 × 40 × 10 mm plate with a regular 96-segment, 10 mm passage
evaluates to a single closed and consistently oriented manifold component with
genus 1 and 800 triangles. Its measured volume is approximately 23,215.16 mm³.
Four collinear vertices preserve the regular passage polygon while introducing
the exact non-square rectangle corners; square plates need no inserted corner
events and therefore use 768 triangles. The test
oracle independently derives the polygonal-bore volume as:

```text
plate volume - (96 / 2 × radius² × sin(2π / 96) × thickness)
```

Automated tests also exercise unit conversion, native-artifact corruption,
stale-revision rejection, exact retry/idempotency conflicts, failed-command
atomicity, restart-reconstructed stable-ID undo/redo,
underconstrained and conflicting sketches, minimum-wall rejection, canonical
JSON hashing, complete ordered-journal prefix hashing, insertion-order-independent
mesh hashing and malformed-mesh guards, exact worker-protocol variants and
adversarial payloads, document/evidence round trips, repeat regeneration, f64
authority/f32 viewport separation, exact
rectangle-minus-regular-polygon volume and area at both 500 × 5 mm extreme
aspect orientations, topology checks, and binary STL byte length. A separate
test qualifies—but does not ship—the Manifold candidate adapter.

On 2026-08-19 the pinned graph passed a frozen scripts-disabled install,
strict TypeScript checking, 24 independently authored tests, and a Vite
production build on Windows with Node.js 24.14.0 and pnpm 11.9.0. The build
gate recomputed the evaluator source closure, verified the bundled identity,
and rejected Manifold, WASM, and dynamic evaluation. A strict static server
verified the configured CSP plus `no-cache, must-revalidate` for `/` and a SPA
route and immutable caching for the content-hashed main and worker assets. An
executing in-app Chromium smoke test under those headers verified initial
worker evaluation, evidence display, body selection, parameter regeneration,
failed-edit rollback, and journal-reconstructed undo/redo across reload, with
no console warnings or errors. Two consecutive production builds emitted the
same eight paths, byte counts, and SHA-256 values. These are bounded results in
one local environment, not cross-platform determinism, a browser matrix, or
production certification.

## Explicit non-capabilities

The result is a closed, oriented manifold **triangle-mesh solid**. It is not an
exact boundary representation and does not provide analytic downstream faces,
persistent face/edge naming, tolerance-aware general CAD Boolean behavior, a
general constraint solver, arbitrary sketch entities, feature branching,
multiple bodies, assemblies, drawings, STEP/IGES import or export, cloud
collaboration, multi-user conflict resolution, accessibility certification,
or production reliability and security claims.

Canonical semantic and mesh SHA-256 hashes support replay comparison for this
engine profile. They are evidence records, not proofs of universal geometric
correctness. A future dependency, compiler, CPU, or browser change must be
qualified rather than assumed equivalent.

Evidence schema 3 records the human-assigned build ID, SHA-256 of the exact
ordinally listed evaluator source closure, and the production kernel adapter,
adapter version, dependency, dependency version, and representation. The
identity carrier is deliberately outside that listed closure, avoiding a
self-referential hash; `pnpm test` and `pnpm build` recompute the closure from
[`../provenance/BUILD_IDENTITY.json`](../provenance/BUILD_IDENTITY.json).

## Reproduce

With Node.js 24+ and pnpm 11.9.0:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

The dependency audit is in
[`../provenance/DEPENDENCY_AUDIT.md`](../provenance/DEPENDENCY_AUDIT.md), and
the governing numerical contract is
[`architecture/NUMERICAL_AND_GEOMETRY_CONTRACT.md`](architecture/NUMERICAL_AND_GEOMETRY_CONTRACT.md).
