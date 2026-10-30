---
name: ranite
description: "Understand and operate the Ranite environment: installation, host and web setup, configuration, models, skills, MCP, sessions, projects, scheduled tasks, workers, teams, channels, memory, diagnostics, and maintenance. Use for questions or changes about Ranite itself."
metadata:
  product_version: "0.6.0"
  reviewed: "2026-10-29"
---

# Ranite operating manual

This is the operating manual for the environment the agent runs inside: its
components, files, interfaces, capabilities and procedures. It is product
documentation, not a replacement system prompt or a personality definition.

Ranite has one machine-wide background host and custodian conversation. Terminal,
web and Telegram are interfaces to it. The host runs model calls and tools; a
browser does not move execution onto the browser's machine. A workspace supplies
the turn's file scope, command directory and workspace memory. A skill supplies
instructions/resources, MCP supplies external tools, and a schedule supplies a
saved instruction and trigger. These mechanisms are different.

## Find the relevant procedure

Read the reference for the operation rather than loading the whole manual.
Every reference ships inside this skill and works without a source checkout.

| Topic or request | Reference |
| --- | --- |
| Installation, runtime identity, host lifecycle, automatic startup, data paths | [Environment](references/environment.md) |
| All settings, secret stores, applying changes, permissions, reviewer, Modal | [Configuration](references/configuration.md) |
| Providers, custom endpoints, keys, model selection, retries and reasoning | [Providers and models](references/providers.md) |
| Web setup, pairing, phone/LAN access, settings pages, input and troubleshooting | [Web](references/web.md) |
| Terminal controls, chats, history, Queue/Steer and stop behavior | [Terminal and sessions](references/terminal-sessions.md) |
| Workspaces, projects, source folders and scope binding | [Projects](references/projects.md) |
| Discover, create, install, update, remove and diagnose Agent Skills | [Skills](references/skills.md) |
| MCP transports, connections, environment variables and tool catalog refresh | [MCP](references/mcp.md) |
| Task types, schedule creation, every trigger, JSON, logs and cancellation | [Tasks and schedules](references/tasks-schedules.md) |
| Explorer/executor workers, reports, context and stopping | [Workers](references/workers.md) |
| Team setup, membership, messages, files, delivery and work records | [Teams](references/teams.md) |
| Telegram, owner messages, notifications and unified inbox | [Telegram and inbox](references/telegram-inbox.md) |
| Durable memory, local search, embeddings, compaction and archives | [Memory and context](references/memory-context.md) |
| All native tools, inputs, outputs, deadlines and attachments | [Tools](references/tools.md) |
| Logs, usage/cost, events/actions and symptom-based diagnosis | [Observability](references/observability.md) |
| Updates, builds, activation, backups, migration, cleanup and source map | [Maintenance](references/maintenance.md) |
| Common user requests as end-to-end operating recipes | [Recipes](references/recipes.md) |
| Complete CLI, flags, slash commands and team subcommands | [Command index](references/commands.md) |

## Establish this installation's state

The references describe reviewed 0.5.0 source. Installed version, running code,
configured integrations and the tools actually usable in a session can differ.
Use the smallest relevant inspection:

```text
ranite about
ranite config
ranite daemon status
ranite skills --workspace <directory>
```

`about` identifies version/runtime and configuration paths. `config` shows
configuration/readiness. `daemon status` reports the running host. `skills` shows
the winning skill paths for that workspace. Models, MCP, schedules, Telegram,
teams, usage and logs have specific inspections in their references. Some commands
initialize a host or contact a service; listing a file is not proof of live state.

## Using the manual

Each operation explains its interface, inputs, stored state, activation, expected
result and failure cases. Discover machine-specific paths, ports, provider/model
ids, schedule ids and peer names from the installation. Examples contain public
placeholders, not credentials or the maintainer's personal paths.

Settings changes and source-code changes are different operations. Many user
requests need only a UI/CLI/tool operation. Writing an unsupported feature's name
into YAML does not implement it. [Maintenance](references/maintenance.md) maps
code responsibilities when a source checkout is actually available.

## Important environment facts

- `settings.yaml` is general configuration. Protected `config.yaml` may contain
  provider keys, a team ticket and Modal credentials. Supported entry points are
  masked CLI/setup prompts or the relevant settings UI. Ordinary agent tools
  cannot access the secret store, even in full-access mode.
- MCP environment/header values are host variable **names**, not secret values.
  Telegram also refers to a host token variable.
- Closing a terminal detaches it. Closing a browser leaves the web server and host
  running. Stopping web does not stop the host. Host restart can interrupt jobs.
- Ordinary owner messages during a run queue for later. Explicit **Steer** admits
  a compatible message into the active turn with follow-up context. Host
  notifications and worker signals have a separate admission path.
- A tool can exist in the catalog yet return `unavailable` because its backing
  integration is absent. Discovery is not connectivity.
- Skill discovery has a short cache, while an existing model session's system
  context may be frozen. A newly discoverable file is not proof that an active
  turn received its description; see [Skills](references/skills.md).
- Source, built files, running host, running web server and a browser's loaded
  bundle are separate activation states; see [Maintenance](references/maintenance.md).

## Maintaining the manual

Keep detailed facts in their reference, with routing here. Check procedures
against current CLI handlers, tool schemas, settings types and discovery code.
References do not depend on unpublished design documents. Updating this skill
does not itself configure a provider, create a task, contact a peer or restart a
service. The runtime's existing operation and permission mechanisms still apply.
