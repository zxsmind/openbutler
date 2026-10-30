# Writing a skill that survives real use

Read for package design, frontmatter, resource organization and revisions.

## Capture the capability

Determine the repeatable outcome, typical request language, required inputs,
environment assumptions, result/artifact contract and the failure boundary.
Conversation history can already answer these. Retain corrections that describe
the intended workflow, without turning one incident into a universal restriction.
An unclear public/business decision can need a question; obvious implementation
details usually do not. A user who asks for a draft need not approve another plan
before receiving it.

Choose the lightest useful shape: a compact procedure for a narrow operation, a
router with focused references for a multi-topic manual, scripts for recurring
deterministic work, and assets only for actual output templates. Do not create
empty agents/references/assets directories or generic README/changelog files just
because another package has them.

## Frontmatter and discovery

```yaml
---
name: example-skill
description: "Produce the requested example artifact. Use when the user asks to create or revise that artifact, including the relevant specialized format."
---
```

OpenButler requires name to match the directory, lowercase letters/digits with single
hyphens, at most 64 characters. Description is nonempty, at most 1024 characters.
Quote colon-bearing YAML values. Metadata is read from a bounded frontmatter
prefix; a beautiful Markdown body cannot repair an invalid header. Optional
license/compatibility/metadata can document provenance and requirements, but a
foreign runtime's fields do not magically implement features here.

Description is the selection interface. Explain what the package does and where
it helps; include an exclusion when it prevents a real neighboring-skill conflict.
Avoid a generic keyword catchall. Triggers in body prose do not help selection
before that body is loaded. See [description evaluation](description.md).

## Body and resources

A useful body tells another capable agent how to reach the intended outcome:

- What to inspect or obtain before an operation and which user decisions remain.
- Tool/resource choices and the environment capability they require.
- Fragile ordering, exact formats, concrete examples and why those constraints matter.
- Expected result, meaningful verification and observable failure/recovery states.
- How to proceed when an optional integration or artifact viewer is unavailable.

Use explanations and examples instead of repeating the system's general policy.
Do not copy the user persona, turn history, secrets or a maintainer's machine paths
into reusable instructions. A product manual should teach its environment and
operations rather than replace the agent's identity or initiative rules.

Keep the entrypoint readable. Link conditional detail next to the branch that
uses it; very long references need a contents map. Paths to shipped resources are
relative and remain inside the package. External files/services are declared
dependencies with discovery instructions, not unexplained absolute paths.

Scripts need real inputs, failure/exit semantics and prerequisites. A script
copied from another runtime must be inspected and exercised against safe fixtures
before its behavior is advertised. Installation of a package is not execution of
its helpers. For output templates, distinguish placeholder fixtures from measured
results so future agents cannot mistake example metrics for evidence.

## Examples and checks

Use realistic prompts, including boundary cases and incomplete-but-normal input.
Checks should establish task outcomes: correct transformed values, an artifact
that actually opens, preserved unrelated data, or a blocked unsafe/unavailable
operation. A check that merely finds a filename or a required phrase can pass for
an empty or wrong artifact. Subjective design/writing needs a concrete review
rubric and human judgment, not a made-up numeric certainty.

## Revise an existing package

Identify its winning path, intended ownership and current dependencies. Preserve
the existing name and unrelated local changes unless the user asks to rename or
replace them. For comparison, snapshot the old package outside discovery before
editing; do not leave a second `-v2` skill competing with the old one by accident.
Change the rule/resource causing a failure, then check representative prior cases.

Do not remove a reference or script until its callers and purpose are understood.
Do not ship evaluation workspaces, cached downloads, credentials or large unrelated
assets. Keep source attribution/license notices for imported or adapted material.

## Final structural review

Parse header; check name/directory/description; resolve every real local link;
inspect scripts/dependencies; ensure resources are included in the package; check
the installed winning path. Validation is not evidence that a model followed the
skill. State separately which realistic cases were actually run and reviewed.
