/** What this machine runs, where it keeps things, and where the log lives. */
import { useEffect, useState } from 'react';
import { fetchAbout } from '../../../api.js';
import type { AboutInfo } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function AboutSettings() {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAbout()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingsPage title="About" description="The machine behind this page.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {info ? (
        <>
          <SettingsSection title="Host">
            <SettingsGroup>
              <SettingsRow label="Version">
                <span className="settings-value">{info.version}</span>
              </SettingsRow>
              <SettingsRow label="Web server uptime">
                <span className="settings-value">{duration(info.uptimeMs)}</span>
              </SettingsRow>
              <SettingsRow label="Workspace">
                <span className="settings-value">{info.workspace}</span>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
          <SettingsSection title="Model">
            <SettingsGroup>
              <SettingsRow label="Provider">
                <span className="settings-value">{info.providerId}</span>
              </SettingsRow>
              <SettingsRow label="Model">
                <span className="settings-value">{info.modelId}</span>
              </SettingsRow>
              <SettingsRow label="Context window">
                <span className="settings-value">
                  {info.contextWindowTokens === null ? 'unknown' : `${Math.round(info.contextWindowTokens / 1000)}k tokens`}
                </span>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
          <SettingsSection title="Storage">
            <SettingsGroup>
              <SettingsRow label="Data directory">
                <span className="settings-value">{info.dataDir}</span>
              </SettingsRow>
              <SettingsRow label="Log file">
                <span className="settings-value">{info.logPath}</span>
              </SettingsRow>
            </SettingsGroup>
          </SettingsSection>
        </>
      ) : null}
    </SettingsPage>
  );
}
