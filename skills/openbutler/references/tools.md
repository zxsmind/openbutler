# Native tool reference and file/media operations

Contents: catalog, core inputs, outputs, deadlines, attachments and failure states.
Related: [MCP](mcp.md), [workers](workers.md), [inbox](telegram-inbox.md).

## Catalog and execution envelope

The tool catalog is host-owned. Main sessions are offered common native tools
even when a backing integration is absent; that handler returns `unavailable`.
Workers have narrower allowlists. Dynamic MCP tools join the same catalog and use
the same approval, deadline, redaction and output mechanisms.

Any call may carry `_timeoutSeconds`, integer 1-500, default 60. This is host
execution metadata removed before domain/MCP arguments are processed. Execution
timing is distinct from queue/approval waiting. A tool deadline or owner stop can
leave partial external effects; the output describes `timed_out`/`cancelled` rather
than pretending success. A foreground subagent call also observes this envelope.

Results are bounded for inline reading and scrubbed before reaching model/chat.
Large command/tool output spills under the data root with a returned path and
preview. Read that file/page instead of rerunning a command merely to get a
smaller tail. Error, invalid input, unavailable, queued and completed are different
outcomes; domain-specific receipts can require later inspection.

## Files and shell

| Tool | Inputs | Result/important details |
| --- | --- | --- |
| `execute_command` | Required `command`; optional `cwd` | Host shell execution; relative cwd resolves from workspace; exit/output/path and execution status |
| `file_read` | Required `path`; optional `sourceType`, `offset`, `limit`, `characterOffset`, `lineNumbers`, `pattern`, `context`, `regex`, `ignoreCase` | File/directory/media reads, paging, search view and source metadata |
| `file_write` | Required `path`, `content` | Atomic UTF-8 replacement, not an append API |
| `file_edit` | Required `path`; one editing mode below | Validated targeted edit with stale/ambiguous-match and content checks |
| `glob` | Required `pattern`; optional `path`, `max_results` | Filename/path matches |
| `grep` | Required `pattern`, a JavaScript regular expression by default; optional `path`, `glob`, `regex: false` for a literal string, `max_results` | Matching lines with file and 1-based line number; case-sensitive in both modes |

`file_read` can read bounded line/directory pages and pattern matches. Follow
returned `nextOffset` or `nextCharacterOffset`; line offsets are 1-based and
character paging has its own explicit cursor. A large single-line/minified file
can need character paging rather than just another line range. Pattern results
are capped/clipped and include context; they are not the whole file. Returned
sha256 identifies observed content, not a permission token or a global lock.

Read `sourceType` can be `auto`, `path`, `url`, `data-url`, `base64`, `clipboard`.
These primarily disambiguate image sources; reading a URL can contact a server,
while a local path reads host files. File/media support and model image support
are separate checks. A directory page can include bounded child size summaries;
it is not an unlimited recursive disk inventory.

`file_edit` modes:

1. Exact replacement: `old`, `new`, optional 1-based `occurrence` (default first).
2. Batch: `edits` array (1-100), each with old/new and occurrence when ambiguous;
   matching is against original content and edits apply together.
3. Line range: `startLine`, `endLine`, exact `anchor` text of current start line,
   and `newText`; stale anchors prevent replacing the wrong lines.

Use one mode per call. Edit validation can reject damaged declarations, bracket
imbalance or encoding damage before writing. Re-read the relevant current file
when an anchor/match is stale; a rejection is not an applied change.

## Memory and sessions

| Tool | Inputs |
| --- | --- |
| `memory_search` | `query`, optional `limit` |
| `memory_write` | `action`, `scope`; optional slug/title/description/summary/bullets/old/new by action |
| `session_list` | Optional `scope`, `limit` |
| `session_search` | `query`; optional `scope`, `include_outputs`, `limit`, `offset` |
| `session_read` | `session`; optional `offset` or `around`, and `limit` |
| `session_message` | `session`, `text` for an eligible live worker |

Scopes exposed by session list/search are workspace or all. A full id or unique
hex prefix identifies saved sessions; ambiguous prefixes return candidates.
Read offsets are 1-based display-entry positions, and around/offset are mutually
exclusive. Memory source lines and session display-entry offsets are not the same
coordinate system. Session read excludes reasoning; output search is opt-in.
See [memory/context](memory-context.md) and [sessions](terminal-sessions.md).

## User communication and background work

| Tool | Inputs and role |
| --- | --- |
| `question` | `question`, optional `options`; interactive clarification, may be unavailable in worker/background context |
| `inbox` | `action` list/read/acknowledge; optional source/ids/limit/offset |
| `send_message_to_owner` | Text and/or one imagePath/filePath; optional replyTo array; explicit Telegram delivery |
| `schedule` | action, optional scheduleId or schedule definition |
| `subagent` | task, mode, background; optional context paths/notes |
| `parent_message` | text, optional kind progress/blocked/question |
| `subagent_stop` | session id/prefix |
| `mcp_manage` | action; serverId/config as appropriate |

Procedures and results are in [schedules](tasks-schedules.md), [workers](workers.md),
[Telegram/inbox](telegram-inbox.md) and [MCP](mcp.md). A missing handler reports a
capability boundary, not an instruction to fabricate a successful result.

## Team tools

| Tool | Main inputs |
| --- | --- |
| `team_status` | No domain inputs |
| `team_send` | text; optional recipient/replyTo |
| `team_group` | Optional limit/acknowledge sequence |
| `team_history` | scope group/dm; peer for dm, optional before/limit |
| `team_delivery` | action list/read/retry/cancel; id or pagination |
| `team_send_file` | path, to |
| `team_receive_file` | id, optional to |
| `team_files` | No domain inputs |
| `team_profile` | action read/update; member/description/expectedRevision |
| `team_work` | action; id/peer/terms/expectedRevision/note or list pagination |
| `team_remember` | topic decisions/shared and text |

Actual schema requirements depend on the action. Revisioned changes need the read
revision. Peers are not local worker ids. See [teams](teams.md) for lifecycle and
delivery semantics rather than treating all calls as synchronous execution.

## Attachments and image inputs

Incoming image data is validated/staged as durable per-session file attachments.
The model receives file references such as image/path markers; the file-reading
tool opens content when needed. Attachment metadata is not proof the model has
already viewed the pixels. Moving/removing the backing session file can break
the reference. Model vision rejection is distinct from file validation failure.

Reviewed web input permits up to four normalized PNG images, each at most 5 MB.
The legacy terminal IPC envelope permits up to eight images, also 5 MB each;
browser preparation and other transport limits can be narrower. Telegram's
explicit outgoing photo/document limits differ and are documented separately.
Large command output files and incoming message attachments have different
ownership/lifetimes; both must be distinguished from disposable OS scratch.
