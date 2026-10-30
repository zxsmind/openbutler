# MCP servers and tools

Contents: transports, configuration, credentials, connection lifecycle and failures.
Related: [configuration](configuration.md), [tools](tools.md), [observability](observability.md).

## Configuration surfaces

`openbutler mcp` opens global server management; `list`, `add` and `remove` are CLI
actions. The agent's `mcp_manage` additionally supports `connect` and `disconnect`.
The bundled `mcp-manager` provides a focused operating workflow. A server id is
not a provider id or an Agent Skill.

| Transport | Required configuration | Execution |
| --- | --- | --- |
| `stdio` | `command`, optional `args`, `env`, `cwd` | A local server process |
| `http` | `url`, optional `headers` | Streamable HTTP server |
| `sse` | `url`, optional `headers` | SSE-compatible server |

Use a real package/endpoint for the chosen server. Example stdio tool input:

```json
{
  "action": "add",
  "serverId": "example",
  "config": {
    "transport": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/server.mjs"],
    "cwd": "/absolute/path/to/server-workdir",
    "env": { "SERVICE_API_KEY": "EXAMPLE_SERVICE_KEY" }
  }
}
```

Example public HTTP configuration shape:

```json
{
  "transport": "http",
  "url": "https://example.invalid/mcp",
  "headers": { "Authorization": "EXAMPLE_MCP_AUTH_HEADER" }
}
```

These are shapes, not installed examples. `EXAMPLE_SERVICE_KEY` is the name of a
host variable holding the value. `EXAMPLE_MCP_AUTH_HEADER` names a variable whose
value is the entire header value required by the server. The settings values are
variable references, not literal tokens and not automatic string templates.

## Lifecycle

1. Inspect `mcp_manage {"action":"list"}` or `openbutler mcp list`.
2. Establish transport, command/endpoint, arguments, working directory and needed
   variable names. Check that the host/service account sees those variables.
3. Add through the supported manager. Adding/connecting can launch a process or
   contact a remote service and runs through OpenButler's normal capability-change gate.
4. Inspect connection result and offered tools. Names join the catalog as
   `mcp_<server>_<tool>`; normalization can affect raw server/tool names.
5. Use a relevant bounded operation to verify the actual capability, when needed.
   Listing tools alone establishes discovery, not the outcome of a particular call.

`mcp_manage` inputs are `action`, `serverId` and, for add, `config`. A changed
connection rebuilds the runtime catalog for the next model step. `disconnect`
stops the connection while retaining its definition. `remove` removes definition
and connection. The CLI saves definitions; startup/runtime connection behavior
and confirmation are separate from that save.

Reconnection is bounded: a server that cannot connect is attempted three times,
then reported for the operator instead of retrying forever, and closing one
kills the process tree it spawned so a stdio server's children do not outlive
it. Recovery reconnects transports only; an interrupted tool call is never
replayed.

Stdio servers default to a data-directory MCP working area unless `cwd` is set.
They do not inherit the source checkout as a safe scratch directory. A server's
own package/runtime dependencies must be available to its executable, not merely
to the browser or a different terminal.

## Credentials and reload

MCP credentials live in host environment variables. Changing a variable in a
shell is not the same as changing the environment of an existing daemon or an
already-running stdio process. Reconnect the affected server after establishing
the intended host environment; process restart may be needed for inherited values.
HTTP(S) URLs reject embedded username/password credentials in supported setup.

## Troubleshooting

| Symptom | Inspect |
| --- | --- |
| Executable/package missing | Exact command, PATH for host account, args and installed dependency |
| Variable unavailable | Reference spelling, user/service environment and process start time |
| Connect timeout | Process stderr, startup duration, endpoint route and supported transport |
| HTTP auth failure | Referenced header variable and required auth scheme |
| Connected but no expected tool | Returned catalog, tool name normalization and runtime refresh |
| Tool returns unavailable | Session handler/integration boundary, not merely prompt wording |
| Worker cannot use MCP | Worker tool containment; [workers](workers.md) |

Each MCP call still uses the shared tool approval/deadline/output mechanisms.
Server-provided descriptions are tool documentation, not new host authority.
