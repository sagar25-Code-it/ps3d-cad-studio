# @ps3d/exact-kernel-worker

Structured-clone transport for running an `@ps3d/exact-kernel-api` adapter in
an isolated browser Web Worker. The host owns the actual kernel runtime; this
package moves only versioned PS3D requests and responses across the boundary.

The bridge:

- validates channel/version/message correlation;
- converts timeouts, cancellation and worker exceptions into typed kernel
  diagnostics;
- validates every response against the original request; and
- rejects late or duplicate messages instead of applying stale geometry.

`chooseKernelAdapter` qualifies injected WASM and native adapters against an
explicit requirement set. It prefers a satisfactory WASM worker for ordinary
interactive operations and selects a native worker only when the requirement
or preference demands it. It never moves an in-memory shape between runtimes
or silently retries a failed modeling operation on another kernel.

No OpenCascade binary is bundled here. This is the isolation and routing
boundary required before a separately licensed and qualified OCCT runtime can
be attached.
