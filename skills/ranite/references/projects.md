# Workspaces and projects

Contents: scope selection, project catalog, multi-folder bindings and failures.
Related: [environment](environment.md), [sessions](terminal-sessions.md), [configuration](configuration.md).

## Four different locations

The installed application contains executable code; the data directory contains
Ranite state; the active workspace supplies a turn's command/memory/permission
scope; a named project is a stored selection of source folders. These need not
be the same directory. A path in natural-language text does not itself switch
the host's selected scope.

## Select workspace from a client

```text
ranite --workspace <existing-directory>
ranite workspace default
ranite workspace default <existing-directory>
ranite web --dir <existing-directory>
```

Without an explicit path, a bare terminal launch uses its configured default,
otherwise the invoking directory. Web `--dir` defaults to its launch directory.
Telegram has a configured workspace. Relative paths resolve from the invoking
shell. Workspace selection validates existence/directory status and canonicalizes
the path; `~` expansion is supported by the workspace CLI resolver.

The shared custodian identity does not change when a turn's workspace changes.
Runtime tools, file paths and workspace memory are rebound before executing that
turn, so another client's directory cannot silently move an already-active turn.

## Named projects in web

The sidebar project selector and New project action manage a persistent catalog.
A project has `id`, `name`, source `folders`, creation time and availability.
The reviewed catalog allows up to 200 projects and 16 folders per project; inspect
validation errors rather than treating these limits as a general filesystem cap.
Folders must be valid absolute directories and are canonicalized/deduplicated.

Choose the project and its source folders before the first message. The first
folder supplies the command/workspace root; additional folders remain named
project context and do not erase the active permission boundary. The session
binding stores project id/name/folders, workspace root and `locked` state. Sending
the first owner message locks the session's project selection. Changing the
project of already-bound work can require creating a new chat; active or queued
work can disable project/navigation operations.

The host supplies project context to the model. A project selection is not
accepted as arbitrary raw metadata inside an HTTP message. A user message cannot
claim a different project binding by adding a `projectId` field to its body.

## Operating procedure

1. Inspect current selected project and active workspace; use the sidebar/context
   bar and session details rather than relying on a mentioned path.
2. For a new task in another project, finish/stop or leave current work as appropriate,
   choose/create the project, select source folders and open the intended chat.
3. Confirm the selected name, first folder and host-reported binding before work.
4. If a source folder moved or became unavailable, repair the catalog through the
   supported project UI and establish a valid binding; changing text in a prompt
   is not a replacement for that operation.

There is no reviewed `ranite project` CLI or native `project_create` agent tool.
Project catalog management is a web surface. An agent can use an available browser
capability or direct the user to the exact selector; it should not invent such a
CLI command. Workspace CLI selection remains available independently.

## Common failures

| Failure | Meaning/next check |
| --- | --- |
| Project information not ready | Catalog loading/error; inspect connection and retry catalog |
| Host does not support selection | Old runtime; updated UI alone does not update host |
| Source folder missing | Filesystem/canonical path and project availability |
| Selector disabled | Busy, queued work or locked binding |
| Wrong command directory | Selected first folder and turn workspace, not installation cwd |
| Memory appears different | Workspace memory is path-scoped; user-scope notes remain shared |

Cross-machine migration requires mapping source paths on the destination; copying
a project catalog does not make the old machine's directories exist.
