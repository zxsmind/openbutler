/**
 * What the machine remembers.
 *
 * Each note is folded and rendered rather than printed: the body arrives
 * without its frontmatter, so this page shows the same prose the agent reads.
 */
import { useEffect, useState } from 'react';
import { fetchMemory } from '../../../api.js';
import { Markdown } from '../../../markdown.js';
import type { MemoryFileInfo, MemoryInfo } from '../../../types.js';
import { SettingsDisclosure, SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';
import './memory.css';

const GROUPS: { key: MemoryFileInfo['group']; title: string; description: string }[] = [
  { key: 'preferences', title: 'Preferences', description: 'How the agent answers' },
  { key: 'profile', title: 'Profile', description: 'Who the owner is' },
  { key: 'topics', title: 'Topics', description: 'Durable knowledge that outlives one project' },
  { key: 'areas', title: 'Areas', description: 'Project state' },
  { key: 'workspace', title: 'This workspace', description: 'Notes that belong to the active directory only' },
];

function size(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}

function NoteView({ file }: { file: MemoryFileInfo }) {
  const meta = [file.updated ? `updated ${file.updated}` : null, size(file.bytes), file.truncated ? 'shortened' : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <SettingsDisclosure title={file.title || file.name} description={meta || undefined}>
      <p className="settings-memory__path">{file.name}</p>
      {file.description ? <p className="settings-memory__summary">{file.description}</p> : null}
      <div className="settings-memory__body">
        <Markdown text={file.body} />
      </div>
    </SettingsDisclosure>
  );
}

export function MemorySettings() {
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMemory()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsPage title="Memory" description="What this machine remembers, as the agent reads it.">
      <SettingsSection title="Storage">
        {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
        {loading ? <SettingsStatus>Reading memory…</SettingsStatus> : null}
        {info ? (
          <SettingsGroup>
            <SettingsRow label="Root" description="Where every note lives">
              <span className="settings-memory__path">{info.root}</span>
            </SettingsRow>
            <SettingsRow label="Index" description="MEMORY.md, the only cross-workspace navigation">
              <span className="settings-value">
                {info.index.present ? `${info.index.lines} lines · ${size(info.index.bytes)}` : 'missing'}
              </span>
            </SettingsRow>
            <SettingsRow label="Notes" description="Preferences, profile, topics, areas, workspace">
              <span className="settings-value">{info.files.length}</span>
            </SettingsRow>
          </SettingsGroup>
        ) : null}
      </SettingsSection>

      {info && info.files.length === 0 ? <SettingsStatus>No notes recorded yet.</SettingsStatus> : null}
      {info && info.omitted > 0 ? <SettingsStatus tone="warn">{info.omitted} more notes are not shown.</SettingsStatus> : null}

      {info
        ? GROUPS.map((group) => {
            const files = info.files.filter((file) => file.group === group.key);
            if (files.length === 0) return null;
            return (
              <SettingsSection key={group.key} title={group.title} description={group.description}>
                {files.map((file) => (
                  <NoteView key={file.name} file={file} />
                ))}
              </SettingsSection>
            );
          })
        : null}
    </SettingsPage>
  );
}
