# Environment, installation and host lifecycle

Contents: components, inspection, installation, launching, startup, paths.
Related: [configuration](configuration.md), [web](web.md), [maintenance](maintenance.md).

## Components and execution location

| Component | Responsibility | Closing/stopping it |
| --- | --- | --- |
| Background host | Sessions, model/tool calls, schedules, MCP and channels | Stops host activity; restart can interrupt jobs |
| Terminal UI | Input, transcript, selectors and approvals | Detaches this client; the host continues |
| Web server | Static assets and HTTP/SSE bridge | Disconnects browser transport; host continues |
| Browser | Chat/settings rendering and local text drafts | Closes the view, not the job |
| Telegram adapter | Paired-owner input and outbound delivery | Managed by host/channel settings |
| Worker | Bounded local agent session | Separate lifecycle and saved transcript |
| Team peer | Another Ranite machine | Independent host, capabilities and connectivity |

Files and shell commands operate on the host using the turn's workspace. Opening
web on a phone does not move tools onto the phone. An MCP server may run on another
machine; its configured command/transport/endpoint determines that location.

## Inspect an installation

```text
ranite --version
ranite about
ranite config
ranite daemon status
ranite workspace default
```

`about` prints version, Node/platform/architecture, settings/secret-store paths and
runtime packages. `config` describes provider readiness, defaults, permissions and
MCP definitions; catalog-dependent inspection may use network/cache. `daemon
status` distinguishes absent, responsive, legacy and unresponsive hosts. Capture
PID/start time for a restart check. The invoked binary's version is not evidence
that an older process has loaded it. Zero loaded workspaces can be normal before
the first client initializes the runtime.

## Install and configure

Release installers include the application, launchers and a Node runtime, so end
users do not need development npm/Node installations. Select an artifact matching
OS and CPU. The reviewed release workflow builds Windows x64, Linux x64 and Linux
arm64. Shell-installer availability on an OS does not prove a release artifact is
published for that OS.

Public installer entry points execute downloaded installer code:

```powershell
irm https://raw.githubusercontent.com/zxsmind/ranite/main/install.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/zxsmind/ranite/main/install.sh | bash
```

For an inspected copy, download the installer first, then invoke that file. Shell
options include `--version` and `--no-modify-path`; PowerShell uses `-Version`
and `-NoModifyPath`. Open a new terminal after PATH changes. Verify the invoked
copy with `ranite --version` and `ranite about`.

`ranite setup` selects a provider, masked credential input and a
model, then prepares local memory assets. The wizard saves its settings at the
final step. Existing installations can prepare the memory model separately.
Setup can contact the network and download packages/model assets.

## Launch and choose scope

```text
ranite
ranite --workspace <directory>
ranite --c "Inspect service status"
ranite workspace default <directory>
ranite daemon start
```

Bare launches use configured `defaultWorkspaceRoot`, otherwise the invoking
directory. `--workspace` selects another existing directory; relative paths resolve
from the invoking shell. `--c` executes an isolated one-shot request through the
host. A path mentioned in a message does not itself rebind workspace scope.

Runtime initialization is lazy. A responsive daemon may have no model/MCP runtime
loaded yet. Connecting MCP servers and preparing a local memory model can take
longer than starting the process. A model/provider may be configured but not ready.

## Lifecycle and automatic startup

`ranite stop` / `ranite daemon stop` stop the host. `ranite restart` saves sessions,
stops active runs, waits for exit and starts a replacement. Clients reconnect and
recover history; interrupted side effects are not retroactively completed. TUI
`/stop` and web Stop target work, not daemon ownership; see [sessions](terminal-sessions.md).

```text
ranite daemon autostart status
ranite daemon autostart on
ranite daemon autostart off
```

`daemon install` / `uninstall` manage startup registration, not program installation.
Windows logon integration, a macOS LaunchAgent or Linux user service is used as
appropriate. Registration and an already running process are independent. The
service account/login environment may differ from an interactive shell. Telegram
setup includes platform-specific token propagation.

## Paths and platform differences

| Platform | Default data root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ranite` |
| macOS | `~/Library/Application Support/ranite` |
| Linux | `$XDG_DATA_HOME/ranite`, otherwise `~/.local/share/ranite` |

`RANITE_DATA_DIR` overrides the root per process. Different values can produce
different data/host instances. Scratch is under the OS temp directory at
`ranite/YYYY-MM-DD`; it is disposable. Data contents are mapped in
[maintenance](maintenance.md). The installation, source checkout, workspace and
data directory are different places. Shell syntax and service management are
platform-specific; a PowerShell example is not a portable POSIX command.

## Verification and failures

- Command absent: inspect launcher/PATH and reopen the terminal after PATH changes.
- Wrong version: inspect invoked executable and live host separately.
- Alive PID but no response: inspect IPC health and host logs.
- Zero workspaces: may simply mean no runtime has been attached yet.
- Credentials absent only in service: inspect host-account variable availability,
  not the actual token text.
- Missing models/tools: inspect provider readiness and MCP state, not just process health.
