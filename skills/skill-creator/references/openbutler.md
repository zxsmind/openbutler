# OpenButler integration and bundled helpers

## Native surfaces

Use `file_read`, `glob`, `grep` for inspection; `file_write`/`file_edit` for text;
`execute_command` for explicit helper/runtime work; `question` for unresolved
material input. Ordinary host permission behavior remains in force. A skill is
not a new tool grant. `subagent` and its foreground/background options are
optional; worker modes/capabilities must match the task.

Global OpenButler-specific scope is `<data-root>/skills/<name>`, discovered via
`openbutler about`; workspace scope is `<workspace>/.agents/skills/<name>`. Discovery
also includes bundled skills, home Claude/Agents/Codex roots and workspace
Claude/Agents roots in override order. `openbutler skills --workspace <directory>`
shows the winning path. The `openbutler` operating manual has the full root map when
available; this package does not require that skill to create a valid package.

## init-skill.mjs

Commands below use `node` as the Node executable placeholder. Release installations
include a runtime but may not put a separate `node` command on PATH. Use an
available Node or inspect the resolved OpenButler launcher (`Get-Command openbutler` on
PowerShell, `command -v openbutler` on POSIX) to locate its bundled executable. Do not
install a new system runtime merely to run an optional helper. Resolve `<creator>`
from the actual discovered package path, not from a maintainer's home directory.

```text
node <creator>/scripts/init-skill.mjs <destination-folder> --description "Actual capability and contexts"
```

Uses Node standard libraries, creates one new SKILL.md and refuses existing
paths. Parent directory must exist. The name comes from the destination basename
and must be valid kebab-case. Description is quoted safely in YAML. Complete the
draft and validate it before announcing a usable skill; the scaffold marker is
intentionally reported as unfinished by the validator.

## validate-skill.mjs

```text
node <creator>/scripts/validate-skill.mjs <skill-directory>
```

Checks real directory/entrypoint, YAML name/description/discovery limits, body
presence, unfinished scaffold markers, symlinks/special files, fenced-block
balance and local Markdown links outside examples. Local links must resolve
inside the package. It does not validate remote URLs, execute scripts, inspect
every external dependency, measure selection, or prove semantic task quality.

This helper uses Node plus `js-yaml`, already a OpenButler application dependency;
bundled placement resolves it through the application installation. If this
creator is separately copied outside that dependency tree and resolution fails,
report the missing dependency and use the installed entrypoint/discovery path or
an explicitly available YAML parser. Do not auto-install packages merely to run
a validator. Exit 0 means structural pass, 1 invalid package, 2 invocation/runtime
failure. JSON output includes paths/counts and diagnostics, not source bodies.

## summarize-evals.mjs

```text
node <creator>/scripts/summarize-evals.mjs <results.json> <new-report-directory>
```

Node standard libraries only. Reads the [recorded result schema](schemas.md),
rejects malformed/duplicate runs and writes benchmark.json/review.html into a
new directory. Preview review.html through a local artifact/browser capability
when available. It is static HTML with escaped user text, no server, model,
network call or execution of artifact paths. Supply measured data; missing metrics
remain null. A human reviews original outputs in addition to this summary.

## Packaging and activation

For a built-in, edit source `skills/<name>` and run the repository's canonical
copy/build step so references/scripts/assets/licenses all enter
`dist/builtin-skills/<name>`. Generated evaluation workspaces are not part of the
package. An installed release may not contain a source checkout.

For global/workspace delivery, copy the whole intended package using the
installation workflow, preserve licenses and verify its winning discovery path.
An optional zip is a transport artifact; OpenButler discovers the extracted directory,
not a `.skill` filename by itself. Skill discovery's short cache and a session's
frozen model context are separate. Do not automatically restart a busy host after
every edit or claim an active model already loaded a newly listed description.
