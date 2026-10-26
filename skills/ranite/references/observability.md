# Status, logs, usage and diagnosis

Contents: inspection commands, output meaning, symptom map and bounded verification.
Related: [maintenance](maintenance.md), [providers](providers.md), [web](web.md).

## Inspect the right layer

| Question | Surface |
| --- | --- |
| Which installed executable/runtime? | `ranite about`, `ranite --version` |
| Which settings are saved/ready? | `ranite config` |
| Which host process? | `ranite daemon status` and PID/start time |
| Which skills were actually discovered? | `ranite skills --workspace <path>` |
| Which models are selectable? | `ranite --list-models` and runtime selection |
| MCP defined versus connected? | `mcp_manage list`, connection results and host logs |
| Schedule saved versus running? | `schedule list`, capabilities and log |
| Owner channel connected? | `telegram status` |
| Team connection/delivery? | `team status`, `team log`, delivery receipts |
| What did a tool do? | Transcript, actions ledger and full spilled output |

Configuration describes intent; a live response/log belongs to a particular
runtime. A successful write does not prove activation, and an accepted queued
operation does not prove its eventual result.

## Logs

```text
ranite logs --lines 100
ranite logs --level warn --lines 200
ranite logs --event web.stream --json
ranite logs --file <log-path> --lines 100
```

Defaults: 100 lines and info severity. Lines accepts 1-100000; levels are error,
warn, info and debug, including more severe records. Event filter is a substring.
`--json` prints structured records. Default path is data-root `logs/ranite.log`.
Web uses `logs/web.log`; daemon startup/lifecycle also writes `daemon.log`.
A log can be empty or contain older PIDs; compare timestamps, process fields,
session/event ids and the incident window before attributing an error.

Web stream open/close, gaps/resync and client diagnostic reports can explain a
stalled page. A browser report is observational, not an instruction to modify
session state. Do not confuse the host log with a particular tool's full output
file or an unflushed model transcript.

## Usage and costs

```text
ranite usage
ranite usage --days 7
ranite usage --session <id> --json
ranite usage --model <provider>/<model> --days 30
```

Default range is 30 days; allowed days are positive up to 3650. Session and model
filters narrow local ledger rows. Model filter is provider/model form. Web Usage
adds calendar/hour views over recorded data. Records distinguish input, output,
cache reads/writes, reasoning where reported, and priced/unpriced usage. Inspect
the price source/availability rather than treating an unknown price as zero.
Local estimates/catalog prices are not the provider's finalized invoice.

Retry, compaction, reviewer and ordinary generation can incur different model
requests. Cache behavior, per-session key affinity and a switched model can alter
cost without an obvious new visible user message. Network health checks that
generate tokens or wake a paid model are different from passive status reads.

## Events and actions

`ranite events` shows durable inbound/scheduled events; `ranite actions` shows
tool-action evidence. `ranite events retry <id>` queues a retained event again.
The schedule log associates triggered runs with their results. Team delivery has
its own durable receipts. `pending`, `running`, delivered, failed and cancelled
mean different stages; check the actual returned schema.

Prune commands are in [maintenance](maintenance.md). Reading a ledger is not
re-executing an event. Retrying a failed network operation can repeat external
effects if the receiver already accepted it; inspect identity/receipt first.

## Symptom-to-inspection map

| Symptom | First useful evidence |
| --- | --- |
| Agent never starts | Binary/PATH, config readiness, host status and startup log |
| Host PID exists but CLI times out | IPC responsiveness and matching PID/start time |
| A change seems ignored | Saved value, runtime selection, process and loaded build |
| Provider rate limiting | Provider error/retry events, key position and usage |
| Model/tool unavailable | Current catalog, active model capabilities and backing handler |
| MCP startup hangs | Exact server/transport, stderr/log, host environment and deadline |
| Skill absent | YAML/name/root precedence and actual `skills` listing |
| Memory not found | Search status, English note content, scope and indexIssues |
| Old chat missing in search | Session existence and derived session index |
| Schedule never fires | Enabled definition, host clock, adapter error, due time and log |
| Telegram sees no reply | Paired owner, inbox read and explicit send receipt |
| Peer did not receive work | Membership, route, outbox/delivery and negotiated work revision |
| Browser chat jumps/stalls | Transcript geometry versus input resize; SSE gap and loaded bundle |
| Input lost after F5 | Browser origin/storage and loaded draft-capable client |
| Cannot switch project/chat | Busy/queued state or locked project binding |
| Command appears truncated | Returned full-output path, not another duplicate command |
| Review asks every time | Review deadline/model error, confidence/escalation and denial counters |

Use the next observation that distinguishes competing causes. Static code,
saved configuration, a mocked test and a live user-device interaction prove
different things. Verification examples in this manual are not instructions to
restart a busy host, delete data or make paid requests merely to obtain a status.
