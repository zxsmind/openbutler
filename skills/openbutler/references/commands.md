# Complete command and control index

This index covers reviewed CLI 0.6.0. A command can open a UI, start a host, contact
a catalog/service or mutate state; its linked procedure explains the effect.
Placeholders in angle brackets are values, not literal shell syntax. Use the
installed `--help` and tool schemas when the running version differs.

## Main entry and inspection

```text
openbutler
openbutler --workspace <directory>
openbutler --c "<request>" [--workspace <directory>]
openbutler --list-models [--provider <id>] [--filter <text>] [--limit <n>]
openbutler --version
openbutler --help
openbutler -h
openbutler about
openbutler config
openbutler setup
openbutler workspace default [directory]
```

`--workspace` requires a directory value. `--c` is the one-shot request flag;
arbitrary unsupported flags do not configure model settings. `workspace default`
without a path prints the existing choice. [Environment](environment.md) and
[providers](providers.md) describe these entry points.

## Credentials, models and permissions

```text
openbutler keys
openbutler keys list
openbutler keys add <provider>
openbutler keys remove <provider>
openbutler permissions [workspace|auto-review|full-access]
openbutler permissions --review-timeout <5-600>
openbutler permissions --approval-timeout <5-600>
openbutler permissions --review-model <provider>/<model>
openbutler permissions --review-model none
openbutler approve
openbutler approve <number>
```

Keys are entered through masked prompts, not an extra raw-key argument. Model
selection is setup, TUI `/models`, or web. There is no invented `openbutler model set`
command. [Configuration](configuration.md) and [providers](providers.md).

## Host and web

```text
openbutler daemon
openbutler daemon start
openbutler daemon start --web [--port <1-65535>]
openbutler daemon status
openbutler daemon stop
openbutler daemon install
openbutler daemon uninstall
openbutler daemon autostart [on|off|status]
openbutler daemon autostart-status
openbutler stop
openbutler restart
openbutler web [--port <1-65535>] [--hostname <address>] [--dir <directory>] [--pair]
```

`daemon` defaults to status. `daemon run` is the internal child-process entry,
not the normal user launch. Install/uninstall here manage startup registration;
program removal is below. `restart` accepts no positional task/scope argument.
[Environment](environment.md), [web](web.md).

## Skills and MCP

```text
openbutler skills [--workspace <directory>]
openbutler mcp
openbutler mcp list
openbutler mcp add
openbutler mcp remove
```

MCP add/remove are interactive configuration flows, not arbitrary inline JSON CLI
subcommands. Agent `mcp_manage` provides connection actions. There is no current
native `openbutler skills install` command; skill installation is package/file work
through the documented workflow. [Skills](skills.md), [MCP](mcp.md).

## Schedules and tasks

```text
openbutler schedule
openbutler schedule list
openbutler schedule capabilities
openbutler schedule log <id>
openbutler schedule add <schedule.json> [--workspace <directory>]
openbutler schedule update <schedule.json> [--workspace <directory>]
openbutler schedule add --json=<schedule-object>
openbutler schedule update --json=<schedule-object>
openbutler schedule run <id>
openbutler schedule open <id>
openbutler schedule enable <id>
openbutler schedule disable <id>
openbutler schedule remove <id>
```

Default is list; open needs an interactive terminal. A JSON file avoids shell
quoting pitfalls for multiline instructions. There is no `openbutler task` command
or generic cron-adapter flag. [Tasks and schedules](tasks-schedules.md).

## Telegram

```text
openbutler telegram setup
openbutler telegram setup --token-env=<NAME> --workspace=<directory> [--no-wait] [--skip-test]
openbutler telegram status
openbutler telegram pair
openbutler telegram unpair
openbutler telegram disable
openbutler telegram reset [--remove-env]
```

Bot controls: `/start`, `/approvals`, `/stop`, `/stop <schedule-id>`, `/clear`,
`/sessions`; pairing uses the displayed `/start <code>`. Do not confuse Telegram
slash controls with TUI slash controls. [Telegram/inbox](telegram-inbox.md).

## Team CLI

```text
openbutler team init --as <name> [--name <team>] [--port <n>]
openbutler team invite [--ttl-minutes <n>]
openbutler team invites
openbutler team invite-revoke <code>
openbutler team join <address> --code <code> --as <name> [--fingerprint <fingerprint>]
openbutler team join-status <address> <request-id>
openbutler team pending
openbutler team approve <request-id>
openbutler team deny <request-id>
openbutler team members
openbutler team leave
openbutler team remove <name>
openbutler team status
openbutler team log [--limit <n>]
openbutler team rejoin <address>
openbutler team say <message>
openbutler team dm <member> <message>
openbutler team inbox
openbutler team read [--group] [--from <member>]
openbutler team history [--group | --with <member>] [--before <seq>] [--limit <n>]
openbutler team send-file <member|group> <path>
openbutler team files
openbutler team get <file-id> [--to <path>]
```

Default is status. Hub-only operations include invite approval/membership
management; supplying their names from a member does not grant hub capability.
Team invites/codes and tickets have different roles. [Teams](teams.md).

## Usage, logs, ledgers, session indexes and removal

```text
openbutler usage [--days <1-3650>] [--session <id>] [--model <provider>/<model>] [--json]
openbutler logs [--lines <1-100000>] [--level error|warn|info|debug] [--event <substring>] [--file <path>] [--json]
openbutler events
openbutler events retry <event-id>
openbutler events prune --older-than <duration> [--yes]
openbutler actions
openbutler actions prune --older-than <duration> [--yes]
openbutler sessions index [--rebuild]
openbutler sessions prune --older-than <duration> [--yes]
openbutler uninstall [--purge] [--dry-run] [--force]
```

Prune previews without `--yes`; duration examples such as `30d` express retention,
not a schedule time. `--json` is supported on the listed reporting commands, not
a universal output flag for every CLI handler. [Observability](observability.md)
and [maintenance](maintenance.md).

## TUI slash commands and web controls

TUI: `/help`, `/clear`, `/settings`, `/permissions`, `/reasoning`, `/thinking`,
`/compact`, `/stop`, `/models`, `/provider`, `/session`, `/skills`, `/exit`.
Terminal controls depend on current overlay and emulator; see its footer/help.

Web: sidebar chat/search/projects; composer model/reasoning/approval controls,
attachments, context, dictation, send/queue/Stop; queue Steer/remove/copy; duration
disclosure. Settings pages: Providers, Models, Modal, Usage, Logs, Approvals,
Memory, Telegram, About. These are UI surfaces, not fabricated root CLI commands.

Native agent tool names and argument summaries are in [tools](tools.md).
