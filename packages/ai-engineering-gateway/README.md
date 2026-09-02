# `@ps3d/ai-engineering-gateway`

This package is the fail-closed contract between an AI/MCP host and PS3D's deterministic CAD engine. It is additive and provider-neutral. It does not contain provider credentials, network clients, hidden agents, geometry algorithms, or a claim that translated scripts are correct in another CAD system.

## Mandatory sequence

1. The AI host requests a handshake.
2. PS3D returns the exact document-schema digest, feature-plan-schema digest, command-manifest digest, and gateway-policy digest.
3. The AI host acknowledges those exact digests.
4. The AI creates a `ps3d-feature-plan/1` value using stable component/entity IDs and engineering intent. Raw mesh/triangle/vertex coordinate edits are rejected.
5. PS3D blocks preview while a required dimension, interface, material, manufacturing input, safety decision, or standards source remains unresolved.
6. A deterministic executor creates a non-mutating candidate and an immutable preview receipt.
7. Explicit approval binds the project ID, base revision, plan ID, plan digest, and preview-receipt digest.
8. Apply rechecks every binding and commits atomically from `baseRevision` to `baseRevision + 1`. Stale revisions, changed plans, replayed approvals, and reused idempotency keys fail closed.

```text
schemas + commands -> acknowledgement -> feature plan -> preview receipt
                                                        |
                                                        v
                                              explicit bound approval
                                                        |
                                                        v
                                          revision-checked atomic apply
```

## Truth boundaries

- An approval token in this package is a **consent-binding digest**, not an authentication secret or digital signature. The surrounding product must authenticate the approving user and protect its transport/session. No API keys, OAuth tokens, passwords, or network-secret storage are implemented here.
- The in-memory registry prevents a caller from presenting a receipt or approval that this gateway instance did not issue. A production service must persist receipts and consumed-approval state transactionally.
- A `GatewayExecutor` must provide deterministic preview and atomic revision-checked apply. This package validates the protocol around that executor; it does not manufacture geometry.
- A standards designation is not enough. Required evidence must be verified and carry an immutable source digest before preview.

## CAD adapter contracts

Translation-plan targets are:

- Fusion 360 Python
- NX/Open Python and C#
- SOLIDWORKS VBA and C#
- Creo TOOLKIT C++ and J-Link Java
- CATIA V5 VBA macros

`createAdapterTranslationPlan` maps reviewed PS3D command IDs to target-host API operations. Missing mappings remain explicit errors. Every plan is labeled `translation-plan-unvalidated`, every generated artifact starts as `generated-unvalidated`, and execution is disallowed by the plan. Only target-host test evidence can promote an artifact to `host-validated`. This contract never claims that translation preserves a native feature tree, mates, drawings, or all source semantics.

## Package checks

```powershell
pnpm --filter @ps3d/ai-engineering-gateway typecheck
pnpm --filter @ps3d/ai-engineering-gateway test
```
