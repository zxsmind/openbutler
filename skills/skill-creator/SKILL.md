---
name: skill-creator
description: "Create, revise and improve reusable Agent Skills for Ranite. Use for turning a workflow into a skill, restructuring an existing skill, evaluating its outputs, comparing revisions, or improving description-based discovery. Use skill-installer for importing an existing package unchanged."
license: Apache-2.0
metadata:
  adapted_for: "Ranite 0.6.0"
  reviewed: "2026-10-22"
  upstream_commit: "dbd4588f9e1033efb41dad4bef2f7947c8993d44"
---

# Skill Creator for Ranite

Create a usable skill package, improve it against realistic requests, and show the
evidence behind any quality claim. Enter at the user's actual stage: capture a
workflow, write a draft, revise a package, investigate failed triggering, or run
an explicitly requested evaluation. A straightforward edit does not require a
benchmark campaign. Installing an existing package unchanged belongs to
`skill-installer`.

This package adapts the Anthropic creator workflow to Ranite's tools, discovery,
workers and data roots. [Upstream and adaptation notes](references/upstream.md)
record the exact source and what changed. Claude CLI, Claude SDK and Codex app
features are not assumed to exist here.

## Select the reference

| Work | Read |
| --- | --- |
| Structure, frontmatter, progressive disclosure and useful examples | [Writing](references/writing.md) |
| Realistic test cases, baselines, grading, human feedback and blind comparisons | [Evaluation](references/evaluation.md) |
| Evaluation/result JSON and helper contracts | [Schemas](references/schemas.md) |
| Positive/negative trigger cases and description revisions | [Description optimization](references/description.md) |
| Ranite paths, tool mapping, helpers, packaging and activation | [Ranite integration](references/ranite.md) |

## 1. Capture the actual workflow

Extract already-known intent, examples, user corrections and output requirements
from the conversation before asking for more information. Establish the skill's
purpose, users, activation boundary, required inputs, output/artifacts, environment
dependencies and meaningful success criteria. Ask only for unresolved choices
that materially change the package or behavior. Existing authorization remains
valid; a routine draft is not a new approval checkpoint.

Distinguish reusable knowledge from a one-off task. An environment manual explains
how a product works; it need not become a personality/system prompt. A procedural
skill should retain flexibility where methods vary and be precise where a wrong
path, format or external effect would cause a real failure.

## 2. Inspect and choose scope

For an update, identify the winning package with `ranite skills --workspace
<directory>`, read its entrypoint/resources and preserve its name, existing
purpose, licenses and unrelated user changes. Keep a baseline snapshot outside
active discovery when a comparison or recovery is needed. Editing a temporary
copy is not installation into the user's selected root.

For a new skill, use the requested scope. Ranite-specific global skills belong
under its data-root `skills/`; project-specific skills normally belong under the
workspace `.agents/skills/`. Existing Claude/Agents/Codex roots can also expose
skills. Inspect precedence instead of creating a second conflicting copy. See
[Ranite integration](references/ranite.md).

## 3. Draft a self-contained package

Use matching kebab-case folder/name and valid YAML. Description explains the
capability and realistic use contexts without attracting unrelated requests.
The body provides the workflow, material constraints, tool/resource choices,
result checks and failure/recovery paths. Read detailed resources only when
their branch applies. Do not add directories or scripts merely to fill a template.

Resources must ship with the package or be declared external prerequisites.
Replace tool names and paths from another agent platform with capabilities
actually available in Ranite; do not invent a worker, viewer or evaluation API.
Scripts inherit the normal tool execution/approval rules, and skill text cannot
grant permissions or turn a repository instruction into owner authorization.

Optional scaffold helper, using an explicit destination whose parent exists:

```text
node <creator>/scripts/init-skill.mjs <destination-folder> --description "When this skill helps"
```

It creates only a new entrypoint and refuses an existing destination. Complete
the generated draft; scaffolding is not a finished skill. Script requirements
and fallback instructions are in [Ranite integration](references/ranite.md).

## 4. Validate structure before claiming usability

```text
node <creator>/scripts/validate-skill.mjs <skill-directory>
ranite skills --workspace <target-workspace>
```

The first checks metadata, package paths and local Markdown references. The
second proves discovery/winning path using Ranite's actual implementation.
Neither proves successful task execution. Check script prerequisites and run
new/changed deterministic helpers against safe fixtures when applicable.
Keep generated evaluation output and backups outside the shipped skill package.

## 5. Evaluate to the requested depth

For an objectively checkable skill, prepare realistic cases and artifact-level
expectations; for subjective work, use concrete human review criteria. Start with
a small useful set and expand for demonstrated gaps. Examples/templates are
[eval cases](assets/evals.example.json) and
[trigger cases](assets/trigger-evals.example.json); their examples are not scored
evidence about a user's skill.

When behavior runs are authorized and feasible, use fresh contexts with the same
prompt, inputs, model/settings and comparable tools. Compare a new skill against
a no-skill baseline, or a revision against its preserved previous version. Record
contamination/availability limitations; do not fabricate an independent baseline
from a context that already read both versions.

Ranite workers are optional execution mechanisms, not a requirement to delegate
every case. They do not inherit the whole conversation and have narrower tools;
an explorer cannot execute an output-generating task. Provider calls can cost
money and change external state. A request to write a skill alone does not imply
authorization for paid repeated model runs or real-service mutations.

Grade the actual artifacts and transcript, identify unverifiable claims and weak
checks, capture available timing/token data and keep unavailable metrics null.
Use paired repeats for variability rather than announcing a win from one lucky
sample. Read [Evaluation](references/evaluation.md) before a comparison campaign.

Optional deterministic report generation from already recorded results:

```text
node <creator>/scripts/summarize-evals.mjs <results.json> <new-report-directory>
```

It makes JSON and static HTML, uses no model/network and does not execute any
artifact. Show the user the outputs and report; a score does not substitute for
review of a document, interface, image or factual result.

## 6. Improve, package and hand off

Revise the cause of a demonstrated failure, not just words matching a failing
example. Keep a held-out check where useful and preserve the comparison baseline.
Finish at the requested quality level, when the requested checks pass, when the
user ends iteration, or when further progress needs unavailable evidence. Report
remaining gaps instead of an endless unbounded optimization loop.

Description optimization is a distinct optional step with positive cases and
near-miss negatives. Deterministic metadata parsing cannot prove the model's
selection accuracy. This package does not automatically invoke `claude -p` or
assume a special description-optimizer endpoint.

Validate the final package and discovery at its actual destination. For built-ins,
update source `skills/` and the canonical bundled copy; for external distribution,
deliver the whole directory with licenses/resources. Ranite discovers directories,
not an unexplained `.skill` archive. Report changed path/scope, validation, actual
behavioral evidence and any activation limitation. An existing frozen model
context can retain an old skill index even after filesystem discovery changes.
