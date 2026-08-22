# Numerical and Geometry Contract

**Status:** Proposed; Phase 0 measurements and conformance results are required
before production defaults are approved  
**Date:** 2026-08-19  
**Applies to:** Parameters, sketches, profiles, solid evaluation,
tessellation, measurement, persistence, replay, and geometry evidence

## 1. Purpose

This contract defines what PS3D CAD Studio means by a valid, repeatable result.
It separates modeling values from display values, names the tolerances that
algorithms may use, specifies failure behavior, and establishes evidence and
test requirements.

The contract does not establish numerical constants by assertion. Phase 0 must
measure and publish the supported dimensional envelope, default tolerances,
entity limits, and performance limits. Until those values pass the required
corpus and browser matrix, they remain undecided.

The words **must**, **must not**, **should**, and **may** are normative within
this project document.

## 2. Representation boundary

Four representations have distinct responsibilities:

1. **Semantic model:** exact user intent as unit-bearing decimal expressions,
   constraints, analytic feature definitions, references, and stable IDs.
2. **Solver state:** finite `f64` values, branch choices, scaled residuals, and
   the last accepted solution used for continuation.
3. **Phase 1 solid state:** a closed, oriented manifold triangle mesh in the
   worker, derived from semantic features.
4. **Render state:** disposable GPU-oriented buffers, normally `f32`, derived
   from the evaluated body and camera-relative origin.

Conversion to a mesh or `f32` render buffer must not overwrite the semantic
definition. Display facets must not be presented as additional modeling
precision. Exact trimmed surfaces and B-rep topology are not Phase 1
representations.

## 3. Supported dimensional envelope

Before public release, Phase 0 must approve and publish:

- minimum and maximum representable model extents;
- minimum supported nonzero length and radius;
- maximum coordinate magnitude relative to model extent;
- permitted feature count, body count, sketch entity count, constraint count,
  and output triangle count;
- default and maximum export tessellation density;
- maximum native file size, graph depth, string length, and expression depth;
  and
- memory and execution-time limits for worker operations.

Inputs outside the published envelope must produce `RESOURCE_LIMIT` or
`OUTSIDE_SUPPORTED_ENVELOPE`, not a plausible-looking unqualified result.
Limits are part of the document engine profile and release evidence.

## 4. Units and quantities

- Lengths are evaluated in SI meters and angles in radians.
- The UI may display approved length and angular units without changing the
  stored semantic expression.
- A literal entering the document must carry a unit or be interpreted through
  the document's explicitly recorded input-unit policy.
- User-entered decimal text is preserved in canonical form. Evaluation yields
  a finite `f64` value; serialization never depends on locale.
- Dimension analysis rejects addition or comparison of incompatible
  quantities and rejects non-dimensionless arguments to functions that
  require dimensionless values.
- Unit conversion is centralized. Geometry adapters do not invent their own
  document-unit behavior.
- Export adapters must state the output unit or clearly require the user to
  select it when the format does not encode units.

The expression engine implements a bounded grammar. It must not call
JavaScript evaluation, load modules, access network or storage, or execute
document-provided code.

## 5. Scalar arithmetic

- Model evaluation, sketch solving, worker-side transforms, validation, and
  measurement use IEEE-754 binary64 values.
- Coordinates, residuals, derivatives, and measurements must be finite at
  every committed boundary. NaN and infinity are errors.
- Negative zero is normalized to positive zero before canonical serialization
  or hashing.
- Renderer conversion to binary32 occurs only after model-space validation and
  optional origin rebasing.
- Fast-math and other transformations that relax IEEE behavior are disabled
  in the deterministic build profile.
- Any randomized algorithm uses a seed recorded in the semantic input or
  engine profile. Unseeded randomness is prohibited in committed evaluation.

## 6. Tolerance policy

There is no universal `epsilon`. A versioned `TolerancePolicy` distinguishes:

- `lengthAbsolute`: lower bound for supported length comparisons;
- `lengthRelative`: scale-dependent length comparison;
- `angle`: angular comparison and constraint residual threshold;
- `parameter`: curve/surface parameter comparison;
- `coincidence`: explicit point/vertex clustering threshold;
- `degeneracy`: minimum supported edge, area, and volume checks;
- `solverResidual`: normalized constraint convergence threshold;
- `rank`: numerical rank classification threshold;
- `tessellationChord`: maximum permitted chord deviation;
- `tessellationAngle`: maximum permitted change of surface direction; and
- `measurementDisplay`: presentation rounding only, never validity.

Each operation receives the policy explicitly. An adapter must not rely on an
unrecorded mutable global default. If a dependency requires internal defaults,
the adapter must set or capture them as part of the engine profile.

For a length comparison, the effective bound is based on the greater of the
approved absolute tolerance and the relative tolerance multiplied by a
documented local characteristic scale. The relevant scale is chosen per
algorithm, such as sketch component extent, profile extent, or body extent.
Using world-coordinate magnitude as the only scale is prohibited.

Tolerance is not permission to alter semantic input silently. Vertex merging,
profile closure, healing, or snapping occurs only in a named operation with a
reported displacement bounded by the applicable policy. If a required repair
would exceed that bound, evaluation fails.

## 7. Parameter and feature evaluation

- Parameter dependencies and feature dependencies must be acyclic.
- Nodes are evaluated in a stable order derived from explicit IDs and feature
  order keys, never object-map enumeration or worker scheduling.
- A derived-cache key includes semantic inputs, dependency revision hashes,
  engine build identity, tolerance policy, and tessellation policy where
  applicable.
- Cache hits and misses must produce equivalent committed results.
- The same committed revision cannot be evaluated concurrently by multiple
  writers in one worker.
- Changing an engine or policy creates a new evaluated revision or an explicit
  rebuild comparison; it does not rewrite prior evidence.

If a feature fails, its previous valid derived artifact may remain visible for
context but is marked stale. Dependent features are marked blocked. Neither
artifact is represented as the current valid result.

## 8. Sketch entity model

The bounded Phase 1 entity set consists of points, finite line segments,
circles, circular arcs, and construction variants. Every entity has a stable
semantic ID and a finite parameterization.

- Points use two planar coordinates.
- Lines refer to two points and must not collapse below the degeneracy bound.
- Circles use a center and positive radius.
- Arcs use a center, positive radius, oriented angular interval, and an
  explicit branch/orientation state.
- Construction geometry participates in solving but not closed-profile output
  unless explicitly converted by a command.

The solver may internally use a transformed parameterization, such as a log
radius to preserve positivity, provided the mapping and diagnostics are
deterministic and do not change serialized intent.

## 9. Constraint solver contract

### 9.1 Supported behavior

The Phase 1 solver is required to support only the constraint set approved in
the Phase 1 PRD. Each constraint maps to a documented residual block and
derivative. Length residuals are normalized by component scale; angular
residuals are dimensionless.

The recommended method is a project-owned damped Gauss-Newton or
Levenberg-Marquardt solver using analytic derivatives or project-owned
dual-number automatic differentiation, with linear algebra supplied through a
reviewed permissive dependency. The solver design remains project-owned even
when it uses a matrix library.

### 9.2 Stable solving

The solver must:

- split disconnected constraint components;
- eliminate fixed variables where practical;
- use the previous accepted state as the continuation point;
- preserve explicit branch tokens for arc orientation, tangency side, and
  periodic angle choice;
- use deterministic variable, residual, and pivot tie-breaking order;
- bound iterations and execution time;
- return the best finite candidate and a failure reason without committing it
  when convergence criteria are not met; and
- distinguish a temporary drag objective from a committed hard constraint.

An underconstrained sketch is stabilized by minimum displacement from the last
accepted solution. It must not jump to an unrelated mathematically valid
branch after a small edit.

### 9.3 Rank and diagnostics

Rank-revealing linear algebra classifies a component as:

- underconstrained, with remaining degrees of freedom;
- fully constrained;
- redundantly constrained; or
- inconsistent/overconstrained.

The result includes normalized maximum and RMS residual, estimated rank,
degrees of freedom, iteration count, termination reason, redundant-constraint
candidates, and a bounded conflict set when inconsistency is detected.

A conflict set is diagnostic evidence, not a proof that it is the unique
minimal set. The UI must use wording consistent with that limitation.

### 9.4 Acceptance

A committed solve must meet all of the following:

- every value is finite;
- normalized residuals meet the approved convergence policy;
- entity positivity and domain invariants hold;
- repeated solve from the recorded accepted state selects the same branch;
- reported rank and DOF agree with the qualification fixtures; and
- the solution lies inside the supported envelope.

## 10. Closed-profile construction

Profile creation is separate from constraint solving. A solved sketch may be
valid while containing no usable closed profile.

The profile builder must:

1. Select only non-construction entities requested by the feature.
2. Resolve intersections and endpoints under the explicit coincidence policy.
3. Reject zero-length edges, invalid arcs, duplicate traversals, open chains,
   and ambiguous branch points.
4. Detect self-intersections and overlapping boundaries.
5. Build deterministic loops with consistent orientation.
6. Classify containment and holes under a documented even/odd or winding
   rule selected for the file-format version.
7. Reject touching or nested cases outside the approved Phase 1 envelope.
8. Approximate curved edges using the recorded tessellation chord and angular
   bounds before transfer to the mesh-solid kernel.

Topology decisions should use robust orientation predicates or another
qualified method. Raw comparisons to a single floating-point epsilon are not
acceptable for loop topology.

## 11. Phase 1 solid contract

### 11.1 Solid representation

The evaluated Phase 1 body is a finite, closed, oriented manifold triangle
mesh. The semantic document retains analytic box, cylinder, sketch, and
extrusion parameters, but the solid Boolean result is mesh-based.

The proposed mesh-solid adapter uses a permissively licensed dependency behind
the `SolidKernel` port, subject to Phase 0 qualification and provenance
approval. No dependency claim replaces project conformance testing.

### 11.2 Supported operations

Only operations approved by the Phase 1 PRD can be committed:

- analytic-definition box and cylinder construction;
- bounded straight extrusion of an approved profile;
- union, subtraction, and intersection within the published corpus; and
- rigid transform required by those features.

Other operations may be explored in Phase 0 but are not supported until a
scope change adds their semantic definition, numerical envelope, tests,
migration behavior, and error contract.

### 11.3 Input requirements

Before a solid operation, the adapter validates:

- finite coordinates and transforms;
- supported scale and triangle-count envelope;
- valid profile orientation and containment;
- nondegenerate primitive parameters;
- manifold, consistently oriented input bodies; and
- operation-specific preconditions.

An invalid imported or intermediate mesh is not passed through in the hope
that a later Boolean repairs it.

### 11.4 Output validity

Every committed body must pass independent project checks:

- all positions and computed measurements are finite;
- every triangle has three valid, distinct indices;
- triangles exceed the approved degeneracy threshold;
- each undirected edge has exactly two incident oriented triangle sides;
- connected shell components are closed and consistently oriented;
- signed volume has the expected orientation and exceeds the approved minimum;
- no kernel error status is present;
- bounds and counts remain inside resource limits; and
- the body can be serialized to the canonical mesh-evidence representation.

Self-intersection checks use the qualified kernel result plus independently
defined adversarial and metamorphic tests. A simple edge-incidence check alone
does not prove geometric non-self-intersection.

### 11.5 Boolean failure

A Boolean either returns a body satisfying the complete output contract or a
typed error. It must not commit an open, non-manifold, nonfinite, partially
updated, or unsupported result. Near-coincident and tangent cases outside the
published conformance envelope return `UNSUPPORTED_GEOMETRIC_CASE` rather
than being advertised as generally robust.

## 12. Tessellation and rendering

The Phase 1 solid is already polygonal, but analytic feature construction and
export quality still use an explicit tessellation policy.

- Chord and angular tolerances are stored in the engine/export request.
- Segment-count tie-breaking and loop traversal are deterministic.
- Export presets resolve to concrete numerical policies recorded in evidence.
- Coarser viewport buffers may be derived for interaction but never replace
  the validated body or fine export result.
- Render normals and edge classifications are presentation attributes and are
  excluded from semantic hashes unless an export format makes them normative.
- Large-coordinate scenes use a render origin so conversion to `f32` does not
  alter worker-space geometry.

STL export includes only a selected valid body, preserves orientation, states
the chosen unit in the export flow, and is revalidated after serialization or
round-trip parsing in release tests.

## 13. Measurement

- Point coordinates, analytic line lengths, and circle/arc radii derive from
  semantic sketch data when that data remains applicable.
- Body bounds, area, and volume derive from the validated evaluated solid and
  identify the engine and tolerance profile when recorded as evidence.
- Display rounding is chosen from uncertainty and unit context. It must not
  imply more precision than the geometry contract supports.
- Measurement algorithms use stable summation or deterministic accumulation
  order where aggregate results affect evidence.
- Mass properties outside the supported scale or conditioning envelope return
  a typed limitation rather than an unqualified number.

## 14. Transforms

Model-space transforms are `f64` affine transforms. Phase 1 committed solid
features use only the transform classes explicitly required by approved
features. Singular transforms, reflection without orientation correction, and
nonuniform scale of semantic analytic primitives are rejected unless a later
feature contract defines their meaning.

Composition order is explicit. Matrices, axes, and handedness have one
project-wide convention documented in the model schema before implementation.
Adapters translate at their boundary and test round trips.

## 15. Semantic topology references

A persisted reference identifies semantic provenance, not an array index:

```text
producer feature ID
declared role such as top, bottom, side from source edge, or datum
representation kind and optional local parameters
geometric signature used only as a bounded recovery aid
```

Phase 1 supports only roles demonstrated by its acceptance workflows. A
reference that no longer resolves uniquely becomes broken and blocks its
dependent feature. A nearest-face guess must not be committed silently.

General naming of faces created by arbitrary Boolean topology is unsolved in
the Phase 1 contract and remains a later exact-kernel concern.

## 16. Deterministic evaluation profile

The deterministic profile includes:

- exact application, schema, solver, adapter, kernel, compiler, evaluator
  source-closure, and WASM build identities;
- locked direct and transitive dependency versions;
- serial geometry evaluation for the initial browser adapter;
- disabled fast-math and unrecorded randomness;
- stable ordering for IDs, constraints, graph traversal, loops, operations,
  vertices, triangles, diagnostics, and evidence fields;
- explicit tolerance and tessellation policies;
- no GPU result in the geometry hash; and
- no timestamp, locale, thread schedule, or transient memory address in a
  hashed payload.

The official research for the proposed mesh-solid dependency reports
cross-platform double-precision determinism in its current release. PS3D must
still verify the exact selected artifact across its own supported browser and
operating-system matrix before relying on that property.

## 17. Geometry evidence

Each committed evaluated revision produces an evidence record containing:

- evidence schema version;
- document ID, revision, parent revision, and semantic hash;
- command-journal prefix hash;
- engine profile, exact adapter/dependency versions, evaluator source-closure
  SHA-256, and, when the selected engine uses WASM, its artifact SHA-256;
- tolerance and tessellation policies;
- explicit deterministic seed, if any;
- per-body exact canonical mesh hash;
- per-body tolerance signature;
- bounds, area, signed volume, component and topology counts;
- validity checks and typed diagnostics; and
- replay verification status when available.

The project-owned Phase 0 bracket engine uses no WASM. Its evidence therefore
records a null WASM hash plus the explicit disposition
`not-used-by-production-engine`; this must not be interpreted as a missing hash
for an engine that does ship WASM.

Semantic JSON uses RFC 8785 JSON Canonicalization before hashing. Binary
artifacts are content addressed separately.

### 17.1 Canonical mesh hash

The exact mesh hash process must:

1. Reject empty, wrong-typed, misaligned, oversized, non-triangle, unused,
   nonfinite, repeated-index, and out-of-range buffers.
2. Normalize negative zero and encode coordinate values as canonical binary64
   bytes.
3. Sort unique vertices lexicographically by those bytes, remap indices, and
   reject triangles collapsed by coincident coordinates.
4. Rotate each oriented triangle cyclically so its smallest index tuple is
   first, without reversing winding.
5. Sort triangles lexicographically.
6. Include component boundaries and any normative semantic surface IDs in a
   documented stable order.
7. Hash the versioned canonical byte stream with SHA-256.

A separate tolerance signature may quantize coordinates using the recorded
policy and include invariant measurements. It supports controlled comparison
but does not replace the exact hash.

Evidence is reproducibility and tamper-detection material, not a formal proof
of geometric correctness. Server signing may be added later without changing
the underlying evidence semantics.

## 18. Future assembly numerical contract

Assemblies are not Phase 1. Their future contract must add:

- rigid instance state represented on `SE(3)`;
- explicit translation and rotation residual scaling;
- one fixed gauge per connected mate component;
- deterministic initialization and solution-branch persistence;
- rank, remaining-DOF, redundant-mate, and conflicting-loop diagnostics;
- bounded drag previews distinct from committed mates; and
- qualification for assembly size, hierarchy depth, and solve time.

The assembly solver may reuse the project numerical crate and permissive
linear algebra, but it must not treat a dynamics or collision engine as a
geometric mate solver.

## 19. Future exact and NURBS contract

NURBS and exact B-rep are multi-year work, not hidden Phase 1 capabilities.
Before support can be claimed, a future contract must define:

- knot, degree, weight, parameter-domain, continuity, and derivative rules;
- curve and surface evaluation error bounds;
- parameter-space trims and edge/surface consistency;
- bounded and refined curve/curve, curve/surface, and surface/surface
  intersections;
- topology classification, split, stitch, heal, and Boolean invariants;
- tolerance propagation without uncontrolled growth;
- exact-to-render tessellation and selection maps;
- persistent naming behavior and explicit repair limits; and
- exchange-format conformance and round-trip policy.

An experimental permissive kernel adapter may be evaluated behind the same
ports. It becomes a production dependency only after the complete applicable
contract and provenance gates pass.

## 20. Error taxonomy

At minimum, geometry-facing operations distinguish:

- `INVALID_NUMBER`
- `UNIT_MISMATCH`
- `OUTSIDE_SUPPORTED_ENVELOPE`
- `RESOURCE_LIMIT`
- `INVALID_GRAPH`
- `SOLVER_DID_NOT_CONVERGE`
- `UNDERCONSTRAINED`
- `CONSTRAINT_CONFLICT`
- `DEGENERATE_GEOMETRY`
- `OPEN_PROFILE`
- `SELF_INTERSECTING_PROFILE`
- `AMBIGUOUS_PROFILE`
- `UNSUPPORTED_GEOMETRIC_CASE`
- `INVALID_SOLID_INPUT`
- `INVALID_SOLID_OUTPUT`
- `IDEMPOTENCY_CONFLICT`
- `BROKEN_REFERENCE`
- `UNSUPPORTED_CAPABILITY`
- `WORKER_FAILURE`
- `PERSISTENCE_FAILURE`
- `UNSUPPORTED_OR_CORRUPT_FILE`

Warnings and failures are separate. A warning cannot waive a committed-body
validity invariant.

## 21. Required verification

### 21.1 Unit and analytic tests

Test unit conversion, expression dimensions, residuals and derivatives,
primitive bounds, simple areas/volumes, canonicalization, and evidence hashes
against independently derived calculations.

### 21.2 Property and metamorphic tests

Generate original synthetic cases to test translation, rotation, scaling
inside the envelope, insertion-order permutations, repeated regeneration,
transform/inverse-transform, Boolean identities where mathematically
applicable, volume relations, and serialization round trips.

### 21.3 Perturbation and adversarial tests

Exercise near-coincident, near-tangent, small-angle, large-coordinate,
redundant, conflicting, degenerate, self-intersecting, and resource-limit
cases around the declared boundary. Tests must expect a typed limitation where
the case is outside the supported envelope.

### 21.4 Adapter conformance

Every solid adapter runs the same project-owned operation, validity, error,
resource, and evidence corpus. Native and WASM builds of the selected kernel
are compared to detect binding and build-profile defects, not to serve as
independent proof of correctness.

### 21.5 Determinism matrix

Committed reference models are rebuilt repeatedly on the supported operating
systems and Chromium, Firefox, and Safari/WebKit families. Exact evidence
hashes must match for the declared deterministic profile. Any allowed variance
requires a new named profile and published explanation; it cannot be ignored
as flaky output.

### 21.6 Recovery and fuzzing

Terminate the worker during solve, Boolean, validation, evidence, export, and
save stages. Reconstruct from the latest complete revision and prove that no
partial result became authoritative. Fuzz schemas, expression syntax, sketch
graphs, operations, and file parsers within strict time and memory budgets.

## 22. Change control

Changing a default tolerance, numerical method, dependency version, compiler
profile, canonicalization algorithm, mesh ordering rule, validity invariant,
or evidence schema is an architecture change. It requires:

- a design or decision record;
- a regenerated conformance and determinism report;
- review of prior native-document behavior;
- an evidence-version or engine-profile change where output can differ; and
- explicit release notes describing the supported impact.

No numerical-policy change is a patch-level implementation detail when it can
change saved geometry, references, measurements, or evidence.
