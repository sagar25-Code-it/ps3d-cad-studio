# `@ps3d/cad-platform-acceptance`

Private end-to-end acceptance harness for PS3D's parametric CAD foundation. It
connects the canonical CAD document, analytic sketch solver, exact-kernel
protocol, rebuild engine, and manifest-first AI engineering gateway without
changing any production package.

The qualified path proves:

- schema and command manifests must be acknowledged before planning;
- a stable-ID feature plan can reference a constrained sketch and exact
  extrusion;
- preview rebuilds a candidate document without mutating the live revision;
- exact geometry comes only from a registered recorded-kernel fixture;
- explicit approval is bound to the exact project, revision, plan, and preview;
- apply is atomic and revision checked;
- preview, exact-kernel, approval, and apply receipts retain deterministic
  digest linkage; and
- unresolved dimensions/standards and stale revisions fail closed.

## Exact-fixture truth boundary

The harness does not evaluate or fabricate B-rep geometry. Its extrusion result
is a protocol record attributed to a non-recorded qualified source-kernel run,
registered through `RecordedExactKernelAdapter`. The adapter validates and
re-hashes the record, refuses unregistered operations with `FIXTURE_MISSING`,
and never treats tessellation as exact geometry. This test proves orchestration,
receipt, and fail-closed behavior; it is not a substitute for rerunning the
source OpenCascade qualification artifact.

Run the isolated checks from the repository root:

```powershell
pnpm --filter @ps3d/cad-platform-acceptance typecheck
pnpm --filter @ps3d/cad-platform-acceptance test
```
