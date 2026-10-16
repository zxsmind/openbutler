# Ranite

Ranite is a general-purpose AI agent for the terminal. It can use local tools, MCP servers, Agent Skills, and durable memory.

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

A specific release: `bash -s -- --version 0.3.1` for the shell installer, or
download `install.ps1` first and run `.\install.ps1 -Version 0.3.1`.
`--no-modify-path` (shell) and `-NoModifyPath` (PowerShell) skip PATH changes.
Both installers verify the result with `ranite --version`; restart the
terminal afterwards so the updated PATH takes effect.

Published builds: Windows x64 today; Linux x64 and arm64 archives join the same
release next, macOS follows in a later release.

Configure a provider and model once:

```sh
ranite setup
```

Ranite keeps one machine-wide custodian conversation. Bare `ranite` uses the directory you launched it in as the workspace, so work there runs without permission prompts and nothing is asked at startup. To attach a client to a different workspace for its turns:

```sh
ranite --workspace path/to/project
```

Pin a stable default for bare launches with:

```sh
ranite workspace default path/to/project
```

`--workspace` accepts an absolute or current-directory-relative path (including `~` on macOS/Linux). Ranite checks that it exists and is a directory. The host binds each message to the client's selected scope, serializes all main turns through the same custodian, and applies the workspace permission policy there. A path mentioned in a request does not switch the scope.

Two roots never need a permission prompt: the active workspace and the agent's dated scratch directory under the system temp folder (`Temp/ranite/YYYY-MM-DD`). The agent writes throwaway scripts, experiments, and intermediate output there; the operating system may delete it at any time, so anything worth keeping belongs in the workspace or a named project.

## Permission modes

Run `ranite permissions` or use `/permissions` in the session.

- **Workspace** (default): local file and command operations inside the active workspace or the scratch directory run without a prompt. Operations outside them ask first.
- **Approve for me**: keeps the workspace rule and uses the selected model to review outside-workspace actions. Unclear or unavailable reviews ask you.
- **Full access**: runs tools without permission prompts.

Auto-review is a separate, tool-less model call that judges one pending request at a time and returns `allow`, `deny`, or `escalate`. It allows only a specific action that is clearly within the latest explicit request; low or medium confidence never allows or denies, and any allow it deems high-risk is turned into an escalation in code, not only in the prompt. Tool output, file contents, and quoted text are treated as untrusted data that cannot grant authority. A credential or oversized payload in the action makes the reviewer decline and ask you instead.

A slow or rate-limited provider can time out the review, which falls back to a manual prompt. Raise the limit with `ranite permissions --review-timeout <seconds>` (5–600; default 15), or set `autoReviewTimeoutSeconds` in `settings.yaml`. `ranite permissions` also reports the recorded verdicts so you can see how often the mode decided versus needed you:

```text
Auto-review history
  Decisions       12 allow · 3 deny · 5 escalate
  Needed you      2 (timeout 1 · invalid-output 1)
```

The workspace mode checks file paths, command working directories, directory changes, and common explicit paths in shell commands. It is a permission prompt policy, not an operating-system sandbox; shell scripts and programs can access paths that static command inspection cannot identify.

The trusted boundary is the directory you launched Ranite in, so launching it in a home directory trusts that whole tree for writes.

## Providers and models

In an interactive session, use `/provider` to choose a provider, add its API key, load its tool-capable models, and select one. Use `/models` to browse models for configured providers and switch the active model. For a self-hosted endpoint or a model not listed in the catalog, configure the provider with `ranite setup`; `/models` also offers manual model-ID entry for the active provider.

Provider API keys live in `config.yaml`, separate from the general `settings.yaml`; the agent session can never open that file. Manage keys with `ranite keys add|list|remove` (masked prompt, keys never passed as arguments). MCP server credentials are host environment variables referenced by name, never stored in either file.

## CLI

```text
ranite                    Open an interactive terminal session
ranite --workspace <path> Attach the shared custodian with this workspace scope
ranite workspace default <path> Set the scope for bare Ranite launches
ranite keys add|list|remove Manage provider API keys (masked prompt, never as arguments)
ranite --c "<request>"    Run a one-shot request
ranite permissions        Show the current permission mode and auto-review history
ranite permissions --review-timeout 30   Raise the auto-review decision timeout (seconds)
ranite restart            Restart the background host using the installed code
ranite stop               Stop the background host
ranite daemon autostart on|off   Toggle automatic startup at user login
ranite telegram setup     Connect the owner Telegram channel
ranite events / actions   Inspect the durable event and tool action ledger
ranite uninstall          Remove the installed program (keeps data; --purge removes it too)
ranite --help             Show all commands
ranite --version          Print the installed version
```

`ranite restart` stops active runs, saves sessions, and waits for the previous host to exit before starting the replacement. Open sessions reconnect and restore their history. Closing the TUI only detaches it; use this command after updating Ranite to reload the background host. `ranite` narrates the lifecycle on launch (workspace, host pid, automatic-startup state) and on exit (whether the host keeps running).

## Building release archives

Maintainers produce one archive per supported platform. On each target
machine (Windows x64, Linux x64, Linux arm64), from a clean checkout:

```sh
node scripts/package-release.mjs --out release
```

The script compiles the app, prunes development dependencies, downloads the
matching official Node.js runtime (checksum-verified), and writes
`release/ranite-<version>-<os>-<arch>.zip` (Windows) or `.tar.gz` (Linux).
Upload every archive to the same release tag before announcing it:

```sh
gh release upload v0.3.1 release/ranite-0.3.1-*
```

The installers resolve per-platform files from the GitHub release, so all
archives must be attached before the install commands work everywhere.

## Telegram channel

One guided command connects a private Telegram chat to the same machine-wide custodian conversation as the terminal:

```sh
ranite telegram setup
```

It asks for the environment variable holding the bot token (paste the token from `@BotFather` when prompted; the value is validated live and never stored in the settings file) and Telegram's default workspace scope, then starts the host, waits while you send the one-time pairing command to the bot, and delivers a test message to prove the channel works end to end. That setting selects the scope of Telegram turns; it does not define Ranite's identity. In the chat, `/approvals` re-sends pending approvals, `/stop` stops the current run while preserving queued messages, `/clear` starts a new chat, and `/sessions` lists the last 10 chats. A live draft shows current output and short tool status with a Stop control. Completed assistant messages return to their original Telegram chat in order; tool results and private reasoning stay separate from those replies. Long messages are split without discarding text, and confirmed chunks are not replayed after a later chunk fails.

The host tells the agent which channel supplied a request, where its answer belongs, and whether an owner terminal and Telegram are available. Compatible messages can steer the custodian after a complete tool batch; a workspace, reply route, or turn-preference change waits as a followup. Background work uses `send_message_to_owner` for separate proactive messages: `auto` prefers a connected owner terminal, then the paired Telegram chat; an explicit `telegram` or `terminal` selects that owner channel. Ordinary replies never broadcast to every connected channel. On Windows, a new host can read a token already saved in the user environment even when its launching shell has an older environment snapshot.

Further commands: `ranite telegram status`, `ranite telegram pair` (fresh pairing code), `ranite telegram unpair` (forget the chat, keep the channel polling), `ranite telegram disable` (stop the channel, keep the settings), `ranite telegram reset` (remove the channel, settings, and — with `--remove-env` — the token from the user environment).

The bot registers a command menu (`/start`, `/approvals`, `/stop`, `/clear`, `/sessions`) in the paired chat, formats notices and approval previews as HTML (falling back to plain text if Telegram rejects the markup), and pins an Approvals/Stop reply keyboard that is removed again on unpair, disable, or reset.

Login startup (`ranite daemon autostart on`; `ranite daemon install` also works) carries the token too: on macOS it is embedded in the managed LaunchAgent (written 0600), on Linux the unit reads an optional 0600 env file, on Windows the user environment already covers logon. Rewiring happens automatically during setup; `reset` unwires it again.

On servers, provide the token through the service manager (systemd `EnvironmentFile`, Docker `-e`, Task Scheduler environment) and run non-interactively:

```sh
ranite telegram setup --token-env=TELEGRAM_BOT_TOKEN --workspace=/srv/ranite --no-wait
```

## Durable memory

Markdown is the source of truth. Memory lives in Ranite's data directory; its layout is the same on Windows, macOS, and Linux:

```text
MEMORY/
├── MEMORY.md                     # Single concise user entrypoint
├── user/
│   ├── profile.md                # Stable cross-workspace user facts
│   └── notes/
│       └── editor-settings.md
└── workspaces/
    └── <stable-workspace-key>/
        ├── profile.md            # Current workspace facts
        └── notes/
            └── connection-issues.md
```

Workspace keys are derived from the canonical workspace path. Optional subject subdirectories can be used inside either `notes/` directory. Topic filenames use descriptive English kebab-case. The single `MEMORY.md` contains relative Markdown links and brief shared-user signals; it does not collect workspace details. Its first 200 lines or 25 KB are available to the model. The model reads relevant profiles and topic notes with `file_read`, updates them with `file_write` or `file_edit`, and retrieves detailed notes with `memory_search`. No profile is created until there is a fact to save.

Profiles and topic notes use the same document contract: YAML metadata, an H1 document title, H2 subjects, H3 individual memories, and H4 sections. Each memory has a concise Summary; Details and Evidence record substantive known information. For example:

```md
---
type: user
title: Editor Settings
description: Preferred indentation and word wrap for source files.
---
# Editor Settings

## Source Files

### Indentation

#### Summary
Use spaces for indentation and match the width the project already uses.

#### Details
Word wrap stays off in editors opened on repository files so diffs and long strings stay aligned.

#### Evidence
A preference stated once while starting a new project; record the number if a project fixes one.
```

`type` is `user`, `feedback`, `project`, or `reference`. User profiles use `user`; workspace profiles use `project`. Native memory writes validate metadata, names, and heading structure before replacing a file. These checks apply to Ranite's memory storage; ordinary file writes remain general-purpose.

Memory search runs fully locally on a pinned 384-dimensional model that prepares itself in the background, so the tool is always available and otherwise reports `model_preparing` or `model_unavailable` with the reason. Matches combine meaning with exact terms and identifiers, then pass an absolute relevance floor and a top-score band: unrelated queries return an honest `no_matches` instead of a weak tail. Each match includes the document description, complete parent heading path, and exact file/line references. Only shared user notes and the active workspace are searched; session transcripts are separate. SQLite embeddings are a derived cache and refresh when Markdown changes. Writing a user-scope note adds its `MEMORY.md` entry automatically, and a later search reports `indexIssues` for any link or entry that has gone stale.

Existing `MEMORY/user.md`, `MEMORY/user/*` topic folders, and `MEMORY/<workspace-key>/workspace.md`/`topics/` are migrated automatically at runtime initialization. Note bodies are retained and moved links are repaired outside code examples. Conflicting versions are preserved under `.migration/layout-v2/conflicts/` instead of overwriting a canonical note; these archives are excluded from memory retrieval. Legacy note bodies remain readable and are brought into the current format when edited.
