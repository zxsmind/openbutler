# Resolve catalogs, repositories and local packages

Read for source selection and fetching; [installation](install-flows.md) covers
publication after review. Source content is inspected as data, not executed.

## Listing and exact selection

If the user names a catalog, list that catalog rather than substituting another.
For an unspecified curated listing, `openai/skills` at `skills/.curated` is a useful
public source. Label repo/ref/path and annotate installed state from Ranite's
actual winning paths, not only `$CODEX_HOME/skills`. An experimental directory
may not exist: report its absence rather than silently treating it as an empty
catalog or inventing packages. A list request creates no installation.

Remote listing can use an available search/HTTP tool or GitHub contents API:

```text
https://api.github.com/repos/<owner>/<repo>/contents/<directory>?ref=<ref>
```

Directory names alone are candidates. Inspect selected packages for valid
SKILL.md before claiming they are installable. Network/auth/rate-limit failure is
not evidence that a catalog has zero entries. Only selected packages are intake;
mentioning several catalogs is not authorization to install all of them.

## GitHub URL normalization

Establish repository, immutable revision where available, and directory containing
the entrypoint. A URL ending in `/blob/<ref>/<path>/SKILL.md` identifies the parent
package. Downloading only that file can omit scripts, references, templates and
licenses. A `/tree/` path can identify a whole package or a catalog, so inspect it.

Branches may contain slashes; URL segment splitting alone can choose the wrong
ref. Prefer an explicit ref plus repo-relative path after resolution. Resolve
moving main/tag references to a commit for reproducibility when supported. Retain
the user-selected ref rather than silently switching to main on error.

For multiple selected packages, resolve and preflight each source/path/destination
before applying. Record outcomes per package. Do not rename packages merely from
a URL alias when frontmatter still has another name.

## Download and git routes

For public content, a pinned archive or selected raw files can be staged in a
task-owned temporary directory. Preserve all required package resources and
licenses. Inspect archive entries before extraction: reject absolute/drive/UNC
paths, `..` components, escaping links, special files and unreasonable expansion.
Verify extracted layout and the selected root; never execute archive hooks.

If authenticated download is unavailable but existing authorized git credentials
can access the repository, a sparse checkout is an alternative. Use the exact
repo/ref/path, capture `rev-parse HEAD`, and disable unnecessary hooks/submodules.
Download failure due to permission or transport is a reason to choose an
appropriate supported route, not to bypass access or pick an unrelated repository.

No included helper fetches a repository or extracts an archive. Use supported
HTTP/git/archive tools available in the host, inspect their outcomes, then pass
the reviewed local directory to the optional local-copy helper. Missing fetch
tools are a dependency blocker, not a successful install.

## Private repositories

Use already configured credentials or an owner-authorized credential mechanism.
Do not ask for a token in chat or embed it in a URL/argument, receipt or source
manifest. An existing `gh`/git session or environment credential may work, but its
presence and repository access are separate checks. Keep private source contents
out of public summaries; report only the necessary repo/path/revision and result.

A 404 can mean a missing ref/path or lack of permission. Distinguish those from
an empty catalog. Do not repeatedly retry an authorization rejection as a network
fluke. A provider-managed system skill in another product is not automatically
preinstalled in Ranite; inspect Ranite's discovery before making that claim.

## Local directories and archives

Resolve the named local path and package root without following symlinks into
unrelated data. An archive is a transport format; Ranite needs an extracted valid
directory. Stage a zip/tar outside active discovery and review its filenames,
resources and entrypoint first. Preserve source metadata, licenses and relevant
sidecars. Large caches, build products or an entire source repository do not need
to become a skill just because they were downloaded beside it.

## Compatibility review

Separate instruction portability from executable readiness. Inspect foreign tool
names, fixed home paths, required CLIs/libraries, model/API dependencies, expected
output viewers and hard-coded agent-platform APIs. `agents/openai.yaml` may be
valuable package metadata but does not implement Codex policy in Ranite. A foreign
SDK's contracts or private service are not universal install gates.

If rewriting is needed, preserve the original source snapshot and state the
adaptation scope; use creator workflow for content changes. Do not call a changed
package a byte-identical upstream install. [Validation](validation.md) explains
the evidence to report.
