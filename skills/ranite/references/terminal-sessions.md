# Terminal, sessions and Queue/Steer

Contents: terminal controls, chat lifecycle, histories, queue semantics and files.
Related: [commands](commands.md), [web](web.md), [memory/context](memory-context.md).

## Terminal entry and controls

`ranite` opens the TUI and starts/attaches the background host. `--workspace`
selects scope and `--c` is a one-shot isolated request. Closing a TUI detaches it.
Read `/help` and the current footer for terminal-emulator-specific controls; web
keyboard behavior is not a promise about every terminal's input protocol.

| Slash command | Function |
| --- | --- |
| `/help` | Available session controls |
| `/clear` | Start a new conversation, not erase every saved session |
| `/settings` | Settings view |
| `/permissions` | Permission/approval mode |
| `/reasoning` | Effective model reasoning variant |
| `/thinking` | Reasoning visibility |
| `/compact` | Request context compaction |
| `/stop` | Stop this run while preserving queued input |
| `/models` | Select configured model |
| `/provider` | Provider setup |
| `/session` | Open saved session |
| `/skills` | Discovered skills |
| `/exit` | Exit/detach terminal |

Enter during work queues input. Esc twice stops and holds queued messages: they
can appear in the transcript but wait for the next explicit send. Ctrl+C first
copies a text selection when present, otherwise clears input, then stops/exits
according to current terminal state. Approval and selection overlays have their
own key handling. A worker row can open that worker's transcript.

Composer controls include Up/Down for previously submitted terminal inputs;
returning past newest clears the TUI input (unlike web's restored scratch draft).
Ctrl+A/Home and Ctrl+E/End move the input caret, Ctrl+U clears input, and left/right,
Backspace/Delete edit characters. Ctrl+Home/End address transcript start/tail;
PageUp/PageDown scroll the transcript. Clipboard image paste uses the supported
Ctrl/Meta+V path when vision is enabled. The reviewed TUI composer submits on Return;
do not promise web's Shift+Enter behavior in every terminal.

## Session identity and storage

One machine-wide custodian conversation is shared across normal owner clients.
Private one-shot, worker and scheduled-run sessions have separate roles. A live
process is not the same thing as a saved session file. Saved sessions include
display entries, model conversation and optional pre-compaction archive, plus
provider/model/context metadata and key positions.

Sessions live under `sessions/<id>/<id>.json`; attachments share that directory.
Older flat session files can still be read. Saving is debounced during work and
flushed by lifecycle operations. Display `turnId` groups the user request and its
associated assistant/tool/notice entries. Steered user messages retain the active
turn id; queued jobs start a new turn after the preceding run settles.

Web/TUI selectors open history. Switching chats while working can be rejected;
switching a view does not authorize migrating an active task's file scope. A
read-only worker view cannot submit ordinary turns as that worker.

## Queue and Steer lifecycle

| Input/action | Result |
| --- | --- |
| Send while idle | Starts a normal turn |
| Ordinary send while busy | Waits as a later turn; not automatically injected |
| Steer a queued row | Marks that message for active-turn admission, preserving selected-steer order |
| Remove a queued row | Withdraws it before admission |
| Compatible steering at a tool boundary | Enters after settled tool results, with follow-up context |
| Different scope, reply route or incompatible preferences | Cannot borrow the active binding; may remain pending for a later turn |
| No active run at Steer request | Reports that there is no task to steer |

Steering context identifies a follow-up to unfinished work, directs interim
questions/corrections into that work and preserves the original objective unless
the owner changes/cancels it. It does not confer additional authority. Notification
and worker signals use host-managed steering independently of ordinary owner queue
mode; ordinary pending messages do not block an eligible host notification.

Once admitted, the message is no longer removable as a queue item. If the model
has already ended before another safe step, the host cannot retroactively apply
guidance to that finished request. A queue action accepted by HTTP is not proof
that a model step already consumed it.

## Stopping and resuming

Host `stop` has distinct queue modes: plain drops pending messages; `keepQueue`
retains them for automatic later execution; `holdQueue` retains and holds them
until explicit owner input. The reviewed web Stop uses the hold form by default;
TUI Esc also holds. `/stop` preserves queue according to its channel contract.
Host `ranite stop` shuts down the daemon rather than only the model turn.

A stopped turn is not a successfully completed job. Newer transcripts record
`turnOutcome` and `turnEndedAt` on its opening user entry. These support accurate
completed/cancelled/failed display and elapsed duration. Old records lack those
facts; a partial answer is not evidence of completion. Recovery starts from saved
context and the actual side effects of any interrupted command.

## Search and read history

Use `session_list` for recent sessions, `session_search` for text across saved
transcripts, and `session_read` for a bounded display-entry window. Read supports
full id or unique prefix, 1-based offsets and `around`; `offset` and `around`
are alternatives. It excludes private reasoning from its display view. Search
can include tool outputs with `include_outputs` and page with `offset`/`limit`.

`ranite sessions index` refreshes derived search data; `--rebuild` rebuilds it.
`sessions prune --older-than <duration>` previews deletion until `--yes` is passed.
These are not memory-note operations. [Tools](tools.md) describes exact tool inputs.
