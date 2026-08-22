# Source and Dependency Policy

## Default rule

All external inputs are denied until this policy permits them and their origin
is recorded. Public visibility is not permission to copy. When origin,
authorship, confidentiality, or license terms are uncertain, do not use the
material and request provenance review.

## Allowed research sources

The following may be used for factual understanding when cited with title,
publisher or owner, URL or publication identifier, access date, and purpose:

- official browser and web-platform documentation;
- public specifications and standards used within their terms;
- peer-reviewed research and independently authored mathematical references;
- documentation for an approved dependency; and
- experiments, measurements, and user research created for this project.

Facts, equations, and interface requirements must be expressed independently.
Do not reproduce protected prose, diagrams, tables, sample data, or code unless
their license is approved and the copied portion is declared.

## Review-required sources

Obtain written provenance approval before using:

- code snippets from articles, books, forums, or question-and-answer sites;
- patent documents beyond factual review directed by qualified counsel;
- public file-format samples or conformance suites;
- AI-generated or AI-assisted code, text, images, models, audio, or data;
- fonts, icons, textures, models, example documents, or other media; or
- code under a license not included in the dependency allowlist below.

Approval must identify the exact material, intended use, governing terms,
required attribution, reviewer, and date.

## Prohibited inputs

Do not use proprietary or confidential source code, leaked material,
decompiled or minified implementations, bypassed access controls, unlicensed
assets, or material supplied in breach of a duty. Do not use external
screenshots, text, assets, internal identifiers, test fixtures, or command
sequences as implementation templates. Do not ask a generator to imitate a
named product, brand, artist, or designer.

## Dependency allowlist

The following software licenses are eligible for routine review, subject to
their exact terms and notice obligations:

- MIT;
- ISC;
- BSD-2-Clause;
- BSD-3-Clause;
- Apache-2.0; and
- Zlib.

Verified CC0 material or public-domain material may be considered for assets.
Fonts require a separately reviewed font license. Copyleft, network-copyleft,
noncommercial, no-derivatives, source-available, custom, or missing licenses
require explicit legal approval and are denied by default.

Every dependency, including development-only, transitive, bundled, WASM,
font, and media inputs, must appear in `dependencies.json` before use. An entry
must provide a stable identifier, kind, name, exact version, canonical source,
integrity hash, declared license, usage, scope, approval record, and notice
requirements. Versions must be pinned. Undeclared URL or CDN imports, install
scripts, vendored code, and floating version ranges are denied unless an
approved exception documents the need and controls.

## Research and provenance records

For each implementation-relevant source, record what factual concept was used
and which requirement, design record, test, or file it informed. A citation is
not permission to copy. Retain original experiments and calculations when they
are part of the engineering rationale.

Generated material must record its tool and version, authorized inputs,
command or prompt, settings or seed when available, output hash, reviewer, and
human changes. Deterministic build outputs must be reproducible from committed
source and must not be mistaken for authored source inputs.

## Testing sources

Derive tests from approved requirements, mathematics, platform behavior,
licensed specifications, and original synthetic data. Record the derivation.
External suites, fixtures, models, golden images, and published examples need
their own license and provenance approval.

## Enforcement and exceptions

Pull requests must fail review when they add an undeclared source, dependency,
asset, generator, or binary. Automated license or vulnerability results do not
replace human review.

An exception must be written, narrowly scoped, owned, time-limited, and
approved before use. Discovery of suspect material requires quarantine,
derivation tracing, provenance-owner notification, and independent replacement
from neutral requirements when necessary.
