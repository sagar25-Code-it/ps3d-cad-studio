# Security Policy

## Current support status

The project is a public-release candidate with a runnable local workbench,
Vercel deployment contract, Supabase-backed account boundary, and stateless
remote MCP preview. Only the centered-bore solid path is qualified; all cloud,
multi-workbench, vehicle, electrical, drawing, exchange, and remote automation
behavior remains explicitly labeled Preview. Security reports are welcome.

## Reporting a vulnerability

Do not publish a suspected vulnerability in a public issue. Use the hosting
service's private security-reporting feature when it is enabled. If that is
unavailable, contact the repository owner through an established private
channel and share only the minimum information needed to arrange a secure
exchange.

A useful report identifies the affected version, reproduction conditions,
expected and observed behavior, likely impact, a minimal proof of concept when
safe, and any disclosure constraints. Do not access data that is not yours,
disrupt services, weaken availability, or retain sensitive information while
researching a report.

## Implemented controls

- Versioned exact project/native schemas reject unknown or malformed fields,
  non-finite numbers, count/size limit violations, and unsupported operations.
- Native input is capped at 1 MB and 5,000 schema nodes. Broad workbench and
  MCP input is capped at 1 MB; sketch entities at 500; components at 100;
  mates at 200; audit entries at 500; and surface tessellation at 48 × 48.
- Qualified solid work runs in a terminating/restarting worker, caps output at
  250,000 triangles, and returns independently checked topology and evidence.
- IndexedDB stores only validated complete revisions. A failed update leaves
  the last valid project visible and recoverable.
- Drawing SVG is generated from an allowlisted project-owned template with
  escaped bounded text and no scripts, foreign objects, external images, or
  links. Download names are fixed rather than derived as paths.
- The local MCP server is stateless and exposes no filesystem, network,
  process, browser-profile, environment-secret, credential, root, sampling,
  prompt, or external-resource capability.
- MCP mutation is split into validate/preview, SHA-256 receipt, explicit
  confirmation, and return-new-project. Stale revisions and mismatched
  receipts fail without mutation.
- Public passwords are handled by Supabase Auth and are never stored by PS3D.
  Browser sessions use `sessionStorage`, so they are scoped to the current tab
  rather than durable local storage or a project file.
- Personal MCP tokens contain 256 random bits, carry an application-specific
  prefix, expire after 7/30/90 days, and are shown once. The database stores a
  server-peppered HMAC digest, token display prefix, scopes, timestamps, and
  owner ID—not the raw token.
- Token tables force RLS, revoke browser-role grants, and are reached only by a
  backend that first validates the current user. User ID is repeated in every
  list/create/revoke filter; a trigger serializes and caps active tokens at five.
- Remote MCP requires a validated OAuth or personal bearer token, verified
  email, least-privilege tool scope, allowlisted browser Origin, JSON-only body,
  1 MB cap, allowlisted JSON-RPC methods, and a 60-request/minute per-identity
  database quota. Request payloads and CAD projects are not persisted.
- OAuth protected-resource metadata, Authorization Code with PKCE provider
  flow, explicit client detail display, approve/deny consent, and exact provider
  callback allowlisting keep the web password out of AI clients.
- Vercel secrets remain server-only. The backend distinguishes new
  `sb_secret_...` application keys from legacy service-role JWTs and never
  returns an elevated key to the browser.
- Static hosting supplies a restrictive CSP, framing/referrer/permission
  controls, explicit HTML revalidation, and immutable hashed-asset caching.
- Production graph and emitted-script gates reject the Node MCP SDK, Zod,
  Manifold candidate, WASM, and dynamic code generation from the browser app.
- Every locked dependency is reconciled to exact registry URL, integrity,
  license, purpose, and notice metadata by an executed deny-by-default gate.

These controls are feasibility evidence, not security certification. No public
service can be guaranteed unhackable. The preview has not completed an
independent penetration test, denial-of-service qualification, formal threat
model review, production availability commitment, or professional CAD safety
certification. Supabase OAuth 2.1 Server is provider beta functionality at this
edition; personal tokens are the bounded compatibility route.

Before every public release, rerun clean CI, dependency and secret scans,
generate/review the SBOM, complete accessibility and security review, compare
source/build identities, inspect every PDF page, exercise account/token/OAuth
and MCP revocation flows, review provider Security Advisors, and obtain explicit
human release approval. See `docs/RELEASE_CHECKLIST.md`. Exceptions must be
explicit, time-limited, and release blocking until approved.
