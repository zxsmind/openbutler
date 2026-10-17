---
name: skill-creator
description: Create or revise reusable Agent Skills in the Agent Skills SKILL.md format; use when a repeatable workflow should be saved for reuse across sessions or workspaces.
---

# Create or update an Agent Skill

Use this skill when a workflow is worth keeping, not just a one-time task instruction.

1. Choose scope from the user's request. Use the Ranite global skill directory from the active context for skills intended across projects. Use the active workspace `.agents/skills/` directory for repository-specific workflows. Ask only if scope materially changes who will use the skill.
2. Choose a short lowercase hyphenated folder name. Write a `SKILL.md` whose YAML frontmatter has a matching `name` and a clear `description` that says when it should and should not activate.
3. Write actionable steps, required inputs, tool choices, validation, and expected output. Keep the main file concise; add `references/`, `scripts/`, or `assets/` only when the workflow needs them.
4. Use `file_write` to create or replace the skill file. The normal tool approval applies. Read it back with `file_read` and correct invalid frontmatter or unclear instructions.
5. Keep skill instructions subordinate to the current user request and Ranite's runtime approvals. Never use a skill to grant itself tools, bypass approval, or request secrets in chat.

After saving, the skill appears in discovery within a few seconds. Mention its name, scope, and path. Do not claim it was installed globally if it was written to the active workspace.
