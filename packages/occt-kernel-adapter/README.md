# OCCT kernel adapter boundary

This package activates an Open CASCADE Technology runtime only after a trusted
loader reports independently observed evidence that exactly matches a
deployment qualification manifest. A runtime cannot self-attest. It does not
bundle, download, or claim to implement OCCT.

The manifest binds the official source revision, executable artifact digest,
build configuration, license and special-exception evidence, qualification
suite result, exact-kernel identity, and capabilities. A mismatch disposes the
runtime before an adapter is returned.

Sessions are bound to a document, revision, and runtime generation. Exactly one
runtime call is allowed at a time across that generation, request IDs are
single-use and bounded, and complete input handles must match the handles held
by the active session. Requests and runtime products are copied into owned
snapshots to prevent mutation during validation.

Returned exact-shape handles, validation reports, topology summaries,
persistent-topology references, provenance, diagnostics, exchange artifacts,
and tessellations are structurally and resource validated before exposure.
Artifact bytes are SHA-256 checked. Invalid, unbounded, cross-session, or
failed-validation products quarantine the generation. A timeout, cancellation,
management failure, or protocol mismatch synchronously invokes the required
isolation termination boundary and starts cleanup; that runtime is never
reused. Cooperative cancellation may be advertised only when its endpoint is
present, but hard termination remains authoritative.

The adapter validates evidence and protocol behavior; it cannot prove that a
loader actually isolated a process or worker, that `terminate` killed it, or
that returned geometry is mathematically correct. Those claims belong to the
trusted loader implementation, reproducible build records, and external OCCT
qualification corpus. Transport-level message and memory limits must also be
enforced before untrusted worker messages are materialized in this process.

Geometry execution remains unavailable until PS3D supplies a separately built,
licensed, reproducible, and qualified WASM or native runtime implementing
`OcctRuntimePort`.
