# Agent Skills: discovery, creation, installation and updates

Contents: format, root precedence, procedures, activation and diagnostics.
Related: [maintenance](maintenance.md), [MCP](mcp.md).

## What a skill provides

A skill is a directory with a valid `SKILL.md` entrypoint and optional references,
scripts and assets. It supplies reusable knowledge/procedures. It does not install
an executable tool, create an MCP connection, schedule a job or alter host
permissions merely by being present. OpenButler indexes metadata and reads the body
and references when applicable.

## Discovery roots and precedence

Later roots override earlier skills with the same name:

1. Bundled built-in skills.
2. `~/.claude/skills`.
3. `~/.agents/skills`.
4. `$CODEX_HOME/skills`, otherwise `~/.codex/skills`.
5. OpenButler data directory `skills/`.
6. Active workspace `.claude/skills`.
7. Active workspace `.agents/skills`.

```text
openbutler skills
openbutler skills --workspace <directory>
```

Use the listed winning path and scope to identify the actual skill. An explicit
workspace avoids accidentally checking another workspace's overrides. Global
roots are not just the OpenButler-specific directory. Bundled skills ship under
`dist/builtin-skills`; a source layout can use `skills/` as fallback.

## Valid format

Files inside recognized bundled/global skill packages are pre-authorized for
reading when they remain inside that valid package. Workspace skill resources
follow the normal workspace boundary. A relative reference escaping the package
does not inherit that trusted-resource status.

```text
example-skill/
  SKILL.md
  references/operation.md
  scripts/helper.mjs
  assets/template.txt
```

Only add resources the workflow needs. Required frontmatter:

```yaml
---
name: example-skill
description: "Explain a specific workflow: when it applies and what it handles."
---
```

Folder and YAML `name` must match: lowercase letters/digits separated by hyphens,
at most 64 characters. Description must be nonempty and at most 1024 characters.
Quote YAML values containing `: ` or other YAML syntax. Discovery reads at most
8 KB of frontmatter, ignores invalid metadata and does not discover a file just
because its Markdown body looks correct. Valid skill directories are discovered;
loose Markdown files are not skills. Metadata files that are symlinks are rejected.
There is a per-scope discovery cap and an overall prompt-index budget.

The reviewed index cache lasts five seconds. The model's system context can be
frozen for a workspace/provider/model/session and refreshed on relevant context
rebuilds or compaction. A new entry in `openbutler skills` does not prove an already
running turn received a new index. Reading an updated known file is also distinct
from discovering a previously missing skill description. Use a fresh appropriate
context after installation rather than restarting useful work merely for a cache.

## Create a skill

Use the bundled `skill-creator` when available. This manual also gives the needed
mechanics: choose global scope for cross-project knowledge or workspace
`.agents/skills/<name>/` for repository-specific knowledge; create matching YAML
metadata; put the procedure in the body; link detailed references relatively.
Include real inputs, interfaces, result checks and failure cases. An environment
manual describes the product rather than impersonating a system prompt.

After writing, parse the YAML, read the file back, verify every referenced file
exists inside the package and run `openbutler skills --workspace <directory>`. Check
the listed path, not only that the folder exists. Do not execute a helper script
merely to discover it; scripts have their own execution semantics.

## Install from a repository or local directory

Use bundled `skill-installer` when available. Establish source repository/local
package, subdirectory and revision. Stage downloads outside the workspace, inspect
`SKILL.md` and referenced resources, and check path traversal/symlinks. Copy the
whole selected package into the intended root, preserving relative structure.
Installation is a file operation, not execution of arbitrary source install hooks.

For global OpenButler-only scope, the destination is `<data-root>/skills/<name>`;
derive data root from `openbutler about` rather than a hard-coded home. Existing
Claude/Agents/Codex roots can already expose the same skill, so inspect precedence
before copying another copy. Workspace scope is `<workspace>/.agents/skills/<name>`.
Report source revision, destination, scope and discovery result.

## Update, rename and remove

- Update the winning package from its intended source, retaining referenced
  resources and unrelated local customizations. A built-in update can be masked by
  an older higher-precedence global/workspace copy.
- Rename folder and YAML name together; update references to the old name.
- Remove the selected skill directory only after identifying its scope/contents.
  A lower-precedence copy may become visible afterward; inspect discovery again.
- Built-in development changes belong in source `skills/`; the copy script updates
  `dist/builtin-skills`. Editing only a built copy is overwritten on build.

## Diagnose a missing/stale skill

| Check | Typical problem |
| --- | --- |
| Exact selected workspace | Looking in another workspace's roots |
| Folder and YAML name | Mismatch, invalid name or loose file |
| YAML parsing | Unquoted colon, bad indentation or missing delimiters |
| Description | Missing, empty or over limit |
| File type/path | Rejected symlink, unreadable resource or missing reference |
| Winning path | Another root overrides it |
| Cache/index | Brief metadata cache, scope/index budget, frozen model context |
| Source vs package | Source edited but bundled copy not shipped/refreshed |

For a broken entrypoint, restoring discovery is a separate task from enriching
its content. Both are required for a useful updated skill.
