# OCCT qualification and distribution gate

**Status:** Required before PS3D advertises exact B-rep modeling

**Candidate pin for qualification:** Open CASCADE Technology (OCCT) 8.0.1

**Execution profiles:** browser WebAssembly worker and isolated native worker

## Why this gate exists

The project-owned `exact-kernel-api` and `exact-kernel-worker` packages are
implemented without embedding dependency objects or binaries. An OCCT runtime
may be connected only after its numerical behavior, topology provenance,
resource use, build identity, supply-chain evidence, and license obligations
are reproducible.

`occt-kernel-adapter` now enforces this boundary in source. Its asynchronous
factory compares independently observed trusted-loader source, artifact, build,
license, capability and qualification evidence with the selected deployment
manifest and disposes the runtime on any mismatch. A runtime cannot attest
itself. The package includes only the adapter contract and tests with an
injected fake runtime; it is not an OCCT build or evaluator.

A local `replicad-opencascadejs` 0.23.0 candidate was inspected. Its wrapper
metadata is MIT and it contains two approximately 10.8 MB WASM binaries, but
the embedded OCCT library remains subject to OCCT's LGPL-2.1 terms and
additional exception. Package metadata alone is not sufficient provenance for
public distribution, so the binary was not copied into PS3D and is not a
current application dependency.

## Reproducible dependency record

The eventual dependency record must contain:

1. exact OCCT source tag and commit;
2. source archive SHA-256 and upstream download URL;
3. wrapper source tag/commit, generated bindings configuration, and patches;
4. Emscripten/CMake/compiler versions and the complete build command;
5. enabled OCCT modules and excluded commercial translators;
6. output JavaScript/WASM hashes and an SBOM relationship to their sources;
7. license text, exception text, user-visible notice, source-availability URL,
   and instructions for rebuilding/replacing the OCCT portion; and
8. equivalent records for the native worker image or executable.

OCCT 8.0.1 is the current maintenance candidate because upstream identifies
it as the first regular 8.0 maintenance release and reports fixes in modeling,
shape healing, STEP export, meshing, WebAssembly performance paths, and
thread-safe fillet reconstruction. Promotion still depends on PS3D's own
corpus; a newer version number is not qualification evidence by itself.

## Runtime boundary

```text
semantic feature graph
        |
        v
@ps3d/exact-kernel-api request
        |
        +-- browser: structured-clone worker -> qualified OCCT WASM runtime
        |
        +-- server: isolated job worker -> qualified native OCCT runtime
```

OCCT pointers, `TopoDS_Shape` objects, binding-specific enums, and mutable
kernel sessions never enter the persistent document. The adapter returns
opaque exact shape handles, topology provenance, validation reports,
tessellations, and deterministic receipts.

The adapter binds each session to a document revision and runtime generation,
serializes requests within that session, rejects duplicate request IDs, and
validates every result envelope before exposing it. Hard timeout, cancellation,
or invalid output quarantines and terminates that runtime generation. A runtime
cannot claim cooperative cancellation without implementing the cancellation
endpoint. These controls reduce stale-state and compromised-runtime risk; they
do not qualify geometry correctness without the corpus below.

## Initial operation qualification

The first promoted slice is deliberately smaller than the complete operation
manifest:

- box, cylinder, cone, sphere and torus primitives;
- planar wire/face creation from solved sketch profiles;
- extrude with new body/component, join, cut and intersect;
- revolve, Boolean combine and hole;
- fillet, chamfer and shell;
- shape validation, healing and topology description;
- STEP, IGES and BREP import/export; and
- deterministic tessellation with face-reference attribution.

Every later operation remains capability-gated until its corpus passes.

## Acceptance corpus

Each operation must be tested on normal, boundary, degenerate and failure
cases in both WASM and native profiles. Required assertions include:

- canonical request equality produces equal content and topology receipts for
  one pinned build;
- all finite outputs are exact B-rep handles, not mesh substitutions;
- volume, area, bounds and topology counts match reference tolerances;
- shape checks reject open/non-manifold/self-intersecting invalid results;
- topology ancestry is returned for generated, modified and deleted entities;
- stale or ambiguous topology references fail without nearest-face fallback;
- cancellation and time/resource limits retain the prior valid revision;
- import transfer reports identify healed, dropped and unresolved entities;
- export followed by reimport stays within the published tolerance envelope;
  and
- repeated create/rebuild/dispose cycles remain inside the memory budget.

## Routing rule

The browser WASM worker is preferred for interactive operations that fit its
advertised limits. A native worker is selected before a session begins when
the requested capability, size, tolerance, exchange format or policy requires
it. A failed in-memory operation is not silently retried on another runtime,
because kernel-owned shape handles cannot be transferred safely without an
explicit exact exchange transaction.

## Public-claim rule

Until the above gate passes, PS3D may describe OCCT as the selected candidate
and may expose exact-kernel contracts as developer preview. It must not label
existing Manifold meshes, recorded fixtures, or preview geometry as exact
B-rep CAD.

## Primary upstream evidence

- OCCT overview, modules, data exchange, healing, Web platform requirements,
  and license: <https://dev.opencascade.org/doc/overview/html/index.html>
- OCCT WebAssembly/WebGL sample:
  <https://dev.opencascade.org/doc/occt-7.9.0/overview/html/dir_0d4cf0b7a3b80d1164f4e93f0d0f0314.html>
- OCCT 8.0.1 upstream release:
  <https://github.com/Open-Cascade-SAS/OCCT/releases/tag/V8_0_1>
