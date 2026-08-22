# Independent Development Policy

## Purpose

This project must be designed and implemented from its own requirements and
engineering decisions. This policy creates a reviewable record of independent
authorship and reduces the risk that unapproved third-party expression,
confidential information, or incompatible licensing enters the repository.

Compliance with this process is evidence of careful practice; it is not a
legal guarantee of non-infringement or freedom to operate.

## Approved implementation boundaries

The repository contains a bounded Phase 0 feasibility implementation derived
from the recorded neutral requirements and candidate architecture. Its
worker-qualified solid path remains limited to the explicitly documented
centered-bore bracket workflow and its supporting validation, evidence,
persistence, presentation, and export boundaries.

The local Phase 1 broad-workbench preview is separately authorized by
`docs/product/PRD_PHASE_1_WORKBENCH_PREVIEW.md`,
`docs/architecture/PHASE_1_WORKBENCH_ARCHITECTURE.md`, ADR 0004, and ADR 0005.
It may implement only the truth-labeled semantic, tessellated, vector, and MCP
subsets declared there. A `preview` capability is not promoted to `qualified`
by UI presence, a passing unit test, or visual plausibility.

Any further expansion or promotion requires approval of the corresponding
neutral requirement, architecture record, numerical contract, provenance, and
contribution gates first. Neither phase is a production, compatibility, exact
geometry, or freedom-to-operate claim.

## Neutral requirements

Requirements must describe user needs and observable behavior without
prescribing borrowed implementation or presentation details. Each requirement
must record:

- a stable identifier and author;
- the user need and rationale;
- inputs, outputs, constraints, and measurable acceptance criteria;
- the origin of any mathematical, standards-based, or platform claim; and
- any accessibility, security, numerical, interoperability, or performance
  limits.

Requirements may rely on generally known mathematics, approved public
standards, browser platform documentation, original user research, and
independent experiments. Distinctive wording, screen organization, examples,
assets, command sequences, and internal implementation details from an
external product are not acceptable requirements inputs.

## Development roles and information boundaries

Maintainers may designate separate requirements authors, implementers,
provenance reviewers, and release approvers. Contributors must disclose any
prior access that could materially affect independent implementation.

An implementer receives only approved requirements and allowed technical
sources. If a separate reviewer evaluates similarity or other intellectual
property risk, that reviewer must communicate only an abstract finding and a
neutral remediation objective. The reviewer must not provide external code,
screenshots, extracted assets, detailed reproductions, or implementation
instructions derived from restricted material, and must not implement the
remediation.

## Original engineering records

Consequential decisions must have a dated design record. A record should state
the problem, neutral constraints, alternatives considered, experiments,
tradeoffs, decision, and authors. Examples include geometry representation,
numerical tolerance, topology rules, rendering, persistence, undo behavior,
worker boundaries, interaction architecture, and accessibility.

Keep issue history, prototypes, benchmark inputs, rejected approaches, and
review discussion when they help explain how a design evolved. Records must be
contemporaneous; retrospective summaries must be labeled as such.

## User-interface originality

Information architecture, workflows, terminology, layout, design tokens,
icons, text, samples, and motion must be created for this project or come from
an approved and recorded source. Common platform conventions may be used when
there is an independent usability or accessibility rationale. Design history
and source assets must be retained so the project can explain its choices.

## Tests and examples

Tests should be derived from documented requirements, mathematics, approved
public specifications, browser behavior, or original experiments. Prefer
invariants, property-based cases, metamorphic relations, independently derived
reference calculations, and original synthetic models. Do not copy test
suites, fixtures, coordinate sets, golden images, example documents, or
standards text without explicit source and license approval.

## Generated and assisted material

Generated code and assets are subject to the same review as human-authored
work. Record the generator, version, inputs, command or prompt, settings or
seed when available, output hash, reviewer, and substantive human changes.
Inputs must themselves be permitted. Prompts or procedures that request
imitation of a named product, brand, artist, or designer are prohibited.

## Provenance and release evidence

Every merged change must link to its requirements and design records where
applicable and declare its sources, dependencies, generated content, and test
origins. Release candidates must have:

- no unresolved provenance exceptions;
- a reviewed dependency inventory and third-party notices;
- an SBOM for the shipped artifact;
- passing security, license, test, and reproducibility gates;
- signed source and build identifiers; and
- an independent release approval.

## Suspect material

If a contribution may contain unapproved material, stop distribution and
quarantine the affected content. Preserve evidence with restricted access,
trace derived work, and notify the provenance owner. Any replacement must be
implemented by an appropriately unexposed contributor from the neutral
requirement and allowed sources. Cosmetic rewriting is not remediation.

## Limits

Independent authorship does not resolve patent, trademark, trade-dress, export,
privacy, or security questions. The MIT License covers only material the
project has authority to license. Automated scanners and contributor
attestations are controls, not proof of legal clearance; qualified review is
required when risk or uncertainty is material.
