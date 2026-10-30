# Source and OpenButler adaptation

Source: [jscraik skill-installer](https://github.com/jscraik/Agent-Skills/blob/afddb36dc2bdddd3e6ed84ac7c3393cd8e171f4c/skills-system/skill-installer/SKILL.md).
Reviewed commit: `afddb36dc2bdddd3e6ed84ac7c3393cd8e171f4c`, 2026-10-22.
The accompanying [Apache 2.0 license](../LICENSE.txt) is retained.

This is a OpenButler adaptation, not a byte-identical copy or an upstream endorsement.
Retained concepts: distinguish listing/install/update; source and revision
provenance; public/private/local routes; explicit destinations; collision handling;
package resources/licenses; per-package results; copied/discovered/runtime evidence.

Changes for OpenButler:

- Use OpenButler's data-root/global/workspace discovery rather than a fixed Codex root.
- Bind name/description validation to OpenButler's actual metadata rules and overrides.
- Keep fetch/staging/review separate from the optional no-overwrite local-copy helper.
- Preserve update recovery and user changes; no implicit library cutover.
- Treat dependency readiness and behavioral proof separately from discovery.
- Replace unconditional Codex-restart advice with OpenButler's brief cache and frozen
  context behavior; no automatic restart of active work.
- Do not import the repository owner's personal migration exception, named machine
  policy, private SDK/Foundry/Tessl workflows, scoring thresholds or service gates.
- Do not run downloaded source hooks/scripts merely as part of installation.

The original Python fetching scripts and repository-specific contract/eval files
were inspected, not executed or installed as hidden dependencies. Catalog and
GitHub procedures are in [sources](sources.md), local publication/update is in
[installation](install-flows.md), and evidence levels are in [validation](validation.md).
