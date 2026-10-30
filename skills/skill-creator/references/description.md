# Description and trigger evaluation

Read when selection is too broad, too narrow, or an explicitly requested
description optimization needs evidence. This is separate from body quality.

OpenButler exposes skill name/description/path in its index, then the model decides
whether to read its instructions. The effective index also depends on valid
metadata, winning-root precedence, index budget and frozen context. Diagnose
those first: rewriting a description cannot fix invalid YAML or a hidden copy.

## Build a useful case set

Collect realistic positive requests with varied phrasing, implicit needs and
actual task context. Include near-miss negatives that share relevant words but
need a different capability or only an explanation. Clearly unrelated negatives
are weak evidence. Capture boundaries to neighboring installed skills.

Use a small justified set initially; around eight-to-ten positives and negatives
can be useful for a broader campaign, but counts are not a requirement. Store
query, stable id and should_trigger label as in [schemas](schemas.md). Review
ambiguous labels with the user when they affect intended scope. Keep private
real-world details out of distributable fixtures.

## Observe actual selection

Run cases in fresh contexts with comparable model/settings and the intended
index. Record which skill body was read, not whether an output merely mentioned
the skill's name. If the harness already loads the target instructions, it does
not test discovery. If no selection trace/body-read observation is available,
mark selection as unobserved; semantic review of a description is not a measured
trigger rate. Repeated model runs can cost tokens and need justified scope.

No included helper calls `claude -p`, assumes the author's current model id is
available, or provides a universal OpenButler selection-test endpoint. Use the
actual supported execution/trace surface and document its limitations.

## Revise and compare

Describe capability plus contexts where it provides value. Add a concise boundary
where a real competing workflow exists. Do not inflate metadata with every
keyword in the domain or force activation for every simple related question.
Keep the 1024-character limit and quote YAML correctly.

Retain held-out cases rather than tuning every label into the training set.
Compare false positives, false negatives and repeat variability under the same
conditions. Do not select a winning description from training score alone or
announce a numerical result when only a static review occurred. Validate the
final header and actual index visibility after changing metadata.
