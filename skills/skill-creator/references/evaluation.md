# Behavioral evaluation, comparison and iteration

Read for an authorized test campaign or an actual quality comparison.
Data shapes are in [schemas](schemas.md). Description selection is a separate
problem covered in [description](description.md).

## Design useful cases

Capture the original request, bounded fixture inputs and user-visible expected
outcome. A small first set can cover a normal request, a meaningful edge case and
a recovery/dependency case. Expand when gaps appear; a fixed large count is not
quality. Keep evaluation inputs separate from the shipped skill unless they are
deliberate reusable examples. Never put real credentials in a test fixture.

Each expectation must be checkable from an artifact, transcript, state read or
documented user review. Prefer semantic checks over wording matching. A PDF named
correctly but containing wrong fields is a failure; a screenshot is not a rendered
PDF inspection if it depicts another build. Record the exact artifact/version.

Subjective cases use a task-specific rubric: correctness/completeness/usability,
visual hierarchy, tone or another relevant dimension. Explain what poor,
acceptable and strong outputs mean. Do not force objective pass/fail claims where
the only evidence is a human aesthetic preference.

## Scope runs before starting

Model/provider runs, external APIs and artifact generation can cost money or
change state. Skill editing alone does not require running those operations.
Choose safe fixtures and the requested depth: structural check, functional smoke,
paired comparison or broader benchmark. If a missing permission/capability blocks
a run, mark it blocked and continue independent authorized work.

Use an outside-package workspace such as a task-owned temporary directory or the
user's selected output folder. Create only needed iteration/case directories:

```text
evaluation-workspace/
  baseline-snapshot/
  iteration-1/
    eval-1/
      with_skill/run-1/
      old_skill/run-1/
    results.json
  report/
    benchmark.json
    review.html
```

This layout is an example, not an excuse to scatter generated files into every
skill folder. Preserve previous iterations when comparison/recovery needs them.

## Execute comparable cases

For a new skill, compare with a no-target-skill baseline when feasible. For an
update, compare with the preserved previous version. Use the same request, input
fixtures, selected model, reasoning/settings and comparable tools. Allocate a
separate output directory for each variant/repeat so they cannot overwrite or
learn from one another's artifacts.

OpenButler `subagent` is optional. Supply task, skill path, fixtures, output location,
mode and background explicitly; workers do not inherit this conversation. Explorer
is read-only, executor can write/run core tools, neither has MCP. A task requiring
browser/office/MCP capabilities cannot silently be evaluated with an incapable
worker. Foreground waits obey host tool deadlines. Respect owner holds/stops and
available worker caps; evaluation is not permission for unlimited delegation.

`openbutler --c` is another available isolated request shape, but it still has its own
normal discovery, permissions, provider costs and tool execution. A baseline
instruction saying "do not load the target skill" is weaker than an environment
that actually excludes it. Record whether the target body was accessible/read.
If the executing context already read both versions, call the result an inline
sanity check, not an independent experiment. Do not edit live global discovery
roots merely to manufacture a baseline.

For paired repetitions, keep fixtures and settings consistent and label every
run. Missing tokens/timing stay null; record values from available host/run usage
or measured boundaries rather than inventing notification fields. Record failed
and blocked attempts too, including provider/capability failures.

## Grade actual evidence

For each check inspect the artifact/transcript at its recorded path. Verify
content and preserved state, not only whether a tool was invoked. Record passed,
failed or blocked and specific evidence. Blocked means the check could not be
performed; an observed wrong or missing required result is failed. Also extract
important unsupported claims made by the execution and flag discrepancies.

Programmatic checks are preferable where the behavior has a real deterministic
seam. Run them only against the selected test output, and keep their scope
explicit. A language-model judge is an assessment, not an objective truth oracle.
If a grader cannot open the relevant binary/image, mark its limit rather than
inferring visual correctness from filenames or source code.

Review the checks themselves: an always-passing/non-discriminating check, a weak
filename test, leaked expected answer or a check requiring unavailable evidence
can make the score misleading. Repair that measurement problem separately from
changing the skill to satisfy it superficially.

## Summarize and show outputs

Collect explicit run records as in [schemas](schemas.md), then optionally use:

```text
node <creator>/scripts/summarize-evals.mjs <results.json> <new-report-directory>
```

The helper validates its input and produces static JSON/HTML from recorded data.
It never runs a model, script, tool or listed artifact. Unknown metrics remain
unknown; blocked checks are visible, not counted as successes. Mean/stddev are
descriptive statistics, not a significance test. Compare matched cases/repeats
before attributing aggregate differences to the skill.

Give the user the actual task outputs as well as the report. HTML score cards do
not replace reading a document or interacting with a UI. Human feedback can be
recorded per case with artifact references and concrete desired changes. If no
browser is available, show a concise comparison and provide the artifact paths;
no local server or foreign eval-viewer is mandatory.

## Optional blind comparison

Label output sets A and B without revealing version identity to a capable
independent reviewer. Supply the original task, fixtures and relevant rubric,
not the desired winner or author explanation. Allow a tie or an inconclusive
result. Correctness and task completion precede superficial formatting. Save
evidence for each judgment and disclose reviewer capabilities/limitations.

## Improve and stop

Revise for patterns supported by evidence. Do not overfit one sample, loosen a
check to manufacture improvement or silently change model/settings between runs.
Keep representative/held-out cases for regression checks and retain the baseline.
Stop at requested scope, satisfied outcome/user feedback, diminishing useful
progress or a real blocker. Further paid runs need their own justified scope.
Report structure/discovery checks separately from behavioral/model evidence.
