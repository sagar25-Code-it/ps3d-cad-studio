# @ps3d/exact-kernel-api

This package is the transport-neutral contract between PS3D and an exact B-rep
geometry kernel. It is intentionally independent from OpenCascade bindings so
the same request model can be implemented by a browser WASM worker, a native
worker, or a deterministic recorded-fixture adapter in tests.

The contract has four non-negotiable boundaries:

1. Metres and radians are the canonical computation units.
2. Kernel-owned B-rep shapes are represented by opaque, revisioned handles.
   Tessellation is a derived display product and is never accepted as an exact
   modelling input.
3. Topology selections use stable references with producer provenance,
   ancestry, and geometric signatures. Implementations must either resolve the
   reference unambiguously or return a diagnostic; silently selecting a nearby
   face or edge is forbidden.
4. Every successful operation returns validation, topology provenance, and a
   deterministic receipt that binds the request to its outputs.

`RecordedExactKernelAdapter` does not calculate geometry. Tests register
responses captured from a real kernel (or otherwise independently verified),
and the adapter deterministically replays those records while checking the
protocol. Missing records fail explicitly.

The package does not add OpenCascade itself and does not claim that any current
PS3D mesh is an exact solid.
