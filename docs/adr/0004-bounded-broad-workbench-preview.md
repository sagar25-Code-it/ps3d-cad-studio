# ADR 0004: Stage Broad CAD Capabilities as Truth-Labeled Semantic Previews

**Status:** Accepted for local implementation  
**Date:** 2026-08-19

## Context

The requested product spans sketching, parts, assemblies, surfaces, drawings,
and automation. A production exact kernel and general constraint/mate solvers
would require years of numerical, topology, interoperability, and qualification
work. A static interface mock would also be misleading and not useful.

## Decision

Implement functional, bounded, project-owned semantic evaluators for every
workspace while retaining the existing centered-bore evaluator as the only
`qualified` solid path. Expose capability status everywhere. Preview features
must have real editable state, deterministic output, validation, tests, and
explicit exclusions; they must never impersonate exact geometry.

## Consequences

- Users can exercise the complete product workflow now.
- Architecture and schemas can mature before exact-kernel integration.
- Some visible features are tessellated preview features and cannot be used for
  manufacturing claims.
- Each preview needs a later qualification ADR before promotion.

## Alternatives

- Claim a full exact system immediately: rejected as technically false.
- Build only the original one-part slice: rejected because it does not validate
  the requested integrated product architecture.
- Copy another CAD system: prohibited by the independent-development policy.
