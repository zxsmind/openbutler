# Durable memory, search and context compaction

Contents: file layout, document schema, write/search tools, preparation, history
and compaction. Related: [sessions](terminal-sessions.md), [maintenance](maintenance.md).

## Stores and scope

Markdown under the data directory's `MEMORY/` is canonical memory. SQLite vectors
are derived indexes, not a replacement for those documents. Saved conversation
transcripts are a separate store searched with session tools.

```text
MEMORY/
  MEMORY.md
  user/preferences.md
  user/profile.md
  topics/<topic>.md
  areas/<project-area>.md
  workspaces/<workspace-key>/profile.md
  self/peers/<member>.md
  team/<team-key>/decisions.md
  team/<team-key>/shared.md
```

User preferences/profile, topics and areas are shared across workspaces. A
workspace profile is directory-local working state. Workspace keys use the first
24 hex characters of a hash of the canonical workspace path. Folder placement
defines scope; a YAML field cannot grant cross-workspace visibility. Self peer
observations are local. Team files are hub-derived mirrors maintained by team
operations, not ordinary editable shared notes.

`MEMORY.md` is the user-scope entrypoint/index: one line per linked note, signal
and updated date; at most 200 lines and 25 KB. Workspace profiles are found from
scope, not listed in this cross-workspace index. Directories such as legacy
`user/notes` or older migration folders are not the current creation layout.
Startup migration can repair older layouts and retain conflicts under `.migration/`.

## Document shape

```markdown
---
title: Example project facts
description: Stable facts about the example project
updated: 2030-01-15
type: project
---
# Example project facts

Facts needed to operate the example project and their verification context.

- The service uses port 8080 as confirmed in its deployment settings.
```

The date is illustrative; native writes stamp the current date. Types are `user`,
`feedback`, `project`, `reference`. Title is at most 160 characters; description
at most 500. One H1 matches title. Summary and fact bullets contain the information;
headings alone do not create searchable facts. File names use English kebab-case;
reserved preference/profile names are selected by scope. Native write fields
restrict colon-bearing metadata to keep their generated YAML valid.

Memory text is English because the local embedding model is English-oriented;
exact paths, identifiers and necessary UI labels remain verbatim. This is a data
format/retrieval property, not a language setting for conversation replies.

## Using memory during work

The agent reads and writes memory through tools as the work calls for it; there
is no requirement to search every message or open every note at task start.
Consult relevant notes when a decision depends on an earlier user preference or
correction, an ongoing project, or a similar failure. A known path can be opened
with `file_read`; otherwise locate it with `memory_search` or the current index.
Read the conditions and evidence, check freshness where consequential, and apply
them to the decision. Reuse current note contents already in context. For an
earlier conversation rather than a durable fact, use session history tools.

General response and working preferences live in `user/preferences.md`; topics
hold topical facts and conditional lessons; areas hold project decisions and
constraints. A topic can retain evidence behind a preference and link to its
canonical rule, rather than keeping another actionable copy. The profile holds
stable identity, and the workspace profile holds directory-local facts.

The runtime currently loads preferences/profile and an index snapshot into its
frozen system context, not the full topic/area notes or workspace profile. Writes
do not refresh that snapshot during a session. Use the write result and current
files after a correction, not an older loaded summary. Search unavailability does
not prevent reading a known path or the current index with `file_read`.

## Write, update and describe

`memory_write` actions: `create`, `append`, `replace`, `describe`. Scopes:
`topic`, `area`, `preferences`, `profile`, `workspace`. Topic/area need a `slug`.
Create uses title, description, summary and bullets; append adds bullets; replace
uses exact `old` and `new` (empty new deletes that text); describe updates a
document title and description. A replacement must match exactly once.

Before writing, find and read the existing home for the fact, reusing current
contents already in context. Replace changed facts, reconcile summary and
description, and remove superseded instructions. Append only independent facts;
exact duplicate checks cannot detect contradictions. If history matters, keep
brief dated evidence marked as superseded rather than old imperative rules.
Do not infer user preferences from silence or record an entry for every task.
Keep repository-maintained implementation details and completed run reports in
their primary sources or session history. A successful write proves persistence;
future retrieval and application must be assessed separately in actual work.

```json
{"action":"create","scope":"area","slug":"example-service","title":"Example service","description":"Stable service operation facts","summary":"Confirmed details needed for future service work.","bullets":["The service configuration is stored in the project's deployment directory."]}
```

Native writes validate shape, stamp date and update the user index as needed.
They do not require a second manual index entry for a new user note. A topic or
area is not a separate per-session conversation archive. For team-wide durable
facts use `team_remember`; ordinary file edits to the mirror do not synchronize.

## Search and preparation

```json
{"query":"Where is the service configuration?","limit":5}
```

`memory_search` takes query and optional limit 1-10 (default 5). The current index
combines local semantic vectors, exact terms/identifiers and evidence thresholds.
It searches shared user memory, self peer notes, the active workspace and active
team scope; other workspaces and teams left behind are excluded. Results include
canonical path, title, description, heading hierarchy and 1-based line references.

| Status | Meaning |
| --- | --- |
| `completed` | Source matches returned |
| `no_matches` | No sufficiently relevant evidence; not a system failure |
| `empty_memory` | No notes available |
| `empty_notes` | Notes exist but contain no searchable text |
| `model_preparing` | First-time local asset preparation in progress |
| `model_unavailable` | Local model cannot be used; inspect reason |
| `invalid` | Input failed validation |

`indexIssues` points to missing/stale index links. Repair the canonical document
or link, not a guessed SQLite row. Setup can prepare local memory assets; the
runtime also starts preparation in the background. Web Memory exposes status.
A serving LLM/GPU provider and the local 384-dimensional memory embedding model
are different components. Reinstalling a chat provider does not repair a missing
embedding model, and deleting the index does not restore deleted Markdown.

## Context, compaction and archives

Context limits come from the selected model. As context approaches its limit,
the host can run compaction: a model-generated continuation checkpoint covers
older context while recent dialogue/tool results remain available. Full older
conversation data is retained in the session archive. `/compact` requests it
manually; a mid-run request waits until settled tools and the next model-step
boundary, with idle fallback if no further step occurs.

Compaction is not durable user-memory writing, transcript deletion, a model
switch or proof the original job completed. The display transcript, active model
conversation and pre-compaction archive can have different sizes. On failure the
existing context is not silently replaced by an empty/invalid checkpoint. Inspect
the compaction entry/error, then decide whether to retry or change the actual
context pressure. A frozen system context is rebuilt at relevant boundaries,
including after compaction; that can refresh skill metadata and memory entrypoints.

For old chat facts use `session_search`/`session_read`; for operational durable
notes use `memory_search`. [Maintenance](maintenance.md) explains their backup and
derived-index differences.
