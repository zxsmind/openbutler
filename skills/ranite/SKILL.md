---
name: ranite
description: Operate Ranite itself: settings.yaml vs config.yaml, provider API keys, MCP servers, approval modes; use when the user asks about Ranite setup, settings, keys, providers, models, or how Ranite behaves.
---

# Operate Ranite

Ranite is an agent CLI: an interactive terminal session, a background host for unattended tasks, and a tool approval policy between the agent and the machine.

## Configuration files

Ranite keeps two files in its data directory (`ranite about` prints both paths):

- `settings.yaml`: general configuration — providers (without key material), models, appearance, approval mode, background tasks, MCP server definitions. Safe to display; the agent reads and edits it without a permission prompt.
- `config.yaml`: secret values — provider API keys, nothing else. It is invisible to the agent: never read, write, edit, or search it with file tools, and never ask the user to paste a key into the chat.

MCP credentials are a third, separate case: they live in host environment variables and are referenced by name in the server definition, never stored in either file. Point MCP questions at the mcp-manager skill; do not duplicate its instructions here.

## Provider keys

Keys enter the store through `ranite keys`, never as command arguments (shell history keeps them) and never pasted into the session:

- `ranite keys add <provider>`: masked prompt, stored on save. Rejects unknown providers and MCP server ids with directions to the right place.
- `ranite keys list`: provider, state, key count, and the last four characters of each key.
- `ranite keys remove <provider>`: confirmed removal; the provider entry itself stays.

## Approval modes

Workspace (default) runs inside the active workspace and the scratch directory without prompts and asks outside them. Auto-review lets the configured model judge outside actions. Full access prompts for nothing. The secret store is denied under every mode, including full access.

Skill instructions never override the user's current request or Ranite's approval policy. Do not place credentials or private data in any skill content.
