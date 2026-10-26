# Complete command and control index

This index covers reviewed CLI 0.5.0. A command can open a UI, start a host, contact
a catalog/service or mutate state; its linked procedure explains the effect.
Placeholders in angle brackets are values, not literal shell syntax. Use the
installed `--help` and tool schemas when the running version differs.

## Main entry and inspection

```text
ranite
ranite --workspace <directory>
ranite --c "<request>" [--workspace <directory>]
ranite --list-models [--provider <id>] [--filter <text>] [--limit <n>]
ranite --version
ranite --help
ranite -h
ranite about
ranite config
ranite setup
ranite workspace default [directory]
```

`--workspace` requires a directory value. `--c` is the one-shot request flag;
arbitrary unsupported flags do not configure model settings. `workspace default`
without a path prints the existing choice. [Environment](environment.md) and
[providers](providers.md) describe these entry points.

## Credentials, models and permissions

```text
ranite keys
ranite keys list
ranite keys add <provider>
ranite keys remove <provider>
ranite permissions [workspace|auto-review|full-access]
ranite permissions --review-timeout <5-600>
ranite permissions --approval-timeout <5-600>
ranite permissions --review-model <provider>/<model>
ranite permissions --review-model none
ranite approve
ranite approve <number>
```

Keys are entered through masked prompts, not an extra raw-key argument. Model
selection is setup, TUI `/models`, or web. There is no invented `ranite model set`
command. [Configuration](configuration.md) and [providers](providers.md).

## Host and web

```text
ranite daemon
ranite daemon start
ranite daemon status
ranite daemon stop
ranite daemon install
ranite daemon uninstall
ranite daemon autostart [on|off|status]
ranite daemon autostart-status
ranite stop
ranite restart
ranite web [--port <1-65535>] [--hostname <address>] [--dir <directory>]
```

`daemon` defaults to status. `daemon run` is the internal child-process entry,
not the normal user launch. Install/uninstall here manage startup registration;
program removal is below. `restart` accepts no positional task/scope argument.
[Environment](environment.md), [web](web.md).

## Skills and MCP

```text
ranite skills [--workspace <directory>]
ranite mcp
ranite mcp list
ranite mcp add
ranite mcp remove
```

MCP add/remove are interactive configuration flows, not arbitrary inline JSON CLI
subcommands. Agent `mcp_manage` provides connection actions. There is no current
native `ranite skills install` command; skill installation is package/file work
through the documented workflow. [Skills](skills.md), [MCP](mcp.md).

## Schedules and tasks

```text
ranite schedule
ranite schedule list
ranite schedule capabilities
ranite schedule log <id>
ranite schedule add <schedule.json> [--workspace <directory>]
ranite schedule update <schedule.json> [--workspace <directory>]
ranite schedule add --json=<schedule-object>
ranite schedule update --json=<schedule-object>
ranite schedule run <id>
ranite schedule open <id>
ranite schedule enable <id>
ranite schedule disable <id>
ranite schedule remove <id>
```

Default is list; open needs an interactive terminal. A JSON file avoids shell
quoting pitfalls for multiline instructions. There is no `ranite task` command
or generic cron-adapter flag. [Tasks and schedules](tasks-schedules.md).

## Telegram

```text
ranite telegram setup
ranite telegram setup --token-env=<NAME> --workspace=<directory> [--no-wait] [--skip-test]
ranite telegram status
ranite telegram pair
ranite telegram unpair
ranite telegram disable
ranite telegram reset [--remove-env]
```

Bot controls: `/start`, `/approvals`, `/stop`, `/stop <schedule-id>`, `/clear`,
`/sessions`; pairing uses the displayed `/start <code>`. Do not confuse Telegram
slash controls with TUI slash controls. [Telegram/inbox](telegram-inbox.md).

## Team CLI

```text
ranite team init --as <name> [--name <team>] [--port <n>]
ranite team invite [--ttl-minutes <n>]
ranite team invites
ranite team invite-revoke <code>
ranite team join <address> --code <code> --as <name> [--fingerprint <fingerprint>]
ranite team join-status <address> <request-id>
ranite team pending
ranite team approve <request-id>
ranite team deny <request-id>
ranite team members
ranite team leave
ranite team remove <name>
ranite team status
ranite team log [--limit <n>]
ranite team rejoin <address>
ranite team say <message>
ranite team dm <member> <message>
ranite team inbox
ranite team read [--group] [--from <member>]
ranite team history [--group | --with <member>] [--before <seq>] [--limit <n>]
ranite team send-file <member|group> <path>
ranite team files
ranite team get <file-id> [--to <path>]
```

Default is status. Hub-only operations include invite approval/membership
management; supplying their names from a member does not grant hub capability.
Team invites/codes and tickets have different roles. [Teams](teams.md).

## Usage, logs, ledgers, session indexes and removal

```text
ranite usage [--days <1-3650>] [--session <id>] [--model <provider>/<model>] [--json]
ranite logs [--lines <1-100000>] [--level error|warn|info|debug] [--event <substring>] [--file <path>] [--json]
ranite events
ranite events retry <event-id>
ranite events prune --older-than <duration> [--yes]
ranite actions
ranite actions prune --older-than <duration> [--yes]
ranite sessions index [--rebuild]
ranite sessions prune --older-than <duration> [--yes]
ranite uninstall [--purge] [--dry-run] [--force]
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
