# Operating recipes for common user requests

These are interface recipes, not independent background policies. Substitute the
actual installation's values and inspect the result of the selected operation.
Detailed semantics remain in the linked references rather than being duplicated.

## "Tell me what Ranite is using right now"

Use `ranite about`, `config`, `daemon status`; inspect the current UI's selected
model/workspace and connection. Report installed version, host PID/start time,
selected provider/model and relevant paths. This does not need a fresh paid model
request. [Environment](environment.md), [observability](observability.md).

## "Open web on this machine"

Choose workspace/port and start `ranite web --dir <directory>`; it returns with
the server in the background. Pair a new browser with `ranite web --pair` and
confirm Connected plus intended chat. If an existing server owns the port,
identify it before replacing it. [Web](web.md).

## "Let me open it from my phone"

Inspect host LAN/tailnet address and route; bind web to the intended reachable
interface, use that address/port on the phone and pair that browser with a fresh
URL. Check firewall/proxy/HTTPS requirements separately. Browser pairing on a PC
does not pair the phone. [Web](web.md).

## "Change the web port or workspace"

Establish the new port/directory and whether a supervisor owns the web process.
Restart that web server with the intended `--port`/`--dir`, not the entire host
just to change its listener. A changed origin has separate cookie/local draft
storage and may need pairing. Confirm the new listener and intended binding.
[Web](web.md), [projects](projects.md).

## "Add a model/provider or point it at my server"

Get exact endpoint/protocol/model id and credential-entry method. Use setup,
TUI `/provider` or web Providers, manage active models in Models and select the
desired model. Inspect capability/readiness and settled selection. Custom URL
plus credentials alone does not prove tool compatibility. [Providers](providers.md).

## "Change reasoning, visibility, theme or permissions"

Use `/reasoning`, `/thinking`, `/settings`, `/permissions` or the corresponding
supported settings fields/UI. Check effective model options and whether the
change affects TUI appearance or web presentation. For reviewer-only changes use
`ranite permissions --review-model ...` and deadline flags. [Configuration](configuration.md).

## "Install this skill" / "make a reusable skill"

Inspect current winning name/path and requested scope. For existing packages,
stage and inspect the named source/revision; for a new skill, create matching
folder/name and valid quoted YAML metadata, then references as needed. Discover
with `ranite skills --workspace <directory>` and inspect the winning path.
Refresh packaged built-ins only when editing built-in source. [Skills](skills.md).

## "Add this MCP server"

Establish the real command/endpoint/transport, working directory and host variable
references. `mcp_manage add` or CLI setup creates the definition; inspect actual
connection and offered tool names, then verify the relevant capability when
needed. There is no provider-key-store shortcut for MCP credentials. [MCP](mcp.md).

## "Create a task"

Choose the actual mechanism from the request: now in this chat, later in queue,
Steer, local worker, durable schedule or peer work agreement. For a schedule,
collect instruction, trigger, timezone and scope; inspect capabilities, create
the definition and verify saved/adapter/run states. [Tasks](tasks-schedules.md).

## "Every weekday at 09:00" / "in 30 minutes"

For weekday wall-clock work, use daily with at/days in the intended host zone.
For one later execution, calculate an explicit timestamp and use at. A repeating
interval is for true elapsed periods, not a substitute for either case. Inspect
the stored human-readable schedule and next due time. [Schedules](tasks-schedules.md).

## "Watch this folder" / "run when memory stays high"

Use filesystem with absolute path/recursive/debounce, or memory_pressure with
threshold/sample/duration. Specify what the resulting run should actually inspect
and report. Inspect activation errors and event/run records; saving JSON alone
does not establish an armed observer. [Schedules](tasks-schedules.md).

## "Change or stop that scheduled task"

Find its stable id with schedule list, inspect definition/log, update a complete
definition or disable/remove by id. For a running schedule, inspect the run and
its stop semantics too. A disable/remove result does not undo prior side effects.
[Schedules](tasks-schedules.md).

## "Do this after the current job" / "correct the current job"

Send normally to queue later work. Choose Steer for a particular queued message
to enter the compatible active turn. Confirm admission rather than only HTTP
acceptance. Use Stop for cancellation; the current interface determines whether
queued input is retained/held. [Sessions](terminal-sessions.md).

## "Use another project"

Inspect active/queued state and locked binding. In web choose/create a named
project and folders before the next chat's first message. In terminal use
`--workspace`; change the default for later launches with `workspace default`.
Confirm the first folder/command root and workspace memory scope. [Projects](projects.md).

## "Use a helper agent" / "ask another machine"

For a local worker, supply task/context with explicit mode and background shape;
read its actual report from the result/inbox. For another Ranite machine, inspect
team status/profile and use team messages or negotiated work. These are different
capability and delivery paths. [Workers](workers.md), [teams](teams.md).

## "Connect Telegram" / "why didn't I receive the answer?"

Use setup/status/pair and complete owner pairing. Check host environment and
outbound test. For a missing reply inspect source inbox and the explicit
send_message_to_owner receipt; ordinary assistant text is not Telegram delivery.
[Telegram and inbox](telegram-inbox.md).

## "Remember this" / "find what we discussed"

For durable knowledge, select a current memory scope and create/update its flat
document through memory_write. For a past conversation, search/read saved sessions.
For memory retrieval trouble inspect preparation/status/scope/indexIssues before
replacing data. [Memory/context](memory-context.md), [sessions](terminal-sessions.md).

## "It is slow, rate-limited, unavailable or ignoring changes"

Inspect the relevant layer: provider retry/usage, MCP state, local model readiness,
queue/approval waiting, or source/build/process/bundle activation. Associate logs
with current process/time/session. A restart is not a universal diagnosis.
[Observability](observability.md), [providers](providers.md), [maintenance](maintenance.md).

## "Update, move, back up, clean or uninstall Ranite"

Identify installation/data/OS and active work, inventory durable versus derived
files, then use the installation or maintenance procedure. Prune previews and
uninstall dry-run show actual targets; purge and ordinary uninstall differ.
Copying live SQLite alone is not a consistent full backup. Confirm restored
sessions, attachments, memory, credentials via supported surfaces and startup.
[Maintenance](maintenance.md).

## "Connect my Modal account" / "deploy a GPU service"

For account access use web Modal save/verify; inspect credential access/app count.
For deployment, discover the actual separately available CLI/MCP/API workflow and
target configuration. A valid token does not establish a deployed service or
authorize an unrelated paid job. [Configuration](configuration.md).
