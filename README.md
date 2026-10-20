# Ranite

Ranite is a general-purpose AI agent for the terminal. It runs as one background host on your machine and answers from a terminal UI, from Telegram, or from a browser client. It uses local tools, MCP servers, Agent Skills, and durable memory.

## Install

Pick the installer for your system. It downloads a self-contained package
with its own Node.js runtime — no Node.js, npm, or admin rights needed — and
sets up the `ranite` command:

Linux (x64/arm64) and macOS (bash, zsh, fish; Windows users in Git Bash too):

```sh
curl -fsSL https://raw.githubusercontent.com/zxsmind/ranite/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/zxsmind/ranite/main/install.ps1 | iex
```

A specific release: `bash -s -- --version 0.4.3` for the shell installer, or
download `install.ps1` first and run `.\install.ps1 -Version 0.4.3`.
`--no-modify-path` (shell) and `-NoModifyPath` (PowerShell) skip PATH changes.
Both installers verify the result with `ranite --version`; restart the
terminal afterwards so the updated PATH takes effect.

Published builds: Windows x64, Linux x64 and Linux arm64 in the same release;
macOS follows in a later release.

Configure a provider and model once:

```sh
ranite setup
```

The wizard asks for a provider, its API key, and one model, then downloads the
local memory model. It writes settings only at the last step, and the provider and
review steps can go back instead of restarting. On a machine that is already
configured it also offers to prepare the memory model on its own.

## How it runs

`ranite` starts the background host if it is not already running and attaches
this terminal to it. The host keeps running after the terminal closes, which is
what lets schedules, Telegram turns, and long runs continue unattended. The TUI
only renders; every turn executes in the host.

There is one machine-wide custodian conversation. The terminal, Telegram, and
the browser client all reach that same session, and each turn carries the
workspace it was sent from, so the scope of a turn never depends on which client
typed it. Bare `ranite` uses the directory you launched it in as the workspace,
so work there runs without permission prompts and nothing is asked at startup.
To attach a client to a different workspace for its turns:

```sh
ranite --workspace path/to/project
```

Pin a stable default for bare launches with:

```sh
ranite workspace default path/to/project
```

`--workspace` accepts an absolute or current-directory-relative path (including
`~` on macOS/Linux). Ranite checks that it exists and is a directory. A path
mentioned in a request does not switch the scope.

Two roots never need a permission prompt: the active workspace and the agent's
dated scratch directory under the system temp folder (`Temp/ranite/YYYY-MM-DD`).
The agent writes throwaway scripts, experiments, and intermediate output there;
the operating system may delete it at any time, so anything worth keeping belongs
in the workspace or a named project. Ranite's own memory documents, its settings
file, and the tool output it spilled to disk are also pre-authorized. The secret
store is never reachable by any tool, under any mode.

## Permission modes

Run `ranite permissions` or use `/permissions` in the session.

- Workspace (default): file and command operations inside the active workspace or the scratch directory run without a prompt. Operations outside them ask first.
- Approve for me: keeps the workspace rule and uses a model to review outside-workspace actions. Unclear or unavailable reviews ask you.
- Full access: runs tools without permission prompts.

Auto-review is a separate, tool-less model call that judges one pending request at
a time and returns `allow`, `deny`, or `escalate`. It allows only a specific
action that is clearly within the latest explicit request; low or medium
confidence never allows or denies, and any allow it deems high-risk is turned
into an escalation in code, not only in the prompt. Tool output, file contents,
and quoted text are treated as untrusted data that cannot grant authority. A
credential or oversized payload in the action makes the reviewer decline and ask
you instead. Three consecutive denials, or ten in the last fifty reviews, pause
review and send the next action to you.

A slow or rate-limited provider can time out the review, which falls back to a
manual prompt. Raise the limit with `ranite permissions --review-timeout
<seconds>` (5–600; default 15). A manual prompt waits `--approval-timeout`
seconds (5–600; default 60) before it expires; an expired prompt denies that one
action and the run continues. Run the reviewer on its own model with `ranite
permissions --review-model <provider>/<model>`, and drop it with `none`.

`ranite permissions` also reports the recorded verdicts so you can see how often
the mode decided versus needed you:

```text
Auto-review history
  Decisions       12 allow · 3 deny · 5 escalate
  Needed you      2 (timeout 1 · invalid-output 1)
```

When review denies an exact action, `ranite approve` lists the recent denials and
`ranite approve <n>` grants one retry. The retry still goes through review.

The workspace mode checks file paths, command working directories, directory
changes, and common explicit paths in shell commands. It is a permission prompt
policy, not an operating-system sandbox; shell scripts and programs can access
paths that static command inspection cannot identify. The trusted boundary is the
directory you launched Ranite in, so launching it in a home directory trusts that
whole tree for writes.

## Tools

Every session sees the same tool catalogue; a tool whose host handler is missing
answers `unavailable` instead of disappearing, so the model learns the boundary
from one call.

Files and shell: `execute_command`, `file_read`, `file_write`, `file_edit`,
`glob`, `grep`. Reads page a file or directory, take a line range, search with a
pattern, and return the sha256 of the whole file. Writes are atomic, and an edit
that would damage the file (unbalanced brackets, doubled encoding, a vanished
declaration) is refused before it lands. A command's output beyond the inline
budget streams to a file under the data directory, and the model is told where it
is instead of re-running a narrower command.

Memory and history: `memory_search`, `memory_write`, `session_list`,
`session_search`, `session_read`, `session_message`.

Collaboration: `question`, `send_message_to_owner`, `inbox`, `subagent`,
`parent_message`, `subagent_stop`, plus the team tools described below.

Background: `schedule`, `mcp_manage`.

Each call may carry `_timeoutSeconds` (1–500; default 60). It is a host option,
not a tool argument. Tool results are cut to a readable size and the complete
output is kept on disk; every result passes a secret scrubber before the model,
the transcript, or a notification sees it.

## Providers and models

Ranite carries no provider list in code. Providers and their models come from the
models.dev catalog, cached for twelve hours, and a stale cache is still used when
the catalog is unreachable. Bundled AI SDK adapters cover the common providers;
any other provider in the catalog installs its runtime package on first use into
the data directory. A self-hosted endpoint or a model the catalog does not list is
configured with `ranite setup` as a custom provider: pick the runtime package,
the base URL, and the model id.

Only models the catalog marks as able to call tools are offered. A model that
cannot call a tool is not a weaker option here; it is not an option.
`ranite --list-models` prints the tool-capable models for the configured
providers, with `--filter`, `--limit`, and `--provider`.

In an interactive session, `/provider` adds a provider, its key, and a model, and
`/models` switches among the models you have configured. Provider API keys live in
`config.yaml`, separate from `settings.yaml`; the agent can never open that file.
Manage keys with `ranite keys add|list|remove` (masked prompt, never as
arguments). Several keys for one provider are used in turn: a rate limit or a
rejected key waits through 1s, 2s, 4s, 8s, 16s, 32s and then moves to the next
key. MCP server credentials are host environment variables referenced by name,
never stored in either file.

Reasoning is chosen per model from the catalog's own options (`/reasoning`), and
thinking text is shown or hidden with `/thinking`. A stale choice resolves to the
strongest level the current model offers instead of silently sending nothing.

## Agent Skills

A skill is a directory with a `SKILL.md` that carries a name and a description in
its frontmatter. Ranite loads only that metadata at session start and reads the
instructions when a task calls for them. Roots, in override order: the bundled
skills, `~/.claude/skills`, `~/.agents/skills`, `$CODEX_HOME/skills` (default
`~/.codex/skills`), the data directory's `skills/`, then `.claude/skills` and
`.agents/skills` inside the active workspace. A later root overrides an earlier
skill of the same name. `ranite skills` lists what was found and where.

## MCP servers

`ranite mcp` adds, lists, and removes global MCP servers over stdio, streamable
HTTP, or SSE. A stdio server starts in the data directory unless it declares its
own `cwd`; environment values and HTTP headers are host variable names, never
saved secrets. Tools from a connected server join the catalogue as
`mcp_<server>_<tool>` and each call goes through the same permission gate. The
agent can manage connections at runtime with `mcp_manage`; a change rebuilds the
tool list for the next step.

## Schedules

A schedule is a saved instruction plus a trigger. Triggers: `manual`, `interval`,
`at`, `window`, `daily` (with optional weekdays, and daylight-saving gaps step
forward rather than skip), `filesystem` (metadata changes under a path), and
`memory_pressure` (a sustained free-memory threshold). Wall-clock times are
server-local, and an ISO value with an offset is converted when it is saved.

A firing becomes a durable event, runs in the session that created the schedule
when that session still exists, and otherwise continues in the schedule's own
session. Run count, last result, last error, and the closing report are kept, so
`ranite schedule list` shows the durable state even while the host is down, and
`ranite schedule log <id>` shows the recent firings. `ranite schedule open <id>`
attaches a terminal to the schedule's session. Missed intervals coalesce into one
wakeup; a one-shot that was interrupted resumes as late rather than vanishing.

## Teams

`ranite team` forms a closed group of Ranite machines over a Tailscale tailnet.
The hub binds one tailnet address (default port 47821) and refuses any other
interface. A member joins with a single-use invite code, the hub owner approves
the request with `ranite team approve`, and the member receives a bearer ticket
that is stored in the secret store. Every later request carries that ticket, and
the hub records only its hash.

Members get a shared group channel, direct messages, durable file transfer
(sha256 verified in both directions, 1 GB cap), a roster with presence and last
activity, and shared team memory: `team_remember` appends a signed entry that the
hub keeps and every member mirrors locally as `team/<team>/decisions.md` and
`shared.md`. Peer agreements are tracked with `team_work`, which moves through
propose, counter, accept, start, block, resume, complete, fail, cancel, and note,
each change carrying a revision so a stale read cannot overwrite a newer one. A
direct message wakes the session that owns it; group traffic never does.

An agent's own identity in the team is one living description it maintains with
`team_profile`, visible to peers through `team_status`.

## Subagents

`subagent` starts one bounded worker session with its own context. The worker sees
only the task and the context paths and notes it was given. Two modes:
`explorer`, which has read-only file, search, memory, and session tools, and
`executor`, which adds file writes and command execution. A foreground call waits
and returns the worker's final message; a background call returns at once and
reports through the inbox. Workers get no MCP tools, may not ask you directly, and
may spawn one further layer only. Running workers are capped at eight per session,
two per worker parent, and ten per machine, and only one running worker may write
a given file at a time. Worker sessions are saved, and a subagent row in the
terminal opens the worker's transcript.

## Telegram channel

One guided command connects a private Telegram chat to the same machine-wide
custodian conversation as the terminal:

```sh
ranite telegram setup
```

It asks for the environment variable holding the bot token (paste the token from
`@BotFather` when prompted; the value is validated live and never stored in the
settings file) and Telegram's default workspace scope, then starts the host, waits
while you send the one-time pairing command to the bot, and delivers a test
message to prove the channel works end to end. That setting selects the scope of
Telegram turns; it does not define Ranite's identity. In the chat, `/approvals`
re-sends pending approvals, `/stop` stops the current run while preserving queued
messages, `/stop <schedule-id>` stops a scheduled run, `/clear` starts a new chat,
and `/sessions` lists the last 10 chats. A live draft shows current output and a
Stop control. Completed assistant messages return to their original Telegram chat
in order; tool results and private reasoning stay separate from those replies.
Long messages are split without discarding text or cutting an HTML entity, and
confirmed chunks are not replayed after a later chunk fails.

The host tells the agent which channel supplied a request, where its answer
belongs, and whether an owner terminal and Telegram are available. A turn that
arrived over Telegram has to be answered there: text written only in the session
never reaches the owner. Background work uses `send_message_to_owner` for separate
proactive messages: `auto` prefers a connected owner terminal, then the paired
Telegram chat; an explicit `telegram` or `terminal` selects that owner channel.
Ordinary replies never broadcast to every connected channel. On Windows, a new
host can read a token already saved in the user environment even when its
launching shell has an older environment snapshot.

Further commands: `ranite telegram status`, `ranite telegram pair` (fresh pairing
code), `ranite telegram unpair` (forget the chat, keep the channel polling),
`ranite telegram disable` (stop the channel, keep the settings), `ranite telegram
reset` (remove the channel, settings, and — with `--remove-env` — the token from
the user environment).

The bot registers a command menu (`/start`, `/approvals`, `/stop`, `/clear`,
`/sessions`) in the paired chat, formats notices and approval previews as HTML
(falling back to plain text if Telegram rejects the markup), and pins an
Approvals/Stop reply keyboard that is removed again on unpair, disable, or reset.

Login startup (`ranite daemon autostart on`; `ranite daemon install` also works)
carries the token too: on macOS it is embedded in the managed LaunchAgent (written
0600), on Linux the unit reads an optional 0600 env file, on Windows the user
environment already covers logon. Rewiring happens automatically during setup;
`reset` unwires it again.

On servers, provide the token through the service manager (systemd
`EnvironmentFile`, Docker `-e`, Task Scheduler environment) and run
non-interactively:

```sh
ranite telegram setup --token-env=TELEGRAM_BOT_TOKEN --workspace=/srv/ranite --no-wait
```

## Browser client

`ranite web` serves a browser client from this machine and pushes the same session
over one server-sent event stream; rendering happens in the browser, so the host
process stays where it is.

```sh
ranite web [--port 45278] [--hostname 127.0.0.1] [--dir path/to/project]
```

It prints a one-time pairing link that expires in five minutes and sets an
HttpOnly session cookie when opened. Press Enter for a fresh link; Ctrl+C stops
the server. The address binds loopback by default; binding another interface
prints a warning, because the pairing link is then reachable from the network.
The client can send messages and images, switch chats and models, stop a run, and
answer approvals and questions.

## Durable memory

Markdown is the source of truth. Memory lives in Ranite's data directory; its
layout is the same on Windows, macOS, and Linux:

```text
MEMORY/
├── MEMORY.md                     # Single concise user entrypoint
├── user/
│   ├── preferences.md            # How to answer this user
│   └── profile.md                # Who the user is
├── topics/
│   └── <topic>.md                # Durable facts about one subject
├── areas/
│   └── <project>.md              # State of an ongoing project area
├── workspaces/
│   └── <workspace-key>/
│       └── profile.md            # Working state for one workspace
├── self/
│   └── peers/
│       └── <member>.md           # Local, unsynced peer observations
└── team/
    └── <team-key>/
        ├── decisions.md          # Hub-derived mirror, read-only
        └── shared.md
```

Workspace keys are the first 24 hex characters of the sha256 of the canonical
workspace path. Folder placement decides scope; frontmatter cannot change it.
`MEMORY.md` is the only index: one line per user-scope note, a short signal, and
the note's updated date, capped at 200 lines and 25 KB. The workspace profile is
found through the active workspace path and is never listed there. The shared team
files are a materialized view of the hub's log and are never written by a file
tool; the only way to record shared memory is `team_remember`.

Every note uses the same flat shape: YAML metadata with `title`, `description`,
`updated`, and `type`, one H1 that matches the title, one short summary paragraph,
then one durable fact per bullet. `type` is `user`, `feedback`, `project`, or
`reference`. Filenames are English kebab-case. A native write stamps the date,
adds the index line for a new user-scope note, and validates the document before
replacing the file. Existing layouts are migrated at startup: older note folders
consolidate into `topics/` and `areas/`, conflicting copies are archived under
`.migration/`, and links are repaired outside code examples.

Memory search runs fully locally on a pinned 384-dimensional model that prepares
itself in the background, so the tool is always available and otherwise reports
`model_preparing` or `model_unavailable` with the reason. Matches combine meaning
with exact terms and identifiers, then pass an absolute floor and an evidence test,
so unrelated queries return an honest `no_matches` instead of a weak tail. Each
match includes the document description, the full heading path, and exact
file/line references. Only the shared user scope, the agent's own scope, the
active workspace, and the active team are searched; session transcripts are
separate. SQLite embeddings are a derived cache and refresh when Markdown changes,
and a later search reports `indexIssues` for any index link that has gone stale.

## Sessions and storage

Sessions are JSON files under `sessions/<id>/`, each with its attachments in the
same directory. A session stores the display transcript, the model conversation,
and — once a compaction has happened — the complete pre-compaction archive.
Saving is debounced during a run and flushed on exit.

When the model context approaches its limit, Ranite compacts automatically: one
model request writes a continuation checkpoint covering the whole context, recent
dialogue and the latest tool results stay verbatim, and older reasoning and large
tool payloads are covered by the checkpoint while remaining in the archive.
`/compact` requests one by hand; a request made mid-run is served at the next step
boundary, after the pending tool batch and before the next model request.

`session_search` searches every saved transcript on the machine, lexically first
and with a semantic rerank when vectors exist; `session_read` opens a window of
one transcript; `session_list` shows recent sessions with their workspace and
preview. `ranite sessions index` builds or refreshes the derived search index
(`--rebuild` drops it first), and `ranite sessions prune --older-than 30d`
deletes old session files, listing what it would delete until `--yes` is given.

The data directory holds everything Ranite writes:

```text
settings.yaml        settings, no key material
config.yaml          provider keys and the team ticket; the agent cannot open it
sessions/            one directory per session, with attachments
MEMORY/              durable memory
state.db             activity ledger, memory and session search indexes
catalog.ndjson       cached provider catalog
models/              the local memory model
packages/            provider runtime packages installed on demand
skills/              user-level Agent Skills
tool-output/         complete tool output that did not fit inline
team.db, team-files/ team hub state and shared files
daemon.log           host log
```

Its location is `%LOCALAPPDATA%\ranite` on Windows,
`~/Library/Application Support/ranite` on macOS, and `$XDG_DATA_HOME/ranite` (or
`~/.local/share/ranite`) on Linux. `RANITE_DATA_DIR` overrides it. `ranite about`
prints the version, the runtime, and these paths.

## CLI

```text
ranite                    Open an interactive terminal session
ranite --workspace <path> Attach the shared custodian with this workspace scope
ranite --c "<request>"    Run a one-shot request
ranite setup              First-run wizard: provider, key, model, memory model
ranite config             Show the current settings and readiness
ranite keys add|list|remove <provider>   Manage provider API keys
ranite permissions [workspace|auto-review|full-access]
                          Choose the approval mode
ranite permissions --review-timeout 30   Auto-review decision timeout (seconds)
ranite permissions --approval-timeout 60 Manual approval timeout (seconds)
ranite permissions --review-model <provider>/<model>|none
                          Run the reviewer on its own model
ranite approve [n]        List auto-review denials; retry one exactly once
ranite mcp [list|add|remove]             Manage global MCP servers
ranite skills             List global and active-workspace Agent Skills
ranite --list-models      List tool-capable models (--filter, --limit, --provider)
ranite schedule list|log|capabilities|add|update|remove|enable|disable|run|open
ranite team <subcommand>  init, invite, invites, invite-revoke, join, join-status,
                          pending, approve, deny, members, leave, remove, status,
                          log, rejoin, say, dm, inbox, read, history, send-file,
                          files, get
ranite telegram setup|pair|status|disable|unpair|reset
ranite web                Serve the browser client (--port, --hostname, --dir)
ranite daemon start|status|stop|install|uninstall|autostart on|off|status
ranite stop               Stop the background host
ranite restart            Restart the host and reconnect open sessions
ranite sessions index [--rebuild]        Build the session search index
ranite sessions prune --older-than 30d [--yes]
                          Delete old session files
ranite events [retry <id>]               Inspect the durable event ledger
ranite events prune --older-than 30d [--yes]
ranite actions                           Inspect the tool action ledger
ranite workspace default <path>          Scope for bare Ranite launches
ranite about              Version, runtime, configuration paths
ranite uninstall [--purge] [--dry-run] [--force]
                          Remove the program; --purge removes data too
ranite --help             Show all commands
ranite --version          Print the installed version
```

`ranite restart` stops active runs, saves sessions, and waits for the previous
host to exit before starting the replacement. Open sessions reconnect and restore
their history. Closing the TUI only detaches it; use this command after updating
Ranite to reload the background host. `ranite` narrates the lifecycle on launch
(workspace, host pid, automatic-startup state) and on exit (whether the host keeps
running).

In the session: `/help`, `/clear`, `/settings`, `/permissions`, `/reasoning`,
`/thinking`, `/compact`, `/stop`, `/models`, `/provider`, `/session`, `/skills`,
`/exit`. Esc twice stops a run and keeps queued messages in the chat, waiting for
the next explicit send; Ctrl+C copies a text selection first, then clears the
composer, then stops and exits.
