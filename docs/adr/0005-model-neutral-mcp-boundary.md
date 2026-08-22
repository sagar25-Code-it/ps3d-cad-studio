# ADR 0005: Use a Stateless, Consent-Gated, Model-Neutral MCP Boundary

**Status:** Accepted for local implementation  
**Date:** 2026-08-19

## Context

PS3D must work with MCP-capable hosts without binding its model schema to one
AI provider or exposing the user's filesystem, credentials, or browser state.
Remote authorization and durable brokers are not yet available.

## Decision

Ship a local stdio MCP server using the official SDK. The server is stateless:
every call contains the bounded project or operation it needs and returns data
without persistence or side effects. Inspection is read-only. Mutation uses a
preview receipt and explicit confirmation, returns a new project, and relies on
the host/browser to obtain human approval before the call.

No tool reads files, environment variables, network endpoints, roots, or other
applications. A later remote endpoint requires a separate OAuth, tenancy,
origin-validation, rate-limit, retention, and deployment decision.

## Consequences

- Any compliant MCP host can use the tool surface without an AI-vendor SDK.
- The server can be tested locally with no account or key.
- Browser live state is not automatically synchronized with a host; users move
  the returned project through an explicit import/export or future broker.
- `confirmed: true` is defense in depth, not proof that a person approved the
  action; client approval UI remains mandatory.
