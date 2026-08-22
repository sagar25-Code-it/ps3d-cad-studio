# ADR 0003: Make the Semantic Document Authoritative and Produce Revision Evidence

**Status:** Proposed  
**Date:** 2026-08-19  
**Decision owners:** Project maintainers, domain lead, and geometry lead  
**Related requirements:** F1-10, F1-11, F1-13, F1-15 and the accuracy,
reliability, maintainability, and recovery requirements

## Context

A parametric CAD document must preserve editable intent across regeneration,
undo/redo, recovery, migrations, renderer changes, and future geometry-engine
changes. A saved triangle mesh or a serialized dependency object cannot
preserve parameters, constraints, feature provenance, or a dependable
application boundary.

The project also needs reviewable evidence for claims that a revision rebuilt
under a specific engine profile. A screenshot or unversioned output file is
insufficient because it does not bind semantic input, dependency build,
tolerances, validity checks, and result geometry.

## Decision

The canonical document is a versioned semantic revision graph. Each immutable
revision records stable identifiers, unit-bearing parameter expressions,
datums, sketches, constraints, accepted sketch continuation state, ordered
features, logical bodies, names/visibility required by the PRD, provenance,
parent revision, and command identity.

Kernel objects, solver factorizations, tessellations, renderer buffers,
thumbnails, and exports are derived artifacts. They may be cached only under a
key that includes semantic input, engine identity, and numerical policy. Cache
deletion cannot change the document.

Every accepted modeling change is a semantic command with an expected base
revision and idempotency ID. UI interactions, imports, recovery, a later
backend, and future MCP writes use this same command boundary. Preview results
are not revisions. An already-committed ID is checked before the base revision:
the exact canonical intent and original parent is a no-op success, while any
different kind, parent, parameter, expression, or unit is an idempotency
conflict.

Every committed evaluated revision receives a versioned evidence record that
binds:

- canonical semantic document hash;
- parent and command-journal hashes;
- schema, solver, adapter, dependency, compiler, evaluator source-closure, and
  WASM identities;
- tolerance and tessellation policies;
- deterministic seed if any;
- per-body canonical mesh hashes and tolerant signatures;
- bounds, area, signed volume, and topology counts;
- validity checks and diagnostics; and
- replay verification status when measured.

Semantic JSON uses RFC 8785 JSON Canonicalization before SHA-256 hashing.
Binary artifacts are content-addressed separately. The exact canonical mesh
algorithm is versioned in the numerical contract.

## Stable identity and references

- Commands assign opaque semantic IDs; array positions and renderer IDs are
  never persisted as identity.
- Replay input includes assigned IDs, so replay does not create new ones.
- Feature dependencies reference semantic IDs and validated role selectors.
- Phase 1 supports only the reference roles required and proven by its
  acceptance workflows.
- A lost or ambiguous reference becomes an explicit broken reference.
- Geometric signatures may assist bounded recovery but cannot silently choose
  an arbitrary nearest entity.

General persistent naming after arbitrary topology-changing edits is outside
the Phase 1 contract.

## Revision and failure semantics

The current revision changes only after the complete candidate passes schema,
graph, parameter, sketch, profile, solid, resource, evidence, and persistence
gates. A failed command does not enter history.

Undo and redo move through committed semantic revisions or apply project-owned
history operations with equivalent immutable behavior. They do not depend on
reversing kernel operations. The journal is the sole persisted history state;
recovery replays it to rebuild bounded state projections and the legal undo and
redo stacks rather than persisting redundant stack arrays.

When regeneration fails, the prior valid derived body may remain visible as a
stale context artifact, while the failed feature and blocked downstream
features are identified separately. The stale body is never labeled as the
current successful evaluation.

## Native persistence

The Phase 0 native format is a versioned envelope that stores the semantic
revision beside its exact evidence. It records schema and producing engine
information but does not require a specific renderer or transient kernel
serialization. Import verifies the evidence's semantic and journal bindings,
then re-evaluates and compares the complete record under the current build.

Persistence atomically writes the semantic document, evidence, and a
domain-separated evidence-payload hash as one committed record. A migration
operates on a copy, is pure and versioned, validates the result, and commits
only when complete.
Unsupported major versions are rejected without modifying the source file or
last valid browser revision.

An optional evaluated-geometry cache may accelerate open but is untrusted
until its content hashes and engine profile match. Re-evaluation remains the
authoritative recovery path.

## Evidence interpretation

Evidence answers: "What semantic revision, engine build, numerical policy,
checks, and output bytes produced this result?" It supports reproducibility,
regression review, content addressing, and tamper detection.

The implemented Phase 0 build identity uses a human-assigned build ID plus a
SHA-256 over an ordinally sorted, explicit evaluator source closure. Its small
identity carrier is excluded from that closure, so the hash is not
self-referential. Build and test gates recompute it. This is a precise input
identity, not evidence that two clean builds are bit-for-bit identical.

Evidence does not prove that an algorithm is mathematically correct, that an
unsupported shape is manufacturable, or that two different engine versions
must produce the same mesh. A server may later sign an evidence envelope, but
a signature attests to the envelope's origin, not to universal geometric
correctness.

GPU raster output, timestamps, locale, worker scheduling, memory addresses,
and other transient presentation state are excluded from geometry hashes.

## Engine upgrades

The document records the engine profile associated with evaluated evidence.
Opening an old document with a new engine does not silently replace its prior
evidence. A user or migration process performs an explicit rebuild that creates
a new revision or rebuild record and reports semantic, topology, measurement,
and hash differences under the applicable policy.

Evidence schema and canonicalization changes are versioned. Old evidence
remains verifiable with its historical algorithm.

## Future backend and MCP

A later backend stores immutable semantic revisions and content-addressed
artifacts using the same hashes. Shared editing uses base-revision checks and
semantic commands; it does not merge derived geometry.

A future MCP server exposes structured resources and the same application
commands. Mutations require authorization, base revision, idempotency, dry-run
or preview, structured diff, explicit commit, and audit provenance. No MCP
tool receives permission to edit serialized storage or call a kernel directly.

The current MCP specification is model- and provider-neutral; the project's
resource and command schemas must remain domain-oriented rather than tailored
to one client.

## Consequences

### Positive

- Documents remain editable and portable across renderer and adapter changes.
- Undo, redo, recovery, imports, backend writes, and future MCP writes share
  one validation and transaction model.
- Geometry output can be reproduced and reviewed against a pinned engine.
- Derived caches can be safely discarded.
- Stable semantic IDs prevent viewport implementation details from becoming
  file-format commitments.

### Negative

- Schema design, migrations, canonicalization, evidence, and command history
  add up-front engineering work.
- Reopening without a valid cache may require complete regeneration.
- Engine upgrades can produce visible evidence differences that need explicit
  review and communication.
- Semantic references cannot solve general topology naming in the Phase 1
  mesh representation.

## Alternatives considered

### Save only the evaluated mesh

Rejected. It loses constraints, parameters, feature intent, and reliable
regeneration, and cannot satisfy the native-format requirements.

### Serialize live dependency objects

Rejected. Such data is dependency- and version-specific, may include unstable
internal identity, and would make recovery and migration dependent on an
uncontrolled binary representation.

### Treat UI actions as the persistent history

Rejected. Pointer events and presentation commands are not stable domain
semantics and cannot serve imports, recovery, a backend, or MCP consistently.

### Hash only the source document

Rejected. A source hash does not identify the engine build, numerical policy,
validity checks, or evaluated geometry whose reproducibility is being claimed.

### Hash screenshots

Rejected. Raster output depends on GPU, viewport, camera, fonts, and browser
presentation and is not geometry evidence.

## Official sources

- RFC 8785, JSON Canonicalization Scheme:
  <https://datatracker.ietf.org/doc/html/rfc8785>
- WebAssembly Core Specification:
  <https://www.w3.org/TR/wasm-core/>
- Model Context Protocol 2026-07-28 specification:
  <https://modelcontextprotocol.io/specification/2026-07-28>
- Model Context Protocol transport specification:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>

Detailed source-use records are in
[`provenance/RESEARCH_SOURCES.md`](../../provenance/RESEARCH_SOURCES.md).
