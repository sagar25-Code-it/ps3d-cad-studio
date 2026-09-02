# `@ps3d/parametric-cad-engine`

Deterministic orchestration between PS3D's canonical CAD document, parametric
sketch solver and exact-kernel protocol.

This package does **not** implement or imitate a geometry kernel. It never
creates mesh placeholders, invents topology selections or guesses missing
feature parameters. A caller supplies:

- a deterministic `ParametricSketchSolver`;
- an `ExactKernelAdapter` backed by a qualified WASM/native kernel or verified
  recorded evidence; and
- a `FeatureOperationMapper` that resolves a canonical feature into one exact,
  typed kernel operation.

## Rebuild transaction

1. Validate the canonical document.
2. Build the canonical deterministic feature plan. Suppressed, rolled-back and
   component-suppressed nodes remain explicit skipped records.
3. Solve every active sketch supplied by the canonical-sketch bridge.
4. Evaluate planned feature nodes in topological order.
5. Reject missing dependencies, unsupported mappings, mismatched feature/kernel
   kinds, mismatched semantic outputs, invalid receipts and invalid geometry.
6. Preserve prior exact last-good results when a node fails. Descendants are
   blocked for the current transaction and never consume the stale result as if
   the failed recomputation succeeded.
7. Return an immutable candidate document, structured diagnostics, a new
   last-good cache and a SHA-256-bound preview/rebuild receipt.

`preview` and `rebuild` both return candidate data; neither writes a browser
file or silently replaces the caller's live document. The receipt kind allows a
higher approval layer to keep preview and confirmed-apply workflows distinct.

## Why feature mapping is injected

The canonical feature model retains stable parameters and references, but a
general exact operation also needs resolved profiles, exact shape handles and
persistent topology selections. The engine refuses to infer these from labels
or array positions. `createFeatureOperationTableMapper` provides a small,
auditable registration mechanism while `validateFeatureOperationMapping`
enforces:

- canonical feature ID equals exact operation ID;
- canonical feature kind maps to the expected exact operation kind; and
- exact semantic outputs match canonical output bodies in stable order.

This package currently imports the three source-only workspace packages through
their `src/index.js` subpaths. Once those packages publish root exports, the
imports can be shortened without changing the orchestration contract.

## Session ownership

Set `openSession: true` to ask the engine to open the supplied session before a
transaction. For persistent production workers, open and own the session in the
host and leave this flag false so exact handles remain scoped to one intentional
session lifecycle.

## Verification

```powershell
pnpm --filter @ps3d/parametric-cad-engine typecheck
pnpm --filter @ps3d/parametric-cad-engine test
```

Focused tests use a deterministic protocol-valid fake exact adapter. The fake is
test-only; production engine code accepts geometry only from the injected exact
adapter and validates its correlation, operation receipt and shape reports.
