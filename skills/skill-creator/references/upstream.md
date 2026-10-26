# Source and Ranite adaptation

Source: [Anthropic skill-creator](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md).
Reviewed commit: `dbd4588f9e1033efb41dad4bef2f7947c8993d44`, 2026-10-22.
The accompanying [Apache 2.0 license](../LICENSE.txt) is retained.

This is an adapted package, not a byte-for-byte mirror or an endorsement by
upstream. Retained concepts include intent capture, resource organization,
realistic cases, paired baselines, evidence-based grading, human review, iterative
improvement, optional blind comparison and description/trigger evaluation.

Ranite changes:

- Use actual file/command/worker tools and explicit workspace/global destinations.
- Apply Ranite's naming, 1024-character description and discovery/index semantics.
- Treat testing depth and delegation as task-dependent; no blanket interview,
  parallel-worker or paid model-campaign requirement for every edit.
- Keep false/unavailable metrics distinct from measured data and leave unknown
  timing/token values null. Inline self-review is not an independent baseline.
- Supply a local JSON/static-HTML summarizer instead of assuming Claude's Python
  evaluator, SDK, CLI, notification fields or browser server.
- Preserve name/user changes and distinguish validation, copying, discovery,
  dependency readiness and actual behavioral evidence.

The original Python scripts, Claude/Cowork-specific instructions and agent-role
files were inspected as design input, not executed or silently installed. Their
platform-specific automation is not advertised as a Ranite capability. The local
helpers and JSON schema are described in [Ranite integration](ranite.md) and
[schemas](schemas.md); they do not claim upstream viewer-format compatibility.
