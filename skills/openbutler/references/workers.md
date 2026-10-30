# Local workers and subagents

Contents: modes, foreground/background, inputs, reports, constraints and stopping.
Related: [tasks](tasks-schedules.md), [inbox](telegram-inbox.md), [tools](tools.md).

## Worker versus peer versus saved session

A worker is a bounded local agent session started by a parent. A team peer is
another machine. A saved session is searchable history and need not be live.
`subagent` starts a worker; `session_message` reaches a live worker from its owning
custodian; `session_read` only reads saved history. None is a new recurring schedule.

## Start a worker

Required inputs are `task`, `mode`, `background`; optional `context` contains
`paths` and `notes`. Task text is at most 8000 characters. Both mode and run shape
are explicit; there is no implicit default.

```json
{
  "task": "Inspect the named module's input validation. Return concrete findings and file locations without editing files.",
  "mode": "explorer",
  "background": true,
  "context": {"paths":["/absolute/project/module"],"notes":"The parent is checking the existing behavior only."}
}
```

| Choice | Behavior |
| --- | --- |
| `explorer` | Read/search/memory/session tools; no file writes or shell execution |
| `executor` | Core file tools plus command execution |
| `background: false` | Call waits and returns the worker's last assistant report |
| `background: true` | Returns worker session id while it continues; reports through inbox |

The worker does not inherit the parent's full conversation. It receives the task,
explicit paths/notes and worker context. Relevant scope, decisions, constraints,
expected output and verification therefore belong in that input. A displayed
assignment is not evidence that its operations succeeded.

## Capabilities and lifecycle

Workers do not get MCP tools, cannot ask the human directly and cannot approve
actions on the human's behalf. Executors may start one further worker layer;
explorers may not. Current running caps are eight per main session, two per worker
parent and ten per machine. The host enforces write leases so two running workers
cannot claim the same file simultaneously. A cap returns `busy`; it is not success.

Workers have no separate arbitrary step/time budget. A foreground wait still
obeys the tool call's deadline (default 60 seconds; `_timeoutSeconds` can change
the host execution deadline up to 500 seconds). Background shape is available for
work whose lifetime should not be tied to that wait.

## Retrieve progress and final results

- Foreground returns the report as the tool result.
- Background returns the session id and notification reference. `parent_message`
  can persist interim notes; `kind` is `progress`, `blocked` or `question`.
  Progress is quiet by default; blocked/question notes can wake the parent unless
  the owner has held it.
- Completion/failure makes an inbox notification and a short host pointer. The
  full report is not automatically substituted into the parent's task context.
- `inbox list/read` retrieves content. Saved parent consumption is tracked so an
  already-read result need not create an obsolete wake.
- `session_read` inspects the saved worker transcript; TUI worker rows can open
  a view-only transcript. Viewing a worker does not become authorization to submit
  arbitrary work as that worker.

## Message or stop a worker

`session_message` takes `session` and `text`; it is for live worker steering, not
arbitrary saved conversations or a separate machine's custodian. The host checks
the live worker target and relationship and frames the input as a parent/custodian
message. It is not a new human permission grant.

`subagent_stop {"session":"<worker-id-or-prefix>"}` stops a worker under the
owning parent's scope. A stop request does not erase a saved report or undo a file
write that already happened. Read resulting status/transcript and reconcile any
partial operation before assigning the same consequential operation elsewhere.

Typical failures: unknown/ambiguous session prefix, saved-but-not-running target,
tool unavailable in explorer, absent MCP capability, blocked write lease, cap
exhausted, deadline expired or explicit owner hold. Each requires inspecting the
actual result rather than interpreting every response as a completed worker job.
