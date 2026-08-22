# ADR 0001: Use a Permissive Mesh-Solid Kernel for the Bounded Phase 1 Solid Subset

**Status:** Proposed  
**Date:** 2026-08-19  
**Decision owners:** Project maintainers and geometry lead  
**Related requirements:** F1-07, F1-08, F1-09, F1-10, F1-12, F1-14

## Context

Phase 1 must produce valid closed solids for a deliberately narrow single-part
workflow in a browser. It must keep the interface responsive, contain geometry
failures, support deterministic regeneration evidence, and remain compatible
with the project's default permissive dependency policy.

Building a robust general solid kernel before the first release would dominate
the programme and make the existing Phase 1 schedule and reliability gates
unrealistic. Conversely, renderer-oriented triangle operations without a
solid-validity contract would not satisfy the requirement that every committed
body be closed, oriented, manifold, finite, and independently validated.

The official Manifold project describes a C++ geometry library for manifold
triangle-mesh solids, robust Boolean operations, cross sections, extrusion,
WASM/TypeScript bindings, and Apache-2.0 licensing. Its current official
release notes also report cross-platform double-precision determinism. These
are upstream statements to be qualified, not facts PS3D may inherit without
testing.

## Decision

Adopt the following Phase 1 direction, subject to dependency approval and the
Phase 0 geometry gate:

1. Use the official `manifold-3d` package as the candidate evaluated-solid
   implementation behind a project-owned `SolidKernel` port.
2. Keep box, cylinder, sketch, constraint, profile, extrusion, and Boolean
   operations as project-owned semantic feature definitions.
3. Treat every evaluated Phase 1 body as a manifold triangle-mesh solid. A
   mesh is derived state and never replaces the semantic feature document.
4. Limit supported operations to the Phase 1 PRD: box, cylinder, approved
   straight extrusion modes, and bounded union/subtraction/intersection.
5. Run the adapter in the model/geometry Web Worker. No dependency-specific
   object or pointer may cross the worker or package boundary.
6. Validate inputs and outputs using project-owned invariants in addition to
   the dependency status result.
7. Record the exact package version, artifact integrity, license, notices,
   compiler/WASM profile, and deterministic evidence only after review. This
   ADR does not install or approve a package and therefore does not add a
   dependency-inventory entry.
8. Keep a capability-based port so a later exact or NURBS/B-rep adapter can be
   evaluated without changing the semantic command layer.

## Phase 1 claim boundary

If the gate passes, the project may claim only that supported operations
produce validated manifold mesh solids within the published dimensional and
geometric envelope.

It must not infer or claim:

- exact analytic boundary surfaces after Boolean evaluation;
- general face/edge persistent naming;
- robust behavior for every tangent or near-coincident input;
- exact fillet, chamfer, shell, sweep, loft, or offset operations;
- standards-based exact solid exchange;
- arbitrary imported-mesh repair; or
- a production NURBS/B-rep kernel.

Analytic semantic definitions may provide exact parameter intent and sketch
measurements, but the evaluated Phase 1 Boolean solid and its area/volume are
mesh-derived under the recorded quality policy.

## Qualification gates

The dependency cannot enter an implementation branch until the source and
dependency policy is satisfied. It cannot become the production Phase 1
adapter until all of the following pass:

- exact version and transitive license review;
- reproducible serial WASM build or verified official artifact;
- original corpus covering each supported primitive, extrusion, and Boolean;
- adversarial near-coincident, tangent, degenerate, large/small scale, and
  resource-limit cases;
- independent edge-incidence, orientation, finiteness, bounds, and volume
  validation;
- deterministic replay and canonical mesh evidence across the supported
  browser and operating-system matrix;
- cancellation, worker termination, memory reclamation, and reconstruction;
- native-document regeneration and migration tests;
- STL export validation at every supported preset; and
- measured compliance with Phase 1 performance and memory budgets.

Any failing category is excluded from the supported envelope or keeps the
decision in Proposed status. A dependency's own test suite is useful evidence
but cannot substitute for the project-owned qualification corpus.

## Consequences

### Positive

- Phase 1 can focus on the semantic model, sketching, transactions,
  persistence, interaction, and conformance instead of a general exact kernel.
- The selected license is eligible for routine review under the project's
  allowlist, subject to exact artifact and notice verification.
- Worker-hosted WASM is compatible with a static browser deployment.
- A dedicated adapter confines dependency API and lifetime behavior.
- Closed mesh solids and STL export align with the deliberately narrow Phase 1
  output requirement.

### Negative

- Curved boundaries are polygonal in the evaluated solid.
- Boolean topology cannot support general persistent naming.
- Some valid mathematical configurations will remain outside the supported
  envelope and must fail explicitly.
- Area, volume, and exported geometry depend on the recorded tessellation
  policy.
- A later exact kernel is substantial additional work rather than a small
  internal replacement.

### Neutral safeguards

- Capability negotiation prevents future features from assuming unsupported
  exactness.
- The native document remains semantic, so later adapters can reevaluate old
  features under a new, explicitly versioned engine profile.
- Engine changes create new evidence; they do not silently rewrite the result
  associated with an earlier revision.

## Alternatives considered

### Implement a general exact solid kernel before Phase 1

Rejected for Phase 1. Robust intersections, trimming, topology,
classification, Booleans, healing, blends, and naming are multi-year work and
would make the bounded public release infeasible. It remains a future research
programme.

### Use renderer meshes and ad hoc triangle operations

Rejected. Renderer data has no sufficient solid validity, tolerance,
determinism, or failure contract and would couple persistent modeling to the
viewport.

### Adopt a permissive experimental NURBS/B-rep kernel immediately

Deferred. Apache-2.0 Truck is a research candidate because its official
project exposes geometry, topology, modeling, Boolean, tessellation,
JavaScript, and STEP-related crates. It is not selected for Phase 1 without a
separate capability and robustness qualification. Repository activity or API
breadth is not a production guarantee.

### Adopt a dependency outside the permissive allowlist

Rejected by default. It would require a separate legal and architecture
decision and is unnecessary for the approved mesh-solid Phase 1 scope.

## Official sources

- Manifold official repository and Apache-2.0 license:
  <https://github.com/elalish/manifold>
- Manifold official releases:
  <https://github.com/elalish/manifold/releases>
- Manifold official JavaScript `Manifold` API:
  <https://manifoldcad.org/docs/jsuser/classes/Manifold.html>
- Manifold official JavaScript `CrossSection` API:
  <https://manifoldcad.org/docs/jsuser/classes/CrossSection.html>
- Truck official repository and Apache-2.0 license:
  <https://github.com/ricosjp/truck>

Detailed source-use records are in
[`provenance/RESEARCH_SOURCES.md`](../../provenance/RESEARCH_SOURCES.md).

