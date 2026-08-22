# PS3D project context

Generated from the original local repository on 2026-08-19. These files are
the live, project-specific software-delivery context; they are not copied
templates.

- `project.mdc` — repository identity, stack, commands, dependencies, and
  contribution constraints.
- `architecture.mdc` — semantic-model, worker, geometry, persistence,
  viewport, MCP, and presentation boundaries.
- `coding-standards.mdc` — strict TypeScript, test, review, provenance, and
  entropy rules.
- `deployment.mdc` — local/Vercel environments, verification, rollback,
  and current operational limits.
- `business-flows.mdc` — the model-edit, history, persistence,
  multi-workbench, selection, learning, identity, token, and local/remote MCP
  journeys visible here.

GitHub Actions, Vercel Web Functions, Supabase Auth/Postgres integration, and
remote MCP release-candidate configuration are present in source. A Git remote,
live cloud resources, production secrets, APM, and a logging backend remain
unconfigured until the reviewed browser-only publication workflow completes.
