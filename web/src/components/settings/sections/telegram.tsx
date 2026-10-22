/** The owner channel: whether the bot is connected, and what it is doing. */
import { useEffect, useState } from 'react';
import { fetchTelegram } from '../../../api.js';
import type { TelegramInfo } from '../../../types.js';
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection, SettingsStatus } from '../primitives.js';

const STATE_LABEL: Record<TelegramInfo['state'], string> = {
  disabled: 'Disabled',
  connecting: 'Connecting',
  polling: 'Polling',
  error: 'Error',
  stopped: 'Stopped',
};

export function TelegramSettings() {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTelegram()
        .then((value) => {
          if (!cancelled) setInfo(value);
        })
        .catch((problem: unknown) => {
          if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
        });
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <SettingsPage title="Telegram" description="The chat the owner writes to, and the host that answers.">
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : null}
      {info ? (
        <SettingsSection title="Channel">
          <SettingsGroup>
            <SettingsRow label="Configured" description="Set in the machine settings">
              <span className="settings-value">{info.enabled ? 'yes' : 'no'}</span>
            </SettingsRow>
            <SettingsRow label="State">
              <span className="settings-value">{STATE_LABEL[info.state]}</span>
            </SettingsRow>
            <SettingsRow label="Paired chat" description="A private chat paired with this machine">
              <span className="settings-value">{info.paired ? (info.username ?? 'paired') : 'not paired'}</span>
            </SettingsRow>
          </SettingsGroup>
          {info.state === 'error' && info.error ? <SettingsStatus tone="error">{info.error}</SettingsStatus> : null}
          {!info.enabled ? <SettingsStatus>Enable Telegram in the machine settings to pair a chat.</SettingsStatus> : null}
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
