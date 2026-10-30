# Evaluation and helper data contracts

These OpenButler-local JSON shapes are not a claim of compatibility with Anthropic's
Python viewer. Examples are fixtures, not actual measurements. All ids are stable
within a suite; artifacts and output workspaces are explicit paths.

## Case suite: evals.json

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": "normal-input",
      "prompt": "Transform the provided example file and preserve the original.",
      "files": ["/fixture/input.json"],
      "expected_output": "A separate output with the requested transformed values.",
      "assertions": ["The original fixture is unchanged", "The produced values match the requested transformation"]
    }
  ]
}
```

Assertions can be empty while designing cases. They should describe observable
outcomes, not leak the exact implementation. Keep expected answers away from a
run when giving them would invalidate the experiment.

## Recorded results: input to summarize-evals.mjs

```json
{
  "skill_name": "example-skill",
  "iteration": "iteration-1",
  "runs": [
    {
      "eval_id": "normal-input",
      "variant": "with_skill",
      "repeat": 1,
      "status": "completed",
      "prompt": "Transform the provided example file.",
      "summary": "The separate output was inspected and the input stayed unchanged.",
      "artifacts": ["/output/transformed.json"],
      "checks": [
        {"text": "Original fixture unchanged", "status": "passed", "evidence": "Fixture hashes match before and after."},
        {"text": "Requested values transformed", "status": "passed", "evidence": "The output values match the case expectation."}
      ],
      "metrics": {"duration_ms": null, "total_tokens": null}
    }
  ]
}
```

Required suite fields: nonempty `skill_name`, nonempty `runs` array. Iteration is
optional. Required run fields: nonempty string eval_id/variant, positive integer
repeat, status completed/failed/blocked, checks array. Each check needs nonempty
text/evidence and status passed/failed/blocked. Metrics are optional; each known
metric is a finite nonnegative number, unknown is null. Prompt/summary are strings
when supplied, artifacts is a string array. Duplicate eval_id/variant/repeat keys
are rejected, and unknown status values are not treated as passes.

Use variants such as `with_skill`, `without_skill`, `old_skill`, `new_skill`, with
the actual comparison clearly named. A blocked run/check requires a reason in
summary/evidence. Do not change an observed failure to blocked just to improve
pass rate. A completed run with zero checks has no measured check pass rate.

## Report semantics

`benchmark.json` contains validated recorded runs and per-variant summaries:
run counts by status, check counts by status, observed check pass rate, and
available duration/token statistics. Pass rate uses passed plus failed checks;
blocked checks are reported separately. Null denominators/unknown metrics remain
null. Each metric reports count/mean/sample standard deviation; one sample has
no measured variance and therefore stddev null.

`review.html` is a static, escaped presentation of that same information. Artifact
paths are displayed as text; no artifact is automatically executed or fetched.
The report directory must not already exist. The helper does not invent a winner,
significance claim, model choice or paired-run identity beyond the supplied data.

## Trigger cases

```json
[
  {"id":"positive-1","query":"Please create the specialized artifact from these inputs.","should_trigger":true},
  {"id":"near-miss-1","query":"Explain what this artifact format means; do not create anything.","should_trigger":false}
]
```

Record actual selection/body-read evidence separately from the intended label.
Source case labels alone do not measure selection accuracy.

## Human feedback and optional comparison

A simple feedback record can contain eval_id, artifact paths, reviewer, observed
problem and desired change. An optional blind comparison records labels A/B,
original task/rubric, winner A/B/tie/inconclusive and concrete evidence. Do not put
version identity in the blinded review inputs or use missing evidence as a win.
