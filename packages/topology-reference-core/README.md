# `@ps3d/topology-reference-core`

Deterministic, kernel-neutral recovery of persistent face, edge, and vertex references after an exact B-rep body is recomputed.

The resolver combines four independent evidence classes:

1. the canonical document reference and feature lineage;
2. the exact-kernel semantic producer and ancestry lineage;
3. analytic/geometric signatures within explicit tolerances; and
4. an order-independent neighborhood/adjacency signature.

An exact key is accepted only after integrity checks. Recovery returns a candidate only when the best eligible candidate is unique. Symmetric or otherwise equivalent candidates return `ambiguous`; the library never resolves a tie by array order, entity ID, or another arbitrary choice. Missing/deleted topology and invalid snapshots are also explicit outcomes.

This package defines the resolver contract and a deterministic reference implementation. It does **not** bundle or claim a live OpenCascade evaluator. Production kernel adapters must provide complete `ResolvedTopologyEntity` provenance for each revision.
