# Configuration, secrets and approval mechanisms

Contents: stores, complete settings map, activation, permission modes, Modal.
Related: [providers](providers.md), [MCP](mcp.md), [maintenance](maintenance.md).

## Stores and management surfaces

`openbutler about` prints this installation's paths.

| Store | Contents | Supported management |
| --- | --- | --- |
| `settings.yaml` | Public configuration described below | Setup, CLI, web settings, management tools, validated YAML edits |
| `config.yaml` | Provider key arrays, team bearer ticket, Modal token id/secret | Masked key/setup prompts, team commands, Modal settings |
| Host environment | Telegram token; MCP credential variables | OS user/service environment configuration |

Host policy denies ordinary agent access to the secret store, including full
access. Public application provider objects can be merged with keys internally;
raw internal objects are not a public redaction interface. Use `openbutler config`,
`keys list` and settings views for intended public inspection.

MCP `env`/`headers` map server names to existing **host environment-variable names**,
not credential values. Telegram `tokenEnv` stores a variable name too.

## Live updates

The host watches `settings.yaml` and `config.yaml` with a 200 ms coalescing window.
Existing runtimes refresh credentials, provider options, model routing, reviewer
selection and reasoning preferences. Each model request also rereads the validated
configuration, including subsequent steps of an already-running turn. In-flight
requests finish with the configuration they started with. Permission mode changes
apply to later tool decisions; pending approval prompts are not resolved by a save.

MCP additions, removals and changed server configurations are reconciled when all
sessions sharing that runtime are idle. Unchanged servers and deliberately
disconnected servers are not restarted. Failed replacement connections retain the
working connection and report the failure. Telegram reconnects only when its own
configuration changes. Schedules and team services use the existing host reload.

Invalid edits are reported without rewriting the files. Model requests stop on
invalid or disabled provider configuration rather than using removed credentials.
Defaults apply to new runtimes; an existing chat keeps its selected provider/model.
Changing environment variables in another process still cannot change the host's
inherited environment. This reload mechanism must be loaded once by restarting an
older host after updating OpenButler itself.

## Complete general settings map

| Key | Meaning |
| --- | --- |
| `providers` | Provider id -> provider state below |
| `providerOrder` | Provider lookup/listing order, not automatic model routing |
| `defaultProvider`, `defaultModel` | One chosen default provider/model |
| `reasoning` | Preferred model-specific variant id |
| `showReasoning` | Visible reasoning deltas |
| `theme` | TUI `Dark`, `Light`, `System` |
| `approvalMode` | `workspace`, `auto-review`, `full-access` |
| `autoReviewTimeoutSeconds` | Reviewer deadline; CLI accepts 5-600, default 15 |
| `autoReviewProvider`, `autoReviewModel` | Optional separate reviewer pair |
| `approvalTimeoutSeconds` | Human approval deadline; CLI accepts 5-600, default 60 |
| `mcpServers` | Global server definitions; [MCP](mcp.md) |
| `schedules` | Durable instructions and triggers; [schedules](tasks-schedules.md) |
| `defaultWorkspaceRoot` | Scope for later bare launches, not custodian identity |
| `telegram` | Channel configuration; [Telegram](telegram-inbox.md) |
| `team` | Team membership; [teams](teams.md) |

Provider state contains `enabled`, optional configured `models`, `url`, `npm`,
`options`, `routing`, `modelRouting`, `payload` and `modelSpecs`. Internal types also expose merged `keys`; serialization
keeps credential material separate. An active model list is not the full catalog.
`options`/`routing` are adapter-specific; unsupported root fields do not become
features merely by being added to YAML.

Use `modelRouting` keyed by the exact model ID to pin only that model to an
upstream. `routing` is an explicit provider-wide default; a model's `modelRouting`
entry replaces it completely (an empty mapping disables that default for the
model). These rules also apply to the permission reviewer.

`modelSpecs.<model>` records facts the catalog does not carry: `name`, `context`,
`output`, `reasoning.efforts` and `payload`. Its `name` is the first choice when
that model is named anywhere, and `payload` merges into requests for it.

```yaml
providers:
  vercel:
    modelRouting:
      deepseek/deepseek-v4.1-flash-1017:
        order: [deepinfra]
        only: [deepinfra]
```

With no provider-wide `routing`, other models use the gateway's normal routing.

Telegram configuration: `enabled`, `tokenEnv`, `workspaceRoot`, paired `chatId`
and `userId`. Team configuration: `role`, `teamName`, `memberName`, `hubHost`,
`hubPort`, optional `hubFingerprint` and `teamId`. Join operations maintain the
separate secret ticket. Schedule fields are detailed in their own reference.

## Save versus apply

The specific UI/CLI/tool surface validates inputs and invokes its relevant
refresh. For direct YAML edits, preserve unrelated fields and inspect `openbutler
config` afterward. The host watches settings files with a debounced reload;
saved configuration, applied runtime and model-visible context remain distinct.

| Change | Activation and confirmation |
| --- | --- |
| Reasoning/thinking | Subsequent steps/deltas read live preferences; inspect effective variant |
| Model | Selector can reject/defer while busy; inspect the settled selection |
| MCP connections | `mcp_manage` refreshes tools for the next step |
| Schedule | Inspect definition plus adapter/runtime state |
| Telegram/team | Corresponding management command, reload/status and pairing/membership |
| Default workspace | Later bare launches; active turn does not move |
| Skill files | Short discovery cache plus frozen system context; [skills](skills.md) |
| Runtime JavaScript | Replace the relevant process; [maintenance](maintenance.md) |
| Web assets | Built bundle plus browser loading it; build identity is captured at web-server startup |

A settings edit cannot necessarily replace every active runtime binding. For
stale state, compare file, runtime, process identity and next step before restart.

## Approval modes and controls

```text
openbutler permissions
openbutler permissions workspace
openbutler permissions auto-review
openbutler permissions full-access
openbutler permissions --review-timeout 30
openbutler permissions --approval-timeout 120
openbutler permissions --review-model <provider>/<model>
openbutler permissions --review-model none
openbutler approve
openbutler approve <number>
```

Workspace mode pre-authorizes the workspace, dated scratch and specific host-owned
resources such as memory/settings and spilled output; outside actions reach a
gate. Auto-review adds a tool-less model decision for gated actions. Uncertainty,
invalid output or timeout can fall back to the human UI. Full access skips ordinary
prompts, not secret-store denial or domain validity checks.

Reviewer outcomes are allow, deny and escalate for a particular action. Three
consecutive denials or ten in the recent fifty pause automatic review. Expiring a
manual prompt denies that action. `openbutler approve` lists recent denials; choosing
a number permits one retry of that recorded action, still through review.

Workspace path inspection is a permission policy, not an OS sandbox. A program
can reach paths static command inspection cannot identify. Human/reviewer approval
deadlines are separate from tool execution `_timeoutSeconds`.

## Modal settings

Web Settings -> Modal saves, verifies and clears token id/secret through the
protected store. Verification contacts Modal's app-list control-plane endpoint;
success proves credential access and may show an app count. It does not prove a
GPU container is deployed or a model endpoint works. The reviewed native catalog
has no `modal_deploy` tool. Separate CLI/MCP deployment needs its own installed
capability, inputs and operational checks.
