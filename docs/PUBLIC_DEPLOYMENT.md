# Public deployment and account setup

This guide releases PS3D as a public GitHub repository and Vercel application
without placing a password, API secret, MCP token, private key, or local path in
source control. The intended starter stack is GitHub Public, Vercel Hobby, and
Supabase Free. Each provider has quotas and may change its free-plan terms; a
public service is therefore not guaranteed to remain cost-free at every scale.

## Release architecture

- Vercel serves the Vite application and the Web-standard functions under
  `api/`.
- Supabase Auth owns password hashing, email verification, recovery sessions,
  OAuth 2.1 authorization, refresh tokens, and user JWTs.
- Vercel keeps the Supabase secret key and `MCP_TOKEN_PEPPER` as server-only
  environment values.
- PostgreSQL stores only token metadata and keyed HMAC digests. It never stores
  a raw `ps3d_mcp_...` token or a CAD/MCP request payload.
- Browser CAD projects remain local unless a user deliberately exports and
  supplies a bounded project value to an AI host.

## 1. Verify the repository before publication

Run these gates in an approved development or CI environment:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

The repository rejects secret-like files, private profile paths, unexplained
binaries, dependency drift, SBOM drift, source-identity drift, and forbidden
browser bundles. Do not weaken a gate merely to make a deployment pass.

## 2. Create the public GitHub repository

Create a new repository, keep it public, and select the MIT License. Upload only
the reviewed repository source; `.gitignore` excludes dependency, test, build,
log, and environment output. After the first clean commit:

1. Enable Private vulnerability reporting under Security settings.
2. Enable Dependabot alerts and security updates.
3. Enable secret scanning and push protection when GitHub offers them for the
   account/repository.
4. Let the included Release gates, CodeQL, and Dependency review workflows run.
5. Add a main-branch ruleset after the first green run. Require pull requests
   and the release-gate check for later changes; keep a documented owner
   recovery path.

The MIT notice preserves the named copyright notice, but the MIT grant also
allows other people to use, copy, modify, distribute, sublicense, and sell the
software subject to the notice and disclaimer. Use trademark policy, service
terms, contributor agreements, or a different lawyer-reviewed license if the
business requires restrictions beyond MIT.

## 3. Import the repository into Vercel

Import the GitHub repository as a new Vercel project. Vercel should detect Vite.
The repository already declares:

- build command: `pnpm build`
- output directory: `dist`
- Node.js: latest supported 24.x
- Web-standard functions: `api/*.ts`
- SPA and OAuth metadata rewrites
- restrictive response headers

Do not add a deployment token to the repository. The Git integration performs
deployments without exposing a reusable token to the source tree.

## 4. Provision Supabase on the free plan

Create one new Supabase project, directly or through the Vercel Marketplace
integration, and select only the free plan. Stop if any screen requires a paid
upgrade.

In the Supabase SQL editor, apply exactly:

`supabase/migrations/202608220001_remote_mcp.sql`

Then configure Authentication:

1. Set Site URL to the final HTTPS Vercel production URL.
2. Add `<production-url>/access?verified=1` and
   `<production-url>/access?recovery=1` to permitted redirect URLs.
3. Require email confirmation. The default email service is suitable only for
   limited evaluation traffic; review its quotas before a larger launch.
4. Enable OAuth 2.1 Server, set Authorization Path to `/oauth/consent`, and use
   an asymmetric JWT signing key before requesting OpenID Connect ID tokens.
5. Register only reviewed AI clients. OAuth callback URLs must be exact HTTPS
   URLs, except standards-compliant local loopback callbacks during development.

OAuth 2.1 Server is provider beta functionality at this edition. Personal
tokens remain the documented compatibility path for hosts that support custom
HTTP headers but not interactive OAuth.

## 5. Add server-only Vercel environment values

Set these in Vercel Project Settings for Production, and for Preview only when
the preview environment has its own isolated backend:

```text
PUBLIC_APP_URL=https://your-final-production-domain.example
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_in_vercel_only
SUPABASE_SECRET_KEY=sb_secret_replace_in_vercel_only
MCP_TOKEN_PEPPER=replace-with-at-least-32-random-characters
```

The publishable key is low privilege, but PS3D still serves it only through its
same-origin backend design. The secret key and pepper are server-only. Never
place their real values in `.env.example`, GitHub, a screenshot, chat, a manual,
or a plain-text handoff file. Use Vercel's encrypted environment settings and a
trusted password manager for owner recovery.

After setting values, redeploy from the same reviewed commit. `/api/health`
must return `ready`; `/api/public-config` must return `cloudAccess: "ready"`.

## 6. Live verification

Use a dedicated test account and complete all of these checks:

- create account, receive verification email, sign in, sign out
- request recovery, use the recovery link, set a new 12+ character password
- create one 7-day read/preview token, copy it once, and verify it is never
  visible again after dismissal or reload
- call MCP `initialize`, `tools/list`, `ps3d_guide`, and one preview operation
- verify a token without `mcp:apply` cannot call `ps3d_apply_preview`
- revoke the token and verify the next MCP request receives HTTP 401
- verify an invalid Origin, oversized body, malformed JSON, unknown method,
  cross-user token ID, and sixth active token all fail closed
- review desktop and small-screen CAD, Learning Center, PDF manual, account,
  OAuth consent, error, and empty states
- confirm GitHub Release gates and CodeQL are green and the deployed commit is
  the reviewed main commit

## Operations and incident response

No public application can be promised unhackable. Keep dependencies patched,
review provider advisories, rotate a suspected secret immediately, revoke
exposed personal tokens, and pause token issuance during an incident. Vercel
can roll code back to a previously reviewed deployment; database changes need a
separately reviewed forward migration or tested backup restore.

