# PS3D CAD Studio System Architecture

**Status:** Proposed for Phase 0 approval  
**Date:** 2026-08-19  
**Scope:** Browser application foundation, bounded Phase 1 part modeling, and
extension boundaries for later product phases

## 1. Architectural position

PS3D CAD Studio is a local-first browser CAD application whose canonical state
is a semantic parametric document. Geometry evaluation is isolated from the
user-interface thread, rendering data is derived, and every consequential
model change crosses one versioned command boundary.

The Phase 1 product is intentionally bounded. It may become production-worthy
for the supported single-part workflow only after the Phase 0 qualification
and Phase 1 acceptance gates pass. Its solid representation is a closed,
oriented manifold triangle mesh derived from analytic feature definitions. It
is not an exact boundary-representation or NURBS system.

Exact trimmed surfaces, general persistent topology, advanced part features,
assemblies, standards-driven drawings, and professional exchange formats are
future work behind explicit capability boundaries. Those areas must not be
described as implemented merely because the architecture reserves space for
them.

This document is read together with:

- [Numerical and Geometry Contract](./NUMERICAL_AND_GEOMETRY_CONTRACT.md)
- [ADR 0001: Permissive Mesh-Solid Kernel](../adr/0001-permissive-mesh-solid-kernel.md)
- [ADR 0002: Worker Isolation](../adr/0002-worker-isolation.md)
- [ADR 0003: Semantic Document and Evidence](../adr/0003-semantic-document-and-evidence.md)
- [Phase 0 and Phase 1 PRD](../product/PRD_PHASE_0_1.md)
- [Product Roadmap](../product/ROADMAP.md)

### Phase 0 implementation disposition

The current browser slice instantiates `SolidKernel` with an original,
bracket-specific f64 mesh evaluator. It supports only the canonical rectangular
plate and regular 96-segment centered passage and is not a general Boolean
kernel. The proposed Manifold adapter remains a development-only qualification
candidate for Phase 1; it is not reachable from the production browser graph,
and no WASM artifact or dynamic code generation ships in Phase 0. References
below to WASM solvers and a general mesh-solid dependency describe gated future
adapters, not current runtime claims.

## 2. Governing principles

1. **Semantic source of truth.** Parameters, sketches, constraints, features,
   references, and document history are authoritative. Kernel objects and
   renderer buffers are disposable derived state.
2. **One mutation boundary.** The UI, imports, recovery, a future backend, and
   future MCP clients all submit the same validated semantic commands.
3. **Geometry off the UI thread.** Constraint solving, profile construction,
   solid evaluation, validation, measurement, and export run in a Web Worker.
4. **No kernel types outside an adapter.** The application depends on a
   project-owned solid-kernel contract, not on a specific dependency API.
5. **Capabilities are explicit.** Unsupported operations fail with typed
   diagnostics. An adapter never silently substitutes a weaker operation.
6. **Last valid state survives failure.** Preview, evaluation, migration,
   persistence, and export failures cannot replace the last committed valid
   document.
7. **Determinism is measured.** Stable ordering, pinned builds, replay tests,
   and evidence records support reproducibility. Architecture alone is not a
   claim of bit-for-bit determinism.
8. **Local first, backend ready.** Phase 1 works without an account or server.
   Storage, authorization, collaboration, and remote execution remain ports
   that later adapters can implement.
9. **Permissive dependency posture.** Project-owned material is MIT licensed.
   Dependencies retain their licenses and require inventory, notice, security,
   and reproducibility review before installation.

## 3. Runtime composition

```text
Browser main thread
  UI shell and command presentation
  Viewport and selection presentation
  Application session coordinator
             |
             | versioned commands, preview requests, cancellation
             v
Model and geometry Web Worker
  Boundary validation and transaction coordinator
  Parameter and feature-graph evaluator
  Sketch analysis -> project-owned bounded TypeScript evaluator
  Solid kernel port -> project-owned bracket-specific f64 evaluator
  Geometry validation and measurement
  Evidence generation
  Persistence port -> browser IndexedDB adapter
             |
             | transferable render buffers, semantic selection map,
             | diagnostics, measurements, revision evidence
             v
Browser main thread
  Viewport adapter -> three.js candidate
  Accessible structure, parameters, status, and error presentation
```

The worker is the sole owner of live solver and solid-kernel objects. The main
thread receives only immutable results such as typed-array render buffers,
bounding boxes, semantic selection identifiers, measurements, diagnostics,
and revision metadata. Raw WASM pointers, dependency-specific objects, and
renderer identifiers never enter the persistent document.

The initial runtime uses one serial model/geometry worker. Parallel WASM,
shared memory, and multiple concurrent evaluators are deferred until the
selected dependency, browser headers, cancellation model, memory behavior,
and deterministic reduction strategy pass a separate qualification gate.

## 4. Logical layers and dependency direction

### 4.1 Presentation

The presentation layer owns menus, commands, property editing, keyboard and
accessibility behavior, the feature/parameter structure, status, and viewport
interaction. It may request previews but cannot mutate document structures or
call geometry dependencies directly.

The viewport consumes a `RenderArtifact` concept containing positions,
normals, triangle indices, visible-edge data, bounds, and a semantic selection
map. Render precision and camera behavior are not modeling precision.

### 4.2 Application

The application layer coordinates use cases:

- create, open, save, and recover a document;
- validate, preview, commit, undo, and redo a command;
- regenerate dirty feature subgraphs;
- inspect parameters and measurements;
- request a supported export; and
- report typed errors without losing the last valid revision.

Every write supplies an expected base revision and an idempotency identifier.
Schema-invalid commands are rejected. A semantically valid command may be
previewed against an isolated candidate revision. Only a successful commit
advances history and persistence. Retry classification precedes stale-revision
handling: exact committed intent is returned without a second mutation, while
ID reuse with different intent fails explicitly.

### 4.3 Domain

The domain layer contains project-owned definitions for identifiers,
quantities, parameters, datums, sketches, constraints, profiles, features,
bodies, commands, diagnostics, revisions, and evidence. It imports no browser,
renderer, persistence, MCP, or geometry dependency.

### 4.4 Evaluation

The evaluator resolves parameter expressions, validates dependency graphs,
computes dirty nodes in stable order, invokes the sketch and solid ports, and
retains the previous valid output for a failed feature. Downstream features
receive a typed blocked state distinct from the originating failure.

Evaluation caches are addressed by the semantic input hash, adapter build
identity, numerical policy, and tessellation policy. A cache miss changes
performance, not document meaning.

### 4.5 Adapters

Adapters translate between project-owned ports and external systems:

- a sketch WASM bridge;
- a permissively licensed manifold mesh-solid kernel;
- browser persistence;
- three-dimensional rendering;
- native file packaging and STL export;
- a future HTTP backend;
- future exact-geometry, assembly, drawing, and exchange engines; and
- a future MCP server.

An adapter must validate dependency results before returning a domain result.
Its capability declaration and error mapping are part of its contract tests.

## 5. Proposed monorepo layout

No application package exists yet. The following is the intended ownership
map once implementation is authorized:

```text
apps/
  studio-web/              static browser application
  api/                     later project and collaboration service
  mcp-server/              later stdio and Streamable HTTP service
  geometry-runner/         later pinned server-side geometry jobs

packages/
  model-schema/            versioned boundary schemas and migrations
  domain/                  semantic CAD types and invariants
  commands/                validation, transactions, undo, and redo
  expression-engine/       unit-aware expression parsing
  evaluator/               feature graph and incremental regeneration
  sketch-kernel-api/       dependency-neutral solve contract
  solid-kernel-api/        dependency-neutral solid operation contract
  solid-manifold-adapter/  sole importer of the Phase 1 solid dependency
  assembly-kernel-api/     future rigid-assembly contract
  drawings/                future sheet and projection semantics
  import-export/           native file and format adapters
  worker-protocol/         versioned messages and transfer types
  persistence/             snapshots, journals, and storage ports
  evidence/                canonicalization, hashing, and verification
  viewport-three/          sole importer of the rendering dependency
  mcp-contract/            future resources, tools, and schemas
  ui/                      presentation components and design system

crates/
  numerics/                shared project-owned numerical policy
  sketch-solver/           Rust constraint solver compiled to WASM
  assembly-solver/         future rigid mate solver
  wasm-bridge/             narrow generated bindings

tests/
  models/                  original and generated model corpus
  kernel-contract/         adapter-neutral conformance cases
  determinism/             replay and cross-platform evidence checks
  import-fixtures/         independently created, approved fixtures
  browser/                 supported-browser scenarios
  performance/             published reference workloads
```

CI must enforce dependency direction. In particular, domain packages cannot
depend on adapters; viewport code cannot define persistent IDs; and only the
solid adapter can import the selected solid package.

## 6. Canonical document and revisions

A document revision contains, conceptually:

```text
schema version and document identifier
revision number, parent revision, and command identity
producing application and engine profile
display units and numerical policy identifier
named parameters and unit-bearing expressions
origin and user datums
sketches: plane, entities, constraints, accepted solution state
ordered feature graph and logical body identities
visibility, naming, and supported presentation state
external artifact references with hashes and provenance
revision diagnostics and evidence reference
```

Stable opaque IDs are assigned by commands and included in replay input. They
are never regenerated from array position. Numeric user input is preserved as
a canonical decimal expression with an explicit unit; evaluation produces SI
`f64` values. JavaScript evaluation is prohibited.

Kernel shapes, solver factorizations, render buffers, thumbnails, and export
meshes are derived artifacts. They may be cached with an engine-version key
but do not replace semantic features in the native file.

Feature references use semantic provenance such as an origin datum or a
feature-produced role. Phase 1 may support only the stable roles required by
its acceptance workflows. General recovery of arbitrary faces after topology
changes remains explicitly unsupported.

See ADR 0003 and the numerical contract for the evidence and reference rules.

## 7. Worker protocol and transaction lifecycle

A worker request includes a protocol version, request ID, operation kind,
base document revision, generation token, bounded payload, and optional
cancellation token. Each discriminated request and response has an exact key
set and exact nested validation. A response includes the matching identifiers,
status, typed diagnostics, proposed or committed revision, changed semantic
IDs, authoritative undo/redo depths, render buffers, and evidence metadata.

The lifecycle is:

1. Validate size, schema, IDs, graph structure, values, and base revision.
2. Apply the command to an isolated semantic candidate.
3. Resolve parameters and regenerate the affected subgraph in stable order.
4. Validate every changed sketch, profile, and solid.
5. For preview, return disposable results without history or persistence.
6. For commit, create the immutable revision and evidence record.
7. Persist the document, evidence, and evidence-payload hash atomically; this
   transaction completion is the command commit point.
8. Publish transferred render data and the committed revision to the UI.

If evaluation fails, the command is not committed and the prior valid
revision remains authoritative, matching the Phase 1 PRD. If the worker
terminates, the session coordinator starts a new worker and reconstructs from
the last complete document/evidence record and command journal. Journal replay
reconstructs the legal undo/redo projections. A transaction may have committed
before an acknowledgement was lost; an exact command retry returns that commit
without appending history. Partial worker state is never considered saved.

## 8. Phase 1 geometry scope

Subject to qualification, Phase 1 supports only the PRD's bounded set:

- principal datum planes;
- points, line segments, circles, circular arcs, and construction geometry;
- the approved geometric and dimensional constraint subset;
- validated closed planar profiles with documented hole-containment rules;
- analytic box and cylinder feature definitions;
- straight sketch extrusion in the approved modes;
- union, subtraction, and intersection inside the published conformance
  envelope;
- regeneration, inspection, and validated STL tessellation/export; and
- semantic references required by the release acceptance models.

The selected Phase 1 kernel represents evaluated solids as manifold triangle
meshes. Analytic primitive and sketch definitions remain semantic inputs, so a
mesh never becomes the parametric source of truth. All supported committed
bodies must pass the project validity checks described in the numerical
contract.

The following are not Phase 1 architecture claims: general mesh import,
revolve, sweep, loft, fillet, chamfer, shell, draft, patterns, exact curved
B-rep faces, assemblies, surface modeling, drawing sheets, STEP or IGES,
arbitrary topology repair, or MCP endpoints.

## 9. Future capability seams

### 9.1 Parametric depth

New features enter through canonical operations and capability declarations.
Each feature requires a supported geometry envelope, stable-reference policy,
deterministic fixtures, error semantics, migrations, and performance budget.

### 9.2 Assemblies

A future assembly layer references immutable part revisions through component
definitions and instances. Rigid mates operate on datums or qualified semantic
selectors. The solver represents each unfixed instance with six rigid-body
degrees of freedom, fixes one gauge per connected component, and reports
remaining DOF, redundant mates, and conflicting loops. Small assemblies must
qualify before larger hierarchies or motion behavior are claimed.

### 9.3 NURBS and exact solids

An exact kernel remains behind the `solid-kernel-api`. Required work includes
curves and surfaces, B-rep topology, parameter-space trims, robust
curve/surface and surface/surface intersections, classification, splitting,
stitching, healing, booleans, offsets, blends, and persistent naming. This is
a multi-year specialist effort or a separately qualified permissive adapter.
Its tessellation would remain derived viewport data.

### 9.4 Drawings and exchange

Early drawings may use documented faceted projections but cannot be described
as exact manufacturing drawings. Exact hidden-line removal, sections,
associativity, tolerancing, and robust projected curves depend on exact
geometry and their own conformance plan.

Each import/export format has an isolated adapter, supported-subset statement,
unit policy, resource limits, round-trip policy, and error report. Imported
meshes remain non-parametric reference or mesh bodies; import does not infer a
feature history.

### 9.5 Model-neutral MCP

The future MCP service exposes domain resources and application commands, not
viewport actions or kernel calls. Read operations can return document,
feature, measurement, validation, and evidence resources. Mutations use an
atomic command batch with a base revision, idempotency key, validation/dry-run
mode, structured diff, explicit authorization, and audit actor.

The static web application is not itself an inbound server. A later local CLI
may serve stdio, and an authenticated backend may serve Streamable HTTP. Both
use the same command layer and schemas, so the protocol is independent of any
AI model or provider.

## 10. Persistence

Phase 1 uses IndexedDB behind `ModelRepository` for immutable revision and
evidence records, a command journal, autosave staging, and disposable caches.
A versioned native document-plus-evidence download remains the portable
user-controlled backup. Browsers
without a direct file-system API use upload/download without weakening the
document format.

Persistence uses a two-step staged write and commit marker, or an equivalent
single IndexedDB transaction. Startup chooses only the complete head record,
validates its document/evidence binding, and re-evaluates it before acceptance.
Migrations run against a copy and commit only after schema and graph
validation. Cache eviction cannot delete canonical revisions.

Later, an HTTP repository adapter may store revision metadata in a relational
database and content-addressed archives/evidence in object storage. Shared
editing uses optimistic revision checks and semantic commands; it does not
merge derived meshes.

## 11. Static deployment and later services

The Phase 1 site is a Vite-generated static application suitable for Vercel.
The output consists of an HTML entry point and content-hashed JavaScript,
worker, WASM, and asset files. Deployment requirements include:

- correct `application/wasm` content type;
- immutable caching for hashed assets and revalidation for the HTML shell;
- a single-page rewrite that does not swallow asset paths;
- a restrictive Content Security Policy and no runtime CDN code;
- same-origin worker and WASM loading;
- file and document resource limits before evaluation; and
- no project-content upload during ordinary local modeling.

Cross-origin isolation headers are introduced only if a later, qualified
shared-memory build requires them. They are not needed for the initial serial
worker design.

Later services may add authentication, project access control, revision
storage, collaboration notification, MCP, and queued geometry or exchange
jobs. Heavy geometry jobs run in pinned, memory-controlled worker containers;
the static front end remains independently deployable.

## 12. Security boundaries

- Native files and imported formats are untrusted data.
- Parsers enforce byte, entity, nesting, graph, string, and execution limits.
- Expressions use a bounded unit-aware grammar and never execute code.
- WASM modules receive only the host functions required by the adapter.
- The main thread can terminate and reconstruct a failed or unresponsive
  worker.
- No dependency is fetched dynamically from an undeclared URL.
- A future remote write requires authentication, authorization, base-revision
  validation, idempotency, audit provenance, and user-visible consent.
- Logs and diagnostics exclude model geometry unless a user explicitly
  attaches it.

## 13. Verification and architecture gates

Before Phase 1 implementation is approved, Phase 0 must establish:

- the supported dimensional and entity envelope;
- the sketch solver's rank, conflict, convergence, and perturbation behavior;
- the mesh-solid adapter's validity and Boolean conformance corpus;
- deterministic replay and evidence behavior across the supported matrix;
- worker cancellation, termination, memory, and reconstruction behavior;
- native schema validation, migration, atomic save, and recovery behavior;
- STL tessellation error and manifoldness checks;
- dependency versions, integrity hashes, licenses, notices, and SBOM process;
  and
- measured feasibility against the PRD performance budgets.

Failure of a gate narrows the published feature envelope or extends Phase 0.
It does not justify weakening the contract or describing unqualified behavior
as supported.

## 14. Licensing boundary

Project-authored implementation remains MIT licensed. A repository-level MIT
license applies only to material the project owns. Every third-party package,
generated binding, WASM binary, transitive dependency, and asset retains its
own license and notice obligations.

Candidate dependencies named in this design are research candidates, not
installed or approved dependencies. Before use, an exact version, canonical
artifact, integrity hash, license expression, purpose, scope, approval, and
notice requirements must be recorded in the provenance inventory. Apache-2.0,
MIT, BSD, ISC, and other policy-allowed components may coexist with the
project's MIT code when their respective terms and notices are preserved.

The release process must generate and review a third-party notice file and
SBOM from the locked dependency graph. No architecture decision overrides the
default-deny source and dependency policy.
