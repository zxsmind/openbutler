# Updates, backups, migration, cleanup and source responsibilities

Contents: data inventory, updating/activation, backup/restore, pruning, uninstall,
source builds and manual upkeep. Related: [environment](environment.md),
[skills](skills.md), [observability](observability.md).

## Persistent data inventory

Derive the root from `ranite about` and [environment](environment.md).

| Path relative to data root | Meaning |
| --- | --- |
| `settings.yaml` | Public configuration |
| `config.yaml` | Protected provider/team/Modal secrets |
| `sessions/<id>/` | Canonical session JSON and attachments |
| `MEMORY/` | Canonical memory Markdown and shared mirrors |
| `state.db` | Durable activity/run/usage state plus derived indexes |
| `projects.json` | Named project catalog |
| `catalog.ndjson` | Provider/model catalog cache |
| `models/` | Prepared local memory-model assets |
| `packages/` | Runtime packages installed on demand |
| `skills/` | Ranite-specific global skills |
| `tool-output/` | Full tool/command output spilled beyond inline limits |
| `mcp/` | Default MCP process working directory |
| `telegram/` | Channel-staged incoming/outgoing media |
| `team.db`, `team-files/` | Team hub state and file-sharing data |
| `logs/ranite.log`, `logs/web.log`, `daemon.log` | Operational/lifecycle logs |

Other discovery roots and OS environment variables live outside this root. A
data-root backup alone does not include workspace source files, all globally
discovered skills, service definitions or external credential-variable storage.
`state.db` is **not** wholly disposable just because embeddings are derived.

## Update an installed package

Identify the installation method and selected release, then use the corresponding
installer/package workflow. Re-running the release installer with an explicit
version is different from rebuilding a development checkout. Verify installed
version with `--version`/`about`; then verify actual process identity and code
activation. Current installer flags are in [environment](environment.md).

There is no native universal `ranite update`/`ranite backup` command in the reviewed
CLI. Do not invent one. Updating the binary directory normally preserves data;
removing data with purge is an independent operation.

## Five activation states

| Layer | Evidence/activation |
| --- | --- |
| Source | Edited files; not yet compiled or necessarily loaded |
| Built application | `npm run build` outputs backend plus bundled skills |
| Running host | PID/start time and loaded application entry; restart after code update |
| Running web server | Its process loaded the web adapter and captures web build id at startup |
| Browser client | Script asset actually loaded; a page can retain an old bundle |

`npm --prefix web run build` creates the frontend under `dist/client`; it does not
replace the host or web process. Vite development serving is a separate mode that
proxies API requests to the host-backed web server. The normal browser UI can
reload after noticing a changed build when idle, but the web server's captured
identity and the currently loaded bundle must be considered. A hard refresh can
load new assets without proving backend code was replaced.

`ranite restart` stops active host work and recycles a tracked web server. For a
coordinated update, identify busy
and queued state, settle/save appropriately, replace host, replace web server when
its adapter/build identity changed, then confirm both process identities and
browser connection. Closing a terminal is not a host restart. Existing browser
pairing is persistent, while one-time links expire/rotate. Changes to web source
labeling require both host acknowledgement and a web process using that attachment.

## Consistent backup and restore

1. Inventory data root, active workspaces, external skill roots, service environment
   references and integrations. Decide whether the backup is same-machine recovery
   or a migration with different paths/architecture.
2. Establish a consistent saved state. Idle, flushed sessions and stopped writers
   give an offline snapshot; copying a live SQLite file alone can omit WAL state.
   A supported SQLite online backup is another option for a competent operator;
   there is no invented Ranite backup CLI.
3. Preserve canonical session directories with attachments, memory, settings,
   project catalog and durable ledgers. Protected secret-store backup is an
   owner/administrator credential operation, not a reason for agent file tools to
   read/display the store. Preserve required external secrets through their own
   supported management mechanism.
4. Restore to the intended root and account, preserve file permissions, then launch
   with the intended `RANITE_DATA_DIR`. Merely changing that variable does not move
   old data. Validate configuration, sessions, memory and attachment paths.
5. Re-establish missing workspace directories, service environment, packages and
   local model assets as needed. Rebuild derived search indexes through their
   specific surfaces rather than deleting a shared durable database.

Migrating a team identity/ticket onto a second live machine can duplicate an
identity; use team membership operations for a genuinely new peer. Windows and
POSIX paths, native dependencies and startup integration are not interchangeable.
Keep the original backup until restored operations have been checked.

## Pruning and uninstall

```text
ranite sessions prune --older-than 30d
ranite sessions prune --older-than 30d --yes
ranite events prune --older-than 30d
ranite actions prune --older-than 30d
ranite uninstall --dry-run
ranite uninstall
ranite uninstall --purge --dry-run
```

The first prune form previews; `--yes` performs the selected deletion. Session
pruning removes actual saved session files/attachments, not just search rows.
Ledger pruning reports event/action/transition counts and has host-state checks.
Ordinary uninstall removes the installed program/startup/PATH integration while
retaining data. `--purge` also removes data; `--force` affects confirmation, not
the scope of what purge means. Inspect dry-run targets first. A source checkout
does not necessarily have the installer's `app/`, `bin/`, `node/` layout.

Deleting catalog/model/package caches can require redownload; deleting Markdown,
sessions or durable ledgers can lose user facts/history. Tool-output files may
still be referenced by transcripts. Scratch alone is OS-disposable by design.

## Source checkout operations and ownership map

These paths are useful only when source is present. An installed package normally
contains compiled `dist` and dependencies, not unpublished development documents.

| Responsibility | Source authority |
| --- | --- |
| CLI commands/flags and onboarding | `src/cli-main.ts`, `src/cli/*` |
| Settings validation/secret separation | `src/settings.ts` |
| Data paths, startup and daemon lifecycle | `src/paths.ts`, `src/daemon.ts`, `src/daemon-autostart.ts` |
| Local IPC identity, attachments and reconnect | `src/daemon-host.ts`, `src/daemon-client.ts`, `src/daemon-protocol.ts` |
| Queue, steering, outcomes and prompt framing | `src/agent-session.ts`, `src/communication.ts`, `src/turn-types.ts` |
| Provider/model catalog, adapters and retries | `src/provider/*` |
| Tool catalog and schemas | `src/tools/catalog.ts`, `src/tools/*` |
| Skills discovery and packaged copy | `src/skills.ts`, `skills/`, `scripts/copy-builtin-skills.mjs` |
| Web transport and UI | `src/web/server.ts`, `web/src/*` |
| Projects | `src/projects/*`, web project selector |
| Memory schema/search and sessions | `src/memory-*`, `src/session-store.ts`, session tools |
| Schedules, inbox, team and workers | Schedule tool/runner, inbox, `src/team/*`, worker records and host |
| Operational logs and usage | `src/logging.ts`, `src/usage/*`, activity ledger |

Use repository instructions for source builds. Normal commands are `npm run
typecheck`, `npm run build`, and `npm --prefix web run build`. Installation of
dependencies, cross-platform packaging and output paths are separate repository
concerns. On Windows Docker Desktop, putting high-file-count dependency/build
output on a Windows bind mount is very slow; this repository's AGENTS.md directs
heavy container work into its filesystem/volume and copies final artifacts out.
Do not turn one checkout's absolute paths into a global skill installation path.

## Updating the built-in manual

Edit source `skills/ranite`, not only `dist/builtin-skills/ranite`. Run the canonical
copy step or backend build to distribute all referenced resources. Validate YAML,
relative links, supported command/tool names and discovery in both source and
package. A higher-precedence skill can mask it. A frozen active model context can
retain the old index; [skills](skills.md) explains discovery versus activation.
Keep version/review metadata aligned with actual source, and do not include
private tokens, personal paths or internal working documents in shipped references.
