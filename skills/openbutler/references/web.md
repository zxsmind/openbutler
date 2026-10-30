# Web server and browser client

Contents: setup, local/phone access, pairing, lifecycle, interface, settings,
input behavior and diagnosis. Related: [environment](environment.md),
[sessions](terminal-sessions.md), [projects](projects.md).

## Start web

```text
openbutler web
openbutler web --port 45278 --hostname 127.0.0.1 --dir <existing-directory>
openbutler web --port 45278 --hostname 0.0.0.0 --dir <existing-directory>
```

Defaults are port 45278, loopback host 127.0.0.1 and the launch directory for web's
workspace. `--dir` is web scope, not a substitute for installing the application.
Plain `openbutler web` starts/attaches the background host, launches the web server as
a tracked background process and returns. A loopback bind prints a hint that
another device needs `--hostname 0.0.0.0`; a wildcard bind prints the network
warning instead. Pairing is explicit: `openbutler web --pair` runs a pairing session
in that terminal and prints a one-time pairing URL. Enter produces a fresh URL;
Ctrl+C stops that session. If a tracked server already runs, `--pair` stops it
first to take over the same port, so an already-paired browser keeps its cookie
while a new device pairs. `openbutler restart` recycles the tracked web server
together with the host, preserving its port, hostname and workspace;
`openbutler stop` stops both.

Open the printed URL in the intended browser. Pair tokens expire after five
minutes and are consumed on use. Pairing establishes an HttpOnly session cookie.
The persistent browser-session secret lets existing browsers remain paired across
web restarts. Copying only a normal `/` URL into a new browser does not pair it.
Treat the one-time URL as access material, not a public bookmark.

Web establishes its local IPC connection as `clientKind: web`; the host attaches
`source: web` to incoming messages. Model context says `owner message via web`.
This requires both updated host and web-server code; the adapter rejects an old
host that does not acknowledge web identity. Terminal remains a separate source,
while local response routing and the shared conversation are unchanged.

## Phone/LAN and HTTPS

For a phone, bind an interface reachable from that phone. `0.0.0.0` is a listen
address, not the address to type in a phone; use the host's LAN/tailnet address
and port. Host loopback is not the phone's loopback. Verify the listener, network
route and firewall, then open a fresh pairing link with the reachable address.
Keep the intended port/path/query when changing only the link's hostname.

Binding beyond loopback makes the service network-reachable. Public exposure,
TLS termination and reverse-proxy/tailnet configuration are separate host/network
operations; `openbutler web` itself is not an HTTPS certificate manager. A reverse
proxy must support long-lived SSE and the intended request Host/Origin/cookie
behavior. Microphone/dictation can require a browser-supported secure context;
a working HTTP chat page does not prove microphone availability.

On a server, run web under the intended process/service supervisor with an
explicit workspace, hostname and port. Registering OpenButler daemon autostart alone
does not create a persistent web-server process. Environment variables and data
root must match the intended host instance.

## Browser controls

The sidebar provides chats, search and projects. The composer provides text,
images, model/reasoning selection, approval mode, context meter, dictation when
supported, send/queue and Stop. Approvals and clarification questions appear in
the action area. Historical messages can page into view. Busy/queued state can
disable navigation or model/project changes rather than switching an active job.

- Enter submits; Shift+Enter inserts a newline. IME composition is not submitted.
- Sent-during-run text queues. A queue row has **Steer**, remove and copy actions.
  Steer changes that message's mode; it does not merely change its display order.
- Text drafts persist per session in browser local storage. F5 and closing/reopening
  the browser retain them when that browser/origin retains storage. Different
  hostnames, ports, profiles and devices have different storage. Private browsing,
  blocked/full storage or clearing site data can change persistence. Image drafts
  are not stored by this text-draft mechanism.
- Up/Down navigate submitted user-message history available in the loaded session
  and queued texts. Moving forward past newest restores the unfinished draft.
  Selection/modifier keys and logical lines preserve normal editing. This is not
  a cross-chat/global shell history or an independent archive of every old message.
- The duration row is a disclosure for a whole turn. Live work opens automatically;
  completed work folds and leaves the latest final answer outside. Explicit manual
  expansion is preserved while that view remains mounted. Step groups remain nested
  inside it. Recorded cancelled/failed outcomes label the header appropriately and
  keep partial output in the work log. Older records may lack outcome metadata.

## Workspace panels

Drag the right or bottom edge inward to open and resize a panel. Each panel opens
on a Tools home page; choosing Terminal opens a real shell in that tab. The plus
button opens another Tools tab. Each panel supports four tabs. Expand/restore
changes the panel's allocation without starting another shell.
Short opening gestures stay closed until the edge threshold is crossed. Crossing
it completes the gesture and smoothly restores a usable panel size; dragging an
open panel near its closing edge similarly completes a smooth collapse. Ordinary
resizing between those edge zones follows the pointer directly.
Opening and closing use the same boundary on each axis, measured from the same
divider position. Terminal scrollbars share the browser UI's scrollbar size and
color tokens rather than xterm's default wide scrollbar.
The terminal host reports Windows ConPTY compatibility metadata to the renderer.
Resize synchronization waits for the moving panel to settle, drains queued
output before fitting, and sends only changed character dimensions to the PTY.

Panels can be dragged across the entire chat area. At full coverage the chat
appears as a non-closable tab in that panel's header. Selecting it reveals the
same mounted conversation; selecting a tool tab returns to that application.
The edge separator remains draggable at full coverage so pulling it back restores
the split view. The other dock remains mounted while a dock covers the workspace.
The outer right/bottom edges also open a dock when the full-coverage chat tab is
selected. Closing the last application tab closes its dock and returns to the
normal chat layout; a chat-only dock must not keep the pinned tab bar visible.

Each tab has back/forward history, reload, an address field and a Tools-home menu.
Addresses currently resolve registered workspace tools (`openbutler://tools` and
`openbutler://terminal`); this is not a web browser. Returning home and moving forward
retains the tool instance. Reloading Terminal explicitly creates a fresh shell.

Collapsing a panel or selecting another tab keeps its terminal running. Closing
a terminal tab, reloading/closing the browser page, losing its connection or
stopping the web server ends that shell. Panel sizes persist per browser origin;
terminal processes and open tabs do not survive a page reload. Existing terminals
keep their original directory when the chat changes. A new terminal uses the
current chat's workspace, resolved by the server.

Terminal traffic uses authenticated, same-origin WebSocket upgrades at
`/api/terminal`; reverse proxies must forward WebSocket upgrades in addition to
chat's SSE stream. The shell runs on the server machine under the web process's
OS account, independently of the agent's run and tool-approval flow. Windows uses
PowerShell; Unix uses the configured `SHELL` or `/bin/sh`. An old web-server process
must be restarted to support terminals even if it already serves a rebuilt UI.

The application catalog and panel layout are separate from terminal rendering
and its transport. The host/client share `src/web/terminal-protocol.ts`. Native
PTYs run in the loader-free `terminal-host.mjs` child process, copied into `dist`
by the normal build. This separates the terminal's lifetime and native work from
the web server and leaves the same host available for a future desktop adapter.
Electron packaging and integration still require their own validation.

## Settings pages

| Page | Operations/information |
| --- | --- |
| Providers | Configure providers, credentials, endpoints and removal |
| Models | Browse catalog and manage active models |
| Modal | Save, verify and clear control-plane credentials |
| Usage | Token/cost reports and time-based views |
| Logs | Structured machine/web activity |
| Approvals | Approval mode, review configuration/history and remembered permissions |
| Memory | Memory preparation/status and document visibility |
| Telegram | Channel configuration/status and onboarding information |
| About | Version/runtime and environment details |

These pages do not imply dedicated native agent tools for every UI operation.
Use a connected browser capability when available, or give the user the exact UI
path. Existing native tools/CLI are usually the more direct operation surface.
An internal `/api/...` route is not a general unauthenticated management endpoint.

## Verify changes and troubleshoot

After startup confirm listener/address, successful pairing, Connected state and
the intended chat/workspace. A health response alone does not establish model
readiness. To confirm source labeling, inspect a legitimately sent message's
stored `source`/model context; starting a paid model call is not required merely
to inspect connection capabilities.

| Symptom | Next inspection |
| --- | --- |
| Port in use | Listener/PID; identify existing web before choosing another port |
| Connection refused | Running web process, bind address and port |
| Phone cannot connect | Reachable address, same network/tailnet and firewall |
| Pair URL refused | Expiry/consumption, correct browser/origin; issue a fresh link |
| API says pair first | Cookie, origin/hostname, proxy behavior and pairing state |
| Chat connects but generation fails | Host/provider readiness and host logs |
| Stream stalls/reconnects | SSE/proxy/network, browser gap/resync and web logs |
| Old controls after update | Built bundle, running web build id and browser-loaded asset |
| Draft missing elsewhere | Browser/origin-specific storage, not server-side cross-device drafts |
| Microphone unavailable | Browser support, permissions and secure context |

See [maintenance](maintenance.md) for source/build/server/browser activation.
