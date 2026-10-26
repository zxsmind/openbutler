# Tasks, schedules and observers

Contents: task terminology, schedule schema, all triggers, CLI/tool procedures,
runtime state and stopping. Related: [workers](workers.md), [teams](teams.md),
[observability](observability.md).

## What "task" can mean

| Desired operation | Ranite mechanism |
| --- | --- |
| Do something now in this conversation | Normal owner request |
| Do a second job after current work | Owner message queue |
| Correct or ask about current work | Explicit Steer |
| Delegate a bounded piece to a local agent | `subagent` |
| Run at a time, repeatedly, or on an observed condition | `schedule` |
| Agree on work with another Ranite machine | `team_work` |

There is no current `ranite task` CLI. A schedule is a durable instruction plus
trigger and scope, not simply a promise in assistant text. Normal input and a
background worker are not automatically recurring schedules.

## Schedule definition

Tool input uses `action`, `scheduleId` for id-based actions, and `schedule` for
add/update. Required schedule fields are `name`, `instruction` and `trigger`.
Optional fields are `id`, `workspaceRoot`, `originSessionId`, `enabled`.
The id is generated when absent; an explicit id is 1-64 lowercase
letters/digits/underscores/dashes. Name is 1-128 characters. Workspace defaults
to the caller, origin session to the caller, and enabled to true.

Example manual task definition:

```json
{
  "id": "inspect-service",
  "name": "Inspect service",
  "instruction": "Inspect the selected service status. Record the observed state and timestamp. Report a changed or failed state with the relevant evidence.",
  "workspaceRoot": "/absolute/path/to/project",
  "enabled": true,
  "trigger": { "adapter": "manual", "options": {} }
}
```

Replace paths and the actual target/instruction. Instructions are read by a future
run: include goal, required inputs, what counts as finished and requested reporting.
Definitions live in settings; observations, execution state and runs live in the
ledger. A scheduled run is bound to its recorded workspace/origin context; when
the original session is unavailable, the host has a persistent schedule session
fallback. `schedule open` opens the schedule's session in an interactive TUI.

When adding through the agent tool, omitting `originSessionId` selects the calling
chat. Set `originSessionId: ""` explicitly to run in a dedicated persistent
schedule session. That session is reused on subsequent runs and restored after
a host restart; it is not a new session per run. Updates that omit
`originSessionId` preserve the existing choice.

## Every current trigger

`ranite schedule capabilities` or `schedule {"action":"capabilities"}` returns
the supported adapters and options for the installed host.

| Adapter | Options and meaning |
| --- | --- |
| `manual` | `{}`; explicit run only, no observer |
| `interval` | `everySeconds`: integer 10-31536000; elapsed recurring period, not wall-clock time |
| `at` | `at`: ISO timestamp; one execution at server-local time; explicit offsets converted at creation |
| `window` | `from`, `to`: ISO timestamps, to later than from; runs at earliest time, missed window runs late |
| `daily` | `at`: `HH:MM`; optional `days`: mon/tue/wed/thu/fri/sat/sun; absent means every day |
| `filesystem` | Absolute `path`; optional `recursive` true by default, `debounceSeconds` 1-60 default 5; metadata changes, not content collection |
| `memory_pressure` | `usedPercent` 50-99; `sampleSeconds` 10-3600 default 30; sustained `durationSeconds` 10-86400 default 60 |

Examples of trigger objects:

```json
{"adapter":"interval","options":{"everySeconds":1800}}
```

```json
{"adapter":"daily","options":{"at":"09:00","days":["mon","wed","fri"]}}
```

```json
{"adapter":"at","options":{"at":"2030-01-15T09:00:00+03:00"}}
```

Time examples are illustrative. Daily/wall-clock schedules use the **host's**
timezone, not necessarily the user's phone timezone. Determine the intended zone
and host zone before converting. Daily scheduling handles DST gaps by advancing
to a valid local time. An interval is not a substitute for "at 09:00 every day".
No generic cron adapter exists in the reviewed capability list.

## Create, edit, run and inspect

```text
ranite schedule capabilities
ranite schedule list
ranite schedule add <schedule.json>
ranite schedule update <schedule.json>
ranite schedule run <id>
ranite schedule log <id>
ranite schedule open <id>
ranite schedule disable <id>
ranite schedule enable <id>
ranite schedule remove <id>
```

Add/update also accept `--json=<object>`; a file avoids shell quoting problems.
The CLI file limit is 64 KB. Explicit `workspaceRoot` takes precedence; otherwise
the CLI resolves the existing schedule/default/request workspace. Tool equivalent:

```json
{"action":"add","schedule":{"name":"Inspect service","instruction":"Inspect the specified service and report its observed state.","trigger":{"adapter":"manual","options":{}}}}
```

Use the saved id for later operations, and include the existing id for update.
Update is a schedule definition, not an arbitrary free-form settings patch;
provide required fields and preserve the intended trigger/scope. List/log/capability
are inspection operations; mutations follow the schedule workspace's permission
scope. `run` queues execution; it does not report completion.

## Verify all three states

1. Definition: correct id, instruction, enabled flag and scope in the list.
2. Adapter: active/disabled/completed/error, correct next time and no activation error.
3. Execution: a recorded run with result/error in `schedule log` and the session.

When the host is down, list can show durable state with a warning, but timers are
not live. Empty schedules start no observers or scheduled model calls. A saved
definition with an adapter error is not an operating monitor. A completed one-shot
is distinct from an enabled repeating schedule. Multiple triggers/events are
ledger-managed; use runtime status rather than assuming overlapping generations.

## Stop and recover

Disable/remove prevent further scheduling and host code stops the associated
named run when applicable. Run history remains in the ledger after removal.
Telegram `/stop <schedule-id>` addresses a scheduled run. Ordinary owner stop
holds automatic waking until explicitly released; an event does not override it.
Inspect whether an external command already changed state before retrying a failed
run. `events retry` retries a ledger event, not necessarily the complete intended
schedule definition. Missing workspace produces an activation/run error rather
than a silently substituted directory.
