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

A specific release: `bash -s -- --version 0.1.0` for the shell installer, or
download `install.ps1` first and run `.\install.ps1 -Version 0.1.0`.
`--no-modify-path` (shell) and `-NoModifyPath` (PowerShell) skip PATH changes.
Both installers verify the result with `ranite --version`; restart the
terminal afterwards so the updated PATH takes effect.

Published builds: Windows x64 today; Linux x64 and arm64 archives join the same
release next, macOS follows in a later release.

Configure a provider and model once:

```sh
ranite setup
```

Ranite keeps one machine-wide custodian conversation. The current directory does not choose its workspace. On first launch, bare `ranite` asks which workspace this client should use; set a stable default once with:

```sh
ranite workspace default path/to/project
```

Then `ranite` opens the same custodian with that workspace scope from any terminal directory. To attach a client to another workspace for its turns without changing the default:

```sh
ranite --workspace path/to/project
```

`--workspace` accepts an absolute or current-directory-relative path (including `~` on macOS/Linux). Ranite checks that it exists and is a directory. The host binds each message to the client's selected scope, serializes all main turns through the same custodian, and applies the workspace permission policy there. A path mentioned in a request does not switch the scope.

## Permission modes

Run `ranite permissions` or use `/permissions` in the session.

- **Workspace** (default): local file and command operations scoped to the current workspace run without a prompt. Operations outside it ask first.
- **Approve for me**: keeps the workspace rule and uses the selected model to review outside-workspace actions. Unclear or unavailable reviews ask you.
- **Full access**: runs tools without permission prompts.

The workspace mode checks file paths, command working directories, directory changes, and common explicit paths in shell commands. It is a permission prompt policy, not an operating-system sandbox; shell scripts and programs can access paths that static command inspection cannot identify.

## Providers and models

In an interactive session, use `/provider` to choose a provider, add its API key, load its tool-capable models, and select one. Use `/models` to browse models for configured providers and switch the active model. For a self-hosted endpoint or a model not listed in the catalog, configure the provider with `ranite setup`; `/models` also offers manual model-ID entry for the active provider.

## CLI

```text
ranite                    Open an interactive terminal session
ranite --workspace <path> Attach the shared custodian with this workspace scope
ranite workspace default <path> Set the scope for bare Ranite launches
ranite --c "<request>"    Run a one-shot request
ranite permissions        Show the current permission mode
ranite restart            Restart the background host using the installed code
ranite telegram setup     Connect the owner Telegram channel
ranite --help             Show all commands
ranite --version          Print the installed version
```

`ranite restart` stops active runs, saves sessions, and waits for the previous host to exit before starting the replacement. Open sessions reconnect and restore their history. Closing the TUI only detaches it; use this command after updating Ranite to reload the background host.

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
gh release upload v0.1.0 release/ranite-0.1.0-*
```

The installers resolve per-platform files from the GitHub release, so all
archives must be attached before the install commands work everywhere.

## Telegram channel

One guided command connects a private Telegram chat to the same machine-wide custodian conversation as the terminal:

```sh
ranite telegram setup
```

It asks for the environment variable holding the bot token (paste the token from `@BotFather` when prompted; the value is validated live and never stored in the settings file) and Telegram's default workspace scope, then starts the host, waits while you send the one-time pairing command to the bot, and delivers a test message to prove the channel works end to end. That setting selects the scope of Telegram turns; it does not define Ranite's identity. In the chat, `/approvals` re-sends pending approvals and `/stop` stops the current run while preserving queued messages. A live draft shows current output and short tool status with a Stop control. Completed assistant messages return to their original Telegram chat in order; tool results and private reasoning stay separate from those replies. Long messages are split without discarding text, and confirmed chunks are not replayed after a later chunk fails.

The host tells the agent which channel supplied a request, where its answer belongs, and whether an owner terminal and Telegram are available. Compatible messages can steer the custodian after a complete tool batch; a workspace, reply route, or turn-preference change waits as a followup. Background work uses `send_message_to_owner` for separate proactive messages: `auto` prefers a connected owner terminal, then the paired Telegram chat; an explicit `telegram` or `terminal` selects that owner channel. Ordinary replies never broadcast to every connected channel. On Windows, a new host can read a token already saved in the user environment even when its launching shell has an older environment snapshot.

Further commands: `ranite telegram status`, `ranite telegram pair` (fresh pairing code), `ranite telegram unpair` (forget the chat, keep the channel polling), `ranite telegram disable` (stop the channel, keep the settings), `ranite telegram reset` (remove the channel, settings, and — with `--remove-env` — the token from the user environment).

The bot registers a command menu (`/start`, `/approvals`, `/stop`) in the paired chat, formats notices and approval previews as HTML (falling back to plain text if Telegram rejects the markup), and pins an Approvals/Stop reply keyboard that is removed again on unpair, disable, or reset.

Login startup (`ranite daemon install`) carries the token too: on macOS it is embedded in the managed LaunchAgent (written 0600), on Linux the unit reads an optional 0600 env file, on Windows the user environment already covers logon. Rewiring happens automatically during setup; `reset` unwires it again.

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
