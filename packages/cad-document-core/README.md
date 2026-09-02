# PS3D canonical CAD document core

This additive package defines the kernel-neutral, immutable document contract for
PS3D. It deliberately does not evaluate geometry. A geometry kernel, sketch
solver, drawing generator, UI, or MCP adapter can consume the same normalized
document without becoming its source of truth.

The model is normalized around projects, components, origins, sketches, bodies,
features, occurrences, joints, and drawings. Stable typed IDs connect those
records. Components own their design data through ID lists, while the project
owns each canonical record exactly once.

The package also provides:

- deterministic feature dependency and topological rebuild planning;
- per-component suppression and rollback semantics;
- immutable update helpers with monotonic revisions;
- model validation with stable, machine-readable diagnostics;
- a deep-freeze boundary suitable for stores and MCP receipts.

Run its isolated checks from the repository root:

```text
pnpm --filter @ps3d/cad-document-core typecheck
pnpm --filter @ps3d/cad-document-core test
```

This is a schema and planning foundation. Exact B-rep evaluation and persistent
topology naming belong in geometry-kernel adapters layered above it.
