# Validation, visibility and troubleshooting

## Evidence levels

| State | What establishes it |
| --- | --- |
| Resolved | Intended repository/local source, ref and package path identified |
| Reviewed | Instructions/resources/scripts/licenses and dependencies inspected |
| Copied | Actual destination manifest matches selected staged source |
| Structurally valid | Valid YAML/name/description and resource/link/path checks |
| Discoverable | `openbutler skills --workspace <directory>` returns the intended winning path |
| Dependency-ready | Needed executables, libraries and integrations are actually available |
| Behaviorally verified | An appropriate real task/artifact check succeeded |

Use passed/failed/blocked per check. Missing evidence is not a pass, and an
observed wrong outcome is not merely an unrun check. Installing a package does
not establish model selection, an active MCP integration or release readiness.

## OpenButler discovery checks

Required entrypoint is SKILL.md in a valid directory. Folder and `name` match,
lowercase letters/digits separated by single hyphens, at most 64 characters.
Description is nonempty and at most 1024 characters. Valid YAML matters: quote
colon-bearing values. The metadata prefix is bounded. A loose Markdown file or
symlinked entrypoint is not equivalent to a valid package.

Inspect the selected workspace explicitly. Roots are bundled skills, home Claude,
home Agents, CODEX_HOME/default Codex, OpenButler data skills, workspace Claude and
workspace Agents, with later copies overriding earlier ones. The winning path
must resolve to the intended destination; a listing in another root is not proof
of this install. Built-in source edits must be copied into bundled distribution.

Discovery caches metadata briefly. An existing system context may be frozen and
keep its previous index until an appropriate rebuild/new context. Do not state
"available on the next turn" as a universal guarantee, or restart active work
automatically just because a copy completed. Invocation can also depend on the
model's description-based choice; copying, listing and body use are distinct.

## Resources and compatibility

Validate every actual relative link outside illustrative code fences. Referenced
files remain inside the package, exist at the installed location and retain
required licenses. A creator validation helper can assist when discovered;
otherwise use an available YAML parser, file inspection and the native discovery
check. A validator from another product is not a substitute for OpenButler's own
folder/description constraints.

Read imported agent-platform metadata instead of deleting it indiscriminately.
OpenButler may ignore unsupported fields; do not advertise them as implemented
policies. Missing Python/Node libraries, a foreign SDK or an absent browser/API
tool can leave a discoverable package dependency-blocked. A license or source
record does not make an executable safe; inspect it separately.

## Failure map

| Failure | Next step |
| --- | --- |
| Catalog cannot be listed | Report network/auth/rate error and exact source; no installation |
| Experimental path absent | Report absence; retain requested route rather than inventing entries |
| GitHub ref/path ambiguous | Resolve explicit ref and package directory |
| Private repo refused | Existing credential/access mechanism; no token-bearing URL |
| Destination exists | Distinguish explicit update from unintended conflict; preserve contents |
| Name/header mismatch | Correct explicitly staged adaptation or select the proper package |
| YAML invalid | Fix quoting/indentation in selected content; source copy alone is insufficient |
| Reference escapes/missing | Reject/repair staged package within agreed adaptation scope |
| Symlink/junction detected | Do not silently dereference into unrelated data |
| Helpers unavailable | Record dependency blocker; use supported manual file workflow if equivalent |
| Listed from another root | Inspect precedence and actual intended workspace |
| Listed but not invoked | Separate frozen index/description choice from filesystem validity |
| Partial apply | Inspect reported new partial path and recovery copy; no blanket recursive cleanup |
| SDK/Tessl tool absent | Foreign integration, not a mandatory OpenButler install gate |

For source updates to the installer/creator themselves, preserve their provenance
and validate their resources as well. Do not edit provider-managed Codex or Claude
system skills unless that separate installation is actually the user's target.
