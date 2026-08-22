# Contributing

The repository contains a worker-qualified Phase 0 solid slice and a bounded,
truth-labeled Phase 1 broad-workbench preview under documented requirements
and architecture. Changes must stay within an approved capability boundary or
first add the requirement, decision record, numerical contract, and
enforcement gate needed to extend it.

## Before contributing

Read:

- `INDEPENDENT_DEVELOPMENT.md`;
- `provenance/SOURCE_POLICY.md`;
- `SECURITY.md`; and
- the pull-request template.

Open an issue for a material requirement, architecture choice, dependency, or
asset before implementing it. Use only sources allowed by the source policy.
Do not paste code or content merely because it is publicly visible.

## Contribution workflow

1. Work from a focused issue and neutral acceptance criteria.
2. Record new research sources and design decisions while the work is done.
3. Add independently derived tests for behavior changes.
4. Declare every dependency, copied excerpt, generated file, and assisted
   contribution.
5. Complete the pull-request provenance checklist.
6. Obtain the required technical and provenance reviews.

Do not commit secrets, personal data, unexplained binaries, build output, or
material whose origin or license cannot be established.

## Contributor sign-off

Every commit must include a `Signed-off-by` trailer created with `git commit
-s` or an equivalent explicit trailer:

```text
Signed-off-by: Contributor Name <contributor@example.com>
```

By signing off, the contributor attests that:

- they created the contribution or have documented authority to submit every
  included part under the applicable license;
- submission under the project's MIT License does not breach another duty;
- all third-party, generated, and assisted material is accurately declared;
- the recorded sources and license information are complete to the best of
  their knowledge;
- no confidential, leaked, decompiled, or otherwise restricted material was
  used; and
- the project may retain the contribution and its provenance record.

A maintainer must not merge a commit with a missing or knowingly inaccurate
sign-off. Signing does not replace source review or dependency approval.

## Review expectations

Reviewers check correctness, security, accessibility, numerical behavior,
tests, scope, and provenance. At least one maintainer approval is required;
changes affecting dependencies, licensing, generated content, or product
identity also require provenance-owner approval.

Unclear provenance is a reason to pause a change, not a documentation detail
to repair after release.
